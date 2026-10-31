// The phone's WebDriverAgent `xcodebuild`, shared by `lab down` and `safari stop`. Appium starts
// it for a device session (`xcodebuild ... test-without-building`, destination id=<phone UDID>,
// derived data under the Appium home); after the session is deleted it keeps running with
// ppid 1. Nothing here is stopped unless its command line carries BOTH markers (the phone's UDID
// and the lab's device derived-data path) and the executable is xcodebuild itself.
// Killing the xcodebuild does not end the XCTest session: over the tunnel the runner app stays on the
// phone ("Automation Running", issue 86). So the runner is asked to stop first (`/wda/shutdown`, after which
// the xcodebuild exits by itself), and the phone's process list is checked afterwards (devicectl).
import { loadState, processCommand, sleep } from './core.js';
import { WDA } from './appium.js';
import { readPhone, wdaDerivedData, listRunners, killRunner } from './phone.js';
import { listProcesses, stopProcess, serviceInstalled, launchdState, waitUntil, WAIT } from './service.js';

const XCODEBUILD = /^(?:\S*\/)?xcodebuild(?:\s|$)/;
// Waits, in ms: the one /wda/shutdown request, the xcodebuild's exit after it, and the pause before the phone's process list is read again.
export const STOP_WAIT = { shutdownMs: 3e3, exitMs: 10e3, settleMs: 5e3 };
const RUNNER_LEFT = 'hold both volume buttons on the phone to restart it, or run `lab down` again';
const validPid = p => Number.isInteger(p) && p > 1;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The pid of the Appium the lab runs: the service's when installed, else the recorded one.
export const appiumPid = (state = loadState()) => (serviceInstalled() ? launchdState().pid : state.driverPid);

// The phones this state may have a WDA for: the saved one and the one a device session is on.
function phoneUdids(state) {
  const ids = new Set();
  try { const p = readPhone(state); if (p) ids.add(p.udid); } catch { /* a damaged record names no phone */ }
  const dev = state?.target?.device;
  if (typeof dev === 'string' && /^[0-9A-Fa-f-]+$/.test(dev)) ids.add(dev);
  return [...ids];
}

// Whether a `ps` command line is the WDA xcodebuild for one of the phones: the anchored
// executable, `id=<udid>` as its own token, and the device derived-data folder as its own path.
export function isDeviceWda(command, udids, derivedData = wdaDerivedData()) {
  if (!XCODEBUILD.test(command)) return false;
  const dirRe = new RegExp(`(?:^|[\\s='"])${escape(derivedData)}(?=$|[\\s/'"])`);
  return dirRe.test(command) && udids.some(u => new RegExp(`(?:^|[\\s,'"])id=${escape(u)}(?=$|[\\s,'"])`).test(command));
}

// The processes to stop, each { pid, command, kind, guard } (guard: what `stopProcess` re-checks
// on the live command line right before SIGTERM). Only a child of the lab's Appium or an orphan
// (ppid 1) counts, or a child of this process (the one `launchWda` just started over the tunnel).
export function deviceWdaTargets(state = loadState(), procs = listProcesses()) {
  const udids = phoneUdids(state);
  if (!udids.length) return [];
  const dd = wdaDerivedData();
  const parent = appiumPid(state);
  const guard = { test: c => isDeviceWda(c, udids, dd) };
  return procs
    .filter(p => isDeviceWda(p.command, udids, dd) && (p.ppid === 1 || p.ppid === process.pid || (validPid(parent) && p.ppid === parent)))
    .map(p => ({ pid: p.pid, command: p.command, kind: 'xcodebuild', guard }));
}

// SIGTERMs each target through its guard. Throws for one that is still running afterwards.
// Returns { found, did } in the shape of a `lab down` step (did null when nothing was stopped).
export async function stopTargets(targets) {
  const stopped = [], notes = [];
  for (const { pid, kind, guard } of targets) {
    const label = `${kind} (pid ${pid})`;
    const r = await stopProcess(pid, guard);
    if (r.state === 'stuck') throw new Error(`${label} didn't exit within ${Math.round(WAIT.portFreeMs / 1000)}s after SIGTERM`);
    if (r.state === 'stopped') stopped.push(label);
    else notes.push(r.state === 'gone' ? `${label} already gone` : `${label} is now something else: left alone`);
  }
  const found = [targets.map(t => `${t.kind} (pid ${t.pid})`).join(', '), ...notes].join('; ');
  return { found, did: stopped.length ? `stopped ${stopped.join(', ')}` : null };
}

// Asks the runner on the phone to end its test (WebDriverAgent's own `/wda/shutdown`) through the tunnel address.
// Any failure means it is not reachable.
async function shutdownRunner(address) {
  try {
    const res = await fetch(`${WDA.url(address)}/wda/shutdown`, { signal: AbortSignal.timeout(STOP_WAIT.shutdownMs) });
    return res.ok;
  } catch { return false; }
}

// SIGKILLs the lab's runner app on the phone, if its process list shows one (SIGTERM is answered by a relaunch), and
// reads the list again after a pause. Only a process whose executable is in WebDriverAgentRunner-Runner.app is signalled.
// Returns { found, did } (null when no runner is listed); a phone that can't be asked is a `found` note, not a failure;
// throws when a runner is still listed afterwards.
async function reapRunner(udid) {
  const first = listRunners(udid);
  if (!first.ok) return { found: `couldn't list the phone's processes: ${first.error}`, did: null };
  if (!first.runners.length) return null;
  const pids = first.runners.map(r => r.pid);
  const found = `runner app on the phone (pid ${pids.join(', ')})`;
  const failures = pids.map(pid => ({ pid, r: killRunner(udid, pid) })).filter(k => !k.r.ok).map(k => `pid ${k.pid}: ${k.r.error}`);
  await sleep(STOP_WAIT.settleMs);
  const again = listRunners(udid);
  if (!again.ok) return { found, did: `sent SIGKILL${failures.length ? ` (${failures.join('; ')})` : ''}, but couldn't read the phone's processes afterwards: ${again.error}` };
  if (again.runners.length) throw Object.assign(new Error(`the WebDriverAgent runner is still on the phone (pid ${again.runners.map(r => r.pid).join(', ')}) after SIGKILL${failures.length ? ` (${failures.join('; ')})` : ''}`), { hint: RUNNER_LEFT, report: { found, did: `sent SIGKILL to pid ${pids.join(', ')}` } });
  return { found, did: `sent SIGKILL to the runner (pid ${pids.join(', ')}); it is gone` };
}

// Joins step reports ({ found, did }, or null for none) into one: each field the non-empty parts joined by "; ", else null.
export const joinReports = reports => {
  const join = k => reports.map(r => r?.[k]).filter(Boolean).join('; ') || null;
  return { found: join('found'), did: join('did') };
};

// Stops the phone's WDA: with the tunnel `address`, the runner is asked to shut down and the xcodebuild given
// STOP_WAIT.exitMs to exit by itself, and only one still there is SIGTERMed. Then, unless it was shut down and nothing is
// listed, the saved phone's process list is read (devicectl) and a runner still on it is SIGKILLed (`device: false`
// skips that: for the tunnel host, whose tunnel is gone). Only done when there is reason to think a runner exists: an
// xcodebuild, a tunnel address, a recorded device session (a cable one too), or `deviceRun` (`lab down` knows the last
// run was on the phone, which a retry after a failed `wda` step needs: the session and the tunnel are already gone). Returns { found, did } or null when none
// of that is found; throws for an xcodebuild or a runner that stays, saying what was found and done (with `prior`, the
// report of an earlier stop in the same step, first) and then what to do.
export async function stopDeviceWda(state = loadState(), { address = null, device = true, deviceRun = false, prior = null } = {}) {
  const targets = deviceWdaTargets(state);
  let phone = null;
  try { phone = readPhone(state); } catch { /* a damaged record names no phone */ }
  const onDevice = device && phone && (targets.length > 0 || !!address || deviceRun || typeof state?.target?.device === 'string');
  if (!targets.length && !address && !onDevice) return null;

  const reports = [];
  const shut = address ? await shutdownRunner(address) : false;
  let left = targets;
  if (shut) {
    reports.push({ found: 'runner asked to shut down' });
    await waitUntil(() => targets.every(t => !processCommand(t.pid)), STOP_WAIT.exitMs);
    left = targets.filter(t => processCommand(t.pid));
    if (targets.length > left.length) reports.push({ did: 'its xcodebuild exited by itself' });
  }
  let stuck = null;
  if (left.length) {
    try { reports.push(await stopTargets(left)); } catch (e) { stuck = e; }
  }
  let tooLate = null;
  if (onDevice) {
    try { reports.push(await reapRunner(phone.udid)); } catch (e) { tooLate = e; reports.push(e.report); }
  }
  if (stuck || tooLate) {
    const all = joinReports([prior, ...reports]);
    const problems = [stuck, tooLate].filter(Boolean).map(e => e.message).join('; ');
    throw new Error(`${problems} (found: ${all.found ?? 'nothing'}; did: ${all.did ?? 'nothing'})${tooLate?.hint ? `: ${tooLate.hint}` : ''}`);
  }
  const out = joinReports(reports);
  return out.found || out.did ? out : null;
}
