// The Wi-Fi tunnel to the phone (issue 15): its record (tunnel.json in the state dir), the registry
// port key xcuitest reads, and the checks a lab command makes of the tunnel host
// (bin/lab-tunnel-host, run by the LaunchAgent com.dividedby.msl-tunnel). The host is the only
// writer of the record while it runs; `lab tunnel down` and `lab down` remove it afterwards.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { run, runAsync, isUdid, stateDir, sleep, spawnDetached, processCommand, processAlive, REPO } from './core.js';
import { appiumHome, WDA, registryModule } from './appium.js';
import { needsError, deviceListed, phoneStatus, classify, wdaDerivedData } from './phone.js';
import { checkPmd3, PMD3_FLOOR, PMD3_VERSION_MS } from './pmd3.js';
import { stopDeviceWda } from './wda.js';
import { InterruptError, interrupted, requestSignal } from './interrupt.js';
import * as svc from './service.js';

export const tunnelFile = () => path.join(stateDir(), 'tunnel.json');

export { registryModule };

const STATES = ['starting', 'up', 'down'];
const KEYS = new Set(['v', 'pid', 'udid', 'address', 'rsdPort', 'registryPort', 'startedAt', 'state', 'reason', 'detail', 'strongboxWas', 'strongboxOurs', 'osVersion']);
export const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;
const validPid = p => Number.isInteger(p) && p > 1;
// The tunnel's address of the phone: an IPv6 unique local address (fd00::/8), as the tool prints it.
export const isTunnelAddress = a => typeof a === 'string' && a.length <= 39 && /^fd[0-9a-f:]+$/.test(a);

// Whether `rec` is a tunnel record: exactly the known keys, each of its type. The address and
// ports are null until the host knows them; an `up` record has all three. `osVersion` (the phone's
// iOS version, from the handshake) is optional, as is `detail` (what the tool said, for a `reason`).
export function checkTunnel(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (Object.keys(rec).some(k => !KEYS.has(k))) return false;
  const nullOr = (v, test) => v === null || test(v);
  return rec.v === 1 && validPid(rec.pid) && isUdid(rec.udid) && STATES.includes(rec.state)
    && nullOr(rec.address, isTunnelAddress) && nullOr(rec.rsdPort, isPort) && nullOr(rec.registryPort, isPort)
    && (rec.state !== 'up' || (rec.address !== null && rec.rsdPort !== null && rec.registryPort !== null))
    && typeof rec.startedAt === 'string' && !Number.isNaN(Date.parse(rec.startedAt))
    && (rec.reason === undefined || (typeof rec.reason === 'string' && rec.reason.length <= 200))
    && (rec.detail === undefined || (typeof rec.detail === 'string' && rec.detail.length <= 200))
    && nullOr(rec.strongboxWas, v => typeof v === 'string' && v.length <= 32)
    && (rec.osVersion === undefined || (typeof rec.osVersion === 'string' && /^\d+(\.\d+){1,2}$/.test(rec.osVersion) && rec.osVersion.length <= 16))
    && typeof rec.strongboxOurs === 'boolean';
}

export const DAMAGED_TUNNEL = 'the tunnel record (tunnel.json) is damaged: run `lab tunnel down`';

// The record, or null when there is none; throws DAMAGED_TUNNEL for one of the wrong shape.
export function readTunnel() {
  let raw;
  try { raw = fs.readFileSync(tunnelFile(), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let rec;
  try { rec = JSON.parse(raw); } catch { throw new Error(DAMAGED_TUNNEL); }
  if (!checkTunnel(rec)) throw new Error(DAMAGED_TUNNEL);
  return rec;
}

// Written whole to a temp file (owner-only) and renamed, so a reader never sees half of it.
export function writeTunnel(rec) {
  if (!checkTunnel(rec)) throw new Error('writeTunnel: not a tunnel record');
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${tunnelFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, tunnelFile());
  return rec;
}

export const clearTunnel = () => fs.rmSync(tunnelFile(), { force: true });

// What the tunnel host's command line (`ps -o command=`) has to look like: node running
// bin/lab-tunnel-host, or the script itself, by name, not any line that mentions it. Pids get reused.
// Anchored on this checkout's script path (the plist runs REPO/bin/lab-tunnel-host), escaped, so a
// node or repo path with a space still matches and a line that only mentions the name does not.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hostCommand = (repo = REPO) => {
  const script = escapeRe(`${repo}/bin/lab-tunnel-host`);
  return new RegExp(`^${script}(?:\\s|$)|^(?:.*/)?node(?:\\s+-\\S+)*\\s+${script}(?:\\s|$)`);
};
export const HOST_COMMAND = hostCommand();

// Whether the record's pid still runs the tunnel host.
export function tunnelAlive(rec) {
  if (!rec || !validPid(rec.pid)) return false;
  return HOST_COMMAND.test(processCommand(rec.pid, { timeoutMs: 5e3 }));
}

// --- the registry port key ---

// xcuitest finds the tunnel through a registry whose port it reads from @appium/strongbox's item
// `tunnelRegistryPort` in the container `appium-xcuitest-driver` (remotexpc tunnel-availability.js):
// env-paths' data folder on macOS. remotexpc's registry writes it when it starts; the host reads
// it first and puts the old value back (or removes it) afterwards, only while the value is its own.
export const strongboxFile = () => path.join(os.homedir(), 'Library', 'Application Support', 'appium-xcuitest-driver-nodejs', 'strongbox', 'tunnelRegistryPort');

export const strongbox = {
  read() {
    try { return fs.readFileSync(strongboxFile(), 'utf8').trim() || null; } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },
  write(value) {
    // The folder is Appium's (xcuitest's strongbox), shared with other tools: made 0700 when the lab has to make it, its mode left alone when it exists.
    fs.mkdirSync(path.dirname(strongboxFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(strongboxFile(), String(value), { mode: 0o600 });
    strongbox.secure(); // also when the key already existed with another mode
  },
  // Owner-only, for a key someone else (the registry library) wrote with its own mode.
  secure() { try { fs.chmodSync(strongboxFile(), 0o600); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  clear() { fs.rmSync(strongboxFile(), { force: true }); },
};

// Puts the key back as the record found it, if it still holds the record's registry port.
// Returns whether it did.
export function restoreStrongbox(rec) {
  if (!rec?.strongboxOurs || !isPort(rec.registryPort) || strongbox.read() !== String(rec.registryPort)) return false;
  if (rec.strongboxWas === null) strongbox.clear();
  else strongbox.write(rec.strongboxWas);
  return true;
}

// --- reaching the phone through the tunnel ---

// One TCP connect, bounded: true when it is accepted. Swappable (tests have no tunnel).
function tcpProbe(host, port, ms = 3e3) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), ms);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
export const hooks = { probe: tcpProbe };

// --- what lab commands do with the tunnel ---

// Waits, in ms (tests shorten them): the tunnel coming up after the host is started, each poll,
// the host leaving after SIGTERM, the phone listed again after a CoreDeviceService restart (and
// that poll), and CoreDeviceService leaving after SIGTERM in the fallback.
export const TUNNEL_WAIT = { upMs: 45e3, pollMs: 1e3, stopMs: 25e3, listMs: 20e3, listPollMs: 2e3, killMs: 5e3 };

// CoreDeviceService is restarted at most once per lab command (each command is its own process;
// tests reset `done`).
export const coreDevice = { done: false };
export const COREDEVICE_LABEL = 'com.apple.CoreDevice.CoreDeviceService';
const COREDEVICE_EXE = /CoreDeviceService\.xpc\/Contents\/MacOS\/CoreDeviceService$/;
export const RESTARTED = 'restarted CoreDeviceService (Xcode and devicectl connections drop briefly)';

// Polls `test` every `every` ms (with `sleep`, so an interrupt ends it) for up to `ms`.
async function waitFor(test, ms, every = TUNNEL_WAIT.pollMs, onWait) {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= end) return false;
    await onWait?.();
    await sleep(every);
  }
}

const pidGone = pid => !processAlive(pid);

// Restarts the user's CoreDeviceService when it is stuck: `launchctl kickstart -k`, else SIGTERM
// (then SIGKILL after TUNNEL_WAIT.killMs) to the pid launchd shows, once its command line is
// CoreDeviceService's own; launchd starts it again on demand. Then waits for devicectl to list
// the phone. Only lab commands under the lease call this, once each; never the host or the idle stop.
// Returns { restarted, how, listed }, or { restarted: false } when it already ran in this command.
export async function restartCoreDevice(udid) {
  if (coreDevice.done) return { restarted: false };
  coreDevice.done = true;
  const target = `user/${process.getuid()}/${COREDEVICE_LABEL}`;
  const k = run('launchctl', ['kickstart', '-k', target], { allowFail: true, timeoutMs: 15e3 });
  let how = 'kickstart';
  if (k.code !== 0) {
    how = 'kill';
    const { pid } = svc.launchdState(target);
    if (!validPid(pid)) throw new Error(`couldn't restart CoreDeviceService: \`launchctl kickstart -k\` failed (exit ${k.code}) and launchd shows no pid for it`);
    const cmd = processCommand(pid, { timeoutMs: 5e3 });
    if (!COREDEVICE_EXE.test(cmd)) throw new Error(`couldn't restart CoreDeviceService: pid ${pid} is not CoreDeviceService, so it was left alone`);
    try { svc.signalPid(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (!await waitFor(() => pidGone(pid), TUNNEL_WAIT.killMs, 250)) {
      try { svc.signalPid(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
  const listed = await waitFor(() => deviceListed(udid), TUNNEL_WAIT.listMs, TUNNEL_WAIT.listPollMs);
  return { restarted: true, how, listed };
}

// CoreDevice is stuck when lockState times out while the device list says its tunnel is still
// connecting.
export const isWedged = s => !s.reachable && s.tunnelState === 'connecting' && /lockState timed out/.test(s.error ?? '');

// `phoneStatus`, with one CoreDeviceService restart and one more look when CoreDevice is stuck
// (lab commands under the lease only). Still stuck afterwards is `needs: tunnel`. The status
// carries `coreDeviceRestarted` when it restarted.
export async function checkPhone(udid, status = phoneStatus) {
  const s = status(udid);
  if (!isWedged(s)) return s;
  if (coreDevice.done) return { ...s, needs: 'tunnel' }; // already restarted in this command (by ensureTunnel, say): a second failure
  let r;
  try { r = await restartCoreDevice(udid); } catch (e) {
    if (e instanceof InterruptError) throw e;
    return { ...s, error: `${s.error}; ${e.message}` };
  }
  const again = status(udid);
  return { ...again, coreDeviceRestarted: r.restarted, ...(isWedged(again) ? { needs: 'tunnel' } : {}) };
}

// The error for a missing tunnel agent: `lab service install` writes it.
function agentMissing() {
  const e = needsError('service', 'the tunnel host\'s LaunchAgent is not installed');
  e.extra.human = ['Wi-Fi runs through a tunnel that a LaunchAgent of the lab\'s holds, and it is not installed.', 'Run `lab service install` (it installs the tunnel host with the Appium service), then the command below.'];
  e.extra.then = 'lab up --target device';
  return e;
}

// The error for a pymobiledevice3 `version` check that timed out twice (issue 60): the tool is probably fine, so no install steps.
function toolSlow() {
  const e = needsError('tunnel', `pymobiledevice3 did not answer its version check within ${PMD3_VERSION_MS / 1000} s, twice`);
  e.extra.human = ['The pymobiledevice3 tool did not answer its version check in time (twice). It is probably installed and fine, only slow to start.', 'Run the command below again.'];
  return e;
}

// A record's reason, with what the tool said when the host kept that: `rsd-failed: ConnectionRefusedError: ...`.
const reasonOf = (reason, detail) => (detail ? `${reason}: ${detail}` : reason);

// The error for a host that recorded `down`, by its reason (and `detail`).
function hostFailure(reason, detail) {
  if (reason === 'tool-slow') return toolSlow();
  if (reason === 'tool-missing') return needsError('tunnel-tool', `the tunnel host could not use pymobiledevice3 (missing or older than ${PMD3_FLOOR})`);
  if (reason === 'not-listed') return needsError('cable', 'the Mac does not see the phone on the network (remotepairingd lists no device)');
  if (reason === 'wrong-device') return needsError('tunnel', 'the tunnel reached another device than the saved phone, so it was closed');
  return needsError('tunnel', `the tunnel host stopped before the tunnel was up (${reason ? reasonOf(reason, detail) : 'no reason recorded'}); see ${svc.tunnelLogPath()}`);
}

// Starts the tunnel host and waits for its record to say up for this phone, or down.
async function startHost(phone, touch) {
  svc.bootstrapTunnelIfNeeded();
  const r = run('launchctl', ['kickstart', svc.tunnelTarget()], { allowFail: true, timeoutMs: 15e3 });
  if (r.code !== 0) throw needsError('tunnel', `launchctl kickstart of the tunnel host failed (exit ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
  let rec = null;
  await waitFor(() => {
    try { rec = readTunnel(); } catch { rec = null; }
    return rec !== null && (rec.state === 'down' || (rec.state === 'up' && rec.udid === phone.udid));
  }, TUNNEL_WAIT.upMs, TUNNEL_WAIT.pollMs, touch);
  return rec;
}

// Makes sure the tunnel to the saved phone is up: a live record for it is kept; otherwise the
// tunnel host is started and waited for (up to TUNNEL_WAIT.upMs). A host that found CoreDevice
// silent gets one CoreDeviceService restart and one more try. `touch` renews the lease while it
// waits. Returns { rec, found, did, coreDeviceRestarted? } or throws a `needs` error.
export async function ensureTunnel(phone, { touch } = {}) {
  let rec = null, damaged = false;
  try { rec = readTunnel(); } catch { damaged = true; /* replaced below, after any host still running is stopped */ }
  if (rec?.state === 'up' && rec.udid === phone.udid && tunnelAlive(rec)) return { rec, found: `tunnel up (${rec.address})`, did: null };
  // One look only: a single timeout is no verdict, so it goes on and the host's check (which retries) decides.
  // That keeps both checks inside the wait: this one before it (10 s), the host's within it (20 s of 45 s).
  const tool = checkPmd3({ retry: false });
  if (!tool.ok && !tool.slow) throw needsError('tunnel-tool', tool.error);
  if (!svc.tunnelInstalled()) throw agentMissing();
  const notes = [];
  if (rec && tunnelAlive(rec)) { await stopTunnel(); notes.push('stopped the old tunnel'); } else {
    if (damaged && await stopAgentHost()) notes.push('stopped a tunnel host that had no readable record');
    if (rec) restoreStrongbox(rec);
    clearTunnel();
  }

  let restarted = false;
  for (let attempt = 0; ; attempt++) {
    const got = await startHost(phone, touch);
    if (got?.state === 'up' && got.udid === phone.udid) {
      notes.push(`started the tunnel host (${got.address})`);
      if (restarted) notes.unshift(RESTARTED);
      return { rec: got, found: rec ? `tunnel ${rec.state}` : 'no tunnel', did: notes.join('; '), ...(restarted ? { coreDeviceRestarted: true } : {}) };
    }
    if (got?.state === 'down' && got.reason === 'coredevice-silent' && attempt === 0 && !coreDevice.done) {
      clearTunnel();
      restarted = (await restartCoreDevice(phone.udid)).restarted;
      continue;
    }
    await stopTunnel();
    if (got?.state === 'down') throw hostFailure(got.reason, got.detail);
    throw needsError('tunnel', `no tunnel within ${Math.round(TUNNEL_WAIT.upMs / 1000)}s (see ${svc.tunnelLogPath()})`);
  }
}

// A host that runs with no readable record (the record is damaged): the pid launchd shows for the
// agent, once its command line is the host's, gets SIGTERM through launchd, and is waited for.
// Returns whether one was running.
async function stopAgentHost() {
  const { pid } = svc.launchdState(svc.tunnelTarget());
  const host = { pid };
  if (!validPid(pid) || !tunnelAlive(host)) return false;
  await endHost(host);
  return true;
}

// SIGTERM to the host through launchd, waited for; the pid itself (after its command line is checked
// again) if launchd doesn't end it. Throws when it is still there afterwards.
async function endHost(host) {
  run('launchctl', ['kill', 'TERM', svc.tunnelTarget()], { allowFail: true, timeoutMs: 10e3 });
  if (await waitFor(() => !tunnelAlive(host), TUNNEL_WAIT.stopMs, 250)) return;
  const r = await svc.stopProcess(host.pid, { test: c => HOST_COMMAND.test(c.trim()) });
  if (r.state === 'stuck') throw new Error(`the tunnel host (pid ${host.pid}) didn't exit within ${Math.round(svc.WAIT.portFreeMs / 1000)}s after SIGTERM`);
}

// Stops the tunnel host (SIGTERM through launchd; the pid itself, after checking its command line,
// if launchd doesn't end it) and removes the record. A host that died without cleaning up leaves
// its registry key: that is put back here. Returns { found, did } in the shape of a `lab down` step.
export async function stopTunnel() {
  let rec;
  try { rec = readTunnel(); } catch {
    const stopped = await stopAgentHost();
    clearTunnel();
    return { found: 'damaged tunnel record', did: stopped ? 'stopped the tunnel host it left running and removed it' : 'removed it' };
  }
  if (!rec) return { found: 'no tunnel' };
  const alive = tunnelAlive(rec);
  if (alive) await endHost(rec);
  let after = null;
  try { after = readTunnel(); } catch { /* replaced by a damaged one: the old record decides */ }
  const restored = restoreStrongbox(after ?? rec);
  clearTunnel();
  const found = alive ? `tunnel ${rec.state} (pid ${rec.pid})` : `tunnel record (${rec.state}${rec.reason ? `: ${reasonOf(rec.reason, rec.detail)}` : ''}), host gone`;
  return { found, did: alive ? `stopped it${restored ? ' and put the registry key back' : ''}` : restored ? 'cleared the record and put the registry key back' : 'cleared the record' };
}

// Whether a live tunnel host is up (or still starting). Never throws.
export function tunnelRunning() {
  try { const rec = readTunnel(); return !!rec && rec.state !== 'down' && tunnelAlive(rec); } catch { return false; }
}

// The address of a tunnel that is up with its host running, where WebDriverAgent can be asked to stop (issue 86); else null.
export function tunnelAddress() {
  try { const rec = readTunnel(); return rec?.state === 'up' && tunnelAlive(rec) ? rec.address : null; } catch { return null; }
}

// What `lab status` and `lab tunnel status` show: the record (no UDID) and whether its host runs.
export function tunnelReport() {
  let rec;
  try { rec = readTunnel(); } catch (e) { return { state: 'damaged', error: e.message }; }
  if (!rec) return { state: 'none' };
  return { state: rec.state, alive: tunnelAlive(rec), pid: rec.pid, address: rec.address, rsdPort: rec.rsdPort, registryPort: rec.registryPort, startedAt: rec.startedAt, ...(rec.reason ? { reason: rec.reason } : {}), ...(rec.detail ? { detail: rec.detail } : {}) };
}

// --- WebDriverAgent over the tunnel ---

// Over Wi-Fi the lab starts the phone's WebDriverAgent itself (Appium's own launch checks the
// device through usbmux), bound to the tunnel address only (USE_IP), and Appium is pointed at it
// (webDriverAgentUrl). `WDA` (port, and `url`, swappable: tests have no tunnel) is in appium.js.
export { WDA };
// Waits, in ms: the build (it signs too) and how often the lease is renewed during it, /status answering after the launch, each poll and each request,
// and the one /status request of the route check (routeStatus) that a failed page command makes.
export const WDA_WAIT = { buildMs: 600e3, statusMs: 120e3, pollMs: 1e3, callMs: 1e3, touchMs: 60e3, probeMs: 3e3 };
export const wdaLogPath = () => path.join(svc.logsDir(), 'msl-wda-device.log');
const wdaProject = () => path.join(appiumHome(), 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj');

// xcodebuild's arguments, as appium-webdriveragent's xcodebuild.js builds them for a real device
// (team, signing identity and bundle id from the saved phone; the lab's device derived data).
export function wdaBuildArgs({ phone, platformVersion, action }) {
  const v = /^(\d+)\.(\d+)/.exec(platformVersion ?? '');
  return [
    action,
    ...(action === 'build-for-testing' ? ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration'] : []),
    '-project', wdaProject(), '-scheme', 'WebDriverAgentRunner', '-derivedDataPath', wdaDerivedData(),
    '-destination', `id=${phone.udid}`,
    ...(v ? [`IPHONEOS_DEPLOYMENT_TARGET=${v[1]}.${v[2]}`] : []),
    `DEVELOPMENT_TEAM=${phone.teamId}`, 'CODE_SIGN_IDENTITY=Apple Development', `PRODUCT_BUNDLE_IDENTIFIER=${phone.bundleId}`,
    'GCC_TREAT_WARNINGS_AS_ERRORS=0', 'COMPILER_INDEX_STORE_ENABLE=NO',
  ];
}

const hasXctestrun = () => {
  try { return fs.readdirSync(path.join(wdaDerivedData(), 'Build', 'Products')).some(f => f.endsWith('.xctestrun')); } catch { return false; }
};

// The last `bytes` of a file, from byte `from` on (a file now shorter than `from` was replaced: all of it is new).
// A missing or unreadable file reads as ''.
export const tailOf = (file, bytes = 16384, from = 0) => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(from <= size ? from : 0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
};

// A file's size in bytes, 0 when it is missing: the offset to read a log from, to see only what is written after.
export const sizeOf = file => { try { return fs.statSync(file).size; } catch { return 0; } };

// One /status request to WebDriverAgent through the tunnel, bounded by `ms` (an interrupt ends it).
async function wdaAnswers(address, ms = WDA_WAIT.callMs) {
  try {
    const res = await fetch(`${WDA.url(address)}/status`, { signal: AbortSignal.any([AbortSignal.timeout(ms), requestSignal()]) });
    return res.ok;
  } catch {
    if (interrupted()) throw new InterruptError(interrupted());
    return false;
  }
}

// Builds (and signs) the phone's WebDriverAgent runner: `xcodebuild build-for-testing` into the lab's device derived data. Not a
// synchronous run: an interrupt ends the build at once (InterruptError), and the lease is renewed while it runs. A failed or
// timed-out build throws the `needs` its output points to. Shared by the Wi-Fi launch and the lend step's install (issue 63). The caller
// holds the signing lock.
export async function buildWda({ phone, platformVersion, touch }) {
  await touch?.();
  const r = await runAsync('xcodebuild', wdaBuildArgs({ phone, platformVersion, action: 'build-for-testing' }), { timeoutMs: WDA_WAIT.buildMs, onTick: touch, tickMs: WDA_WAIT.touchMs });
  if (r.code !== 0) {
    const text = r.code === 124 ? `xcodebuild build-for-testing timed out after ${Math.round(WDA_WAIT.buildMs / 1000)}s` : `xcodebuild build-for-testing failed (exit ${r.code}): ${`${r.stderr || ''}\n${r.stdout || ''}`.trim().split('\n').slice(-6).join(' ')}`;
    throw needsError(classify(text), text);
  }
  await touch?.();
}

// Starts the phone's WebDriverAgent for a session over the tunnel: stops an old one (the runner on the phone too, issue 86), builds (and
// signs) it when there is no xctestrun under the device derived data, then runs `xcodebuild
// test-without-building` detached (launchd adopts it; `lab down` stops it) with USE_IP=<tunnel
// address>, its output in msl-wda-device.log (0600), and polls /status once a second. On timeout
// the xcodebuild is stopped and the log's end classified (passcode, resign, ...). An interrupt
// leaves it running for `lab down`. Returns { pid, built }.
// The build, its signing and the launch run under the signing lock shared with sideload (issue 63): the one caller,
// createSession in safari.js, holds it across this and the session create, so it is not taken again here.
export async function launchWda({ phone, tunnel: tun, platformVersion, touch }) {
  await stopDeviceWda(undefined, { address: tun.address });
  let built = false;
  if (!hasXctestrun()) {
    await buildWda({ phone, platformVersion, touch });
    built = true;
  }
  const { pid } = spawnDetached('xcodebuild', wdaBuildArgs({ phone, platformVersion, action: 'test-without-building' }), {
    env: { USE_IP: tun.address, USE_PORT: String(WDA.port), WDA_PRODUCT_BUNDLE_IDENTIFIER: phone.bundleId },
    log: wdaLogPath(),
  });
  if (!pid) throw new Error('couldn\'t start xcodebuild for WebDriverAgent');
  const end = Date.now() + WDA_WAIT.statusMs;
  for (;;) {
    if (await wdaAnswers(tun.address)) return { pid, built };
    if (Date.now() >= end) break;
    await touch?.();
    await sleep(WDA_WAIT.pollMs);
  }
  const said = tailOf(wdaLogPath());
  await stopDeviceWda(undefined, { address: tun.address });
  const waited = `WebDriverAgent did not answer on the tunnel address within ${Math.round(WDA_WAIT.statusMs / 1000)}s`;
  const needs = classify(said);
  if (needs !== 'unknown') throw needsError(needs, `${waited} (its log, ${wdaLogPath()}, points to: ${needs})`, { evidence: said });
  const health = await tunnelHealthy();
  if (!health.ok) throw needsError('tunnel', `${waited}: ${health.why}`);
  throw needsError('unknown', `${waited}; see ${wdaLogPath()}`);
}

// Whether the tunnel a device session runs over still works: a live `up` record whose RSD port
// accepts one TCP connect. { ok, why? }.
export async function tunnelHealthy() {
  let rec;
  try { rec = readTunnel(); } catch (e) { return { ok: false, why: e.message }; }
  if (!rec || rec.state !== 'up') return { ok: false, why: rec ? `the tunnel is ${rec.state}${rec.reason ? ` (${reasonOf(rec.reason, rec.detail)})` : ''}` : 'no tunnel is recorded' };
  if (!tunnelAlive(rec)) return { ok: false, why: 'the tunnel host is gone' };
  if (!await hooks.probe(rec.address, rec.rsdPort)) return { ok: false, why: 'the phone does not answer through the tunnel' };
  return { ok: true };
}

// Whether the route to the phone works, for a failed page command and `lab tunnel status`: the tunnel
// (tunnelHealthy) and then, with `wda`, one /status request to WebDriverAgent through it.
// { ok } or { ok: false, stage: 'tunnel' | 'wda', why }. Each probe is bounded; an interrupt throws.
export async function routeStatus({ wda = true } = {}) {
  const health = await tunnelHealthy();
  if (!health.ok) return { ok: false, stage: 'tunnel', why: health.why };
  if (!wda) return { ok: true };
  let rec;
  try { rec = readTunnel(); } catch (e) { return { ok: false, stage: 'tunnel', why: e.message }; }
  if (!await wdaAnswers(rec.address, WDA_WAIT.probeMs)) return { ok: false, stage: 'wda', why: 'the tunnel reaches the phone but WebDriverAgent does not answer' };
  return { ok: true };
}

// Whether the tunnel a recorded device session was made on is gone, so asking the session anything would only wait out a
// timeout (`lab up` after a dropped tunnel, issue 62). `transport` is the session's own record ({ via, address, startedAt? }).
// A cable session (or none recorded) is never gone. Gone: no `up` record or no live host, a tunnel that is another one
// (the record's `startedAt` differs from the session's; for a session recorded before `startedAt`, its address does), or
// the same tunnel whose RSD port does not answer one 3 s TCP connect. With `wda` (what `lab up` asks) the same tunnel must
// also answer one 3 s WebDriverAgent /status request: Appium answers a session's context list without WebDriverAgent, so a
// session whose runner died behind a good tunnel would otherwise be kept for ever. { gone, why? }.
export async function sessionRouteGone(transport, { wda = false } = {}) {
  if (transport?.via !== 'tunnel') return { gone: false };
  let rec;
  try { rec = readTunnel(); } catch (e) { return { gone: true, why: e.message }; }
  if (!rec) return { gone: true, why: 'no tunnel is recorded' };
  if (rec.state !== 'up') return { gone: true, why: `the tunnel is ${rec.state}${rec.reason ? ` (${reasonOf(rec.reason, rec.detail)})` : ''}` };
  if (!tunnelAlive(rec)) return { gone: true, why: 'the tunnel host is gone' };
  const was = typeof transport.startedAt === 'string' ? rec.startedAt === transport.startedAt : typeof transport.address === 'string' ? rec.address === transport.address : true;
  if (!was) return { gone: true, why: 'its tunnel was replaced' };
  if (!await hooks.probe(rec.address, rec.rsdPort)) return { gone: true, why: 'the phone does not answer through the tunnel' };
  if (wda && !await wdaAnswers(rec.address, WDA_WAIT.probeMs)) return { gone: true, why: 'WebDriverAgent does not answer through the tunnel' };
  return { gone: false };
}
