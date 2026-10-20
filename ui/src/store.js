import { reactive } from 'vue';

export const store = reactive({
  sites: [],
  pg: { status: 'stopped' },
  platform: '',
  home: '',
  port: 4400,
  connected: false,
  notice: null, // { kind: 'error' | 'ok', text }
});

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-proof': '1', ...(body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

export function notify(kind, text) {
  store.notice = { kind, text, at: Date.now() };
  const at = store.notice.at;
  if (kind === 'ok') setTimeout(() => { if (store.notice?.at === at) store.notice = null; }, 4000);
}

function upsert(site) {
  const i = store.sites.findIndex((s) => s.slug === site.slug);
  if (i === -1) store.sites.unshift(site);
  else store.sites[i] = site;
}

export async function connect() {
  const state = await (await fetch('/api/state')).json();
  Object.assign(store, { sites: state.sites, pg: state.pg, platform: state.platform, home: state.home, port: state.port });
  const es = new EventSource('/api/events');
  es.onopen = () => { store.connected = true; };
  es.onerror = () => { store.connected = false; };
  es.addEventListener('site', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('site-removed', (e) => { const { slug } = JSON.parse(e.data); store.sites = store.sites.filter((s) => s.slug !== slug); });
  es.addEventListener('pg', (e) => { store.pg = JSON.parse(e.data); });
}

// Site tarballs before reports, so a report dropped alongside its site
// attaches to the site that was just imported.
export async function uploadFiles(files, selectedSlug) {
  const list = [...files].filter((f) => /\.(tar\.gz|tgz)$/.test(f.name));
  if (!list.length) { notify('error', 'Drop a .tar.gz from site-press (the site or its report).'); return null; }
  list.sort((a, b) => Number(/report/.test(a.name)) - Number(/report/.test(b.name)));
  let first = null;
  let lastSite = null;
  for (const f of list) {
    const isReport = /report/.test(f.name);
    const q = new URLSearchParams({ filename: f.name });
    if (isReport && (lastSite || selectedSlug)) q.set('slug', lastSite || selectedSlug);
    try {
      const { kind, sites } = await api('POST', `/api/upload?${q}`, f);
      if (kind === 'site') { lastSite = sites[0].slug; first = first || sites[0].slug; }
      notify('ok', kind === 'report' ? `Report attached to ${sites[0].slug}` : `Imported ${sites[0].slug}, starting it`);
      first = first || sites[0].slug;
    } catch (err) {
      notify('error', `${f.name}: ${err.message}`);
    }
  }
  return first;
}
