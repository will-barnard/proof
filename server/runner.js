import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import * as registry from './registry.js';
import { log, clearLogs } from './events.js';
import { linkDeps, needsBuild, buildSite } from './build.js';
import { ensurePostgres, createDatabase, dropDatabase, databaseUrl } from './postgres.js';
import { readJson, writeJson, pidAlive, pidCommand, sleep, run, httpError } from './util.js';

// Starts, stops and supervises the generated sites. Each site runs as
// `node core/server/index.js` from its own folder, the same command its
// Dockerfile runs, with an environment proof builds from scratch.

const children = new Map(); // slug -> ChildProcess
const locks = new Map();

// One operation per site at a time: a Stop clicked during a build waits for
// the build step to finish instead of racing it.
function withLock(slug, fn) {
  const prev = locks.get(slug) || Promise.resolve();
  const next = prev.then(fn);
  // The stored tail never rejects (callers get the real promise), so a failed
  // start can't surface as an unhandled rejection.
  const tail = next.catch(() => {});
  locks.set(slug, tail);
  tail.then(() => { if (locks.get(slug) === tail) locks.delete(slug); });
  return next;
}

const mediaDir = (site) => path.join(config.dirs.media, site.slug);

// Deliberately NOT inherited from your shell: a stray BREW_BUCKET_URL or
// DB_PASSWORD there would send test uploads to the real bucket or point the
// site at the wrong database.
export function siteEnv(site) {
  const pass = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'SystemRoot'];
  const env = {};
  for (const k of pass) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(site.port),
    // Plain http on localhost: a Secure cookie would be dropped by Safari.
    COOKIE_SECURE: '0',
    MEDIA_DRIVER: 'local',
  });
  if (site.mode === 'preview') {
    env.SITE_PREVIEW_SEED = '1';
  } else {
    env.DATABASE_URL = databaseUrl(site.db);
    env.ADMIN_BOOTSTRAP_TOKEN = site.bootstrapToken;
    env.MEDIA_DIR = mediaDir(site);
    env.SEED_ON_BOOT = '1';
  }
  return env;
}

// ── pid bookkeeping, so a crashed proof doesn't leave sites holding ports ──

async function savePids() {
  const pids = {};
  for (const [slug, child] of children) pids[slug] = { pid: child.pid, dir: registry.get(slug)?.dir };
  await writeJson(config.pidsFile, pids).catch(() => {});
}

export async function reapOrphans() {
  const pids = await readJson(config.pidsFile, {});
  for (const [slug, { pid, dir }] of Object.entries(pids)) {
    if (!pidAlive(pid)) continue;
    const cmd = await pidCommand(pid);
    // Only kill it if it is still what we started (pids get reused).
    if (!cmd.includes('core/server/index.js')) continue;
    console.log(`[proof] stopping ${slug} (pid ${pid}) left running by an earlier proof${dir ? ` from ${dir}` : ''}`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  await writeJson(config.pidsFile, {}).catch(() => {});
}

// ── admin account ──────────────────────────────────────────────────────

const base = (site) => `http://127.0.0.1:${site.port}`;
const CSRF = { 'x-sp-csrf': '1', 'content-type': 'application/json' };

function sessionFrom(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /^sp_session=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

export async function authState(site, session = site.session) {
  const res = await fetch(`${base(site)}/api/auth/state`, { headers: session ? { cookie: `sp_session=${session}` } : {} });
  if (!res.ok) throw new Error(`/api/auth/state returned ${res.status}`);
  return res.json();
}

// Creates the owner account on a fresh database (via the bootstrap token
// proof set) or signs in with the stored credentials, and keeps the session
// so "Open admin" can sign you straight in.
export async function ensureAdmin(site) {
  const state = await authState(site);
  if (state.user) return site.session;
  let res;
  if (state.bootstrapNeeded) {
    res = await fetch(`${base(site)}/api/auth/bootstrap`, { method: 'POST', headers: CSRF, body: JSON.stringify({ token: site.bootstrapToken, email: site.admin.email, password: site.admin.password }) });
    if (res.ok) log(site.slug, `created the owner account ${site.admin.email}`);
  } else {
    res = await fetch(`${base(site)}/api/auth/login`, { method: 'POST', headers: CSRF, body: JSON.stringify({ email: site.admin.email, password: site.admin.password }) });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`couldn't sign in to the admin (${res.status}: ${body.error || 'no detail'}). If this database has an owner proof didn't create, use Wipe DB.`);
  }
  const session = sessionFrom(res);
  await registry.patch(site.slug, { session });
  return session;
}

export async function getSession(slug) {
  const site = registry.must(slug);
  if (site.mode !== 'full') throw httpError(409, 'The admin needs Full mode (preview has no database).');
  if (registry.rt(slug).status !== 'running') throw httpError(409, `${slug} isn't running.`);
  return ensureAdmin(site);
}

// ── lifecycle ──────────────────────────────────────────────────────────

async function waitHealthy(site, child, timeoutMs = 90e3) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode != null || child.signalCode) throw new Error(`the site exited during startup (code ${child.exitCode ?? child.signalCode}); see the log`);
    try { if ((await fetch(`${base(site)}/healthz`)).ok) return; } catch { /* not listening yet */ }
    await sleep(250);
  }
  throw new Error(`/healthz didn't answer within ${timeoutMs / 1000}s`);
}

function pipeLines(stream, slug, name) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) if (l.trim()) log(slug, l, name);
  });
}

async function doStart(slug) {
  let site = registry.must(slug);
  if (children.has(slug)) return;
  const say = (line) => log(slug, line);
  try {
    registry.setStatus(slug, 'installing');
    await linkDeps(site.dir, say);

    if (await needsBuild(site)) {
      registry.setStatus(slug, 'building');
      const fp = await buildSite(site.dir, (l) => log(slug, l, 'build'));
      site = await registry.patch(slug, { buildFingerprint: fp });
    }

    registry.setStatus(slug, 'starting');
    if (site.mode === 'full') {
      await ensurePostgres(say);
      await createDatabase(site.db);
      if (!site.dbCreated) site = await registry.patch(slug, { dbCreated: true });
    }
    await registry.ensurePort(site);
    site = registry.must(slug);

    say(`starting in ${site.mode} mode on port ${site.port}`);
    const child = spawn(process.execPath, ['core/server/index.js'], { cwd: site.dir, env: siteEnv(site), stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(slug, child);
    await savePids();
    pipeLines(child.stdout, slug, 'stdout');
    pipeLines(child.stderr, slug, 'stderr');
    child.on('exit', (code, signal) => {
      children.delete(slug);
      savePids();
      const r = registry.rt(slug);
      if (r.status === 'stopping' || r.status === 'stopped') { registry.setStatus(slug, 'stopped', { pid: null, startedAt: null }); return; }
      // A failed start already recorded why; don't replace it with "killed".
      if (r.status === 'error') { registry.setStatus(slug, 'error', { error: r.error, pid: null }); return; }
      const why = signal ? `killed by ${signal}` : `exited with code ${code}`;
      log(slug, `site ${why}`);
      registry.setStatus(slug, 'error', { error: `The site ${why}. See the log.`, pid: null, startedAt: null });
    });
    registry.setStatus(slug, 'starting', { pid: child.pid });

    await waitHealthy(site, child);
    if (site.mode === 'full') await ensureAdmin(registry.must(slug));
    registry.setStatus(slug, 'running', { startedAt: Date.now() });
    say(`running: ${registry.view(registry.must(slug)).urls.site}`);
  } catch (err) {
    log(slug, `start failed: ${err.message}`);
    if (err.output) for (const l of err.output.split('\n').slice(-15)) log(slug, l, 'stderr');
    const child = children.get(slug);
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      registry.setStatus(slug, 'stopping');
      child.kill('SIGKILL');
      if (child.exitCode == null && !child.signalCode) await Promise.race([exited, sleep(3000)]);
    }
    registry.setStatus(slug, 'error', { error: err.message });
    throw err;
  }
}

async function doStop(slug) {
  const child = children.get(slug);
  if (!child) { if (registry.get(slug)) registry.setStatus(slug, 'stopped', { pid: null }); return; }
  registry.setStatus(slug, 'stopping');
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const killed = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!killed) { child.kill('SIGKILL'); await exited; }
  log(slug, 'stopped');
}

export const startSite = (slug) => withLock(slug, () => doStart(slug));
export const stopSite = (slug) => withLock(slug, () => doStop(slug));
export const restartSite = (slug) => withLock(slug, async () => { await doStop(slug); await doStart(slug); });

export async function setMode(slug, mode) {
  if (!['preview', 'full'].includes(mode)) throw httpError(400, 'mode must be preview or full');
  const running = children.has(slug);
  await withLock(slug, async () => {
    if (running) await doStop(slug);
    await registry.patch(slug, { mode });
    log(slug, `switched to ${mode} mode`);
  });
  if (running) await startSite(slug);
}

export async function rebuild(slug) {
  const running = children.has(slug);
  await withLock(slug, async () => {
    if (running) await doStop(slug);
    await registry.patch(slug, { buildFingerprint: null });
  });
  await startSite(slug);
}

// Re-import site/seed.json over what's in the database (pages + redirects;
// users, uploads and form submissions stay), the same as `npm run seed --
// --replace` in the generated repo.
export async function resetContent(slug) {
  const site = registry.must(slug);
  if (site.mode !== 'full') return { message: 'Preview mode reads site/seed.json on every request, so there is nothing to reset.' };
  return withLock(slug, async () => {
    await ensurePostgres((l) => log(slug, l));
    await createDatabase(site.db);
    await linkDeps(site.dir, (l) => log(slug, l));
    log(slug, 'replacing content from site/seed.json');
    await run(process.execPath, ['core/server/bin/seed.js', '--replace'], { cwd: site.dir, env: siteEnv(site), onLine: (l) => log(slug, l, 'seed') });
    return { message: 'Content replaced from site/seed.json.' };
  });
}

// Drop the database and uploads; the next start seeds from scratch and
// creates the owner account again.
export async function forgetData(site) {
  if (site.dbCreated) await dropDatabase(site.db, (l) => log(site.slug, l));
  await fs.rm(mediaDir(site), { recursive: true, force: true });
  if (registry.get(site.slug)) await registry.patch(site.slug, { dbCreated: false, session: null });
}

export async function wipeDb(slug) {
  const running = children.has(slug);
  await withLock(slug, async () => {
    if (running) await doStop(slug);
    await forgetData(registry.must(slug));
    log(slug, 'dropped the database and uploads');
  });
  if (running) await startSite(slug);
}

export async function deleteSite(slug) {
  const site = registry.must(slug);
  await stopSite(slug);
  await forgetData(site);
  await fs.rm(path.join(config.dirs.reports, slug), { recursive: true, force: true });
  if (site.kind === 'tarball') {
    await fs.rm(site.dir, { recursive: true, force: true });
  } else {
    // Leave your folder as it was, minus the symlink proof added.
    const nm = path.join(site.dir, 'node_modules');
    const st = await fs.lstat(nm).catch(() => null);
    if (st?.isSymbolicLink()) await fs.rm(nm);
  }
  await registry.remove(slug);
  clearLogs(slug);
}

export async function stopAll() {
  await Promise.all([...children.keys()].map((slug) => doStop(slug).catch(() => {})));
}

export const isRunning = (slug) => children.has(slug) && registry.rt(slug).status === 'running';
