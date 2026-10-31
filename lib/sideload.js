// The lab's side of slot lending (issue 63, ADR 0008): finding the `sideload` binary and calling its `slot` commands. sideload is
// another tool that signs apps for the same free Apple account, and a free account holds a few apps; when the phone has no room for
// the WebDriverAgent runner, sideload lends the lab one of its slots (`slot lend`), and the lab gives it back (`slot return`).
// Every call passes the saved phone's UDID (`--udid`, never sideload's `--device` alias) and sideload's own SIDELOAD_HOME; the
// answer is one JSON envelope on stdout, and what the lab does with each code is data (the tables below), not branches.
import fs from 'node:fs';
import path from 'node:path';
import { run, runAsync, isUdid, isObj } from './core.js';
import { redactMessage } from './phone.js';

// Waits, in ms (tests shorten them). sideload's own worst cases are about 10 min (lend) and 15 min (return); the lab waits a
// little longer than the nominal limit plus a margin for the data backup sideload is adding. `termGraceMs` is the time sideload
// gets to print its INTERRUPTED answer after SIGTERM before SIGKILL; `statusMs` bounds `sideload status` (display only).
// When to ask again after a call whose outcome is not known (a timeout, INTERRUPTED, output the lab cannot read) and sideload gave no
// `retryAfter`: sideload's longest operation window, 645 s.
export const UNKNOWN_RETRY_MS = 645e3;
export const SLOT_WAIT = { lendMs: 15 * 60e3, returnMs: 20 * 60e3, dataMarginMs: 2 * 60e3, termGraceMs: 30e3, statusMs: 15e3, tickMs: 60e3 };

// --- the binary ---

// Why `p` can't be the sideload binary, or null: it must be an absolute path to a regular file the lab may run.
function binProblem(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return 'is not an absolute path';
  let st;
  try { st = fs.statSync(p); } catch { return 'does not exist'; }
  if (!st.isFile()) return 'is not a file';
  try { fs.accessSync(p, fs.constants.X_OK); } catch { return 'is not executable'; }
  return null;
}

// The sideload binary: MSL_SIDELOAD_BIN (refused when wrong, never replaced by another), else the `bin` the lend record
// remembers (the idle stop's PATH is launchd's, which does not carry ~/.local/bin or /opt/homebrew/bin), else the first `sideload` on
// PATH (found here, so the absolute path is what is shown and run). { ok: true, path, from } or { ok: false, from, error }.
export function resolveBin({ record, env = process.env } = {}) {
  const set = env.MSL_SIDELOAD_BIN;
  if (set !== undefined && set !== '') {
    const why = binProblem(set);
    return why ? { ok: false, from: 'MSL_SIDELOAD_BIN', error: `MSL_SIDELOAD_BIN "${set}" ${why}: set it to the absolute path of the sideload binary, or unset it` } : { ok: true, path: set, from: 'MSL_SIDELOAD_BIN' };
  }
  if (record?.bin && !binProblem(record.bin)) return { ok: true, path: record.bin, from: 'record' };
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // a relative PATH entry is not a place the lab runs things from
    const p = path.join(dir, 'sideload');
    if (!binProblem(p)) return { ok: true, path: p, from: 'PATH' };
  }
  return { ok: false, from: null, error: 'the sideload binary was not found on PATH: install sideload, or set MSL_SIDELOAD_BIN to its absolute path' };
}

// --- the answer ---

// sideload's envelope from its stdout: one JSON object (the last line that is one, so a stray line before it does not matter), else null.
export function parseEnvelope(stdout) {
  const text = String(stdout ?? '').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
  for (const candidate of [text, lines.at(-1)]) {
    if (!candidate) continue;
    try { const v = JSON.parse(candidate); if (isObj(v)) return v; } catch { /* not JSON */ }
  }
  return null;
}

// sideload's `retryAfter` as an ISO time: seconds (a number, or a numeric string) from `now`, or a date. Null when absent or unreadable.
export function retryAtOf(value, now = Date.now()) {
  let at = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) at = now + value * 1000;
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) && Number(value) > 0) at = now + Number(value) * 1000;
  else if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) at = Date.parse(value);
  return at === null ? null : new Date(Math.min(at, now + 24 * 3600e3)).toISOString();
}

// What a slot call can come to. Codes sideload gives (the addendum of the plan lists them all); the lab's own are TIMEOUT-like.
//   busy        retry later: sideload holds the lock, a window is open, or the result is not known
//   unlock, connection, trust   the phone: DEVICE_LOCKED / DEVICE_NOT_CONNECTED / DEVICE_NOT_PAIRED
//   limit       FREE_APP_LIMIT: the free account is full
//   retry       failed definitely, nothing changed, safe to try again
//   owner       the owner has to act (and anything not listed here is treated as this)
export const CODE_CLASSES = {
  busy: ['SLOT_PENDING', 'OPERATION_IN_PROGRESS', 'UNINSTALL_RESULT_UNCERTAIN', 'INSTALL_RESULT_UNCERTAIN', 'SLOT_STATE_UNKNOWN', 'TIMEOUT', 'INTERRUPTED', 'SNAPSHOT_FAILED', 'SPAWN_FAILED', 'UNPARSEABLE'],
  unlock: ['DEVICE_LOCKED'],
  connection: ['DEVICE_NOT_CONNECTED'],
  trust: ['DEVICE_NOT_PAIRED'],
  limit: ['FREE_APP_LIMIT'],
  retry: ['UNINSTALL_FAILED', 'INSTALL_FAILED', 'INSTALL_UNCONFIRMED', 'RETURN_NOT_LANDED', 'APPS_UNREADABLE', 'WDA_STOP_FAILED', 'RETURN_UNSETTLED', 'LEND_UNSETTLED'], // the last four are the lab's own
  owner: ['NO_LENDABLE_APP', 'LENDABLE_NOT_INSTALLED', 'ALREADY_LENT', 'NOT_SIGNED', 'PROFILE_EXPIRED', 'PROFILE_INVALID', 'PROFILE_MISSING', 'PROFILE_CERT_MISMATCH', 'DEVICE_NOT_IN_PROFILE', 'WRONG_TEAM', 'GUARD_FAILED', 'KEYCHAIN_LOCKED', 'FREE_CERT_CHANGED', 'CONFIG_INVALID', 'LEDGER_INVALID', 'DEVICE_NOT_SAVED', 'USAGE', 'NO_BINARY', 'NO_PHONE', 'OTHER_PHONE'], // the last three are the lab's own
};
const CODE_PREFIXES = { owner: ['FREE_IDENTITY_'] };

export function codeClass(code) {
  for (const [cls, codes] of Object.entries(CODE_CLASSES)) if (codes.includes(code)) return cls;
  for (const [cls, prefixes] of Object.entries(CODE_PREFIXES)) if (prefixes.some(p => String(code).startsWith(p))) return cls;
  return 'owner'; // not listed: the owner looks at it
}

// `needs` per class; `connection` is `tunnel` when the phone was last reached over Wi-Fi, else `cable`.
const NEEDS_OF = { busy: 'busy', unlock: 'unlock', connection: 'connection', trust: 'trust', limit: 'slots', retry: 'unknown', owner: 'slots' };
export const needsOf = (cls, via) => (NEEDS_OF[cls] === 'connection' ? (via === 'tunnel' ? 'tunnel' : 'cable') : NEEDS_OF[cls]);

// What a failed `slot lend` does: `needs`, and what becomes of the record the lab wrote before the call (`record`: keep it,
// drop it as nothing changed, or mark it lent). Codes in LEND_CODES override their class.
export const LEND_MAP = {
  busy: { record: 'keep' }, unlock: { record: 'drop' }, connection: { record: 'drop' }, trust: { record: 'drop' },
  limit: { record: 'drop' }, retry: { record: 'drop' }, owner: { record: 'drop' },
};
export const LEND_CODES = {
  OPERATION_IN_PROGRESS: { record: 'drop' }, // sideload never started: nothing changed
  LEND_UNSETTLED: { record: 'keep' }, // an ok answer that freed nothing and lent nothing: the lab does not know what happened
  UNEXPECTED_APP_DELTA: { needs: 'unknown', record: 'keep', recordWhenLent: 'lent' }, // with state "lent" the lend did happen: it must be returned
};

// What a failed `slot return` does (the record stays `returning` in every case). `silent`: nothing is said (the record keeps `retryAt`);
// `noAutoRetry`: the idle stop does not try again until a lab command has run.
export const RETURN_MAP = {
  busy: { silent: true }, unlock: {}, connection: {}, trust: {}, limit: {}, retry: {}, owner: { noAutoRetry: true },
};

// The lab's reading of a lend answer: { needs, record } (record: 'keep' | 'drop' | 'lent').
export function lendOutcome(answer, { via } = {}) {
  const cls = codeClass(answer.kind);
  const over = LEND_CODES[answer.kind] ?? {};
  const rule = { ...LEND_MAP[cls], ...over };
  const record = over.recordWhenLent && answer.state === 'lent' ? over.recordWhenLent : answer.uncertain && rule.record === 'drop' ? 'keep' : rule.record; // an uncertain answer may have lent
  return { needs: over.needs ?? needsOf(cls, via), record, class: cls };
}

// The lab's reading of a return answer: { needs, silent, noAutoRetry }.
export function returnOutcome(answer, { via } = {}) {
  const cls = codeClass(answer.kind);
  const rule = RETURN_MAP[cls];
  return { needs: needsOf(cls, via), silent: rule.silent === true, noAutoRetry: rule.noAutoRetry === true, class: cls };
}

// --- calling ---

// Runs `<bin> slot lend|return --udid <udid> [--to lab]` with SIDELOAD_HOME=<home> and reads the envelope. Resolves:
//   { ok: true, data }                       sideload said ok (`data` is the whole envelope)
//   { ok: false, kind, code, cause?, message, fix?, uncertain, retryAt, state?, warnings, timedOut?, unknown? }
// `kind` is the code to act on: the envelope's error code, or its `cause` for RETURN_FAILED. A timeout, an INTERRUPTED answer,
// output that is not an envelope and a spawn error are `unknown: true` (the call may have done something): the caller keeps its
// record. Only 124 of the exit codes is looked at. `clock` (ms) is read once the call has ended. `touch` (a lease renewal) runs every SLOT_WAIT.tickMs. Rejects with an
// InterruptError when the lab is interrupted (the child gets SIGTERM, SIGKILL after termGraceMs).
export async function slotCall(action, { udid, bin, home, touch, clock = Date.now } = {}) {
  if (!['lend', 'return'].includes(action)) throw new Error(`slotCall: "${action}" is not lend or return`);
  if (!isUdid(udid)) throw new Error(`slotCall: "${udid}" is not a device UDID`);
  const why = binProblem(bin);
  if (why) throw new Error(`slotCall: the sideload binary "${bin}" ${why}`);
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('slotCall: SIDELOAD_HOME must be an absolute path');
  const timeoutMs = (action === 'lend' ? SLOT_WAIT.lendMs : SLOT_WAIT.returnMs) + SLOT_WAIT.dataMarginMs;
  const args = ['slot', action, '--udid', udid, ...(action === 'lend' ? ['--to', 'lab'] : [])];
  const r = await runAsync(bin, args, { timeoutMs, env: { SIDELOAD_HOME: home }, onTick: touch, tickMs: SLOT_WAIT.tickMs, killAfterMs: SLOT_WAIT.termGraceMs });
  const env = parseEnvelope(r.stdout);
  const now = clock(); // read after the call: it may have run for minutes, and every retry time counts from its end
  const later = new Date(now + UNKNOWN_RETRY_MS).toISOString();
  const unknown = (kind, message, retryAt = later) => ({ ok: false, unknown: true, kind, code: kind, message, uncertain: true, retryAt, warnings: [] });
  // sideload prints INTERRUPTED on our SIGTERM; what it said is kept (`said`), but a timeout stays unknown either way.
  if (r.code === 124) return { ...unknown('TIMEOUT', `sideload slot ${action} did not finish within ${Math.round(timeoutMs / 60e3)} min`, retryAtOf(env?.retryAfter ?? env?.errors?.[0]?.retryAfter, now) ?? later), timedOut: true, ...(typeof env?.errors?.[0]?.code === 'string' ? { said: env.errors[0].code } : {}) };
  if (r.code === 127) return unknown('SPAWN_FAILED', `couldn't run sideload: ${redactMessage(r.stderr, 160)}`, null);
  if (!env) return unknown('UNPARSEABLE', `sideload slot ${action} printed no answer the lab can read (exit ${r.code})`);
  if (env.ok === true) return { ok: true, data: env, warnings: Array.isArray(env.warnings) ? env.warnings : [] };
  const e = Array.isArray(env.errors) && isObj(env.errors[0]) ? env.errors[0] : {};
  const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
  // sideload merges an error's data (cause, state, uncertain, retryAfter) into the top level of the envelope; `errors[0]` is checked as a fallback.
  const causeRaw = env.cause ?? e.cause;
  const cause = typeof causeRaw === 'string' && causeRaw ? causeRaw : undefined;
  const kind = code === 'RETURN_FAILED' && cause ? cause : code;
  return {
    ok: false, kind, code, ...(cause ? { cause } : {}), message: redactMessage(e.message ?? env.message ?? `sideload slot ${action} failed`, 300),
    ...(typeof e.fix === 'string' ? { fix: e.fix } : {}),
    uncertain: (env.uncertain ?? e.uncertain) === true,
    retryAt: retryAtOf(env.retryAfter ?? e.retryAfter, now) ?? (kind === 'INTERRUPTED' ? later : null),
    ...(typeof (env.state ?? e.state) === 'string' ? { state: env.state ?? e.state } : {}),
    warnings: Array.isArray(env.warnings) ? env.warnings : [],
  };
}

// `sideload status` for `lab status` (display only: the lab never decides from it): { ok: true, lentToLab } or { ok: false, error }.
// `lentToLab` is read from the envelope's `lent[]` (entries given `to: "lab"`), else null.
export function sideloadStatus({ bin, home }) {
  if (binProblem(bin)) return { ok: false, error: `the sideload binary "${bin}" is not usable` };
  const r = run(bin, ['status'], { allowFail: true, timeoutMs: SLOT_WAIT.statusMs, env: { SIDELOAD_HOME: home } });
  const env = parseEnvelope(r.stdout);
  if (r.code === 124) return { ok: false, error: `sideload status did not answer within ${Math.round(SLOT_WAIT.statusMs / 1000)}s` };
  if (!env) return { ok: false, error: `sideload status printed no answer the lab can read (exit ${r.code})` };
  const lends = Array.isArray(env.lent) ? env.lent : null;
  const lentToLab = lends ? lends.filter(l => isObj(l) && l.to === 'lab').map(l => ({ app: typeof l.app === 'string' ? l.app : null })) : null;
  return { ok: env.ok !== false, lentToLab };
}
