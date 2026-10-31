// Shared plumbing for bin/sim and bin/safari: running commands, the state file, run
// folders and JSON output. No dependencies; Node 22+.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactUrl, errorText, asError } from './appium.js';
import { InterruptError, afterPendingSignals, cleaningUp, exitCodeFor, interrupted, requestSignal, withInterrupt } from './interrupt.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KEEP_RUNS = 20;

// --- running commands (swappable so tests can record calls instead) ---

// A command that names no timeout gets this one: a hung child must not hold the lab (and an
// interrupt waiting on it) forever. Calls that can legitimately take longer pass their own.
export const DEFAULT_TIMEOUT_MS = 120e3;

let runner = (cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL', ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (r.error?.code === 'ETIMEDOUT') return { code: 124, stdout: r.stdout || '', stderr: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
};

// A command that may run for minutes (the phone's WebDriverAgent build), run without blocking the
// event loop so that an interrupt is seen at once: the child gets SIGTERM (SIGKILL 3 s later) and the
// call rejects with an InterruptError once it has ended. `timeoutMs` ends it the same way and gives
// exit 124; `killAfterMs` is the grace between that SIGTERM and the SIGKILL (3 s unless given: a caller whose child
// shuts down on SIGTERM, like `sideload`, asks for longer); `onTick` (a lease renewal) runs every `tickMs`. Returns { code, stdout, stderr } like `run`
// with allowFail (the last 64 KB of each). Tests that replace the runner get it through the runner.
const KEEP = 64 * 1024;
const KILL_AFTER_MS = 3e3;
const spawnAsync = (cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env, onTick, tickMs = 60e3, killAfterMs = KILL_AFTER_MS } = {}) => new Promise((resolve, reject) => {
  if (interrupted()) return reject(new InterruptError(interrupted()));
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
  let out = '', err = '', timedOut = false, settled = false, killer = null;
  const keep = (was, c) => (was + c).slice(-KEEP);
  child.stdout.on('data', c => { out = keep(out, c); });
  child.stderr.on('data', c => { err = keep(err, c); });
  const stop = () => {
    if (killer) return; // a timeout and an interrupt can both ask: one SIGTERM, one SIGKILL timer
    child.kill('SIGTERM');
    killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const tick = onTick ? setInterval(() => { Promise.resolve().then(onTick).catch(() => {}); }, tickMs) : null;
  const signal = requestSignal();
  const onAbort = () => stop();
  signal.addEventListener('abort', onAbort, { once: true });
  const end = fn => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(killer); clearInterval(tick);
    signal.removeEventListener('abort', onAbort);
    fn();
  };
  child.once('error', e => end(() => resolve({ code: 127, stdout: '', stderr: e.message })));
  child.once('close', code => end(() => {
    if (interrupted()) reject(new InterruptError(interrupted()));
    else resolve(timedOut ? { code: 124, stdout: out, stderr: `timed out after ${Math.round(timeoutMs / 1000)}s\n${err}` } : { code: code ?? 1, stdout: out, stderr: err });
  }));
});
let asyncRunner = spawnAsync;
export const setRunner = fn => { runner = fn; asyncRunner = async (cmd, args, opts) => runner(cmd, args, opts); };
// Tests of the real waiting swap just the asynchronous one (`setAsyncRunner()` puts the real one back).
export const setAsyncRunner = fn => { asyncRunner = fn ?? spawnAsync; };
export const runAsync = (cmd, args, opts = {}) => asyncRunner(cmd, args, opts);

// A process that outlives the lab command (the phone's WebDriverAgent `xcodebuild`): started
// with an argument list in its own process group, stdin from /dev/null, stdout and stderr into
// `log` (truncated, owner-only) or nowhere. Returns { pid } (null when it could not start).
let spawner = (cmd, args, { env, log } = {}) => {
  const fd = log ? openPrivate(log) : 'ignore';
  try {
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
    child.on('error', () => { /* reported by the caller's wait: nothing answers */ });
    child.unref();
    return { pid: Number.isInteger(child.pid) ? child.pid : null };
  } finally {
    if (typeof fd === 'number') fs.closeSync(fd);
  }
};
export const setSpawner = fn => { spawner = fn; };
export const spawnDetached = (cmd, args, opts = {}) => spawner(cmd, args, opts);

// Opens `file` for writing, truncated and mode 0600 (also when it already existed with another mode).
export function openPrivate(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w', 0o600);
  fs.fchmodSync(fd, 0o600);
  return fd;
}

// --- refusing root ---

// As root the lab would write root-owned files into the owner's home and reach another user's
// launchd. MSL_ALLOW_ROOT=1 lifts the refusal for the test suite only (cloud sessions run as root).
let getUid = () => process.getuid?.();
export const setUid = fn => { getUid = fn; };
const refuseRoot = () => getUid() === 0 && process.env.MSL_ALLOW_ROOT !== '1';

// Waits `ms`; rejects with InterruptError when the command is (or gets) interrupted, except
// during cleanup (duringCleanup), whose waits are bounded by their own callers.
export const sleep = ms => new Promise((resolve, reject) => {
  if (cleaningUp()) return void setTimeout(resolve, ms);
  const already = interrupted();
  if (already) return reject(new InterruptError(already));
  const signal = requestSignal();
  const onAbort = () => { clearTimeout(timer); reject(new InterruptError(interrupted() ?? 'SIGTERM')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

// Runs a command with an argument list (never a shell string). Throws on a non-zero exit
// unless allowFail, so a failed step can't pass silently. `timeoutMs` kills a command that
// hangs and reports it as exit 124 (DEFAULT_TIMEOUT_MS when not given). `env` adds variables to
// the command's environment. A child ended by a signal is an ordinary failure (its message names
// the signal): whether the lab itself was signalled is `cli`'s question, answered by the lab's own handler.
export function run(cmd, args, { allowFail = false, timeoutMs, env } = {}) {
  const r = runner(cmd, args, { timeoutMs, ...(env ? { env } : {}) });
  if (r.code !== 0 && !allowFail) throw failure(cmd, args, r);
  return r;
}

// The command line of process `pid` as `ps` shows it, trimmed; '' when there is no such process.
export function processCommand(pid, { timeoutMs } = {}) {
  const r = run('ps', ['-o', 'command=', '-p', String(pid)], { allowFail: true, timeoutMs });
  return r.code === 0 ? r.stdout.trim() : '';
}

// Whether `ps` knows process `pid`.
export const processAlive = pid => run('ps', ['-o', 'pid=', '-p', String(pid)], { allowFail: true, timeoutMs: 5e3 }).code === 0;

// The error `run` throws for a failed command (also used by callers that retry first).
export function failure(cmd, args, r) {
  if (r.signal) return new Error(`${cmd} ${args[0] ?? ''} was killed by ${r.signal}`);
  const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
  return new Error(`${cmd} ${args[0] ?? ''} failed (exit ${r.code})${msg ? ': ' + msg : ''}`);
}

// --- state: ~/.config/mobile-safari-lab/state.json ---

export const stateDir = () => process.env.MSL_STATE || path.join(os.homedir(), '.config', 'mobile-safari-lab');
const stateFile = () => path.join(stateDir(), 'state.json');

export function loadState() {
  let raw;
  try { raw = fs.readFileSync(stateFile(), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {}; // a corrupt state file is treated as empty; the next save rewrites it
  }
}

// Merges `patch` into the state; a null value removes that key. Written to a temp file and
// renamed, so a reader never sees a half-written file (which `loadState` would read as {}).
export function saveState(patch) {
  const next = { ...loadState(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, stateFile());
  return next;
}

// Simulator UDIDs are UUIDs; device UDIDs are 25 or 40 hex characters with an optional dash.
export const isUdid = s => typeof s === 'string' && /^[0-9A-Fa-f][0-9A-Fa-f-]{23,39}$/.test(s);

// Shape checks for records read from the state file: a plain object (not null, not an array), and an ISO-parseable time string.
export const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isAt = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));

// --- run folders: runs/<YYYYMMDD-HHMMSS>-<label>/ ---

export const runsRoot = () => process.env.MSL_RUNS || path.join(REPO, 'runs');
const RUN_DIR = /^\d{8}-\d{6}-/;

const stamp = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function newRun(label = 'run', now = new Date()) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run';
  const dir = path.join(runsRoot(), `${stamp(now)}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  saveState({ run: dir });
  pruneRuns();
  return dir;
}

export function pruneRuns(keep = KEEP_RUNS) {
  let names;
  try { names = fs.readdirSync(runsRoot()).filter(n => RUN_DIR.test(n)).sort(); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const n of old) fs.rmSync(path.join(runsRoot(), n), { recursive: true, force: true });
  return old;
}

// A real (not linked) run-named directory directly under the runs root: `..`, `.` and a link
// that leads elsewhere don't count.
function isRunFolder(run) {
  const resolved = path.resolve(run);
  if (path.dirname(resolved) !== path.resolve(runsRoot()) || !RUN_DIR.test(path.basename(resolved))) return false;
  try { return fs.lstatSync(resolved).isDirectory(); } catch { return false; }
}

export function currentRun() {
  const { run } = loadState();
  // Only a folder the lab made under the runs root: a path from anywhere else (an old scratch
  // folder left in the state) would collect artifacts where nobody looks.
  if (typeof run === 'string' && isRunFolder(run)) return run;
  return newRun('adhoc');
}

// What an artifact is called: a plain name, saved into the run folder. A path is refused (not
// folded into one long file name), and a trailing `.<ext>` is the extension already, so
// `home.png` is home.png, not home.png.png.
export function artifactBase(name, ext) {
  const given = String(name || 'out');
  if (/[\\/]/.test(given)) {
    throw new Error(`"${given}" is a path: the name is a file name only, saved in the run folder (${runsRoot()}/<run>/). Pass just the name, e.g. ${path.basename(given.replace(/\\/g, '/')) || 'out'}`);
  }
  const bare = given.toLowerCase().endsWith(`.${ext}`) ? given.slice(0, -(ext.length + 1)) : given;
  return bare.replace(/[^\w.-]+/g, '-') || 'out';
}

// The run folder a new session writes to. One made for it (`sim run <label>`) is used as it is;
// a new one is made when the current run already hosted a session (`sessionRun`, set once a
// session was created in it) or is only the catch-all `adhoc` one.
export function runForSession() {
  const { run, sessionRun } = loadState();
  if (typeof run === 'string' && isRunFolder(run) && run !== sessionRun && !/-adhoc$/.test(run)) return run;
  return newRun('session');
}

// Called once a session exists: the next one starts a fresh run folder.
export function markSessionRun() {
  saveState({ sessionRun: currentRun() });
}

// A new file path in the current run: shot.png, shot-2.png, …
export function artifact(name, ext) {
  const base = artifactBase(name, ext); // before currentRun(): a refused name makes no folder
  const dir = currentRun();
  for (let i = 1; ; i++) {
    const p = path.join(dir, `${base}${i > 1 ? '-' + i : ''}.${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

// Every line is scrubbed of secret query parameters, whoever the caller.
export function logRun(line) {
  fs.appendFileSync(path.join(currentRun(), 'run.log'), `${new Date().toISOString()} ${maskDevices(redactUrl(line))}\n`);
}

// Width and height of a PNG, read from its header.
export function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`not a PNG: ${file}`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// A timestamp a stored record holds (an ISO string Date can read).
export const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));

// --- command-line plumbing ---

// One word of a shell command line: bare when it is plain, else single-quoted, so it pastes safely.
export const quote = p => (/^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

// Splits argv into positionals and --flags (a flag takes the next word as its value unless
// it's listed in `bools`). A value is never given after `=`. Errors never print a word from argv
// (it may be a secret given in the wrong form): a flag is named only when it looks like a name.
// A flag listed in `repeat` may be given more than once and comes back as an array of its values.
export function parseArgs(argv, bools = [], repeat = []) {
  const pos = [], flags = {};
  const named = k => (/^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(k) ? `--${k}` : 'a flag');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        const flag = named(a.slice(2, eq));
        throw new Error(`${flag === 'a flag' ? 'a --flag=value' : `${flag}=…`} is not supported: give the value as the next word`);
      }
      const k = a.slice(2);
      if (bools.includes(k)) flags[k] = true;
      else {
        if (i + 1 >= argv.length) throw new Error(`${named(k)} needs a value`);
        if (repeat.includes(k)) (flags[k] ??= []).push(argv[++i]);
        else flags[k] = argv[++i];
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

// Words that ask for help. They never reach a handler or a hook (no lease, no run folder,
// no phone). Text that is exactly `-h` or `--help` therefore can't be typed through `type`,
// `eval` and the like; `keys` has `--` for it, and scanning stops at a bare `--`.
const isHelpFlag = a => a === '--help' || a === '-h';

function helpFor(handlers, [name, ...rest], usage) {
  const names = Object.keys(handlers);
  const lines = usage?.commands ?? {};
  const overview = usage?.overview ?? `commands: ${names.join(', ')}`;
  const wanted = name === 'help' || isHelpFlag(name) ? rest.find(a => !isHelpFlag(a)) : name;
  if (wanted !== undefined && Object.hasOwn(handlers, wanted)) {
    return { ok: true, usage: lines[wanted] ?? overview, commands: { [wanted]: lines[wanted] ?? null } };
  }
  return { ok: true, usage: overview, commands: Object.fromEntries(names.map(n => [n, lines[n] ?? null])) };
}

// Device UDIDs (25 characters with a dash, or 40 hex) are shown as `…` + the last 4 characters.
// Simulator UUIDs (8-4-4-4-12) are not device ids and are left alone.
export const maskDevices = text => String(text)
  .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g, m => '…' + m.slice(-4))
  .replace(/\b[0-9A-Fa-f]{40}\b/g, m => '…' + m.slice(-4));

// Runs one command and prints its result as JSON: { ok: true, ... } or { ok: false, error }.
// A handler may return `ok: false` itself (with an `error`) to report a failure and still
// print its other fields; that exits 1 like a thrown error.
// Hooks: `before(name, args)` runs first (it may throw to refuse; a returned `{ note }` is
// printed as `lease`), `after(name, out)` after a handler succeeds. An error with
// `skipArtifacts` skips `onError`, and an `extra` object on it is merged into the output.
// `help`, `--help` and `-h` answer from `usage` ({ overview, commands: {name: line} }) before
// any hook. Printed text has device UDIDs masked unless `unmask(name, args)` says otherwise;
// handler return values stay whole.
export async function cli(handlers, argv, { onError, before, after, usage, unmask } = {}) {
  const [name, ...rest] = argv;
  const dd = rest.indexOf('--');
  if (name === 'help' || isHelpFlag(name) || (dd < 0 ? rest : rest.slice(0, dd)).some(isHelpFlag)) {
    console.log(JSON.stringify(helpFor(handlers, argv, usage), null, 2));
    return 0;
  }
  if (refuseRoot()) {
    console.log(JSON.stringify({ ok: false, error: 'refusing to run as root: run it as your own user, without sudo' }));
    return 1;
  }
  const h = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  if (!h) {
    // The word is printed only if it looks like a command name: it may be a secret in the wrong place.
    const shown = name === undefined || /^[a-z][a-z-]{0,30}$/.test(name) ? `"${name ?? ''}"` : '(argument #1)';
    console.log(JSON.stringify({ ok: false, error: `unknown command ${shown}`, usage: usage?.overview, commands: Object.keys(handlers) }));
    return 2;
  }
  const show = text => (unmask?.(name, rest) ? text : maskDevices(text));
  // SIGINT, SIGTERM and SIGHUP end the wait the command is in (see interrupt.js); the result is
  // still one JSON object, with `interrupted` naming the signal, and the exit code is 128 + its number.
  // A signal that arrived during a synchronous child is handled one macrotask after the child returns,
  // so the lab's own handler is read after `afterPendingSignals()`: a child killed alone is only a failed child.
  return withInterrupt(async () => {
    try {
      const gate = await before?.(name, rest);
      const out = await h(rest);
      await after?.(name, out);
      await afterPendingSignals();
      const sig = interrupted();
      console.log(show(JSON.stringify({ ok: true, ...out, ...(gate?.note ? { lease: gate.note } : {}), ...(sig ? { interrupted: sig } : {}) }, null, 2)));
      return out?.ok === false ? (sig ? exitCodeFor(sig) : 1) : 0;
    } catch (thrown) {
      const e = asError(thrown);
      await afterPendingSignals();
      const early = interrupted() ?? (e instanceof InterruptError ? e.signal : null);
      const artifacts = onError && !e.skipArtifacts && !early ? await onError(name, e).catch(() => ({})) : {};
      const sig = early ?? interrupted(); // a signal during onError still marks the result
      console.log(show(JSON.stringify({ ok: false, error: errorText(e), ...(sig ? { interrupted: sig } : {}), ...e.extra, ...artifacts }, null, 2)));
      return sig ? exitCodeFor(sig) : 1;
    }
  });
}
