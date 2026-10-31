import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, fakeRunner, tempDir } from './helpers.js';
import { setRunner } from '../lib/core.js';
import * as phone from '../lib/phone.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phone');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const U = '00008000-000A1B2C3D4E5F60'; // the fake phone in the fixtures
const TEAM = 'ABCDE12345';

beforeEach(() => {
  sandbox();
  process.env.MSL_APPIUM_HOME = tempDir('msl-appium-');
  phone.setUsbmux();
});
afterEach(() => { delete process.env.MSL_APPIUM_HOME; phone.setUsbmux(); });

// A devicectl stand-in: `files` maps a subcommand ('list devices', 'lockState', 'launch') to
// { json: fixture name, stdout, stderr, code }; the JSON is written where --json-output points.
function devicectl(files) {
  return (cmd, args) => {
    if (cmd !== 'xcrun') return undefined;
    const sub = args.includes('lockState') ? 'lockState' : args.includes('launch') ? 'launch' : 'list devices';
    const f = files[sub];
    if (!f) return { code: 1, stderr: `unexpected devicectl ${sub}` };
    if (f.json) fs.writeFileSync(args[args.indexOf('--json-output') + 1], fixture(f.json));
    return { code: f.code ?? 0, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  };
}

const CABLE = { 'list devices': { json: 'devices-cable.json' }, lockState: { json: 'lock-unlocked.json' } };

test('fixtures hold only the fake phone id', () => {
  for (const f of fs.readdirSync(FIX)) {
    for (const id of fixture(f).match(/\b[0-9A-F]{8}-[0-9A-F]{16}\b/g) ?? []) assert.equal(id, U, f);
  }
});

test('isTeamId and defaultBundleId', () => {
  assert.equal(phone.isTeamId(TEAM), true);
  for (const bad of ['abcde12345', 'ABCDE1234', 'ABCDE123456', 'ABCDE-2345', '', undefined, 5]) assert.equal(phone.isTeamId(bad), false, String(bad));
  assert.equal(phone.defaultBundleId(TEAM), 'com.dividedby.msl-wda-abcd');
  assert.equal(phone.defaultBundleId('Z9Y8X7W6V5'), 'com.dividedby.msl-wda-z9y8');
  assert.throws(() => phone.defaultBundleId('nope'), /not a team id/);
});

test('parseDevices: cable, Wi-Fi, stale offline list, absent, and bad output', () => {
  const only = name => {
    const list = phone.parseDevices(JSON.parse(fixture(name)));
    assert.equal(list.length <= 1, true, 'simulators are dropped');
    return list[0];
  };
  assert.deepEqual(only('devices-cable.json'), { udid: U, name: 'Test iPhone', transport: 'cable', tunnelState: 'connected', pairingState: 'paired', developerMode: true, osVersion: '27.0.1', buildVersion: '24A446' });
  assert.equal(only('devices-wifi.json').transport, 'wifi');
  // Wi-Fi off and unplugged: the list still says connected over the network. Only a live call can tell.
  const stale = only('devices-offline-stale.json');
  assert.equal(stale.transport, 'wifi');
  assert.equal(stale.tunnelState, 'connected');
  assert.equal(only('devices-absent.json'), undefined);
  assert.throws(() => phone.parseDevices({}), /unexpected output/);
  assert.throws(() => phone.parseDevices(null), /unexpected output/);
  const odd = JSON.parse(fixture('devices-cable.json'));
  const d = odd.result.devices.find(x => x.hardwareProperties.reality === 'physical');
  d.connectionProperties.transportType = 'something-new';
  d.deviceProperties.developerModeStatus = 'disabled';
  assert.deepEqual([phone.parseDevices(odd)[0].transport, phone.parseDevices(odd)[0].developerMode], ['unknown', false]);
  // A version that is not a version is dropped, not passed on.
  d.deviceProperties.osVersionNumber = '27.x; rm -rf';
  d.deviceProperties.osBuildUpdate = 'not a build!';
  assert.deepEqual([phone.parseDevices(odd)[0].osVersion, phone.parseDevices(odd)[0].buildVersion], [null, null]);
  delete d.deviceProperties.osVersionNumber;
  delete d.deviceProperties.osBuildUpdate;
  assert.deepEqual([phone.parseDevices(odd)[0].osVersion, phone.parseDevices(odd)[0].buildVersion], [null, null]);
});

test('lockState: unlocked, locked, offline, timeout, bad udid', () => {
  const calls = fakeRunner(devicectl({ lockState: { json: 'lock-unlocked.json' } }));
  assert.deepEqual(phone.lockState(U), { ok: true, locked: false });
  assert.deepEqual(calls[0].slice(0, 8), ['xcrun', 'devicectl', 'device', 'info', 'lockState', '--device', U, '--json-output']);

  fakeRunner(devicectl({ lockState: { json: 'lock-locked.json' } }));
  assert.deepEqual(phone.lockState(U), { ok: true, locked: true });

  fakeRunner(devicectl({ lockState: { json: 'lock-offline.json', code: 1, stderr: fixture('lock-offline-stderr.txt') } }));
  const off = phone.lockState(U);
  assert.equal(off.ok, false);
  assert.match(off.error, /NWError error 60/);
  assert.equal(phone.classify(off.error), 'cable');

  fakeRunner(devicectl({ lockState: { code: 124, stderr: 'timed out after 20s' } }));
  const slow = phone.lockState(U);
  assert.match(slow.error, /timed out after 20s/);
  assert.equal(phone.classify(slow.error), 'cable');

  assert.throws(() => phone.lockState('booted'), /not a device UDID/);
});

// A long lockState failure whose known text sits past char 400, where the shown `error` is cut: `needs` is read from the whole text.
const LONG_LOCKED = `${'CoreDeviceError detail. '.repeat(25)}The device is locked.`;

test('lockState: a long failure keeps `needs` from the whole text, and its error is cut to 400', () => {
  fakeRunner(devicectl({ lockState: { code: 1, stderr: LONG_LOCKED } }));
  const r = phone.lockState(U);
  assert.deepEqual([r.ok, r.needs], [false, 'unlock']);
  assert.ok(r.error.length <= 403 && !r.error.includes('is locked'), 'the shown error is cut before the known text');
  fakeRunner(devicectl({ lockState: { code: 124, stderr: '' } }));
  assert.equal(phone.lockState(U).needs, 'cable');
});

test('phoneStatus and runShortcut: a long lockState failure is read whole (unlock), not the cable fallback', () => {
  fakeRunner(devicectl({ 'list devices': { json: 'devices-cable.json' }, lockState: { code: 1, stderr: LONG_LOCKED } }));
  const s = phone.phoneStatus(U, { usbmux: () => true });
  assert.deepEqual([s.reachable, s.needs], [false, 'unlock']);
  assert.ok(s.error.length <= 403);
  const r = phone.runShortcut(U, 'Lab Focus On');
  assert.deepEqual([r.ok, r.needs], [false, 'unlock']);
  assert.ok(r.error.length <= 403);
});

// --- a dropped CoreDevice control channel (#81): one retry in the devicectl wrapper, then `cable` ---

// A devicectl stand-in that answers its calls from `replies` in turn (the last one repeats) and counts them.
function sequence(replies) {
  const calls = [];
  fakeRunner((cmd, args) => {
    if (cmd !== 'xcrun') return undefined;
    const out = args[args.indexOf('--json-output') + 1];
    const sub = args.includes('lockState') ? 'lockState' : 'launch';
    const rep = replies[sub][Math.min(calls.filter(c => c === sub).length, replies[sub].length - 1)];
    calls.push(sub);
    if (rep.json) fs.writeFileSync(out, fixture(rep.json));
    return { code: rep.code ?? 0, stdout: '', stderr: rep.stderr ?? '' };
  });
  return calls;
}
const DROPPED = { code: 1, stderr: fixture('coredevice-4000-stderr.txt') };
const OK = { json: 'lock-unlocked.json' };

test('devicectl: one dropped-channel failure is retried once and the second answer is used', () => {
  const calls = sequence({ lockState: [DROPPED, OK] });
  assert.deepEqual(phone.lockState(U), { ok: true, locked: false });
  assert.deepEqual(calls, ['lockState', 'lockState']);
});

test('devicectl: two dropped-channel failures are two runs, then needs cable', () => {
  const calls = sequence({ lockState: [DROPPED] });
  const r = phone.lockState(U);
  assert.deepEqual([r.ok, r.needs], [false, 'cable']);
  assert.equal(calls.length, 2);
});

test('devicectl: a timeout or an unrelated error is not retried', () => {
  for (const rep of [{ code: 124, stderr: fixture('coredevice-4000-stderr.txt') }, { code: 1, stderr: 'something nobody has seen before' }, { code: 1, stderr: 'the device is locked' }]) {
    const calls = sequence({ lockState: [rep, OK] });
    assert.equal(phone.lockState(U).ok, false, rep.stderr);
    assert.equal(calls.length, 1, rep.stderr);
  }
});

test('devicectl: a drop that may have come mid-command (no "could not be established") is cable but not retried', () => {
  const calls = sequence({ lockState: [{ code: 1, stderr: 'Internal logic error: Connection was invalidated (com.apple.CoreDevice.ControlChannelConnectionError error 1)' }, OK] });
  const r = phone.lockState(U);
  assert.deepEqual([r.ok, r.needs], [false, 'cable']);
  assert.equal(calls.length, 1);
});

test('openTab (a Safari launch) is never retried, even for a never-established connection: a second run would open a second tab', () => {
  const calls = sequence({ launch: [DROPPED, { code: 0 }] });
  assert.throws(() => phone.openTab(U, 'msl-0a1b2c3d'), e => e.extra.needs === 'cable');
  assert.deepEqual(calls, ['launch']);
});

test('devicectl: "Connection was invalidated" alone is cable and not retried', () => {
  const calls = sequence({ lockState: [{ code: 1, stderr: 'Internal logic error: Connection was invalidated' }, OK] });
  const r = phone.lockState(U);
  assert.deepEqual([r.ok, r.needs], [false, 'cable']);
  assert.equal(calls.length, 1);
});

test('runShortcut: a dropped channel twice is needs cable, not shortcut; once is a success', () => {
  let calls = sequence({ lockState: [OK], launch: [DROPPED] });
  const r = phone.runShortcut(U, 'Lab Focus On');
  assert.deepEqual([r.ok, r.needs], [false, 'cable']);
  assert.deepEqual(calls, ['lockState', 'launch', 'launch']);
  calls = sequence({ lockState: [OK], launch: [DROPPED, { code: 0 }] });
  assert.deepEqual(phone.runShortcut(U, 'Lab Focus On'), { ok: true });
  assert.deepEqual(calls, ['lockState', 'launch', 'launch']);
});

test('lockState and the device list pass bounded timeouts', () => {
  const seen = [];
  setRunner((cmd, args, opts) => {
    seen.push(opts.timeoutMs);
    return { code: 1, stdout: '', stderr: 'x' };
  });
  phone.lockState(U);
  phone.phoneStatus(U, { usbmux: () => true });
  assert.deepEqual(seen, [20e3, 30e3]);
});

test('phoneStatus: cable and Wi-Fi, unlocked and locked', () => {
  fakeRunner(devicectl(CABLE));
  assert.deepEqual(phone.phoneStatus(U, { usbmux: () => true }), {
    udid: U, found: true, name: 'Test iPhone', transport: 'cable', via: 'usbmux', tunnelState: 'connected', pairingState: 'paired',
    developerMode: true, osVersion: '27.0.1', buildVersion: '24A446', usbmux: true, usbmuxTypes: [], locked: false, reachable: true,
  });

  fakeRunner(devicectl({ 'list devices': { json: 'devices-wifi.json' }, lockState: { json: 'lock-unlocked.json' } }));
  const wifi = phone.phoneStatus(U, { usbmux: () => ({ listed: true }) });
  assert.deepEqual([wifi.transport, wifi.via, wifi.reachable], ['wifi', 'tunnel', true]);

  fakeRunner(devicectl({ 'list devices': { json: 'devices-cable.json' }, lockState: { json: 'lock-locked.json' } }));
  const locked = phone.phoneStatus(U, { usbmux: () => true });
  assert.equal(locked.reachable, true);
  assert.equal(locked.locked, true);
});

test('phoneStatus: a stale "connected" list is not reachability', () => {
  const calls = fakeRunner(devicectl({
    'list devices': { json: 'devices-offline-stale.json' },
    lockState: { json: 'lock-offline.json', code: 1, stderr: fixture('lock-offline-stderr.txt') },
  }));
  let asked = 0;
  const s = phone.phoneStatus(U, { usbmux: () => { asked++; return true; } });
  assert.equal(s.found, true);
  assert.equal(s.tunnelState, 'connected'); // what the stale list claims
  assert.equal(s.reachable, false);
  assert.equal(s.locked, null);
  assert.equal(s.needs, 'cable');
  assert.match(s.error, /NWError/);
  assert.equal(asked, 0, 'usbmux is not consulted after a failed lockState');
  assert.equal(calls.filter(c => c.includes('lockState')).length, 1);
});

test('phoneStatus: lockState fine but usbmux lost the phone is not reachable', () => {
  fakeRunner(devicectl(CABLE));
  const s = phone.phoneStatus(U, { usbmux: () => false });
  assert.equal(s.reachable, false);
  assert.equal(s.usbmux, false);
  assert.equal(s.locked, false);
  assert.equal(s.needs, 'cable');
  assert.match(s.error, /Unknown device or simulator UDID/);

  const err = phone.phoneStatus(U, { usbmux: () => ({ listed: false, error: 'usbmux check failed: boom' }) });
  assert.equal(err.error, 'usbmux check failed: boom');
});

test('phoneStatus: a USB entry in usbmux is the cable; anything else CoreDevice lists on the network is Wi-Fi through the tunnel', () => {
  const WIFI = { 'list devices': { json: 'devices-wifi.json' }, lockState: { json: 'lock-unlocked.json' } };
  fakeRunner(devicectl(CABLE));
  const usb = phone.phoneStatus(U, { usbmux: () => ({ listed: true, types: ['USB'] }) });
  assert.deepEqual([usb.reachable, usb.transport, usb.via, usb.usbmux, usb.usbmuxTypes], [true, 'cable', 'usbmux', true, ['USB']]);

  // The cable is in while CoreDevice still shows the network: USB wins.
  fakeRunner(devicectl(WIFI));
  const cable = phone.phoneStatus(U, { usbmux: () => ({ listed: true, types: ['USB'] }) });
  assert.deepEqual([cable.reachable, cable.transport, cable.via], [true, 'cable', 'usbmux']);

  // Wi-Fi: usbmux's Network entries are ignored, and so is a usbmux that lists nothing or fails.
  for (const mux of [{ listed: true, types: ['Network'] }, { listed: false, types: [] }, { listed: false, types: [], error: 'usbmux check failed: boom' }, false, true]) {
    const wifi = phone.phoneStatus(U, { usbmux: () => mux });
    assert.deepEqual([wifi.reachable, wifi.transport, wifi.via, wifi.needs, wifi.error], [true, 'wifi', 'tunnel', undefined, undefined], JSON.stringify(mux));
  }
});

test('phoneStatus: over the cable a usbmux that does not list the phone over USB is not reachable', () => {
  fakeRunner(devicectl(CABLE));
  for (const mux of [false, { listed: false, types: [] }, { listed: true, types: ['Network'] }]) {
    const s = phone.phoneStatus(U, { usbmux: () => mux });
    assert.deepEqual([s.found, s.reachable, s.via, s.needs], [true, false, null, 'cable'], JSON.stringify(mux));
    assert.match(s.error, /Unknown device or simulator UDID/);
  }
  assert.equal(phone.phoneStatus(U, { usbmux: () => false }).usbmux, false);
  const err = phone.phoneStatus(U, { usbmux: () => ({ listed: false, error: 'usbmux check failed: boom' }) });
  assert.equal(err.error, 'usbmux check failed: boom');
  assert.deepEqual(phone.needsError(err.needs, err.error).extra.human, phone.NEEDS.cable.human);
});

test('phoneStatus: neither route reaches the phone (lockState fails) is needs cable, with the cable steps', () => {
  fakeRunner(devicectl({
    'list devices': { json: 'devices-offline-stale.json' },
    lockState: { json: 'lock-offline.json', code: 1, stderr: fixture('lock-offline-stderr.txt') },
  }));
  const off = phone.phoneStatus(U, { usbmux: () => ({ listed: false, types: [] }) });
  assert.deepEqual([off.reachable, off.via, off.needs], [false, null, 'cable']);
  assert.deepEqual(phone.needsError(off.needs, off.error).extra.human, phone.NEEDS.cable.human);
});

test('Private Wi-Fi Address has no part in the diagnosis any more', () => {
  assert.equal(phone.classify('usbmux does not list it; Private Wi-Fi Address is on'), 'unknown');
  assert.deepEqual(phone.needsError('cable', 'Private Wi-Fi Address').extra.human, phone.NEEDS.cable.human);
  assert.ok(!Object.keys(phone).some(k => /PRIVATE/i.test(k)));
});

test('phoneStatus: phone absent from the list, unpaired, and devicectl failing', () => {
  const calls = fakeRunner(devicectl({ 'list devices': { json: 'devices-absent.json' } }));
  const absent = phone.phoneStatus(U, { usbmux: () => true });
  assert.deepEqual([absent.found, absent.reachable, absent.needs], [false, false, 'cable']);
  assert.deepEqual([absent.osVersion, absent.buildVersion], [null, null]);
  assert.equal(calls.some(c => c.includes('lockState')), false, 'no lockState for a phone that is not listed');

  const unpaired = JSON.parse(fixture('devices-cable.json'));
  unpaired.result.devices.find(x => x.hardwareProperties.reality === 'physical').connectionProperties.pairingState = 'unpaired';
  fakeRunner((cmd, args) => { fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify(unpaired)); });
  assert.equal(phone.phoneStatus(U, { usbmux: () => true }).needs, 'trust');

  fakeRunner(() => ({ code: 1, stderr: 'xcrun: error: unable to find utility "devicectl"' }));
  const broken = phone.phoneStatus(U, { usbmux: () => true });
  assert.equal(broken.reachable, false);
  assert.equal(broken.needs, 'unknown');
  assert.match(broken.error, /unable to find utility/);
});

test('phoneStatus uses the injected module-level usbmux check', () => {
  fakeRunner(devicectl(CABLE));
  phone.setUsbmux(id => id === U);
  assert.equal(phone.phoneStatus(U).reachable, true);
  phone.setUsbmux(() => false);
  assert.equal(phone.phoneStatus(U).reachable, false);
});

test('usbmuxListed runs appium-ios-device from the managed Appium install in node', () => {
  const out = list => ({ stdout: `noise\nMSL_USBMUX:${JSON.stringify(list)}\n` });
  const calls = fakeRunner(() => out([{ udid: U, type: 'USB' }, { udid: 'other', type: 'Network' }]));
  assert.deepEqual(phone.usbmuxListed(U), { listed: true, types: ['USB'] });
  const [cmd, flag, script, driver] = calls[0];
  assert.equal(cmd, process.execPath);
  assert.equal(flag, '-e');
  assert.match(script, /appium-ios-device/);
  assert.match(script, /listDevices\(\)/, 'reads the raw list, which keeps ConnectionType');
  assert.match(script, /ConnectionType/);
  assert.equal(driver, path.join(process.env.MSL_APPIUM_HOME, 'node_modules', 'appium-xcuitest-driver', 'package.json'));
  assert.equal(calls[0].length, 4);

  // Connection types: Network only, both (deduped), and an entry without a type.
  fakeRunner(() => out([{ udid: U, type: 'Network' }]));
  assert.deepEqual(phone.usbmuxListed(U), { listed: true, types: ['Network'] });
  fakeRunner(() => out([{ udid: U, type: 'USB' }, { udid: U, type: 'Network' }, { udid: U, type: 'USB' }]));
  assert.deepEqual(phone.usbmuxListed(U), { listed: true, types: ['USB', 'Network'] });
  fakeRunner(() => out([{ udid: U }]));
  assert.deepEqual(phone.usbmuxListed(U), { listed: true, types: ['unknown'] });

  fakeRunner(() => ({ stdout: 'MSL_USBMUX:[]\n' }));
  assert.deepEqual(phone.usbmuxListed(U), { listed: false, types: [] });
  fakeRunner(() => out([{ udid: 'other', type: 'USB' }, null]));
  assert.deepEqual(phone.usbmuxListed(U), { listed: false, types: [] });
  fakeRunner(() => ({ stdout: 'MSL_USBMUX:{}\n' }));
  assert.match(phone.usbmuxListed(U).error, /unreadable/);
  fakeRunner(() => ({ stdout: 'nothing useful' }));
  assert.match(phone.usbmuxListed(U).error, /unreadable/);
  fakeRunner(() => ({ code: 1, stderr: `Cannot find module 'appium-ios-device' for ${U}` }));
  const failed = phone.usbmuxListed(U);
  assert.equal(failed.listed, false);
  assert.match(failed.error, /Cannot find module/);
  assert.equal(failed.error.includes(U), false, 'ids are redacted');
});

// --- signing expiry ---

function wdaBuild(withProfile = true) {
  const dd = path.join(process.env.MSL_APPIUM_HOME, 'wda-device');
  const app = path.join(dd, 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app');
  fs.mkdirSync(app, { recursive: true });
  if (withProfile) fs.writeFileSync(path.join(app, 'embedded.mobileprovision'), 'binary');
  return { dd, profile: path.join(app, 'embedded.mobileprovision') };
}
const plist = date => `<?xml version="1.0"?><plist><dict><key>CreationDate</key><date>2026-10-09T12:00:00Z</date><key>ExpirationDate</key>\n<date>${date}</date></dict></plist>`;

test('wdaDerivedData sits under the Appium home, apart from the simulator build', () => {
  assert.equal(phone.wdaDerivedData(), path.join(process.env.MSL_APPIUM_HOME, 'wda-device'));
});

test('profileExpiry reads ExpirationDate through security cms', () => {
  const { dd, profile } = wdaBuild();
  const calls = fakeRunner(() => ({ stdout: plist('2026-10-23T12:00:00Z') }));
  assert.equal(phone.profileExpiry(dd), '2026-10-23T12:00:00.000Z');
  assert.deepEqual(calls[0], ['security', 'cms', '-D', '-i', profile]);
  assert.equal(phone.profileExpiry(), '2026-10-23T12:00:00.000Z', 'defaults to the lab WDA build');
});

test('profileExpiry is null with no build, no profile, a failing security, or a bad date', () => {
  const calls = fakeRunner(() => ({ stdout: plist('2026-10-23T12:00:00Z') }));
  assert.equal(phone.profileExpiry(path.join(tempDir(), 'none')), null);
  const { dd } = wdaBuild(false);
  assert.equal(phone.profileExpiry(dd), null);
  assert.equal(calls.length, 0, 'security is not run without a profile');
  wdaBuild();
  fakeRunner(() => ({ code: 1 }));
  assert.equal(phone.profileExpiry(dd), null);
  fakeRunner(() => ({ stdout: plist('not a date') }));
  assert.equal(phone.profileExpiry(dd), null);
  fakeRunner(() => ({ stdout: '<plist></plist>' }));
  assert.equal(phone.profileExpiry(dd), null);
});

test('needsResign and hoursLeft use the given clock', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const at = h => new Date(now + h * 3600e3).toISOString();
  assert.equal(phone.needsResign({ wdaExpires: at(25) }, now), false);
  assert.equal(phone.needsResign({ wdaExpires: at(24.01) }, now), false);
  assert.equal(phone.needsResign({ wdaExpires: at(23) }, now), true);
  assert.equal(phone.needsResign({ wdaExpires: at(-1) }, now), true);
  assert.equal(phone.needsResign({ wdaExpires: at(100) }, now, true), true, 'forced');
  for (const rec of [undefined, {}, { wdaExpires: null }, { wdaExpires: 'garbage' }]) assert.equal(phone.needsResign(rec, now), true, JSON.stringify(rec));
  assert.equal(phone.hoursLeft(at(30.04), now), 30);
  assert.equal(phone.hoursLeft(at(-2), now), -2);
  assert.equal(phone.hoursLeft(null, now), null);
  assert.equal(phone.hoursLeft('garbage', now), null);
});

// --- classifier ---

test('classify: failure text -> needs', () => {
  const table = [
    ['Unknown device or simulator UDID: 00008000-000A1B2C3D4E5F60', 'cable'],
    ['ERROR: The operation couldn’t be completed. (CoreDeviceError error 4016 - The device is not able to fulfill the requested usage assertion requirements.)', 'cable'],
    [fixture('lock-offline-stderr.txt'), 'cable'],
    ['Network.NWError error 60 - Operation timed out', 'cable'],
    ['devicectl lockState timed out after 20s', 'cable'],
    ['Timed out while enabling automation mode', 'passcode'],
    ['WebDriverAgent failed: Timed out while enabling automation mode.', 'passcode'],
    ['{ "passcodeRequired" : true }', 'unlock'],
    ['Unable to launch com.apple.mobilesafari because the device was not, or could not be, unlocked', 'unlock'],
    ['the device is locked', 'unlock'],
    ['Developer Mode is disabled on this device', 'developer-mode'],
    ['You must enable Developer Mode to run apps', 'developer-mode'],
    ['The request was denied: the profile has not been explicitly trusted by the user', 'trust'],
    ['Untrusted Developer: your device management settings', 'trust'],
    ['No Account for Team "ABCDE12345". Add a new account in Accounts settings', 'xcode-account'],
    ['error: No signing certificate "iOS Development" found', 'xcode-account'],
    ['This team has been banned', 'xcode-account'],
    ['Failed Registering Bundle Identifier', 'xcode-account'],
    ['Error Domain=MIInstallerErrorDomain Code=13 "0xe8008018 (The identity used to sign the executable is no longer valid.)"', 'resign'],
    ['kAMDInvalidProvisioningProfile 0xe8008024', 'resign'],
    ['The provisioning profile has expired', 'resign'],
    ['codesign failed: errSecInternalComponent', 'keychain'],
    ['User interaction is not allowed.', 'keychain'],
    ['Command CodeSign failed: the keychain is locked', 'keychain'],
    ['maximum number of apps for free development profiles has been reached', 'slots'],
    ['You cannot register more than 10 App IDs within a 7 day period', 'slots'],
    [fixture('coredevice-4000-stderr.txt'), 'cable'],
    ['CoreDeviceError error 4000', 'cable'],
    ['ERROR: The device is not available. (com.apple.dt.CoreDeviceError error 4016 (0xFB0))', 'cable'],
    ['Internal logic error: Connection was invalidated (com.apple.CoreDevice.ControlChannelConnectionError error 1)', 'cable'],
    ['something nobody has seen before', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [text, needs] of table) assert.equal(phone.classify(text), needs, String(text).slice(0, 70));
});

test('classify prefers the actionable cause when texts are combined', () => {
  assert.equal(phone.classify('xcodebuild: Timed out while enabling automation mode ... NWError error 60'), 'passcode');
  assert.equal(phone.classify('device is locked; Operation timed out; NWError 60'), 'unlock');
});

// --- needs errors ---

test('needsError carries needs, steps, the follow-up command and the simulator way out', () => {
  for (const needs of Object.keys(phone.NEEDS)) {
    const e = phone.needsError(needs, 'boom');
    assert.equal(e.message, 'boom');
    assert.equal(e.extra.needs, needs);
    assert.equal(Array.isArray(e.extra.human) && e.extra.human.length > 0, true, needs);
    assert.equal(typeof e.extra.then, 'string', needs);
    assert.equal(e.extra.or, needs === 'resign' ? 'lab phone setup --udid <UDID> --team <ID>' : 'lab up --target simulator');
    assert.equal(e.extra.simulator ?? 'lab up --target simulator', 'lab up --target simulator');
  }
  const resign = phone.needsError('resign', 'x').extra;
  assert.match(resign.human.join(' '), /If a re-sign doesn't fix it, Apple is rejecting this team: run `lab phone setup` with another team\./);
  assert.equal(resign.then, 'lab up --target device --resign');
  assert.equal(resign.simulator, 'lab up --target simulator');
  const service = phone.needsError('service', 'x').extra;
  assert.match(service.human.join(' '), /Appium isn't running with up-to-date log redaction/);
  assert.equal(service.then, 'lab service install');
  assert.throws(() => phone.needsError('nonsense', 'x'), /unknown needs value/);
  // A "tab" failure that ended the run's trust in the phone has its own steps: a switch back can't fix it.
  const hidden = phone.needsError('tab', 'x').extra;
  const lost = phone.needsError('tab', 'x', { tainted: true }).extra;
  assert.match(hidden.human.join(' '), /Switch back to the lab's tab/);
  assert.doesNotMatch(lost.human.join(' '), /Switch back/);
  assert.match(lost.human.join(' '), /Run `safari start`.*fresh tab\. Close the old lab tab on the phone by hand/);
  assert.equal(lost.needs, 'tab');
  assert.equal(lost.then, hidden.then);
  assert.equal(phone.needsError('cable', 'x', { tainted: true }).extra.human.join(), phone.NEEDS.cable.human.join(), 'only a tab failure has a tainted form');
  const e = phone.needsError('cable', `phone ${U} at Test-iPhone.coredevice.local\nfailed`);
  assert.equal(e.message, 'phone <udid> at <host> failed');
  e.extra.human.push('mutated');
  assert.equal(phone.NEEDS.cable.human.includes('mutated'), false, 'steps are copied');
});

test('a trust whose evidence is the developer profile gives only the VPN & Device Management step', () => {
  const profileOnly = phone.NEEDS.trust.human.slice(1);
  assert.equal(profileOnly.length, 1);
  assert.match(profileOnly[0], /VPN & Device Management/);
  for (const text of ['the profile has not been explicitly trusted by the user', 'Unable to launch: the Developer App Certificate is not trusted', 'Untrusted Developer']) {
    assert.equal(phone.classify(text), 'trust', text);
    assert.deepEqual(phone.needsError('trust', text).extra.human, profileOnly, text);
  }
  // `evidence` is what the need was read from when the message is not it (a log's tail).
  assert.deepEqual(phone.needsError('trust', 'xcodebuild failed with code 65', { evidence: 'profile has not been explicitly trusted' }).extra.human, profileOnly);
  // Anything else under trust keeps both steps, including a profile text that also asks for the Mac's trust.
  assert.deepEqual(phone.needsError('trust', 'unpaired').extra.human, phone.NEEDS.trust.human);
  assert.deepEqual(phone.needsError('trust', 'x', { evidence: 'has not been explicitly trusted; Trust This Computer' }).extra.human, phone.NEEDS.trust.human);
  assert.equal(phone.NEEDS.trust.human.length, 2, 'the table itself is unchanged');
});

// --- target selection ---

const REC = { udid: U, teamId: TEAM, bundleId: 'com.example.wda', wdaExpires: null };
const status = over => ({ udid: U, found: true, transport: 'cable', developerMode: true, locked: false, usbmux: true, reachable: true, ...over });
const choose = args => { try { return phone.chooseTarget(args); } catch (e) { return e; } };

test('chooseTarget: auto', () => {
  assert.equal(choose({ phone: undefined }).target, 'simulator');
  assert.equal(choose({ flag: 'auto', phone: undefined }).target, 'simulator');
  assert.equal(choose({ phone: REC, status: status() }).target, 'device');
  assert.equal(choose({ flag: 'auto', phone: REC, status: status({ transport: 'wifi' }) }).target, 'device');

  const gone = choose({ phone: REC, status: status({ reachable: false, found: false, needs: 'cable', error: 'not listed' }) });
  assert.equal(gone.extra.needs, 'cable');
  assert.equal(gone.extra.or, 'lab up --target simulator');
  assert.equal(choose({ phone: REC, status: status({ reachable: true, locked: true }) }).extra.needs, 'unlock');
  assert.equal(choose({ phone: REC, status: status({ developerMode: false }) }).extra.needs, 'developer-mode');
  assert.equal(choose({ phone: REC, status: status({ reachable: false, needs: undefined }) }).extra.needs, 'cable');
  assert.equal(choose({ phone: REC, status: status({ reachable: false, needs: 'trust', error: 'unpaired' }) }).extra.needs, 'trust');
});

test('chooseTarget: explicit device and simulator', () => {
  assert.equal(choose({ flag: 'simulator', phone: REC, status: status({ reachable: false }) }).target, 'simulator');
  assert.equal(choose({ flag: 'simulator', phone: undefined }).target, 'simulator');
  assert.equal(choose({ flag: 'device', phone: REC, status: status() }).target, 'device');
  assert.equal(choose({ flag: 'device', phone: undefined }).extra.needs, 'setup');
  assert.equal(choose({ flag: 'device', phone: REC, status: status({ reachable: false, needs: 'cable' }) }).extra.needs, 'cable');
  assert.equal(choose({ flag: 'device', phone: REC, status: status({ locked: true }) }).extra.needs, 'unlock');
});

test('chooseTarget rejects bad input', () => {
  assert.match(choose({ flag: 'phone', phone: REC, status: status() }).message, /--target must be one of auto, device, simulator/);
  assert.match(choose({ phone: REC }).message, /needs its phoneStatus/);
});

// --- the run's tab ---

test('newTabTag makes msl-<8 hex>', () => {
  assert.match(phone.newTabTag(), /^msl-[0-9a-f]{8}$/);
  assert.notEqual(phone.newTabTag(), phone.newTabTag());
});

test('openTab launches Safari on the saved phone at a tagged page, restarting Safari', () => {
  const calls = fakeRunner(devicectl({ launch: {} }));
  assert.deepEqual(phone.openTab(U, 'msl-0a1b2c3d'), { tag: 'msl-0a1b2c3d', url: 'https://example.com/?msl-0a1b2c3d' });
  assert.deepEqual(calls[0].slice(0, 11), ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', U, '--terminate-existing', '--payload-url', 'https://example.com/?msl-0a1b2c3d', 'com.apple.mobilesafari']);
  assert.equal(calls[0][11], '--json-output');
});

test('openTab validates, and failures become needs errors', () => {
  fakeRunner(devicectl({ launch: {} }));
  assert.throws(() => phone.openTab('booted', 'msl-0a1b2c3d'), /not a device UDID/);
  assert.throws(() => phone.openTab(U, 'msl-xyz'), /not msl-<8 hex>/);
  assert.throws(() => phone.openTab(U, 'x https://evil.example'), /not msl-<8 hex>/);

  fakeRunner(devicectl({ launch: { code: 1, stderr: 'Unable to launch com.apple.mobilesafari because the device was not, or could not be, unlocked' } }));
  assert.throws(() => phone.openTab(U, 'msl-0a1b2c3d'), e => e.extra.needs === 'unlock' && e.extra.or === 'lab up --target simulator');

  fakeRunner(devicectl({ launch: { code: 124, stderr: 'timed out after 120s' } }));
  assert.throws(() => phone.openTab(U, 'msl-0a1b2c3d'), e => e.extra.needs === 'cable');

  fakeRunner(devicectl({ launch: { code: 1, stderr: 'strange failure' } }));
  assert.throws(() => phone.openTab(U, 'msl-0a1b2c3d'), e => e.extra.needs === 'unknown' && /strange failure/.test(e.message));
});

test('readPhone checks the shape of the record', () => {
  assert.equal(phone.readPhone({}), null);
  assert.equal(phone.readPhone({ phone: null }), null);
  assert.equal(phone.readPhone({ phone: { udid: U, teamId: TEAM, bundleId: 'com.dividedby.msl-wda-abcd', wdaExpires: '2026-10-23T12:00:00.000Z' } }).bundleId, 'com.dividedby.msl-wda-abcd');
  for (const bad of ['x', [], {}, { udid: U, teamId: TEAM }, { udid: 'no', teamId: TEAM, bundleId: 'com.dividedby.msl-wda-abcd' }, { udid: U, teamId: 'low', bundleId: 'com.dividedby.msl-wda-abcd' },
    { udid: U, teamId: TEAM, bundleId: 'nodots' }, { udid: U, teamId: TEAM, bundleId: 'com.dividedby.msl-wda-abcd', wdaExpires: 'soon' }]) {
    assert.throws(() => phone.readPhone({ phone: bad }), /damaged/, JSON.stringify(bad));
  }
});

test('readPhone checks the optional seen record, and withSeen writes one only for a known version', () => {
  const base = { udid: U, teamId: TEAM, bundleId: 'com.dividedby.msl-wda-abcd' };
  const seen = { osVersion: '27.0.1', buildVersion: '24A446', at: '2026-10-18T12:00:00.000Z' };
  assert.deepEqual(phone.readPhone({ phone: { ...base, seen } }).seen, seen);
  assert.equal(phone.readPhone({ phone: { ...base, seen: { ...seen, buildVersion: null } } }).seen.buildVersion, null);
  for (const bad of ['x', [], null, {}, { ...seen, osVersion: '27' }, { ...seen, osVersion: 27.1 }, { ...seen, osVersion: '27.0; x' },
    { ...seen, buildVersion: 'no way!' }, { ...seen, buildVersion: 5 }, { osVersion: seen.osVersion, at: seen.at }, { ...seen, at: 'yesterday' }, { ...seen, at: undefined }]) {
    assert.throws(() => phone.readPhone({ phone: { ...base, seen: bad } }), /damaged/, JSON.stringify(bad));
  }

  const now = Date.parse('2026-10-18T12:00:00.000Z');
  assert.deepEqual(phone.withSeen(base, { osVersion: '27.0.1', buildVersion: '24A446' }, now), { ...base, seen });
  assert.deepEqual(phone.withSeen(base, { osVersion: '27.0.1', buildVersion: null }, now).seen, { ...seen, buildVersion: null });
  const had = { ...base, seen };
  assert.equal(phone.withSeen(had, { osVersion: null, buildVersion: null }, now), had, 'no version read: the last one stays');
});

test('seen records how the phone was last reached: tunnel or usbmux, none in an old record; a phone that was not reached keeps the last way', () => {
  const base = { udid: U, teamId: TEAM, bundleId: 'com.dividedby.msl-wda-abcd' };
  const seen = { osVersion: '27.0.1', buildVersion: '24A446', at: '2026-10-18T12:00:00.000Z' };
  assert.equal(phone.readPhone({ phone: { ...base, seen } }).seen.via, undefined, 'an old record is still valid');
  for (const via of ['tunnel', 'usbmux']) assert.equal(phone.readPhone({ phone: { ...base, seen: { ...seen, via } } }).seen.via, via);
  for (const bad of ['wifi', 'cable', null, 5, '']) {
    assert.throws(() => phone.readPhone({ phone: { ...base, seen: { ...seen, via: bad } } }), /damaged/, JSON.stringify(bad));
  }
  const now = Date.parse(seen.at);
  assert.equal(phone.withSeen(base, { osVersion: '27.0.1', buildVersion: '24A446', via: 'tunnel' }, now).seen.via, 'tunnel');
  assert.equal(phone.withSeen(base, { osVersion: '27.0.1', buildVersion: '24A446', via: 'usbmux' }, now).seen.via, 'usbmux');
  assert.equal('via' in phone.withSeen(base, { osVersion: '27.0.1', buildVersion: '24A446', via: null }, now).seen, false, 'never reached, never said');
  const wifi = { ...base, seen: { ...seen, via: 'tunnel' } };
  assert.equal(phone.withSeen(wifi, { osVersion: '27.0.2', buildVersion: null, via: null }, now).seen.via, 'tunnel', 'listed but not reached: the last way stays');
  assert.equal(phone.withSeen(wifi, { osVersion: '27.0.2', buildVersion: null, via: 'usbmux' }, now).seen.via, 'usbmux', 'reached another way: that way');
});

test('withRoute: a phone that is gone and was last reached over Wi-Fi needs tunnel, not cable; every other case is left as it is', () => {
  const gone = { reachable: false, transport: 'wifi', needs: 'cable', error: 'devicectl lockState timed out after 20s' };
  const wifi = { seen: { osVersion: '27.0.1', buildVersion: null, at: '2026-10-18T12:00:00.000Z', via: 'tunnel' } };
  const out = phone.withRoute(gone, wifi);
  assert.equal(out.needs, 'tunnel');
  assert.match(out.error, /^devicectl lockState timed out after 20s \(last reached over Wi-Fi\)$/);
  assert.equal(phone.withRoute({ ...gone, found: false, transport: 'unknown', error: undefined }, wifi).error, 'the phone is not reachable (last reached over Wi-Fi)');
  assert.equal(phone.withRoute(gone, { seen: { ...wifi.seen, via: 'usbmux' } }), gone, 'last seen on the cable');
  assert.equal(phone.withRoute(gone, { seen: { ...wifi.seen, via: undefined } }), gone, 'an old record');
  assert.equal(phone.withRoute(gone, {}), gone, 'never seen');
  assert.equal(phone.withRoute(gone, null), gone);
  assert.equal(phone.withRoute({ ...gone, transport: 'cable' }, wifi).needs, 'cable', 'listed on the cable now');
  for (const other of [{ ...gone, needs: 'trust' }, { ...gone, needs: 'unlock' }, { ...gone, reachable: true, needs: undefined }]) assert.equal(phone.withRoute(other, wifi), other);
  assert.equal(phone.withRoute(null, wifi), null);
});


test('the cable steps offer Wi-Fi after a cable pairing, with no Xcode or Finder setting', () => {
  const human = phone.needsError('cable', 'x').extra.human.join(' ');
  assert.match(human, /paired over the cable, put it on the same Wi-Fi network as the Mac/);
  assert.doesNotMatch(human, /Connect via network|Finder|Show this iPhone/);
});

test('needs tunnel-tool and tunnel say what to do, in these words', () => {
  const tool = phone.needsError('tunnel-tool', 'x').extra;
  assert.deepEqual(tool.human, [
    'Wi-Fi needs the pymobiledevice3 tool, version 11.40.2 or newer, and it is missing or too old.',
    'Run `brew install uv` if uv is not installed, then `uv tool install --python 3.14 pymobiledevice3` (to upgrade: `uv tool upgrade pymobiledevice3`).',
    'Or connect the phone with a cable.',
  ]);
  assert.equal(tool.then, 'lab up --target device');
  const tun = phone.needsError('tunnel', 'x').extra;
  assert.deepEqual(tun.human, [
    'The Mac could not open a route to the phone over Wi-Fi: no tunnel within 45 s, it dropped, or it reached another device.',
    'Unlock the phone and keep it on the same Wi-Fi network as the Mac. If the error names a refused, timed-out or no-route connection, check for a VPN, a different network or band, or the phone\'s Wi-Fi asleep.',
    'Run the command below again, or connect the phone with a cable.',
  ]);
  assert.equal(tun.then, 'lab up --target device');
});
