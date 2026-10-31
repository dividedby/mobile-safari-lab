// The phone's WebDriverAgent over the Wi-Fi tunnel (#15): the xcodebuild arguments, the detached
// launch with USE_IP, the wait for /status and what a timeout says. xcodebuild is a recorded
// stand-in (setRunner for the build, setSpawner for the launch); /status is a local HTTP server.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandbox, fakeRunner } from './helpers.js';
import { saveState, setSpawner, openPrivate, setAsyncRunner } from '../lib/core.js';
import { InterruptError } from '../lib/interrupt.js';
import * as svc from '../lib/service.js';
import * as tunnel from '../lib/tunnel.js';
import { wdaDerivedData } from '../lib/phone.js';
import { deviceWdaTargets, stopDeviceWda, STOP_WAIT } from '../lib/wda.js';

const PU = '00008000-000A1B2C3D4E5F60';
const PHONE = { udid: PU, teamId: 'ABCDE12345', bundleId: 'com.example.msl-wda-abcd' };
const TUN = { address: 'fd00:1234::1' };

let dir, calls, spawned, server, statusAfter, polls, spawnLog, realWait, realUrl, killed, realStop, realPoll, shutdowns, onShutdown;

beforeEach(async () => {
  dir = sandbox();
  process.env.MSL_APPIUM_HOME = path.join(dir, 'appium');
  saveState({ phone: PHONE });
  realWait = { ...tunnel.WDA_WAIT };
  realUrl = tunnel.WDA.url;
  Object.assign(tunnel.WDA_WAIT, { statusMs: 400, pollMs: 5, callMs: 200, buildMs: 5000 });
  realStop = { ...STOP_WAIT };
  realPoll = svc.WAIT.pollMs;
  Object.assign(STOP_WAIT, { shutdownMs: 200, exitMs: 30, settleMs: 5 });
  svc.WAIT.pollMs = 5;
  shutdowns = 0;
  onShutdown = () => {};
  killed = [];
  svc.setKill((pid, sig) => { killed.push([pid, sig]); });
  calls = fakeRunner();
  spawned = [];
  spawnLog = 'WebDriverAgent starting\n';
  setSpawner((cmd, args, opts) => {
    spawned.push({ cmd, args, ...opts });
    if (opts.log) { fs.closeSync(openPrivate(opts.log)); fs.writeFileSync(opts.log, spawnLog); }
    return { pid: 9001 };
  });
  polls = 0;
  statusAfter = 3; // /status answers from the third poll on
  server = http.createServer((req, res) => {
    if (req.url === '/wda/shutdown') { shutdowns++; onShutdown(); res.end('Shutting down'); return; }
    polls++;
    res.statusCode = req.url === '/status' && polls >= statusAfter ? 200 : 503;
    res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  tunnel.WDA.url = () => `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  Object.assign(tunnel.WDA_WAIT, realWait);
  Object.assign(STOP_WAIT, realStop);
  svc.WAIT.pollMs = realPoll;
  tunnel.WDA.url = realUrl;
  await new Promise(r => server.close(r));
});

const withBuild = () => {
  const products = path.join(wdaDerivedData(), 'Build', 'Products');
  fs.mkdirSync(products, { recursive: true });
  fs.writeFileSync(path.join(products, 'WebDriverAgentRunner_iphoneos.xctestrun'), '<plist/>');
};

test('wdaBuildArgs: the saved phone, team and bundle id, the device derived data, the iOS version; only the build may touch provisioning', () => {
  const build = tunnel.wdaBuildArgs({ phone: PHONE, platformVersion: '27.0.1', action: 'build-for-testing' });
  assert.equal(build[0], 'build-for-testing');
  assert.ok(build.includes('-allowProvisioningUpdates'));
  const test = tunnel.wdaBuildArgs({ phone: PHONE, platformVersion: '27.0.1', action: 'test-without-building' });
  assert.equal(test[0], 'test-without-building');
  assert.ok(!test.some(a => /allowProvisioning/.test(a)));
  for (const args of [build, test]) {
    assert.equal(args[args.indexOf('-destination') + 1], `id=${PU}`);
    assert.equal(args[args.indexOf('-derivedDataPath') + 1], path.join(dir, 'appium', 'wda-device'));
    assert.equal(args[args.indexOf('-scheme') + 1], 'WebDriverAgentRunner');
    assert.ok(args[args.indexOf('-project') + 1].endsWith(path.join('appium-webdriveragent', 'WebDriverAgent.xcodeproj')));
    assert.ok(args.includes('DEVELOPMENT_TEAM=ABCDE12345'));
    assert.ok(args.includes('CODE_SIGN_IDENTITY=Apple Development'));
    assert.ok(args.includes('PRODUCT_BUNDLE_IDENTIFIER=com.example.msl-wda-abcd'));
    assert.ok(args.includes('IPHONEOS_DEPLOYMENT_TARGET=27.0'));
    assert.ok(!args.includes('booted') && !args.some(a => /^--?udid/.test(a)));
  }
  assert.ok(!tunnel.wdaBuildArgs({ phone: PHONE, platformVersion: null, action: 'test-without-building' }).some(a => /DEPLOYMENT_TARGET/.test(a)));
});

test('launchWda: a built runner is started detached with USE_IP and USE_PORT, and /status is polled until it answers', async () => {
  withBuild();
  const out = await tunnel.launchWda({ phone: PHONE, tunnel: TUN, platformVersion: '27.0.1' });
  assert.deepEqual(out, { pid: 9001, built: false });
  assert.ok(!calls.some(c => c[0] === 'xcodebuild'), 'nothing is built when the xctestrun exists');
  assert.equal(spawned.length, 1);
  const [s] = spawned;
  assert.equal(s.cmd, 'xcodebuild');
  assert.equal(s.args[0], 'test-without-building');
  assert.equal(s.args[s.args.indexOf('-destination') + 1], `id=${PU}`);
  assert.equal(s.args[s.args.indexOf('-derivedDataPath') + 1], wdaDerivedData());
  assert.equal(s.env.USE_IP, 'fd00:1234::1');
  assert.equal(s.env.USE_PORT, '8100');
  assert.equal(s.log, path.join(process.env.MSL_LOGS, 'msl-wda-device.log'));
  assert.equal(fs.statSync(s.log).mode & 0o777, 0o600);
  assert.equal(polls, 3, 'answered after N polls');
});

test('launchWda: with no xctestrun it builds first (signing allowed), then starts it', async () => {
  const out = await tunnel.launchWda({ phone: PHONE, tunnel: TUN, platformVersion: '27.0.1' });
  assert.equal(out.built, true);
  const build = calls.find(c => c[0] === 'xcodebuild');
  assert.equal(build[1], 'build-for-testing');
  assert.ok(build.includes('-allowProvisioningUpdates'));
  assert.ok(calls.indexOf(build) >= 0 && spawned.length === 1);
});

test('launchWda: a failed build is classified and nothing is started', async () => {
  fakeRunner(cmd => (cmd === 'xcodebuild' ? { code: 65, stderr: 'error: No Account for Team "ABCDE12345"' } : undefined));
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN }), e => e.extra.needs === 'xcode-account');
  fakeRunner(cmd => (cmd === 'xcodebuild' ? { code: 124 } : undefined));
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN }), e => /timed out/.test(e.message));
  assert.equal(spawned.length, 0);
});

test('launchWda: the build runs asynchronously with the limit and the lease renewal; an interrupt during it ends the command and starts nothing', async () => {
  let seen;
  setAsyncRunner((cmd, args, opts) => { seen = { cmd, args, opts }; return Promise.reject(new InterruptError('SIGTERM')); });
  const touch = async () => {};
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN, platformVersion: '27.0.1', touch }), e => e instanceof InterruptError && e.signal === 'SIGTERM');
  assert.equal(seen.cmd, 'xcodebuild');
  assert.equal(seen.args[0], 'build-for-testing');
  assert.deepEqual([seen.opts.timeoutMs, seen.opts.onTick === touch, seen.opts.tickMs], [tunnel.WDA_WAIT.buildMs, true, tunnel.WDA_WAIT.touchMs]);
  assert.deepEqual([realWait.buildMs, realWait.touchMs], [600e3, 60e3], 'the real limits: ten minutes, renewed every minute');
  assert.equal(spawned.length, 0);
});

test('launchWda: no answer in time stops the xcodebuild and the log\'s end says why (passcode, re-sign)', async () => {
  withBuild();
  statusAfter = Infinity;
  const procs = `  9001     1 /usr/bin/xcodebuild test-without-building -destination id=${PU} -derivedDataPath ${wdaDerivedData()}\n`;
  let running = true;
  fakeRunner((cmd, args) => {
    if (cmd === 'ps' && args.includes('-ax')) return { stdout: running ? procs : '' };
    if (cmd === 'ps' && args.includes('command=')) return running ? { stdout: procs.trim().split(/\s+/).slice(2).join(' ') } : { code: 1 };
  });
  svc.setKill((pid, sig) => { killed.push([pid, sig]); running = false; });

  spawnLog = 'xcodebuild: Timed out while enabling automation mode.\n';
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN }), e => e.extra.needs === 'passcode' && /did not answer on the tunnel address/.test(e.message));
  assert.deepEqual(killed, [[9001, 'SIGTERM']], 'the xcodebuild is stopped');

  running = true;
  killed = [];
  spawnLog = 'error: 0xe8008018 The identity used to sign the executable is no longer valid\n';
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN }), e => e.extra.needs === 'resign');
  assert.deepEqual(killed, [[9001, 'SIGTERM']]);

  running = true;
  spawnLog = 'nothing useful\n';
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN }), e => e.extra.needs === 'tunnel' && /no tunnel is recorded/.test(e.message));
});

test('launchWda: a start that gives no pid is an error, not a wait', async () => {
  withBuild();
  setSpawner(() => ({ pid: null }));
  await assert.rejects(tunnel.launchWda({ phone: PHONE, tunnel: TUN }), /couldn't start xcodebuild/);
});

test('the WebDriverAgent xcodebuild the lab started (its child, or an orphan) is a target; another process\'s child is not', () => {
  const line = `/usr/bin/xcodebuild test-without-building -destination id=${PU} -derivedDataPath ${wdaDerivedData()}`;
  const mine = deviceWdaTargets({ phone: PHONE }, [{ pid: 11, ppid: process.pid, command: line }]);
  assert.deepEqual(mine.map(t => t.pid), [11]);
  assert.deepEqual(deviceWdaTargets({ phone: PHONE }, [{ pid: 12, ppid: 1, command: line }]).map(t => t.pid), [12]);
  assert.deepEqual(deviceWdaTargets({ phone: PHONE }, [{ pid: 13, ppid: 4321, command: line }]), []);
});

// --- stopping the runner on the phone (#86) ---

const XCODEBUILD_LINE = () => `/usr/bin/xcodebuild test-without-building -destination id=${PU} -derivedDataPath ${wdaDerivedData()}`;
const RUNNER = 'file:///private/var/containers/Bundle/Application/ABC/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner';
const OTHERS = [
  { executable: 'file:///private/var/containers/Bundle/Application/DEF/MobileSafari.app/MobileSafari', processIdentifier: 500 },
  { executable: 'file:///private/var/containers/Bundle/Application/GHI/NotWebDriverAgentRunner-Runner.app/x', processIdentifier: 501 },
];

// The Mac's xcodebuild and the phone's process list, as stand-ins. `runners`: pids of the runner app on the phone;
// `sticky`: a SIGKILL does not remove them; `listFails`: devicectl can't list. `order` records the shutdown and the SIGTERM.
function stopWorld({ xcodebuild = true, runners = [], sticky = false, listFails = false } = {}) {
  const w = { running: xcodebuild, runners: new Set(runners), devicectl: [], order: [] };
  onShutdown = () => { w.order.push('shutdown'); };
  w.calls = fakeRunner((cmd, args) => {
    if (cmd === 'ps' && args.includes('-ax')) return { stdout: w.running ? `  9001     1 ${XCODEBUILD_LINE()}\n` : '' };
    if (cmd === 'ps' && args.includes('command=')) return w.running ? { stdout: XCODEBUILD_LINE() } : { code: 1 };
    if (cmd !== 'xcrun' || args[0] !== 'devicectl') return undefined;
    w.devicectl.push(args);
    const out = args[args.indexOf('--json-output') + 1];
    if (args.slice(1, 4).join(' ') === 'device info processes') {
      if (listFails) return { code: 1, stderr: 'The device is not connected' };
      fs.writeFileSync(out, JSON.stringify({ result: { runningProcesses: [...OTHERS, ...[...w.runners].map(processIdentifier => ({ executable: RUNNER, processIdentifier }))] } }));
    } else if (args.slice(1, 4).join(' ') === 'device process signal' && !sticky) {
      w.runners.delete(Number(args[args.indexOf('--pid') + 1]));
    }
    return { code: 0 };
  });
  svc.setKill((pid, sig) => { w.order.push(sig); killed.push([pid, sig]); w.running = false; });
  return w;
}
const signals = w => w.devicectl.filter(a => a.slice(1, 4).join(' ') === 'device process signal');

test('stopDeviceWda: the runner is asked to shut down before the xcodebuild is SIGTERMed (it is still there after the wait)', async () => {
  const w = stopWorld({ runners: [] });
  const out = await stopDeviceWda({ phone: PHONE }, { address: TUN.address });
  assert.equal(shutdowns, 1);
  assert.deepEqual(w.order, ['shutdown', 'SIGTERM']);
  assert.deepEqual(killed, [[9001, 'SIGTERM']]);
  assert.match(out.found, /^runner asked to shut down; xcodebuild \(pid 9001\)$/);
  assert.equal(out.did, 'stopped xcodebuild (pid 9001)');
});

test('stopDeviceWda: an xcodebuild that exits by itself after the shutdown is not SIGTERMed', async () => {
  const w = stopWorld();
  onShutdown = () => { w.order.push('shutdown'); setTimeout(() => { w.running = false; }, 10); };
  const out = await stopDeviceWda({ phone: PHONE }, { address: TUN.address });
  assert.deepEqual(w.order, ['shutdown']);
  assert.deepEqual(killed, []);
  assert.equal(out.did, 'its xcodebuild exited by itself');
  assert.deepEqual(signals(w), [], 'no runner was listed, so none was signalled');
});

test('stopDeviceWda: a tunnel that does not answer skips the shutdown, SIGTERMs the xcodebuild and kills the listed runner', async () => {
  const w = stopWorld({ runners: [1234] });
  tunnel.WDA.url = () => 'http://127.0.0.1:1';
  const out = await stopDeviceWda({ phone: PHONE }, { address: TUN.address });
  assert.equal(shutdowns, 0);
  assert.deepEqual(killed, [[9001, 'SIGTERM']]);
  assert.equal(signals(w).length, 1);
  assert.match(out.found, /runner app on the phone \(pid 1234\)/);
  assert.match(out.did, /sent SIGKILL to the runner \(pid 1234\); it is gone/);
});

test('stopDeviceWda: only the runner\'s pid is signalled, with SIGKILL, and every devicectl call carries the saved UDID', async () => {
  const w = stopWorld({ xcodebuild: false, runners: [1234, 1300] });
  tunnel.WDA.url = () => 'http://127.0.0.1:1';
  await stopDeviceWda({ phone: PHONE, target: { device: PU } }, { address: TUN.address });
  const sent = signals(w);
  assert.deepEqual(sent.map(a => a[a.indexOf('--pid') + 1]).sort(), ['1234', '1300'], 'not Safari (500), not the lookalike (501)');
  for (const a of sent) assert.equal(a[a.indexOf('--signal') + 1], 'SIGKILL');
  assert.ok(w.devicectl.length >= 3, 'a list, the signals, a list again');
  for (const a of w.devicectl) {
    assert.equal(a[a.indexOf('--device') + 1], PU);
    assert.ok(!a.includes('booted'));
  }
  assert.deepEqual(killed, []);
});

test('stopDeviceWda: a runner still listed after SIGKILL is reported, with what to do', async () => {
  stopWorld({ xcodebuild: false, runners: [1234], sticky: true });
  tunnel.WDA.url = () => 'http://127.0.0.1:1';
  await assert.rejects(stopDeviceWda({ phone: PHONE }, { address: TUN.address }), /still on the phone \(pid 1234\) after SIGKILL.*volume buttons.*`lab down`/);
  // The message says the whole picture first (the earlier part of the step too), then what to do.
  await assert.rejects(stopDeviceWda({ phone: PHONE }, { address: TUN.address, prior: { found: 'xcodebuild (pid 55)', did: 'stopped xcodebuild (pid 55)' } }),
    e => /after SIGKILL \(found: xcodebuild \(pid 55\); runner app on the phone \(pid 1234\); did: stopped xcodebuild \(pid 55\); sent SIGKILL to pid 1234\): hold both volume buttons/.test(e.message));
});

test('stopDeviceWda: no runner on the phone sends no signal and, with nothing else found, says nothing', async () => {
  const w = stopWorld({ xcodebuild: false });
  tunnel.WDA.url = () => 'http://127.0.0.1:1';
  assert.equal(await stopDeviceWda({ phone: PHONE }, { address: TUN.address }), null);
  assert.equal(w.devicectl.length, 1, 'one list');
  assert.deepEqual(signals(w), []);
});

test('stopDeviceWda: a phone that can\'t be listed is a note, not a failure', async () => {
  stopWorld({ xcodebuild: false, listFails: true });
  tunnel.WDA.url = () => 'http://127.0.0.1:1';
  const out = await stopDeviceWda({ phone: PHONE }, { address: TUN.address });
  assert.match(out.found, /couldn't list the phone's processes: The device is not connected/);
  assert.equal(out.did, null);
});

test('stopDeviceWda: no tunnel, no xcodebuild and no device session means no devicectl call; device: false never makes one', async () => {
  const w = stopWorld({ xcodebuild: false, runners: [1234] });
  assert.equal(await stopDeviceWda({ phone: PHONE }), null);
  assert.equal(await stopDeviceWda({ phone: PHONE, target: { device: PU } }, { device: false }), null);
  assert.deepEqual(w.devicectl, []);
  assert.equal(shutdowns, 0);
  const cable = await stopDeviceWda({ phone: PHONE, target: { device: PU } });
  assert.match(cable.did, /sent SIGKILL/, 'a recorded device session (a cable one too) is checked');
});

test('stopDeviceWda: a retry after a failed step (no target, no tunnel, no xcodebuild) still reads the phone when the last run was on it (deviceRun)', async () => {
  const w = stopWorld({ xcodebuild: false, runners: [1234] });
  const out = await stopDeviceWda({ phone: PHONE }, { deviceRun: true });
  assert.deepEqual(signals(w).map(a => a[a.indexOf('--pid') + 1]), ['1234']);
  assert.match(out.did, /sent SIGKILL/);
  stopWorld({ xcodebuild: false, runners: [1234], sticky: true });
  await assert.rejects(stopDeviceWda({ phone: PHONE }, { deviceRun: true }), /still on the phone/);
});
