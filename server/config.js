import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything proof owns lives under one folder, so "start over" is one rm -rf.
const home = env.PROOF_HOME || path.join(os.homedir(), '.proof');

export const config = {
  home,
  port: Number(env.PROOF_PORT || 4400),
  // Loopback by default: the dashboard can start processes and delete
  // folders, so it shouldn't be reachable from the LAN unless you ask.
  host: env.PROOF_HOST || '127.0.0.1',
  dirs: {
    sites: path.join(home, 'sites'),
    reports: path.join(home, 'reports'),
    deps: path.join(home, 'deps'),
    media: path.join(home, 'media'),
    pg: path.join(home, 'pg'),
    tmp: path.join(home, 'tmp'),
  },
  registryFile: path.join(home, 'registry.json'),
  pidsFile: path.join(home, 'pids.json'),
  sitePorts: { from: Number(env.PROOF_SITE_PORT_FROM || 4501), to: Number(env.PROOF_SITE_PORT_TO || 4999) },
  postgres: {
    // Point at a Postgres you already run (Postgres.app, a container) instead
    // of the embedded one. Must be a superuser URL: proof creates and drops a
    // database per site. Example: postgres://postgres:pw@localhost:5432/postgres
    externalUrl: env.PROOF_DATABASE_URL || '',
    port: Number(env.PROOF_PG_PORT || 54329),
    user: 'postgres',
    password: 'proof',
  },
  uiDist: path.join(APP_ROOT, 'ui/dist'),
};

export const dashboardUrl = () => `http://localhost:${config.port}`;
export const siteHostUrl = (slug) => `http://${slug}.localhost:${config.port}`;
