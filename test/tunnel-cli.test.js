// What lab commands do with the Wi-Fi tunnel (#15): the tunnel host's LaunchAgent, starting and
// stopping it, the CoreDeviceService restart, `lab tunnel`, and the tunnel step of `lab down`.
// launchd, ps and devicectl are recorded stand-ins; nothing reaches a phone.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { sandbox, fakeRunner } from './helpers.js';
import { saveState, loadState, REPO } from '../lib/core.js';
import * as svc from '../lib/service.js';
import * as tunnel from '../lib/tunnel.js';
import * as lease from '../lib/lease.js';
import { handlers as lab } from '../lib/lab.js';
import { runHost } from '../lib/tunnel-host.js';

const PU = '00008000-000A1B2C3D4E5F60';
const PHONE = { udid: PU, teamId: 'ABCDE12345', bundleId: 'com.example.msl-wda-abcd' };
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phone');
const UID = process.getuid();
const TUNNEL_TARGET = `gui/${UID}/com.dividedby.msl-tunnel`;
const CORE_TARGET = `user/${UID}/com.apple.CoreDevice.CoreDeviceService`;
const HOST_PID = 4242;

let w, calls, killed, home;
const record = (extra = {}) => ({ v: 1, pid: HOST_PID, udid: PU, address: 'fd00:1234::1', rsdPort: 54321, registryPort: 42999, startedAt: new Date().toISOString(), state: 'up', strongboxWas: null, strongboxOurs: true, ...extra });

// The world the commands see. `w.onKick()` is what the tunnel host does when launchd starts it
// (default: comes up); `w.alive` whether its pid runs; launchctl kill TERM ends it as the host does.
function world(extra = () => undefined) {
  w = { alive: false, kicks: 0, onKick: () => { w.alive = true; tunnel.strongbox.write('42999'); tunnel.writeTunnel(record()); }, core: { kick: 0, pid: 777, command: '/System/Library/PrivateFrameworks/CoreDevice.framework/Versions/A/XPCServices/CoreDeviceService.xpc/Contents/MacOS/CoreDeviceService', gone: true }, toolOk: true };
  calls = fakeRunner((cmd, args) => {
    const other = extra(cmd, args);
    if (other) return other;
    if (args[0] === 'version' && w.versionCodes?.length) { w.versions = (w.versions ?? 0) + 1; if (w.versionCodes.shift() === 124) return { code: 124 }; }
    if (args[0] === 'version') return w.toolOk ? { stdout: '11.40.2\n' } : { code: 127, stderr: 'no such file' };
    if (cmd === 'xcode-select') return { stdout: '/Applications/Xcode.app/Contents/Developer\n' };
    if (cmd === 'launchctl' && args[0] === 'kickstart' && args[1] === '-k' && args[2] === CORE_TARGET) { w.core.kick++; return w.core.refuse ? { code: 150, stderr: 'Operation not permitted' } : undefined; }
    if (cmd === 'launchctl' && args[0] === 'kickstart' && args[1] === TUNNEL_TARGET) { w.kicks++; w.onKick(w.kicks); return undefined; }
    if (cmd === 'launchctl' && args[0] === 'kill' && args[2] === TUNNEL_TARGET) {
      if (w.alive && !w.ignoreTerm) {
        w.alive = false;
        let rec = null;
        try { rec = tunnel.readTunnel(); } catch { /* a damaged record: the host ends without it */ }
        if (rec) { tunnel.restoreStrongbox(rec); tunnel.writeTunnel({ ...rec, state: 'down', reason: 'stopped', strongboxOurs: false }); }
      }
      return undefined;
    }
    if (cmd === 'launchctl' && args[0] === 'print' && args[1] === TUNNEL_TARGET) return w.tunnelLoaded ? { stdout: w.alive ? `state = running\n\tpid = ${HOST_PID}\n` : 'state = not running\n' } : { code: 113, stderr: 'Could not find service' };
    if (cmd === 'launchctl' && args[0] === 'bootstrap' && args[2] === svc.tunnelPlistPath()) { w.tunnelLoaded = true; return undefined; }
    if (cmd === 'launchctl' && args[0] === 'bootout' && args[1] === TUNNEL_TARGET) { w.tunnelLoaded = false; return undefined; }
    if (cmd === 'launchctl' && args[0] === 'print' && args[1] === CORE_TARGET) return { stdout: `state = running\n\tpid = ${w.core.pid}\n` };
    if (cmd === 'ps' && args.includes('command=') && args.at(-1) === String(HOST_PID)) return w.alive ? { stdout: `${w.hostCmd ?? `/opt/homebrew/bin/node ${REPO}/bin/lab-tunnel-host`}\n` } : { code: 1 };
    if (cmd === 'ps' && args.includes('command=') && args.at(-1) === String(w.core.pid)) return { stdout: `${w.core.command}\n` };
    if (cmd === 'ps' && args.includes('pid=')) return w.core.gone ? { code: 1 } : { stdout: `${w.core.pid}\n` };
    if (cmd === 'xcrun' && args[0] === 'devicectl') {
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], fs.readFileSync(path.join(FIX, 'devices-cable.json'), 'utf8'));
      return undefined;
    }
    return undefined;
  });
  return w;
}
const launchctl = () => calls.filter(c => c[0] === 'launchctl').map(c => c.slice(1).join(' '));

beforeEach(() => {
  const dir = sandbox();
  home = path.join(dir, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.MSL_PMD3 = path.join(dir, 'bin', 'pymobiledevice3');
  process.env.MSL_APPIUM_HOME = path.join(dir, 'appium');
  Object.assign(tunnel.TUNNEL_WAIT, { upMs: 300, pollMs: 5, stopMs: 100, listMs: 100, listPollMs: 5, killMs: 50 });
  tunnel.coreDevice.done = false;
  killed = [];
  svc.setKill((pid, sig) => { killed.push([pid, sig]); });
  svc.setPlatform('darwin');
  saveState({ phone: PHONE });
  world();
});
afterEach(() => { svc.setPlatform(process.platform); });

const installAgent = () => { fs.mkdirSync(svc.agentsDir(), { recursive: true }); fs.writeFileSync(svc.tunnelPlistPath(), 'x'); };

// --- the agent ---

test('the tunnel plist runs bin/lab-tunnel-host with node, idle: no RunAtLoad, no KeepAlive, stderr to the log', () => {
  const xml = svc.buildTunnelPlist({ node: '/opt/homebrew/bin/node', host: '/repo/bin/lab-tunnel-host', developerDir: '/Dev', path: '/opt/homebrew/bin:/u/.local/bin:/usr/bin', log: '/L/msl-tunnel.log', env: { MSL_STATE: '/s' } });
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.dividedby\.msl-tunnel<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/repo\/bin\/lab-tunnel-host<\/string>\s*<\/array>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.doesNotMatch(xml, /StartInterval/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/L\/msl-tunnel\.log<\/string>/);
  assert.match(xml, /<key>MSL_STATE<\/key>\s*<string>\/s<\/string>/);
  assert.match(xml, /<key>DEVELOPER_DIR<\/key>\s*<string>\/Dev<\/string>/);
});

test('installTunnel writes the plist (0644) and a 0600 log, loads it idle in gui/<uid>; uninstall boots it out and removes it', async () => {
  const out = await svc.installTunnel({ node: '/opt/homebrew/bin/node' });
  assert.equal(out.installed, true);
  assert.equal(fs.statSync(svc.tunnelPlistPath()).mode & 0o777, 0o644);
  assert.equal(fs.statSync(svc.tunnelLogPath()).mode & 0o777, 0o600);
  const xml = fs.readFileSync(svc.tunnelPlistPath(), 'utf8');
  assert.match(xml, new RegExp(`<string>${path.join(REPO, 'bin', 'lab-tunnel-host')}</string>`));
  assert.match(xml, new RegExp(`<key>PATH</key>\\s*<string>/opt/homebrew/bin:${path.dirname(process.env.MSL_PMD3)}:`), 'the folder pymobiledevice3 is in');
  assert.ok(launchctl().includes(`bootstrap gui/${UID} ${svc.tunnelPlistPath()}`));
  assert.ok(!launchctl().some(l => l.startsWith('kickstart')), 'installing starts nothing');

  const un = await svc.uninstallTunnel();
  assert.equal(un.removed, true);
  assert.ok(launchctl().includes(`bootout ${TUNNEL_TARGET}`));
  assert.ok(!fs.existsSync(svc.tunnelPlistPath()));
  svc.setPlatform('linux');
  await assert.rejects(svc.installTunnel({ node: '/n' }), /needs macOS/);
});

test('service status shows the tunnel host (install and uninstall carry it along: lab.test.js)', async () => {
  const st = await lab.service(['status']);
  assert.equal(st.tunnelHost.installed, false);
  assert.match(st.tunnelHost.issues.join(' '), /lab service install/);
});

// --- starting and stopping ---

test('ensureTunnel starts the host with kickstart (no -k) and waits for its record; a live one is kept', async () => {
  installAgent();
  const r = await tunnel.ensureTunnel(PHONE);
  assert.equal(r.rec.state, 'up');
  assert.equal(r.found, 'no tunnel');
  assert.match(r.did, /started the tunnel host \(fd00:1234::1\)/);
  assert.ok(launchctl().includes(`kickstart ${TUNNEL_TARGET}`));
  assert.ok(!launchctl().some(l => l.startsWith(`kickstart -k ${TUNNEL_TARGET}`)));
  const before = w.kicks;
  const again = await tunnel.ensureTunnel(PHONE);
  assert.deepEqual([again.found, again.did, w.kicks], ['tunnel up (fd00:1234::1)', null, before]);
});

test('ensureTunnel: missing or old tool needs tunnel-tool, a missing agent needs service, both before anything starts', async () => {
  w.toolOk = false;
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel-tool' && /pymobiledevice3 tool, version 11\.40\.2 or newer/.test(e.extra.human[0]) && e.extra.then === 'lab up --target device');
  w.toolOk = true;
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'service' && /lab service install/.test(e.extra.human.join(' ')));
  assert.equal(w.kicks, 0);
});

test('ensureTunnel: the lab-side version check looks once; a timeout is no verdict and the host decides (#60)', async () => {
  installAgent();
  w.versionCodes = [124];
  const r = await tunnel.ensureTunnel(PHONE);
  assert.equal(r.rec.state, 'up');
  assert.equal(w.versions, 1, 'no retry before the host starts');
  assert.equal(w.kicks, 1);

  // A missing tool is still decided here, before anything starts.
  tunnel.clearTunnel();
  w.alive = false;
  w.kicks = 0;
  w.toolOk = false;
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel-tool');
  assert.equal(w.kicks, 0);
});

test('ensureTunnel: a host that recorded tool-slow needs tunnel with the same words; tool-missing is still tunnel-tool (#60)', async () => {
  installAgent();
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'tool-slow', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel' && !/uv tool install/.test(e.extra.human.join(' ')) && /did not answer its version check/.test(e.extra.human[0]));
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'tool-missing', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel-tool' && /uv tool install/.test(e.extra.human.join(' ')));
});

const REFUSED = "ConnectionRefusedError: [Errno 61] Connect call failed ('fd00::1', 58783, 0, 0)";

test('ensureTunnel: a host that recorded rsd-failed with a detail says what the tool said; with none, as before (#107)', async () => {
  installAgent();
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'rsd-failed', detail: REFUSED, strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel'
    && e.message === `the tunnel host stopped before the tunnel was up (rsd-failed: ${REFUSED}); see ${svc.tunnelLogPath()}`);
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'rsd-failed', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.message === `the tunnel host stopped before the tunnel was up (rsd-failed); see ${svc.tunnelLogPath()}`);
});

test('`lab tunnel status` shows the detail of a tunnel that went down; stopTunnel and the route check name it too (#107)', async () => {
  tunnel.writeTunnel(record({ state: 'down', reason: 'rsd-failed', detail: REFUSED, strongboxOurs: false }));
  const st = (await lab.tunnel(['status'])).tunnel;
  assert.deepEqual([st.state, st.reason, st.detail], ['down', 'rsd-failed', REFUSED]);
  assert.equal(JSON.stringify(st).includes(PU), false, 'no UDID');
  tunnel.writeTunnel(record({ state: 'down', reason: 'tool-exited', strongboxOurs: false }));
  assert.equal('detail' in (await lab.tunnel(['status'])).tunnel, false, 'no detail, no key');

  tunnel.writeTunnel(record({ state: 'down', reason: 'rsd-failed', detail: REFUSED, strongboxOurs: false }));
  assert.match((await tunnel.routeStatus()).why, new RegExp(`^the tunnel is down \\(rsd-failed: ConnectionRefusedError`));
  assert.equal((await tunnel.stopTunnel()).found, `tunnel record (down: rsd-failed: ${REFUSED}), host gone`);
});

test('host: a version check that times out twice records tool-slow, a missing tool tool-missing (#60)', async () => {
  const lines = [];
  const go = () => runHost({ signals: new (EventEmitter)(), log: l => lines.push(l), pid: process.pid });
  w.versionCodes = [124, 124];
  assert.deepEqual(await go(), { code: 1, reason: 'tool-slow' });
  assert.equal(w.versions, 2);
  assert.match(lines.join('\n'), /timed out twice/);
  assert.deepEqual([tunnel.readTunnel().state, tunnel.readTunnel().reason], ['down', 'tool-slow']);
  tunnel.clearTunnel();
  w.toolOk = false;
  assert.deepEqual(await go(), { code: 1, reason: 'tool-missing' });
  assert.equal(tunnel.readTunnel().reason, 'tool-missing');
});

test('ensureTunnel: no tunnel within the wait, a wrong device and an unlisted phone each have their needs; the host is stopped', async () => {
  installAgent();
  w.onKick = () => { w.alive = true; tunnel.writeTunnel(record({ state: 'starting', address: null, rsdPort: null, registryPort: null, strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel' && /no tunnel within/.test(e.message) && /45 s/.test(e.extra.human[0]));
  assert.ok(launchctl().includes(`kill TERM ${TUNNEL_TARGET}`));
  assert.equal(tunnel.readTunnel(), null);

  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'wrong-device', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel' && /another device/.test(e.message));
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'not-listed', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'cable');
  assert.equal(w.core.kick, 0, 'no CoreDeviceService restart for these');
});

test('ensureTunnel: a silent tool gets one CoreDeviceService restart and one more try, reported; a second silence needs tunnel', async () => {
  installAgent();
  w.onKick = n => { if (n === 1) tunnel.writeTunnel(record({ state: 'down', reason: 'coredevice-silent', strongboxOurs: false })); else { w.alive = true; tunnel.writeTunnel(record()); } };
  const r = await tunnel.ensureTunnel(PHONE);
  assert.equal(r.coreDeviceRestarted, true);
  assert.match(r.did, /^restarted CoreDeviceService \(Xcode and devicectl connections drop briefly\)/);
  assert.equal(w.core.kick, 1);
  assert.ok(launchctl().includes(`kickstart -k ${CORE_TARGET}`));
  assert.ok(calls.some(c => c[0] === 'xcrun' && c.includes('list')), 'waits for devicectl to list the phone');

  await tunnel.stopTunnel();
  tunnel.coreDevice.done = false;
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'coredevice-silent', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel' && /coredevice-silent/.test(e.message));
  assert.equal(w.core.kick, 2, 'one restart in this command');
});

test('restartCoreDevice: kickstart -k first; refused, the pid launchd shows is SIGTERMed once it is CoreDeviceService; never twice in a command', async () => {
  const ok = await tunnel.restartCoreDevice(PU);
  assert.deepEqual(ok, { restarted: true, how: 'kickstart', listed: true });
  assert.deepEqual(killed, []);
  assert.deepEqual(await tunnel.restartCoreDevice(PU), { restarted: false });
  assert.equal(w.core.kick, 1);

  tunnel.coreDevice.done = false;
  w.core.refuse = true;
  const fb = await tunnel.restartCoreDevice(PU);
  assert.equal(fb.how, 'kill');
  assert.deepEqual(killed, [[777, 'SIGTERM']]);

  // Still there after the wait: SIGKILL.
  tunnel.coreDevice.done = false;
  killed = [];
  w.core.gone = false;
  await tunnel.restartCoreDevice(PU);
  assert.deepEqual(killed, [[777, 'SIGTERM'], [777, 'SIGKILL']]);

  // Another program at that pid: left alone.
  tunnel.coreDevice.done = false;
  killed = [];
  w.core.command = '/usr/bin/vim CoreDeviceService.txt';
  await assert.rejects(tunnel.restartCoreDevice(PU), /pid 777 is not CoreDeviceService, so it was left alone/);
  assert.deepEqual(killed, []);
});

test('the host is recognised by its command line, not by any mention of it', () => {
  for (const [cmd, ok] of [
    [`/opt/homebrew/bin/node ${REPO}/bin/lab-tunnel-host`, true],
    [`node --no-warnings ${REPO}/bin/lab-tunnel-host`, true],
    [`${REPO}/bin/lab-tunnel-host`, true],
    ['/usr/bin/vim notes-on-lab-tunnel-host.md', false],
    ['/usr/bin/vim lab-tunnel-host', false],
    ['/usr/bin/tail -f /tmp/lab-tunnel-host.log', false],
    [`/opt/homebrew/bin/node ${REPO}/bin/lab-tunnel-host-old`, false],
  ]) assert.equal(tunnel.HOST_COMMAND.test(cmd), ok, cmd);
  // A node or repo path with a space still matches (anchored on the script path), a mere mention does not.
  const spaced = tunnel.hostCommand('/Users/A B/repos/mobile safari lab');
  for (const [cmd, ok] of [
    ['/Users/A B/.nvm/bin/node /Users/A B/repos/mobile safari lab/bin/lab-tunnel-host', true],
    ['/opt/homebrew/bin/node /Users/A B/repos/mobile safari lab/bin/lab-tunnel-host', true],
    ['/Users/A B/repos/mobile safari lab/bin/lab-tunnel-host', true],
    ['/usr/bin/vim /Users/A B/repos/mobile safari lab/bin/lab-tunnel-host.md', false],
    ['/usr/bin/vim lab-tunnel-host', false],
    ['/opt/homebrew/bin/node /Users/A B/repos/other/bin/lab-tunnel-host', false],
    ['/usr/bin/tail -f /Users/A B/repos/mobile safari lab/bin/lab-tunnel-host', false],
  ]) assert.equal(spaced.test(cmd), ok, cmd);
  w.alive = true;
  w.hostCmd = '/usr/bin/vim lab-tunnel-host';
  assert.equal(tunnel.tunnelAlive(record()), false);
  w.hostCmd = undefined;
  assert.equal(tunnel.tunnelAlive(record()), true);
});

test('a host that recorded tool-missing: the error says, word for word, the tool is missing or older than 11.40.2', async () => {
  installAgent();
  w.onKick = () => { tunnel.writeTunnel(record({ state: 'down', reason: 'tool-missing', strongboxOurs: false })); };
  await assert.rejects(tunnel.ensureTunnel(PHONE), e => e.extra.needs === 'tunnel-tool' && e.message === 'the tunnel host could not use pymobiledevice3 (missing or older than 11.40.2)');
});

test('the ps calls that check the host and restart CoreDeviceService carry their exact arguments and a 5 s timeout', async () => {
  w.alive = true;
  calls.length = 0;
  calls.opts.length = 0;
  assert.equal(tunnel.tunnelAlive(record()), true);
  assert.deepEqual(calls, [['ps', '-o', 'command=', '-p', String(HOST_PID)]]);
  assert.deepEqual(calls.opts.map(o => o.timeoutMs), [5e3]);

  w.core.refuse = true;
  calls.length = 0;
  calls.opts.length = 0;
  await tunnel.restartCoreDevice(PU);
  const ps = calls.map((c, i) => [c, calls.opts[i]]).filter(([c]) => c[0] === 'ps');
  assert.deepEqual(ps.map(([c]) => c.slice(1)), [['-o', 'command=', '-p', '777'], ['-o', 'pid=', '-p', '777']]);
  assert.deepEqual(ps.map(([, o]) => o.timeoutMs), [5e3, 5e3]);
});

test('a damaged record with a tunnel host still running: the host is stopped (SIGTERM through launchd) before the record is replaced', async () => {
  installAgent();
  w.tunnelLoaded = true;
  w.alive = true;
  fs.mkdirSync(path.dirname(tunnel.tunnelFile()), { recursive: true });
  fs.writeFileSync(tunnel.tunnelFile(), '{"v":9}');
  const kicksBefore = w.kicks;
  const r = await tunnel.ensureTunnel(PHONE);
  assert.equal(r.rec.state, 'up');
  const order = launchctl().filter(l => l === `kill TERM ${TUNNEL_TARGET}` || l === `kickstart ${TUNNEL_TARGET}`);
  assert.deepEqual(order, [`kill TERM ${TUNNEL_TARGET}`, `kickstart ${TUNNEL_TARGET}`], 'stopped first, then started');
  assert.match(r.did, /stopped a tunnel host that had no readable record/);
  assert.equal(w.kicks, kicksBefore + 1);

  // `lab tunnel down` does the same for a damaged record.
  w.alive = true;
  fs.writeFileSync(tunnel.tunnelFile(), 'not json');
  const down = await tunnel.stopTunnel();
  assert.equal(down.found, 'damaged tunnel record');
  assert.match(down.did, /stopped the tunnel host it left running/);
  assert.equal(tunnel.readTunnel(), null);

  // No host running: nothing is signalled.
  w.alive = false;
  fs.writeFileSync(tunnel.tunnelFile(), 'not json');
  const before = launchctl().filter(l => l.startsWith('kill')).length;
  assert.equal((await tunnel.stopTunnel()).did, 'removed it');
  assert.equal(launchctl().filter(l => l.startsWith('kill')).length, before);
});

test('a damaged record, and launchd does not end the host: its pid is SIGTERMed once its command is the host\'s; another program at that pid is left alone', async () => {
  installAgent();
  w.tunnelLoaded = true;
  w.alive = true;
  w.ignoreTerm = true;
  Object.assign(svc.WAIT, { pollMs: 5, portFreeMs: 100 });
  fs.writeFileSync(tunnel.tunnelFile(), 'not json');
  svc.setKill((pid, sig) => { killed.push([pid, sig]); w.alive = false; });
  const out = await tunnel.stopTunnel();
  assert.match(out.did, /stopped the tunnel host/);
  assert.deepEqual(killed, [[HOST_PID, 'SIGTERM']]);
  assert.ok(launchctl().includes(`kill TERM ${TUNNEL_TARGET}`), 'launchd was asked first');

  // The pid is some other program's now: neither launchd nor a signal is used.
  killed = [];
  w.alive = true;
  w.hostCmd = '/usr/bin/vim notes.txt';
  const before = launchctl().filter(l => l.startsWith('kill')).length;
  fs.writeFileSync(tunnel.tunnelFile(), 'not json');
  assert.equal((await tunnel.stopTunnel()).did, 'removed it');
  assert.deepEqual(killed, []);
  assert.equal(launchctl().filter(l => l.startsWith('kill')).length, before);
});

test('stopTunnel: SIGTERM through launchd, record removed; a dead host\'s key is put back; the pid itself if launchd does not end it', async () => {
  assert.deepEqual(await tunnel.stopTunnel(), { found: 'no tunnel' });
  w.alive = true;
  tunnel.strongbox.write('42999');
  tunnel.writeTunnel(record());
  const out = await tunnel.stopTunnel();
  assert.deepEqual(out, { found: `tunnel up (pid ${HOST_PID})`, did: 'stopped it' });
  assert.equal(tunnel.readTunnel(), null);
  assert.equal(tunnel.strongbox.read(), null);

  // The host died hard: its record still says up and the key is still its own.
  tunnel.strongbox.write('42999');
  tunnel.writeTunnel(record({ strongboxWas: '41000' }));
  assert.deepEqual(await tunnel.stopTunnel(), { found: 'tunnel record (up), host gone', did: 'cleared the record and put the registry key back' });
  assert.equal(tunnel.strongbox.read(), '41000');

  // launchd does not end it (not its job any more): the pid, after its command line is checked.
  w.alive = true;
  w.ignoreTerm = true;
  tunnel.writeTunnel(record());
  svc.setKill((pid, sig) => { killed.push([pid, sig]); w.alive = false; });
  Object.assign(svc.WAIT, { pollMs: 5, portFreeMs: 100 });
  await tunnel.stopTunnel();
  assert.deepEqual(killed, [[HOST_PID, 'SIGTERM']]);

  fs.writeFileSync(tunnel.tunnelFile(), '{"v":9}');
  assert.deepEqual(await tunnel.stopTunnel(), { found: 'damaged tunnel record', did: 'removed it' });
});

// --- lab tunnel, lab down, lab status ---

test('lab tunnel up/down take the lease and hand it back; status takes none; bad words are refused', async () => {
  installAgent();
  await assert.rejects(lab.tunnel([]), /usage: lab tunnel up \| down \| status/);
  await assert.rejects(lab.tunnel(['up', 'now']), /usage: lab tunnel/);
  const up = await lab.tunnel(['up']);
  assert.equal(up.tunnel.state, 'up');
  assert.equal(up.tunnel.alive, true);
  assert.equal(lease.read(), null, 'the lease the command took is handed back');
  const st = await lab.tunnel(['status']);
  assert.deepEqual([st.tunnel.state, st.tunnel.agent.installed, st.tunnel.registry.present], ['up', true, false]);
  assert.equal(JSON.stringify(st).includes(PU), false, 'no UDID in the status');
  const down = await lab.tunnel(['down']);
  assert.equal(down.did, 'stopped it');
  assert.equal(lease.read(), null);

  await lease.acquire({ owner: 'agent-a' });
  await assert.rejects(lab.tunnel(['down']), /leased by "agent-a"/);
  await lease.release({ force: true });
  saveState({ phone: null });
  await assert.rejects(lab.tunnel(['up']), e => e.extra.needs === 'setup');
});

test('lab down stops the tunnel right after the WebDriverAgent step, also with --keep-service', async () => {
  for (const flags of [[], ['--keep-service']]) {
    w.alive = true;
    tunnel.writeTunnel(record());
    const out = await lab.down(flags);
    const names = out.steps.map(s => s.step);
    assert.equal(names[names.indexOf('wda') + 1], 'tunnel', flags.join(' '));
    assert.deepEqual(out.steps.find(s => s.step === 'tunnel').did, 'stopped it');
    assert.equal(tunnel.readTunnel(), null);
  }
});

test('the idle stop counts a live tunnel as running and stops it; lab hold accepts it; lab status shows it', async () => {
  w.alive = true;
  tunnel.writeTunnel(record());
  const held = await lab.hold([]);
  assert.ok(held.running.includes('the tunnel is up'));
  await lease.clearHold();
  const st = await lab.status();
  assert.deepEqual([st.tunnel.state, st.tunnel.alive, st.tunnel.address], ['up', true, 'fd00:1234::1']);
  assert.ok(!calls.some(c => c[0] === 'xcrun'), 'status asks nothing of the phone');
  // Idle: past the threshold with no lease.
  fs.writeFileSync(path.join(process.env.MSL_STATE, 'activity.json'), JSON.stringify({ at: new Date(Date.now() - 3600e3).toISOString() }));
  const idle = await lab.down(['--idle']);
  assert.equal(idle.idle, true);
  assert.ok(idle.running.includes('the tunnel is up'));
  assert.equal(idle.steps.find(s => s.step === 'tunnel').did, 'stopped it');
  assert.equal(loadState().idleStop.failures, 0);
});

test('`lab tunnel status` prints one JSON object', () => {
  const bin = path.join(REPO, 'bin', 'lab');
  fs.mkdirSync(path.dirname(process.env.MSL_PMD3), { recursive: true });
  fs.writeFileSync(process.env.MSL_PMD3, '#!/bin/sh\necho 11.40.2\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [bin, 'tunnel', 'status'], { env: process.env, encoding: 'utf8', timeout: 20e3 });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.tunnel.state, 'none');
  assert.equal(out.tool.version, '11.40.2');
  assert.equal(r.status, 0);
});

// --- CoreDevice stuck, and a failed command over Wi-Fi ---

const stuck = { udid: PU, found: true, reachable: false, tunnelState: 'connecting', error: 'devicectl lockState timed out after 20s', needs: 'cable' };

test('checkPhone: a stuck CoreDevice (lockState timed out, tunnel connecting) gets one restart and one more look, reported', async () => {
  const looks = [stuck, { ...stuck, reachable: true, tunnelState: 'connected', error: undefined, needs: undefined, transport: 'wifi' }];
  const r = await tunnel.checkPhone(PU, () => looks.shift());
  assert.equal(r.reachable, true);
  assert.equal(r.coreDeviceRestarted, true);
  assert.equal(w.core.kick, 1);

  // Once per command: a second stuck look has no second restart, and is `needs: tunnel`.
  const again = await tunnel.checkPhone(PU, () => stuck);
  assert.equal(again.reachable, false);
  assert.equal(again.coreDeviceRestarted, undefined);
  assert.equal(again.needs, 'tunnel');
  assert.equal(w.core.kick, 1);
});

test('checkPhone: still stuck after the restart needs tunnel; other failures and a healthy phone cause no restart', async () => {
  const r = await tunnel.checkPhone(PU, () => stuck);
  assert.deepEqual([r.coreDeviceRestarted, r.needs], [true, 'tunnel']);
  tunnel.coreDevice.done = false;
  w.core.kick = 0;
  for (const s of [{ ...stuck, tunnelState: 'disconnected' }, { ...stuck, error: 'devicectl failed' }, { ...stuck, reachable: true }]) {
    assert.equal(await tunnel.checkPhone(PU, () => s), s);
  }
  assert.equal(w.core.kick, 0);
});

test('checkPhone: a restart that cannot be done (another program at the pid) is said in the error, nothing is killed', async () => {
  w.core.refuse = true;
  w.core.command = '/usr/bin/vim CoreDeviceService.txt';
  const r = await tunnel.checkPhone(PU, () => stuck);
  assert.match(r.error, /is not CoreDeviceService, so it was left alone/);
  assert.deepEqual(killed, []);
});

test('a device command that failed over Wi-Fi is `needs: tunnel` when the tunnel is not up or does not answer; over the cable it is left alone', async () => {
  const { failureArtifacts } = await import('../lib/safari.js');
  saveState({ session: 'S1', backend: 'appium', port: 4723, target: { device: PU }, transport: { via: 'tunnel', address: 'fd00:1234::1' } });
  const failed = await failureArtifacts('eval', new Error('boom'));
  assert.equal(failed.needs, 'tunnel');
  assert.match(failed.tunnel, /no tunnel is recorded/);
  assert.equal(failed.then, 'lab up --target device');

  w.alive = true;
  tunnel.writeTunnel(record());
  const real = tunnel.hooks.probe;
  try {
    tunnel.hooks.probe = async () => false;
    assert.match((await failureArtifacts('eval', new Error('boom'))).tunnel, /does not answer through the tunnel/);
    tunnel.hooks.probe = async () => true;
    assert.deepEqual(await failureArtifacts('eval', new Error('boom')), {}, 'the tunnel is fine: the error stands as it is');
    // The command's own need stands while the tunnel is healthy, and gives way to `tunnel` when it is not. (A refusal of the
    // tab guard is not here: it skips the artifacts, so the guard checks the route itself; test/appium.test.js.)
    const unlock = Object.assign(new Error('x'), { extra: { needs: 'unlock' } });
    assert.deepEqual(await failureArtifacts('eval', unlock), {}, 'healthy tunnel: the command\'s own need');
    tunnel.hooks.probe = async () => false;
    for (const needs of ['unlock', 'passcode', 'cable']) {
      const out = await failureArtifacts('eval', Object.assign(new Error('x'), { extra: { needs } }));
      assert.equal(out.needs, 'tunnel', needs);
    }
    w.alive = false; // and the host gone
    assert.match((await failureArtifacts('eval', unlock)).tunnel, /host is gone/);
    w.alive = true;
    saveState({ transport: { via: 'usbmux' } });
    assert.deepEqual(await failureArtifacts('eval', new Error('boom')), {});
  } finally { tunnel.hooks.probe = real; }
});

// --- is the route to the phone working (#59): routeStatus and `lab tunnel status` ---

// WebDriverAgent's /status as a local server (`up`: whether it answers), the tunnel probe answering `reach`.
async function route({ reach = true, up = true, hang = false } = {}, body) {
  const hits = { probe: 0, wda: 0 };
  const server = http.createServer((req, res) => { hits.wda++; if (!hang) { res.statusCode = up ? 200 : 503; res.end('{}'); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const real = { probe: tunnel.hooks.probe, url: tunnel.WDA.url, probeMs: tunnel.WDA_WAIT.probeMs };
  tunnel.hooks.probe = async () => { hits.probe++; return reach; };
  tunnel.WDA.url = () => `http://127.0.0.1:${server.address().port}`;
  tunnel.WDA_WAIT.probeMs = 150;
  try { return await body(hits); } finally {
    tunnel.WDA_WAIT.probeMs = real.probeMs;
    tunnel.hooks.probe = real.probe;
    tunnel.WDA.url = real.url;
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
}

test('routeStatus: no tunnel, a gone host or a silent phone stop at the tunnel; then one bounded WebDriverAgent request', async () => {
  await route({}, async hits => {
    assert.deepEqual(await tunnel.routeStatus(), { ok: false, stage: 'tunnel', why: 'no tunnel is recorded' });
    tunnel.writeTunnel(record());
    assert.deepEqual(await tunnel.routeStatus(), { ok: false, stage: 'tunnel', why: 'the tunnel host is gone' });
    w.alive = true;
    assert.deepEqual(await tunnel.routeStatus(), { ok: true });
    assert.deepEqual([hits.probe, hits.wda], [1, 1]);
    assert.deepEqual(await tunnel.routeStatus({ wda: false }), { ok: true });
    assert.deepEqual([hits.probe, hits.wda], [2, 1], 'wda: false asks the tunnel only');
  });
  await route({ reach: false }, async hits => {
    w.alive = true;
    tunnel.writeTunnel(record());
    assert.deepEqual(await tunnel.routeStatus(), { ok: false, stage: 'tunnel', why: 'the phone does not answer through the tunnel' });
    assert.equal(hits.wda, 0);
  });
  await route({ up: false }, async () => {
    w.alive = true;
    tunnel.writeTunnel(record());
    assert.deepEqual(await tunnel.routeStatus(), { ok: false, stage: 'wda', why: 'the tunnel reaches the phone but WebDriverAgent does not answer' });
  });
  await route({ hang: true }, async () => {
    w.alive = true;
    tunnel.writeTunnel(record());
    const t0 = Date.now();
    assert.equal((await tunnel.routeStatus()).stage, 'wda');
    assert.ok(Date.now() - t0 < 3000, 'bounded by probeMs');
  });
});

test('lab tunnel status says whether the route works; null when the tunnel is not up with a live host, and lab status stays record-only', async () => {
  await route({}, async hits => {
    let st = await lab.tunnel(['status']);
    assert.equal(st.tunnel.reaches, null, 'no tunnel: nothing probed');
    w.alive = true;
    tunnel.writeTunnel(record({ state: 'starting', address: null, rsdPort: null, registryPort: null, strongboxOurs: false }));
    assert.equal((await lab.tunnel(['status'])).tunnel.reaches, null, 'still starting');
    tunnel.writeTunnel(record());
    w.alive = false;
    assert.equal((await lab.tunnel(['status'])).tunnel.reaches, null, 'host gone');
    assert.equal(hits.probe, 0);

    w.alive = true;
    st = await lab.tunnel(['status']);
    assert.equal(st.tunnel.reaches, true);
    assert.equal(st.tunnel.reachesWhy, undefined);
    assert.deepEqual([hits.probe, hits.wda], [1, 0], 'no session over the tunnel: WebDriverAgent is not asked');

    saveState({ session: 'S1', backend: 'appium', port: 4723, target: { device: PU }, transport: { via: 'tunnel', address: 'fd00:1234::1' } });
    assert.equal((await lab.tunnel(['status'])).tunnel.reaches, true);
    assert.deepEqual([hits.probe, hits.wda], [2, 1], 'a session over the tunnel: WebDriverAgent too');

    const before = [hits.probe, hits.wda];
    const status = await lab.status();
    assert.equal(status.tunnel.reaches, undefined);
    assert.deepEqual([hits.probe, hits.wda], before, 'lab status makes no device calls');
    assert.equal(JSON.stringify(await lab.tunnel(['status'])).includes(PU), false, 'no UDID');
  });
  await route({ reach: false }, async () => {
    w.alive = true;
    tunnel.writeTunnel(record());
    const st = await lab.tunnel(['status']);
    assert.deepEqual([st.tunnel.reaches, st.tunnel.reachesWhy], [false, 'the phone does not answer through the tunnel']);
  });
  await route({ up: false }, async () => {
    w.alive = true;
    saveState({ transport: { via: 'tunnel', address: 'fd00:1234::1' } });
    tunnel.writeTunnel(record());
    const st = await lab.tunnel(['status']);
    assert.deepEqual([st.tunnel.reaches, st.tunnel.reachesWhy], [false, 'the tunnel reaches the phone but WebDriverAgent does not answer']);
  });
});

// --- is the tunnel a recorded session ran on gone (#62): sessionRouteGone ---

test('sessionRouteGone: a cable session never; a Wi-Fi one when its tunnel is gone, replaced or silent', async () => {
  const real = tunnel.hooks.probe;
  let probes = 0, reach = true;
  tunnel.hooks.probe = async () => { probes++; return reach; };
  try {
    const was = { via: 'tunnel', address: 'fd00:1234::1', startedAt: '2026-10-23T18:00:00.000Z' };
    for (const t of [undefined, null, {}, { via: 'usbmux' }, { via: 'usbmux', address: 'fd00:1234::1' }]) assert.deepEqual(await tunnel.sessionRouteGone(t), { gone: false }, JSON.stringify(t));
    assert.equal(probes, 0);

    assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: true, why: 'no tunnel is recorded' });
    fs.mkdirSync(path.dirname(tunnel.tunnelFile()), { recursive: true });
    fs.writeFileSync(tunnel.tunnelFile(), '{"v":9}');
    assert.match((await tunnel.sessionRouteGone(was)).why, /damaged/);
    tunnel.writeTunnel(record({ startedAt: was.startedAt, state: 'down', reason: 'tool-exited', strongboxOurs: false }));
    assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: true, why: 'the tunnel is down (tool-exited)' });
    tunnel.writeTunnel(record({ startedAt: was.startedAt }));
    assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: true, why: 'the tunnel host is gone' });
    assert.equal(probes, 0, 'nothing is connected to while the record or the host says gone');

    w.alive = true;
    assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: false });
    assert.equal(probes, 1, 'the same tunnel: one connect');
    reach = false;
    assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: true, why: 'the phone does not answer through the tunnel' });

    // Another tunnel (the host was started again): its start time differs; nothing is connected to.
    reach = true;
    probes = 0;
    tunnel.writeTunnel(record({ startedAt: '2026-10-23T19:00:00.000Z' }));
    assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: true, why: 'its tunnel was replaced' });
    assert.equal(probes, 0);

    // A session recorded before startedAt was kept: the address decides, then the connect.
    const old = { via: 'tunnel', address: 'fd00:1234::1' };
    assert.deepEqual(await tunnel.sessionRouteGone(old), { gone: false });
    assert.equal(probes, 1);
    assert.deepEqual(await tunnel.sessionRouteGone({ via: 'tunnel', address: 'fd00:9999::1' }), { gone: true, why: 'its tunnel was replaced' });
    // Nothing recorded of which tunnel: only whether this one answers.
    assert.deepEqual(await tunnel.sessionRouteGone({ via: 'tunnel' }), { gone: false });

    // With `wda` (lab up) the same tunnel must also have WebDriverAgent answering; a cable session is never asked.
    await route({ up: false }, async hits => {
      assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: true, why: 'its tunnel was replaced' }, 'a replaced tunnel is gone before WebDriverAgent is asked');
      assert.equal(hits.wda, 0);
      tunnel.writeTunnel(record({ startedAt: was.startedAt }));
      assert.deepEqual(await tunnel.sessionRouteGone(was), { gone: false }, 'without wda: not asked');
      assert.equal(hits.wda, 0);
      assert.deepEqual(await tunnel.sessionRouteGone(was, { wda: true }), { gone: true, why: 'WebDriverAgent does not answer through the tunnel' });
      assert.equal(hits.wda, 1);
      assert.deepEqual(await tunnel.sessionRouteGone({ via: 'usbmux' }, { wda: true }), { gone: false });
      assert.equal(hits.wda, 1);
    });
    await route({}, async hits => {
      assert.deepEqual(await tunnel.sessionRouteGone(was, { wda: true }), { gone: false });
      assert.equal(hits.wda, 1);
    });
  } finally { tunnel.hooks.probe = real; }
});

// --- golden plist and launchctl sequences (the LaunchAgent helper must change none of it) ---

test('golden: buildTunnelPlist output, byte for byte (with XML escaping)', () => {
  const xml = svc.buildTunnelPlist({ node: '/opt/homebrew/bin/node', host: '/repo/bin/lab-tunnel-host', developerDir: '/Dev', path: '/opt/homebrew/bin:/usr/bin', log: '/L/a&b/<c>.log', env: { MSL_STATE: '/S&1' } });
  assert.equal(xml, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dividedby.msl-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/repo/bin/lab-tunnel-host</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEVELOPER_DIR</key>
    <string>/Dev</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin</string>
    <key>MSL_STATE</key>
    <string>/S&amp;1</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/L/a&amp;b/&lt;c&gt;.log</string>
</dict>
</plist>
`);
});

test('golden: installTunnel and uninstallTunnel run exactly these commands, in this order', async () => {
  const DEV = ['xcode-select', '-p'];
  const print = ['launchctl', 'print', TUNNEL_TARGET];
  const bootout = ['launchctl', 'bootout', TUNNEL_TARGET];
  const enable = ['launchctl', 'enable', TUNNEL_TARGET];
  const bootstrap = ['launchctl', 'bootstrap', `gui/${UID}`, svc.tunnelPlistPath()];

  calls.length = 0;
  await svc.installTunnel({ node: '/n' });
  assert.deepEqual(calls, [DEV, print, enable, bootstrap]);
  calls.length = 0;
  assert.deepEqual(await svc.uninstallTunnel(), { removed: true, wasLoaded: true });
  assert.deepEqual(calls, [print, bootout, print]);
  calls.length = 0;
  assert.deepEqual(await svc.uninstallTunnel(), { removed: false, wasLoaded: false });
  assert.deepEqual(calls, [bootout], 'not installed: launchd is not asked');

  await svc.installTunnel({ node: '/n' });
  calls.length = 0;
  await svc.installTunnel({ node: '/n' });
  assert.deepEqual(calls, [DEV, print, bootout, print, enable, bootstrap], 'a loaded one is booted out first');
  w.tunnelLoaded = false;
  calls.length = 0;
  assert.equal(svc.bootstrapTunnelIfNeeded(), true);
  assert.deepEqual(calls, [print, enable, bootstrap]);
  assert.equal(svc.bootstrapTunnelIfNeeded(), false);

  const was = svc.WAIT.portFreeMs;
  svc.WAIT.portFreeMs = 50;
  try {
    world((cmd, args) => (cmd === 'launchctl' && args[0] === 'bootout' ? {} : undefined)); // launchd keeps the old one
    w.tunnelLoaded = true;
    await assert.rejects(svc.installTunnel({ node: '/n' }), /^Error: launchd did not unload the old tunnel host within 10s$/);
  } finally { svc.WAIT.portFreeMs = was; }
});
