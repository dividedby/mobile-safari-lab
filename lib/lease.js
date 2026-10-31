// The simulator lease: one agent at a time drives the Claude iPhone. A JSON file in the state
// dir ({ owner, since, expires }) that every guarded command takes or renews and that other
// owners are refused until it expires. Advisory: it only binds the CLIs in this repo.
// Reads and changes happen inside a `mkdir` mutex, so create, renew and takeover are one
// step even with several processes. `activity.json` ({ at }) records the last command, for the
// idle stop (`acquireIdle`): lease commands write it, and so does `recordActivity` for commands
// that look without leasing (`sim shot`, `sim ui`). `hold.json` ({ until }) is `lab hold`: the
// idle stop leaves the lab alone until then.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, stateDir, sleep, maskDevices } from './core.js';

const DEFAULT_TTL_S = 900;
const UNREADABLE = 'an unreadable lease file';

// The owner of the lease the idle stop (`lab down --idle`) holds while it shuts the lab down.
// It never counts as activity, and its lease has its own, fixed length.
export const IDLE_OWNER = 'msl-idle';
export const IDLE_TTL_MS = 600e3;

// The mutex: how often to retry, how long to wait, and when a lock dir is a crashed holder's.
export const MUTEX = { retryMs: 50, waitMs: 3000, staleMs: 10e3 };

let now = () => Date.now();
export const setClock = fn => { now = fn; }; // tests

const leaseFile = () => path.join(stateDir(), 'lease.json');
const lockDir = () => path.join(stateDir(), 'lease.lock');
const activityFile = () => path.join(stateDir(), 'activity.json');
const holdFile = () => path.join(stateDir(), 'hold.json');

// `lab hold` lasts 1 to HOLD_MAX_MIN minutes (a person using the simulator by hand); a hold file
// that ends further out than that is not one we wrote, and is ignored.
export const HOLD_MAX_MIN = 120;

// --- identity and TTL ---

// Who is asking: MSL_OWNER, else the Claude Code session id, else user@host:tty. The same
// agent gets the same owner on every invocation; shells without a terminal share "notty".
export function owner() {
  const named = process.env.MSL_OWNER || process.env.CLAUDE_CODE_SESSION_ID;
  let who;
  if (named) who = named.trim();
  else {
    const r = run('ps', ['-o', 'tty=', '-p', String(process.ppid)], { allowFail: true });
    const tty = r.code === 0 ? r.stdout.trim() : '';
    who = `${os.userInfo().username}@${os.hostname()}:${tty && tty !== '??' ? tty : 'notty'}`;
  }
  // eslint-disable-next-line no-control-regex
  if (!who || who.length > 200 || /[\u0000-\u001f\u007f]/.test(who)) {
    throw new Error('the lease owner (MSL_OWNER or CLAUDE_CODE_SESSION_ID) must be 1 to 200 characters with no control characters');
  }
  return who;
}

export function ttlMs() {
  const raw = process.env.MSL_LEASE_TTL;
  if (raw === undefined || raw === '') return DEFAULT_TTL_S * 1000;
  const s = Number(raw);
  if (!Number.isInteger(s) || s < 1 || s > 86400) throw new Error('MSL_LEASE_TTL must be a whole number of seconds from 1 to 86400');
  return s * 1000;
}

// 2026-10-15T14:03:09-05:00: the local time the person at the Mac would read.
export function localIso(value) {
  const d = new Date(value);
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

// --- the file ---

// null when there is no lease, { corrupt: true } when the file isn't a lease (treated as
// expired), otherwise { owner, since, expires }.
export function read() {
  let raw;
  try { raw = fs.readFileSync(leaseFile(), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let v;
  try { v = JSON.parse(raw); } catch { return { corrupt: true }; }
  const ok = v && typeof v === 'object' && typeof v.owner === 'string' && v.owner
    && ['since', 'expires'].every(k => typeof v[k] === 'string' && Number.isFinite(Date.parse(v[k])));
  return ok ? { owner: v.owner, since: v.since, expires: v.expires } : { corrupt: true };
}

const expired = (l, t = now()) => l.corrupt || Date.parse(l.expires) <= t;

function write(lease) {
  const tmp = `${leaseFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2) + '\n');
  fs.renameSync(tmp, leaseFile());
}

// --- the last command ---

// When a lab command last took, renewed or released the lease ({ at } in activity.json), as
// ms since the epoch; null when there is no record or it isn't one. The idle stop reads it:
// once `safari stop` has released the lease nothing else says how long ago the lab was used.
export function lastActive() {
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(activityFile(), 'utf8'))?.at);
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

function markActive(t) {
  const tmp = `${activityFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: new Date(t).toISOString() }) + '\n');
  fs.renameSync(tmp, activityFile());
}

// Records a command that looks without leasing as activity. Never takes or renews the lease.
// Best effort: when the mutex stays busy the note goes to stderr and the command still runs.
export async function recordActivity() {
  try {
    await withMutex(() => markActive(now()));
    return true;
  } catch (e) {
    console.error(maskDevices(`[lease] couldn't record the activity: ${e.message}`));
    return false;
  }
}

// --- the hold ---

// When the hold in force at `t` ends, as ms since the epoch; null when there is none, it has
// ended, or the file isn't one (unreadable, no valid `until`, or further out than HOLD_MAX_MIN).
export function holdUntil(t = now()) {
  try {
    const until = Date.parse(JSON.parse(fs.readFileSync(holdFile(), 'utf8'))?.until);
    return Number.isFinite(until) && until > t && until <= t + HOLD_MAX_MIN * 60e3 ? until : null;
  } catch { return null; }
}

// Holds the idle stop off for `minutes` (a whole number from 1 to HOLD_MAX_MIN) and counts as
// activity. Returns the end, ms since the epoch. Takes no lease. Written in the mutex, so it is
// either seen by an idle stop's check or comes after it.
export function setHold({ minutes }) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > HOLD_MAX_MIN) throw new Error(`the hold must be a whole number of minutes from 1 to ${HOLD_MAX_MIN}`);
  return withMutex(() => {
    const t = now();
    const until = t + minutes * 60e3;
    const tmp = `${holdFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ until: new Date(until).toISOString() }) + '\n');
    fs.renameSync(tmp, holdFile());
    markActive(t);
    return until;
  });
}

// Ends a hold: the lab was stopped or the simulator freshly booted, so it no longer applies.
export function clearHold() {
  fs.rmSync(holdFile(), { force: true });
}

async function withMutex(fn) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const end = Date.now() + MUTEX.waitMs;
  for (;;) {
    try { fs.mkdirSync(lockDir()); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    reapStaleLock();
    if (Date.now() >= end) throw new Error('the lease is busy, retry in a moment');
    await sleep(MUTEX.retryMs);
  }
  try { return fn(); } finally {
    try { fs.rmdirSync(lockDir()); } catch { /* already gone */ }
  }
}

// A lock dir older than MUTEX.staleMs belongs to a holder that died: move it aside (the
// rename succeeds for one process only) and delete it. If what was moved turns out to be
// fresh, another process won the race and replaced it: put it back.
function reapStaleLock() {
  let age;
  try { age = Date.now() - fs.statSync(lockDir()).mtimeMs; } catch { return; }
  if (age < MUTEX.staleMs) return;
  const aside = `${lockDir()}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try { fs.renameSync(lockDir(), aside); } catch { return; }
  try {
    if (Date.now() - fs.statSync(aside).mtimeMs < MUTEX.staleMs) fs.renameSync(aside, lockDir());
    else fs.rmdirSync(aside);
  } catch { /* best effort */ }
}

// --- operations ---

function refusal(cur) {
  const e = new Error(
    cur.owner === IDLE_OWNER
      ? `The idle stop is shutting the lab down (its lease runs until ${localIso(cur.expires)}). Retry in a minute: it ends within a few. `
        + 'Only if it is still refused after that and no idle stop is running (see ~/Library/Logs/msl-idle.log), a crashed one left its lease: `lab release --force` clears it. Never use --force while a stop is running.'
      : `Simulator is leased by "${cur.owner}" until ${localIso(cur.expires)} (taken ${localIso(cur.since)}). `
        + 'If that agent is done, run `lab release --force` or `lab up --force`; otherwise wait.',
  );
  e.extra = { lease: { owner: cur.owner, since: cur.since, expires: cur.expires } };
  e.skipArtifacts = true; // never screenshot another agent's session
  return e;
}

// Takes or renews the lease for `who`. Returns { action, found, previous? } with action one
// of 'created', 'renewed', 'took over expired lease of <owner>', 'forced lease from <owner>'.
// Another owner's unexpired lease is refused unless `force`.
export function acquire({ force = false, owner: who = owner() } = {}) {
  return withMutex(() => {
    const cur = read();
    const t = now();
    const fresh = { owner: who, since: new Date(t).toISOString(), expires: new Date(t + ttlMs()).toISOString() };
    const commit = lease => { write(lease); markActive(t); };
    if (!cur) {
      commit(fresh);
      return { action: 'created', found: 'no lease' };
    }
    if (!cur.corrupt && cur.owner === who) {
      commit({ ...fresh, since: cur.since });
      return { action: 'renewed', found: 'leased by this owner' };
    }
    if (expired(cur, t)) {
      commit(fresh);
      const was = cur.corrupt ? UNREADABLE : cur.owner;
      return { action: `took over expired lease of ${was}`, found: `expired lease of ${was}`, previous: cur };
    }
    if (!force) throw refusal(cur);
    commit(fresh);
    return { action: `forced lease from ${cur.owner}`, found: `leased by "${cur.owner}" until ${localIso(cur.expires)}`, previous: cur };
  });
}

// --- the idle stop ---

// Whether the lab is idle at `t`: no live lease (absent, expired or unreadable), no hold, and no
// lease command (or `recordActivity`) for `thresholdMs`. { idle: true, lastActive } or { idle: false, reason }. Runs inside
// the mutex. A missing or unreadable activity record starts the clock (written as now), so a
// lab upgraded while in use is never stopped on the first look.
function judgeIdle(cur, t, thresholdMs) {
  if (cur && !expired(cur, t)) {
    return { idle: false, reason: cur.owner === IDLE_OWNER ? 'another idle stop is running' : `in use: leased by "${cur.owner}" until ${localIso(cur.expires)}` };
  }
  const held = holdUntil(t);
  if (held !== null) return { idle: false, reason: `held until ${localIso(held)}` };
  const at = lastActive();
  if (at === null || at > t + 60e3) { // none, or from the future (the clock moved back)
    markActive(t);
    return { idle: false, reason: 'no record of the last command: the idle clock starts now' };
  }
  if (t - at < thresholdMs) {
    return { idle: false, reason: `last command ${Math.floor((t - at) / 60e3)} min ago, under the ${Math.round(thresholdMs / 60e3)} min threshold`, lastActive: at };
  }
  return { idle: true, lastActive: at };
}

// Looks, without taking anything (the idle stop's cheap first look).
export function idleState({ thresholdMs }) {
  return withMutex(() => judgeIdle(read(), now(), thresholdMs));
}

// Checks and takes in one mutex section: when the lab is idle, writes the idle stop's lease
// (owner IDLE_OWNER, IDLE_TTL_MS), so a `lab up` racing it either took the lease first (this
// returns idle: false) or is refused until the stop is done. Never counts as activity.
export function acquireIdle({ thresholdMs }) {
  return withMutex(() => {
    const t = now();
    const r = judgeIdle(read(), t, thresholdMs);
    if (!r.idle) return r;
    write({ owner: IDLE_OWNER, since: new Date(t).toISOString(), expires: new Date(t + IDLE_TTL_MS).toISOString() });
    return r;
  });
}

// Whether `who` may act on the simulator, changing nothing: { found } for no lease, their
// own, an expired one, or (with `force`) another's live one; otherwise refused like `acquire`.
export function check({ force = false, owner: who = owner() } = {}) {
  return withMutex(() => {
    const cur = read();
    if (!cur) return { found: 'no lease' };
    if (!cur.corrupt && cur.owner === who) return { found: 'leased by this owner' };
    if (expired(cur)) return { found: `expired lease of ${cur.corrupt ? UNREADABLE : cur.owner}` };
    if (!force) throw refusal(cur);
    return { found: `leased by "${cur.owner}" until ${localIso(cur.expires)}` };
  });
}

// Pushes the expiry out, only if the lease is this owner's (never creates one).
export function touch({ owner: who = owner() } = {}) {
  return withMutex(() => {
    const cur = read();
    if (!cur || cur.corrupt || cur.owner !== who) return false;
    const t = now();
    write({ owner: who, since: cur.since, expires: new Date(t + (who === IDLE_OWNER ? IDLE_TTL_MS : ttlMs())).toISOString() });
    if (who !== IDLE_OWNER) markActive(t);
    return true;
  });
}

// Deletes this owner's lease; another owner's only with `force` (an expired one needs no
// force: it isn't a lease any more).
export function release({ force = false, owner: who = owner() } = {}) {
  return withMutex(() => {
    const cur = read();
    if (!cur) return { released: false };
    if (!cur.corrupt && cur.owner !== who && !expired(cur) && !force) throw refusal(cur);
    fs.rmSync(leaseFile(), { force: true });
    if (who !== IDLE_OWNER) markActive(now());
    return { released: true, ...(cur.corrupt || cur.owner === who ? {} : { was: cur.owner }) };
  });
}

// The lease note a takeover leaves in a command's output; undefined when nothing was taken.
export const takeoverNote = r => {
  if (!r.previous) return undefined;
  const prev = r.previous.corrupt ? UNREADABLE : r.previous.owner;
  return r.action.startsWith('forced') ? { forced: prev } : { tookOver: prev };
};

// Hooks for `cli`: the named commands take or renew the lease before they run and renew it
// after; `stop` releases it. A takeover is reported in the command's output as `lease`.
export function guard(names) {
  return {
    async before(name) {
      if (!names.has(name)) return undefined;
      const r = await acquire();
      const note = takeoverNote(r);
      return note && { note };
    },
    async after(name) {
      if (!names.has(name)) return;
      try {
        if (name === 'stop') await release();
        else await touch();
      } catch (e) { console.error(maskDevices(`[lease] couldn't update the lease: ${e.message}`)); }
    },
  };
}
