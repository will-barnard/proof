import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import * as registry from './registry.js';
import { exists, readJson, randomToken, run, httpError } from './util.js';
import { log } from './events.js';
import { stopSite, forgetData } from './runner.js';

// Turns a site-press tarball (or a folder) into a registered site, and
// attaches report tarballs to the site they belong to.

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'site';

function listTar(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.split('\n').filter(Boolean)) : reject(httpError(400, `Not a readable .tar.gz: ${err.trim()}`))));
  });
}

async function inspectTar(file) {
  const entries = (await listTar(file)).map((e) => e.replace(/^\.\//, ''));
  if (entries.some((e) => e.startsWith('/') || e.split('/').includes('..'))) throw httpError(400, 'The archive has absolute or ../ paths; refusing to unpack it.');
  const tops = new Set(entries.map((e) => e.split('/')[0]).filter(Boolean));
  if (tops.size === 1 && tops.has('report')) return { type: 'report' };
  if (tops.size === 1) {
    const top = [...tops][0];
    if (entries.includes(`${top}/package.json`) && entries.some((e) => e.startsWith(`${top}/core/server/`))) return { type: 'site', top };
  }
  throw httpError(400, 'That archive is neither a site-press site (one folder with package.json and core/) nor a report (report/).');
}

async function readMeta(dir) {
  const meta = await readJson(path.join(dir, 'site-press.json'), {});
  const seed = await readJson(path.join(dir, 'site/seed.json'), null);
  return {
    source: meta.source || null,
    platform: meta.platform || null,
    coreVersion: meta.coreVersion || (await fs.readFile(path.join(dir, 'core/VERSION'), 'utf8').catch(() => '')).trim() || null,
    jobId: meta.jobId || null,
    generatedAt: meta.generatedAt || null,
    title: seed?.site?.siteTitle || null,
    pageCount: seed?.pages?.length ?? null,
  };
}

async function looksLikeSite(dir) {
  return (await exists(path.join(dir, 'package.json'))) && (await exists(path.join(dir, 'core/server/index.js')));
}

function newRecord(slug, dir, kind, meta) {
  return {
    slug,
    dir,
    kind,
    ...meta,
    importedAt: new Date().toISOString(),
    port: registry.allocatePort(),
    mode: 'preview',
    db: `proof_${slug.replace(/-/g, '_')}`,
    dbCreated: false,
    admin: { email: 'admin@proof.test', password: randomToken(12) },
    bootstrapToken: randomToken(18),
    session: null,
    buildFingerprint: null,
    report: null,
    checks: null,
  };
}

// Re-importing over an existing site keeps its port and login but starts it
// from a clean slate: new files, fresh database, no old uploads.
async function refreshExisting(site, meta) {
  await stopSite(site.slug);
  await forgetData(site);
  return registry.patch(site.slug, { ...meta, importedAt: new Date().toISOString(), buildFingerprint: null, checks: null, session: null });
}

export async function importSiteTarball(file, filename = path.basename(file)) {
  const info = await inspectTar(file);
  if (info.type === 'report') throw httpError(400, 'That is a report archive');
  const slug = slugify(info.top);
  const tmp = await fs.mkdtemp(path.join(config.dirs.tmp, 'import-'));
  try {
    await run('tar', ['-xzf', file, '-C', tmp]);
    const dest = path.join(config.dirs.sites, slug);
    const existing = registry.get(slug);
    if (existing && existing.kind === 'folder') throw httpError(409, `${slug} is already registered from a folder (${existing.dir}). Remove it first.`);
    if (existing) await stopSite(slug);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(path.join(tmp, info.top), dest);
    const meta = await readMeta(dest);
    if (existing) {
      log(slug, `re-imported from ${filename}: fresh files, database and uploads`);
      return refreshExisting(existing, meta);
    }
    log(slug, `imported from ${filename}`);
    return registry.put(newRecord(slug, dest, 'tarball', meta));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// A folder is run in place (so you can edit site/ and restart). proof only
// adds a node_modules symlink and dist/, both already in the template's
// .gitignore.
export async function importFolder(dir) {
  dir = path.resolve(dir);
  if (!(await looksLikeSite(dir))) throw httpError(400, `${dir} doesn't look like a site-press site (needs package.json and core/server/index.js).`);
  const meta = await readMeta(dir);
  const same = registry.list().find((s) => s.dir === dir);
  if (same) return registry.patch(same.slug, meta);
  let slug = slugify(path.basename(dir));
  for (let i = 2; registry.get(slug); i++) slug = `${slugify(path.basename(dir))}-${i}`;
  log(slug, `registered folder ${dir}`);
  return registry.put(newRecord(slug, dir, 'folder', meta));
}

function guessReportOwner(filename) {
  const sites = registry.list();
  if (!sites.length) throw httpError(400, 'Import the site before its report.');
  const base = path.basename(filename || '').replace(/\.(tar\.gz|tgz)$/, '').replace(/-report$/, '');
  return sites.find((s) => s.slug === slugify(base)) || sites[0];
}

export async function importReport(file, { slug, filename } = {}) {
  const site = slug ? registry.must(slug) : guessReportOwner(filename);
  const tmp = await fs.mkdtemp(path.join(config.dirs.tmp, 'report-'));
  try {
    await run('tar', ['-xzf', file, '-C', tmp]);
    const dest = path.join(config.dirs.reports, site.slug);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(path.join(tmp, 'report'), dest);
    log(site.slug, `attached report from ${path.basename(filename || file)}`);
    return registry.patch(site.slug, { report: { importedAt: new Date().toISOString(), file: path.basename(filename || file) } });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// Any of: a site tarball, a report tarball, a site folder, or a site-press
// job folder holding both tarballs.
export async function importAny(p, { filename, slug } = {}) {
  const st = await fs.stat(p).catch(() => null);
  if (!st) throw httpError(404, `Nothing at ${p}`);
  if (st.isDirectory()) {
    if (await looksLikeSite(p)) return { kind: 'site', sites: [await importFolder(p)] };
    const names = await fs.readdir(p);
    const site = names.find((n) => /site\.tar\.gz$/.test(n));
    const report = names.find((n) => /report\.tar\.gz$/.test(n));
    if (!site) throw httpError(400, `${p} has no site in it.`);
    const out = [await importSiteTarball(path.join(p, site))];
    if (report) out[0] = await importReport(path.join(p, report), { slug: out[0].slug, filename: report });
    return { kind: 'site', sites: out };
  }
  const info = await inspectTar(p);
  if (info.type === 'report') return { kind: 'report', sites: [await importReport(p, { slug, filename: filename || p })] };
  return { kind: 'site', sites: [await importSiteTarball(p, filename ? path.basename(filename) : undefined)] };
}
