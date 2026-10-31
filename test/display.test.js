import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, fakeRunner, displayPhone, PHONE } from './helpers.js';
import { loadState, saveState } from '../lib/core.js';
import * as phone from '../lib/phone.js';
import * as ledger from '../lib/phone-restore.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phone');
const fixture = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const TEAM = 'ABCDE12345';
const SAVED = { udid: PHONE, teamId: TEAM, bundleId: 'com.dividedby.msl-wda-abcd' };

let ph, calls;
const wait = { ...phone.WAIT };

beforeEach(() => {
  sandbox();
  phone.WAIT.readBackMs = 0; // the read-backs are bounded by their count; no test waits on a clock
  ph = displayPhone();
  calls = fakeRunner((cmd, args) => ph.handle(cmd, args));
  saveState({ phone: SAVED });
});
afterEach(() => { Object.assign(phone.WAIT, wait); });

const entry = () => loadState().phoneRestore;
const argv = () => ph.calls.map(a => a.join(' '));

// --- the adapter over devicectl ---

test('the recorded shapes parse: appearance (light, dark), orientation (upright, flat), and nothing else', () => {
  assert.equal(phone.parseAppearance(fixture('appearance-info-dark.json').result), 'dark');
  assert.equal(phone.parseAppearance(fixture('appearance-set-light.json').result), 'light');
  assert.equal(phone.parseAppearance({ userInterfaceStyle: 'automatic' }), null);
  assert.equal(phone.parseAppearance(undefined), null);
  assert.deepEqual(phone.parseOrientation(fixture('orientation-get-portrait.json').result), { deviceOrientation: 'portrait', nonFlat: 'portrait' });
  assert.deepEqual(phone.parseOrientation(fixture('orientation-get-landscape-left.json').result), { deviceOrientation: 'landscapeLeft', nonFlat: 'landscapeLeft' });
  assert.deepEqual(phone.parseOrientation(fixture('orientation-get-faceup-upsidedown.json').result), { deviceOrientation: 'faceUp', nonFlat: 'portraitUpsideDown' });
  assert.equal(phone.parseOrientation({ deviceOrientation: 'sideways' }), null);
  // The phone's own lock flag is not read: it said false with the lock on.
  assert.equal('locked' in phone.parseOrientation({ ...fixture('orientation-get-portrait.json').result, deviceIsOrientationLocked: true }), false);
  // Flat with no upright reading: nothing to put the interface back to.
  assert.deepEqual(phone.parseOrientation({ deviceOrientation: 'faceDown' }), { deviceOrientation: 'faceDown', nonFlat: null });
});

test('every devicectl call passes --device <saved udid>, never "booted"; the appearance set passes --mode and nothing else', () => {
  phone.getAppearance(PHONE);
  phone.setAppearance(PHONE, 'dark');
  phone.getOrientation(PHONE);
  phone.setOrientation(PHONE, 'landscapeLeft');
  assert.equal(ph.calls.length, 4);
  for (const a of ph.calls) {
    assert.equal(a[a.indexOf('--device') + 1], PHONE);
    assert.equal(a.includes('booted'), false);
    assert.ok(a.includes('--json-output'));
  }
  assert.deepEqual(argv().map(l => l.replace(/ --json-output .*/, '')), [
    `devicectl device info appearance --device ${PHONE}`,
    `devicectl device settings appearance --device ${PHONE} --mode dark`,
    `devicectl device orientation get --device ${PHONE}`,
    `devicectl device orientation set landscapeLeft --device ${PHONE}`,
  ]);
  assert.equal(argv().some(l => l.includes('--look-and-feel')), false);
  assert.ok(calls.every(c => c[0] === 'xcrun'));
});

test('the adapter refuses a bad udid, mode or orientation before running anything', () => {
  assert.throws(() => phone.getAppearance('booted'), /not a device UDID/);
  assert.throws(() => phone.setAppearance(PHONE, 'auto'), /not light or dark/);
  assert.throws(() => phone.setOrientation(PHONE, 'sideways'), /not one of/);
  assert.deepEqual(calls, []);
});

test('a locked phone is `unlock`, a call that never answers is a timeout, and output the lab does not know is unknown', () => {
  ph.error = { code: 1, stderr: 'The device is locked. (passcodeRequired true)' };
  const locked = phone.getAppearance(PHONE);
  assert.deepEqual([locked.ok, locked.needs], [false, 'unlock']);
  ph.error = { code: 124, stderr: '' };
  const slow = phone.getOrientation(PHONE);
  assert.deepEqual([slow.ok, slow.needs], [false, 'cable']);
  assert.match(slow.error, /timed out after 20s/);
  ph.error = null;
  fakeRunner((cmd, args) => { fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ result: { surprise: true } })); return { code: 0 }; });
  const odd = phone.getAppearance(PHONE);
  assert.deepEqual([odd.ok, odd.needs], [false, 'unknown']);
  assert.match(odd.error, /does not recognise/);
});

// --- the record ---

test('readRestore: the right shape, and a damaged record names the way out', () => {
  assert.equal(ledger.readRestore({}), null);
  assert.equal(ledger.readRestore({ phoneRestore: null }), null);
  const good = { udid: PHONE, appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() }, orientation: { prior: { deviceOrientation: 'faceUp', nonFlat: 'portrait' }, set: 'landscapeLeft', at: new Date().toISOString() } };
  assert.deepEqual(ledger.readRestore({ phoneRestore: good }), good);
  assert.deepEqual(ledger.pendingKinds(good), ['appearance', 'orientation']);
  const bad = [
    'x', [], {}, { udid: PHONE }, { udid: 'nope', appearance: good.appearance },
    { udid: PHONE, appearance: { ...good.appearance, prior: 'auto' } },
    { udid: PHONE, appearance: { ...good.appearance, at: 'yesterday' } },
    { udid: PHONE, appearance: good.appearance, secret: 1 },
    { udid: PHONE, orientation: { ...good.orientation, set: 'sideways' } },
    { udid: PHONE, orientation: { ...good.orientation, prior: { deviceOrientation: 'faceUp', nonFlat: null } } },
  ];
  for (const b of bad) assert.throws(() => ledger.readRestore({ phoneRestore: b }), /damaged.*lab phone restore --forget/s, JSON.stringify(b));
});

// --- appearance: the rules ---

test('rule 1: the entry, with the prior, is on disk BEFORE the change is sent', async () => {
  let seen;
  ph.onSet = () => { seen = structuredClone(entry()); };
  const r = await ledger.changeAppearance(SAVED, 'dark');
  assert.deepEqual(r, { appearance: 'dark', prior: 'light', changed: true, pending: true });
  assert.equal(seen.udid, PHONE);
  assert.deepEqual([seen.appearance.prior, seen.appearance.set], ['light', 'dark']);
  assert.equal(ph.style, 'dark');
  assert.deepEqual(ph.sets, [['appearance', 'dark']]);
});

test('rule 2: a phone whose appearance cannot be read is not changed, and nothing is written down', async () => {
  ph.error = { code: 1, stderr: 'The device is locked' };
  await assert.rejects(ledger.changeAppearance(SAVED, 'dark'), e => {
    assert.match(e.message, /won't change Appearance it can't put back/);
    assert.equal(e.extra.needs, 'unlock');
    return true;
  });
  assert.deepEqual(ph.sets, []);
  assert.equal(entry(), undefined);
});

test('rule 3: a pending entry keeps its prior across later changes, also after a crash', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  // The lab was killed with dark on; the next run asks for light and then dark again.
  const light = await ledger.changeAppearance(SAVED, 'light');
  assert.equal(light.prior, 'light');
  const dark = await ledger.changeAppearance(SAVED, 'dark');
  assert.equal(dark.prior, 'light');
  assert.equal(entry().appearance.prior, 'light');
  // A leftover entry whose prior is "light" while the phone shows dark: asking for dark again changes nothing and does not take dark for the prior.
  const again = await ledger.changeAppearance(SAVED, 'dark');
  assert.deepEqual([again.changed, again.prior], [false, 'light']);
  assert.equal(entry().appearance.prior, 'light');
});

test('already showing the mode asked for: nothing is sent and nothing is recorded', async () => {
  const r = await ledger.changeAppearance(SAVED, 'light');
  assert.deepEqual(r, { appearance: 'light', prior: 'light', changed: false, pending: false });
  assert.deepEqual(ph.sets, []);
  assert.equal(entry(), undefined);
});

test('rule 5: the entry is cleared only after the phone reads back the prior; a phone that ignores the change keeps it', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  ph.ignoreSet = true;
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.equal(r.appearance.restored, false);
  assert.match(r.appearance.error, /Appearance was not confirmed/);
  assert.match(r.appearance.human[0], /set Appearance back to light by hand/);
  assert.ok(entry().appearance, 'the entry is kept');
  ph.ignoreSet = false;
  const ok = await ledger.restorePending();
  assert.equal(ok.restored, true);
  assert.equal(entry(), undefined);
  assert.equal(ph.style, 'light');
});

test('restoring appearance never claims Automatic was kept: restoredExactly false and a note', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  const r = await ledger.restorePending();
  assert.equal(r.restored, true);
  assert.equal(r.appearance.restored, true);
  assert.equal(r.appearance.restoredExactly, false);
  assert.match(r.appearance.note, /cannot read whether Appearance is on Automatic/);
  const report = ledger.restoreReport(r);
  assert.equal(report.phoneRestored, true);
  assert.equal(report.restoredExactly, false);
  assert.equal(report.human, undefined);
});

test('rule 6: a record for another phone is refused, for a change and for a restore; --forget drops it', async () => {
  saveState({ phoneRestore: { udid: '00008000-000A1B2C3D4E5F61', appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() } } });
  await assert.rejects(ledger.changeAppearance(SAVED, 'dark'), /belong to another phone.*lab phone restore --forget/s);
  await assert.rejects(ledger.changeOrientation(SAVED, 'landscapeLeft'), /belong to another phone/);
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.match(r.human[0], /another phone than the saved one/);
  assert.deepEqual(ph.calls, [], 'the other phone was never asked');
  assert.deepEqual(ledger.forgetRestore(), { forgot: true, forgotten: ['appearance'] });
  assert.equal(entry(), undefined);
  assert.deepEqual(ledger.forgetRestore(), { forgot: false, forgotten: [] });
});

test('a locked phone keeps the entry and says what to do; the next restore finishes it', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  ph.error = { code: 1, stderr: 'The device is locked. passcodeRequired true' };
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.equal(r.appearance.needs, 'unlock');
  assert.match(r.appearance.human[0], /unlock it and run `lab phone restore`/);
  assert.ok(entry().appearance);
  const report = ledger.restoreReport(r);
  assert.equal(report.phoneRestored, false);
  assert.match(report.human[0], /appearance was not put back to light/);
  ph.error = null;
  assert.equal((await ledger.restorePending()).restored, true);
  assert.equal(entry(), undefined);
  assert.equal(ph.style, 'light');
});

test('an unreachable phone is asked once: the other kinds are not tried after the first call times out', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  ph.calls.length = 0;
  ph.error = { code: 124, stderr: '' };
  const r = await ledger.restorePending();
  assert.equal(ph.calls.length, 1);
  assert.equal(r.restored, false);
  assert.match(r.orientation.error, /not tried/);
  assert.ok(entry().appearance && entry().orientation);
});

test('with nothing pending, restorePending asks nothing; with no phone saved it keeps the entry and says so', async () => {
  assert.deepEqual(await ledger.restorePending(), { pending: false });
  assert.deepEqual(ph.calls, []);
  await ledger.changeAppearance(SAVED, 'dark');
  saveState({ phone: null });
  ph.calls.length = 0;
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.match(r.human[0], /no phone is saved now/);
  assert.deepEqual(ph.calls, []);
  assert.ok(entry());
});

test('a damaged record is reported with the way out, and the phone is not asked', async () => {
  saveState({ phoneRestore: { udid: PHONE } });
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.match(r.human[0], /damaged.*lab phone restore --forget/s);
  assert.deepEqual(ph.calls, []);
  assert.equal(ledger.restoreReport(r).phoneRestored, false);
  assert.deepEqual(ledger.pendingNames(loadState()), { damaged: true, error: r.error });
});

test('only: restoring one kind leaves the other pending', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  const r = await ledger.restorePending({ only: 'appearance' });
  assert.equal(r.restored, true);
  assert.deepEqual(Object.keys(entry()).sort(), ['orientation', 'udid']);
  assert.deepEqual(await ledger.restorePending({ only: 'appearance' }), { pending: false });
});

// --- orientation ---

test('orientation: the prior is written first, the change is read back, and restore puts it back', async () => {
  let seen;
  ph.onSet = () => { seen = structuredClone(entry()); };
  const r = await ledger.changeOrientation(SAVED, 'landscapeLeft');
  assert.deepEqual(r, { orientation: 'landscapeLeft', prior: { deviceOrientation: 'portrait', nonFlat: 'portrait' }, changed: true, pending: true });
  assert.deepEqual(seen.orientation.prior, { deviceOrientation: 'portrait', nonFlat: 'portrait' });
  assert.equal(ph.orientation, 'landscapeLeft');
  const back = await ledger.restorePending();
  assert.equal(back.restored, true);
  assert.deepEqual([back.orientation.restored, back.orientation.restoredExactly], [true, true]);
  assert.equal(ph.orientation, 'portrait');
  assert.equal(entry(), undefined);
});

test('orientation restore from a flat phone: the upright orientation first, then the flat reading', async () => {
  Object.assign(ph, { orientation: 'faceUp', nonFlat: 'portrait' });
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  assert.deepEqual(entry().orientation.prior, { deviceOrientation: 'faceUp', nonFlat: 'portrait' });
  ph.sets.length = 0;
  const r = await ledger.restorePending();
  assert.equal(r.restored, true);
  assert.deepEqual(ph.sets, [['orientation', 'portrait'], ['orientation', 'faceUp']]);
  assert.deepEqual([ph.orientation, ph.nonFlat], ['faceUp', 'portrait']);
  assert.equal(r.orientation.restoredExactly, true);
});

test('orientation restore from an upside-down flat phone sets portrait, the interface orientation, then the flat reading', async () => {
  Object.assign(ph, { orientation: 'faceUp', nonFlat: 'portraitUpsideDown' });
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  ph.sets.length = 0;
  const r = await ledger.restorePending();
  assert.deepEqual(ph.sets, [['orientation', 'portrait'], ['orientation', 'faceUp']]);
  assert.equal(r.restored, true);
  assert.equal(r.orientation.restoredExactly, false, 'upside down comes back as portrait, flat or not');
  assert.match(r.orientation.note, /portraitUpsideDown/);
  assert.equal(ledger.restoreReport(r).restoredExactly, false);
});

test('orientation restore from an upside-down phone becomes portrait and says it is not exact', async () => {
  Object.assign(ph, { orientation: 'portraitUpsideDown', nonFlat: 'portraitUpsideDown' });
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  ph.sets.length = 0;
  const r = await ledger.restorePending();
  assert.deepEqual(ph.sets, [['orientation', 'portrait']]);
  assert.equal(r.restored, true);
  assert.equal(r.orientation.restoredExactly, false);
  assert.match(r.orientation.note, /portraitUpsideDown/);
  assert.equal(ledger.restoreReport(r).restoredExactly, false);
  assert.equal(entry(), undefined);
});

test('rule 4: a phone turned by hand after the lab set it is left alone: ownerChanged, and the record is cleared', async () => {
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  Object.assign(ph, { orientation: 'landscapeRight', nonFlat: 'landscapeRight' });
  ph.sets.length = 0;
  const r = await ledger.restorePending();
  assert.deepEqual(ph.sets, []);
  assert.equal(r.orientation.ownerChanged, true);
  assert.equal(r.orientation.restored, false);
  assert.equal(r.restored, true, 'a deliberate leave is not a failure');
  assert.equal(entry(), undefined);
  assert.equal(ph.orientation, 'landscapeRight');
});

test('rotation lock on: the set is ignored, so the change fails with that advice; nothing was changed, so nothing is kept', async () => {
  ph.rotationLock = true;
  await assert.rejects(ledger.changeOrientation(SAVED, 'landscapeLeft'), e => {
    assert.match(e.message, /did not change after setting landscapeLeft \(still portrait\): Portrait Orientation Lock is probably on/);
    assert.equal(e.extra.rotationLock, 'probably');
    assert.match(e.extra.human[0], /Turn off Portrait Orientation Lock/);
    return true;
  });
  assert.equal(entry(), undefined);
  // One reading before, one after the set, then at most two more: bounded.
  assert.ok(ph.calls.filter(a => a[3] === 'get').length <= 1 + phone.READ_BACK_TRIES);
});

test('rotation lock on with an entry already pending: the entry stays', async () => {
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  ph.rotationLock = true;
  await assert.rejects(ledger.changeOrientation(SAVED, 'portrait'), /Rotation Lock is probably on|Orientation Lock is probably on/);
  assert.ok(entry().orientation);
  assert.deepEqual(entry().orientation.prior, { deviceOrientation: 'portrait', nonFlat: 'portrait' });
});

test('orientation: a flat phone that gave no upright reading is not changed (it could not be put back)', async () => {
  fakeRunner((cmd, args) => {
    if (args.includes('get')) {
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ result: { deviceOrientation: 'faceDown' } }));
      return { code: 0 };
    }
    return ph.handle(cmd, args);
  });
  await assert.rejects(ledger.changeOrientation(SAVED, 'portrait'), /can't put back: the phone lies flat/);
  assert.deepEqual(ph.sets, []);
  assert.equal(entry(), undefined);
});

test('the orientation is already what was asked: nothing is sent', async () => {
  const r = await ledger.changeOrientation(SAVED, 'portrait');
  assert.deepEqual([r.changed, r.pending], [false, false]);
  assert.deepEqual(ph.sets, []);
});

test('every devicectl call of every flow above carried the saved udid (a full run through both kinds)', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  await ledger.restorePending();
  assert.ok(ph.calls.length >= 8);
  for (const a of ph.calls) assert.equal(a[a.indexOf('--device') + 1], PHONE);
  assert.equal(JSON.stringify(calls).includes('booted'), false);
});

test('the lab never touches the simulator: the display calls are devicectl only', async () => {
  await ledger.changeAppearance(SAVED, 'dark');
  await ledger.restorePending();
  assert.ok(calls.every(c => c[0] === 'xcrun' && c[1] === 'devicectl'));
});

test('a restore the phone ignores (rotation lock on) keeps the entry and gives the same lock advice, not a generic "not confirmed"', async () => {
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  ph.rotationLock = true; // turned on after the lab set landscape
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.match(r.orientation.error, /did not change when the lab set it back to portrait \(still landscapeLeft\): Portrait Orientation Lock is probably on/);
  assert.match(r.orientation.human[0], /Turn it off in Control Center, then run `lab phone restore`/);
  assert.ok(entry().orientation, 'the entry is kept');
  assert.ok(ph.calls.filter(a => a[3] === 'get').length <= 2 + 1 + phone.READ_BACK_TRIES);
  ph.rotationLock = false;
  assert.equal((await ledger.restorePending()).restored, true);
  assert.equal(ph.orientation, 'portrait');
  assert.equal(entry(), undefined);
});

test('a restore that moved the phone but not to the prior is the generic failure, entry kept', async () => {
  await ledger.changeOrientation(SAVED, 'landscapeLeft');
  ph.onSet = () => { ph.onSet = null; ph.drift = true; };
  const real = ph.handle;
  fakeRunner((cmd, args) => {
    const out = real(cmd, args);
    if (ph.drift && args.includes('get')) { // the phone ends up somewhere else after the set
      const f = args[args.indexOf('--json-output') + 1];
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      j.result.deviceOrientation = 'landscapeRight';
      fs.writeFileSync(f, JSON.stringify(j));
    }
    return out;
  });
  const r = await ledger.restorePending();
  assert.equal(r.restored, false);
  assert.match(r.orientation.error, /the orientation was not confirmed: the phone reads landscapeRight/);
  assert.doesNotMatch(r.orientation.error, /Orientation Lock/);
  assert.ok(entry().orientation);
});
