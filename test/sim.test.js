import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, tempDir, fakeRunner, fakePng } from './helpers.js';
import { cli, loadState, saveState, newRun, pruneRuns, runsRoot, setRunner } from '../lib/core.js';
import { handlers as sim, BOOT_CHUNK_MS, isUnwarmed, markUnwarmed, markWarmed, pickDevice, screenWidth, setPause, simState, simInfo, bootSim, deviceSession, refuseOnDevice, udid as simUdid, configuredRecord, yieldTo, checkProfileArg } from '../lib/sim.js';
import { INSTALL_HINT, registryModule } from '../lib/appium.js';
import { InterruptError, withInterrupt } from '../lib/interrupt.js';

const U = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
const LIST = {
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6', name: 'iOS 18.6', isAvailable: true,
      supportedDeviceTypes: [{ name: 'iPhone 16', identifier: 'iPhone-16', productFamily: 'iPhone' }] },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2', name: 'iOS 26.2', isAvailable: true,
      supportedDeviceTypes: [
        { name: 'iPhone 16e', identifier: 'iPhone-16e', productFamily: 'iPhone' },
        { name: 'iPhone 17 Pro', identifier: 'iPhone-17-Pro', productFamily: 'iPhone' },
        { name: 'iPad Pro', identifier: 'iPad-Pro', productFamily: 'iPad' }] },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0', name: 'watchOS 26', isAvailable: true, supportedDeviceTypes: [] },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', name: 'iOS 27.0', isAvailable: false, supportedDeviceTypes: [] },
  ],
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ name: 'iPhone 17 Pro', udid: 'AAAAAAAA-0000-4000-8000-000000000000', isAvailable: true }] },
};

// An Appium home that has remotexpc's tunnel registry (doctor checks for it).
function appiumHomeWithRegistry() {
  const home = tempDir('msl-appium-');
  process.env.MSL_APPIUM_HOME = home;
  fs.mkdirSync(path.dirname(registryModule()), { recursive: true });
  fs.writeFileSync(registryModule(), '');
  return home;
}
beforeEach(() => { sandbox(); setPause(() => {}); appiumHomeWithRegistry(); });

test('create picks the newest available iOS runtime and its newest iPhone, and saves the UDID', async () => {
  const calls = fakeRunner((_cmd, args) => {
    if (args[1] === 'list') return { stdout: JSON.stringify(LIST) };
    if (args[1] === 'create') return { stdout: U + '\n' };
  });
  const out = await sim.create([]);
  assert.deepEqual(calls[1], ['xcrun', 'simctl', 'create', 'Claude iPhone', 'iPhone-17-Pro', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2']);
  assert.equal(out.udid, U);
  assert.equal(loadState().udid, U);
});

test('create reuses the saved or same-named simulator instead of making another', async () => {
  const list = structuredClone(LIST);
  list.devices['com.apple.CoreSimulator.SimRuntime.iOS-26-2'].push({ name: 'Claude iPhone', udid: U, isAvailable: true });
  const calls = fakeRunner(() => ({ stdout: JSON.stringify(list) }));
  assert.equal((await sim.create([])).created, false);
  assert.equal(calls.length, 1);
  assert.equal(loadState().udid, U);
});

test('pickDevice explains a missing runtime or type', () => {
  assert.throws(() => pickDevice({ runtimes: [] }), /downloadPlatform/);
  assert.throws(() => pickDevice(LIST, 'iPhone 3G'), /No device type/);
  assert.equal(pickDevice(LIST, 'iPhone 16e').deviceType.identifier, 'iPhone-16e');
});

const types = names => names.map(name => ({ name, identifier: name.replace(/ /g, '-'), productFamily: 'iPhone' }));
const listOf = names => ({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', name: 'iOS 27.0', isAvailable: true, supportedDeviceTypes: types(names) }] });

test('pickDevice takes the highest model number whatever order Apple lists them in', () => {
  const names = ['iPhone 11', 'iPhone SE (3rd generation)', 'iPhone 16e', 'iPhone 17', 'iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone Air', 'iPhone 16 Pro'];
  const pick = list => pickDevice(list).deviceType.name;
  assert.equal(pick(listOf(names)), 'iPhone 17 Pro'); // oldest first
  assert.equal(pick(listOf([...names].reverse())), 'iPhone 17 Pro'); // newest first (Xcode 27)
  assert.equal(pick(listOf([names[4], names[0], names[3], names[7], names[5], names[1]])), 'iPhone 17 Pro'); // shuffled
  assert.equal(pick(listOf(['iPhone 17', 'iPhone 17 Pro Max', 'iPhone 17 Plus'])), 'iPhone 17');
  assert.equal(pick(listOf(['iPhone 17e', 'iPhone 17 Pro Max'])), 'iPhone 17 Pro Max');
  assert.equal(pick(listOf(['iPhone SE (3rd generation)', 'iPhone 11'])), 'iPhone 11');
});

test('commands need a created simulator and always pass its UDID, never "booted"', () => {
  const calls = fakeRunner();
  assert.throws(() => sim.open(['https://example.com']), /sim create/);
  saveState({ udid: U });
  sim.open(['https://example.com/a?b=1']);
  sim.tap(['--label', 'Address']);
  sim.tap(['10', '20']);
  sim.type(['hello world']);
  sim.scroll(['down']);
  sim.appearance(['dark']);
  sim.swipe(['1', '2', '3', '4']);
  assert.deepEqual(calls, [
    ['xcrun', 'simctl', 'openurl', U, 'https://example.com/a?b=1'],
    ['axe', 'tap', '--label', 'Address', '--tap-style', 'physical', '--udid', U],
    ['axe', 'tap', '-x', '10', '-y', '20', '--tap-style', 'physical', '--udid', U],
    ['axe', 'type', 'hello world', '--udid', U],
    ['axe', 'gesture', 'scroll-down', '--udid', U],
    ['xcrun', 'simctl', 'ui', U, 'appearance', 'dark'],
    ['axe', 'swipe', '--start-x', '1', '--start-y', '2', '--end-x', '3', '--end-y', '4', '--udid', U],
  ]);
  assert.ok(!calls.flat().includes('booted'));
});

test('run.log lines from sim have secret query parameters masked', () => {
  saveState({ udid: U });
  fakeRunner();
  sim.open(['https://example.com/cb?token=SECRETTOKEN&a=1']);
  const logText = fs.readFileSync(path.join(loadState().run, 'run.log'), 'utf8');
  assert.match(logText, /sim open https:\/\/example\.com\/cb\?token=\[redacted\]&a=1/);
  assert.ok(!logText.includes('SECRET'));
});

test('bad arguments are refused before anything runs', () => {
  const calls = fakeRunner();
  saveState({ udid: U });
  assert.throws(() => sim.open(['file:///etc/passwd']), /usage/);
  assert.throws(() => sim.open(['--help']), /usage/);
  assert.throws(() => sim.appearance(['blue']), /usage/);
  assert.throws(() => sim.scroll(['sideways']), /usage/);
  assert.throws(() => sim.tap(['x']), /usage/);
  assert.throws(() => sim.swipe(['1', '2']), /usage/);
  assert.equal(calls.length, 0);
});

// Fakes `xcode-select -p` as a temp Xcode with the given apps under it.
function fakeXcode({ simulator = false, deviceHub = false } = {}) {
  const root = tempDir('msl-xcode-');
  const dev = path.join(root, 'Contents', 'Developer');
  fs.mkdirSync(dev, { recursive: true });
  if (simulator) fs.mkdirSync(path.join(dev, 'Applications', 'Simulator.app'), { recursive: true });
  if (deviceHub) fs.mkdirSync(path.join(root, 'Contents', 'Applications', 'DeviceHub.app'), { recursive: true });
  return dev;
}
const bootCalls = (dev, extra = () => undefined) => fakeRunner((cmd, a) => cmd === 'xcode-select' ? { stdout: dev + '\n' } : extra(cmd, a));

test('boot tolerates an already-booted simulator but not other failures', async () => {
  saveState({ udid: U });
  let calls = bootCalls(fakeXcode({ simulator: true }), (_c, a) => a[1] === 'boot' ? { code: 149, stderr: 'Unable to boot device in current state: Booted' } : undefined);
  assert.equal((await sim.boot()).booted, true);
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['xcrun', 'simctl', 'boot'], ['xcode-select', '-p'], ['osascript', '-e', 'application id "com.apple.iphonesimulator" is running'], ['open', '-a', 'Simulator'], ['xcrun', 'simctl', 'bootstatus']]);
  calls = fakeRunner((_c, a) => a[1] === 'boot' ? { code: 1, stderr: 'Invalid device' } : undefined);
  await assert.rejects(sim.boot(), /Invalid device/);
});

test('boot opens Simulator.app when Xcode has it', async () => {
  saveState({ udid: U });
  const calls = bootCalls(fakeXcode({ simulator: true, deviceHub: true }));
  assert.equal((await sim.boot()).window, 'Simulator');
  assert.deepEqual(calls.at(-2), ['open', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', U]);
  assert.deepEqual(calls.at(-1), ['xcrun', 'simctl', 'bootstatus', U, '-b']);
});

test('boot opens Device Hub on Xcode 27, which has no Simulator.app', async () => {
  saveState({ udid: U });
  const calls = bootCalls(fakeXcode({ deviceHub: true }));
  assert.equal((await sim.boot()).window, 'Device Hub');
  assert.deepEqual(calls.at(-2), ['open', '-b', 'com.apple.dt.Devices']);
  assert.deepEqual(calls.at(-1), ['xcrun', 'simctl', 'bootstatus', U, '-b']);
});

test('boot records the window app in the state only when it opened it (it was not running)', async () => {
  saveState({ udid: U });
  const running = answer => (cmd, a) => cmd === 'osascript' && a[1].includes('is running') ? { stdout: answer } : undefined;
  bootCalls(fakeXcode({ simulator: true, deviceHub: true }), running('false\n'));
  assert.equal((await sim.boot()).window, 'Simulator');
  assert.equal(loadState().windowApp, 'Simulator');

  // Already recorded as ours: still ours while it runs (a second boot reuses the window).
  bootCalls(fakeXcode({ simulator: true }), running('true\n'));
  await sim.boot();
  assert.equal(loadState().windowApp, 'Simulator');

  // A person's own Device Hub, or one we can't tell about, is never recorded.
  for (const answer of ['true\n', '', 'maybe\n']) {
    saveState({ windowApp: null });
    const calls = bootCalls(fakeXcode({ deviceHub: true }), running(answer));
    assert.equal((await sim.boot()).window, 'Device Hub');
    assert.deepEqual(calls.find(c => c[0] === 'osascript'), ['osascript', '-e', 'application id "com.apple.dt.Devices" is running']);
    assert.equal(loadState().windowApp, undefined, answer);
  }
  saveState({ windowApp: null });
  bootCalls(fakeXcode({ deviceHub: true }), running('false\n'));
  await sim.boot();
  assert.equal(loadState().windowApp, 'Device Hub');

  // The first record stays: another app opened later doesn't replace it.
  bootCalls(fakeXcode({ simulator: true }), running('false\n'));
  assert.equal((await sim.boot()).window, 'Simulator');
  assert.equal(loadState().windowApp, 'Device Hub');
});

test('boot without any window app, or when open fails, still waits for the boot', async () => {
  saveState({ udid: U });
  const err = console.error;
  const notes = [];
  console.error = m => notes.push(m);
  try {
    let calls = bootCalls(fakeXcode());
    assert.equal((await sim.boot()).window, null);
    assert.ok(!calls.some(c => c[0] === 'open'));
    assert.deepEqual(calls.at(-1), ['xcrun', 'simctl', 'bootstatus', U, '-b']);
    calls = bootCalls(fakeXcode({ deviceHub: true }), cmd => cmd === 'open' ? { code: 1, stderr: 'no such app' } : undefined);
    assert.equal((await sim.boot()).window, null);
    assert.deepEqual(calls.at(-1), ['xcrun', 'simctl', 'bootstatus', U, '-b']);
  } finally { console.error = err; }
  assert.equal(notes.length, 2);
  assert.match(notes[0], /couldn't open a window/);
  assert.match(notes[1], /no such app/);
});

test('AXe is retried when it times out creating its session, and only then', () => {
  saveState({ udid: U });
  const pauses = [];
  setPause(ms => pauses.push(ms));
  let n = 0;
  let calls = fakeRunner(cmd => cmd === 'axe' && ++n <= 2 ? { code: 1, stderr: 'Error: Timed out creating the simulator remote automation session' } : undefined);
  sim.tap(['--label', 'Address']);
  assert.equal(calls.length, 3);
  assert.deepEqual(pauses, [2000, 2000]);

  calls = fakeRunner(cmd => cmd === 'axe' ? { code: 1, stderr: 'No translation object returned for simulator' } : undefined);
  assert.throws(() => sim.scroll(['down']), /axe gesture failed \(exit 1\): No translation object/);
  assert.equal(calls.length, 4); // gives up after 4 attempts

  calls = fakeRunner(cmd => cmd === 'axe' ? { code: 1, stderr: 'Element not found' } : undefined);
  assert.throws(() => sim.tap(['--label', 'Nope']), /axe tap failed.*Element not found/);
  assert.equal(calls.length, 1); // not transient: no retry
});

test('shot saves into the run folder and records the pixel scale; tap --px uses it', () => {
  saveState({ udid: U });
  const calls = fakeRunner((cmd, args) => {
    if (args[1] === 'io') fakePng(args.at(-1), 1206, 2622);
    if (cmd === 'axe' && args[0] === 'describe-ui') return { stdout: JSON.stringify([{ frame: { x: 0, y: 0, width: 402, height: 874 }, children: [] }]) };
  });
  const out = sim.shot(['home']);
  assert.match(out.file, /home\.png$/);
  assert.equal(path.dirname(out.file), loadState().run);
  assert.deepEqual([out.width, out.height, out.scale], [1206, 2622, 3]);
  sim.tap(['603', '300', '--px']);
  assert.deepEqual(calls.at(-1), ['axe', 'tap', '-x', '201', '-y', '100', '--tap-style', 'physical', '--udid', U]);
  assert.match(sim.shot(['home']).file, /home-2\.png$/);
});

test('shot saves the width the scale was measured at, and reuses the scale only for a screenshot of that width when AXe can\'t be read', () => {
  saveState({ udid: U });
  let axeUp = true;
  let w = 1206;
  fakeRunner((cmd, args) => {
    if (args[1] === 'io') fakePng(args.at(-1), w, 2622);
    if (cmd === 'axe' && args[0] === 'describe-ui') return axeUp ? { stdout: JSON.stringify([{ frame: { x: 0, y: 0, width: 402, height: 874 }, children: [] }]) } : { code: 1, stderr: 'Error: Timed out creating the simulator remote automation session' };
  });
  const err = console.error;
  console.error = () => {};
  try {
    // No saved scale and AXe down: null with a note to retry.
    axeUp = false;
    const none = sim.shot(['a']);
    assert.equal(none.scale, null);
    assert.match(none.note, /retry `sim shot`/);
    assert.equal(loadState().scale, undefined);

    axeUp = true;
    const read = sim.shot(['b']);
    assert.equal(read.scale, 3);
    assert.equal(read.note, undefined);
    assert.deepEqual([loadState().scale, loadState().scaleWidth], [3, 1206]);

    // AXe down again, same width: the saved scale.
    axeUp = false;
    const kept = sim.shot(['c']);
    assert.equal(kept.scale, 3);
    assert.equal(kept.note, undefined);

    // A different width (another device): null with the note, and the saved scale untouched.
    w = 1170;
    const other = sim.shot(['d']);
    assert.equal(other.scale, null);
    assert.match(other.note, /retry `sim shot`/);
    assert.deepEqual([loadState().scale, loadState().scaleWidth], [3, 1206]);
  } finally { console.error = err; }
});

test('stderr warnings from sim mask device ids', async () => {
  saveState({ udid: U });
  fakeRunner((cmd, args) => {
    if (args[1] === 'io') fakePng(args.at(-1), 1206, 2622);
    if (cmd === 'axe' && args[0] === 'describe-ui') return { code: 1, stderr: 'no such device 00008000-000A1B2C3D4E5F60' };
  });
  const err = console.error;
  const notes = [];
  console.error = m => notes.push(m);
  try { sim.shot(['home']); } finally { console.error = err; }
  assert.equal(notes.length, 1);
  assert.match(notes[0], /couldn't read the screen size from AXe/);
  assert.doesNotMatch(notes[0], /00008000-000A1B2C3D4E5F60/);
  assert.match(notes[0], /…5F60/);
  const win = [];
  console.error = m => win.push(m);
  try {
    bootCalls(fakeXcode({ deviceHub: true }), cmd => cmd === 'open' ? { code: 1, stderr: 'cannot open 00008000-000A1B2C3D4E5F60' } : undefined);
    await sim.boot();
  } finally { console.error = err; }
  assert.equal(win.length, 1);
  assert.doesNotMatch(win[0], /00008000-000A1B2C3D4E5F60/);
  assert.match(win[0], /…5F60/);
});

test('tap --px without a screenshot first says so', () => {
  saveState({ udid: U });
  fakeRunner();
  assert.throws(() => sim.tap(['1', '2', '--px']), /sim shot/);
});

test('ui saves the tree and lists its labels', () => {
  saveState({ udid: U });
  const tree = [{ frame: { width: 402 }, AXLabel: 'Safari', children: [{ AXLabel: 'Address', children: [{ AXLabel: ' ' }, { AXLabel: 'Reload' }] }] }];
  fakeRunner(() => ({ stdout: JSON.stringify(tree) }));
  const out = sim.ui();
  assert.deepEqual(out.labels, ['Safari', 'Address', 'Reload']);
  assert.ok(fs.existsSync(out.file));
  assert.equal(screenWidth(tree), 402);
});

test('reset shuts down and erases only this simulator', () => {
  saveState({ udid: U });
  const calls = fakeRunner();
  sim.reset();
  assert.deepEqual(calls, [['xcrun', 'simctl', 'shutdown', U], ['xcrun', 'simctl', 'erase', U]]);
});

test('run folders are named by time and label, and only the newest 20 are kept', () => {
  for (let i = 0; i < 23; i++) newRun(`Test ${i}!`, new Date(2026, 9, 13, 12, 0, i));
  const names = fs.readdirSync(runsRoot()).sort();
  assert.equal(names.length, 20);
  assert.equal(names[0], '20261013-120003-test-3');
  assert.equal(names.at(-1), '20261013-120022-test-22');
  assert.equal(path.basename(loadState().run), '20261013-120022-test-22');
  fs.mkdirSync(path.join(runsRoot(), 'keep-me'));
  pruneRuns(1);
  assert.ok(fs.existsSync(path.join(runsRoot(), 'keep-me')));
});

test('a corrupt state file reads as empty', () => {
  saveState({ udid: U });
  fs.writeFileSync(path.join(process.env.MSL_STATE, 'state.json'), '{nope');
  assert.deepEqual(loadState(), {});
});

// Runs a command through cli() and returns its exit code and the JSON it printed.
async function runCli(handlers, argv) {
  const log = console.log;
  let printed = '';
  console.log = line => { printed += line; };
  try {
    const code = await cli(handlers, argv);
    return { code, out: JSON.parse(printed) };
  } finally { console.log = log; }
}

test('doctor fails with a hint for each thing missing, and exits 1', async () => {
  fakeRunner(cmd => (cmd === 'axe' ? { code: 127, stderr: 'not found' } : { stdout: 'Xcode 26.2\n' }));
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing, ['axe', 'udid']);
  assert.deepEqual(Object.keys(out.hints), ['axe', 'udid']);
  assert.equal(out.appium, 'Xcode 26.2'); // the fake answers every check alike
  assert.match(out.error, /missing: axe, udid/);
  assert.equal(out.xcode, 'Xcode 26.2');
  assert.equal(out.axe, null);
});

test('doctor with only Command Line Tools hints at every missing item', async () => {
  fakeRunner(cmd => (cmd === 'xcodebuild' || cmd === 'xcrun' ? { code: 1, stderr: 'xcode-select: error' } : { stdout: '1.0\n' }));
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 1);
  assert.deepEqual(out.missing, ['xcode', 'simctl', 'udid']);
  assert.deepEqual(Object.keys(out.hints), out.missing);
  assert.ok(Object.values(out.hints).every(h => typeof h === 'string' && h));
});

test('doctor passes with ok true and exit 0 when nothing is missing', async () => {
  saveState({ udid: U });
  fakeRunner(() => ({ stdout: '1.0\n' }));
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.hints, undefined);
  assert.equal(out.error, undefined);
});

test('doctor adds the lab version note when the checkout is behind, and still passes', async () => {
  saveState({ udid: U });
  fakeRunner((cmd, args) => {
    if (cmd !== 'git') return { stdout: '1.0\n' };
    if (args[2] === 'rev-parse') return { stdout: 'abc1234\n' };
    if (args[2] === 'branch') return { stdout: 'main\n' };
    if (args[2] === 'ls-remote') return { stdout: `${'d'.repeat(40)}\tHEAD\n` };
    if (args[2] === 'merge-base') return { code: 1 };
    return undefined;
  });
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.labVersion.behind, true);
  assert.match(out.labVersion.human[0], /pull --ff-only$/);
});

test('doctor says nothing about the lab version when it is current or could not be checked', async () => {
  saveState({ udid: U });
  fakeRunner(() => ({ stdout: '1.0\n' })); // git answers nonsense: not checked
  assert.equal((await runCli(sim, ['doctor'])).out.labVersion, undefined);
});

test('doctor reports a missing Appium with the install command', async () => {
  saveState({ udid: U });
  fakeRunner(cmd => (cmd.endsWith('/appium') ? { code: 127, stderr: 'not found' } : { stdout: '1.0\n' }));
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 1);
  assert.deepEqual(out.missing, ['appium']);
  assert.equal(out.hints.appium, INSTALL_HINT);
  assert.match(out.hints.appium, /pnpm add appium@3\.8\.0 appium-xcuitest-driver@12\.18\.1/);
  assert.equal(out.appium, null);
});

test('simState reads the saved simulator\'s state from simctl, null when unknown', () => {
  fakeRunner(() => ({ stdout: JSON.stringify({ devices: { rt: [{ udid: U, state: 'Shutdown' }, { udid: 'OTHER', state: 'Booted' }] } }) }));
  assert.equal(simState(U), 'Shutdown');
  assert.equal(simState('MISSING'), null);
});

test('simInfo adds the iOS runtime from the runtime key, null when it can\'t be read or the simulator is unknown', () => {
  fakeRunner(() => ({ stdout: JSON.stringify({ devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ udid: U, state: 'Booted' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: 'ODD', state: 'Shutdown' }],
    rt: [{ udid: 'NOKEY', state: 'Shutdown' }],
  } }) }));
  assert.deepEqual(simInfo(U), { state: 'Booted', runtime: 'iOS 26.2' });
  assert.deepEqual(simInfo('ODD'), { state: 'Shutdown', runtime: 'iOS 27.0' });
  assert.deepEqual(simInfo('NOKEY'), { state: 'Shutdown', runtime: null });
  assert.deepEqual(simInfo('MISSING'), { state: null, runtime: null });
});

test('bootSim bounds simctl boot at 60 s and each bootstatus piece at 150 s or the time left, and accepts a booting simulator', async () => {
  const seen = [];
  setRunner((cmd, args, opts) => {
    seen.push([cmd, args[1], opts?.timeoutMs]);
    if (cmd === 'xcode-select') return { code: 0, stdout: '', stderr: '' };
    if (args[1] === 'boot') return { code: 149, stdout: '', stderr: 'Unable to boot device in current state: Booting' };
    return { code: 0, stdout: '', stderr: '' };
  });
  await bootSim(U, { timeoutMs: 100e3 });
  assert.deepEqual(seen.filter(s => s[1] === 'boot' || s[1] === 'bootstatus'), [['xcrun', 'boot', 60e3], ['xcrun', 'bootstatus', 100e3]]);
  await bootSim(U);
  assert.equal(seen.filter(s => s[1] === 'bootstatus').at(-1)[2], BOOT_CHUNK_MS);
});

// bootstatus answers `codes` in turn (the last one repeats); gives the bootstatus calls' timeouts.
function bootstatusRunner(codes) {
  const seen = [];
  setRunner((cmd, args, opts) => {
    if (args[1] !== 'bootstatus') return { code: 0, stdout: '', stderr: '' };
    const code = codes[Math.min(seen.length, codes.length - 1)];
    seen.push(opts?.timeoutMs);
    return { code, stdout: '', stderr: code === 124 ? 'timed out after 150s' : code ? 'boom' : '' };
  });
  return seen;
}

test('bootSim waits in pieces: a piece that runs out calls onWait and the next one carries on; it ends at the first exit 0', async () => {
  saveState({ unwarmed: [U] });
  const seen = bootstatusRunner([124, 124, 0]);
  let waits = 0;
  await bootSim(U, { onWait: () => { waits++; } });
  assert.deepEqual(seen, [BOOT_CHUNK_MS, BOOT_CHUNK_MS, BOOT_CHUNK_MS]);
  assert.equal(waits, 2);
  assert.equal(loadState().unwarmed, undefined, 'a finished boot clears the marker');
});

test('bootSim gives an unwarmed simulator 1500 s, a warmed one 600 s, and says to run sim boot again when it runs out', async () => {
  let seen = bootstatusRunner([124]);
  await assert.rejects(bootSim(U), /still booting after 600 s; run `sim boot` again, the migration continues/);
  assert.equal(seen.length, 4);
  saveState({ unwarmed: [U] });
  seen = bootstatusRunner([124]);
  let waits = 0;
  await assert.rejects(bootSim(U, { onWait: () => { waits++; } }), /still booting after 1500 s/);
  assert.equal(seen.length, 10);
  assert.equal(waits, 9, 'not after the last piece');
  assert.deepEqual(loadState().unwarmed, [U], 'a boot that did not finish leaves the marker');
});

test('bootSim fails on any other bootstatus exit, and an interrupt ends the wait instead of the next piece', async () => {
  bootstatusRunner([1]);
  await assert.rejects(bootSim(U), /simctl failed \(exit 1\): boom/);
  bootstatusRunner([124]);
  let waits = 0;
  await assert.rejects(bootSim(U, { onWait: () => { waits++; throw new InterruptError('SIGINT'); } }), e => e instanceof InterruptError);
  assert.equal(waits, 1);
});

test('only an array holding the UDID makes a simulator unwarmed: a missing or damaged marker reads as warmed', () => {
  assert.equal(isUnwarmed(U), false);
  for (const bad of ['yes', U, { [U]: true }, 7, true, [], ['nope'], [7, null]]) {
    saveState({ unwarmed: bad });
    assert.equal(isUnwarmed(U), false, JSON.stringify(bad));
  }
  saveState({ unwarmed: [U] });
  assert.equal(isUnwarmed(U), true);
  assert.equal(isUnwarmed(C), false);
  markUnwarmed(C);
  assert.deepEqual(loadState().unwarmed, [U, C]);
  markWarmed(U);
  assert.deepEqual(loadState().unwarmed, [C]);
  saveState({ unwarmed: [C, 'junk', 3] });
  markWarmed(U);
  assert.deepEqual(loadState().unwarmed, [C], 'a rewrite keeps only valid UDIDs');
  markWarmed(C);
  assert.equal(loadState().unwarmed, undefined);
  saveState({ unwarmed: 'damaged' });
  markUnwarmed(U);
  assert.deepEqual(loadState().unwarmed, [U]);
});

test('bootSim records simBoot only when simctl accepted the boot (the simulator was Shutdown); sim shutdown and reset clear it', async () => {
  saveState({ udid: U });
  let reply = { code: 0, stdout: '', stderr: '' };
  setRunner((cmd, args) => (args[1] === 'boot' ? reply : { code: 0, stdout: '', stderr: '' }));
  await bootSim(U);
  assert.equal(loadState().simBoot, U);
  assert.deepEqual(sim.shutdown([]), { udid: U, shutdown: true });
  assert.equal(loadState().simBoot, undefined);

  // Already up, or coming up: someone else booted it, so it is not recorded.
  for (const now of ['Booted', 'Booting']) {
    reply = { code: 149, stdout: '', stderr: `Unable to boot device in current state: ${now}` };
    await bootSim(U);
    assert.equal(loadState().simBoot, undefined, now);
  }
  // A failed boot records nothing.
  reply = { code: 1, stdout: '', stderr: 'no such device' };
  await assert.rejects(bootSim(U), /simctl boot failed/);
  assert.equal(loadState().simBoot, undefined);

  reply = { code: 0, stdout: '', stderr: '' };
  await bootSim(U);
  sim.reset([]);
  assert.equal(loadState().simBoot, undefined);
});

test('doctor no longer checks safaridriver', async () => {
  saveState({ udid: U });
  const calls = fakeRunner(() => ({ stdout: '1.0\n' }));
  const { out } = await runCli(sim, ['doctor']);
  assert.equal(out.safaridriver, undefined);
  assert.ok(!calls.some(c => c[0] === 'safaridriver'));
  assert.equal(out.phone, false);
});

const SAVED_PHONE = { udid: '00008000-000A1B2C3D4E5F60', teamId: 'ABCDE12345', bundleId: 'com.dividedby.msl-wda-abcd' };

test('doctor with a phone record does not require the simulator, AXe or a simulator UDID', async () => {
  saveState({ phone: SAVED_PHONE });
  fakeRunner(cmd => (cmd === 'axe' || cmd === 'xcrun' ? { code: 127, stderr: 'not found' } : { stdout: 'ok\n' }));
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.axe, null);
  assert.equal(out.udid, null);
  assert.equal(out.phone, true);
});

test('doctor with a phone record still requires Xcode and Appium', async () => {
  saveState({ phone: SAVED_PHONE });
  fakeRunner(cmd => (cmd === 'xcodebuild' || cmd.endsWith('/appium') ? { code: 127, stderr: 'not found' } : { stdout: 'ok\n' }));
  const { code, out } = await runCli(sim, ['doctor']);
  assert.equal(code, 1);
  assert.deepEqual(out.missing, ['xcode', 'appium']);
});

// The Wi-Fi tunnel tool: reported, hinted only with a phone saved, and never a reason for `ok: false`.
const TOOL = '/opt/tools/bin/pymobiledevice3';
const withTool = reply => (cmd, args) => (cmd === TOOL ? reply(args) : { stdout: 'ok\n' });

test('doctor reports the tunnel tool version and stays ok without the tool', async () => {
  process.env.MSL_PMD3 = TOOL;
  try {
    saveState({ phone: SAVED_PHONE });
    fakeRunner(withTool(() => ({ stdout: '11.41.0\n' })));
    let { code, out } = await runCli(sim, ['doctor']);
    assert.equal(code, 0);
    assert.equal(out.pymobiledevice3, '11.41.0');
    assert.equal(out.hints, undefined);

    fakeRunner(withTool(() => ({ code: 127, stderr: 'not found' })));
    ({ code, out } = await runCli(sim, ['doctor']));
    assert.equal(code, 0);
    assert.equal(out.ok, true);
    assert.deepEqual(out.missing, []);
    assert.equal(out.pymobiledevice3, null);
    assert.match(out.hints.pymobiledevice3, /brew install uv/);

    fakeRunner(withTool(() => ({ code: 124 })));
    ({ code, out } = await runCli(sim, ['doctor']));
    assert.equal(code, 0);
    assert.equal(out.ok, true);
    assert.equal(out.pymobiledevice3, null);
    assert.match(out.hints.pymobiledevice3, /try again/);
    assert.ok(!/brew install/.test(out.hints.pymobiledevice3), 'a slow check is not an install hint');

    fakeRunner(withTool(() => ({ stdout: '11.40.1\n' })));
    ({ code, out } = await runCli(sim, ['doctor']));
    assert.equal(code, 0);
    assert.equal(out.pymobiledevice3, '11.40.1');
    assert.match(out.hints.pymobiledevice3, /11\.40\.2 or newer/);
    assert.deepEqual(out.missing, []);
  } finally { delete process.env.MSL_PMD3; }
});

test('doctor hints at the tunnel tool only when a phone is saved, and alongside other hints', async () => {
  process.env.MSL_PMD3 = TOOL;
  try {
    saveState({ udid: U });
    fakeRunner(withTool(() => ({ code: 127, stderr: 'not found' })));
    let { out } = await runCli(sim, ['doctor']);
    assert.equal(out.ok, true);
    assert.equal(out.hints, undefined);
    assert.equal(out.pymobiledevice3, null);

    saveState({ phone: SAVED_PHONE });
    const toolGone = withTool(() => ({ code: 127, stderr: 'x' }));
    fakeRunner((cmd, args) => (cmd === 'xcodebuild' ? { code: 127, stderr: 'not found' } : toolGone(cmd, args)));
    ({ out } = await runCli(sim, ['doctor']));
    assert.equal(out.ok, false);
    assert.deepEqual(out.missing, ['xcode']);
    assert.deepEqual(Object.keys(out.hints), ['xcode', 'pymobiledevice3']);
  } finally { delete process.env.MSL_PMD3; }
});

test('doctor reports the tunnel registry, and with a phone saved hints at how to get it; never a reason for ok: false', async () => {
  process.env.MSL_PMD3 = TOOL;
  saveState({ phone: SAVED_PHONE });
  fakeRunner(withTool(() => ({ stdout: '11.41.0\n' })));
  let { code, out } = await runCli(sim, ['doctor']);
  assert.deepEqual([code, out.tunnelRegistry, out.hints], [0, true, undefined]);

  fs.rmSync(registryModule());
  ({ code, out } = await runCli(sim, ['doctor']));
  assert.deepEqual([code, out.ok, out.tunnelRegistry, out.missing], [0, true, false, []]);
  assert.match(out.hints.tunnelRegistry, /remotexpc's tunnel registry/);
  assert.ok(out.hints.tunnelRegistry.includes(registryModule()), 'it names where it looked');
  assert.ok(out.hints.tunnelRegistry.includes('pnpm add appium@3.8.0 appium-xcuitest-driver@12.18.1'), 'and the install command');

  // No phone saved: reported, not hinted.
  saveState({ phone: null, udid: U });
  ({ out } = await runCli(sim, ['doctor']));
  assert.deepEqual([out.tunnelRegistry, out.hints], [false, undefined]);
  delete process.env.MSL_PMD3;
});

test('doctor does not treat a damaged phone record as a saved phone: the simulator tools stay required', async () => {
  for (const bad of [{}, { udid: '00008000-000A1B2C3D4E5F60' }, { ...SAVED_PHONE, teamId: 'x' }, { ...SAVED_PHONE, wdaExpires: 'never' }, { ...SAVED_PHONE, keyboard: 'on' }, [SAVED_PHONE], 'phone', 7]) {
    saveState({ phone: bad });
    fakeRunner(cmd => (cmd === 'axe' || cmd === 'xcrun' ? { code: 127, stderr: 'not found' } : { stdout: 'ok\n' }));
    const { code, out } = await runCli(sim, ['doctor']);
    assert.equal(code, 1, JSON.stringify(bad));
    assert.deepEqual(out.missing, ['simctl', 'axe', 'udid'], JSON.stringify(bad));
    assert.equal(out.phone, false, JSON.stringify(bad));
  }
});

test('deviceSession reads a device target, and refuseOnDevice names the way out', () => {
  const dev = { session: 's', target: { device: '00008000-000A1B2C3D4E5F60' } };
  assert.equal(deviceSession(dev), '00008000-000A1B2C3D4E5F60');
  for (const bad of [{}, { session: 's', target: { simulator: U } }, { target: dev.target }, { session: '', target: dev.target },
    { session: 's', target: { device: 'x' } }, { session: 's', target: [dev.target.device] }, { session: 's', target: null }]) {
    assert.equal(deviceSession(bad), null, JSON.stringify(bad));
    assert.doesNotThrow(() => refuseOnDevice('tap', bad));
  }
  assert.throws(() => refuseOnDevice('tap', dev), /sim tap is refused.*safari shot\|tap\|keys\|swipe.*safari stop/);
});

// --- profiles: clean (state `udid`) and configured (`profiles.configured`) ---

const C = '7B2C3D4E-5F6A-4B7C-9D8E-0F1A2B3C4D5E';
const CONFIGURED = { udid: C, name: 'Claude iPhone (configured)' };
const bothSaved = extra => saveState({ udid: U, profiles: { configured: CONFIGURED }, ...extra });
// simctl whose devices have the given states; boot and shutdown change them.
function simctlWorld(devs) {
  return fakeRunner((_cmd, args) => {
    if (args[1] === 'list') {
      const list = Object.entries(devs).map(([udid, state]) => ({ udid, name: udid === U ? 'Claude iPhone' : CONFIGURED.name, state, isAvailable: true }));
      return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': list } }) };
    }
    if (args[1] === 'boot') devs[args[2]] = 'Booted';
    if (args[1] === 'shutdown') devs[args[2]] = 'Shutdown';
    return undefined;
  });
}

test('create --profile configured makes a second, separately named simulator and leaves the clean one alone', async () => {
  saveState({ udid: U });
  const list = structuredClone(LIST);
  list.devices['com.apple.CoreSimulator.SimRuntime.iOS-26-2'].push({ name: 'Claude iPhone', udid: U, isAvailable: true });
  const calls = fakeRunner((_cmd, args) => {
    if (args[1] === 'list') return { stdout: JSON.stringify(list) };
    if (args[1] === 'create') return { stdout: C + '\n' };
  });
  const out = await sim.create(['--profile', 'configured']);
  assert.deepEqual(calls[1], ['xcrun', 'simctl', 'create', 'Claude iPhone (configured)', 'iPhone-17-Pro', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2']);
  assert.deepEqual([out.udid, out.profile, out.created], [C, 'configured', true]);
  assert.equal(loadState().udid, U, 'the clean simulator is untouched');
  assert.deepEqual(loadState().profiles.configured, { udid: C, name: 'Claude iPhone (configured)' });
});

test('create --profile configured reuses the saved one, or one of that name, and never takes the clean simulator', async () => {
  saveState({ udid: U });
  const device = (name, udid) => ({ name, udid, isAvailable: true });
  const listOf = (...devices) => ({ ...LIST, devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-2': devices } });
  // Same name as an existing device: reused, nothing created.
  let calls = fakeRunner(() => ({ stdout: JSON.stringify(listOf(device('Claude iPhone', U), device(CONFIGURED.name, C))) }));
  let out = await sim.create(['--profile', 'configured']);
  assert.deepEqual([out.udid, out.created], [C, false]);
  assert.equal(calls.length, 1);
  assert.equal(loadState().profiles.configured.udid, C);
  // The saved record wins over a name; a second create is the same device.
  out = await sim.create(['--profile', 'configured']);
  assert.equal(out.udid, C);
  // The clean simulator is not taken as the configured one, even when it carries the wanted name.
  saveState({ profiles: null });
  calls = fakeRunner((_cmd, args) => (args[1] === 'list' ? { stdout: JSON.stringify(listOf(device('Claude iPhone', U))) } : { stdout: C + '\n' }));
  out = await sim.create(['--profile', 'configured', '--name', 'Claude iPhone']);
  assert.deepEqual([out.udid, out.created], [C, true]);
  assert.equal(loadState().udid, U);
});

test('an unknown profile is refused before any command runs', async () => {
  const calls = fakeRunner();
  bothSaved();
  for (const [name, args] of [['create', ['--profile', 'work']], ['boot', ['--profile', 'Clean']], ['shutdown', ['--profile', '']], ['reset', ['--profile', 'x', '--yes']], ['udid', ['--profile', 'a b']]]) {
    await assert.rejects(async () => sim[name](args), /--profile must be one of clean, configured/, name);
  }
  await assert.rejects(sim.boot(['--profile']), /--profile needs a value/);
  await assert.rejects(sim.boot(['--other', 'x']), /usage: sim boot/);
  assert.equal(calls.length, 0);
});

test('which simulator a command acts on: --profile, else the recorded session, else the profile in use, else clean', () => {
  assert.throws(() => simUdid(), /sim create/);
  saveState({ udid: U });
  assert.equal(simUdid(), U);
  assert.throws(() => simUdid('configured'), /No configured simulator yet: run `sim create --profile configured`/);
  bothSaved();
  assert.equal(simUdid(), U, 'clean is the default');
  assert.equal(simUdid('configured'), C);
  assert.equal(simUdid('clean'), U);

  saveState({ profile: 'configured' }); // the profile in use
  assert.equal(simUdid(), C);
  assert.equal(simUdid('clean'), U, 'the flag beats it');

  saveState({ profile: 'clean', session: 'S1', target: { simulator: C } }); // a recorded session wins over the profile in use
  assert.equal(simUdid(), C);
  assert.equal(simUdid('clean'), U, 'and the flag beats the session');
  saveState({ profile: 'configured', target: { simulator: U } });
  assert.equal(simUdid(), U);

  // A session naming a simulator that is not a saved one is not trusted; a phone session is not a simulator.
  saveState({ profile: null, target: { simulator: '0000AAAA-0000-4000-8000-00000000AAAA' } });
  assert.equal(simUdid(), U);
  saveState({ target: { device: '00008110-001A2B3C4D5E6F78' } });
  assert.equal(simUdid(), U);
  // A stored profile that is neither is read as clean.
  saveState({ target: null, session: null, profile: 'work' });
  assert.equal(simUdid(), U);
  assert.equal(sim.udid([]).udid, U);
  assert.deepEqual(sim.udid(['--profile', 'configured']), { udid: C, profile: 'configured' });
});

test('a damaged configured record is refused with the way out; a missing one is just none', () => {
  saveState({ udid: U });
  assert.equal(configuredRecord(), null);
  for (const bad of [{ configured: 'x' }, { configured: { udid: 'nope' } }, { configured: { udid: U } }, { configured: { udid: C, name: 7 } }, 'x']) {
    saveState({ profiles: bad });
    if (bad === 'x') assert.equal(configuredRecord(), null);
    else assert.throws(() => configuredRecord(), /damaged: run `sim create --profile configured`/, JSON.stringify(bad));
  }
});

test('reset on the configured profile needs --profile configured and --yes together; clean resets as before', () => {
  bothSaved();
  const calls = fakeRunner();
  sim.reset([]); // clean: no flags needed
  assert.deepEqual(calls, [['xcrun', 'simctl', 'shutdown', U], ['xcrun', 'simctl', 'erase', U]]);

  const refusal = /would erase the configured profile for good.*sim reset --profile configured --yes/;
  calls.length = 0;
  assert.throws(() => sim.reset(['--profile', 'configured']), refusal);
  saveState({ profile: 'configured' }); // the profile in use is configured, but a reset has to name it
  assert.throws(() => sim.reset([]), refusal);
  assert.throws(() => sim.reset(['--yes']), refusal);
  saveState({ profile: null, session: 'S1', target: { simulator: C } }); // and so does a live session on it
  assert.throws(() => sim.reset(['--yes']), refusal);
  assert.equal(calls.length, 0, 'refused before any simctl call');

  assert.deepEqual(sim.reset(['--profile', 'configured', '--yes']), { udid: C, profile: 'configured', erased: true });
  assert.deepEqual(calls, [['xcrun', 'simctl', 'shutdown', C], ['xcrun', 'simctl', 'erase', C]]);
  assert.throws(() => sim.reset(['--no', 'x']), /usage: sim reset/);
  assert.throws(() => sim.reset(['now']), /usage: sim reset/);
});

test('boot shuts the other profile down first, records the profile in use, and refuses while a session is on the other one', async () => {
  bothSaved();
  const devs = { [U]: 'Booted', [C]: 'Shutdown' };
  const calls = simctlWorld(devs);
  saveState({ simBoot: U });
  const out = await sim.boot(['--profile', 'configured']);
  assert.deepEqual([out.udid, out.profile, out.shutDown], [C, 'configured', ['clean']]);
  assert.deepEqual(calls.filter(c => ['shutdown', 'boot'].includes(c[2])).map(c => c.slice(2).join(' ')), [`shutdown ${U}`, `boot ${C}`]);
  assert.deepEqual(devs, { [U]: 'Shutdown', [C]: 'Booted' });
  assert.equal(loadState().simBoot, C);
  assert.equal(loadState().profile, 'configured');
  assert.equal(simUdid(), C, 'sim commands now act on it');
  assert.ok(!calls.flat().includes('booted'));

  // The other profile goes back with `sim boot` (no flag = clean). A session on the booted one blocks it.
  saveState({ session: 'S1', target: { simulator: C } });
  calls.length = 0;
  await assert.rejects(sim.boot(['--profile', 'clean']), /a session is open on the configured simulator.*safari stop/);
  assert.equal(calls.filter(c => ['shutdown', 'boot'].includes(c[2])).length, 0);
  assert.deepEqual(devs, { [U]: 'Shutdown', [C]: 'Booted' });

  saveState({ session: null, target: null });
  const back = await sim.boot(['--profile', 'clean']);
  assert.deepEqual([back.udid, back.shutDown], [U, ['configured']]);
  assert.equal(back.profile, undefined, 'the clean output is as it was');
  assert.equal(loadState().profile, 'clean');
  assert.deepEqual(devs, { [U]: 'Booted', [C]: 'Shutdown' });
});

test('yieldTo shuts down nothing when the other simulator is down, unknown, or there is none; and fails if it will not go down', () => {
  saveState({ udid: U });
  const calls = fakeRunner();
  assert.deepEqual(yieldTo(U), []);
  assert.equal(calls.length, 0, 'one saved simulator: nothing is asked of simctl');
  bothSaved();
  simctlWorld({ [U]: 'Shutdown', [C]: 'Shutdown' });
  assert.deepEqual(yieldTo(C), []);
  fakeRunner((_cmd, args) => (args[1] === 'list' ? { stdout: JSON.stringify({ devices: { r: [{ udid: C, state: 'Booted' }] } }) } : undefined));
  assert.throws(() => yieldTo(U), /still Booted after `simctl shutdown`/); // C stays Booted: the clean one is not booted over it
});

test('shutdown and reset clear the recorded boot only for the device they stop; shutdown clears the profile in use', () => {
  bothSaved({ simBoot: C, profile: 'configured' });
  fakeRunner();
  assert.deepEqual(sim.shutdown(['--profile', 'clean']), { udid: U, shutdown: true });
  assert.equal(loadState().simBoot, C, 'the configured boot is not the clean simulator\'s');
  assert.equal(loadState().profile, 'configured');
  assert.deepEqual(sim.shutdown([]), { udid: C, profile: 'configured', shutdown: true });
  assert.equal(loadState().simBoot, undefined);
  assert.equal(loadState().profile, undefined);
});

test('sim profile status takes each device\'s name from simctl, not from the lab', () => {
  bothSaved();
  fakeRunner(() => ({ stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
    { udid: U, name: 'Renamed by hand', state: 'Shutdown', isAvailable: true },
    { udid: C, name: 'Also renamed', state: 'Shutdown', isAvailable: true }] } }) }));
  const out = sim.profile(['status']);
  assert.deepEqual([out.devices.clean.name, out.devices.configured.name], ['Renamed by hand', 'Also renamed']);
  assert.equal(out.devices.clean.runtime, 'iOS 27.0');
  // A device simctl does not list keeps no invented name and says it is unknown.
  fakeRunner(() => ({ stdout: JSON.stringify({ devices: {} }) }));
  const gone = sim.profile(['status']);
  assert.deepEqual([gone.devices.clean.name, gone.devices.clean.known, gone.devices.configured.name], [null, false, CONFIGURED.name]);
});

test('checkProfileArg checks the --profile of the commands that take one, and refuses a repeated one', () => {
  assert.doesNotThrow(() => checkProfileArg('boot', ['--profile', 'configured']));
  assert.doesNotThrow(() => checkProfileArg('boot', ['--profile'])); // the command's own parser says it needs a value
  assert.doesNotThrow(() => checkProfileArg('type', ['--profile', 'bogus'])); // text for `type`, not a flag
  assert.throws(() => checkProfileArg('reset', ['--yes', '--profile', 'bogus']), /--profile must be one of/);
  assert.throws(() => checkProfileArg('boot', ['--profile', 'clean', '--profile', 'configured']), /more than once/);
  assert.throws(() => checkProfileArg('boot', ['--profile', 'configured', '--profile', 'bogus']), /more than once/);
});

test('sim profile status lists both devices and which is booted, and only reads the device list', () => {
  const devs = { [U]: 'Shutdown', [C]: 'Booted' };
  saveState({ udid: U });
  let calls = simctlWorld(devs);
  const none = sim.profile(['status']);
  assert.deepEqual([none.current, none.devices.configured, none.booted], ['clean', null, []]);
  bothSaved({ profile: 'configured' });
  calls = simctlWorld(devs);
  const out = sim.profile(['status']);
  assert.equal(out.current, 'configured');
  assert.deepEqual(out.booted, ['configured']);
  assert.deepEqual([out.devices.clean.state, out.devices.configured.state, out.devices.configured.name], ['Shutdown', 'Booted', CONFIGURED.name]);
  assert.ok(calls.every(c => c[1] === 'simctl' && c[2] === 'list'), 'list only');
  assert.throws(() => sim.profile([]), /usage: sim profile status/);
  assert.throws(() => sim.profile(['status', 'x']), /usage: sim profile status/);
  assert.throws(() => sim.profile(['wipe']), /usage: sim profile status/);
  saveState({ profiles: { configured: { udid: 'bad' } } });
  assert.match(sim.profile(['status']).damaged, /damaged/);
});

// --- the warm-up boot: a new simulator is booted once by `sim create`, then shut down ---

// simctl for a create: `list` shows the devices in `devs` (UDID -> state) beside LIST's runtimes, `create`
// makes `made`, boot and shutdown change states. `bootstatus` answers by `boot` ({ code, stderr }).
function createWorld(devs, { made = U, boot = { code: 0 } } = {}) {
  const calls = fakeRunner((_cmd, args) => {
    if (args[1] === 'list') {
      const list = structuredClone(LIST);
      list.devices['com.apple.CoreSimulator.SimRuntime.iOS-26-2'] = Object.entries(devs).map(([udid, state]) => ({ udid, name: udid === U ? 'Claude iPhone' : CONFIGURED.name, state, isAvailable: true }));
      return { stdout: JSON.stringify(list) };
    }
    if (args[1] === 'create') { devs[made] = 'Shutdown'; return { stdout: made + '\n' }; }
    if (args[1] === 'boot') devs[args[2]] = 'Booted';
    if (args[1] === 'shutdown') devs[args[2]] = 'Shutdown';
    if (args[1] === 'bootstatus') return boot;
    return undefined;
  });
  return calls;
}
const simctlOf = (calls, ...verbs) => calls.filter(c => c[0] === 'xcrun' && verbs.includes(c[2])).map(c => c.slice(2).join(' '));

test('create boots a new simulator once, waits for it, shuts it down and leaves it warmed', async () => {
  const devs = {};
  const calls = createWorld(devs);
  const out = await sim.create([]);
  assert.deepEqual([out.udid, out.created, out.warmed], [U, true, true]);
  assert.equal(out.shutDown, undefined);
  assert.deepEqual(simctlOf(calls, 'create', 'boot', 'bootstatus', 'shutdown'), [
    'create Claude iPhone iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-2', `boot ${U}`, `bootstatus ${U} -b`, `shutdown ${U}`]);
  assert.ok(!calls.flat().includes('booted'));
  assert.equal(devs[U], 'Shutdown');
  const state = loadState();
  assert.equal(state.udid, U);
  assert.equal(state.unwarmed, undefined, 'the boot finished: warmed');
  assert.equal(state.simBoot, undefined, 'it is shut down: nothing for the idle stop to stop');
  assert.equal(state.profile, undefined, 'a warm-up is not a profile in use');
});

test('create --profile configured warms the new one up too, shutting the other lab simulator down first', async () => {
  saveState({ udid: U });
  const devs = { [U]: 'Booted' };
  const calls = createWorld(devs, { made: C });
  const out = await sim.create(['--profile', 'configured']);
  assert.deepEqual([out.udid, out.profile, out.warmed, out.shutDown], [C, 'configured', true, ['clean']]);
  assert.deepEqual(simctlOf(calls, 'create', 'boot', 'shutdown'), [
    'create Claude iPhone (configured) iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-2', `shutdown ${U}`, `boot ${C}`, `shutdown ${C}`]);
  assert.deepEqual(devs, { [U]: 'Shutdown', [C]: 'Shutdown' });
  assert.equal(loadState().unwarmed, undefined);
});

test('create with a session open on the other profile saves the device but refuses to boot, and says how to finish', async () => {
  saveState({ udid: U, session: 'S1', target: { simulator: U } });
  const devs = { [U]: 'Booted' };
  const calls = createWorld(devs, { made: C });
  await assert.rejects(sim.create(['--profile', 'configured']), /created and saved 7B2C3D4E-5F6A-4B7C-9D8E-0F1A2B3C4D5E, but the warm-up boot failed: a session is open on the clean simulator.*; `sim boot --profile configured` finishes it/s);
  assert.deepEqual(simctlOf(calls, 'boot', 'shutdown'), []);
  assert.equal(loadState().profiles.configured.udid, C, 'the device stays saved');
  assert.deepEqual(loadState().unwarmed, [C], 'and unwarmed, so the boot that finishes it gets the long limit');
});

test('create whose warm-up boot fails keeps the device and the unwarmed marker, with the hint', async () => {
  const devs = {};
  const calls = createWorld(devs, { boot: { code: 1, stderr: 'boom' } });
  await assert.rejects(sim.create([]), /created and saved .*, but the warm-up boot failed: .*\(exit 1\): boom; `sim boot` finishes it$/);
  assert.equal(loadState().udid, U);
  assert.deepEqual(loadState().unwarmed, [U]);
  assert.ok(!simctlOf(calls, 'shutdown').length, 'no shutdown of a boot that is still going');
});

test('create whose warm-up boot runs out of time says the migration continues', async () => {
  createWorld({}, { boot: { code: 124, stderr: 'timed out after 150s' } });
  await assert.rejects(sim.create([]), /warm-up boot failed: simulator still booting after 1500 s; run `sim boot` again, the migration continues; `sim boot` finishes it/);
  assert.deepEqual(loadState().unwarmed, [U]);
});

test('create does not boot a simulator it found, and refuses to make one under a phone session', async () => {
  const devs = { [U]: 'Shutdown' };
  const calls = createWorld(devs);
  const out = await sim.create([]);
  assert.deepEqual([out.created, out.warmed], [false, undefined]);
  assert.deepEqual(simctlOf(calls, 'boot', 'bootstatus', 'shutdown'), []);
  assert.equal(loadState().unwarmed, undefined);

  saveState({ udid: null, session: 'S1', target: { device: '00008000-000A1B2C3D4E5F60' } });
  const again = createWorld({});
  await assert.rejects(sim.create([]), /sim create is refused: the Safari session is on the iPhone/);
  assert.deepEqual(simctlOf(again, 'create', 'boot'), []);
});

test('reset marks the simulator unwarmed (the erase makes its next boot a first boot)', async () => {
  bothSaved();
  fakeRunner();
  sim.reset([]);
  assert.deepEqual(loadState().unwarmed, [U]);
  sim.reset(['--profile', 'configured', '--yes']);
  assert.deepEqual(loadState().unwarmed, [U, C]);
  const calls = fakeRunner();
  await bootSim(C);
  assert.deepEqual(loadState().unwarmed, [U], 'a finished boot clears only its own');
  assert.equal(calls.filter(c => c[2] === 'bootstatus').length, 1);
});

// A signal that lands while a bootstatus piece runs (the child returns 124, as a cut one does).
const signalDuringPiece = pieces => setRunner((cmd, args) => {
  if (args[1] !== 'bootstatus') return { code: 0, stdout: '', stderr: '' };
  pieces.push(args);
  if (pieces.length === 1) process.emit('SIGINT', 'SIGINT'); // once: a second signal would end the process
  return { code: 124, stdout: '', stderr: 'timed out after 150s' };
});

test('a signal during a bootstatus piece ends the wait: InterruptError, no onWait, no further piece', async () => {
  const pieces = [];
  signalDuringPiece(pieces);
  let waits = 0;
  await withInterrupt(() => assert.rejects(bootSim(U, { onWait: () => { waits++; } }), e => e instanceof InterruptError && e.signal === 'SIGINT'));
  assert.equal(pieces.length, 1);
  assert.equal(waits, 0);
});

test('create lets an interrupt during the warm-up through as it is, keeping the device and the unwarmed marker', async () => {
  const pieces = [];
  setRunner((cmd, args) => {
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(LIST), stderr: '' };
    if (args[1] === 'create') return { code: 0, stdout: U + '\n', stderr: '' };
    if (args[1] !== 'bootstatus') return { code: 0, stdout: '', stderr: '' };
    pieces.push(args);
    if (pieces.length === 1) process.emit('SIGTERM', 'SIGTERM');
    return { code: 124, stdout: '', stderr: 'timed out after 150s' };
  });
  await withInterrupt(() => assert.rejects(sim.create([]), e => e instanceof InterruptError && !/warm-up boot failed/.test(e.message)));
  assert.equal(pieces.length, 1);
  assert.equal(loadState().udid, U);
  assert.deepEqual(loadState().unwarmed, [U]);
});

test('doctor reports phoneDisplay (the devicectl appearance and orientation commands) only with a phone saved, as help texts, and never fails on it', async () => {
  saveState({ udid: U });
  let calls = fakeRunner(() => ({ stdout: '1.0\n' }));
  let { out } = await runCli(sim, ['doctor']);
  assert.equal(out.phoneDisplay, undefined, 'no phone saved: not asked');
  assert.deepEqual(calls.filter(c => c[1] === 'devicectl'), []);

  saveState({ phone: SAVED_PHONE });
  calls = fakeRunner(() => ({ stdout: '1.0\n' }));
  let code;
  ({ code, out } = await runCli(sim, ['doctor']));
  assert.equal(code, 0);
  assert.equal(out.phoneDisplay, true);
  assert.equal(out.hints?.phoneDisplay, undefined);
  const asked = calls.filter(c => c[0] === 'xcrun' && c[1] === 'devicectl');
  assert.ok(asked.length >= 2);
  for (const c of asked) assert.equal(c.at(-1), '--help', 'help only: nothing is sent to a phone');
  assert.equal(asked.some(c => c.includes('booted') || c.includes('--device')), false);

  // An older Xcode: the commands do not exist. A hint, `ok` stays true, nothing is "missing".
  calls = fakeRunner((cmd, args) => (cmd === 'xcrun' && args[0] === 'devicectl' && args.includes('appearance') ? { code: 2, stderr: 'Error: Unexpected argument' } : { stdout: '1.0\n' }));
  ({ code, out } = await runCli(sim, ['doctor']));
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.phoneDisplay, false);
  assert.match(out.hints.phoneDisplay, /Xcode 27/);

  // A hint next to a real failure, in the same hints object.
  fakeRunner((cmd, args) => (cmd === 'xcodebuild' || (cmd === 'xcrun' && args[0] === 'devicectl') ? { code: 127, stderr: 'x' } : { stdout: '1.0\n' }));
  ({ code, out } = await runCli(sim, ['doctor']));
  assert.equal(code, 1);
  assert.deepEqual(out.missing, ['xcode']);
  assert.ok('phoneDisplay' in out.hints && 'xcode' in out.hints);
  assert.equal(out.phoneDisplay, false);
});
