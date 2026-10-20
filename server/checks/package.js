import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson } from '../util.js';

// Static checks on the unpacked files. No server needed.

const TEXT_EXT = new Set(['.js', '.vue', '.json', '.css', '.html', '.md', '.yml', '.yaml', '.sql', '.txt', '']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'seed-media']);

async function textFiles(dir, rel = '', out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) await textFiles(path.join(dir, e.name), r, out);
    else if (e.isFile() && TEXT_EXT.has(path.extname(e.name))) out.push(r);
  }
  return out;
}

// Every string in the seed that points at /media/… or an absolute image URL.
function mediaRefs(node, out = { local: new Set(), remote: new Set() }) {
  if (Array.isArray(node)) { for (const v of node) mediaRefs(v, out); return out; }
  if (node && typeof node === 'object') {
    if (typeof node.src === 'string') {
      if (node.src.startsWith('/media/')) out.local.add(node.src.slice(7));
      else if (/^https?:\/\//.test(node.src)) out.remote.add(node.src);
    }
    for (const v of Object.values(node)) mediaRefs(v, out);
  }
  return out;
}

export async function packageChecks(site) {
  const items = [];
  const add = (status, label, detail) => items.push({ status, label, detail });
  const dir = site.dir;

  const meta = await readJson(path.join(dir, 'site-press.json'), null);
  if (meta) add('pass', 'site-press.json present', `source ${meta.source || '?'}, core ${meta.coreVersion || '?'}`);
  else add(site.kind === 'folder' ? 'warn' : 'fail', 'site-press.json missing', 'The repo has no record of where it came from or which core it vendors.');

  const coreVersion = (await fs.readFile(path.join(dir, 'core/VERSION'), 'utf8').catch(() => '')).trim();
  if (meta?.coreVersion && coreVersion && meta.coreVersion !== coreVersion) add('warn', 'core/VERSION differs from site-press.json', `core/VERSION ${coreVersion}, site-press.json ${meta.coreVersion}. core/ was changed or re-copied after generation.`);

  const pkg = await readJson(path.join(dir, 'package.json'), null);
  const missingScripts = ['build', 'start', 'seed'].filter((s) => !pkg?.scripts?.[s]);
  if (!pkg) add('fail', 'package.json unreadable');
  else if (missingScripts.length) add('fail', 'package.json scripts missing', missingScripts.join(', '));
  else add('pass', 'package.json scripts build / start / seed');
  if (pkg?.name?.includes('__SITE_SLUG__')) add('fail', 'package.json name still has the template placeholder');

  if (await exists(path.join(dir, 'package-lock.json'))) add('pass', 'package-lock.json present');
  else add('warn', 'No package-lock.json', 'Dependencies resolve fresh on every install (^ ranges), so the Docker build on Beachhead may get different versions than you tested here.');

  // Leftover template placeholders anywhere in the source.
  const hits = [];
  for (const rel of await textFiles(dir)) {
    const text = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '');
    for (const ph of ['__SITE_SLUG__', '__SOURCE_URL__']) if (text.includes(ph)) hits.push(`${rel} (${ph})`);
  }
  if (hits.length) add('fail', 'Template placeholders left in files', hits.slice(0, 20).join('\n'));
  else add('pass', 'No leftover template placeholders');

  if (await exists(path.join(dir, '.env'))) add('warn', '.env file included', 'It would be committed with the repo unless .gitignore catches it.');

  for (const f of ['Dockerfile', 'docker-compose.yml', 'beachhead.json']) {
    if (!(await exists(path.join(dir, f)))) add('fail', `${f} missing`, 'Beachhead needs it to deploy.');
  }

  // seed.json
  let seed = null;
  try { seed = JSON.parse(await fs.readFile(path.join(dir, 'site/seed.json'), 'utf8')); } catch (err) {
    add('fail', 'site/seed.json unreadable', err.message);
    return items;
  }
  const pages = seed.pages || [];
  if (!pages.length) add('fail', 'seed.json has no pages');
  else add('pass', `seed.json: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${(seed.media || []).length} media, ${(seed.redirects || []).length} redirects`);
  if (!pages.some((p) => p.path === '/')) add('fail', 'No home page', 'seed.json has no page at "/".');
  const dupes = pages.map((p) => p.path).filter((p, i, a) => a.indexOf(p) !== i);
  if (dupes.length) add('fail', 'Duplicate page paths', [...new Set(dupes)].join(', '));

  // Block types exist (library blocks in core/blocks, custom x-* in site/blocks).
  const known = new Set([
    ...(await fs.readdir(path.join(dir, 'core/blocks')).catch(() => [])),
    ...(await fs.readdir(path.join(dir, 'site/blocks')).catch(() => [])).map((n) => n.replace(/\.vue$/, '')),
  ]);
  const unknown = new Set();
  const placeholders = [];
  for (const p of pages) for (const [i, b] of (p.blocks || []).entries()) {
    if (!known.has(b.type)) unknown.add(`${b.type} (on ${p.path})`);
    if (b.type === 'placeholder') placeholders.push(`${p.path} section ${i + 1}`);
  }
  if (unknown.size) add('fail', 'Blocks with no component', [...unknown].join('\n'));
  else add('pass', 'Every block type has a component');
  if (placeholders.length) add('warn', `${placeholders.length} placeholder section${placeholders.length === 1 ? '' : 's'}`, `Nothing in the library fitted these and no custom block was accepted:\n${placeholders.join('\n')}`);

  const forms = pages.flatMap((p) => (p.blocks || []).filter((b) => b.type === 'contact-form').map((b) => ({ path: p.path, b })));
  const emptyForms = forms.filter(({ b }) => !(b.props?.fields || []).length);
  if (emptyForms.length) add('fail', 'Contact form with no fields', `${emptyForms.map((f) => f.path).join(', ')}: visitors would get "The form is empty." on submit.`);

  // Media: listed rows have files, referenced files are listed, nothing hotlinked.
  const mediaDir = path.join(dir, 'site/seed-media');
  const onDisk = new Set(await fs.readdir(mediaDir).catch(() => []));
  onDisk.delete('.gitkeep');
  const listed = new Set((seed.media || []).map((m) => m.file));
  const missingFiles = [...listed].filter((f) => !onDisk.has(f));
  if (missingFiles.length) add('fail', 'Media rows with no file in seed-media', missingFiles.slice(0, 20).join('\n'));
  const refs = mediaRefs(seed);
  const unlisted = [...refs.local].filter((f) => !listed.has(f));
  if (unlisted.length) add('fail', 'Pages reference /media files not in seed.media', unlisted.slice(0, 20).join('\n'));
  const orphans = [...onDisk].filter((f) => !listed.has(f));
  if (orphans.length) add('warn', `${orphans.length} unused file${orphans.length === 1 ? '' : 's'} in seed-media`, orphans.slice(0, 20).join('\n'));
  if (refs.remote.size) add('warn', `${refs.remote.size} image${refs.remote.size === 1 ? '' : 's'} hotlinked from the old site`, `These failed to download and will break when the old site is cancelled:\n${[...refs.remote].slice(0, 15).join('\n')}`);
  if (!missingFiles.length && !unlisted.length) add('pass', `Media complete (${listed.size} file${listed.size === 1 ? '' : 's'})`);

  const big = [];
  for (const f of onDisk) {
    const st = await fs.stat(path.join(mediaDir, f)).catch(() => null);
    if (st && st.size > 1.5 * 1048576) big.push(`${f} (${(st.size / 1048576).toFixed(1)} MB)`);
  }
  if (big.length) add('warn', `${big.length} image${big.length === 1 ? '' : 's'} over 1.5 MB`, `The template serves images at their imported size:\n${big.slice(0, 15).join('\n')}`);

  return items;
}
