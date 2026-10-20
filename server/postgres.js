import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';
import { exists, pidAlive, sleep } from './util.js';
import { bus } from './events.js';

// One Postgres for every site, one database per site. Embedded by default
// (real Postgres 16 binaries from the embedded-postgres package, matching the
// postgres:16 image the generated sites deploy with), or an existing server
// via PROOF_DATABASE_URL.

let state = { status: 'stopped', error: null, external: Boolean(config.postgres.externalUrl) };
let instance = null;
let starting = null;

export const pgState = () => ({ ...state, port: state.external ? null : config.postgres.port });
function setState(s) { state = { ...state, ...s }; bus.emit('pg', pgState()); }

function adminUrl(database = 'postgres') {
  if (config.postgres.externalUrl) {
    const u = new URL(config.postgres.externalUrl);
    u.pathname = `/${database}`;
    return u.toString();
  }
  const { user, password, port } = config.postgres;
  return `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
}

export const databaseUrl = (db) => adminUrl(db);

// If proof was killed hard, the embedded postmaster outlives it and still
// holds the data dir. Stop that one cleanly before starting our own.
async function clearStalePostmaster(dir, log) {
  const pidFile = path.join(dir, 'postmaster.pid');
  if (!(await exists(pidFile))) return;
  const pid = Number((await fs.readFile(pidFile, 'utf8')).split('\n')[0]);
  if (!pidAlive(pid)) return;
  log(`stopping a Postgres left running by an earlier proof (pid ${pid})`);
  try { process.kill(pid, 'SIGINT'); } catch { return; }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(200);
}

export function ensurePostgres(log = () => {}) {
  if (state.status === 'running') return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    setState({ status: 'starting', error: null });
    try {
      if (config.postgres.externalUrl) {
        const c = new pg.Client({ connectionString: adminUrl() });
        await c.connect();
        await c.end();
      } else {
        const { default: EmbeddedPostgres } = await import('embedded-postgres');
        const dir = config.dirs.pg;
        await clearStalePostmaster(dir, log);
        instance = new EmbeddedPostgres({
          databaseDir: dir,
          port: config.postgres.port,
          user: config.postgres.user,
          password: config.postgres.password,
          persistent: true,
          onLog: () => {},
          onError: (m) => { const s = String(m?.message || m).trim(); if (s) log(`[postgres] ${s}`); },
        });
        if (!(await exists(path.join(dir, 'PG_VERSION')))) {
          log('initialising the embedded Postgres (first run only)');
          await fs.rm(dir, { recursive: true, force: true });
          await instance.initialise();
        }
        await instance.start();
      }
      setState({ status: 'running' });
    } catch (err) {
      instance = null;
      setState({ status: 'error', error: err.message });
      throw err;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

export async function stopPostgres() {
  if (instance) {
    try { await instance.stop(); } catch { /* already gone */ }
    instance = null;
  }
  if (!config.postgres.externalUrl) setState({ status: 'stopped' });
}

async function withAdmin(fn) {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const ident = (name) => `"${name.replace(/"/g, '""')}"`;

export async function createDatabase(name) {
  await withAdmin(async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await c.query(`CREATE DATABASE ${ident(name)}`);
  });
}

export async function dropDatabase(name, log) {
  await ensurePostgres(log);
  // WITH (FORCE) closes connections a site left open (PG 13+).
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
}
