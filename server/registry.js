import fs from 'node:fs/promises';
import { config, siteHostUrl } from './config.js';
import { readJson, writeJson, portFree, httpError } from './util.js';
import { bus } from './events.js';

// The registry is the only state proof keeps besides the site folders and
// the Postgres data dir: one JSON file, rewritten on every change.
//
// A site record (persisted):
//   slug, dir, kind ('tarball' | 'folder'), source, platform, coreVersion,
//   jobId, importedAt, port, mode ('preview' | 'full'), db, admin {email,
//   password}, bootstrapToken, session, buildFingerprint, report, checks
//
// Runtime state (memory only): status, error, pid, startedAt.

let sites = {};
const runtime = new Map();
let saving = Promise.resolve();

export async function loadRegistry() {
  await fs.mkdir(config.home, { recursive: true });
  for (const d of Object.values(config.dirs)) await fs.mkdir(d, { recursive: true });
  const data = await readJson(config.registryFile, { sites: {} });
  sites = data.sites || {};
}

function persist() {
  saving = saving.then(() => writeJson(config.registryFile, { version: 1, sites })).catch((err) => console.error('[proof] registry write failed', err));
  return saving;
}

export function rt(slug) {
  let r = runtime.get(slug);
  if (!r) { r = { status: 'stopped', error: null, pid: null, startedAt: null }; runtime.set(slug, r); }
  return r;
}

export function view(site) {
  if (!site) return null;
  const r = rt(site.slug);
  return {
    ...site,
    session: undefined,
    status: r.status,
    error: r.error,
    pid: r.pid,
    startedAt: r.startedAt,
    urls: {
      site: siteHostUrl(site.slug),
      admin: `${siteHostUrl(site.slug)}/__proof/login`,
      direct: `http://localhost:${site.port}`,
      report: site.report ? `/reports/${site.slug}/index.html` : null,
    },
  };
}

export const list = () => Object.values(sites).sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
export const get = (slug) => sites[slug] || null;
export function must(slug) {
  const s = sites[slug];
  if (!s) throw httpError(404, `No site called ${slug}`);
  return s;
}

export async function put(site) {
  sites[site.slug] = site;
  await persist();
  bus.emit('site', view(site));
  return site;
}

export async function patch(slug, changes) {
  const site = must(slug);
  Object.assign(site, changes);
  await persist();
  bus.emit('site', view(site));
  return site;
}

export async function remove(slug) {
  delete sites[slug];
  runtime.delete(slug);
  await persist();
  bus.emit('site-removed', { slug });
}

export function setStatus(slug, status, extra = {}) {
  const r = rt(slug);
  Object.assign(r, { status, ...extra });
  if (status !== 'error' && !('error' in extra)) r.error = null;
  const site = sites[slug];
  if (site) bus.emit('site', view(site));
}

// A stable port per site, so bookmarks and admin sessions survive restarts.
// Re-allocated only if something else has taken it.
export async function ensurePort(site) {
  if (site.port && (await portFree(site.port))) return site.port;
  const taken = new Set(Object.values(sites).map((s) => s.port));
  for (let p = config.sitePorts.from; p <= config.sitePorts.to; p++) {
    if (taken.has(p) && p !== site.port) continue;
    if (await portFree(p)) {
      if (site.port !== p) await patch(site.slug, { port: p });
      return p;
    }
  }
  throw new Error(`No free port between ${config.sitePorts.from} and ${config.sitePorts.to}`);
}

export function allocatePort() {
  const taken = new Set(Object.values(sites).map((s) => s.port));
  for (let p = config.sitePorts.from; p <= config.sitePorts.to; p++) if (!taken.has(p)) return p;
  throw new Error('No ports left');
}
