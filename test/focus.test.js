// Lab Focus (#16): the shortcut adapter in phone.js and the `focus` kind in the restore ledger (phone-restore.js).
// The phone is a stand-in (displayPhone in helpers.js); no test waits on a clock.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, fakeRunner, displayPhone, PHONE } from './helpers.js';
import { loadState, saveState } from '../lib/core.js';
import * as phone from '../lib/phone.js';
import * as ledger from '../lib/phone-restore.js';
import { handlers as safari } from '../lib/safari.js';

const SAVED = { udid: PHONE, teamId: 'ABCDE12345', bundleId: 'com.dividedby.msl-wda-abcd' };
const OTHER = '00008000-000A1B2C3D4E5F61';
let ph, calls;

beforeEach(() => {
  sandbox();
  phone.WAIT.readBackMs = 0;
  ph = displayPhone({ locked: false });
  calls = fakeRunner((cmd, args) => ph.handle(cmd, args));
  saveState({ phone: SAVED });
});

const entry = () => loadState().phoneRestore;
const launches = () => calls.filter(c => c.includes('com.apple.shortcuts'));

// --- the adapter ---

test('runShortcut: the lock state is read first, then one argument list with the saved udid, the encoded URL and com.apple.shortcuts', () => {
  assert.deepEqual(phone.runShortcut(PHONE, 'Lab Focus On'), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 6), ['xcrun', 'devicectl', 'device', 'info', 'lockState', '--device']);
  assert.equal(calls[0][6], PHONE);
  assert.deepEqual(calls[1].slice(0, 10), ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', PHONE, '--payload-url', 'shortcuts://run-shortcut?name=Lab%20Focus%20On', 'com.apple.shortcuts']);
  assert.ok(calls.every(c => c[0] === 'xcrun' && !c.includes('booted') && !c.includes('is.workflow.my.app')));
  assert.equal(calls[1].includes('--terminate-existing'), false);
});

test('runShortcut refuses a bad udid or a name that is not plain before running anything', () => {
  assert.throws(() => phone.runShortcut('booted', 'Lab Focus On'), /not a device UDID/);
  for (const bad of ['', 'a&b', 'a#b', 'a/b', 'café', 'x'.repeat(61), ' x', 'x ', 'a?b=c', 'a%20b', '日本', null, 7]) {
    assert.throws(() => phone.runShortcut(PHONE, bad), /not a shortcut name/, JSON.stringify(bad));
  }
  assert.deepEqual(calls, []);
  assert.equal(phone.shortcutUrl('A b.c-d_e'), 'shortcuts://run-shortcut?name=A%20b.c-d_e');
  assert.equal(phone.isShortcutName('x'.repeat(60)), true);
});

test('runShortcut on a locked phone launches nothing and says unlock; an unreadable lock state launches nothing either', () => {
  ph.locked = true;
  const locked = phone.runShortcut(PHONE, 'Lab Focus On');
  assert.deepEqual([locked.ok, locked.needs], [false, 'unlock']);
  assert.match(locked.error, /does not run a shortcut on a locked phone/);
  assert.equal(launches().length, 0);
  ph.locked = undefined; // the stand-in does not answer lockState: the runner's default has no JSON
  const unreadable = phone.runShortcut(PHONE, 'Lab Focus On');
  assert.equal(unreadable.ok, false);
  assert.equal(launches().length, 0);
});

test('runShortcut failures: a text it knows keeps its needs, other texts are `shortcut`, a timeout may have run', () => {
  ph.launchError = { code: 1, stderr: 'ERROR: The application is not installed. (CoreDeviceError 10002)' };
  const missing = phone.runShortcut(PHONE, 'Lab Focus On');
  assert.deepEqual([missing.ok, missing.needs, missing.maybeSent], [false, 'shortcut', undefined]);
  ph.launchError = { code: 1, stderr: 'The device is locked. (passcodeRequired true)' };
  assert.equal(phone.runShortcut(PHONE, 'Lab Focus On').needs, 'unlock');
  ph.launchError = { code: 124, stderr: '' };
  const slow = phone.runShortcut(PHONE, 'Lab Focus On');
  assert.deepEqual([slow.ok, slow.maybeSent], [false, true]);
  assert.match(slow.error, /timed out after 30s/);
});

test('setFocus runs the saved phone\'s own shortcut names, the defaults when none are saved', () => {
  phone.setFocus(PHONE, 'on', SAVED);
  phone.setFocus(PHONE, 'off', { ...SAVED, focus: { onShortcut: 'In', offShortcut: 'Out' } });
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Out']);
  assert.throws(() => phone.setFocus(PHONE, 'maybe', SAVED), /not on or off/);
  assert.deepEqual(phone.focusConfig(undefined), { enabled: true, onShortcut: 'Lab Focus On', offShortcut: 'Lab Focus Off' });
  assert.deepEqual(phone.focusConfig({ focus: { enabled: false } }), { enabled: false, onShortcut: 'Lab Focus On', offShortcut: 'Lab Focus Off' });
  assert.equal(phone.focusConfig({ focus: { onShortcut: 'a&b' } }).onShortcut, 'Lab Focus On', 'a damaged field gives the defaults');
});

// --- the ledger ---

test('focus has no command of its own: not a `safari focus`, not in the command kinds, but in the ledger kinds', () => {
  assert.equal('focus' in safari, false);
  assert.deepEqual(ledger.COMMAND_KINDS, ['appearance', 'orientation']);
  assert.deepEqual(ledger.KINDS, ['appearance', 'orientation', 'focus']);
});

test('readRestore: the focus entry has the shape { prior: "unknown", set: "on", at }; anything else is a damaged record', () => {
  const good = { udid: PHONE, focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() } };
  assert.deepEqual(ledger.readRestore({ phoneRestore: good }), good);
  assert.deepEqual(ledger.pendingKinds(good), ['focus']);
  for (const bad of [{ ...good.focus, prior: 'off' }, { ...good.focus, set: 'off' }, { ...good.focus, at: 'now' }, { set: 'on', at: good.focus.at }, 'on']) {
    assert.throws(() => ledger.readRestore({ phoneRestore: { udid: PHONE, focus: bad } }), /damaged.*lab phone restore --forget/s, JSON.stringify(bad));
  }
});

test('rule 1: the entry is on disk BEFORE the shortcut runs; the prior is recorded as unknown', async () => {
  let seen;
  ph.onSet = () => { seen = structuredClone(entry()); };
  const r = await ledger.changeFocus(SAVED);
  assert.deepEqual(r, { focus: 'on', prior: 'unknown', changed: true, pending: true });
  assert.equal(seen.udid, PHONE);
  assert.deepEqual([seen.focus.prior, seen.focus.set], ['unknown', 'on']);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  assert.equal(ph.calls.every(a => a[a.indexOf('--device') + 1] === PHONE), true);
});

test('a shortcut that was not delivered leaves no new entry; one that timed out keeps it (it may have run); an old entry is kept', async () => {
  ph.locked = true;
  await assert.rejects(ledger.changeFocus(SAVED), e => e.extra.needs === 'unlock');
  assert.equal(entry(), undefined);
  assert.deepEqual(ph.shortcuts, []);
  ph.locked = false;
  ph.launchError = { code: 1, stderr: 'ERROR: not installed' };
  await assert.rejects(ledger.changeFocus(SAVED), e => e.extra.needs === 'shortcut');
  assert.equal(entry(), undefined);
  ph.launchError = { code: 124, stderr: '' };
  await assert.rejects(ledger.changeFocus(SAVED), /timed out/);
  assert.ok(entry().focus, 'it may have run: the entry stays');
  const kept = structuredClone(entry());
  ph.launchError = { code: 1, stderr: 'ERROR: not installed' };
  await assert.rejects(ledger.changeFocus(SAVED), /not installed/);
  assert.equal(entry().focus.prior, kept.focus.prior, 'an entry that is already there stays');
});

test('rule 6: a ledger for another phone is refused; no phone saved is `needs setup`', async () => {
  saveState({ phoneRestore: { udid: OTHER, focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() } } });
  await assert.rejects(ledger.changeFocus(SAVED), /another phone than the saved one/);
  assert.deepEqual(ph.shortcuts, []);
  await assert.rejects(ledger.changeFocus(null), e => e.extra.needs === 'setup');
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.deepEqual(ph.shortcuts, []);
});

test('restore runs Off, clears the entry only after the launch was delivered, and says it is not exact', async () => {
  await ledger.changeFocus(SAVED);
  const r = await ledger.restorePending();
  assert.equal(r.restored, true);
  assert.deepEqual([r.focus.restored, r.focus.changed, r.focus.restoredExactly], [true, true, false]);
  assert.match(r.focus.note, /ran the Lab Focus Off shortcut and assumes Lab Focus was off before the run/);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  assert.equal(entry(), undefined);
  assert.deepEqual(ledger.restoreReport(r).restoredExactly, false);
  assert.deepEqual(await ledger.restorePending(), { pending: false });
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off'], 'nothing pending, nothing run');
});

test('restore on a locked phone keeps the entry, launches nothing and gives the steps; unlocked, the next one finishes it', async () => {
  await ledger.changeFocus(SAVED);
  ph.locked = true;
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.equal(r.focus.restored, false);
  assert.match(r.focus.human[0], /The focus was not put back to off/);
  assert.match(r.focus.human[0], /unlock it and run `lab phone restore`.*turn Lab Focus off by hand/);
  assert.ok(entry().focus);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  ph.locked = false;
  assert.equal((await ledger.restorePending()).restored, true);
  assert.equal(entry(), undefined);
});

test('restore with the Off shortcut failing keeps the entry; the saved Off name is the one run', async () => {
  saveState({ phone: { ...SAVED, focus: { offShortcut: 'Lab Out' } } });
  await ledger.changeFocus(readPhone());
  ph.launchError = { code: 1, stderr: 'ERROR: not installed' };
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.ok(entry().focus);
  ph.launchError = null;
  assert.equal((await ledger.restorePending()).restored, true);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Out']);
});

function readPhone() { return phone.readPhone(loadState()); }

test('all kinds pending: appearance and orientation are put back before the focus, in one call; a phone that stopped answering skips the rest', async () => {
  saveState({ phoneRestore: {
    udid: PHONE,
    appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() },
    focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() },
  } });
  ph.style = 'dark';
  const r = await ledger.restorePending();
  assert.equal(r.restored, true);
  assert.equal(ph.style, 'light');
  assert.deepEqual(ph.shortcuts, ['Lab Focus Off']);
  assert.ok(ph.calls.findIndex(a => a.includes('appearance')) < ph.calls.findIndex(a => a.includes('com.apple.shortcuts')));

  saveState({ phoneRestore: {
    udid: PHONE,
    appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() },
    focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() },
  } });
  ph.error = { code: 1, stderr: 'The device is locked. (passcodeRequired true)' };
  const locked = await ledger.restorePending();
  assert.equal(locked.restored, false);
  assert.match(locked.focus.error, /not tried/);
  assert.deepEqual(ph.shortcuts, ['Lab Focus Off'], 'no further shortcut');
  assert.deepEqual(ledger.pendingKinds(entry()), ['appearance', 'focus']);
});
