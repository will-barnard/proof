import { EventEmitter } from 'node:events';

// One in-process bus. The dashboard subscribes over SSE: `site` events when a
// site's record or status changes, `log` events per output line, `pg` for the
// database's state.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const LOG_LIMIT = 3000;
const logs = new Map();

export function log(slug, line, stream = 'proof') {
  const entry = { t: Date.now(), stream, line: String(line) };
  let buf = logs.get(slug);
  if (!buf) { buf = []; logs.set(slug, buf); }
  buf.push(entry);
  if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT);
  bus.emit('log', { slug, ...entry });
}

export const logsFor = (slug) => logs.get(slug) || [];
export const clearLogs = (slug) => logs.delete(slug);
