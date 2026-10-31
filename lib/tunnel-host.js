// The tunnel host: the one process that holds the Wi-Fi tunnel to the phone while the lab uses
// it (bin/lab-tunnel-host, run by launchd as com.dividedby.msl-tunnel). It opens Apple's native
// tunnel with pymobiledevice3, checks that the device at the other end is the saved phone, serves
// remotexpc's tunnel registry on 127.0.0.1 so xcuitest can find it, writes tunnel.json, and
// watches. When the tool exits, the phone stops answering or launchd sends SIGTERM, it stops the
// phone's WebDriverAgent, the registry and its registry key, records why, and exits. Not a lab
// command: no lease, no activity, no JSON; one line per event on stderr (the agent's log).
// It never restarts CoreDeviceService: only a lab command under the lease does that.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { loadState, maskDevices } from './core.js';
import { appiumHome } from './appium.js';
import { readPhone, redactMessage } from './phone.js';
import { checkPmd3 } from './pmd3.js';
import { stopDeviceWda } from './wda.js';
import { writeTunnel, strongbox, hooks, isTunnelAddress, isPort, restoreStrongbox, registryModule } from './tunnel.js';

// Waits, in ms (tests shorten them): the tool's first line, each `rsd-info` and the tries, the
// watch's TCP checks of the RSD port and how many may fail in a row, the tool's exit after SIGTERM and
// the registry's stop. With the phone's WebDriverAgent stop (`stopProcess`, up to 10 s) the teardown
// takes at most about 20 s, under the 25 s that `stopTunnel` waits (TUNNEL_WAIT.stopMs).
export const HOST_WAIT = { lineMs: 30e3, rsdMs: 15e3, rsdTries: 3, rsdGapMs: 1e3, probeEveryMs: 15e3, probeFails: 3, probeMs: 3e3, killMs: 5e3, registryStopMs: 5e3 };

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// The tool's first line, `<address> <RSD port>`: { address, rsdPort }, or null for anything else.
export function parseTunnelLine(line) {
  const m = /^(\S+) (\d{1,5})$/.exec(String(line ?? '').trim());
  if (!m || !isTunnelAddress(m[1])) return null;
  const rsdPort = Number(m[2]);
  return isPort(rsdPort) ? { address: m[1], rsdPort } : null;
}

async function startRegistry(infos, port) {
  const file = registryModule();
  if (!fs.existsSync(file)) throw new Error(`remotexpc's tunnel registry is not at ${file}: the lab needs appium-xcuitest-driver 12.18.1 installed in ${appiumHome()}`);
  const { startTunnelRegistryServer } = await import(pathToFileURL(file).href);
  if (typeof startTunnelRegistryServer !== 'function') throw new Error(`${file} has no startTunnelRegistryServer: the lab needs appium-xcuitest-driver 12.18.1`);
  return startTunnelRegistryServer(infos, port);
}

// A free TCP port on 127.0.0.1 (the registry binds it right after).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// The tool's child processes get a wide terminal: rich wraps its output at 80 columns when it is
// piped, and a wrapped exception line is two lines.
const toolEnv = () => ({ ...process.env, COLUMNS: '500' });

// `pymobiledevice3 remote start-tunnel --native --udid <saved phone> --script-mode` (without --udid the
// tool may pick an Apple TV on the network), stdin from /dev/null.
const spawnTool = (pmd3, udid) => spawn(pmd3, ['remote', 'start-tunnel', '--native', '--udid', udid, '--script-mode'], { stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv() });

// The line of a pymobiledevice3 failure that says what went wrong, for a person. The tool prints
// a rich traceback box (ANSI colours, lines framed in box-drawing characters) that ends in the
// exception line, so the start of the text is the frame and the end is the cause. Text with none
// of that decoration is returned whole. Otherwise: the last line that looks like a Python exception
// (an exception group's `| ` lines count; its `+` rules and the frames do not), else the last plain line.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const FRAME = /^[─-╿|+]|^Traceback \(most recent call last\)|^File ".*", line \d+/;
const EXCEPTION = /^(?=[A-Za-z_])[\w.]*(?:Error|Exception(?:Group)?|Exit|Interrupt)(?::.*)?$/;
export function toolFailure(text) {
  const all = String(text ?? '').replace(ANSI, '');
  const lines = all.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean);
  if (all === String(text ?? '') && !lines.some(l => FRAME.test(l))) return all;
  const kept = lines.map(l => {
    if (!l.startsWith('|')) return l;
    const rest = l.replace(/^(?:\|\s*)+/, '');
    return EXCEPTION.test(rest) ? rest : '';
  }).filter(l => l && !FRAME.test(l));
  return kept.findLast(l => EXCEPTION.test(l)) ?? kept.at(-1) ?? all;
}

// What the host says of the tool's failure, in the log and the record: the reduced text with device
// ids out of it (each whole, before the length limit can cut one in two), one line, short.
const toolSaid = text => redactMessage(maskDevices(redactMessage(toolFailure(text), Infinity)), 160);

// `rsd-info --native` for the saved phone (`PYMOBILEDEVICE3_UDID`: rsd-info takes no --udid): the
// handshake's JSON, or rejects. It rides the same remoted tunnel as start-tunnel, so the service ports
// are the ones Appium will use, and it handshakes with remoted's UUID. Not `--rsd <address> <port>`:
// that handshakes with the tool's host-id UUID, and from iOS 27.2 a new UUID makes the phone
// re-attach and close every service listener (issue 111). Asynchronous so that a stop request (`stopped`
// resolves) is handled at once: the tool is killed and the host goes on to tear down.
function rsdInfo(pmd3, udid, stopped = new Promise(() => {})) {
  return new Promise((resolve, reject) => {
    const child = spawn(pmd3, ['remote', 'rsd-info', '--native'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...toolEnv(), PYMOBILEDEVICE3_UDID: udid } });
    let out = '', err = '', settled = false;
    const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); fn(v); };
    const timer = setTimeout(() => end(reject, new Error(`rsd-info timed out after ${HOST_WAIT.rsdMs / 1000}s`)), HOST_WAIT.rsdMs);
    stopped.then(() => end(reject, new Error('stopped')));
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err = (err + c).slice(-2000); });
    child.once('error', e => end(reject, new Error(`rsd-info failed: ${e.message}`)));
    child.once('close', code => {
      if (code !== 0) {
        const said = toolSaid(err || out);
        return end(reject, Object.assign(new Error(`rsd-info failed (exit ${code}): ${said}`), { detail: said }));
      }
      try { end(resolve, JSON.parse(out)); } catch { end(reject, new Error('rsd-info printed something that is not JSON')); }
    });
  });
}

// The registry's service catalog from the handshake: { name: { port } } (remotexpc servicesToCatalog's shape).
export function catalogOf(info) {
  const out = {};
  for (const [name, s] of Object.entries(info?.Services ?? {})) {
    const port = Number(s?.Port);
    if (typeof name === 'string' && isPort(port)) out[name] = { port: String(port) };
  }
  return out;
}

// Resolves with the tool's first stdout line, its exit (with the end of stderr), or silence after `ms`.
function firstLine(child, ms, stopped) {
  return new Promise(resolve => {
    let out = '', err = '';
    const timer = setTimeout(() => resolve({ silent: true }), ms);
    const done = v => { clearTimeout(timer); resolve(v); };
    child.stdout.on('data', c => {
      out += c;
      const i = out.indexOf('\n');
      if (i >= 0) done({ line: out.slice(0, i) });
    });
    child.stderr.on('data', c => { err = (err + c).slice(-2000); });
    child.once('exit', code => done({ exit: code, stderr: err }));
    child.once('error', e => done({ exit: 127, stderr: e.message }));
    stopped.then(() => done({ stopped: true }));
  });
}

// Runs the host until it stops. Returns { code, reason }: 0 after SIGTERM, 1 otherwise. `deps`
// replace the outside world in tests: pmd3 (the tool's path; checked with checkPmd3 when absent),
// spawnTool, rsdInfo, startRegistry, freePort, stopWda, probe, signals (an EventEmitter), log, pid, now. The default
// stopWda stops the xcodebuild only: the tunnel is gone by then, so devicectl is left to `lab down` (issue 86).
export async function runHost(deps = {}) {
  const d = { spawnTool, rsdInfo, startRegistry, freePort, stopWda: () => stopDeviceWda(undefined, { device: false }), probe: hooks.probe, signals: process, log: line => console.error(maskDevices(`[tunnel] ${line}`)), pid: process.pid, now: () => new Date(), ...deps };
  let phone;
  try { phone = readPhone(loadState()); } catch (e) { d.log(e.message); return { code: 1, reason: 'no-phone' }; }
  if (!phone) { d.log('no phone is saved: run `lab phone setup`'); return { code: 1, reason: 'no-phone' }; }

  const rec = { v: 1, pid: d.pid, udid: phone.udid, address: null, rsdPort: null, registryPort: null, startedAt: d.now().toISOString(), state: 'starting', strongboxWas: null, strongboxOurs: false };
  // Validated before the record changes: a patch that is not a record leaves it as it was.
  const save = patch => { writeTunnel({ ...rec, ...patch }); Object.assign(rec, patch); };
  save({});

  let stopReason = null, stopDetail = null, wake;
  const stopped = new Promise(r => { wake = r; });
  const stop = (reason, detail = null) => { if (!stopReason) { stopReason = reason; stopDetail = detail; wake(); } };
  const onSignal = () => stop('stopped');
  for (const s of SIGNALS) d.signals.on(s, onSignal);
  // A wait that ends early when the host is told to stop (no timer is left behind).
  const delay = ms => new Promise(r => { const t = setTimeout(r, ms); stopped.then(() => { clearTimeout(t); r(); }); });

  let child = null, server = null, exited = false;
  try { await body(); } catch (e) {
    d.log(`failed: ${redactMessage(e.message, 160)}`);
    stop(`error: ${redactMessage(e.message, 160)}`.slice(0, 200));
  } finally {
    // Another signal during the teardown (stopTunnel's fallback after its wait) must not end it midway: it is swallowed.
    const swallow = () => d.log('already stopping: the teardown goes on');
    for (const s of SIGNALS) { d.signals.on(s, swallow); d.signals.off(s, onSignal); }
    try { await teardown(); } finally { for (const s of SIGNALS) d.signals.off(s, swallow); }
  }
  return { code: stopReason === 'stopped' ? 0 : 1, reason: stopReason };

  async function body() {
    let pmd3 = d.pmd3;
    if (!pmd3) {
      const tool = checkPmd3();
      if (!tool.ok) { d.log(tool.error); stop(tool.slow ? 'tool-slow' : 'tool-missing'); return; }
      pmd3 = tool.path;
    }

    // 1. The tunnel, from the tool's first line.
    child = d.spawnTool(pmd3, phone.udid);
    child.once('exit', () => { exited = true; });
    const first = await firstLine(child, HOST_WAIT.lineMs, stopped);
    if (first.stopped) return;
    if (first.silent) { d.log(`the tool printed nothing within ${HOST_WAIT.lineMs / 1000}s (CoreDeviceService may be stuck)`); stop('coredevice-silent'); return; }
    if (first.exit !== undefined) {
      const said = toolSaid(first.stderr);
      d.log(`the tool exited (code ${first.exit}) before the tunnel was up: ${said}`);
      stop(/no (connected )?devices?|device not found|no device matching/i.test(first.stderr) ? 'not-listed' : `tool-exited: ${said}`.slice(0, 200));
      return;
    }
    const tun = parseTunnelLine(first.line);
    if (!tun) { d.log('the tool\'s first line is not "<fd… address> <port>"'); stop('bad-output'); return; }
    child.stdout.resume();
    save(tun);

    // 2. Backstop: the device at the other end must still be the saved phone, whatever the tool did with --udid.
    let info = null, why = null, detail = null;
    for (let i = 0; i < HOST_WAIT.rsdTries && !stopReason; i++) {
      if (i) await delay(HOST_WAIT.rsdGapMs);
      if (stopReason) break;
      try { info = await d.rsdInfo(pmd3, phone.udid, stopped); break; } catch (e) { why = e.message; detail = e.detail ?? e.message; }
    }
    if (stopReason) return;
    if (!info) { d.log(`rsd-info failed ${HOST_WAIT.rsdTries} times: ${why}`); stop('rsd-failed', toolSaid(detail)); return; }
    const seen = info?.Properties?.UniqueDeviceID;
    if (typeof seen !== 'string' || seen.toUpperCase() !== phone.udid.toUpperCase()) { d.log('the tunnel reached another device than the saved phone'); stop('wrong-device'); return; }

    // The iOS version the handshake reported: Appium needs it over the tunnel, and usbmux can't give it.
    const version = [info?.Properties?.ProductVersion, info?.Properties?.OSVersion].find(v => typeof v === 'string' && v.length <= 16 && /^\d+(\.\d+){1,2}$/.test(v));
    if (version) save({ osVersion: version });

    // 3. The registry, unless another live registry owns the key.
    const was = strongbox.read();
    if (was !== null && isPort(Number(was)) && await d.probe('127.0.0.1', Number(was), HOST_WAIT.probeMs)) {
      d.log(`another tunnel registry is live on 127.0.0.1:${was}: left alone`);
      stop('registry-busy');
      return;
    }
    if (stopReason) return;
    const port = await d.freePort();
    save({ registryPort: port, strongboxWas: was, strongboxOurs: true });
    const infos = { tunnels: { [phone.udid]: { udid: phone.udid, address: tun.address, rsdPort: tun.rsdPort, services: catalogOf(info), lastUpdated: Date.now() } }, metadata: { lastUpdated: d.now().toISOString(), totalTunnels: 1, activeTunnels: 1 } };
    server = await d.startRegistry(infos, port);
    strongbox.secure(); // the library writes the key with its own mode
    if (strongbox.read() !== String(port)) { d.log('the registry did not write its port where xcuitest reads it'); stop('registry-key'); return; }
    if (stopReason) return;

    // 4. Up.
    save({ state: 'up' });
    d.log(`up: ${tun.address} port ${tun.rsdPort}, registry on 127.0.0.1:${port}`);

    // 5. Watch.
    child.once('exit', () => stop('tool-exited'));
    if (exited) stop('tool-exited');
    let fails = 0;
    while (!stopReason) {
      await delay(HOST_WAIT.probeEveryMs);
      if (stopReason) break;
      fails = (await d.probe(tun.address, tun.rsdPort, HOST_WAIT.probeMs)) ? 0 : fails + 1;
      if (fails >= HOST_WAIT.probeFails) stop('unreachable');
    }
  }

  async function teardown() {
    if (child && !exited) {
      child.kill('SIGTERM');
      const gone = await new Promise(r => { const t = setTimeout(() => r(false), HOST_WAIT.killMs); child.once('exit', () => { clearTimeout(t); r(true); }); if (exited) { clearTimeout(t); r(true); } });
      if (!gone) child.kill('SIGKILL');
    }
    try { await d.stopWda(); } catch (e) { d.log(`couldn't stop the phone's WebDriverAgent: ${redactMessage(e.message, 160)}`); }
    if (server) {
      // Not unref'd and cleared afterwards: a stop that never settles must not empty the event loop mid-teardown.
      // (bin/lab-tunnel-host exits explicitly, so a hung stop cannot keep the process alive afterwards.)
      let t;
      const bound = new Promise((_, no) => { t = setTimeout(() => no(new Error(`it did not stop within ${HOST_WAIT.registryStopMs / 1000}s`)), HOST_WAIT.registryStopMs); });
      try { await Promise.race([server.stop(), bound]); } catch (e) { d.log(`couldn't stop the registry: ${redactMessage(e.message, 160)}`); } finally { clearTimeout(t); }
    }
    restoreStrongbox(rec);
    save({ state: 'down', reason: stopReason ?? 'stopped', ...(stopDetail ? { detail: stopDetail } : {}), strongboxOurs: false });
    d.log(`down: ${stopReason}`);
  }
}
