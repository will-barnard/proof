import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { config, APP_ROOT } from './config.js';
import * as registry from './registry.js';
import { bus, logsFor } from './events.js';
import { pgState, stopPostgres } from './postgres.js';
import { importAny } from './importer.js';
import * as runner from './runner.js';
import { runChecks, checksRunning } from './checks/index.js';
import { siteFromHost, handleSiteRequest } from './proxy.js';
import { randomToken, httpError } from './util.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

const app = express();
app.disable('x-powered-by');

// The dashboard can start processes and delete folders. Two guards:
// - Host must be localhost (blocks DNS-rebinding pages from reaching it).
// - Mutating calls need an x-proof header, which a page on another origin
//   can't send without a CORS preflight that this server never approves.
const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`, `${config.host}:${config.port}`]);
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host)) return res.status(403).send('proof only answers on localhost');
  if (!['GET', 'HEAD'].includes(req.method) && req.path.startsWith('/api/') && req.get('x-proof') !== '1') return res.status(403).json({ error: 'Missing x-proof header' });
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => { if (!res.headersSent) res.json(out ?? { ok: true }); }).catch(next);
const fire = (p) => p.catch(() => {}); // long operations report through SSE

app.get('/api/health', (req, res) => res.json({ app: 'proof', version: VERSION, pid: process.pid }));

app.get('/api/state', (req, res) => res.json({
  version: VERSION,
  home: config.home,
  port: config.port,
  platform: process.platform,
  pg: pgState(),
  sites: registry.list().map((s) => ({ ...registry.view(s), checksRunning: checksRunning(s.slug) })),
}));

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': hi\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20e3);
  res.on('close', () => clearInterval(ping));
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get('/api/events', (req, res) => {
  const send = sse(res);
  const onSite = (s) => send('site', { ...s, checksRunning: checksRunning(s.slug) });
  const onRemoved = (d) => send('site-removed', d);
  const onPg = (d) => send('pg', d);
  bus.on('site', onSite); bus.on('site-removed', onRemoved); bus.on('pg', onPg);
  res.on('close', () => { bus.off('site', onSite); bus.off('site-removed', onRemoved); bus.off('pg', onPg); });
});

app.get('/api/sites/:slug/logs', (req, res) => {
  registry.must(req.params.slug);
  const send = sse(res);
  send('backlog', logsFor(req.params.slug).slice(-800));
  const onLog = (e) => { if (e.slug === req.params.slug) send('log', e); };
  bus.on('log', onLog);
  res.on('close', () => bus.off('log', onLog));
});

// Import from a path on this machine: a site tarball, a report tarball, a
// site folder, or a folder holding both tarballs.
app.post('/api/import', express.json(), wrap(async (req) => {
  const { path: p, start = true } = req.body || {};
  if (!p) throw httpError(400, 'path is required');
  const { kind, sites } = await importAny(p.replace(/^~(?=$|\/)/, process.env.HOME || ''));
  if (start && kind === 'site') fire(runner.startSite(sites[0].slug));
  return { kind, sites: sites.map(registry.view) };
}));

// Upload from the dashboard (drag and drop): the raw .tar.gz is the body.
app.post('/api/upload', wrap(async (req) => {
  const filename = path.basename(String(req.query.filename || 'upload.tar.gz'));
  const tmp = path.join(config.dirs.tmp, `upload-${randomToken(6)}-${filename}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  try {
    const { kind, sites } = await importAny(tmp, { filename, slug: req.query.slug || undefined });
    if (kind === 'site' && req.query.start !== '0') fire(runner.startSite(sites[0].slug));
    return { kind, sites: sites.map(registry.view) };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}));

// Native file/folder picker on macOS: AppleScript's chooser, opened in the
// frontmost app (your browser) so it appears on top.
app.post('/api/pick', express.json(), wrap(async (req) => {
  if (process.platform !== 'darwin') throw httpError(501, 'The native picker is macOS only. Paste a path instead.');
  const pick = req.body?.kind === 'file' ? 'file' : 'folder';
  const prompt = pick === 'file' ? 'Choose a site-press .tar.gz' : 'Choose a site folder (or a folder with the tarballs)';
  const script = `tell application (path to frontmost application as text) to POSIX path of (choose ${pick} with prompt "${prompt}")`;
  const picked = await new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : /-128/.test(err) ? resolve(null) : reject(new Error(err.trim() || `osascript exited ${code}`))));
  });
  if (!picked) return { cancelled: true };
  const { kind, sites } = await importAny(picked.replace(/\/$/, ''));
  if (kind === 'site') fire(runner.startSite(sites[0].slug));
  return { sites: sites.map(registry.view) };
}));

const action = (fn, { background = false } = {}) => wrap(async (req) => {
  registry.must(req.params.slug);
  if (background) { fire(fn(req.params.slug, req.body || {})); return { ok: true }; }
  return (await fn(req.params.slug, req.body || {})) ?? { ok: true };
});

app.post('/api/sites/:slug/start', action(runner.startSite, { background: true }));
app.post('/api/sites/:slug/stop', action(runner.stopSite));
app.post('/api/sites/:slug/restart', action(runner.restartSite, { background: true }));
app.post('/api/sites/:slug/rebuild', action(runner.rebuild, { background: true }));
app.post('/api/sites/:slug/mode', express.json(), action((slug, body) => runner.setMode(slug, body.mode), { background: true }));
app.post('/api/sites/:slug/reset-content', action(runner.resetContent));
app.post('/api/sites/:slug/wipe-db', action(runner.wipeDb, { background: true }));
app.post('/api/sites/:slug/checks', action(runChecks));
app.post('/api/sites/:slug/reveal', action(async (slug) => {
  const dir = registry.must(slug).dir;
  if (process.platform === 'darwin') spawn('open', [dir], { stdio: 'ignore', detached: true }).unref();
  return { dir };
}));
app.delete('/api/sites/:slug', action(runner.deleteSite));

app.use('/reports/:slug', (req, res, next) => express.static(path.join(config.dirs.reports, req.params.slug), { index: 'index.html' })(req, res, next));

app.use(express.static(config.uiDist, { index: 'index.html' }));
app.get('*', (req, res) => {
  const index = path.join(config.uiDist, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(503).type('text').send('The dashboard isn\'t built. Run `npm run build` in the proof folder.');
});

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[proof] ${req.method} ${req.originalUrl}`, err);
  res.status(status).json({ error: err.message });
});

export async function startServer() {
  await registry.loadRegistry();
  await runner.reapOrphans();
  const server = http.createServer((req, res) => {
    const slug = siteFromHost(req.headers.host);
    if (slug) return handleSiteRequest(req, res, slug).catch((err) => { console.error(err); if (!res.headersSent) res.writeHead(500).end(err.message); });
    app(req, res);
  });
  server.requestTimeout = 0; // large uploads through the site proxy
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) { console.log('[proof] forcing exit'); process.exit(1); }
    stopping = true;
    console.log(`\n[proof] ${signal}: stopping sites and Postgres…`);
    server.close();
    await runner.stopAll();
    await stopPostgres();
    process.exit(0);
  };
  // A dashboard that dies takes every site with it; log and keep going.
  process.on('unhandledRejection', (err) => console.error('[proof] unhandled', err));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}
