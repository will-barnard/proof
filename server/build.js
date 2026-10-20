import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { exists, run, readJson } from './util.js';

// ── shared dependency cache ────────────────────────────────────────────────
// Every generated site ships the same package.json, so dependencies are
// installed once per distinct dependency set into ~/.proof/deps/<hash>/ and
// each site's node_modules is a symlink to it. site-press's own verify step
// does the same thing with TEMPLATE_DEPS_DIR.

const installing = new Map();

async function depsKey(siteDir) {
  const pkg = await readJson(path.join(siteDir, 'package.json'));
  const lock = await fs.readFile(path.join(siteDir, 'package-lock.json'), 'utf8').catch(() => null);
  const h = crypto.createHash('sha256')
    .update(JSON.stringify({ d: pkg.dependencies || {}, dd: pkg.devDependencies || {}, node: process.versions.node.split('.')[0] }))
    .update(lock || '')
    .digest('hex').slice(0, 16);
  return { key: h, pkg, lock };
}

async function installDeps(siteDir, onLine) {
  const { key, pkg, lock } = await depsKey(siteDir);
  const dir = path.join(config.dirs.deps, key);
  if (await exists(path.join(dir, '.complete'))) return dir;
  if (installing.has(key)) return installing.get(key);
  const p = (async () => {
    onLine(`installing dependencies into the shared cache (${key}); later sites with the same package.json skip this`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `proof-deps-${key}`, private: true, type: 'module', dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} }, null, 2));
    if (lock) await fs.writeFile(path.join(dir, 'package-lock.json'), lock);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await run(npm, [lock ? 'ci' : 'install', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'], { cwd: dir, env: process.env, onLine });
    await fs.writeFile(path.join(dir, '.complete'), new Date().toISOString());
    return dir;
  })().finally(() => installing.delete(key));
  installing.set(key, p);
  return p;
}

// A folder you ran `npm install` in keeps its own node_modules; everything
// else gets the shared one.
export async function linkDeps(siteDir, onLine) {
  const nm = path.join(siteDir, 'node_modules');
  const st = await fs.lstat(nm).catch(() => null);
  if (st && !st.isSymbolicLink()) { onLine('using the folder\'s own node_modules'); return nm; }
  const shared = await installDeps(siteDir, onLine);
  const target = path.join(shared, 'node_modules');
  if (st) {
    if ((await fs.readlink(nm)) === target) return nm;
    await fs.rm(nm);
  }
  await fs.symlink(target, nm, 'dir');
  return nm;
}

// ── build ───────────────────────────────────────────────────────────────
// Fingerprint of everything that goes into the Vite bundles. seed.json and
// seed-media are read at runtime, so editing content doesn't force a rebuild.

const SKIP = new Set(['node_modules', 'dist', '.git', 'seed-media']);

async function walk(dir, rel, out) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const r = path.join(rel, e.name);
    if (r === path.join('site', 'seed.json')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, r, out);
    else if (e.isFile()) { const st = await fs.stat(full); out.push(`${r}:${st.size}:${Math.round(st.mtimeMs)}`); }
  }
}

export async function fingerprint(siteDir) {
  const out = [];
  await walk(siteDir, '', out);
  return crypto.createHash('sha256').update(out.sort().join('\n')).digest('hex').slice(0, 16);
}

export async function needsBuild(site) {
  if (!(await exists(path.join(site.dir, 'dist/server'))) || !(await exists(path.join(site.dir, 'dist/client')))) return true;
  return (await fingerprint(site.dir)) !== site.buildFingerprint;
}

export async function buildSite(siteDir, onLine) {
  const vite = path.join(siteDir, 'node_modules/vite/bin/vite.js');
  const env = { ...process.env, NODE_ENV: 'production' };
  const t0 = Date.now();
  onLine('building client bundle');
  await run(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: siteDir, env, onLine });
  onLine('building SSR bundle');
  await run(process.execPath, [vite, 'build', '--ssr', 'core/client/entry-server.js', '--outDir', 'dist/server', '--logLevel', 'warn'], { cwd: siteDir, env, onLine });
  onLine(`built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return fingerprint(siteDir);
}
