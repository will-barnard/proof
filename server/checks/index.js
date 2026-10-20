import * as registry from '../registry.js';
import { log, logsFor } from '../events.js';
import { isRunning, getSession } from '../runner.js';
import { packageChecks } from './package.js';
import { crawlChecks } from './crawl.js';
import { adminChecks } from './admin.js';

const running = new Map();

async function group(name, fn) {
  const t0 = Date.now();
  try {
    return { name, items: await fn(), ms: Date.now() - t0 };
  } catch (err) {
    return { name, items: [{ status: 'fail', label: `${name} checks crashed`, detail: err.stack || err.message }], ms: Date.now() - t0 };
  }
}

export function runChecks(slug) {
  if (running.has(slug)) return running.get(slug);
  const p = (async () => {
    const site = registry.must(slug);
    const base = `http://127.0.0.1:${site.port}`;
    const live = isRunning(slug);
    log(slug, 'running checks');
    const logMark = logsFor(slug).length;
    const groups = [await group('Package', () => packageChecks(site))];

    if (live) groups.push(await group('Crawl', () => crawlChecks(site, base)));
    else groups.push({ name: 'Crawl', items: [{ status: 'skip', label: 'Site not running', detail: 'Start it to crawl pages, links and images.' }] });

    if (live && site.mode === 'full') groups.push(await group('Admin', async () => adminChecks(site, base, await getSession(slug))));
    else groups.push({ name: 'Admin', items: [{ status: 'skip', label: site.mode === 'full' ? 'Site not running' : 'Preview mode has no admin', detail: 'Switch to Full mode and start the site to test the admin.' }] });

    // Anything the site logged to stderr while being crawled is worth seeing.
    const errs = logsFor(slug).slice(logMark).filter((l) => l.stream === 'stderr' || /\[error\]/.test(l.line));
    if (live) {
      const g = groups.find((x) => x.name === 'Crawl');
      if (errs.length) g.items.push({ status: 'fail', label: `Server logged ${errs.length} error line${errs.length === 1 ? '' : 's'} during checks`, detail: errs.slice(0, 20).map((l) => l.line).join('\n') });
      else g.items.push({ status: 'pass', label: 'No server errors logged during checks' });
    }

    const all = groups.flatMap((g) => g.items);
    const summary = Object.fromEntries(['pass', 'warn', 'fail', 'skip'].map((s) => [s, all.filter((i) => i.status === s).length]));
    const result = { ranAt: new Date().toISOString(), mode: site.mode, live, summary, groups };
    log(slug, `checks done: ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed`);
    await registry.patch(slug, { checks: result });
    return result;
  })().finally(() => running.delete(slug));
  running.set(slug, p);
  return p;
}

export const checksRunning = (slug) => running.has(slug);
