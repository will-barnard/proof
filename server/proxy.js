import http from 'node:http';
import * as registry from './registry.js';
import { startSite, isRunning, getSession } from './runner.js';
import { dashboardUrl } from './config.js';

// Requests for <slug>.localhost:4400 are forwarded to that site's own port.
// Separate hostnames give each site its own cookie jar: browsers share
// cookies across ports, so two admins on localhost:4501 and :4502 would sign
// each other out.

export function siteFromHost(host) {
  const m = /^([a-z0-9-]+)\.localhost(?::\d+)?$/i.exec(host || '');
  return m ? m[1].toLowerCase() : null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, status, title, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | proof</title>
<style>
  :root{color-scheme:light dark;--mat:#23514a;--line:rgba(232,240,196,.09);--paper:#fbfbf8;--ink:#16201e;--mute:#5c6864;--red:#c9321f}
  @media (prefers-color-scheme:dark){:root{--mat:#173a35;--paper:#1a2221;--ink:#e3ebe7;--mute:#93a39e;--red:#ff6a52}}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;font:15px/1.5 system-ui,sans-serif;
    background:var(--mat) linear-gradient(var(--line) 1px,transparent 1px) -1px -1px/32px 32px;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px)}
  main{max-width:520px;width:100%;padding:30px 32px;background:var(--paper);color:var(--ink);box-shadow:0 10px 30px -12px rgba(0,0,0,.5);box-sizing:border-box}
  h1{font-weight:850;font-size:26px;line-height:1.1;margin:0 0 10px;font-stretch:125%}
  p{color:var(--mute);margin:0 0 18px}
  button,a.btn{font:inherit;font-weight:600;background:var(--ink);color:var(--paper);border:0;border-radius:3px;padding:9px 18px;cursor:pointer;text-decoration:none;display:inline-block}
  button[disabled]{opacity:.5;cursor:wait}
  .err{color:var(--red);white-space:pre-wrap}
  a{color:inherit}
</style><main>${body}<p style="margin-top:28px"><a href="${dashboardUrl()}">← proof dashboard</a></p></main>`);
}

function stoppedPage(res, site, next) {
  const status = registry.rt(site.slug).status;
  page(res, 503, `${site.slug} is stopped`, `
<h1>${esc(site.slug)} isn't running</h1>
<p id="msg">${status === 'error' ? 'It stopped with an error.' : `It's ${esc(status)}.`} Start it in ${esc(site.mode)} mode and this page reloads when it's up.</p>
<button id="go">Start ${esc(site.slug)}</button>
<p class="err" id="err"></p>
<script>
const go = document.getElementById('go'), msg = document.getElementById('msg'), err = document.getElementById('err');
async function poll() {
  const s = await (await fetch('/__proof/status')).json();
  msg.textContent = s.status + '…';
  if (s.status === 'running') return location.replace(${JSON.stringify(next)});
  if (s.status === 'error') { err.textContent = s.error || 'Start failed; see the log in the dashboard.'; go.disabled = false; return; }
  setTimeout(poll, 800);
}
go.onclick = async () => { go.disabled = true; err.textContent = ''; await fetch('/__proof/start', { method: 'POST' }); poll(); };
${['starting', 'installing', 'building'].includes(status) ? 'go.disabled = true; poll();' : ''}
</script>`);
}

async function proofRoute(req, res, site) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__proof/status') {
    const r = registry.rt(site.slug);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ status: r.status, error: r.error }));
  }
  if (url.pathname === '/__proof/start' && req.method === 'POST') {
    startSite(site.slug).catch(() => {});
    res.writeHead(202, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/__proof/login') {
    if (site.mode !== 'full') {
      return page(res, 409, 'Admin needs Full mode', `<h1>The admin needs Full mode</h1><p>${esc(site.slug)} is in preview mode, which serves site/seed.json with no database, so the admin is read-only. Switch it to Full in the dashboard.</p><a class="btn" href="${dashboardUrl()}/#/${esc(site.slug)}">Open in dashboard</a>`);
    }
    if (!isRunning(site.slug)) return stoppedPage(res, site, '/__proof/login');
    try {
      const session = await getSession(site.slug);
      res.writeHead(302, {
        location: /^\/(?!\/)/.test(url.searchParams.get('next') || '') ? url.searchParams.get('next') : '/admin',
        'set-cookie': `sp_session=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`,
        'cache-control': 'no-store',
      });
      return res.end();
    } catch (err) {
      return page(res, 500, 'Sign-in failed', `<h1>Couldn't sign you in</h1><p class="err">${esc(err.message)}</p>`);
    }
  }
  return page(res, 404, 'Not found', '<h1>Not a proof route</h1>');
}

export async function handleSiteRequest(req, res, slug) {
  const site = registry.get(slug);
  if (!site) return page(res, 404, 'Unknown site', `<h1>No site called ${esc(slug)}</h1><p>Import it in the dashboard first.</p>`);
  if (req.url.startsWith('/__proof/')) return proofRoute(req, res, site);
  if (!isRunning(slug)) return stoppedPage(res, site, req.url);

  const headers = { ...req.headers };
  headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = req.headers.host;
  const upstream = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: req.url, headers }, (up) => {
    res.writeHead(up.statusCode, up.statusMessage, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    page(res, 502, 'Site unreachable', `<h1>${esc(slug)} didn't answer</h1><p class="err">${esc(err.message)}</p>`);
  });
  req.pipe(upstream);
}
