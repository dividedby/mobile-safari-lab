// The Wi-Fi tunnel (#15): tunnel.json, the registry key, and the tunnel host against a fake
// pymobiledevice3 (test/fixtures/fake-pmd3), a stand-in registry and a temp HOME.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, tempDir } from './helpers.js';
import { saveState } from '../lib/core.js';
import * as tunnel from '../lib/tunnel.js';
import { runHost, parseTunnelLine, catalogOf, toolFailure, HOST_WAIT } from '../lib/tunnel-host.js';

const PU = '00008000-000A1B2C3D4E5F60';
const PHONE = { udid: PU, teamId: 'ABCDE12345', bundleId: 'com.example.msl-wda-abcd' };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE = path.join(FIXTURES, 'fake-pmd3');
// A rich-style traceback box ending in the exception line. Constructed to look like the tool's
// output (#107), not captured from a real run.
const REFUSED_FILE = path.join(FIXTURES, 'phone', 'rsd-info-refused-constructed-stderr.txt');
const REFUSED = "ConnectionRefusedError: [Errno 61] Connect call failed ('fd00::1', 58783, 0, 0)";

let home, fakeDir, pmd3, hosts;
beforeEach(() => {
  hosts = [];
  const dir = sandbox();
  home = path.join(dir, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
  fakeDir = tempDir('msl-fake-pmd3-');
  pmd3 = path.join(fakeDir, 'pymobiledevice3');
  fs.writeFileSync(pmd3, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  process.env.FAKE_DIR = fakeDir;
  process.env.FAKE_UDID = PU;
  process.env.FAKE_MODE = 'ok';
  // Generous limits: the fake tool is a node start (twice per handshake) and a loaded machine can take seconds;
  // the tests that need a short limit set it themselves, and the host ends every run with a reason by these limits.
  Object.assign(HOST_WAIT, { lineMs: 30e3, rsdMs: 15e3, rsdTries: 3, rsdGapMs: 10, probeEveryMs: 20, probeFails: 3, probeMs: 50, killMs: 2e3, registryStopMs: 2e3 });
  saveState({ phone: PHONE });
});

// Whatever a test leaves running (it failed before signalling the host, or never did) is stopped
// here, so a failing test never leaves a fake tool holding the run open: SIGTERM each host and wait
// for its own teardown; only a host that does not finish within its limits has its tool pids killed.
afterEach(async () => {
  for (const h of hosts) h.signals.emit('SIGTERM');
  const bound = HOST_WAIT.killMs + HOST_WAIT.registryStopMs + 5e3;
  const stuck = (await Promise.all(hosts.map(h => Promise.race([h.done.then(() => false, () => false), new Promise(r => setTimeout(r, bound, true).unref())])))).some(Boolean);
  if (!stuck) return;
  for (const f of ['tool.pid', 'rsd.pid']) {
    try { process.kill(Number(fs.readFileSync(path.join(fakeDir, f), 'utf8')), 'SIGKILL'); } catch { /* gone or never started */ }
  }
});

const record = (extra = {}) => ({ v: 1, pid: 4242, udid: PU, address: 'fd00:1234::1', rsdPort: 54321, registryPort: 42314, startedAt: new Date().toISOString(), state: 'up', strongboxWas: null, strongboxOurs: true, ...extra });

// --- tunnel.json ---

test('tunnel.json: written atomically and owner-only, read back whole', () => {
  assert.equal(tunnel.readTunnel(), null);
  tunnel.writeTunnel(record());
  assert.deepEqual(tunnel.readTunnel(), record({ startedAt: tunnel.readTunnel().startedAt }));
  assert.equal(fs.statSync(tunnel.tunnelFile()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(tunnel.tunnelFile())).filter(f => f.endsWith('.tmp')), [], 'no temp file left');
  tunnel.clearTunnel();
  assert.equal(tunnel.readTunnel(), null);
});

test('tunnel.json: every bad field, an unknown key and broken JSON are damaged', () => {
  const bad = [
    { v: 2 }, { pid: 1 }, { pid: '4242' }, { udid: 'nope' }, { address: '192.168.1.5' }, { address: 'fe80::1' }, { address: 'fd00::1; rm' },
    { rsdPort: 0 }, { rsdPort: 70000 }, { registryPort: '42314' }, { startedAt: 'yesterday' }, { state: 'running' },
    { reason: 'x'.repeat(201) }, { reason: 7 }, { strongboxWas: 42314 }, { strongboxOurs: 'yes' }, { extra: 1 },
    { state: 'up', address: null }, { state: 'up', registryPort: null },
    { detail: 7 }, { detail: null }, { detail: 'x'.repeat(201) },
    { osVersion: 27 }, { osVersion: 'latest' }, { osVersion: '27.0.1; rm' }, { osVersion: '1'.repeat(17) }, { osVersion: null },
  ];
  for (const b of bad) {
    assert.equal(tunnel.checkTunnel(record(b)), false, JSON.stringify(b));
    assert.throws(() => tunnel.writeTunnel(record(b)), /not a tunnel record/);
    fs.mkdirSync(path.dirname(tunnel.tunnelFile()), { recursive: true });
    fs.writeFileSync(tunnel.tunnelFile(), JSON.stringify(record(b)));
    assert.throws(() => tunnel.readTunnel(), /tunnel record \(tunnel\.json\) is damaged: run `lab tunnel down`/);
  }
  fs.writeFileSync(tunnel.tunnelFile(), '{');
  assert.throws(() => tunnel.readTunnel(), /damaged/);
  assert.equal(tunnel.checkTunnel(record({ osVersion: '27.0.1' })), true);
  assert.equal(tunnel.checkTunnel(record({ osVersion: '27.1' })), true);
  assert.equal(tunnel.checkTunnel(record({ state: 'down', reason: 'rsd-failed', detail: 'x'.repeat(200) })), true);
  // Starting and down records may lack the address and ports.
  assert.equal(tunnel.checkTunnel(record({ state: 'starting', address: null, rsdPort: null, registryPort: null, strongboxOurs: false })), true);
  assert.equal(tunnel.checkTunnel(record({ state: 'down', reason: 'wrong-device', address: null, rsdPort: null, registryPort: null })), true);
});

test('restoreStrongbox puts back the old value or removes the key, only while it holds our port', () => {
  tunnel.strongbox.write('42314');
  assert.equal(tunnel.restoreStrongbox(record()), true);
  assert.equal(tunnel.strongbox.read(), null);
  tunnel.strongbox.write('42314');
  assert.equal(tunnel.restoreStrongbox(record({ strongboxWas: '41000' })), true);
  assert.equal(tunnel.strongbox.read(), '41000');
  // Someone else's value now: untouched.
  tunnel.strongbox.write('50000');
  assert.equal(tunnel.restoreStrongbox(record()), false);
  assert.equal(tunnel.strongbox.read(), '50000');
  assert.equal(tunnel.restoreStrongbox(record({ strongboxOurs: false, registryPort: 50000 })), false);
  assert.equal(tunnel.strongbox.read(), '50000');
  assert.ok(tunnel.strongboxFile().startsWith(home), 'the key lives under HOME');
  tunnel.strongbox.write('42314');
  assert.equal(fs.statSync(tunnel.strongboxFile()).mode & 0o777, 0o600);
  fs.chmodSync(tunnel.strongboxFile(), 0o644);
  tunnel.strongbox.write('42315');
  assert.equal(fs.statSync(tunnel.strongboxFile()).mode & 0o777, 0o600, 'also when the key existed with another mode');
  assert.equal(fs.statSync(path.dirname(tunnel.strongboxFile())).mode & 0o777, 0o700, 'a folder the lab makes is owner-only');
  // The folder is Appium's (xcuitest's strongbox), not the lab's: one that exists keeps its mode.
  fs.chmodSync(path.dirname(tunnel.strongboxFile()), 0o755);
  tunnel.strongbox.write('42316');
  assert.equal(fs.statSync(path.dirname(tunnel.strongboxFile())).mode & 0o777, 0o755, 'an existing folder is left alone');
});

test('parseTunnelLine takes only an fd… address and a port', () => {
  assert.deepEqual(parseTunnelLine('fd00:1234::1 54321\n'), { address: 'fd00:1234::1', rsdPort: 54321 });
  for (const l of ['192.168.1.5 54321', 'fe80::1 54321', 'fd00::1', 'fd00::1 0', 'fd00::1 99999', 'fd00::1 543 21', '', 'Tunnel ready', 'FD00::1 54321']) {
    assert.equal(parseTunnelLine(l), null, l);
  }
});

test('toolFailure: the exception line of a rich traceback box, with ANSI codes and without', () => {
  const box = fs.readFileSync(REFUSED_FILE, 'utf8');
  assert.equal(toolFailure(box), REFUSED);
  // Colours around the box and the exception, and a carriage-return line ending.
  const coloured = box.split('\n').map(l => (l.startsWith('ConnectionRefused') ? `\x1b[1;31mConnectionRefusedError\x1b[0m\x1b[31m:${l.slice('ConnectionRefusedError:'.length)}\x1b[0m` : `\x1b[2m${l}\x1b[0m`)).join('\r\n');
  assert.ok(coloured.includes('\x1b['));
  assert.equal(toolFailure(coloured), REFUSED);
  // The last exception line wins: a chained traceback ends in the cause that was raised last.
  assert.equal(toolFailure(`TimeoutError\n\nThe above exception was the direct cause of:\n\n${box}`), REFUSED);
  for (const line of ['TimeoutError', 'asyncio.exceptions.TimeoutError: timed out', 'OSError: [Errno 65] No route to host', 'KeyboardInterrupt']) assert.equal(toolFailure(`│ frame │\n${line}\n`), line);
});

test('toolFailure: with no exception line it is the last plain line, else the text as it was', () => {
  assert.equal(toolFailure('╭─ Traceback ─╮\n│ frame │\nERROR: could not reach the device\nsee the log\n╰─╯\n'), 'see the log');
  const frames = 'Traceback (most recent call last):\n  File "x.py", line 3, in f\n';
  assert.equal(toolFailure(frames), frames, 'only frames: all of it');
  assert.equal(toolFailure('╭──╮\n│ │\n╰──╯\n'), '╭──╮\n│ │\n╰──╯\n');
  assert.equal(toolFailure('\x1b[31mplain\x1b[0m'), 'plain');
  assert.equal(toolFailure(''), '');
  assert.equal(toolFailure(undefined), '');
});

test('toolFailure: text with no decoration is kept whole, as it was before (#107)', () => {
  const plain = 'Error: could not do a thing\nCheck that the phone is unlocked\n';
  assert.equal(toolFailure(plain), plain);
  assert.equal(toolFailure('ConnectionTerminatedError\n'), 'ConnectionTerminatedError\n');
  assert.equal(toolFailure('ERROR: No device connected'), 'ERROR: No device connected');
  // One decoration is enough to reduce it.
  assert.equal(toolFailure('Error: could not do a thing\nTraceback (most recent call last):\n  File "x.py", line 3, in f\nOSError: gone\n'), 'OSError: gone');
});

test('toolFailure: an exception group gives its innermost exception line, not its rules or frames (#107)', () => {
  const group = [
    '  + Exception Group Traceback (most recent call last):',
    '  |   File "/x/main.py", line 9, in <module>',
    '  |     asyncio.run(go())',
    '  | ExceptionGroup: unhandled errors in a TaskGroup (1 sub-exception)',
    '  +-+---------------- 1 ----------------',
    '    | Traceback (most recent call last):',
    '    |   File "/x/y.py", line 4, in connect',
    "    | ConnectionRefusedError: [Errno 61] Connect call failed ('fd00::1', 58783, 0, 0)",
    '    +------------------------------------',
  ].join('\n');
  assert.equal(toolFailure(group), REFUSED);
  assert.equal(toolFailure('+---+\n| ExceptionGroup: boom (2 sub-exceptions)\n+---+\n'), 'ExceptionGroup: boom (2 sub-exceptions)');
  assert.equal(toolFailure('+---+\n| BaseExceptionGroup: boom\n+---+\n'), 'BaseExceptionGroup: boom');
  assert.equal(toolFailure('+---+\n| just a table row\n+---+\n'), '+---+\n| just a table row\n+---+\n', 'no exception and no plain line: all of it');
});

test('catalogOf keeps services with a port, as strings', () => {
  assert.deepEqual(catalogOf({ Services: { a: { Port: '53001' }, b: { Port: 53002 }, c: { Port: 'x' }, d: {} } }), { a: { port: '53001' }, b: { port: '53002' } });
  assert.deepEqual(catalogOf(null), {});
});

// --- the host ---

// A stand-in registry: it writes its port where xcuitest reads it, as remotexpc's does.
function fakeRegistry({ writeKey = true } = {}) {
  const r = { started: null, stopped: false };
  r.start = async (infos, port) => {
    r.started = { infos, port };
    if (writeKey) { // the library's own way: a plain write, its own mode
      fs.mkdirSync(path.dirname(tunnel.strongboxFile()), { recursive: true });
      fs.writeFileSync(tunnel.strongboxFile(), String(port), { mode: 0o644 });
      fs.chmodSync(tunnel.strongboxFile(), 0o644);
    }
    return { stop: async () => { r.stopped = true; } };
  };
  return r;
}

// Runs the host with the fake tool. `probe(host, port)` answers the TCP checks. Returns the
// host's promise and what it did.
function host({ probe = async () => true, registry = fakeRegistry(), signals = new EventEmitter() } = {}) {
  const w = { wda: 0, lines: [], registry, signals };
  w.done = runHost({ pmd3, startRegistry: registry.start, freePort: async () => 42999, stopWda: async () => { w.wda++; }, probe, signals, log: l => w.lines.push(l), pid: process.pid });
  hosts.push(w);
  return w;
}
const calls = () => fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const waitFor = async (test, ms = 3000) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
// Waits for `test` while the host runs: if the host ends first, that is the failure (with its reason), at once.
// The deadline is the host's own longest path to "up" (first line, every rsd-info try and gap) plus slack,
// so it can only be hit by a host that is stuck, not by a slow machine.
const hostLimit = () => HOST_WAIT.lineMs + HOST_WAIT.rsdTries * (HOST_WAIT.rsdMs + HOST_WAIT.rsdGapMs) + 5e3;
const until = async (w, test, ms = hostLimit()) => {
  let ended = null;
  w.done.then(r => { ended = r; }, e => { ended = { error: e.message }; });
  await waitFor(() => ended !== null || test(), ms);
  if (ended !== null && !test()) throw new Error(`the host ended first: ${JSON.stringify(ended)}`);
};
const upNow = () => { try { return tunnel.readTunnel()?.state === 'up'; } catch { return false; } };

test('host: opens the tunnel for the saved UDID, checks the device, starts the registry, records up; SIGTERM tears it all down', async () => {
  const w = host({ probe: async (h, p) => h !== '127.0.0.1' || p !== 42314 });
  await until(w, upNow);
  const rec = tunnel.readTunnel();
  assert.deepEqual([rec.state, rec.address, rec.rsdPort, rec.registryPort, rec.udid, rec.pid, rec.strongboxOurs, rec.strongboxWas], ['up', 'fd00:1234::1', 54321, 42999, PU, process.pid, true, null]);
  assert.equal(tunnel.strongbox.read(), '42999');
  assert.equal(fs.statSync(tunnel.strongboxFile()).mode & 0o777, 0o600, 'the key the registry wrote is owner-only');
  const [start, rsd] = calls();
  assert.deepEqual(start.argv, ['remote', 'start-tunnel', '--native', '--udid', PU, '--script-mode']);
  assert.equal(start.stdinNull, true, 'stdin is /dev/null');
  assert.deepEqual(rsd.argv, ['remote', 'rsd-info', '--native'], 'remoted\'s UUID, not --rsd: a new UUID closes every listener on iOS 27.2 (#111)');
  assert.equal(rsd.udidEnv, PU, 'rsd-info asks for the saved phone');
  assert.equal(start.udidEnv, null);
  assert.equal(rec.osVersion, '27.0.1', 'the iOS version the handshake reported is recorded');
  const entry = w.registry.started.infos.tunnels[PU];
  assert.deepEqual([entry.udid, entry.address, entry.rsdPort, Object.keys(entry.services)], [PU, 'fd00:1234::1', 54321, ['com.apple.webinspector.shim.remote', 'com.apple.dt.testmanagerd.remote']]);

  w.signals.emit('SIGTERM');
  assert.deepEqual(await w.done, { code: 0, reason: 'stopped' });
  const down = tunnel.readTunnel();
  assert.deepEqual([down.state, down.reason, down.strongboxOurs], ['down', 'stopped', false]);
  assert.equal(tunnel.strongbox.read(), null, 'the key is removed (it was absent before)');
  assert.equal(w.registry.stopped, true);
  assert.equal(w.wda, 1, 'the phone\'s WebDriverAgent is stopped');
});

test('host: a device other than the saved phone is refused and the tool is killed', async () => {
  process.env.FAKE_MODE = 'wrong-udid';
  const w = host();
  assert.deepEqual(await w.done, { code: 1, reason: 'wrong-device' });
  assert.equal(tunnel.readTunnel().state, 'down');
  assert.equal(w.registry.started, null, 'no registry for another device');
  assert.equal(tunnel.strongbox.read(), null);
  assert.equal(w.wda, 1, 'the phone\'s WebDriverAgent is stopped on any end, up or not');
});

test('host: the tool exiting after the tunnel was up restores the key, stops WebDriverAgent and records down', async () => {
  process.env.FAKE_MODE = 'exit-early';
  process.env.FAKE_EXIT_MS = '400';
  tunnel.strongbox.write('41000'); // a stale value from an earlier registry: nothing listens there
  const w = host({ probe: async h => h !== '127.0.0.1' });
  const out = await w.done;
  assert.deepEqual(out, { code: 1, reason: 'tool-exited' });
  assert.equal(tunnel.strongbox.read(), '41000', 'the old value is put back');
  assert.equal(w.wda, 1);
  assert.equal(w.registry.stopped, true);
  assert.deepEqual([tunnel.readTunnel().state, tunnel.readTunnel().reason], ['down', 'tool-exited']);
});

test('host: three failed TCP checks in a row tear the tunnel down', async () => {
  let checks = 0;
  const w = host({ probe: async h => (h === '127.0.0.1' ? false : (++checks, false)) });
  assert.deepEqual(await w.done, { code: 1, reason: 'unreachable' });
  assert.equal(checks, 3);
  assert.equal(w.wda, 1);
  assert.equal(tunnel.strongbox.read(), null);
});

test('host: a live foreign registry key is left alone and the host refuses', async () => {
  tunnel.strongbox.write('43000');
  const w = host({ probe: async (h, p) => h === '127.0.0.1' && p === 43000 });
  assert.deepEqual(await w.done, { code: 1, reason: 'registry-busy' });
  assert.equal(tunnel.strongbox.read(), '43000');
  assert.equal(w.registry.started, null);
});

test('host: a registry that does not write the key where xcuitest reads it is stopped', async () => {
  const w = host({ registry: fakeRegistry({ writeKey: false }) });
  assert.deepEqual(await w.done, { code: 1, reason: 'registry-key' });
  assert.equal(w.registry.stopped, true);
});

test('host: a silent tool is CoreDevice being stuck; no device listed is not-listed; rsd-info is tried three times', async () => {
  HOST_WAIT.lineMs = 300;
  process.env.FAKE_MODE = 'silent';
  assert.deepEqual(await host().done, { code: 1, reason: 'coredevice-silent' });
  HOST_WAIT.lineMs = 30e3; // this tool exits at once; only the silent one needs the short limit, and a slow node start must not trip it
  process.env.FAKE_MODE = 'no-device';
  assert.deepEqual(await host().done, { code: 1, reason: 'not-listed' });

  process.env.FAKE_MODE = 'rsd-fail-twice';
  const w = host();
  await until(w, upNow);
  assert.equal(fs.readFileSync(path.join(fakeDir, 'rsd-count'), 'utf8'), '3');
  w.signals.emit('SIGTERM');
  assert.equal((await w.done).reason, 'stopped');
});

test('host: rsd-info failing three times logs and records the tool\'s exception line, not the start of its traceback box (#107)', async () => {
  process.env.FAKE_MODE = 'rsd-fail';
  process.env.FAKE_RSD_STDERR = REFUSED_FILE;
  const w = host();
  assert.deepEqual(await w.done, { code: 1, reason: 'rsd-failed' });
  assert.equal(fs.readFileSync(path.join(fakeDir, 'rsd-count'), 'utf8'), '3');
  assert.ok(w.lines.includes(`rsd-info failed 3 times: rsd-info failed (exit 1): ${REFUSED}`), w.lines.join('\n'));
  const rec = tunnel.readTunnel();
  assert.deepEqual([rec.state, rec.reason, rec.detail], ['down', 'rsd-failed', REFUSED]);
  assert.equal(w.lines.at(-1), 'down: rsd-failed');
  assert.equal(tunnel.strongbox.read(), null);
  assert.equal(w.wda, 1);
});

test('host: a device id in the tool\'s message is masked in the record\'s detail and the log (#107)', async () => {
  process.env.FAKE_MODE = 'rsd-fail';
  const file = path.join(fakeDir, 'stderr.txt');
  fs.writeFileSync(file, `│ frame │\nOSError: [Errno 65] No route to host (${PU}, 0123456789abcdef0123456789abcdef01234567)\n`);
  process.env.FAKE_RSD_STDERR = file;
  const w = host();
  await w.done;
  const { detail } = tunnel.readTunnel();
  assert.match(detail, /^OSError: \[Errno 65\] No route to host \(<udid>, …4567\)$/);
  assert.equal(detail.includes('A1B2C3D4E5F60') || detail.includes('0123456789abcdef0123'), false);
  assert.equal(w.lines.some(l => l.includes('A1B2C3D4E5F60')), false, 'the log line too');
});

test('host: an id that the 160-character limit would cut in two is masked first (#107)', async () => {
  process.env.FAKE_MODE = 'rsd-fail';
  const file = path.join(fakeDir, 'stderr.txt');
  const id = '0123456789abcdef0123456789abcdef01234567';
  const lead = `OSError: ${'x '.repeat(70)}`; // 149 characters: the id starts 11 before the limit
  fs.writeFileSync(file, `│ frame │\n${lead}${id}\n`);
  process.env.FAKE_RSD_STDERR = file;
  const w = host();
  await w.done;
  assert.equal(tunnel.readTunnel().detail, `${lead}…4567`);
  assert.equal(w.lines.some(l => l.includes(id.slice(0, 11))), false, 'the log line too');
});

test('host: both tool processes run with a wide terminal, so rich does not wrap the exception line (#107)', async () => {
  process.env.FAKE_MODE = 'rsd-fail';
  process.env.FAKE_RSD_STDERR = REFUSED_FILE;
  await host().done;
  const made = calls();
  assert.deepEqual(made.map(c => c.argv[1]).slice(0, 2), ['start-tunnel', 'rsd-info']);
  assert.deepEqual(made.map(c => c.columns), made.map(() => '500'));
});

test('host: the tool exiting before the tunnel keeps plain multi-line text whole, and reduces a traceback box to its exception line (#107)', async () => {
  process.env.FAKE_MODE = 'start-fail';
  const file = path.join(fakeDir, 'start.txt');
  fs.writeFileSync(file, 'Error: could not do a thing\nCheck that the phone is unlocked\n');
  process.env.FAKE_START_STDERR = file;
  let w = host();
  assert.deepEqual(await w.done, { code: 1, reason: 'tool-exited: Error: could not do a thing Check that the phone is unlocked' });
  assert.ok(w.lines.includes('the tool exited (code 1) before the tunnel was up: Error: could not do a thing Check that the phone is unlocked'), w.lines.join('\n'));

  process.env.FAKE_START_STDERR = REFUSED_FILE;
  w = host();
  assert.deepEqual(await w.done, { code: 1, reason: `tool-exited: ${REFUSED}` });
  assert.equal(tunnel.readTunnel().reason, `tool-exited: ${REFUSED}`);
});

test('host: no saved phone writes nothing; SIGTERM while starting still records down', async () => {
  saveState({ phone: null });
  assert.deepEqual(await host().done, { code: 1, reason: 'no-phone' });
  assert.equal(tunnel.readTunnel(), null);

  saveState({ phone: PHONE });
  process.env.FAKE_MODE = 'silent';
  const w = host();
  await until(w, () => fs.existsSync(path.join(fakeDir, 'calls.log')));
  w.signals.emit('SIGTERM');
  assert.deepEqual(await w.done, { code: 0, reason: 'stopped' });
  assert.equal(tunnel.readTunnel().state, 'down');
});

test('host: a second SIGTERM during the teardown does not end it; the key, the registry and the record are still finished', async () => {
  let release;
  const slowWda = new Promise(r => { release = r; });
  const registry = fakeRegistry();
  const signals = new EventEmitter();
  const w = { lines: [], registry, signals };
  w.done = runHost({ pmd3, startRegistry: registry.start, freePort: async () => 42999, stopWda: () => slowWda, probe: async () => true, signals, log: l => w.lines.push(l), pid: process.pid });
  hosts.push(w);
  await until(w, upNow);
  assert.equal(tunnel.strongbox.read(), '42999');
  signals.emit('SIGTERM');
  await waitFor(() => signals.listenerCount('SIGTERM') > 0 && w.lines.some(l => /^up:/.test(l)) && tunnel.readTunnel().state === 'up');
  await new Promise(r => setTimeout(r, 100)); // the teardown is now waiting for WebDriverAgent
  assert.equal(signals.listenerCount('SIGTERM'), 1, 'a swallowing handler stays installed through the teardown');
  signals.emit('SIGTERM'); // stopTunnel's fallback
  signals.emit('SIGINT');
  assert.equal(tunnel.readTunnel().state, 'up', 'not finished yet');
  release();
  assert.deepEqual(await w.done, { code: 0, reason: 'stopped' });
  assert.equal(tunnel.readTunnel().state, 'down');
  assert.equal(tunnel.strongbox.read(), null);
  assert.equal(registry.stopped, true);
  assert.deepEqual(['SIGTERM', 'SIGINT', 'SIGHUP'].map(s => signals.listenerCount(s)), [0, 0, 0], 'nothing is left installed afterwards');
  assert.ok(w.lines.some(l => /already stopping/.test(l)));
});

test('host: an over-long iOS version is not recorded, and the final down record still saves', async () => {
  process.env.FAKE_OSVERSION = `${'1'.repeat(20)}.0`;
  try {
    const w = host();
    await until(w, upNow);
    assert.equal(tunnel.readTunnel().osVersion, undefined);
    w.signals.emit('SIGTERM');
    assert.deepEqual(await w.done, { code: 0, reason: 'stopped' });
    assert.equal(tunnel.readTunnel().state, 'down');
  } finally { delete process.env.FAKE_OSVERSION; }
});

test('host: a registry that does not stop is given up on after its limit, and the rest of the teardown runs', async () => {
  HOST_WAIT.registryStopMs = 100;
  const registry = { started: null, stopped: false, start: async (infos, port) => { fs.mkdirSync(path.dirname(tunnel.strongboxFile()), { recursive: true }); fs.writeFileSync(tunnel.strongboxFile(), String(port)); return { stop: () => new Promise(() => {}) }; } };
  const signals = new EventEmitter();
  const w = { lines: [] };
  w.done = runHost({ pmd3, startRegistry: registry.start, freePort: async () => 42999, stopWda: async () => {}, probe: async () => true, signals, log: l => w.lines.push(l), pid: process.pid });
  hosts.push({ done: w.done, signals });
  await until(w, upNow);
  signals.emit('SIGTERM');
  assert.deepEqual(await w.done, { code: 0, reason: 'stopped' });
  assert.equal(tunnel.readTunnel().state, 'down');
  assert.equal(tunnel.strongbox.read(), null);
  assert.ok(w.lines.some(l => /couldn't stop the registry/.test(l)));
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = name => Number(fs.readFileSync(path.join(fakeDir, name), 'utf8'));

test('host: SIGTERM while rsd-info is running tears down at once: the tools are killed, state down, WebDriverAgent stopped', async () => {
  HOST_WAIT.rsdMs = 30e3; // a handshake that would block a synchronous host for 30 s
  process.env.FAKE_MODE = 'rsd-slow';
  const w = host();
  await until(w, () => fs.existsSync(path.join(fakeDir, 'rsd.pid'))); // node's start can take seconds on a loaded runner
  const [tool, rsd] = [pidOf('tool.pid'), pidOf('rsd.pid')];
  const t = Date.now();
  w.signals.emit('SIGTERM');
  assert.deepEqual(await w.done, { code: 0, reason: 'stopped' });
  assert.ok(Date.now() - t < 15e3, 'prompt, not after the 30 s handshake limit');
  assert.deepEqual([tunnel.readTunnel().state, tunnel.readTunnel().reason], ['down', 'stopped']);
  await waitFor(() => !alive(tool) && !alive(rsd));
  assert.equal(w.wda, 1);
  assert.equal(tunnel.strongbox.read(), null);
  assert.equal(w.registry.started, null);
});

test('bin/lab-tunnel-host prints nothing on stdout', async () => {
  const { spawnSync } = await import('node:child_process');
  process.env.FAKE_MODE = 'wrong-udid';
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lab-tunnel-host');
  const r = spawnSync(process.execPath, [bin], { env: { ...process.env, MSL_PMD3: pmd3 }, encoding: 'utf8', timeout: 20e3 });
  assert.equal(r.stdout, '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another device/);
  assert.equal(tunnel.readTunnel().reason, 'wrong-device');
});
