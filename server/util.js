import fs from 'node:fs/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT' || fallback !== undefined) return fallback;
    throw err;
  }
}

// Write to a temp file and rename, so a crash mid-write never leaves a
// half-written registry behind.
export async function writeJson(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, p);
}

export function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    // Bind the unspecified address: generated sites call app.listen(port),
    // which takes every interface, so a port only counts as free if that works.
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

// Run a command, streaming each output line to onLine. Rejects with the tail
// of the output on a non-zero exit.
export function run(cmd, args, { cwd, env, onLine = () => {}, timeoutMs = 10 * 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const feed = (stream) => {
      let buf = '';
      return (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          tail.push(line); if (tail.length > 40) tail.shift();
          onLine(line, stream);
        }
      };
    };
    child.stdout.on('data', feed('stdout'));
    child.stderr.on('data', feed('stderr'));
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} ${args.join(' ')} timed out`)); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${[cmd, ...args].join(' ')} exited ${code}`), { output: tail.join('\n') }));
    });
  });
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export async function pidCommand(pid) {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}
