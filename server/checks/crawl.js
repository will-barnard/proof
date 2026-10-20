import path from 'node:path';
import { readJson } from '../util.js';

// Crawls the running site: every page in seed.json, then every internal link,
// image, script and stylesheet those pages reference.

const TAG_RE = /<(a|img|link|script|source|iframe)\b([^>]*)>/gi;
const ATTR_RE = /\b(href|src|srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function extractRefs(html) {
  const out = [];
  for (const [, tag, attrs] of html.matchAll(TAG_RE)) {
    for (const m of attrs.matchAll(ATTR_RE)) {
      const attr = m[1].toLowerCase();
      const raw = decode(m[3] ?? m[4] ?? '');
      const urls = attr === 'srcset' ? raw.split(',').map((s) => s.trim().split(/\s+/)[0]) : [raw];
      for (const u of urls) if (u) out.push({ tag: tag.toLowerCase(), attr, url: u });
    }
  }
  return out;
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k]); }
  }));
  return results;
}

async function fetchFollow(base, p, hops = 4) {
  let url = base + p;
  const chain = [];
  for (let i = 0; i <= hops; i++) {
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      chain.push(`${res.status} → ${next.pathname}`);
      await res.arrayBuffer().catch(() => {});
      if (next.origin !== new URL(base).origin) return { status: res.status, external: next.href, chain };
      url = next.href;
      continue;
    }
    return { status: res.status, type: res.headers.get('content-type') || '', res, chain };
  }
  return { status: 310, chain, loop: true };
}

export async function crawlChecks(site, base) {
  const items = [];
  const add = (status, label, detail) => items.push({ status, label, detail });
  const seed = await readJson(path.join(site.dir, 'site/seed.json'), { pages: [], redirects: [] });
  const pages = (seed.pages || []).filter((p) => p.status !== 'draft');
  const origin = new URL(base).origin;

  // ── pages ──
  const refs = new Map(); // path -> { kind, from:Set }
  const remoteImages = new Set();
  const failedPages = [];
  const slow = [];
  await pool(pages, 4, async (p) => {
    const t0 = Date.now();
    const r = await fetchFollow(base, p.path);
    const ms = Date.now() - t0;
    if (ms > 1500) slow.push(`${p.path} (${ms} ms)`);
    if (r.status !== 200) { failedPages.push(`${p.path} → ${r.status}${r.chain.length ? ` via ${r.chain.join(', ')}` : ''}`); await r.res?.arrayBuffer().catch(() => {}); return; }
    const html = await r.res.text();
    if (!html.includes('data-sp-block')) failedPages.push(`${p.path} → 200 but no blocks rendered`);
    for (const ref of extractRefs(html)) {
      const u = ref.url;
      if (/^(#|mailto:|tel:|javascript:|data:|sms:)/i.test(u)) continue;
      let abs;
      try { abs = new URL(u, base + p.path); } catch { continue; }
      if (abs.origin !== origin) {
        if (ref.tag === 'img' || ref.tag === 'source') remoteImages.add(abs.href);
        continue;
      }
      const key = abs.pathname + abs.search;
      const kind = ref.tag === 'a' ? 'link' : ref.tag === 'img' || ref.tag === 'source' || key.startsWith('/media/') ? 'image' : 'asset';
      if (!refs.has(key)) refs.set(key, { kind, from: new Set() });
      refs.get(key).from.add(p.path);
    }
  });
  if (failedPages.length) add('fail', `${failedPages.length} of ${pages.length} pages failed`, failedPages.join('\n'));
  else add('pass', `All ${pages.length} pages render (200, blocks present)`);
  if (slow.length) add('warn', 'Slow pages (> 1.5 s)', slow.join('\n'));

  // ── everything they link to ──
  const pagePaths = new Set(pages.map((p) => p.path));
  const toCheck = [...refs.entries()].filter(([k]) => !pagePaths.has(k.split('?')[0]));
  const results = await pool(toCheck, 6, async ([key, info]) => {
    const r = await fetchFollow(base, key);
    let bad = r.status >= 400 || r.loop;
    if (!bad && info.kind === 'image' && r.type && !r.type.startsWith('image/')) bad = true;
    await r.res?.arrayBuffer().catch(() => {});
    return { key, info, r, bad };
  });
  const byKind = { link: [], image: [], asset: [] };
  const redirected = [];
  for (const { key, info, r, bad } of results) {
    if (bad) byKind[info.kind].push(`${key} → ${r.loop ? 'redirect loop' : r.status}${info.kind === 'image' && r.status < 400 ? ` (${r.type})` : ''}  [on ${[...info.from].slice(0, 3).join(', ')}${info.from.size > 3 ? '…' : ''}]`);
    else if (r.chain.length && info.kind === 'link') redirected.push(`${key} ${r.chain.join(', ')}`);
  }
  const count = (k) => results.filter((x) => x.info.kind === k).length;
  if (byKind.link.length) add('fail', `${byKind.link.length} broken internal link${byKind.link.length === 1 ? '' : 's'}`, byKind.link.join('\n'));
  else add('pass', `Internal links OK (${count('link')} beyond the page list)`);
  if (byKind.image.length) add('fail', `${byKind.image.length} broken image${byKind.image.length === 1 ? '' : 's'}`, byKind.image.join('\n'));
  else add('pass', `Images OK (${count('image')})`);
  if (byKind.asset.length) add('fail', `${byKind.asset.length} broken script/style asset${byKind.asset.length === 1 ? '' : 's'}`, byKind.asset.join('\n'));
  else add('pass', `Scripts and styles OK (${count('asset')})`);
  if (redirected.length) add('warn', `${redirected.length} link${redirected.length === 1 ? '' : 's'} go through a redirect`, `Works, but the link could point straight at the page:\n${redirected.join('\n')}`);
  if (remoteImages.size) add('warn', `${remoteImages.size} image${remoteImages.size === 1 ? ' loads' : 's load'} from another site`, [...remoteImages].slice(0, 15).join('\n'));

  // ── redirects from seed.json ──
  const redirects = seed.redirects || [];
  if (redirects.length) {
    const bad = [];
    await pool(redirects, 4, async (rd) => {
      const res = await fetch(base + rd.from, { redirect: 'manual' });
      const loc = res.headers.get('location');
      await res.arrayBuffer().catch(() => {});
      const to = loc ? new URL(loc, base).pathname : null;
      if (res.status < 300 || res.status >= 400 || to !== rd.to) bad.push(`${rd.from} → expected ${rd.status || 301} ${rd.to}, got ${res.status}${to ? ` ${to}` : ''}`);
    });
    if (bad.length) add('fail', `${bad.length} of ${redirects.length} redirects wrong`, bad.join('\n'));
    else add('pass', redirects.length === 1 ? 'The redirect answers correctly' : `All ${redirects.length} redirects answer correctly`);
  }

  // ── site-level endpoints ──
  const miss = await fetch(`${base}/proof-check-${Date.now()}-does-not-exist`);
  await miss.arrayBuffer().catch(() => {});
  if (miss.status === 404) add('pass', 'Unknown paths return 404');
  else add('fail', `Unknown paths return ${miss.status}`, 'Expected 404. Search engines would index a soft 404 as a real page.');

  const sm = await fetch(`${base}/sitemap.xml`);
  if (sm.ok) {
    const xml = await sm.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => { try { return new URL(m[1]).pathname.replace(/(.)\/$/, '$1'); } catch { return m[1]; } });
    const missing = [...pagePaths].filter((p) => !locs.includes(p));
    if (missing.length) add('warn', 'Pages missing from sitemap.xml', missing.join('\n'));
    else add('pass', `sitemap.xml lists all ${locs.length} pages`);
  } else add('fail', `sitemap.xml returned ${sm.status}`);

  const robots = await fetch(`${base}/robots.txt`);
  const rtxt = robots.ok ? await robots.text() : '';
  if (!robots.ok) add('fail', `robots.txt returned ${robots.status}`);
  else if (site.mode === 'full' && /Disallow:\s*\/\s*$/m.test(rtxt)) add('fail', 'robots.txt blocks the whole site in Full mode', 'The deployed site would not be indexed.');
  else add('pass', 'robots.txt OK');

  return items;
}
