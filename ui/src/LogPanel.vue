<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';

const props = defineProps({ slug: { type: String, required: true } });
const lines = ref([]);
const box = ref(null);
const follow = ref(true);
const filter = ref('all');
let es;

const shown = computed(() => (filter.value === 'all' ? lines.value : lines.value.filter((l) => l.stream === 'stderr' || /error|fail/i.test(l.line))));

function scroll() {
  if (!follow.value) return;
  nextTick(() => { if (box.value) box.value.scrollTop = box.value.scrollHeight; });
}
function onScroll() {
  const el = box.value;
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

onMounted(() => {
  es = new EventSource(`/api/sites/${encodeURIComponent(props.slug)}/logs`);
  es.addEventListener('backlog', (e) => { lines.value = JSON.parse(e.data); scroll(); });
  es.addEventListener('log', (e) => {
    lines.value.push(JSON.parse(e.data));
    if (lines.value.length > 2000) lines.value.splice(0, lines.value.length - 2000);
    scroll();
  });
});
onBeforeUnmount(() => es?.close());
</script>

<template>
  <section class="log" aria-label="Log">
    <div class="pane-head">
      <h3>Log</h3>
      <div class="tabs">
        <button :class="{ on: filter === 'all' }" @click="filter = 'all'">Everything</button>
        <button :class="{ on: filter === 'errors' }" @click="filter = 'errors'">Errors</button>
      </div>
    </div>
    <div ref="box" class="box" @scroll="onScroll">
      <p v-if="!shown.length" class="quiet">{{ filter === 'all' ? 'Nothing logged since proof started.' : 'No errors.' }}</p>
      <div v-for="(l, i) in shown" :key="i" class="line" :class="l.stream"><time>{{ time(l.t) }}</time><span>{{ l.line }}</span></div>
    </div>
    <button v-if="!follow" class="jump" @click="follow = true; scroll()">Jump to latest</button>
  </section>
</template>

<style scoped>
.log { position: relative; min-width: 0; }
.pane-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 20px; font-weight: 800; font-variation-settings: 'wdth' 115; }
.tabs { display: flex; gap: 2px; }
.tabs button { border: 0; background: transparent; padding: 3px 9px; border-radius: 3px; cursor: pointer; font-size: 13.5px; color: var(--mute); }
.tabs button.on { background: var(--paper-2); color: var(--ink); font-weight: 600; }
.box {
  margin-top: 10px; height: 460px; overflow: auto; padding: 10px 12px;
  background: var(--paper-2); font: 12.5px/1.55 var(--mono); border-radius: 2px;
}
.line { display: grid; grid-template-columns: 66px minmax(0, 1fr); gap: 8px; }
.line time { color: var(--mute); opacity: 0.7; }
.line span { white-space: pre-wrap; overflow-wrap: anywhere; }
.line.stderr span { color: var(--red); }
.line.proof span { color: var(--pencil); }
.line.build span, .line.seed span { color: var(--mute); }
.quiet { color: var(--mute); margin: 0; font-family: var(--wide); font-size: 14px; }
.jump { position: absolute; right: 12px; bottom: 12px; border: 0; background: var(--ink); color: var(--paper); padding: 5px 11px; border-radius: 3px; cursor: pointer; font-size: 13px; }
@media (max-width: 1100px) { .box { height: 320px; } }
</style>
