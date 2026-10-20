<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { store, connect, uploadFiles, api, notify } from './store.js';
import SiteSheet from './SiteSheet.vue';

const selected = ref(location.hash.replace(/^#\/?/, '') || null);
const site = computed(() => store.sites.find((s) => s.slug === selected.value) || null);
const dragging = ref(false);
const pathInput = ref('');
const busy = ref(false);
let dragDepth = 0;

function select(slug) {
  selected.value = slug;
  history.replaceState(null, '', slug ? `#/${slug}` : '#/');
}
watch(() => store.sites.length, () => {
  if (!site.value && store.sites.length) select(store.sites[0].slug);
});
window.addEventListener('hashchange', () => { selected.value = location.hash.replace(/^#\/?/, '') || null; });

const statusText = {
  stopped: 'Stopped', installing: 'Installing', building: 'Building', starting: 'Starting',
  running: 'Running', stopping: 'Stopping', error: 'Failed',
};
const pgText = computed(() => {
  const pg = store.pg;
  if (pg.external) return pg.status === 'running' ? 'Postgres: your server' : `Postgres: your server (${pg.status})`;
  return { running: `Postgres on :${pg.port}`, starting: 'Postgres starting', error: 'Postgres failed', stopped: 'Postgres idle' }[pg.status] || pg.status;
});

// Whole-window drop target, so a tarball can land anywhere.
const onEnter = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; dragging.value = true; e.preventDefault(); } };
const onLeave = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragging.value = false; };
const onOver = (e) => { if (dragging.value) e.preventDefault(); };
async function onDrop(e) {
  e.preventDefault();
  dragDepth = 0; dragging.value = false;
  const first = await uploadFiles(e.dataTransfer.files, selected.value);
  if (first) select(first);
}

async function importPath() {
  if (!pathInput.value.trim()) return;
  busy.value = true;
  try {
    const { kind, sites } = await api('POST', '/api/import', { path: pathInput.value.trim() });
    notify('ok', kind === 'report' ? `Report attached to ${sites[0].slug}` : `Imported ${sites[0].slug}, starting it`);
    select(sites[0].slug);
    pathInput.value = '';
  } catch (err) { notify('error', err.message); } finally { busy.value = false; }
}

async function pick(kind) {
  busy.value = true;
  try {
    const out = await api('POST', '/api/pick', { kind });
    if (out.sites) { notify('ok', `Imported ${out.sites[0].slug}, starting it`); select(out.sites[0].slug); }
  } catch (err) { notify('error', err.message); } finally { busy.value = false; }
}

const fileInput = ref(null);
async function onFileChosen(e) {
  const first = await uploadFiles(e.target.files, selected.value);
  if (first) select(first);
  e.target.value = '';
}

onMounted(async () => {
  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('dragover', onOver);
  window.addEventListener('drop', onDrop);
  try { await connect(); } catch (err) { notify('error', `Can't reach proof: ${err.message}`); }
  if (!site.value && store.sites.length) select(store.sites[0].slug);
});
onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onEnter);
  window.removeEventListener('dragleave', onLeave);
  window.removeEventListener('dragover', onOver);
  window.removeEventListener('drop', onDrop);
});
</script>

<template>
  <div class="ruler" aria-hidden="true"><span v-for="n in 24" :key="n" :style="{ left: `${n * 160}px` }">{{ n }}</span></div>

  <header class="top">
    <h1 class="mark">proof</h1>
    <p class="tag">Test bench for site-press output</p>
    <div class="top-right">
      <span class="pg" :class="store.pg.status" :title="store.pg.error || ''"><i></i>{{ pgText }}</span>
      <span v-if="!store.connected" class="pg error"><i></i>Dashboard disconnected</span>
    </div>
  </header>

  <div class="layout">
    <aside class="rail">
      <section class="drop" :class="{ hot: dragging }">
        <span class="crop tl"></span><span class="crop tr"></span><span class="crop bl"></span><span class="crop br"></span>
        <p class="drop-title">Drop a site or report .tar.gz</p>
        <p class="drop-sub">Anywhere on this page. A site starts as soon as it's unpacked.</p>
        <div class="drop-actions">
          <template v-if="store.platform === 'darwin'">
            <button class="btn mat-btn" :disabled="busy" @click="pick('folder')">Choose folder</button>
            <button class="btn mat-btn" :disabled="busy" @click="pick('file')">Choose tarball</button>
          </template>
          <button v-else class="btn mat-btn" :disabled="busy" @click="fileInput.click()">Choose tarball</button>
          <input ref="fileInput" type="file" accept=".gz,.tgz" multiple hidden @change="onFileChosen" />
        </div>
        <form class="path" @submit.prevent="importPath">
          <label for="path">Or a path on this {{ store.platform === 'darwin' ? 'Mac' : 'computer' }}</label>
          <div class="path-row">
            <input id="path" v-model="pathInput" placeholder="~/Downloads/acme-site.tar.gz" autocomplete="off" spellcheck="false" />
            <button class="btn mat-btn" :disabled="busy || !pathInput.trim()">Import</button>
          </div>
        </form>
      </section>

      <nav class="tickets" v-if="store.sites.length" aria-label="Sites">
        <button v-for="s in store.sites" :key="s.slug" class="ticket" :class="{ on: s.slug === selected }" @click="select(s.slug)">
          <span class="t-name">{{ s.slug }}</span>
          <span class="t-meta">
            <span class="dot" :class="s.status"></span>{{ statusText[s.status] || s.status }}, {{ s.mode === 'full' ? 'Full' : 'Preview' }}
            <span v-if="s.checks" class="t-checks" :class="{ bad: s.checks.summary.fail }">{{ s.checks.summary.fail ? `${s.checks.summary.fail} failing` : 'checks pass' }}</span>
          </span>
        </button>
      </nav>
    </aside>

    <main class="bench">
      <SiteSheet v-if="site" :key="site.slug" :site="site" @removed="select(null)" />
      <div v-else class="empty">
        <h2>Nothing on the bench yet</h2>
        <p>Drop a <b>site.tar.gz</b> from a site-press job anywhere on this page, or run <code>proof ~/Downloads/acme-site.tar.gz</code> in a terminal. Drop the <b>report.tar.gz</b> with it to read the report here too.</p>
      </div>
    </main>
  </div>

  <div v-if="dragging" class="overlay" aria-hidden="true"><p>Drop to import</p></div>
  <div v-if="store.notice" class="notice" :class="store.notice.kind" role="status" @click="store.notice = null">{{ store.notice.text }}</div>
</template>

<style scoped>
.ruler {
  position: fixed; inset: 0 0 auto 0; height: 18px; z-index: 1; pointer-events: none;
  background:
    repeating-linear-gradient(90deg, var(--mat-ink) 0 1px, transparent 1px 32px) 0 0 / 100% 10px no-repeat,
    repeating-linear-gradient(90deg, var(--mat-ink) 0 1px, transparent 1px 8px) 0 0 / 100% 5px no-repeat;
  opacity: 0.45;
}
.ruler span { position: absolute; top: 6px; transform: translateX(3px); font-size: 10px; font-variation-settings: 'wdth' 70; color: var(--mat-ink); }

.top { display: flex; align-items: baseline; gap: 18px; padding: 30px 32px 18px; flex-wrap: wrap; }
.mark {
  margin: 0; font-size: 44px; line-height: 1; font-weight: 850;
  font-variation-settings: 'wdth' 125; letter-spacing: -0.02em; color: var(--mat-ink);
}
.tag { margin: 0; color: var(--mat-mute); font-variation-settings: 'wdth' 80; }
.top-right { margin-left: auto; display: flex; gap: 14px; }
.pg { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--mat-mute); font-variation-settings: 'wdth' 80; }
.pg i { width: 8px; height: 8px; border-radius: 50%; background: var(--mat-mute); }
.pg.running i { background: #9fe0b8; }
.pg.starting i { background: var(--highlight); }
.pg.error { color: #ffb4a6; } .pg.error i { background: #ff8a76; }

.layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 28px; padding: 0 32px 48px; align-items: start; }

.drop { position: relative; padding: 22px 20px 20px; }
.drop.hot { background: rgba(232, 240, 196, 0.08); }
.crop { position: absolute; width: 16px; height: 16px; border-color: var(--mat-ink); border-style: solid; border-width: 0; }
.crop.tl { top: 0; left: 0; border-top-width: 1.5px; border-left-width: 1.5px; }
.crop.tr { top: 0; right: 0; border-top-width: 1.5px; border-right-width: 1.5px; }
.crop.bl { bottom: 0; left: 0; border-bottom-width: 1.5px; border-left-width: 1.5px; }
.crop.br { bottom: 0; right: 0; border-bottom-width: 1.5px; border-right-width: 1.5px; }
.drop-title { margin: 0 0 4px; font-weight: 700; font-size: 17px; font-variation-settings: 'wdth' 110; }
.drop-sub { margin: 0 0 14px; color: var(--mat-mute); font-size: 13.5px; }
.drop-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.path { margin-top: 16px; }
.path label { display: block; font-size: 13px; color: var(--mat-mute); margin-bottom: 5px; }
.path-row { display: flex; gap: 6px; }
.path input {
  flex: 1; min-width: 0; padding: 7px 9px; border-radius: 3px;
  border: 1.5px solid rgba(232, 240, 196, 0.35); background: var(--mat-deep); color: var(--mat-ink);
  font-size: 13.5px;
}
.path input::placeholder { color: rgba(232, 240, 196, 0.35); }

.tickets { margin-top: 22px; display: flex; flex-direction: column; gap: 2px; }
.ticket {
  display: block; width: 100%; text-align: left; padding: 11px 14px; border: 0; border-radius: 3px;
  background: transparent; color: var(--mat-ink); cursor: pointer;
}
.ticket:hover { background: rgba(232, 240, 196, 0.07); }
.ticket.on { background: var(--paper); color: var(--ink); box-shadow: var(--shadow); }
.t-name { display: block; font-weight: 750; font-size: 16px; font-variation-settings: 'wdth' 112; overflow-wrap: anywhere; }
.t-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; opacity: 0.8; font-variation-settings: 'wdth' 85; }
.t-checks { margin-left: auto; }
.t-checks.bad { color: #ffb4a6; font-weight: 600; }
.ticket.on .t-checks.bad { color: var(--red); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.4; flex: none; }
.dot.running { background: var(--pencil); opacity: 1; }
.ticket:not(.on) .dot.running { background: #8fd0f5; }
.dot.error { background: #ff8a76; opacity: 1; }
.dot.installing, .dot.building, .dot.starting, .dot.stopping { background: var(--highlight); opacity: 1; animation: pulse 1s ease-in-out infinite alternate; }
@keyframes pulse { to { opacity: 0.35; } }

.empty { background: var(--paper); color: var(--ink); padding: 40px 44px; box-shadow: var(--shadow); max-width: 680px; border-radius: 2px; }
.empty h2 { margin: 0 0 10px; font-size: 26px; font-variation-settings: 'wdth' 118; font-weight: 800; }
.empty p { margin: 0; color: var(--mute); max-width: 62ch; }
.empty code { font-family: var(--mono); font-size: 13px; background: var(--paper-2); padding: 1px 5px; color: var(--ink); }

.overlay {
  position: fixed; inset: 12px; z-index: 20; display: grid; place-items: center; pointer-events: none;
  border: 2px dashed var(--mat-ink); background: rgba(23, 58, 53, 0.72);
}
.overlay p { font-size: 40px; font-weight: 850; font-variation-settings: 'wdth' 125; color: var(--mat-ink); margin: 0; }
.notice {
  position: fixed; right: 20px; bottom: 20px; z-index: 30; max-width: min(460px, calc(100vw - 40px));
  padding: 12px 16px; background: var(--paper); color: var(--ink); box-shadow: var(--shadow); border-left: 4px solid var(--ok);
  cursor: pointer; white-space: pre-wrap;
}
.notice.error { border-left-color: var(--red); }

@media (max-width: 860px) {
  .top { padding: 28px 16px 14px; }
  .layout { grid-template-columns: 1fr; padding: 0 16px 32px; gap: 18px; }
  .top-right { margin-left: 0; width: 100%; }
}
</style>
