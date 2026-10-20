#!/usr/bin/env node
// proof                       start the dashboard (or open it if it's already running)
// proof <path> [<path>…]      import site tarballs / report tarballs / folders, start, open
//   --full                    start imported sites in Full mode (Postgres + admin)
//   --no-open                 don't open the browser
//   --no-start                import only
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config, dashboardUrl, siteHostUrl, APP_ROOT } from '../server/config.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const paths = args.filter((a) => !a.startsWith('--')).map((p) => path.resolve(p));

if (flags.has('--help') || flags.has('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const api = `http://127.0.0.1:${config.port}`;

async function running() {
  try {
    const res = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(800) });
    return (await res.json()).app === 'proof';
  } catch { return false; }
}

function openUrl(url) {
  if (flags.has('--no-open')) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser here */ }
}

async function post(p, body) {
  const res = await fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proof': '1' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${p} returned ${res.status}`);
  return data;
}

async function importPaths() {
  let first = null;
  for (const p of paths) {
    try {
      const { kind, sites } = await post('/api/import', { path: p, start: false });
      const s = sites[0];
      console.log(`[proof] ${kind === 'report' ? `report attached to ${s.slug}` : `imported ${s.slug}`}  (${p})`);
      if (kind === 'site' && !first) first = s;
    } catch (err) {
      console.error(`[proof] ${p}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (first && !flags.has('--no-start')) {
    if (flags.has('--full') && first.mode !== 'full') await post(`/api/sites/${first.slug}/mode`, { mode: 'full' });
    await post(`/api/sites/${first.slug}/start`);
    console.log(`[proof] starting ${first.slug} → ${siteHostUrl(first.slug)}`);
  }
  return first;
}

function ensureUiBuilt() {
  if (fs.existsSync(path.join(config.uiDist, 'index.html'))) return;
  console.log('[proof] building the dashboard (first run)…');
  const vite = path.join(APP_ROOT, 'node_modules/vite/bin/vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: path.join(APP_ROOT, 'ui'), stdio: 'inherit' });
  if (r.status !== 0) { console.error('[proof] dashboard build failed; run `npm run build` to see why'); process.exit(1); }
}

if (await running()) {
  const first = await importPaths();
  openUrl(first ? `${dashboardUrl()}/#/${first.slug}` : dashboardUrl());
  if (!paths.length) console.log(`[proof] already running at ${dashboardUrl()}`);
} else {
  ensureUiBuilt();
  const { startServer } = await import('../server/index.js');
  try {
    await startServer();
  } catch (err) {
    if (err.code === 'EADDRINUSE') { console.error(`[proof] port ${config.port} is taken by something else. Set PROOF_PORT to use another.`); process.exit(1); }
    throw err;
  }
  console.log(`[proof] dashboard: ${dashboardUrl()}   (data in ${config.home})`);
  console.log('[proof] Ctrl-C stops every site and the database');
  const first = await importPaths();
  openUrl(first ? `${dashboardUrl()}/#/${first.slug}` : dashboardUrl());
}
