// Slot lending, the plumbing and the return side (#63, ADR 0008): finding the sideload binary, calling `sideload slot ...`, the lab's
// record of a borrowed slot, and giving it back (idle stop, `lab down`, `lab phone slot return`). devicectl and the sideload calls are
// recorded stand-ins (setRunner); the process-level cases run test/fixtures/fake-sideload for real. Nothing reaches a phone.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, fakeRunner, tempDir, havePerl, holdLock, lockIsFree } from './helpers.js';
import { loadState, saveState, stateDir, setAsyncRunner, runAsync } from '../lib/core.js';
import { InterruptError, withInterrupt } from '../lib/interrupt.js';
import { handlers as lab } from '../lib/lab.js';
import * as lease from '../lib/lease.js';
import * as svc from '../lib/service.js';
import * as phone from '../lib/phone.js';
import { SLOT_WAIT, UNKNOWN_RETRY_MS, resolveBin, slotCall, parseEnvelope, retryAtOf, codeClass, lendOutcome, returnOutcome, sideloadStatus } from '../lib/sideload.js';
import { readLend, putLend, returnSlot, forgetLend, waiting, wantsReturn, ensureWdaSlot, probeInstall, SLOT_PHRASE } from '../lib/slot-lend.js';

const PU = '00008000-000A1B2C3D4E5F60';
const BUNDLE = 'com.example.msl-wda-abcd';
const RUNNER = `${BUNDLE}.xctrunner`;
const PHONE = { udid: PU, teamId: 'ABCDE12345', bundleId: BUNDLE, seen: { osVersion: '27.0.1', buildVersion: null, at: '2026-10-24T12:00:00.000Z', via: 'tunnel' } };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-sideload');
const FIX = path.join(HERE, 'fixtures', 'phone');

let dir, bin, home, fakeDir, calls, w, saved;

// A wrapper script that runs the fake sideload under node (a real executable file: the lab checks for one).
function makeBin(into) {
  const file = path.join(into, 'sideload');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return file;
}

beforeEach(() => {
  dir = sandbox();
  saved = { ...SLOT_WAIT };
  delete process.env.MSL_SIDELOAD_BIN;
  process.env.MSL_OWNER = 'me';
  delete process.env.MSL_LEASE_TTL;
  Object.assign(lease.MUTEX, { retryMs: 5, waitMs: 3000, staleMs: 10e3 });
  Object.assign(svc.WAIT, { statusMs: 100, pollMs: 10, serviceMs: 500, kickMs: 500, portFreeMs: 100 });
  fakeDir = tempDir('msl-fake-sideload-');
  home = tempDir('msl-sideload-home-');
  bin = makeBin(fakeDir);
  process.env.FAKE_DIR = fakeDir;
  process.env.FAKE_MODE = 'ok';
  process.env.SIDELOAD_HOME = home; // the signing lock is a real flock in this folder, never the owner's ~/.sideload
  process.env.MSL_APPIUM_HOME = tempDir('msl-appium-'); // where the lab's WebDriverAgent build is looked for
  delete process.env.MSL_SIGNLOCK;
  saveState({ phone: PHONE });
  world();
});

afterEach(() => {
  Object.assign(SLOT_WAIT, saved);
  setAsyncRunner(null);
  delete process.env.SIDELOAD_HOME;
  delete process.env.MSL_APPIUM_HOME;
});

// --- the phone and sideload, as stand-ins ---

const okAnswer = (extra = {}) => ({ ok: true, command: 'slot', action: 'return', reinstalled: true, ...extra });
// sideload's envelope: errors[] holds {code, message, fix}; the error's data (cause, state, uncertain, retryAfter) is merged into the top level.
const failAnswer = (code, top = {}) => ({ ok: false, command: 'slot', action: 'return', errors: [{ code, message: `${code} happened`, fix: `fix for ${code}` }], ...top });
const returnFailed = (cause, top = {}) => failAnswer('RETURN_FAILED', { cause, ...top });
const say = o => ({ stdout: `${JSON.stringify(o)}\n` });

// The lab's WebDriverAgent build: the runner app under the Appium home's device derived data (or none).
const BUILT = () => path.join(phone.wdaDerivedData(), 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app');
function build(on = true) {
  fs.rmSync(phone.wdaDerivedData(), { recursive: true, force: true });
  if (!on) return;
  fs.mkdirSync(BUILT(), { recursive: true });
  fs.writeFileSync(path.join(BUILT(), 'embedded.mobileprovision'), 'x');
}
const LIMIT = 'ApplicationVerificationFailed: This device has reached the maximum number of installed apps using a free developer profile.';
const APP_IDS = 'Cannot register more than 10 App IDs within a 7 day period.';

// The world the commands see. `w.apps` the bundle ids on the phone; `w.answers` what sideload says to the next calls (a runner reply,
// or an envelope object); `w.installs` what installd says to the next installs of the runner ('ok', 'limit', 'appids', or a runner reply);
// `w.plutil` the bundle id of the built runner; `noBuild` leaves the lab with no WebDriverAgent build; hooks and failures for the cases that need them.
function world(init = {}) {
  w = { locked: false, apps: new Set([RUNNER]), listFail: null, lockFail: null, uninstallFail: null, uninstallKeeps: false, answers: [], installs: [], plutil: RUNNER, noBuild: false, buildFails: false, onLock: null, onUninstall: null, onSideload: null, onInstall: null, onBuild: null, ...init };
  build(!w.noBuild);
  calls = fakeRunner((cmd, args) => {
    if (cmd === bin) {
      w.onSideload?.();
      const a = w.answers.length ? w.answers.shift() : okAnswer();
      return a.stdout !== undefined || a.code !== undefined ? a : say(a);
    }
    if (cmd === 'plutil') return w.plutil ? { stdout: `${w.plutil}\n` } : { code: 1, stderr: 'no such key' };
    if (cmd === 'xcodebuild') {
      w.onBuild?.();
      if (w.buildFails) return { code: 65, stderr: 'error: build failed' };
      build(true);
      return undefined;
    }
    if (cmd !== 'xcrun' || args[0] !== 'devicectl') return undefined;
    const verb = args.slice(1, 4).join(' ');
    const out = args[args.indexOf('--json-output') + 1];
    if (verb === 'device info lockState') {
      w.onLock?.();
      if (w.lockFail) return { code: 1, stderr: w.lockFail };
      fs.writeFileSync(out, fs.readFileSync(path.join(FIX, w.locked ? 'lock-locked.json' : 'lock-unlocked.json'), 'utf8'));
    } else if (verb === 'device info apps') {
      if (w.listFail) return { code: 1, stderr: w.listFail };
      fs.writeFileSync(out, JSON.stringify({ result: { apps: [...w.apps].map(bundleIdentifier => ({ bundleIdentifier })) } }));
    } else if (verb === 'device install app') {
      w.onInstall?.();
      const r = w.installs.length ? w.installs.shift() : 'ok';
      if (r === 'ok') { w.apps.add(RUNNER); return undefined; }
      return r === 'limit' ? { code: 1, stderr: LIMIT } : r === 'appids' ? { code: 1, stderr: APP_IDS } : r;
    } else if (verb === 'device uninstall app') {
      w.onUninstall?.();
      if (w.uninstallFail) return { code: 1, stderr: w.uninstallFail };
      if (!w.uninstallKeeps) w.apps.delete(args.at(-3));
    }
    return undefined;
  });
}

// The record of a slot the lab holds (written by hand: nothing lends yet).
const record = (extra = {}) => ({ udid: PU, phase: 'lent', at: '2026-10-24T12:00:00.000Z', since: '2026-10-24T12:00:00.000Z', app: 'stremio-ios', bin, home, ...extra });
const lend = extra => putLend(record(extra));
const noOut = c => c.slice(0, c.indexOf('--json-output') === -1 ? undefined : c.indexOf('--json-output'));
const dev = verb => calls.filter(c => c[0] === 'xcrun' && c[1] === 'devicectl' && c.slice(2, 5).join(' ') === verb).map(noOut);
const sideloadCalls = () => calls.map((c, i) => ({ c, o: calls.opts[i] })).filter(x => x.c[0] === bin);
const now = () => new Date().toISOString();

const activityPath = () => path.join(stateDir(), 'activity.json');
const setActive = min => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(activityPath(), JSON.stringify({ at: new Date(Date.now() - min * 60e3).toISOString() })); };
async function logged(fn) {
  const lines = [];
  const real = console.error;
  console.error = m => lines.push(String(m));
  try { return [await fn(), lines]; } finally { console.error = real; }
}
const asLeaseHolder = owner => fs.writeFileSync(path.join(stateDir(), 'lease.json'), JSON.stringify({ owner, since: now(), expires: new Date(Date.now() + 600e3).toISOString() }));

// --- B: the binary and the call ---

test('B1: MSL_SIDELOAD_BIN that is relative, missing, not executable or a folder is refused, and no other binary replaces it', () => {
  const plain = path.join(fakeDir, 'plain');
  fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
  const folder = path.join(fakeDir, 'folder');
  fs.mkdirSync(folder);
  for (const [value, why] of [['sideload', /is not an absolute path/], [path.join(fakeDir, 'nope'), /does not exist/], [plain, /is not executable/], [folder, /is not a file/]]) {
    const r = resolveBin({ record: { bin }, env: { MSL_SIDELOAD_BIN: value, PATH: fakeDir } });
    assert.equal(r.ok, false, value);
    assert.equal(r.from, 'MSL_SIDELOAD_BIN');
    assert.match(r.error, why);
    assert.match(r.error, /MSL_SIDELOAD_BIN/);
  }
  assert.equal(resolveBin({ env: { MSL_SIDELOAD_BIN: bin } }).path, bin);
  assert.equal(resolveBin({ env: { MSL_SIDELOAD_BIN: '' , PATH: fakeDir } }).from, 'PATH', 'an empty value is no value');
});

test('B2: the PATH lookup returns an absolute path, skips relative entries, and says so when there is none', () => {
  const r = resolveBin({ env: { PATH: `.:relative/bin::${fakeDir}` } });
  assert.deepEqual([r.ok, r.path, r.from], [true, bin, 'PATH']);
  assert.ok(path.isAbsolute(r.path));
  const none = resolveBin({ env: { PATH: `.:${tempDir()}` } });
  assert.equal(none.ok, false);
  assert.equal(none.from, null);
  assert.match(none.error, /sideload binary was not found on PATH: install sideload, or set MSL_SIDELOAD_BIN/);
});

test('B3: environment, then the record, then PATH', () => {
  const other = makeBin(tempDir('msl-other-'));
  const env = { PATH: path.dirname(other) };
  assert.deepEqual([resolveBin({ record: { bin }, env: { ...env, MSL_SIDELOAD_BIN: other } }).path, resolveBin({ record: { bin }, env: { ...env, MSL_SIDELOAD_BIN: other } }).from], [other, 'MSL_SIDELOAD_BIN']);
  assert.deepEqual([resolveBin({ record: { bin }, env }).path, resolveBin({ record: { bin }, env }).from], [bin, 'record']);
  assert.deepEqual([resolveBin({ record: { bin: path.join(fakeDir, 'gone') }, env }).path, resolveBin({ record: { bin: path.join(fakeDir, 'gone') }, env }).from], [other, 'PATH'], 'a record whose binary is gone falls to PATH');
  assert.equal(resolveBin({ env }).from, 'PATH');
});

test('B4: a slot call runs the binary with the saved UDID (--udid, never --device) and the record\'s SIDELOAD_HOME', async () => {
  setAsyncRunner(null); // the real spawn, the fake sideload
  fs.writeFileSync(path.join(fakeDir, 'answers.json'), JSON.stringify([okAnswer({ app: 'stremio-ios' }), { ok: true, command: 'slot', action: 'lend', freed: 1, alreadyLent: false }]));
  const ret = await slotCall('return', { udid: PU, bin, home });
  assert.equal(ret.ok, true);
  assert.equal(ret.data.reinstalled, true);
  const lent = await slotCall('lend', { udid: PU, bin, home });
  assert.equal(lent.ok, true);
  const log = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => l.argv), [['slot', 'return', '--udid', PU], ['slot', 'lend', '--udid', PU, '--to', 'lab']]);
  assert.deepEqual(log.map(l => l.home), [home, home]);
  assert.ok(!log.some(l => l.argv.includes('--device')));
  await assert.rejects(slotCall('return', { udid: 'booted', bin, home }), /not a device UDID/);
  await assert.rejects(slotCall('return', { udid: PU, bin, home: 'relative' }), /SIDELOAD_HOME must be an absolute path/);
  await assert.rejects(slotCall('return', { udid: PU, bin: 'sideload', home }), /sideload binary "sideload" is not an absolute path/);
  await assert.rejects(slotCall('wipe', { udid: PU, bin, home }), /not lend or return/);
});

test('B4: the call is made with the lab\'s own time limits and SIDELOAD_HOME in its environment (recorded runner)', async () => {
  w.answers.push(okAnswer());
  const touch = () => {};
  await slotCall('return', { udid: PU, bin, home, touch });
  const [{ c, o }] = sideloadCalls();
  assert.deepEqual(c, [bin, 'slot', 'return', '--udid', PU]);
  assert.deepEqual(o.env, { SIDELOAD_HOME: home });
  assert.equal(o.timeoutMs, SLOT_WAIT.returnMs + SLOT_WAIT.dataMarginMs);
  assert.equal(o.killAfterMs, SLOT_WAIT.termGraceMs);
  assert.equal(o.onTick, touch);
  assert.equal(o.tickMs, SLOT_WAIT.tickMs);
  w.answers.push(okAnswer());
  await slotCall('lend', { udid: PU, bin, home });
  assert.equal(sideloadCalls()[1].o.timeoutMs, SLOT_WAIT.lendMs + SLOT_WAIT.dataMarginMs);
});

test('B5: a call that outlasts its limit gets SIGTERM (sideload prints INTERRUPTED) and is unknown, not failed', async () => {
  setAsyncRunner(null);
  Object.assign(SLOT_WAIT, { returnMs: 1500, dataMarginMs: 0, termGraceMs: 2000, tickMs: 100 });
  process.env.FAKE_MODE = 'term-json';
  let ticks = 0;
  const a = await slotCall('return', { udid: PU, bin, home, touch: () => { ticks++; } });
  assert.deepEqual([a.ok, a.unknown, a.timedOut, a.kind, a.said], [false, true, true, 'TIMEOUT', 'INTERRUPTED']);
  assert.equal(a.uncertain, true);
  assert.equal(codeClass(a.kind), 'busy');
  assert.ok(ticks >= 3, `the lease is renewed while sideload works (${ticks})`);
});

test('B5: a sideload that ignores SIGTERM is killed after the grace, and the call still ends', async () => {
  setAsyncRunner(null);
  Object.assign(SLOT_WAIT, { returnMs: 1200, dataMarginMs: 0, termGraceMs: 400 });
  process.env.FAKE_MODE = 'ignore-term';
  const t = Date.now();
  const a = await slotCall('return', { udid: PU, bin, home });
  const took = Date.now() - t;
  assert.deepEqual([a.unknown, a.kind], [true, 'TIMEOUT']);
  assert.ok(took >= 1200 + 300 && took < 1200 + 400 + 3000, `SIGKILL came after the grace, not the default 3 s or never (${took} ms)`);
  const pid = Number(fs.readFileSync(path.join(fakeDir, 'tool.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the fake sideload is gone');
});

test('B5: an interrupt of the lab ends the call with an InterruptError (the record is kept by the caller)', async () => {
  setAsyncRunner(null);
  process.env.FAKE_MODE = 'sleep';
  const call = withInterrupt(() => slotCall('return', { udid: PU, bin, home }));
  await new Promise(r => setTimeout(r, 400));
  process.emit('SIGINT', 'SIGINT');
  await assert.rejects(call, e => e instanceof InterruptError);
});

test('B6: output that is not an envelope, and a binary that cannot run, are unknown', async () => {
  setAsyncRunner(null);
  process.env.FAKE_MODE = 'garbage';
  const g = await slotCall('return', { udid: PU, bin, home });
  assert.deepEqual([g.ok, g.unknown, g.kind], [false, true, 'UNPARSEABLE']);
  assert.equal(codeClass('UNPARSEABLE'), 'busy');
  world();
  w.answers.push({ code: 127, stderr: 'spawn ENOENT' });
  const s = await slotCall('return', { udid: PU, bin, home });
  assert.deepEqual([s.unknown, s.kind], [true, 'SPAWN_FAILED']);
});

test('an unknown outcome waits sideload\'s longest window (645 s) unless sideload gave a retryAfter', async () => {
  assert.equal(UNKNOWN_RETRY_MS, 645e3);
  const t0 = Date.parse('2026-10-24T12:00:00.000Z');
  const at = (answer, extra = {}) => { w.answers.push(answer); return slotCall('return', { udid: PU, bin, home, clock: () => t0, ...extra }); };
  assert.equal((await at({ code: 124 })).retryAt, '2026-10-24T12:10:45.000Z', 'a timeout');
  assert.equal((await at({ stdout: 'oops' })).retryAt, '2026-10-24T12:10:45.000Z', 'unreadable output');
  assert.equal((await at(failAnswer('INTERRUPTED'))).retryAt, '2026-10-24T12:10:45.000Z', 'INTERRUPTED');
  assert.equal((await at(failAnswer('INTERRUPTED', { retryAfter: 30 }))).retryAt, '2026-10-24T12:00:30.000Z', 'sideload\'s own time wins');
  assert.equal((await at(failAnswer('NOT_SIGNED'))).retryAt, null, 'a definite answer has none');
  // The idle stop and `lab down` wait for it.
  lend();
  w.answers.push({ code: 124 });
  assert.equal((await returnSlot({})).returned, false);
  assert.ok(Date.parse(readLend(loadState()).retryAt) > Date.now() + 600e3);
  assert.match((await returnSlot({})).skipped, /retry after/);
});

test('retry times count from the END of the call, which may have run for minutes', async () => {
  const t0 = Date.parse('2026-10-24T12:00:00.000Z');
  const end = t0 + 22 * 60e3;
  // The clock reads t0 until the call has run and 22 minutes later after it: only a read after the call sees the second.
  let ran = false;
  w.onSideload = () => { ran = true; };
  const clock = () => (ran ? end : t0);
  const via = answer => { ran = false; w.answers.push(answer); return slotCall('return', { udid: PU, bin, home, clock }); };
  const plus = ms => new Date(end + ms).toISOString();
  assert.equal((await via({ code: 124 })).retryAt, plus(645e3), 'a timeout');
  assert.equal((await via(failAnswer('INTERRUPTED'))).retryAt, plus(645e3), 'INTERRUPTED');
  assert.equal((await via({ stdout: 'oops' })).retryAt, plus(645e3), 'unreadable output');
  assert.equal((await via(failAnswer('SLOT_PENDING', { retryAfter: 120 }))).retryAt, plus(120e3), 'sideload\'s retryAfter');
});

test('a retryAfter that sideload printed with its INTERRUPTED answer on a timeout is used', async () => {
  const t0 = Date.parse('2026-10-24T12:00:00.000Z');
  const clock = () => t0;
  w.answers.push({ code: 124, stdout: JSON.stringify(failAnswer('INTERRUPTED', { retryAfter: 90 })) });
  const a = await slotCall('return', { udid: PU, bin, home, clock });
  assert.deepEqual([a.kind, a.said, a.retryAt], ['TIMEOUT', 'INTERRUPTED', '2026-10-24T12:01:30.000Z']);
  w.answers.push({ code: 124, stdout: JSON.stringify({ ok: false, errors: [{ code: 'INTERRUPTED', message: 'm', retryAfter: 45 }] }) });
  assert.equal((await slotCall('return', { udid: PU, bin, home, clock })).retryAt, '2026-10-24T12:00:45.000Z', 'inside errors[0] too');
});

test('the envelope: errors, RETURN_FAILED\'s cause, retryAfter, warnings and the last JSON line are read', async () => {
  assert.deepEqual(parseEnvelope('noise\n{"ok":true}\n'), { ok: true });
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(parseEnvelope('[1]'), null);
  assert.equal(parseEnvelope(''), null);
  const t0 = Date.parse('2026-10-24T12:00:00.000Z');
  assert.equal(retryAtOf(90, t0), '2026-10-24T12:01:30.000Z');
  assert.equal(retryAtOf('90', t0), '2026-10-24T12:01:30.000Z');
  assert.equal(retryAtOf('2026-10-24T13:00:00.000Z', t0), '2026-10-24T13:00:00.000Z');
  assert.equal(retryAtOf(undefined, t0), null);
  assert.equal(retryAtOf(-5, t0), null);
  assert.equal(retryAtOf(1e9, t0), '2026-10-25T12:00:00.000Z', 'at most a day');

  w.answers.push(returnFailed('FREE_APP_LIMIT', { uncertain: true, retryAfter: 60, state: 'lent' }), failAnswer('SLOT_PENDING', { retryAfter: 30, warnings: [{ code: 'LAST_FREE_APP_REMOVED' }] }));
  const a = await slotCall('return', { udid: PU, bin, home });
  assert.deepEqual([a.kind, a.code, a.cause, a.uncertain, a.state, a.fix, a.message], ['FREE_APP_LIMIT', 'RETURN_FAILED', 'FREE_APP_LIMIT', true, 'lent', 'fix for RETURN_FAILED', 'RETURN_FAILED happened']);
  assert.ok(Date.parse(a.retryAt) > Date.now());
  const b = await slotCall('return', { udid: PU, bin, home });
  assert.deepEqual([b.kind, b.cause, b.uncertain, b.warnings], ['SLOT_PENDING', undefined, false, [{ code: 'LAST_FREE_APP_REMOVED' }]]);
});

test('an older shape, with cause, uncertain and retryAfter inside errors[0], is still read', async () => {
  w.answers.push({ ok: false, command: 'slot', action: 'return', errors: [{ code: 'RETURN_FAILED', message: 'm', fix: 'f', cause: 'DEVICE_LOCKED', uncertain: true, retryAfter: 60, state: 'lent' }] });
  const a = await slotCall('return', { udid: PU, bin, home });
  assert.deepEqual([a.kind, a.cause, a.uncertain, a.state], ['DEVICE_LOCKED', 'DEVICE_LOCKED', true, 'lent']);
  assert.ok(Date.parse(a.retryAt) > Date.now());
});

test('every code of sideload\'s list has the class the plan gives it; what is not listed is the owner\'s', () => {
  const classes = {
    busy: ['SLOT_PENDING', 'OPERATION_IN_PROGRESS', 'UNINSTALL_RESULT_UNCERTAIN', 'INSTALL_RESULT_UNCERTAIN', 'SLOT_STATE_UNKNOWN', 'TIMEOUT', 'INTERRUPTED', 'SNAPSHOT_FAILED'],
    unlock: ['DEVICE_LOCKED'], connection: ['DEVICE_NOT_CONNECTED'], trust: ['DEVICE_NOT_PAIRED'], limit: ['FREE_APP_LIMIT'],
    retry: ['UNINSTALL_FAILED', 'INSTALL_FAILED', 'INSTALL_UNCONFIRMED', 'RETURN_NOT_LANDED'],
    owner: ['NO_LENDABLE_APP', 'LENDABLE_NOT_INSTALLED', 'ALREADY_LENT', 'NOT_SIGNED', 'PROFILE_EXPIRED', 'PROFILE_INVALID', 'PROFILE_MISSING', 'PROFILE_CERT_MISMATCH', 'DEVICE_NOT_IN_PROFILE', 'WRONG_TEAM', 'GUARD_FAILED', 'KEYCHAIN_LOCKED', 'FREE_IDENTITY_AMBIGUOUS', 'FREE_IDENTITY_MISSING', 'FREE_CERT_CHANGED', 'CONFIG_INVALID', 'LEDGER_INVALID', 'DEVICE_NOT_SAVED', 'USAGE', 'SOMETHING_NEW'],
  };
  for (const [cls, codes] of Object.entries(classes)) for (const code of codes) assert.equal(codeClass(code), cls, code);
});

test('the lend table: what each answer does to the record the lab wrote before the call', () => {
  const rec = (kind, extra = {}) => lendOutcome({ kind, ...extra }, { via: 'tunnel' });
  assert.deepEqual([rec('SLOT_PENDING').needs, rec('SLOT_PENDING').record], ['busy', 'keep']);
  assert.deepEqual([rec('OPERATION_IN_PROGRESS').needs, rec('OPERATION_IN_PROGRESS').record], ['busy', 'drop']);
  for (const k of ['UNINSTALL_RESULT_UNCERTAIN', 'SLOT_STATE_UNKNOWN', 'INTERRUPTED', 'TIMEOUT', 'UNPARSEABLE']) assert.deepEqual([rec(k).needs, rec(k).record], ['busy', 'keep'], k);
  for (const k of ['NO_LENDABLE_APP', 'ALREADY_LENT', 'LENDABLE_NOT_INSTALLED', 'NOT_SIGNED', 'PROFILE_EXPIRED', 'DEVICE_NOT_SAVED']) assert.deepEqual([rec(k).needs, rec(k).record], ['slots', 'drop'], k);
  assert.deepEqual([rec('DEVICE_LOCKED').needs, rec('DEVICE_LOCKED').record], ['unlock', 'drop']);
  assert.deepEqual([rec('DEVICE_NOT_PAIRED').needs, rec('DEVICE_NOT_PAIRED').record], ['trust', 'drop']);
  assert.equal(rec('DEVICE_NOT_CONNECTED').needs, 'tunnel');
  assert.equal(lendOutcome({ kind: 'DEVICE_NOT_CONNECTED' }, { via: 'usbmux' }).needs, 'cable');
  assert.deepEqual([rec('INSTALL_FAILED').needs, rec('INSTALL_FAILED').record], ['unknown', 'drop']);
  assert.deepEqual([rec('UNEXPECTED_APP_DELTA', { state: 'lent' }).needs, rec('UNEXPECTED_APP_DELTA', { state: 'lent' }).record], ['unknown', 'lent']);
  assert.equal(rec('UNEXPECTED_APP_DELTA').record, 'keep');
  assert.equal(rec('NOT_SIGNED', { uncertain: true }).record, 'keep', 'an uncertain answer may have lent');
});

test('the return table: silent busy answers, owner actions that wait for a lab command, the rest retried', () => {
  const o = (kind, via) => returnOutcome({ kind }, { via });
  assert.deepEqual([o('SLOT_PENDING').silent, o('SLOT_PENDING').noAutoRetry], [true, false]);
  assert.deepEqual([o('KEYCHAIN_LOCKED').silent, o('KEYCHAIN_LOCKED').noAutoRetry, o('KEYCHAIN_LOCKED').needs], [false, true, 'slots']);
  assert.equal(o('FREE_IDENTITY_AMBIGUOUS').noAutoRetry, true);
  assert.equal(o('SOMETHING_NEW').noAutoRetry, true);
  assert.deepEqual([o('UNINSTALL_FAILED').silent, o('UNINSTALL_FAILED').noAutoRetry, o('UNINSTALL_FAILED').needs], [false, false, 'unknown']);
  assert.deepEqual([o('DEVICE_LOCKED').needs, o('DEVICE_LOCKED').noAutoRetry], ['unlock', false]);
  assert.deepEqual([o('DEVICE_NOT_CONNECTED', 'tunnel').needs, o('DEVICE_NOT_CONNECTED', 'usbmux').needs, o('DEVICE_NOT_CONNECTED').needs], ['tunnel', 'cable', 'cable']);
  assert.equal(o('FREE_APP_LIMIT').needs, 'slots');
});

// --- the phone side: listing, uninstalling, the limit text ---

test('the app listing: present, absent, unreadable output and failures are told apart (never "absent" by guess)', () => {
  world();
  assert.deepEqual(phone.appListed(PU, RUNNER), { ok: true, present: true });
  w.apps.clear();
  assert.deepEqual(phone.appListed(PU, RUNNER), { ok: true, present: false });
  assert.deepEqual(dev('device info apps')[0], ['xcrun', 'devicectl', 'device', 'info', 'apps', '--device', PU, '--bundle-id', RUNNER]);
  w.listFail = 'The device is locked.';
  const locked = phone.appListed(PU, RUNNER);
  assert.deepEqual([locked.ok, locked.needs], [false, 'unlock']);
  w.listFail = null;
  calls = fakeRunner((cmd, args) => (cmd === 'xcrun' ? (fs.writeFileSync(args[args.indexOf('--json-output') + 1], '{"result":{}}'), undefined) : undefined));
  const odd = phone.appListed(PU, RUNNER);
  assert.deepEqual([odd.ok, odd.needs], [false, 'unknown']);
  assert.match(odd.error, /does not recognise/);
  calls = fakeRunner(() => ({ code: 124 }));
  assert.match(phone.appListed(PU, RUNNER).error, /timed out/);
  assert.throws(() => phone.appListed('booted', RUNNER), /not a device UDID/);
  assert.throws(() => phone.appListed(PU, 'nodots'), /not a bundle id/);
});

test('R6: only the saved bundle id\'s .xctrunner is uninstalled, and never one of sideload\'s apps', () => {
  world();
  assert.deepEqual(phone.uninstallRunner(PU, PHONE), { ok: true });
  assert.deepEqual(dev('device uninstall app'), [['xcrun', 'devicectl', 'device', 'uninstall', 'app', '--device', PU, RUNNER]]);
  assert.equal(phone.runnerId(PHONE), RUNNER);
  const before = calls.length;
  assert.throws(() => phone.uninstallRunner(PU, { ...PHONE, bundleId: 'io.github.dividedby.free.stremio' }), /one of sideload's apps/);
  assert.throws(() => phone.uninstallRunner(PU, { ...PHONE, bundleId: 'io.github.dividedby.free' }), /one of sideload's apps/);
  assert.throws(() => phone.uninstallRunner('booted', PHONE), /not a device UDID/);
  assert.throws(() => phone.uninstallRunner(PU, {}), /no bundle id/);
  assert.equal(calls.length, before, 'a refusal runs no command');
  w.uninstallFail = 'The device is locked.';
  const r = phone.uninstallRunner(PU, PHONE);
  assert.deepEqual([r.ok, r.needs], [false, 'unlock']);
});

test('installRunner passes the saved UDID and an absolute .app; an installd limit refusal is told from the App-ID limit', () => {
  const app = path.join(tempDir(), 'WebDriverAgentRunner-Runner.app');
  world();
  assert.deepEqual(phone.installRunner(PU, app), { ok: true });
  assert.deepEqual(dev('device install app'), [['xcrun', 'devicectl', 'device', 'install', 'app', '--device', PU, app]]);
  assert.throws(() => phone.installRunner(PU, 'Runner.app'), /absolute path to an .app/);
  assert.throws(() => phone.installRunner(PU, '/x/Runner'), /absolute path to an .app/);
  calls = fakeRunner(() => ({ code: 1, stderr: 'ApplicationVerificationFailed: This device has reached the maximum number of installed apps using a free developer profile.' }));
  const limit = phone.installRunner(PU, app);
  assert.deepEqual([limit.ok, limit.limit, limit.needs], [false, true, 'slots']);
  calls = fakeRunner(() => ({ code: 1, stderr: 'Cannot register more than 10 App IDs within a 7 day period.' }));
  const ids = phone.installRunner(PU, app);
  assert.deepEqual([ids.limit, ids.needs], [false, 'slots']);
});

// Real devicectl stderr for installd's free-app limit (scrubbed): the limit sentence sits past char 400, where the shown error is cut.
const LONG_LIMIT = fs.readFileSync(path.join(FIX, 'install-free-app-limit-stderr.txt'), 'utf8');

test('installRunner: a long real free-app-limit message is still the limit (classified on the whole text), and the shown error is redacted and cut', () => {
  const app = path.join(tempDir(), 'WebDriverAgentRunner-Runner.app');
  assert.ok(LONG_LIMIT.replace(/\s+/g, ' ').indexOf('maximum number of installed apps') > 400, 'the fixture is the long case');
  assert.ok(/ApplicationIdentifier/.test(LONG_LIMIT) && !/App ID/i.test(LONG_LIMIT), 'it names ApplicationIdentifier, which the App ID guard must not read as an App ID');
  assert.equal(phone.isAppLimit(LONG_LIMIT), true);
  const udid = '00008110-001A2B3C4D5E6F78';
  calls = fakeRunner(() => ({ code: 1, stderr: `${LONG_LIMIT}\n(device ${udid} on iPhone.coredevice.local)` }));
  const r = phone.installRunner(PU, app);
  assert.deepEqual([r.ok, r.limit, r.needs], [false, true, 'slots']);
  assert.ok(r.error.length <= 403, `error is bounded (${r.error.length})`);
  assert.ok(!r.error.includes('\n'));
  assert.ok(!r.error.includes(udid) && !r.error.includes('.coredevice.local'));
  assert.ok(!r.error.includes('maximum number of installed apps'), 'the cut text no longer carries the sentence');
});

test('failures other than install classify on the whole text too: a long devicectl message ending in a known text', () => {
  const long = `${'x'.repeat(500)} The device is locked.`;
  calls = fakeRunner(() => ({ code: 1, stderr: long }));
  const r = phone.uninstallRunner(PU, PHONE);
  assert.deepEqual([r.ok, r.needs], [false, 'unlock']);
  assert.ok(r.error.length <= 403);
});

test('isAppLimit: both limit texts count, the App-ID-per-week limit never does', () => {
  assert.equal(phone.isAppLimit('This device has reached the maximum number of installed apps using a free developer profile'), true);
  assert.equal(phone.isAppLimit('maximum number of apps for free development profiles'), true);
  assert.equal(phone.isAppLimit('maximum number of installed apps'), true);
  assert.equal(phone.isAppLimit('You have reached the maximum number of App IDs (10) for this week'), false);
  assert.equal(phone.isAppLimit('Cannot register more than 10 App IDs'), false);
  // Text that matches the app limit AND names App IDs is the per-week limit: the exclusion is what keeps it from lending.
  const both = 'ApplicationVerificationFailed: This device has reached the maximum number of installed apps using a free developer profile (App ID limit reached for this week).';
  assert.equal(phone.isAppLimit(both), false);
  assert.equal(phone.isAppLimit('You have reached the maximum number of apps; Cannot register more than 10 App IDs'), false);
  assert.equal(phone.isAppLimit(''), false);
  assert.equal(phone.isAppLimit(undefined), false);
  assert.equal(phone.classify('Cannot register more than 10 App IDs'), 'slots', 'classify is unchanged');
});

test('slotsError keeps needs slots, replaces the steps, and ends with sideload\'s fix (redacted)', () => {
  const e = phone.slotsError('no lendable app', { human: ['Pick an app.'], fix: 'run `sideload device lendable --app x` on 00008000-000A1B2C3D4E5F60' });
  assert.equal(e.extra.needs, 'slots');
  assert.equal(e.extra.human[0], 'Pick an app.');
  assert.match(e.extra.human.at(-1), /<udid>/);
  assert.ok(!JSON.stringify(e.extra).includes(PU));
  assert.deepEqual(phone.slotsError('x').extra.human, phone.NEEDS.slots.human);
});

test('runnerApp finds the built runner, the WebDriverAgentRunner one first; profileExpiry still reads its profile', () => {
  const dd = tempDir('msl-dd-');
  assert.equal(phone.runnerApp(dd), null);
  const products = path.join(dd, 'Build', 'Products', 'Debug-iphoneos');
  for (const n of ['Other.app', 'WebDriverAgentRunner-Runner.app']) {
    fs.mkdirSync(path.join(products, n), { recursive: true });
    fs.writeFileSync(path.join(products, n, 'embedded.mobileprovision'), 'x');
  }
  assert.equal(phone.runnerApp(dd), path.join(products, 'WebDriverAgentRunner-Runner.app'));
  calls = fakeRunner((cmd) => (cmd === 'security' ? { stdout: '<key>ExpirationDate</key>\n<date>2026-11-01T00:00:00Z</date>' } : undefined));
  assert.equal(phone.profileExpiry(dd), '2026-11-01T00:00:00.000Z');
  assert.deepEqual(calls.at(-1), ['security', 'cms', '-D', '-i', path.join(products, 'WebDriverAgentRunner-Runner.app', 'embedded.mobileprovision')]);
});

// --- the record ---

test('the record: a good one reads back, every wrong shape is damaged and names `lab phone slot forget`', () => {
  assert.equal(readLend({}), null);
  assert.equal(readLend({ slotLend: null }), null);
  const good = record({ retryAt: now(), returnFailed: { code: 'X', at: now(), human: ['a'] } });
  assert.deepEqual(readLend({ slotLend: good }), good);
  for (const bad of [
    'text', [], { ...good, udid: 'booted' }, { ...good, phase: 'done' }, { ...good, at: 'yesterday' }, { ...good, bin: 'sideload' }, { ...good, home: undefined },
    { ...good, retryAt: 5 }, { ...good, app: '' }, { ...good, extra: 1 }, { ...good, returnFailed: { code: '', at: now(), human: [] } }, { ...good, returnFailed: { code: 'X', at: now(), human: [1] } },
  ]) assert.throws(() => readLend({ slotLend: bad }), /lab phone slot forget/, JSON.stringify(bad));
});

test('waiting: sideload\'s retry time holds the idle stop and `lab down`; an owner action holds the idle stop until a lab command ran; a person is never held', () => {
  const t = Date.parse('2026-10-24T12:00:00.000Z');
  const later = new Date(t + 60e3).toISOString();
  const failed = { code: 'KEYCHAIN_LOCKED', at: new Date(t).toISOString(), human: [], noAutoRetry: true };
  assert.match(waiting(record({ retryAt: later }), { idle: true, now: t }), /retry after/);
  assert.match(waiting(record({ retryAt: later }), { now: t }), /retry after/);
  assert.equal(waiting(record({ retryAt: later }), { manual: true, now: t }), null);
  assert.equal(waiting(record({ retryAt: new Date(t - 1).toISOString() }), { idle: true, now: t }), null);
  assert.match(waiting(record({ returnFailed: failed }), { idle: true, lastActive: t - 5e3, now: t }), /no lab command has run since/);
  assert.match(waiting(record({ returnFailed: failed }), { idle: true, lastActive: null, now: t }), /no lab command/);
  assert.equal(waiting(record({ returnFailed: failed }), { idle: true, lastActive: t + 5e3, now: t }), null, 'a lab command ran since');
  assert.equal(waiting(record({ returnFailed: failed }), { lastActive: t - 5e3, now: t }), null, '`lab down` is a lab command');
  assert.equal(waiting(record({ returnFailed: failed }), { manual: true, idle: true, lastActive: 0, now: t }), null);
  assert.equal(wantsReturn({}, {}), false);
  assert.equal(wantsReturn({ slotLend: 'junk' }, {}), false, 'a damaged record is not the idle stop\'s to act on');
  assert.equal(wantsReturn({ slotLend: record() }, {}), true);
});

// --- R: giving the slot back ---

test('R1: the idle stop returns the slot: lock check, listing, uninstall of the saved runner id, listing, `slot return`; `reinstalled` alone clears it', async () => {
  lend();
  setActive(20);
  w.answers.push(okAnswer({ app: 'stremio-ios' })); // no `settled` field
  const [out, lines] = await logged(() => lab.down(['--idle']));
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.idle, true);
  assert.ok(out.running.includes(SLOT_PHRASE));
  assert.deepEqual(out.steps.map(s => s.step), ['session', 'wda', 'slot', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium']);
  const verbs = calls.filter(c => c[0] === 'xcrun' || c[0] === bin).map(c => (c[0] === bin ? 'sideload' : c.slice(2, 5).join(' ')));
  assert.deepEqual(verbs, ['device info lockState', 'device info apps', 'device uninstall app', 'device info apps', 'sideload']);
  assert.deepEqual(dev('device uninstall app'), [['xcrun', 'devicectl', 'device', 'uninstall', 'app', '--device', PU, RUNNER]]);
  const [{ c, o }] = sideloadCalls();
  assert.deepEqual(c, [bin, 'slot', 'return', '--udid', PU]);
  assert.equal(o.env.SIDELOAD_HOME, home);
  assert.equal(loadState().slotLend, undefined);
  assert.equal(out.slotReturned, true);
  assert.equal(out.slot.returned, true);
  assert.equal(out.slot.reinstalled, true);
  assert.equal(out.slot.app, 'stremio-ios');
  assert.match(out.steps.find(s => s.step === 'slot').did, /gave it back/);
  assert.equal(loadState().idleStop.slot.returned, true);
  assert.equal(loadState().idleStop.failures, 0);
  assert.equal(lines.length, 1);
  assert.equal(lease.read(), null, 'the idle stop\'s lease is handed back');
  assert.ok(!JSON.stringify(out).includes(PU), 'no UDID in the output');
});

test('R2: `alreadyPresent` and `nothingLent` clear the record too', async () => {
  for (const [flag, key] of [[{ alreadyPresent: true }, 'alreadyPresent'], [{ nothingLent: true }, 'nothingLent']]) {
    world();
    lend();
    w.answers.push({ ok: true, command: 'slot', action: 'return', ...flag });
    const r = await returnSlot({});
    assert.equal(r.returned, true, key);
    assert.equal(r[key], true);
    assert.equal(loadState().slotLend, undefined);
  }
});

test('R2: an ok answer that says nothing about the slot being back does not clear the record', async () => {
  lend();
  w.answers.push({ ok: true, command: 'slot', action: 'return' });
  const r = await returnSlot({});
  assert.deepEqual([r.returned, r.code], [false, 'RETURN_UNSETTLED']);
  assert.equal(readLend(loadState()).phase, 'returning');
});

test('R2: dataRestored and warnings are passed through, never depended on', async () => {
  lend();
  w.answers.push(okAnswer({ dataRestored: true, warnings: [{ code: 'LAST_FREE_APP_REMOVED', message: 'm' }] }));
  const r = await returnSlot({});
  assert.deepEqual([r.returned, r.dataRestored, r.warnings.length], [true, true, 1]);
});

test('R2: the restore counts are passed through to the idle stop\'s slot', async () => {
  lend();
  setActive(20);
  w.answers.push(okAnswer({ app: 'stremio-ios', dataRestored: true, dataFilesRestored: 11, dataFilesFailed: 2, warnings: [{ code: 'DATA_RESTORE_PARTIAL_BACKUP', message: '2 of 13 data files were not backed up' }] }));
  const [out] = await logged(() => lab.down(['--idle']));
  assert.deepEqual([out.slot.dataRestored, out.slot.dataFilesRestored, out.slot.dataFilesFailed], [true, 11, 2]);
  assert.equal(out.slot.warnings[0].code, 'DATA_RESTORE_PARTIAL_BACKUP');
  assert.deepEqual(out.steps.find(s => s.step === 'slot').slot, out.slot);
  assert.ok(!JSON.stringify(out).includes(PU), 'no UDID in the output');
});

test('R2: a count that is not a count (a string, a negative, a fraction, an object) is not passed on', async () => {
  lend();
  w.answers.push(okAnswer({ dataFilesRestored: '11', dataFilesFailed: -1, dataFiles: 1.5, dataBackedUp: 'yes' }));
  const r = await returnSlot({});
  assert.equal(r.returned, true);
  assert.deepEqual([r.dataFilesRestored, r.dataFilesFailed, r.dataFiles, r.dataBackedUp], [undefined, undefined, undefined, undefined]);
  lend();
  w.answers.push(okAnswer({ dataFilesRestored: 0, dataFilesFailed: {} }));
  const z = await returnSlot({});
  assert.deepEqual([z.dataFilesRestored, z.dataFilesFailed], [0, undefined]);
});

test('R3: a locked phone: no uninstall, no sideload call, the record is kept, and the idle stop says so once', async () => {
  lend();
  w.locked = true;
  setActive(20);
  const [first, lines1] = await logged(() => lab.down(['--idle']));
  assert.equal(first.ok, undefined);
  assert.equal(first.slotReturned, false);
  assert.equal(first.slot.code, 'DEVICE_LOCKED');
  assert.equal(first.slot.needs, 'unlock');
  assert.ok(first.human.some(l => /phone is locked/.test(l)), 'said once');
  assert.equal(dev('device uninstall app').length, 0);
  assert.equal(sideloadCalls().length, 0);
  assert.equal(dev('device info apps').length, 0);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.match(lines1.join('\n'), /slot borrowed from sideload is not back yet \(DEVICE_LOCKED\)/);

  const [second, lines2] = await logged(() => lab.down(['--idle']));
  assert.equal(second.idle, true);
  assert.equal(second.slotReturned, false);
  assert.equal(second.human, undefined, 'not said again');
  assert.deepEqual(lines2, [], 'no new line in the idle log');
  assert.equal(readLend(loadState()).returnFailed.code, 'DEVICE_LOCKED');
  assert.equal(dev('device uninstall app').length, 0);

  w.locked = false; // unlocked at a later tick: it goes back
  const [third] = await logged(() => lab.down(['--idle']));
  assert.equal(third.slotReturned, true);
  assert.equal(loadState().slotLend, undefined);
});

// Every row of the return table, run through the real flow: [the answer, what the record and the report show].
const ROWS = [
  ['SLOT_PENDING (retryAfter)', failAnswer('SLOT_PENDING', { retryAfter: 120 }), { silent: true, needs: 'busy', retryAt: true }],
  ['OPERATION_IN_PROGRESS', failAnswer('OPERATION_IN_PROGRESS'), { silent: true, needs: 'busy' }],
  ['RETURN_FAILED / UNINSTALL_RESULT_UNCERTAIN', returnFailed('UNINSTALL_RESULT_UNCERTAIN', { uncertain: true }), { silent: true, needs: 'busy' }],
  ['SLOT_STATE_UNKNOWN', failAnswer('SLOT_STATE_UNKNOWN'), { silent: true, needs: 'busy' }],
  ['INTERRUPTED', failAnswer('INTERRUPTED'), { silent: true, needs: 'busy', retryAt: true }],
  ['RETURN_FAILED / DEVICE_LOCKED', returnFailed('DEVICE_LOCKED'), { needs: 'unlock', human: /locked/ }],
  ['RETURN_FAILED / DEVICE_NOT_CONNECTED (over Wi-Fi)', returnFailed('DEVICE_NOT_CONNECTED'), { needs: 'tunnel', human: /over Wi-Fi/ }],
  ['RETURN_FAILED / DEVICE_NOT_PAIRED', returnFailed('DEVICE_NOT_PAIRED'), { needs: 'trust', human: /Trust/ }],
  ['RETURN_FAILED / FREE_APP_LIMIT', returnFailed('FREE_APP_LIMIT'), { needs: 'slots', human: /another app took the slot/ }],
  ['RETURN_FAILED / PROFILE_EXPIRED', returnFailed('PROFILE_EXPIRED'), { needs: 'slots', noAutoRetry: true, human: /fix for RETURN_FAILED/ }],
  ['RETURN_FAILED / KEYCHAIN_LOCKED', returnFailed('KEYCHAIN_LOCKED'), { needs: 'slots', noAutoRetry: true }],
  ['RETURN_FAILED / FREE_IDENTITY_AMBIGUOUS', returnFailed('FREE_IDENTITY_AMBIGUOUS'), { needs: 'slots', noAutoRetry: true }],
  ['RETURN_FAILED / DEVICE_NOT_SAVED', returnFailed('DEVICE_NOT_SAVED'), { needs: 'slots', noAutoRetry: true }],
  ['RETURN_FAILED / a code nobody listed', returnFailed('BRAND_NEW_CODE'), { needs: 'slots', noAutoRetry: true }],
  ['RETURN_FAILED / UNINSTALL_FAILED', returnFailed('UNINSTALL_FAILED'), { needs: 'unknown', human: /try again/ }],
  ['RETURN_FAILED / RETURN_NOT_LANDED', returnFailed('RETURN_NOT_LANDED'), { needs: 'unknown' }],
  ['RETURN_FAILED / INSTALL_UNCONFIRMED', returnFailed('INSTALL_UNCONFIRMED'), { needs: 'unknown' }],
  ['a timeout', { code: 124 }, { silent: true, needs: 'busy', retryAt: true }],
  ['output that is not JSON', { stdout: 'oops' }, { silent: true, needs: 'busy', retryAt: true }],
];
for (const [name, answer, want] of ROWS) {
  test(`R4: ${name} keeps the record in returning, and reports as the table says`, async () => {
    lend();
    w.answers.push(answer);
    const r = await returnSlot({});
    const rec = readLend(loadState());
    assert.equal(r.returned, false);
    assert.equal(rec.phase, 'returning');
    assert.equal(r.needs, want.needs);
    assert.equal(r.fresh, !want.silent, 'silent ones say nothing');
    assert.equal(r.human.length > 0, !want.silent);
    if (want.human) assert.match(r.human.join('\n'), want.human);
    assert.equal(rec.returnFailed === undefined, want.silent === true);
    assert.equal(rec.returnFailed?.noAutoRetry === true, want.noAutoRetry === true);
    assert.equal(rec.retryAt !== undefined, want.retryAt === true);
    assert.equal(dev('device uninstall app').length, 1, 'the runner was taken off first');
  });
}

test('R4: DEVICE_NOT_CONNECTED is `cable` for a phone last reached over the cable; sideload\'s fix is the last line of an owner action', async () => {
  saveState({ phone: { ...PHONE, seen: { ...PHONE.seen, via: 'usbmux' } } });
  lend();
  w.answers.push(returnFailed('DEVICE_NOT_CONNECTED'));
  assert.equal((await returnSlot({})).needs, 'cable');
  w.apps.add(RUNNER);
  const signed = returnFailed('NOT_SIGNED');
  signed.errors[0].fix = 'Re-sign stremio-ios: sideload fetch --device x on 00008000-000A1B2C3D4E5F60';
  w.answers.push(signed);
  const r = await returnSlot({});
  assert.match(r.human.at(-1), /^sideload says: Re-sign stremio-ios/);
  assert.ok(!r.human.join('').includes(PU));
});

test('R4: the same failure is reported once; a different one is reported again', async () => {
  lend();
  w.answers.push(returnFailed('NOT_SIGNED'), returnFailed('NOT_SIGNED'), returnFailed('PROFILE_EXPIRED'));
  assert.equal((await returnSlot({})).fresh, true);
  w.apps.add(RUNNER);
  assert.equal((await returnSlot({})).fresh, false);
  w.apps.add(RUNNER);
  assert.equal((await returnSlot({})).fresh, true);
});

test('R5: phase returning with the runner already off the phone: no uninstall, the return is called', async () => {
  lend({ phase: 'returning' });
  w.apps.clear();
  w.answers.push(okAnswer());
  const r = await returnSlot({});
  assert.equal(r.returned, true);
  assert.equal(dev('device uninstall app').length, 0);
  assert.equal(sideloadCalls().length, 1);
  assert.equal(loadState().slotLend, undefined);
});

test('R5: the intent is written before the runner is uninstalled', async () => {
  lend({ phase: 'lent' });
  let seen;
  w.onUninstall = () => { seen = readLend(loadState()).phase; };
  w.answers.push(okAnswer());
  await returnSlot({});
  assert.equal(seen, 'returning');
});

test('R7: an uninstall that leaves the runner on the phone puts the phase back to lent, and sideload is not called', async () => {
  lend();
  w.uninstallKeeps = true;
  const r = await returnSlot({});
  assert.deepEqual([r.returned, r.code, r.phase], [false, 'UNINSTALL_FAILED', 'lent']);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(sideloadCalls().length, 0);
  assert.equal(r.fresh, true);
});

test('R7: an uninstall command that fails but whose listing then shows the runner gone goes on to the return', async () => {
  lend();
  w.uninstallFail = 'something odd';
  w.apps.clear();
  const r = await returnSlot({});
  assert.equal(r.returned, true);
});

test('an unreadable listing keeps `returning` and stops: no uninstall, no sideload call', async () => {
  lend();
  w.listFail = 'CoreDeviceError 4016 usage assertion requirements';
  const r = await returnSlot({});
  assert.deepEqual([r.returned, r.code, r.phase, r.needs], [false, 'DEVICE_NOT_CONNECTED', 'returning', 'tunnel']);
  assert.equal(dev('device uninstall app').length, 0);
  assert.equal(sideloadCalls().length, 0);
});

test('a phone that does not answer the lock check: nothing is uninstalled, the record keeps its phase', async () => {
  lend();
  w.lockFail = 'CoreDeviceError 4016 usage assertion requirements';
  const r = await returnSlot({});
  assert.deepEqual([r.returned, r.code, r.phase], [false, 'DEVICE_NOT_CONNECTED', 'lent']);
  assert.equal(dev('device uninstall app').length, 0);
  assert.equal(dev('device info apps').length, 0);
});

test('a lock check that fails with a long message ending in a known text is classified on the whole text (unlock, not the unreadable cut)', async () => {
  lend();
  w.lockFail = `${'CoreDeviceError detail. '.repeat(25)}The device is locked.`;
  const r = await returnSlot({});
  assert.deepEqual([r.returned, r.code, r.phase], [false, 'DEVICE_LOCKED', 'lent']);
  assert.equal(dev('device uninstall app').length, 0);
});

test('no sideload binary: found BEFORE anything is uninstalled; the owner is told to install it or set MSL_SIDELOAD_BIN', async () => {
  lend({ bin: path.join(fakeDir, 'gone') });
  const oldPath = process.env.PATH;
  process.env.PATH = tempDir();
  try {
    const r = await returnSlot({});
    assert.deepEqual([r.returned, r.code, r.needs], [false, 'NO_BINARY', 'slots']);
    assert.match(r.human.join('\n'), /Install sideload or set MSL_SIDELOAD_BIN/);
    assert.equal(readLend(loadState()).returnFailed.noAutoRetry, true);
  } finally { process.env.PATH = oldPath; }
  assert.equal(dev('device uninstall app').length, 0, 'the runner never left');
  assert.equal(dev('device info lockState').length, 0);
});

test('MSL_SIDELOAD_BIN wins over the record, and a wrong one stops the return before anything is uninstalled', async () => {
  lend();
  process.env.MSL_SIDELOAD_BIN = path.join(fakeDir, 'not-there');
  try {
    const r = await returnSlot({});
    assert.equal(r.code, 'NO_BINARY');
    assert.match(r.error, /MSL_SIDELOAD_BIN/);
    assert.equal(dev('device uninstall app').length, 0);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a record for another phone, or with no phone saved: no device call, and the person is told what to do by hand', async () => {
  lend({ udid: '00008000-000A1B2C3D4E5F61' });
  const other = await returnSlot({});
  assert.deepEqual([other.returned, other.code], [false, 'OTHER_PHONE']);
  assert.match(other.human.join('\n'), /sideload slot return --device <alias>/);
  assert.match(other.human.join('\n'), /lab phone slot forget/);
  saveState({ phone: null });
  const none = await returnSlot({});
  assert.equal(none.code, 'NO_PHONE');
  assert.equal(calls.length, 0, 'not one command');
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('R9: the lease taken over before the uninstall: nothing is uninstalled and sideload is not called', async () => {
  lend();
  setActive(20);
  w.onLock = () => asLeaseHolder('agent-b'); // `lab up --force` lands while the lock is being read
  const [out, lines] = await logged(() => lab.down(['--idle']));
  assert.equal(out.ok, false);
  assert.match(out.error, /someone took the lab over while the idle stop ran/);
  assert.equal(dev('device uninstall app').length, 0);
  assert.equal(sideloadCalls().length, 0);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(lease.read().owner, 'agent-b', 'its lease is not removed');
  assert.deepEqual(out.steps.map(s => s.step), ['session', 'wda', 'slot'], 'the steps after it did not run');
  assert.equal(lines.length, 1);
});

test('R9: the lease is renewed before the uninstall and before the return call, and while sideload works', async () => {
  lend();
  const seen = [];
  const touch = async () => { seen.push(calls.length); return true; };
  w.answers.push(okAnswer());
  await returnSlot({ idle: true, touch });
  assert.ok(seen.length >= 2);
  const uninstallAt = calls.findIndex(c => c[3] === 'uninstall');
  const sideloadAt = calls.findIndex(c => c[0] === bin);
  assert.ok(seen.some(n => n <= uninstallAt) && seen.some(n => n > uninstallAt && n <= sideloadAt));
  assert.equal(sideloadCalls()[0].o.onTick, touch);
});

test('R10: a slot that cannot go back is not a failed idle stop: it does not count toward the three failures', async () => {
  lend();
  w.answers.push(returnFailed('NOT_SIGNED'));
  setActive(20);
  const [out] = await logged(() => lab.down(['--idle']));
  assert.equal(out.ok, undefined);
  assert.equal(out.slot.returned, false);
  const rec = loadState().idleStop;
  assert.deepEqual([rec.ok, rec.failures], [true, 0]);
  assert.equal(rec.slot.code, 'RETURN_FAILED');
  assert.equal(rec.slot.cause, 'NOT_SIGNED');
  assert.equal(rec.steps.find(s => s.step === 'slot').did, null);
});

test('R11: sideload\'s retry time is respected, and an owner action waits for a lab command', async () => {
  lend({ retryAt: new Date(Date.now() + 300e3).toISOString() });
  setActive(20);
  assert.deepEqual(await lab.down(['--idle']), { idle: false, reason: 'nothing the lab started is running' });
  assert.equal(calls.filter(c => c[0] === 'xcrun' || c[0] === bin).length, 0);
  const hold = await returnSlot({ idle: true });
  assert.match(hold.skipped, /retry after/);
  assert.equal(calls.filter(c => c[0] === 'xcrun' || c[0] === bin).length, 0);
  const manual = await returnSlot({ manual: true });
  assert.equal(manual.returned, true, 'a person is not held back');
  assert.equal(loadState().slotLend, undefined);

  // An owner action: the idle stop does not look again until a lab command has run.
  world();
  const failedAt = new Date(Date.now() - 60e3).toISOString();
  lend({ returnFailed: { code: 'RETURN_FAILED', cause: 'KEYCHAIN_LOCKED', at: failedAt, human: ['unlock the keychain'], noAutoRetry: true } });
  setActive(20);
  assert.deepEqual(await lab.down(['--idle']), { idle: false, reason: 'nothing the lab started is running' });
  const s = await lab.status();
  assert.equal(s.slot.lend.returnFailed.noAutoRetry, true);
  assert.equal(s.idleStop.nextStop.earliest !== undefined, true);
});

test('R11: the idle stop tries again after a lab command, and gives the slot back', async () => {
  lend({ returnFailed: { code: 'RETURN_FAILED', cause: 'KEYCHAIN_LOCKED', at: new Date(Date.now() - 40 * 60e3).toISOString(), human: ['x'], noAutoRetry: true } });
  setActive(20); // the last lab command ran 20 min ago, after the failure 40 min ago
  const [out] = await logged(() => lab.down(['--idle']));
  assert.equal(out.idle, true);
  assert.equal(out.slotReturned, true);
});

test('a damaged record is reported once across two idle ticks, and a newly damaged one is reported again', async () => {
  saveState({ slotLend: { udid: 'x' } });
  const first = await returnSlot({ idle: true });
  assert.deepEqual([first.returned, first.fresh], [false, true]);
  assert.match(first.human[0], /lab phone slot forget/);
  assert.equal((await returnSlot({ idle: true })).fresh, false, 'not again at the next tick');
  saveState({ slotLend: { udid: 'y' } });
  assert.equal((await returnSlot({ idle: true })).fresh, true, 'a different damage is new');
  assert.equal(calls.length, 0);
  forgetLend();
  assert.equal(loadState().slotLendDamageReported, undefined);
});

test('R12: a device session in use: the runner is not touched, the idle stop and `lab down` skip it', async () => {
  lend();
  const r = await returnSlot({ sessionOpen: true });
  assert.deepEqual([r.returned, r.fresh], [false, false]);
  assert.match(r.skipped, /device session is open/);
  assert.equal(calls.length, 0);
  saveState({ session: 'S1', backend: 'appium', port: 4723, target: { device: PU } });
  await assert.rejects(lab.phone(['slot', 'return']), /a device session is open/);
  assert.equal(calls.filter(c => c[0] === 'xcrun' || c[0] === bin).length, 0);
});

test('R13: `lab phone slot return` gives it back now and prints one object; with nothing recorded it says so', async () => {
  assert.deepEqual(await lab.phone(['slot', 'return']), { pending: false, found: 'no borrowed slot recorded' });
  lend({ retryAt: new Date(Date.now() + 300e3).toISOString() });
  w.answers.push(okAnswer());
  const out = await lab.phone(['slot', 'return']);
  assert.equal(out.slotReturned, true);
  assert.deepEqual(out.slot, { returned: true, app: 'stremio-ios', reinstalled: true });
  assert.equal(loadState().slotLend, undefined);
  await assert.rejects(lab.phone(['slot']), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['slot', 'now']), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['slot', 'return', 'x']), /usage: lab phone setup/);
});

test('R13: `lab phone slot return` that cannot finish is ok:false with the steps; the record is kept', async () => {
  lend();
  w.locked = true;
  const out = await lab.phone(['slot', 'return']);
  assert.equal(out.ok, false);
  assert.equal(out.slotReturned, false);
  assert.equal(out.needs, 'unlock');
  assert.match(out.error, /was not given back/);
  assert.ok(out.human.length);
  assert.equal(readLend(loadState()).returnFailed.code, 'DEVICE_LOCKED');
});

test('R13: `lab phone slot return` and `forget` check the lease', async () => {
  lend();
  asLeaseHolder('agent-b');
  await assert.rejects(lab.phone(['slot', 'return']), /leased by "agent-b"/);
  await assert.rejects(lab.phone(['slot', 'forget']), /leased by "agent-b"/);
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('R13: `lab phone slot forget` drops the record and touches nothing', async () => {
  assert.deepEqual(await lab.phone(['slot', 'forget']), { forgot: false, found: 'no borrowed slot recorded' });
  lend();
  const out = await lab.phone(['slot', 'forget']);
  assert.equal(out.forgot, true);
  assert.match(out.human[0], /sideload slot return --device <alias>/);
  assert.equal(loadState().slotLend, undefined);
  saveState({ slotLend: 'junk' }); // a damaged record can be dropped too
  assert.equal((await lab.phone(['slot', 'forget'])).forgot, true);
  assert.equal(calls.length, 0);
});

test('R13: `lab phone forget` and `setup` for another phone are refused while a slot is borrowed, with the way out', async () => {
  lend();
  await assert.rejects(lab.phone(['forget']), /lab phone slot return.*lab phone slot forget/s);
  assert.equal(loadState().phone.udid, PU, 'the phone is still saved');
  await assert.rejects(lab.phone(['setup', '--udid', '00008000-000A1B2C3D4E5F61', '--team', 'ABCDE12345']), /slot borrowed from sideload.*lab phone slot return/s);
  saveState({ slotLend: 'junk' });
  await assert.rejects(lab.phone(['forget']), /lab phone slot forget/);
  await lab.phone(['slot', 'forget']);
  assert.equal((await lab.phone(['forget'])).forgot, true);
});

test('R13: the restore counts reach the `slot` of `lab phone slot return` and of a plain `lab down`', async () => {
  const counts = { dataRestored: true, dataFilesRestored: 11, dataFilesFailed: 2 };
  lend();
  w.answers.push(okAnswer(counts));
  const manual = await lab.phone(['slot', 'return']);
  assert.deepEqual([manual.slot.dataRestored, manual.slot.dataFilesRestored, manual.slot.dataFilesFailed], [true, 11, 2]);
  lend(); // no idle stop installed, so `lab down` gives it back itself
  w.answers.push(okAnswer(counts));
  const down = await lab.down([]);
  assert.equal(down.ok, undefined, down.error);
  assert.equal(down.slotReturned, true);
  assert.deepEqual([down.slot.dataRestored, down.slot.dataFilesRestored, down.slot.dataFilesFailed], [true, 11, 2]);
  assert.deepEqual(down.steps.find(s => s.step === 'slot').slot, down.slot);
});

test('R8: `lab down` leaves a lent slot to the idle stop when it is installed and loaded; returns it when it is not, or the return had started', async () => {
  const armed = () => { fs.mkdirSync(svc.agentsDir(), { recursive: true }); fs.writeFileSync(svc.idlePlistPath(), '<plist/>'); };
  armed();
  lend();
  let out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.ok(!out.steps.some(s => s.step === 'slot'));
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(sideloadCalls().length, 0);
  assert.equal(dev('device uninstall app').length, 0);

  lend({ phase: 'returning' });
  w.answers.push(okAnswer());
  out = await lab.down([]);
  assert.equal(out.steps.find(s => s.step === 'slot').did.startsWith('gave it back'), true);
  assert.equal(out.slotReturned, true);
  assert.equal(loadState().slotLend, undefined);

  fs.rmSync(svc.idlePlistPath());
  world();
  lend();
  w.answers.push(okAnswer());
  out = await lab.down([]);
  assert.deepEqual(out.steps.map(s => s.step).slice(0, 3), ['lease', 'session', 'wda'].slice(0, 3));
  assert.equal(out.steps.find(s => s.step === 'slot').did.startsWith('gave it back'), true);
  assert.equal(loadState().slotLend, undefined);
});

test('R8: `lab down` reports a slot that cannot go back, in `human` and `slotReturned: false`, and still releases the lease', async () => {
  lend();
  w.locked = true;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.slotReturned, false);
  assert.ok(out.human.some(l => /phone is locked/.test(l)));
  assert.equal(out.steps.at(-1).step, 'release');
  assert.equal(lease.read(), null);
});

test('the slot step runs after the WebDriverAgent step', async () => {
  lend();
  const out = await lab.down([]);
  const names = out.steps.map(s => s.step);
  assert.equal(names[names.indexOf('wda') + 1], 'slot');
});

test('R14: `lab status` shows the slot block: the binary, the record without the UDID, sideload\'s own status; no device call', async () => {
  const empty = await lab.status();
  assert.equal(empty.slot.lend, null);
  assert.equal(empty.slot.sideload, undefined);
  assert.equal(typeof empty.slot.bin.ok, 'boolean');
  lend({ returnFailed: { code: 'RETURN_FAILED', cause: 'NOT_SIGNED', at: now(), human: ['re-sign it'], noAutoRetry: true }, retryAt: new Date(Date.now() + 60e3).toISOString() });
  calls = fakeRunner((cmd, args) => (cmd === bin && args[0] === 'status' ? say({ ok: true, lent: [{ app: 'stremio-ios', to: 'lab' }, { app: 'other', to: 'someone' }] }) : undefined));
  const s = await lab.status();
  assert.equal(s.slot.bin.ok, true);
  assert.deepEqual([s.slot.bin.path, s.slot.bin.from], [bin, 'record']);
  assert.deepEqual([s.slot.lend.phase, s.slot.lend.app], ['lent', 'stremio-ios']);
  assert.equal(s.slot.lend.returnFailed.noAutoRetry, true);
  assert.ok(s.slot.lend.retryAt);
  assert.deepEqual(s.slot.sideload, { ok: true, lentToLab: [{ app: 'stremio-ios' }] });
  assert.match(s.slot.human[0], /borrowed stremio-ios's slot from sideload/);
  assert.ok(!JSON.stringify(s.slot).includes(PU));
  assert.ok(!calls.some(c => c[0] === 'xcrun' && c[1] === 'devicectl'), 'status asks nothing of the phone');
  assert.deepEqual(calls.filter(c => c[0] === bin), [[bin, 'status']]);
  assert.deepEqual(calls.opts[calls.findIndex(c => c[0] === bin)].env, { SIDELOAD_HOME: home });
});

test('R14: `lab status` with no binary and with a damaged record', async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = tempDir();
  try {
    let s = await lab.status();
    assert.equal(s.slot.bin.ok, false);
    assert.match(s.slot.bin.error, /not found on PATH/);
    saveState({ slotLend: { udid: 'x' } });
    s = await lab.status();
    assert.equal(s.slot.lend.damaged, true);
    assert.match(s.slot.lend.error, /lab phone slot forget/);
    assert.match(s.slot.human[0], /lab phone slot forget/);
    lend();
    s = await lab.status();
    assert.equal(s.slot.bin.from, 'record', 'the record\'s binary is used when PATH has none');
    delete process.env.MSL_SIDELOAD_BIN;
    putLend(record({ bin: path.join(fakeDir, 'gone') }));
    s = await lab.status();
    assert.equal(s.slot.bin.ok, false);
    assert.deepEqual(s.slot.sideload, { ok: false, error: s.slot.bin.error });
  } finally { process.env.PATH = oldPath; }
});

test('sideloadStatus is display only: a timeout, no answer and an answer without a list are each a plain result', () => {
  world();
  calls = fakeRunner(() => ({ code: 124 }));
  assert.match(sideloadStatus({ bin, home }).error, /did not answer within/);
  calls = fakeRunner(() => ({ stdout: 'text' }));
  assert.match(sideloadStatus({ bin, home }).error, /no answer the lab can read/);
  calls = fakeRunner(() => say({ ok: true }));
  assert.deepEqual(sideloadStatus({ bin, home }), { ok: true, lentToLab: null });
  assert.equal(sideloadStatus({ bin: 'sideload', home }).ok, false);
});

test('forgetLend drops a record without any command', () => {
  lend();
  assert.deepEqual(forgetLend(), { forgot: true, app: 'stremio-ios' });
  assert.deepEqual(forgetLend(), { forgot: false });
  assert.equal(calls.length, 0);
});

test('runAsync passes killAfterMs through the recorded runner and the real one accepts it', async () => {
  setAsyncRunner(null);
  const r = await runAsync(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 5000, killAfterMs: 50 });
  assert.deepEqual([r.code, r.stdout], [0, 'hi']);
});

// --- the lend step (`lab up`'s slot step): ensureWdaSlot, probeInstall (#63, PR 2) ---

const OTHER_PHONE = '00008000-000A1B2C3D4E5F61';
// The step with the fake sideload as the binary (unless a test sets MSL_SIDELOAD_BIN itself).
async function ensure(extra = {}) {
  const was = process.env.MSL_SIDELOAD_BIN;
  if (was === undefined) process.env.MSL_SIDELOAD_BIN = bin;
  try { return await ensureWdaSlot({ phone: PHONE, osVersion: '27.0.1', via: 'tunnel', touch: async () => true, ...extra }); } finally { if (was === undefined) delete process.env.MSL_SIDELOAD_BIN; }
}
const lendAnswer = (extra = {}) => ({ ok: true, command: 'slot', action: 'lend', freed: 1, app: 'stremio-ios', device: 'iPhone', ...extra });
const installs = () => dev('device install app');
const sideloads = () => sideloadCalls().map(x => x.c.slice(1));
const rejection = async p => { try { await p; } catch (e) { return e; } return assert.fail('expected a rejection'); };
// The order of the commands that change anything: build, install, sideload.
const order = () => calls.map(c => (c[0] === 'xcodebuild' ? 'build' : c[0] === bin ? `sideload ${c[2]}` : c[0] === 'xcrun' && c.slice(3, 5).join(' ') === 'install app' ? 'install' : null)).filter(Boolean);
const needPerl = { skip: !havePerl && '/usr/bin/perl is not here' };
const gone = () => assert.equal(loadState().slotLend, undefined, 'no record');

test('L1: WebDriverAgent already on the phone: one listing for its bundle id, no install, no sideload call, no record', async () => {
  const r = await ensure();
  assert.equal(r.found, 'WebDriverAgent installed');
  assert.equal(r.did, null);
  assert.equal(r.summary, undefined);
  assert.deepEqual(dev('device info apps'), [['xcrun', 'devicectl', 'device', 'info', 'apps', '--device', PU, '--bundle-id', RUNNER]]);
  assert.deepEqual(order(), []);
  gone();
});

test('L1: a held lend with WebDriverAgent installed is reused: nothing is returned, installed or asked of sideload', async () => {
  lend();
  const r = await ensure();
  assert.equal(r.found, 'WebDriverAgent installed');
  assert.deepEqual(order(), []);
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('L2: missing and installd accepts it: installed under the signing lock, nothing borrowed, no sideload call', needPerl, async () => {
  world({ apps: new Set(), installs: ['ok'] });
  const held = [];
  w.onInstall = () => held.push(!lockIsFree(home));
  const r = await ensure();
  assert.equal(r.found, 'WebDriverAgent missing');
  assert.match(r.did, /it fit; nothing borrowed/);
  assert.equal(r.summary, undefined);
  assert.deepEqual(held, [true], 'the lock is held while installd installs');
  assert.deepEqual(installs(), [['xcrun', 'devicectl', 'device', 'install', 'app', '--device', PU, BUILT()]]);
  assert.deepEqual(order(), ['install']);
  assert.equal(lockIsFree(home), true, 'and let go afterwards');
  gone();
});

test('L3: installd refuses with its app limit: `slot lend --udid <saved> --to lab` (never --device), the record says lent, a second install, the summary', async () => {
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push(lendAnswer());
  let atCall;
  w.onSideload = () => { atCall = readLend(loadState()); };
  const r = await ensure();
  assert.deepEqual(sideloads(), [['slot', 'lend', '--udid', PU, '--to', 'lab']]);
  assert.ok(!sideloadCalls()[0].c.includes('--device'));
  assert.equal(sideloadCalls()[0].o.env.SIDELOAD_HOME, home);
  assert.deepEqual([atCall.phase, atCall.udid, atCall.bin, atCall.home], ['lending', PU, bin, home], 'the intent is on disk before sideload is called');
  const rec = readLend(loadState());
  assert.deepEqual([rec.phase, rec.app, rec.device, rec.bin, rec.home], ['lent', 'stremio-ios', 'iPhone', bin, home]);
  assert.deepEqual(order(), ['install', 'sideload lend', 'install']);
  assert.ok(w.apps.has(RUNNER));
  assert.equal(r.found, 'WebDriverAgent missing, no free slot');
  assert.match(r.did, /borrowed stremio-ios's slot from sideload and installed it/);
  assert.deepEqual(r.summary, { lent: 'stremio-ios', freed: 1 });
  assert.deepEqual(r.report, { slot: r.summary });
  assert.ok(!JSON.stringify(r).includes(PU));
});

test('L4: sideload says the slot is already lent (alreadyLent): the record becomes lent and WebDriverAgent goes in', async () => {
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push({ ok: true, command: 'slot', action: 'lend', alreadyLent: true, app: 'stremio-ios' });
  const r = await ensure();
  assert.deepEqual(r.summary, { lent: 'stremio-ios', alreadyLent: true });
  assert.match(r.did, /already borrowed/);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(installs().length, 2);
});

test('L4: an ok answer that frees nothing and lends nothing is not trusted: no second install, the record of the attempt stays', async () => {
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push({ ok: true, command: 'slot', action: 'lend' });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'unknown');
  assert.equal(installs().length, 1);
  assert.equal(readLend(loadState()).phase, 'lending');
});

// Every row of the lend table (plan section 4 with the addendum's code classes): the `needs`, and what becomes of the record the lab wrote.
const LEND_ROWS = [
  ['SLOT_PENDING', failAnswer('SLOT_PENDING', { retryAfter: 120 }), 'busy', 'keep'],
  ['OPERATION_IN_PROGRESS', failAnswer('OPERATION_IN_PROGRESS'), 'busy', 'drop'],
  ['UNINSTALL_RESULT_UNCERTAIN', failAnswer('UNINSTALL_RESULT_UNCERTAIN', { uncertain: true, retryAfter: 60 }), 'busy', 'keep'],
  ['INSTALL_RESULT_UNCERTAIN', failAnswer('INSTALL_RESULT_UNCERTAIN', { uncertain: true }), 'busy', 'keep'],
  ['SLOT_STATE_UNKNOWN', failAnswer('SLOT_STATE_UNKNOWN'), 'busy', 'keep'],
  ['INTERRUPTED', failAnswer('INTERRUPTED'), 'busy', 'keep'],
  ['SNAPSHOT_FAILED', failAnswer('SNAPSHOT_FAILED'), 'busy', 'keep'],
  ['TIMEOUT', failAnswer('TIMEOUT'), 'busy', 'keep'],
  ['NO_LENDABLE_APP', failAnswer('NO_LENDABLE_APP'), 'slots', 'drop'],
  ['ALREADY_LENT', failAnswer('ALREADY_LENT'), 'slots', 'drop'],
  ['LENDABLE_NOT_INSTALLED', failAnswer('LENDABLE_NOT_INSTALLED'), 'slots', 'drop'],
  ['NOT_SIGNED', failAnswer('NOT_SIGNED'), 'slots', 'drop'],
  ['PROFILE_EXPIRED', failAnswer('PROFILE_EXPIRED'), 'slots', 'drop'],
  ['KEYCHAIN_LOCKED', failAnswer('KEYCHAIN_LOCKED'), 'slots', 'drop'],
  ['FREE_IDENTITY_MISSING', failAnswer('FREE_IDENTITY_MISSING'), 'slots', 'drop'],
  ['DEVICE_NOT_SAVED', failAnswer('DEVICE_NOT_SAVED'), 'slots', 'drop'],
  ['DEVICE_LOCKED', failAnswer('DEVICE_LOCKED'), 'unlock', 'drop'],
  ['DEVICE_NOT_CONNECTED', failAnswer('DEVICE_NOT_CONNECTED'), 'tunnel', 'drop'],
  ['DEVICE_NOT_PAIRED', failAnswer('DEVICE_NOT_PAIRED'), 'trust', 'drop'],
  ['UNINSTALL_FAILED', failAnswer('UNINSTALL_FAILED'), 'unknown', 'drop'],
  ['UNEXPECTED_APP_DELTA (state lent)', failAnswer('UNEXPECTED_APP_DELTA', { state: 'lent' }), 'unknown', 'lent'],
  ['UNEXPECTED_APP_DELTA', failAnswer('UNEXPECTED_APP_DELTA'), 'unknown', 'keep'],
  ['a code nobody listed', failAnswer('SOMETHING_NEW'), 'slots', 'drop'],
  ['a timeout of the lab\'s own', { code: 124 }, 'busy', 'keep'],
  ['output the lab cannot read', { stdout: 'sideload: oops\n' }, 'busy', 'keep'],
];

test('L5: every lend answer: the `needs`, sideload\'s fix as the last line of an owner action, and what becomes of the record', async () => {
  for (const [name, answer, needs, record] of LEND_ROWS) {
    world({ apps: new Set(), installs: ['limit', 'ok'] });
    saveState({ slotLend: null });
    w.answers.push(answer);
    const e = await rejection(ensure());
    assert.equal(e.extra.needs, needs, name);
    assert.equal(installs().length, 1, `${name}: WebDriverAgent is not installed after a failed lend`);
    assert.equal(sideloads().length, 1, name);
    const rec = loadState().slotLend;
    if (record === 'drop') assert.equal(rec, undefined, `${name}: the intent is dropped`);
    else assert.equal(rec.phase, record === 'lent' ? 'lent' : 'lending', name);
    if (needs === 'slots' && answer.errors) assert.match(e.extra.human.at(-1), /^fix for /, `${name}: sideload's fix is last`);
    if (needs === 'busy' && record === 'keep') assert.match(e.extra.human.join(' '), /does not know for sure|retry after/, name);
  }
});

test('L5: a retryAfter becomes retryAt on the record and in the failure; an unknown outcome without one waits sideload\'s longest window', async () => {
  world({ apps: new Set(), installs: ['limit'] });
  w.answers.push(failAnswer('SLOT_PENDING', { retryAfter: 120 }));
  const t0 = Date.now();
  const e = await rejection(ensure());
  const at = Date.parse(e.extra.retryAt);
  assert.ok(at >= t0 + 119e3 && at <= Date.now() + 121e3);
  assert.equal(readLend(loadState()).retryAt, e.extra.retryAt);
  world({ apps: new Set(), installs: ['limit'] });
  saveState({ slotLend: null });
  w.answers.push({ code: 124 });
  const timedOut = await rejection(ensure());
  assert.ok(Date.parse(timedOut.extra.retryAt) >= Date.now() + UNKNOWN_RETRY_MS - 5e3);
});

test('L5: a record that was already there is not dropped by a definite refusal (only the intent this run wrote is)', async () => {
  lend({ phase: 'returning' });
  world({ apps: new Set(), installs: ['limit'] });
  w.answers.push(failAnswer('OPERATION_IN_PROGRESS'));
  await rejection(ensure());
  assert.equal(readLend(loadState()).phase, 'returning');
});

test('L5: no lend with the sideload binary missing or wrong: needs slots with the way to fix it, and nothing is written or asked', async () => {
  world({ apps: new Set(), installs: ['limit'] });
  process.env.MSL_SIDELOAD_BIN = path.join(fakeDir, 'nope');
  try {
    const e = await rejection(ensure());
    assert.equal(e.extra.needs, 'slots');
    assert.match(e.message, /MSL_SIDELOAD_BIN/);
    assert.match(e.extra.human.join(' '), /install it or set MSL_SIDELOAD_BIN/);
    assert.deepEqual(order(), ['install']);
    gone();
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('L6: the signing lock is held for each install and never across the sideload call', needPerl, async () => {
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  const events = [];
  w.onInstall = () => events.push(['install', !lockIsFree(home)]);
  w.onSideload = () => events.push(['sideload', !lockIsFree(home)]);
  w.answers.push(lendAnswer());
  await ensure();
  assert.deepEqual(events, [['install', true], ['sideload', false], ['install', true]]);
  assert.equal(lockIsFree(home), true);
});

test('L6: sideload holds the lock: needs busy, no build, no install, no sideload call, no record', needPerl, async () => {
  world({ apps: new Set(), installs: ['ok'], noBuild: true });
  const other = await holdLock(home);
  try {
    const e = await rejection(ensure());
    assert.equal(e.extra.needs, 'busy');
    assert.deepEqual(order(), []);
    gone();
  } finally { await other.release(); }
});

test('L6: the lock is let go when the install itself fails', needPerl, async () => {
  world({ apps: new Set(), installs: [{ code: 1, stderr: 'The device is locked.' }] });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'unlock');
  assert.equal(lockIsFree(home), true);
  assert.deepEqual(order(), ['install']);
});

test('L7: the App-ID-per-week limit is `slots` but never a reason to lend', async () => {
  world({ apps: new Set(), installs: ['appids'] });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'slots');
  assert.deepEqual(e.extra.human, phone.NEEDS.slots.human, 'the generic steps');
  assert.deepEqual(order(), ['install']);
  gone();
});

test('L7: a refusal whose text names the app limit and App IDs is the weekly limit: no `slot lend`, no record', async () => {
  const both = { code: 1, stderr: 'ApplicationVerificationFailed: This device has reached the maximum number of installed apps using a free developer profile (App ID limit reached for this week).' };
  world({ apps: new Set(), installs: [both] });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'slots');
  assert.deepEqual(e.extra.human, phone.NEEDS.slots.human, 'the generic steps, not the lending ones');
  assert.deepEqual(sideloads(), []);
  assert.deepEqual(order(), ['install']);
  gone();
});

test('L7: any other install failure is its own `needs`, with no lend', async () => {
  world({ apps: new Set(), installs: [{ code: 1, stderr: 'a profile has expired: 0xe8008018' }] });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'resign');
  assert.deepEqual(order(), ['install']);
  gone();
});

test('L8: a listing the lab cannot read lends nothing and lets the session go on', async () => {
  for (const reply of [{ code: 1, stderr: 'devicectl: boom' }, { code: 124 }]) {
    world({ apps: new Set() });
    calls = fakeRunner((cmd, args) => (cmd === 'xcrun' && args.includes('apps') ? reply : undefined));
    const r = await ensure();
    assert.match(r.found, /^WebDriverAgent: could not list the phone's apps \(.+\); no slot lending$/);
    assert.deepEqual(r.report, { slot: { checked: false } });
    assert.equal(r.summary, undefined);
    assert.deepEqual(calls.filter(c => c[0] !== 'xcrun'), []);
    assert.equal(installs().length, 0);
  }
});

test('L9: no build yet: the runner is built under the lock, with the saved team and bundle id, before the install', needPerl, async () => {
  world({ apps: new Set(), installs: ['ok'], noBuild: true });
  const held = [];
  w.onBuild = () => held.push(!lockIsFree(home));
  const r = await ensure();
  assert.deepEqual(held, [true]);
  assert.deepEqual(order(), ['build', 'install']);
  const args = calls.find(c => c[0] === 'xcodebuild');
  assert.equal(args[1], 'build-for-testing');
  assert.ok(args.includes(`id=${PU}`) && args.includes('DEVELOPMENT_TEAM=ABCDE12345') && args.includes(`PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE}`));
  assert.ok(args.includes('IPHONEOS_DEPLOYMENT_TARGET=27.0'));
  assert.match(r.did, /it fit/);
});

test('L9: a build that fails stops the step with the build\'s own `needs`; nothing is installed, borrowed or recorded', async () => {
  world({ apps: new Set(), installs: ['ok'], noBuild: true, buildFails: true });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'unknown');
  assert.match(e.message, /xcodebuild build-for-testing failed/);
  assert.deepEqual(order(), ['build']);
  gone();
});

test('L10: a build whose bundle id is not the saved phone\'s runner id is refused, whatever it says', async () => {
  for (const id of ['com.example.other.xctrunner', null]) {
    world({ apps: new Set(), installs: ['limit', 'ok'], plutil: id });
    const e = await rejection(ensure());
    assert.equal(e.extra.needs, 'resign', String(id));
    assert.match(e.message, /did not install it/);
    assert.deepEqual(order(), []);
    gone();
  }
  world({ apps: new Set(), installs: ['ok'] });
  await ensure();
  assert.deepEqual(calls.find(c => c[0] === 'plutil'), ['plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(BUILT(), 'Info.plist')]);
});

test('L11: DEVICE_NOT_CONNECTED is `tunnel` for a phone reached over Wi-Fi and `cable` over usbmux', async () => {
  for (const [via, needs] of [['tunnel', 'tunnel'], ['usbmux', 'cable']]) {
    world({ apps: new Set(), installs: ['limit'] });
    saveState({ slotLend: null });
    w.answers.push(failAnswer('DEVICE_NOT_CONNECTED'));
    const e = await rejection(ensure({ via }));
    assert.equal(e.extra.needs, needs, via);
    gone();
  }
});

test('L13: dataRestored and warnings are passed through to the summary, never depended on', async () => {
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push(lendAnswer({ dataRestored: { stremio: 'backed up' }, warnings: [{ code: 'LAST_FREE_APP_REMOVED', message: 'that was the last free app' }] }));
  const r = await ensure();
  assert.deepEqual(r.summary.dataRestored, { stremio: 'backed up' });
  assert.equal(r.summary.warnings[0].code, 'LAST_FREE_APP_REMOVED');
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  saveState({ slotLend: null });
  w.answers.push(lendAnswer());
  assert.deepEqual((await ensure()).summary, { lent: 'stremio-ios', freed: 1 });
});

test('L13: the backup counts are passed through to the summary, and a count of the wrong type is not', async () => {
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push(lendAnswer({ dataBackedUp: false, dataFiles: 11, dataFilesFailed: 2, warnings: [{ code: 'DATA_BACKUP_INCOMPLETE', message: '2 of 13 data files were not backed up' }] }));
  const r = await ensure();
  assert.deepEqual(r.summary, { lent: 'stremio-ios', freed: 1, dataBackedUp: false, dataFiles: 11, dataFilesFailed: 2, warnings: r.summary.warnings });
  assert.equal(r.summary.warnings[0].code, 'DATA_BACKUP_INCOMPLETE');
  assert.deepEqual(r.report.slot, r.summary);
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  saveState({ slotLend: null });
  w.answers.push(lendAnswer({ dataBackedUp: 'true', dataFiles: '11', dataFilesFailed: null }));
  assert.deepEqual((await ensure()).summary, { lent: 'stremio-ios', freed: 1 });
});

test('L13: the restore counts of a settling return are passed through to the summary', async () => {
  lend({ phase: 'returning' });
  w.answers.push(okAnswer({ dataRestored: true, dataFilesRestored: 12, dataFilesFailed: 0 }));
  const r = await ensure();
  assert.deepEqual(r.summary, { returned: true, app: 'stremio-ios', reinstalled: true, dataRestored: true, dataFilesRestored: 12, dataFilesFailed: 0 });
  gone();
});

test('L14: a record for another phone: refused before the phone is asked, with the way out', async () => {
  lend({ udid: OTHER_PHONE });
  calls.length = 0;
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'slots');
  assert.match(e.extra.human.join(' '), /sideload slot return --device <alias>.*lab phone slot forget/s);
  assert.equal(calls.length, 0);
  assert.equal(readLend(loadState()).udid, OTHER_PHONE);
});

test('a damaged record: WebDriverAgent installed carries on with the message; WebDriverAgent missing stops before anything is installed', async () => {
  saveState({ slotLend: 'junk' });
  const ok = await ensure();
  assert.equal(ok.found, 'WebDriverAgent installed');
  assert.match(ok.human[0], /lab phone slot forget/);
  world({ apps: new Set(), installs: ['limit'] });
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'slots');
  assert.match(e.message, /lab phone slot forget/);
  assert.deepEqual(order(), []);
  assert.equal(loadState().slotLend, 'junk', 'the damaged record is left as it was');
});

test('a damaged record is reported even when the listing is unreadable; nothing is lent on that listing', async () => {
  saveState({ slotLend: 'junk' });
  world({ apps: new Set() });
  calls = fakeRunner((cmd, args) => (cmd === 'xcrun' && args.includes('apps') ? { code: 1, stderr: 'devicectl: boom' } : undefined));
  const r = await ensure();
  assert.match(r.found, /could not list the phone's apps/);
  assert.deepEqual(r.report, { slot: { checked: false } });
  assert.match(r.human[0], /lab phone slot forget/);
  assert.deepEqual(calls.filter(c => c[0] !== 'xcrun'), []);
  assert.equal(dev('device install app').length, 0);
});

// --- the crash matrix (plan section 3): a record left by a crash, then the next `lab up` ---

test('C1: killed after `lending` was written, before or during `slot lend`: WebDriverAgent missing and no room -> `slot lend` again (alreadyLent / fresh)', async () => {
  lend({ phase: 'lending', since: undefined, app: undefined });
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push(lendAnswer());
  const r = await ensure();
  assert.deepEqual(order(), ['install', 'sideload lend', 'install']);
  assert.equal(r.summary.lent, 'stremio-ios');
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('a lend that succeeds drops a stale return failure from the record, and so does a settle into `lent`', async () => {
  const failure = { code: 'RETURN_FAILED', cause: 'DEVICE_LOCKED', at: '2026-10-24T12:00:00.000Z', human: ['old return failure steps'], noAutoRetry: true };
  lend({ phase: 'returning', returnFailed: failure });
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push(lendAnswer());
  await ensure();
  let rec = readLend(loadState());
  assert.equal(rec.phase, 'lent');
  assert.equal(rec.returnFailed, undefined);

  lend({ phase: 'returning', returnFailed: failure });
  world();
  w.answers.push(returnFailed('FREE_APP_LIMIT'));
  await ensure();
  rec = readLend(loadState());
  assert.equal(rec.phase, 'lent');
  assert.equal(rec.returnFailed, undefined);
});

test('C1: ...and if the lend is still pending at sideload: busy until its window ends, the record keeps `lending`', async () => {
  lend({ phase: 'lending' });
  world({ apps: new Set(), installs: ['limit'] });
  w.answers.push(failAnswer('SLOT_PENDING', { retryAfter: 90 }));
  const e = await rejection(ensure());
  assert.equal(e.extra.needs, 'busy');
  const rec = readLend(loadState());
  assert.deepEqual([rec.phase, rec.retryAt], ['lending', e.extra.retryAt]);
});

test('C1: ...and if it fits after all (Stremio is already gone): installed, then `slot return` settles the record into `lent`', async () => {
  lend({ phase: 'lending' });
  world({ apps: new Set(), installs: ['ok'] });
  w.answers.push(returnFailed('FREE_APP_LIMIT'));
  const r = await ensure();
  assert.deepEqual(order(), ['install', 'sideload return']);
  assert.deepEqual(sideloads(), [['slot', 'return', '--udid', PU]]);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(dev('device uninstall app').length, 0, 'nothing is taken off the phone');
  assert.deepEqual(r.summary, { lent: 'stremio-ios', held: true });
  assert.match(r.did, /it fit; nothing borrowed.*kept the borrowed slot/);
});

test('C2: killed after the lend answered, before `lent` was written: the same record, and sideload\'s alreadyLent finishes it', async () => {
  lend({ phase: 'lending' });
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push({ ok: true, command: 'slot', action: 'lend', alreadyLent: true, app: 'stremio-ios' });
  const r = await ensure();
  assert.deepEqual(r.summary, { lent: 'stremio-ios', alreadyLent: true });
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('C3: killed after `lent`, before WebDriverAgent was installed: the install fits in the held slot, sideload is not called', async () => {
  lend({ phase: 'lent' });
  world({ apps: new Set(), installs: ['ok'] });
  const r = await ensure();
  assert.deepEqual(order(), ['install']);
  assert.match(r.did, /it fit/);
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('C4: the lab\'s own timeout of `slot lend`: the record keeps `lending`; the next call answers SLOT_PENDING and waits', async () => {
  world({ apps: new Set(), installs: ['limit', 'limit'] });
  w.answers.push({ code: 124 });
  const first = await rejection(ensure());
  assert.equal(first.extra.needs, 'busy');
  assert.equal(readLend(loadState()).phase, 'lending');
  w.answers.push(failAnswer('SLOT_PENDING', { retryAfter: 200 }));
  const second = await rejection(ensure());
  assert.equal(second.extra.needs, 'busy');
  assert.ok(Date.parse(second.extra.retryAt) < Date.parse(first.extra.retryAt), 'sideload\'s own time replaces the lab\'s guess');
  assert.equal(readLend(loadState()).phase, 'lending');
});

test('C5: killed after `returning` was written, WebDriverAgent still on the phone: `slot return` says FREE_APP_LIMIT and the lend is reused as `lent`', async () => {
  lend({ phase: 'returning' });
  w.answers.push(returnFailed('FREE_APP_LIMIT'));
  const r = await ensure();
  assert.deepEqual(order(), ['sideload return']);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(dev('device uninstall app').length, 0);
  assert.equal(r.found, 'WebDriverAgent installed');
  assert.deepEqual(r.summary, { lent: 'stremio-ios', held: true });
});

test('C5: ...if there is room after all (`reinstalled`), the record is cleared and both apps are on the phone', async () => {
  lend({ phase: 'returning' });
  w.answers.push(okAnswer());
  const r = await ensure();
  gone();
  assert.deepEqual(r.summary, { returned: true, app: 'stremio-ios', reinstalled: true });
  assert.equal(r.report.slot, r.summary);
});

test('C5: ...a busy sideload leaves the record as it is (with its retry time) and `up` goes on; a missing binary only says so', async () => {
  lend({ phase: 'returning' });
  w.answers.push(failAnswer('SLOT_PENDING', { retryAfter: 60 }));
  const r = await ensure();
  assert.equal(r.found, 'WebDriverAgent installed');
  assert.match(r.human[0], /could not settle.*SLOT_PENDING/s);
  const rec = readLend(loadState());
  assert.equal(rec.phase, 'returning');
  assert.ok(rec.retryAt);
  const before = sideloadCalls().length; // the retry time holds a second settle back: no sideload call
  const again = await ensure();
  assert.equal(sideloadCalls().length, before);
  assert.deepEqual(again.human ?? [], []);

  lend({ phase: 'returning' });
  process.env.MSL_SIDELOAD_BIN = path.join(fakeDir, 'nope');
  try {
    const noBin = await ensure();
    assert.match(noBin.human[0], /MSL_SIDELOAD_BIN/);
    assert.equal(readLend(loadState()).phase, 'returning');
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('C6: killed between the WebDriverAgent uninstall and `slot return`: the install fits, the settle makes it `lent` again', async () => {
  lend({ phase: 'returning' });
  world({ apps: new Set(), installs: ['ok'] });
  w.answers.push(returnFailed('FREE_APP_LIMIT'));
  await ensure();
  assert.deepEqual(order(), ['install', 'sideload return']);
  assert.equal(readLend(loadState()).phase, 'lent');
});

test('C7: killed after `slot return` worked, before the record was cleared: Stremio is back, so there is no room: a fresh lend', async () => {
  lend({ phase: 'returning' });
  world({ apps: new Set(), installs: ['limit', 'ok'] });
  w.answers.push(lendAnswer());
  const r = await ensure();
  assert.deepEqual(order(), ['install', 'sideload lend', 'install']);
  assert.deepEqual(sideloads(), [['slot', 'lend', '--udid', PU, '--to', 'lab']]);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(r.summary.lent, 'stremio-ios');
});

test('C8: an idle stop that is running keeps `lab up` out (the lease), and a second idle stop sees the first', async () => {
  lend();
  asLeaseHolder(lease.IDLE_OWNER);
  const out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, false);
  assert.match(out.error, /msl-idle/);
  assert.equal(sideloadCalls().length, 0);
  assert.equal(installs().length, 0);
  const idle = await lease.acquireIdle({ idleMinutes: 15 });
  assert.equal(idle.idle, false);
  assert.equal(idle.reason, 'another idle stop is running');
});

test('C9: an owner action that waited for a lab command (noAutoRetry) does not hold the next `lab up` back from settling', async () => {
  lend({ phase: 'returning', returnFailed: { code: 'RETURN_FAILED', cause: 'KEYCHAIN_LOCKED', at: '2026-10-24T12:00:00.000Z', human: ['unlock the keychain'], noAutoRetry: true } });
  w.answers.push(returnFailed('FREE_APP_LIMIT'));
  const r = await ensure();
  assert.deepEqual(sideloads(), [['slot', 'return', '--udid', PU]]);
  assert.equal(readLend(loadState()).phase, 'lent');
  assert.equal(r.summary.held, true);
});

test('probeInstall: the saved UDID on the install, the built runner as the app, and an installd limit is an outcome, not a throw', async () => {
  world({ apps: new Set(), installs: ['ok'] });
  const r = await probeInstall({ phone: PHONE, platformVersion: '27.0.1' });
  assert.deepEqual([r.outcome, r.built], ['accepted', false]);
  assert.deepEqual(installs(), [['xcrun', 'devicectl', 'device', 'install', 'app', '--device', PU, BUILT()]]);
  world({ apps: new Set(), installs: ['limit'] });
  assert.equal((await probeInstall({ phone: PHONE })).outcome, 'limit');
});

test('probeInstall: installd\'s long real free-app-limit message is the limit outcome, not needs: unknown', async () => {
  world({ apps: new Set(), installs: [{ code: 1, stderr: LONG_LIMIT }] });
  const r = await probeInstall({ phone: PHONE });
  assert.equal(r.outcome, 'limit');
  assert.ok(r.error.length <= 403);
});

test('L3: the long real free-app-limit message from installd goes on to the lend, then the second install', async () => {
  world({ apps: new Set(), installs: [{ code: 1, stderr: LONG_LIMIT }, 'ok'] });
  w.answers.push(lendAnswer());
  const r = await ensure();
  assert.deepEqual(order(), ['install', 'sideload lend', 'install']);
  assert.deepEqual(r.summary, { lent: 'stremio-ios', freed: 1 });
  assert.equal(readLend(loadState()).phase, 'lent');
});
