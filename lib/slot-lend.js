// The lab's record of a slot borrowed from sideload (issue 63, ADR 0008) and giving it back. When the phone has no room for the
// WebDriverAgent runner, sideload can lend the lab one of its slots; until it is returned the phone holds the lab's runner where
// sideload's app was. The record (`state.slotLend`) is the lab's claim "I may hold a slot": it is written BEFORE `slot lend` runs
// (phase `lending`) and before the runner is uninstalled (phase `returning`), so a crash leaves it for the next idle stop, `lab down`,
// `lab up` or `lab phone slot return`. The record is never resolved by reading the phone or `sideload status`: only a `slot lend` /
// `slot return` answer settles it (sideload's answers are the authority). The rules of the return, each of them tested:
//   1. a record for another phone than the saved one, or no saved phone: no device call, a person returns it by hand;
//   2. a device session is open: nothing (the runner is in use);
//   3. the sideload binary is found BEFORE anything is uninstalled (the runner must never leave without a way to give the slot back);
//   4. a locked or unreachable phone: nothing is uninstalled or called (no passcode prompts at an unattended Mac);
//   5. every sideload call carries the record's SIDELOAD_HOME and bin, and the saved phone's UDID;
//   6. the record is cleared only by an answer that says the slot is back (`reinstalled`, `alreadyPresent`, `nothingLent`).
// The lend side (`ensureWdaSlot`, the `slot` step of `lab up`) is at the end of the file: it borrows a slot only after installd itself
// refused the lab's own runner install with its free-app limit (`slot lend` never checks that the phone is full, so the lab must not
// call it on a guess), and it never holds the signing lock across a sideload call.
import path from 'node:path';
import { loadState, saveState, isUdid, isObj, isAt, run } from './core.js';
import { InterruptError } from './interrupt.js';
import { readPhone, appListed, uninstallRunner, installRunner, runnerApp, runnerId, lockState, redactMessage, needsError, slotsError, WAIT as PHONE_WAIT } from './phone.js';
import { stopDeviceWda } from './wda.js';
import { buildWda } from './tunnel.js';
import { acquire as acquireSignLock, lockDir } from './signlock.js';
import { resolveBin, slotCall, returnOutcome, lendOutcome, sideloadStatus } from './sideload.js';

export const FORGET = 'lab phone slot forget';
export const RETURN = 'lab phone slot return';
// What the idle stop says it found when a record is waiting.
export const SLOT_PHRASE = 'a slot borrowed from sideload is waiting to go back';

const PHASES = ['lending', 'lent', 'returning'];
const isAbs = v => typeof v === 'string' && path.isAbsolute(v);
const isFailed = f => isObj(f) && typeof f.code === 'string' && f.code !== '' && (f.cause === undefined || typeof f.cause === 'string')
  && isAt(f.at) && Array.isArray(f.human) && f.human.length <= 12 && f.human.every(h => typeof h === 'string') && (f.noAutoRetry === undefined || typeof f.noAutoRetry === 'boolean');

const DAMAGED = `the saved record of a slot borrowed from sideload is damaged: run \`${FORGET}\`, then check with \`sideload status\` whether a slot is still lent and return it by hand (\`sideload slot return --device <alias>\`)`;

// --- the record ---

// state.slotLend = { udid, phase, at, bin, home, since?, app?, device?, retryAt?, returnFailed? }, or null when nothing is borrowed;
// throws the damaged-record message when it is not that shape.
//   phase: lending (written before `slot lend` ran), lent (sideload said yes), returning (before the runner is uninstalled / `slot return` ran)
//   bin, home: the sideload binary and SIDELOAD_HOME the lend used; the return uses the same ones
//   retryAt: no sideload call before it (sideload's retryAfter)
//   returnFailed: { code, cause?, at, human, noAutoRetry? } the last failure that was reported
export function readLend(state) {
  const r = state?.slotLend;
  if (r === undefined || r === null) return null;
  const ok = isObj(r) && isUdid(r.udid) && PHASES.includes(r.phase) && isAt(r.at) && isAbs(r.bin) && isAbs(r.home)
    && (r.since === undefined || isAt(r.since)) && (r.retryAt === undefined || isAt(r.retryAt))
    && (r.app === undefined || (typeof r.app === 'string' && r.app !== '')) && (r.device === undefined || (typeof r.device === 'string' && r.device !== ''))
    && (r.returnFailed === undefined || isFailed(r.returnFailed))
    && Object.keys(r).every(k => ['udid', 'phase', 'at', 'bin', 'home', 'since', 'retryAt', 'app', 'device', 'returnFailed'].includes(k));
  if (!ok) throw new Error(DAMAGED);
  return structuredClone(r);
}

// What the state holds: { present: false }, { present: true, rec } or { present: true, damaged: <message> } (the record is not that shape).
export function lendState(state = loadState()) {
  if (state?.slotLend === undefined || state.slotLend === null) return { present: false };
  try { return { present: true, rec: readLend(state) }; } catch (e) { return { present: true, damaged: e.message }; }
}

export const putLend = rec => { saveState({ slotLend: rec }); return rec; };
export const clearLend = () => { saveState({ slotLend: null }); };

// `lab phone slot forget`: drops the record without touching the phone or sideload.
export function forgetLend() {
  const state = loadState();
  const had = state.slotLend !== undefined && state.slotLend !== null;
  let rec = null;
  try { rec = readLend(state); } catch { /* damaged */ }
  if (had) clearLend();
  saveState({ slotLendDamageReported: null });
  return { forgot: had, ...(rec?.app ? { app: rec.app } : {}) };
}

// Whether `rec` should not be tried now: sideload asked for a later retry (`retryAt`), or the last failure needs the owner and no
// lab command has run since (the idle stop only; `lastActive` is the time of the last one). A person running `lab phone slot return` is never held back.
export function waiting(rec, { idle = false, manual = false, lastActive = null, now = Date.now() } = {}) {
  if (manual) return null;
  if (rec.retryAt && Date.parse(rec.retryAt) > now) return `sideload asked for a retry after ${rec.retryAt}`;
  if (idle && rec.returnFailed?.noAutoRetry && (lastActive ?? 0) <= Date.parse(rec.returnFailed.at)) return 'the last attempt needs you (see `lab status`); no lab command has run since';
  return null;
}

// Whether the idle stop has a slot to give back now: a readable record that is not waiting.
export function wantsReturn(state, { lastActive = null, now = Date.now() } = {}) {
  const { rec } = lendState(state); // damaged: nothing the idle stop can do (`lab status` shows it)
  return !!rec && !waiting(rec, { idle: true, lastActive, now });
}

// The lines for a person while a record exists.
export function lendHuman(rec) {
  const what = rec.app ? `${rec.app}'s slot` : 'a slot';
  const lines = [`The lab borrowed ${what} from sideload so the phone has room for WebDriverAgent, and has not given it back yet (${rec.phase}). The idle stop and \`lab down\` give it back; \`${RETURN}\` does it now.`];
  if (rec.returnFailed) lines.push(...rec.returnFailed.human);
  return lines;
}

// What `lab status` shows (no device calls; `sideload status` is asked only while a record exists, and only for display).
export function slotStatus(state = loadState()) {
  const { rec = null, damaged = null } = lendState(state);
  const bin = resolveBin({ record: rec });
  const out = { bin: bin.ok ? { ok: true, path: bin.path, from: bin.from } : { ok: false, from: bin.from, error: bin.error } };
  if (damaged) return { ...out, lend: { damaged: true, error: damaged }, human: [damaged] };
  if (!rec) return { ...out, lend: null };
  const f = rec.returnFailed;
  return {
    ...out,
    lend: {
      phase: rec.phase, ...(rec.app ? { app: rec.app } : {}), ...(rec.since ? { since: rec.since } : {}), ...(rec.retryAt ? { retryAt: rec.retryAt } : {}),
      ...(f ? { returnFailed: { code: f.code, ...(f.cause ? { cause: f.cause } : {}), at: f.at, ...(f.noAutoRetry ? { noAutoRetry: true } : {}) } } : {}),
    },
    sideload: bin.ok ? sideloadStatus({ bin: bin.path, home: rec.home }) : { ok: false, error: bin.error },
    human: lendHuman(rec),
  };
}

// --- giving the slot back ---

// What the phone said (a `needs` from phone.js), when the lab itself met it: the failure code it stands for and the sentence for a person.
const DEVICE_NEEDS = {
  unlock: { code: 'DEVICE_LOCKED', human: 'the phone is locked. Unlock it.' },
  tunnel: { code: 'DEVICE_NOT_CONNECTED', human: "the Mac cannot reach the phone over Wi-Fi. Unlock it and put it on the Mac's network." },
  cable: { code: 'DEVICE_NOT_CONNECTED', human: 'the Mac cannot reach the phone. Connect it with a cable (or to the same Wi-Fi) and unlock it.' },
  trust: { code: 'DEVICE_NOT_PAIRED', human: 'the phone does not trust this Mac. Unlock it and tap Trust.' },
};

// The lines for a person for a failed return (`silent` ones have none). `fix` is sideload's own advice, redacted, last; `advice` is the lab's.
function failureHuman(outcome, { code, cause, message, fix, advice, app }) {
  const what = `${app ? `${app}'s slot` : 'The slot'} borrowed from sideload`;
  const retry = `The idle stop and \`lab down\` try again; \`${RETURN}\` does it now.`;
  const lines = [];
  const device = DEVICE_NEEDS[outcome.needs];
  if (device) lines.push(`${what} is waiting to go back, but ${device.human} ${retry}`);
  else {
    const why = `${code}${cause && cause !== code ? ` (${cause})` : ''}: ${message}`;
    lines.push(outcome.class === 'limit'
      ? `${what} could not go back: another app took the slot (${why}). Delete an app you don't need on the phone, then run \`${RETURN}\`; the idle stop also tries again.`
      : outcome.noAutoRetry
        ? `${what} could not go back (${why}). It needs you: do what sideload says below, then run \`${RETURN}\`. The idle stop does not try again until a lab command has run.`
        : `${what} could not go back (${why}). ${retry}`);
  }
  if (advice) lines.push(advice);
  if (fix) lines.push(`sideload says: ${redactMessage(fix, 300)}`);
  return lines;
}

// Notes the failed return in the record (the phase, the retry time, and, unless silent, what was said) and returns the result.
// `fresh`: the failure differs from the one last reported (the idle stop tells a person once).
function failed(rec, { code, cause, message, fix, advice, retryAt, phase, via }) {
  const kind = cause ?? code;
  const outcome = returnOutcome({ kind }, { via });
  const human = failureHuman(outcome, { code, cause, message, fix, advice, app: rec.app });
  const same = rec.returnFailed && rec.returnFailed.code === code && rec.returnFailed.cause === cause;
  const next = { ...rec, phase };
  delete next.retryAt;
  if (retryAt) next.retryAt = retryAt;
  if (!outcome.silent) next.returnFailed = { code, ...(cause ? { cause } : {}), at: new Date().toISOString(), human, ...(outcome.noAutoRetry ? { noAutoRetry: true } : {}) };
  putLend(next);
  return {
    pending: true, returned: false, fresh: !outcome.silent && !same, silent: outcome.silent,
    code, ...(cause ? { cause } : {}), needs: outcome.needs, error: redactMessage(message, 300), phase, ...(retryAt ? { retryAt } : {}), human: outcome.silent ? [] : human,
  };
}

// sideload's data-backup counts (AppDataBackup.swift), passed through when they are the right type: booleans and finite counts, nothing else.
const dataFields = (d, bools, counts) => ({
  ...Object.fromEntries(bools.filter(k => typeof d[k] === 'boolean').map(k => [k, d[k]])),
  ...Object.fromEntries(counts.filter(k => Number.isInteger(d[k]) && d[k] >= 0).map(k => [k, d[k]])),
});
const backupData = d => dataFields(d, ['dataBackedUp'], ['dataFiles', 'dataFilesFailed']);
const restoreData = d => dataFields(d, [], ['dataFilesRestored', 'dataFilesFailed']);

// Gives back the slot the record says the lab holds (see the rules at the top). Never throws but for an interrupt (the record stays
// and the next stop, `lab down`, `lab up` or `lab phone slot return` finishes it). Options:
//   idle       the idle stop's: `touch` must keep the idle lease (a false answer means `lab up --force` took the lab over: nothing more is done)
//   manual     `lab phone slot return`: not held back by `retryAt` or `noAutoRetry`
//   touch      renews the lease (also called while sideload works)
//   sessionOpen  a device session is open (the runner is in use)
//   lastActive the time of the last lab command (ms), for `noAutoRetry`
// Returns { pending: false } when nothing is recorded, else { pending: true, returned, fresh, ... }: `returned: true` with app,
// dataRestored?, dataFilesRestored?, dataFilesFailed?, warnings?; or `returned: false` with `skipped` (why nothing was tried), `aborted: true` (the lease was taken over),
// or code, cause?, needs, error, phase, retryAt?, human (empty when silent), fresh, silent.
export async function returnSlot({ idle = false, manual = false, touch, sessionOpen = false, lastActive = null } = {}) {
  const state = loadState();
  let rec;
  try { rec = readLend(state); } catch (e) {
    // Said once per damaged record: the state remembers which one (a record damaged in another way is said again).
    const key = JSON.stringify(state.slotLend);
    const fresh = state.slotLendDamageReported !== key;
    if (fresh) saveState({ slotLendDamageReported: key });
    return { pending: true, returned: false, fresh, skipped: 'damaged record', error: e.message, human: [e.message] };
  }
  if (!rec) return { pending: false };
  if (sessionOpen) return { pending: true, returned: false, fresh: false, skipped: 'a device session is open: the runner is in use' };
  const hold = waiting(rec, { idle, manual, lastActive });
  if (hold) return { pending: true, returned: false, fresh: false, skipped: hold, ...(rec.retryAt ? { retryAt: rec.retryAt } : {}) };

  let phone = null;
  try { phone = readPhone(state); } catch { /* damaged: handled as no phone */ }
  const via = phone?.seen?.via;
  const stay = { phase: rec.phase };
  if (!phone) return failed(rec, { code: 'NO_PHONE', message: 'no phone is saved, so the lab cannot reach the phone to give the slot back', advice: `Save the phone again (\`lab phone setup\`), or return the slot by hand with \`sideload slot return --device <alias>\` and run \`${FORGET}\`.`, ...stay });
  if (phone.udid !== rec.udid) return failed(rec, { code: 'OTHER_PHONE', message: 'the borrowed slot belongs to another phone than the saved one', advice: `Return the slot by hand with \`sideload slot return --device <alias>\`, then run \`${FORGET}\`. The lab does not touch another phone.`, ...stay });

  const bin = resolveBin({ record: rec });
  if (!bin.ok) return failed(rec, { code: 'NO_BINARY', message: bin.error, advice: 'Install sideload or set MSL_SIDELOAD_BIN (then run `lab service install` again so the idle stop has it too).', ...stay });

  const unreachable = (needs, error, fallback) => failed(rec, { code: DEVICE_NEEDS[needs]?.code ?? fallback, message: error, via, phase: rec.phase });
  const lock = lockState(rec.udid);
  if (!lock.ok) return unreachable(lock.needs, lock.error, 'DEVICE_NOT_CONNECTED'); // a phone that won't answer is out of reach
  if (lock.locked) return unreachable('unlock', 'the phone is locked (a passcode is required)');

  // Stops at once when the idle stop's lease was taken over (`lab up --force`): sideload's own lock keeps a call already running safe.
  const mine = async () => {
    if (!touch) return true;
    const ok = await touch();
    return idle ? ok !== false : true;
  };
  const aborted = () => ({ pending: true, returned: false, fresh: true, aborted: true, skipped: 'someone took the lab over while the slot was being given back' });

  if (!await mine()) return aborted();
  rec = putLend({ ...rec, phase: 'returning' }); // intent first
  const id = runnerId(phone);
  const listed = appListed(rec.udid, id);
  if (!listed.ok) return unreachable(listed.needs, listed.error, 'APPS_UNREADABLE');
  if (listed.present) {
    try { await stopDeviceWda(); } catch (e) {
      if (e instanceof InterruptError) throw e;
      return failed(rec, { code: 'WDA_STOP_FAILED', message: `couldn't stop WebDriverAgent before taking it off the phone: ${e.message}`, phase: 'lent' });
    }
    if (!await mine()) return aborted();
    const gone = uninstallRunner(rec.udid, phone);
    const again = appListed(rec.udid, id);
    if (!again.ok) return unreachable(again.needs, again.error, 'APPS_UNREADABLE');
    if (again.present) {
      return failed(rec, { code: 'UNINSTALL_FAILED', message: gone.ok ? 'WebDriverAgent is still on the phone after it was uninstalled' : gone.error, phase: 'lent' });
    }
  }

  if (!await mine()) return aborted();
  const a = await slotCall('return', { udid: rec.udid, bin: bin.path, home: rec.home, touch });
  if (a.ok) {
    const d = a.data;
    if (d.reinstalled === true || d.alreadyPresent === true || d.nothingLent === true) {
      clearLend();
      const app = typeof d.app === 'string' ? d.app : rec.app;
      return {
        pending: true, returned: true, fresh: true, ...(app ? { app } : {}),
        ...(d.reinstalled === true ? { reinstalled: true } : d.alreadyPresent === true ? { alreadyPresent: true } : { nothingLent: true }),
        ...(d.dataRestored !== undefined ? { dataRestored: d.dataRestored } : {}), ...restoreData(d), ...(a.warnings.length ? { warnings: a.warnings } : {}),
      };
    }
    return failed(rec, { code: 'RETURN_UNSETTLED', message: 'sideload answered ok but did not say the slot is back (no reinstalled, alreadyPresent or nothingLent)', phase: 'returning' });
  }
  return failed(rec, { code: a.code, cause: a.cause, message: a.message, fix: a.fix, retryAt: a.retryAt ?? undefined, phase: 'returning', via });
}

// --- borrowing a slot (the `slot` step of `lab up`) ---

// The bundle id of a built runner app (its Info.plist), or null when it can't be read.
function bundleIdOf(app) {
  const r = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Info.plist')], { allowFail: true, timeoutMs: PHONE_WAIT.profileMs });
  const id = String(r.stdout ?? '').trim();
  return r.code === 0 && id ? id : null;
}

// Puts the lab's own runner on the phone under the signing lock (held for the install only: it is let go before any sideload call).
// Builds the runner first when there is no build. installd decides whether it fits: { outcome: 'accepted' } or { outcome: 'limit' }
// (installd's free-app limit: definite, nothing changed). Any other failure throws its `needs` error, and so does a build whose bundle id
// is not the saved phone's `<bundle id>.xctrunner`.
export async function probeInstall({ phone, platformVersion, touch } = {}) {
  const id = runnerId(phone);
  const lock = await acquireSignLock();
  try {
    let app = runnerApp();
    let built = false;
    if (!app) {
      await buildWda({ phone, platformVersion, touch });
      built = true;
      app = runnerApp();
      if (!app) throw new Error('xcodebuild finished but left no signed WebDriverAgent runner under the lab\'s build folder: run `lab up --target device --resign`');
    }
    const has = bundleIdOf(app);
    if (has !== id) throw needsError('resign', `the built WebDriverAgent runner carries ${has ? `bundle id "${has}"` : 'a bundle id the lab can\'t read'}, not "${id}" (the saved phone's); the lab did not install it`);
    const r = installRunner(phone.udid, app);
    if (r.ok) return { outcome: 'accepted', built };
    if (r.limit) return { outcome: 'limit', built, error: r.error };
    throw needsError(r.needs, r.error);
  } finally {
    await lock.release();
  }
}

const GENERIC_LEND = ['sideload would not lend a slot, so there is no room for the lab\'s WebDriverAgent on the phone. Delete an app you don\'t need on the phone, or do what sideload says below, then run the command below.'];
const LEND_STEPS = {
  NO_LENDABLE_APP: ['sideload has no app it may lend. Mark one with `sideload device lendable --alias <alias> --app <app> --yes`, or delete an app you don\'t need on the phone, then run the command below.'],
  ALREADY_LENT: ['sideload has already lent a slot to someone else, and the lab never takes over another holder\'s lend. Wait until it is back, or delete an app you don\'t need on the phone, then run the command below.'],
  LENDABLE_NOT_INSTALLED: ['The app sideload would lend is not on the phone, so there is no slot to take. Delete an app you don\'t need on the phone (or put the lendable app back with sideload), then run the command below.'],
  DEVICE_NOT_SAVED: ['sideload does not know this phone. Save it with `sideload device save ...` (see `sideload device --help`), then run the command below.'],
};
for (const code of ['NOT_SIGNED', 'PROFILE_EXPIRED']) LEND_STEPS[code] = ['The app sideload would lend is not signed or its profile has run out, so sideload did not uninstall anything. Sign it again with sideload (its advice is below), then run the command below.'];

// The error for a `slot lend` that did not lend: `needs` from the table (sideload.js), the steps for a person, sideload's fix last.
// `kept`: the record of the attempt is still there.
function lendError(a, outcome, { kept }) {
  const msg = `sideload would not lend a slot: ${a.code}${a.cause ? ` (${a.cause})` : ''}: ${a.message}`;
  let e;
  if (outcome.needs === 'slots') e = slotsError(msg, { human: LEND_STEPS[a.kind] ?? GENERIC_LEND, fix: a.fix });
  else {
    e = needsError(outcome.needs, msg);
    if (kept && outcome.record !== 'drop') e.extra.human.unshift(`The lab does not know for sure whether sideload lent a slot. It kept a record of the attempt; the next \`lab up\`, the idle stop or \`${RETURN}\` settles it.`);
    if (a.retryAt) e.extra.human.push(`sideload asked for a retry after ${a.retryAt}.`);
    if (a.fix) e.extra.human.push(redactMessage(a.fix, 300));
  }
  if (a.retryAt) e.extra.retryAt = a.retryAt;
  return e;
}

// With WebDriverAgent installed and a record in `lending` or `returning` (a crash or an earlier failure left it): asks sideload what
// became of the loan with `slot return` (nothing is uninstalled: the runner stays where it is). The slot is back (record cleared), or
// the runner holds it (the phase becomes `lent`, so the idle stop gives it back), or sideload is busy or unreadable (left as it is).
// Never fails `lab up`. { did?, summary?, human }.
// A summary with the step report that carries it: `{ summary, report: { slot: summary } }`.
export const withSlot = summary => ({ summary, report: { slot: summary } });

async function settle(rec, { touch, clock }) {
  if (waiting(rec, {})) return { human: [] }; // sideload asked for time: the idle stop and `lab down` try again later
  const bin = resolveBin({ record: rec });
  if (!bin.ok) return { human: [`The lab could not settle the record of a slot borrowed from sideload: ${bin.error}. \`${RETURN}\` does it once sideload is found.`] };
  const a = await slotCall('return', { udid: rec.udid, bin: bin.path, home: rec.home, touch, clock });
  if (a.ok) {
    const d = a.data;
    if (d.reinstalled === true || d.alreadyPresent === true || d.nothingLent === true) {
      clearLend();
      const app = typeof d.app === 'string' ? d.app : rec.app;
      return {
        did: 'settled the record of a slot borrowed from sideload: it is back',
        summary: { returned: true, ...(app ? { app } : {}), ...(d.reinstalled === true ? { reinstalled: true } : d.alreadyPresent === true ? { alreadyPresent: true } : { nothingLent: true }), ...(d.dataRestored !== undefined ? { dataRestored: d.dataRestored } : {}), ...restoreData(d), ...(a.warnings.length ? { warnings: a.warnings } : {}) },
        human: [],
      };
    }
    return { human: ['sideload answered ok to the settling `slot return` but did not say the slot is back; the record is kept.'] };
  }
  if (a.kind === 'FREE_APP_LIMIT') { // the lend stands and WebDriverAgent sits in it
    const next = { ...rec, phase: 'lent' };
    delete next.retryAt;
    delete next.returnFailed; // the lend stands: an old return failure is not about it
    putLend(next);
    return { did: 'kept the borrowed slot (WebDriverAgent sits in it; the idle stop gives it back)', summary: { lent: rec.app ?? null, held: true }, human: [] };
  }
  if (a.retryAt && returnOutcome({ kind: a.kind }).silent) putLend({ ...rec, retryAt: a.retryAt });
  return { human: [`The lab could not settle the record of a slot borrowed from sideload (${a.code}${a.cause ? `/${a.cause}` : ''}: ${a.message}). The idle stop and \`lab down\` try again; \`${RETURN}\` does it now.`] };
}

// The `slot` step of `lab up` for a new phone session. One bounded listing of the phone's apps (the runner's bundle id only); when the
// runner is there nothing more happens. When it is missing, the lab installs the runner it built: installd accepts (it fit: nothing
// is borrowed) or refuses with its free-app limit, and only that refusal leads to `slot lend --udid <saved> --to lab`, then one more
// install. An unreadable listing lends nothing (the session goes on as it always did). Options: `phone` (the saved record),
// `osVersion` (the phone's, for the build), `via` ('tunnel' | 'usbmux'), `touch` (lease renewal), `clock` (tests).
// Returns { found, did, report?, summary?, human? } (`summary`: the top-level `slot` of the JSON, only when something was borrowed or
// settled); throws a `needs` error (`slots`, `busy`, ...) when the runner can't be put on the phone.
export async function ensureWdaSlot({ phone, osVersion, via, touch, clock = Date.now } = {}) {
  const udid = phone.udid;
  const lent = lendState();
  let rec = lent.rec ?? null;
  if (rec && rec.udid !== udid) {
    throw slotsError('a slot borrowed from sideload belongs to another phone than the saved one', { human: [`The lab borrowed a slot from sideload for another phone and has not given it back. Return it by hand with \`sideload slot return --device <alias>\`, then run \`${FORGET}\`.`] });
  }
  const listed = appListed(udid, runnerId(phone));
  if (!listed.ok) { // nothing is lent on a guess, but a damaged record is said all the same
    return { found: `WebDriverAgent: could not list the phone's apps (${listed.error}); no slot lending`, did: null, report: { slot: { checked: false } }, ...(lent.damaged ? { human: [lent.damaged] } : {}) };
  }
  if (lent.damaged) {
    if (listed.present) return { found: 'WebDriverAgent installed', did: null, human: [lent.damaged] };
    throw slotsError(lent.damaged, { human: [lent.damaged] });
  }
  const settleIfStale = async () => (rec && (rec.phase === 'lending' || rec.phase === 'returning') ? settle(rec, { touch, clock }) : null);
  const done = (found, did, settled) => ({
    found, did: [did, settled?.did].filter(Boolean).join('; ') || null,
    ...(settled?.summary ? withSlot(settled.summary) : {}),
    ...(settled?.human?.length ? { human: settled.human } : {}),
  });

  if (listed.present) return done('WebDriverAgent installed', null, await settleIfStale());

  const probe = await probeInstall({ phone, platformVersion: osVersion, touch });
  if (probe.outcome === 'accepted') {
    return done('WebDriverAgent missing', 'installed it (it fit; nothing borrowed)', await settleIfStale());
  }

  // installd said the account is full: only now is a lend asked for.
  const bin = resolveBin({ record: rec });
  if (!bin.ok) {
    throw slotsError(`the phone has no room for WebDriverAgent and the sideload binary is not usable: ${bin.error}`, {
      human: ['The phone holds as many apps from the free account as it allows. The lab can borrow a slot from sideload, but it cannot run sideload: install it or set MSL_SIDELOAD_BIN to its absolute path (then run `lab service install` again so the idle stop has it too). Or delete an app you don\'t need on the phone. Then run the command below.'],
    });
  }
  const home = rec?.home ?? lockDir();
  const wrote = !rec;
  if (!rec) rec = putLend({ udid, phase: 'lending', at: new Date().toISOString(), bin: bin.path, home }); // intent first
  const a = await slotCall('lend', { udid, bin: bin.path, home, touch, clock });
  if (!a.ok) {
    const out = lendOutcome({ kind: a.kind, uncertain: a.uncertain, state: a.state }, { via });
    const drop = out.record === 'drop';
    if (drop) { if (wrote) clearLend(); }
    else if (out.record === 'lent') putLend({ ...rec, phase: 'lent', bin: bin.path, ...(a.retryAt ? { retryAt: a.retryAt } : {}) });
    else if (a.retryAt) putLend({ ...rec, retryAt: a.retryAt });
    throw lendError(a, out, { kept: !drop || !wrote });
  }
  const d = a.data;
  const freed = typeof d.freed === 'number' && d.freed >= 1;
  if (!freed && d.alreadyLent !== true) {
    const unsettled = { kind: 'LEND_UNSETTLED', code: 'LEND_UNSETTLED', message: 'sideload answered ok but did not say a slot was freed or already lent', warnings: [] };
    throw lendError(unsettled, lendOutcome(unsettled, { via }), { kept: true });
  }
  const app = typeof d.app === 'string' && d.app ? d.app : rec.app;
  const device = typeof d.device === 'string' && d.device ? d.device : rec.device;
  const next = { ...rec, phase: 'lent', bin: bin.path, since: d.alreadyLent === true && rec.since ? rec.since : new Date().toISOString(), ...(app ? { app } : {}), ...(device ? { device } : {}) };
  delete next.retryAt;
  delete next.returnFailed; // a failure of an earlier return is not about this lend
  putLend(next);

  const again = await probeInstall({ phone, platformVersion: osVersion, touch });
  if (again.outcome === 'limit') {
    throw slotsError('sideload lent a slot but the phone refused WebDriverAgent again (another app took it in between)', {
      human: [`The slot stays borrowed (the idle stop and \`lab down\` give it back; \`${RETURN}\` does it now). Delete an app you don't need on the phone, then run the command below.`],
    });
  }
  const summary = { lent: app ?? null, ...(freed ? { freed: d.freed } : {}), ...(d.alreadyLent === true ? { alreadyLent: true } : {}), ...(d.dataRestored !== undefined ? { dataRestored: d.dataRestored } : {}), ...backupData(d), ...(a.warnings.length ? { warnings: a.warnings } : {}) };
  return {
    found: 'WebDriverAgent missing, no free slot',
    did: d.alreadyLent === true ? `installed it in the slot already borrowed from sideload${app ? ` (${app}'s)` : ''}` : `borrowed ${app ? `${app}'s` : 'a'} slot from sideload and installed it`,
    ...withSlot(summary),
  };
}
