<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { api, notify, store } from './store.js';
import LogPanel from './LogPanel.vue';

const props = defineProps({ site: { type: Object, required: true } });
const emit = defineEmits(['removed']);

const s = computed(() => props.site);
const busy = ref('');
const armed = ref(false);
const now = ref(Date.now());
let tick;
onMounted(() => { tick = setInterval(() => { now.value = Date.now(); }, 15e3); });
onBeforeUnmount(() => clearInterval(tick));

const working = computed(() => ['installing', 'building', 'starting', 'stopping'].includes(s.value.status));
const running = computed(() => s.value.status === 'running');
const full = computed(() => s.value.mode === 'full');

const statusLine = computed(() => {
  const st = s.value.status;
  const where = `${full.value ? 'Full' : 'Preview'} mode on port ${s.value.port}`;
  return {
    running: `Running in ${where}`,
    stopped: `Stopped. Starts in ${where}.`,
    installing: 'Installing dependencies (first site with this package.json only)',
    building: 'Building client and SSR bundles',
    starting: full.value ? 'Starting: database, migrations, seed import' : 'Starting',
    stopping: 'Stopping',
    error: 'Failed',
  }[st] || st;
});

function ago(iso) {
  if (!iso) return '';
  const sec = Math.max(0, (now.value - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

async function act(name, path, body, okText) {
  busy.value = name;
  try {
    const out = await api('POST', `/api/sites/${s.value.slug}/${path}`, body);
    if (okText || out?.message) notify('ok', out?.message || okText);
    return out;
  } catch (err) { notify('error', err.message); } finally { busy.value = ''; }
}

const setMode = (mode) => { if (mode !== s.value.mode) act('mode', 'mode', { mode }); };
const runChecks = () => act('checks', 'checks');

async function remove() {
  if (!armed.value) { armed.value = true; setTimeout(() => { armed.value = false; }, 4000); return; }
  busy.value = 'remove';
  try { await api('DELETE', `/api/sites/${s.value.slug}`); notify('ok', `Removed ${s.value.slug}`); emit('removed'); } catch (err) { notify('error', err.message); } finally { busy.value = ''; }
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); notify('ok', `Copied the ${what}`); } catch { notify('error', 'Clipboard is blocked in this browser'); }
}

const checks = computed(() => s.value.checks);
const checksRunning = computed(() => busy.value === 'checks' || s.value.checksRunning);
const summaryText = computed(() => {
  const c = checks.value?.summary;
  if (!c) return '';
  const parts = [`${c.pass} passed`];
  if (c.warn) parts.push(`${c.warn} to look at`);
  parts.push(c.fail ? `${c.fail} failed` : 'nothing failed');
  return parts.join(', ');
});
const stale = computed(() => checks.value && (checks.value.mode !== s.value.mode || !checks.value.live));
</script>

<template>
  <article class="sheet">
    <header class="head">
      <div class="title">
        <h2>{{ s.slug }}</h2>
        <p class="meta">
          <span v-if="s.source">Rebuilt from <a :href="s.source" target="_blank" rel="noopener">{{ s.source.replace(/^https?:\/\//, '') }}</a></span>
          <span v-if="s.coreVersion">core {{ s.coreVersion }}</span>
          <span v-if="s.pageCount != null">{{ s.pageCount }} page{{ s.pageCount === 1 ? '' : 's' }}</span>
          <span>{{ s.kind === 'folder' ? 'Folder, run in place' : `Imported ${ago(s.importedAt)}` }}</span>
        </p>
      </div>
      <div class="mode" role="radiogroup" aria-label="Mode">
        <button role="radio" :aria-checked="!full" :class="{ on: !full }" :disabled="working" @click="setMode('preview')">
          <b>Preview</b><small>seed.json, no database</small>
        </button>
        <button role="radio" :aria-checked="full" :class="{ on: full }" :disabled="working" @click="setMode('full')">
          <b>Full</b><small>Postgres and admin</small>
        </button>
      </div>
    </header>

    <div class="status" :class="s.status">
      <span class="dot"></span>
      <span>{{ statusLine }}</span>
    </div>
    <p v-if="s.status === 'error' && s.error" class="error-box">{{ s.error }}</p>

    <div class="actions">
      <button v-if="!running && s.status !== 'starting'" class="btn solid" :disabled="working || !!busy" @click="act('start', 'start')">Start</button>
      <button v-else class="btn solid" :disabled="s.status === 'stopping' || !!busy" @click="act('stop', 'stop')">Stop</button>
      <button class="btn" :disabled="working || !!busy || !running" @click="act('restart', 'restart')">Restart</button>
      <button class="btn" :disabled="working || checksRunning" @click="runChecks">{{ checksRunning ? 'Running checks…' : 'Run checks' }}</button>
      <span class="spacer"></span>
      <button class="btn quiet" :disabled="working || !!busy" title="Rebuild the Vite bundles even if nothing changed" @click="act('rebuild', 'rebuild')">Rebuild</button>
      <button v-if="full" class="btn quiet" :disabled="working || !!busy" title="npm run seed -- --replace: pages and redirects from site/seed.json; users, uploads and submissions stay" @click="act('reset', 'reset-content')">Reset content</button>
      <button v-if="full" class="btn quiet" :disabled="working || !!busy" title="Drop the database and uploads; the next start seeds from scratch" @click="act('wipe', 'wipe-db', null, 'Database dropped')">Wipe database</button>
      <button v-if="store.platform === 'darwin'" class="btn quiet" @click="act('reveal', 'reveal')">Show in Finder</button>
      <button class="btn quiet danger" :class="{ armed }" :disabled="busy === 'remove'" @click="remove">{{ armed ? 'Click again to remove' : 'Remove' }}</button>
    </div>

    <div class="links">
      <a class="btn" :class="{ disabled: !running }" :href="s.urls.site" target="_blank" rel="noopener">Open site</a>
      <a class="btn" :class="{ disabled: !running || !full }" :href="s.urls.admin" target="_blank" rel="noopener" :title="full ? 'Signs you in as the test owner' : 'Switch to Full mode for the admin'">Open admin</a>
      <a class="btn quiet" :class="{ disabled: !running }" :href="s.urls.direct" target="_blank" rel="noopener" title="Direct port, for browsers that don't resolve *.localhost">Port {{ s.port }}</a>
      <a v-if="s.source" class="btn quiet" :href="s.source" target="_blank" rel="noopener">Original site</a>
      <a v-if="s.urls.report" class="btn quiet" :href="s.urls.report" target="_blank" rel="noopener">site-press report</a>
      <span v-else class="hint">Drop the report.tar.gz here to attach it</span>
    </div>

    <p v-if="full" class="creds">
      Admin login: <button class="cred" @click="copy(s.admin.email, 'email')">{{ s.admin.email }}</button>
      <button class="cred" @click="copy(s.admin.password, 'password')">{{ s.admin.password }}</button>
      <span class="hint">Open admin signs you in; these are for the direct port or a second browser.</span>
    </p>

    <div class="panes">
      <section class="checks" aria-label="Checks">
        <div class="pane-head">
          <h3>Checks</h3>
          <p v-if="checks" class="summary" :class="{ bad: checks.summary.fail }">{{ summaryText }}, {{ ago(checks.ranAt) }}</p>
        </div>
        <p v-if="stale" class="hint stale">These ran {{ checks.live ? `in ${checks.mode} mode` : 'with the site stopped' }}. Run them again for the current state.</p>
        <p v-if="!checks" class="hint">
          Checks read the files, crawl every page, link and image, and in Full mode exercise the admin: sign in, edit and save, upload an image, send the contact form.
          {{ running ? '' : 'Start the site first to get the crawl and admin checks.' }}
        </p>
        <div v-for="g in checks?.groups || []" :key="g.name" class="group">
          <h4>{{ g.name }}</h4>
          <ul>
            <li v-for="(item, i) in g.items" :key="i" :class="item.status">
              <span class="mark" :aria-label="item.status">{{ { pass: '✓', fail: '✗', warn: '!', skip: '–' }[item.status] }}</span>
              <details v-if="item.detail && item.status !== 'pass'" :open="item.status === 'fail'">
                <summary><span class="label">{{ item.label }}</span></summary>
                <pre>{{ item.detail }}</pre>
              </details>
              <span v-else class="label" :title="item.detail || ''">{{ item.label }}</span>
            </li>
          </ul>
        </div>
      </section>
      <LogPanel :slug="s.slug" />
    </div>
  </article>
</template>

<style scoped>
.sheet { background: var(--paper); color: var(--ink); box-shadow: var(--shadow); padding: 30px 34px 34px; border-radius: 2px; min-width: 0; }
.head { display: flex; gap: 24px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.title { min-width: 0; }
h2 { margin: 0; font-size: clamp(30px, 4vw, 44px); line-height: 1.02; font-weight: 850; font-variation-settings: 'wdth' 125; letter-spacing: -0.015em; overflow-wrap: anywhere; }
.meta { margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--mute); font-size: 14px; font-variation-settings: 'wdth' 85; }
.meta a { color: inherit; }

.mode { display: flex; border: 1.5px solid var(--ink); border-radius: 3px; overflow: hidden; flex: none; }
.mode button { display: flex; flex-direction: column; align-items: flex-start; padding: 7px 14px; background: transparent; border: 0; cursor: pointer; text-align: left; color: var(--ink); }
.mode button + button { border-left: 1.5px solid var(--ink); }
.mode button.on { background: var(--ink); color: var(--paper); }
.mode button[disabled] { cursor: wait; }
.mode b { font-variation-settings: 'wdth' 100; }
.mode small { font-size: 12px; opacity: 0.75; font-variation-settings: 'wdth' 78; }

.status { display: flex; align-items: center; gap: 9px; margin-top: 22px; font-weight: 600; font-variation-settings: 'wdth' 95; }
.status .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--mute); opacity: 0.5; }
.status.running .dot { background: var(--pencil); opacity: 1; }
.status.error { color: var(--red); } .status.error .dot { background: var(--red); opacity: 1; }
.status.installing .dot, .status.building .dot, .status.starting .dot, .status.stopping .dot { background: var(--highlight); opacity: 1; animation: pulse 1s ease-in-out infinite alternate; }
@keyframes pulse { to { opacity: 0.3; } }
.error-box { margin: 10px 0 0; padding: 10px 12px; border-left: 3px solid var(--red); background: var(--paper-2); white-space: pre-wrap; font-size: 14px; }

.actions, .links { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 16px; }
.actions .spacer { flex: 1; }
.links { padding-top: 16px; border-top: 1px solid var(--rule); }
.hint { color: var(--mute); font-size: 13.5px; font-variation-settings: 'wdth' 88; }
.creds { margin: 12px 0 0; font-size: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.cred { border: 1px dashed var(--rule); background: var(--paper-2); padding: 2px 8px; border-radius: 3px; cursor: copy; font-size: 13.5px; }

.panes { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 28px; margin-top: 26px; }
.pane-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
h3 { margin: 0; font-size: 20px; font-weight: 800; font-variation-settings: 'wdth' 115; }
.summary { margin: 0; color: var(--mute); font-size: 14px; }
.summary.bad { color: var(--red); font-weight: 600; }
.stale { margin: 6px 0 0; }
.checks > .hint { margin-top: 8px; max-width: 60ch; }

.group { margin-top: 18px; }
h4 { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: var(--mute); font-variation-settings: 'wdth' 100; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: start; padding: 4px 0; font-size: 14.5px; }
.mark { font-weight: 800; text-align: center; line-height: 1.5; }
li.pass .mark { color: var(--ok); }
li.fail .mark { color: var(--red); font-size: 16px; }
li.skip { color: var(--mute); }
/* A proofreader's highlighter for things to look at, a red pen for failures. */
li.warn .label { background: linear-gradient(transparent 12%, color-mix(in srgb, var(--highlight) 70%, transparent) 12%, color-mix(in srgb, var(--highlight) 70%, transparent) 88%, transparent 88%); padding: 0 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
li.fail .label { text-decoration: underline wavy var(--red); text-decoration-thickness: 1.5px; text-underline-offset: 4px; }
summary { cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::after { content: ' show'; color: var(--mute); font-size: 12.5px; }
details[open] > summary::after { content: ' hide'; }
pre { margin: 6px 0 4px; padding: 9px 11px; background: var(--paper-2); font: 12.5px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); max-height: 260px; overflow: auto; }

@media (max-width: 1100px) { .panes { grid-template-columns: 1fr; } }
@media (max-width: 600px) {
  .sheet { padding: 22px 16px 24px; }
  .actions .spacer { display: none; }
  .mode { width: 100%; } .mode button { flex: 1; }
}
</style>
