import path from 'node:path';
import zlib from 'node:zlib';
import { readJson } from '../util.js';

// Exercises the admin the way a client would, through its API: sign in,
// re-save every page, edit a heading and see it on the public page, upload
// and delete an image, submit the contact form. Runs against the test
// database only (Full mode).

function tinyPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(12).fill(200)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const strip = ({ id: _id, ...b }) => b;
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

function diffKeys(a, b, prefix = '') {
  if (stable(a) === stable(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [prefix || '(value)'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffKeys(a[k], b[k], prefix ? `${prefix}.${k}` : k));
}

export async function adminChecks(site, base, session) {
  const items = [];
  const add = (status, label, detail) => items.push({ status, label, detail });
  const headers = { cookie: `sp_session=${session}`, 'x-sp-csrf': '1' };
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  const st = await (await fetch(`${base}/api/auth/state`, { headers })).json();
  if (!st.user) { add('fail', 'Admin sign-in', 'The stored session was rejected.'); return items; }
  add('pass', `Signed in as ${st.user.email} (${st.user.role})`);

  const adminPage = await fetch(`${base}/admin`);
  await adminPage.arrayBuffer().catch(() => {});
  if (adminPage.status === 200) add('pass', '/admin loads');
  else add('fail', `/admin returned ${adminPage.status}`);

  const seed = await readJson(path.join(site.dir, 'site/seed.json'), { pages: [] });
  const list = await api('GET', '/api/admin/pages');
  if (list.status !== 200) { add('fail', `Page list returned ${list.status}`, list.data?.error); return items; }
  const pages = list.data;
  const seedPaths = new Set((seed.pages || []).map((p) => p.path));
  const dbPaths = new Set(pages.map((p) => p.path));
  const notImported = [...seedPaths].filter((p) => !dbPaths.has(p));
  if (notImported.length) add('fail', `${notImported.length} seed page${notImported.length === 1 ? '' : 's'} not in the database`, notImported.join('\n'));
  else add('pass', `All ${seedPaths.size} seed pages imported`);

  // ── edit round trip on the home page ──
  const home = pages.find((p) => p.path === '/') || pages[0];
  if (home) {
    const full = (await api('GET', `/api/admin/pages/${home.id}`)).data;
    const target = full.blocks.find((b) => typeof b.props?.heading === 'string' && b.props.heading);
    if (!target) add('skip', 'Edit round trip', `No block with a heading on ${home.path} to edit.`);
    else {
      const marker = `proof-${Date.now().toString(36)}`;
      const original = target.props.heading;
      const edited = { ...full, blocks: full.blocks.map((b) => (b.id === target.id ? { ...b, props: { ...b.props, heading: `${original} ${marker}` } } : b)) };
      const save = await api('PUT', `/api/admin/pages/${home.id}`, edited);
      if (save.status !== 200) add('fail', `Saving ${home.path} returned ${save.status}`, [save.data?.error, ...(save.data?.details || [])].filter(Boolean).join('\n'));
      else {
        const html = await (await fetch(base + home.path)).text();
        if (html.includes(marker)) add('pass', `Edit a heading on ${home.path} → shows on the public page`);
        else add('fail', `Edited heading on ${home.path} didn't appear on the public page`, 'Saved OK, but the rendered page still shows the old text (caching?).');
        const restore = await api('PUT', `/api/admin/pages/${home.id}`, { ...(save.data || full), blocks: (save.data || full).blocks.map((b) => (b.id === target.id ? { ...b, props: { ...b.props, heading: original } } : b)) });
        if (restore.status !== 200) add('warn', `Couldn't put the original heading back on ${home.path}`, restore.data?.error);
      }
    }
  }

  // ── every page survives a save from the admin unchanged ──
  // A page that fails validation can't be published by the client; one whose
  // content changes on save will shift the first time they press Save.
  const rejected = [];
  const drifted = [];
  for (const p of pages) {
    const before = (await api('GET', `/api/admin/pages/${p.id}`)).data;
    const res = await api('PUT', `/api/admin/pages/${p.id}`, before);
    if (res.status !== 200) { rejected.push(`${p.path}: ${res.data?.error || res.status}${res.data?.details?.length ? `\n  ${res.data.details.slice(0, 5).join('\n  ')}` : ''}`); continue; }
    if (res.data?.warnings?.length) drifted.push(`${p.path}: ${res.data.warnings.slice(0, 3).join('; ')}`);
    for (const [i, b] of before.blocks.entries()) {
      const after = res.data.blocks[i];
      const keys = after ? diffKeys(strip(b), strip(after)) : ['(block removed)'];
      if (keys.length) drifted.push(`${p.path} section ${i + 1} (${b.type}): ${keys.slice(0, 5).join(', ')}`);
    }
  }
  if (rejected.length) add('fail', `${rejected.length} page${rejected.length === 1 ? '' : 's'} can't be saved from the admin`, rejected.join('\n'));
  else add('pass', `All ${pages.length} pages save from the admin`);
  if (drifted.length) add('warn', 'Saving changes some content', `The first Save in the admin rewrites these (sanitiser or schema defaults). Check they still look right:\n${drifted.slice(0, 20).join('\n')}`);

  // ── media upload ──
  const fd = new FormData();
  fd.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'proof-check.png');
  const up = await fetch(`${base}/api/admin/media`, { method: 'POST', headers, body: fd });
  const upData = await up.json().catch(() => ({}));
  if (up.status !== 201) add('fail', `Image upload returned ${up.status}`, upData.error);
  else {
    const img = await fetch(base + upData.url);
    await img.arrayBuffer().catch(() => {});
    const served = img.status === 200 && (img.headers.get('content-type') || '').startsWith('image/');
    const del = await api('DELETE', `/api/admin/media/${upData.id}`);
    const gone = await fetch(base + upData.url);
    await gone.arrayBuffer().catch(() => {});
    if (served && del.status === 200 && gone.status === 404) add('pass', 'Upload an image → served at /media → delete removes it');
    else add('fail', 'Image upload round trip', `served: ${img.status} ${img.headers.get('content-type')}, delete: ${del.status}, after delete: ${gone.status}`);
  }

  const settings = await api('GET', '/api/admin/settings');
  if (settings.status === 200 && settings.data?.siteTitle !== undefined) add('pass', `Site settings load ("${settings.data.siteTitle}")`);
  else add('fail', `Site settings returned ${settings.status}`);

  // ── contact forms ──
  const formBlocks = [];
  for (const p of pages) {
    const full = (await api('GET', `/api/admin/pages/${p.id}`)).data;
    for (const b of full.blocks) if (b.type === 'contact-form') formBlocks.push({ path: p.path, b });
  }
  for (const { path: pth, b } of formBlocks.slice(0, 3)) {
    const fields = b.props?.fields || [];
    if (!fields.length) { add('fail', `Contact form on ${pth} has no fields`, 'Every submission is rejected with "The form is empty."'); continue; }
    const values = Object.fromEntries(fields.map((f) => [f.name, f.type === 'email' ? 'proof@proof.test' : `proof check ${f.label}`]));
    const res = await fetch(`${base}/api/forms/${b.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) { add('skip', `Contact form on ${pth}`, 'Rate-limited (5 per 10 minutes). Run checks again later.'); continue; }
    if (res.status !== 200) { add('fail', `Contact form on ${pth} returned ${res.status}`, data.error); continue; }
    const subs = await api('GET', '/api/admin/submissions');
    const found = (subs.data || []).some((s) => s.page_path === pth && JSON.stringify(s.payload).includes('proof'));
    if (found) add('pass', `Contact form on ${pth} → submission listed in the admin`);
    else add('fail', `Contact form on ${pth} accepted the post but it's not in Form submissions`);
  }

  return items;
}
