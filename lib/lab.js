// bin/lab: availability. `lab up` gets from whatever state the Mac is in to a working
// simulator or iPhone + Safari session (`--target`), saying at each step what it found and did; `lab down` stops
// what the lab started (`lab down --idle` is the idle stop, run by its own LaunchAgent);
// `lab status` looks without touching; `lab release` hands the lease back; `lab service`
// manages the Appium and idle stop LaunchAgents; `lab hold` keeps the idle stop off while a
// person uses the simulator by hand; `lab phone` saves, checks and forgets the physical iPhone;
// `lab tunnel` opens and closes the Wi-Fi tunnel to it by hand.
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, parseArgs, isUdid, run, maskDevices, quote, isTime } from './core.js';
import { InterruptError, afterPendingSignals, duringCleanup, interrupted } from './interrupt.js';
import { appiumBin, appiumHome, INSTALL_HINT, redactUrl, errorText, asError } from './appium.js';
import { udid as simUdid, simState, simInfo, bootSim, yieldTo, appRunning, WINDOW_APPS, checkProfile, profileOfUdid, labDevices, configuredRecord, simulatorSession } from './sim.js';
import * as lease from './lease.js';
import * as svc from './service.js';
import { phoneStatus, lockState, profileExpiry, hoursLeft, isTeamId, isBundleId, readPhone, withSeen, withRoute, keyboardTarget, focusConfig, isShortcutName, setFocus, parseOnOff, KEYBOARD_HUMAN, NEEDS, defaultBundleId, needsError, redactMessage, needsResign, chooseTarget, TARGETS, RESIGN_WITHIN_MS } from './phone.js';
import { restorePending, restoreReport, restoreHuman, forgetRestore, pendingNames, changeFocus, KINDS as RESTORE_KINDS, COMMAND_KINDS, SETTINGS, settingWords, settingUsage, CHECK_BY_HAND } from './phone-restore.js';
import { deviceWdaTargets, stopTargets, stopDeviceWda, joinReports } from './wda.js';
import { labVersion } from './version.js';
import { checkPmd3, pmd3Hint } from './pmd3.js';
import { ensureTunnel, stopTunnel, tunnelRunning, tunnelAddress, tunnelReport, registryModule, checkPhone, routeStatus, sessionRouteGone, RESTARTED } from './tunnel.js';
import { handlers as safari, startSession, parseAllowHosts, ensureAppium, endDeviceSession, appiumEndpoint, readSession, targetType, backendUrl, wd, WAIT as SAFARI_WAIT } from './safari.js';
import { lockReport, probe as probeSignLock } from './signlock.js';
import { readLend, lendState, forgetLend, returnSlot, slotStatus, wantsReturn, ensureWdaSlot, withSlot, SLOT_PHRASE, FORGET as FORGET_SLOT, RETURN as RETURN_SLOT } from './slot-lend.js';

const httpUrl = u => /^https?:\/\//.test(u || '');
const validPid = p => Number.isInteger(p) && p > 1;
const DELETE_MS = 10e3;

// What `down` records for a pid it was asked to stop (see svc.stopProcess); a pid that can't
// be stopped throws and stays in the state.
function pidOutcome(label, pid, r) {
  if (r.state === 'stuck') throw new Error(`${label} (pid ${pid}) didn't exit within ${Math.round(svc.WAIT.portFreeMs / 1000)}s after SIGTERM`);
  saveState({ driverPid: null });
  if (r.state === 'stopped') return { found: `${label} (pid ${pid})`, did: `stopped it (pid ${pid})` };
  if (r.state === 'gone') return { found: `${label} (pid ${pid}) already gone` };
  return { found: `pid ${pid} now runs something else (${redactUrl(r.command)}): left alone` };
}

// Runs one step of `up`, timing it and recording what it found and did. A throw becomes the
// failed step.
function stepper(steps) {
  return async (name, fn) => {
    const t = Date.now();
    try {
      const r = await fn();
      steps.push({ step: name, found: r.found, did: r.did ?? null, ...(r.report ?? {}), ms: Date.now() - t });
      return r;
    } catch (thrown) {
      const e = asError(thrown);
      // A cold-start hint (see createSession) is for the person reading the failed step too.
      const hint = e.coldStart === true && Array.isArray(e.extra?.human) ? { human: e.extra.human, then: e.extra.then } : {};
      steps.push({ step: name, found: null, did: null, error: errorText(e), ...hint, ms: Date.now() - t });
      e.failedStep = name;
      throw e;
    }
  };
}

const clearSession = () => saveState({ session: null, target: null, backend: null, injected: null, deviceTab: null, pagePin: null, transport: null });

// What the process of a pid we recorded has to look like (from `ps -o command=`): the
// executable, or the script node runs, by name, not any command line that mentions it
// (`vim appium.md`). Pids get reused.
const SAFARIDRIVER = /^(?:\S*\/)?safaridriver(?:\s|$)/;
const APPIUM = /^(?:\S*\/)?appium(?:\s|$)|^(?:\S*\/)?node\s+(?:-\S+\s+)*(?:\S*\/)?appium(?:\/(?:index|build\/lib\/main)\.js)?(?:\s|$)/;

// The steps of `down`. `ctx` is { before (the state when it started), devices (the lab's simulators,
// [{ profile, udid }], both profiles), flags, current (the recorded session, set by sessionStep) }.

// A phone session ended without its keyboard restore (WebDriverAgent killed, Appium crashed, or
// the restore failed) and there is no live session to restore through: starting one would only
// turn the settings off again, so a person sets them.
const keyboardLeft = ctx => {
  if (ctx.before.keyboardPending !== true) return undefined;
  ctx.keyboard = { keyboardRestored: false };
  return { keyboardRestored: false, human: [KEYBOARD_HUMAN] };
};

async function sessionStep(ctx) {
  try { ctx.current = readSession(ctx.before); } catch {
    clearSession();
    return { found: 'damaged session record', did: 'cleared it', report: keyboardLeft(ctx) };
  }
  if (!ctx.current) return { found: 'no session', report: keyboardLeft(ctx) };
  const { session: sid, backend, port, target } = ctx.current;
  let cut = false;
  try {
    // A device session first closes (or blanks) the lab's tab on the phone, restores the
    // keyboard settings, then deletes the session; what became of them is part of this step's output.
    if (backend === 'appium' && target.device !== undefined) {
      const tab = await endDeviceSession();
      if (tab.keyboardRestored !== undefined) ctx.keyboard = { keyboardRestored: tab.keyboardRestored };
      if (tab.phoneRestored !== undefined) ctx.phone = { phoneRestored: tab.phoneRestored, phoneRestore: tab.phoneRestore, ...(tab.restoredExactly === false ? { restoredExactly: false } : {}), human: restoreHuman(tab.phoneRestore) };
      return { found: `session ${sid} (${backend})`, did: 'ended it', report: tab };
    }
    const url = backend === 'appium' ? appiumEndpoint().url : backendUrl(backend, port);
    let did = 'ended it';
    try { await wd(url, 'GET', '/status', undefined, svc.WAIT.statusMs); } catch (e) {
      if (e instanceof InterruptError) throw e;
      did = 'cleared the record (the server isn\'t answering)';
    }
    if (did === 'ended it') {
      try { await wd(url, 'DELETE', `/session/${sid}`, undefined, DELETE_MS); } catch (e) {
        if (e.wd !== 'invalid session id') throw e;
        did = 'cleared the record (the server had already dropped it)';
      }
    }
    return { found: `session ${sid} (${backend})`, did, report: keyboardLeft(ctx) };
  } catch (e) {
    cut = e instanceof InterruptError;
    throw e;
  } finally {
    // An interrupt leaves the record: the session may not have been ended (endDeviceSession sends nothing more after one), and `lab down` again finishes.
    if (!cut) clearSession();
  }
}

// What Appium starts for the Claude iPhone: the WebDriverAgent `xcodebuild` (a child of
// Appium) and a `simctl diagnose`, each with our UDID and a path in the msl-appium folder.
// Stopped first, so the simulator doesn't shut down under a running test.
const XCODEBUILD = /^(?:\S*\/)?xcodebuild(?:\s|$)/;
const DIAGNOSE = /^(?:\S*\/)?(?:xcrun\s+)?simctl\s+diagnose(?:\s|$)/;
const kindOf = c => (XCODEBUILD.test(c) ? 'xcodebuild' : 'simctl diagnose');

// The phone's WebDriverAgent (see wda.js: the runner is asked to stop over the tunnel, which `tunnel` stops after this
// step, then the xcodebuild, then the phone's process list is checked) is stopped in the same step.
async function wdaStep({ devices, before, deviceRun }) {
  let targets = [];
  if (devices.length) {
    const home = appiumHome();
    const ours = c => devices.some(d => c.includes(d.udid)) && (c.includes(home) || c.includes('msl-appium'));
    const wda = c => XCODEBUILD.test(c) && c.includes('WebDriverAgent') && ours(c);
    const diagnose = c => DIAGNOSE.test(c) && ours(c);
    const appiumPid = svc.serviceInstalled() ? svc.launchdState().pid : loadState().driverPid;
    const guard = { test: c => wda(c) || diagnose(c) };
    const seen = new Set(deviceWdaTargets(before).map(t => t.pid));
    targets = svc.listProcesses()
      .filter(p => !seen.has(p.pid) && (diagnose(p.command) || (validPid(appiumPid) && p.ppid === appiumPid && wda(p.command))))
      .map(p => ({ pid: p.pid, command: p.command, kind: kindOf(p.command), guard }));
  }
  const sim = targets.length ? await stopTargets(targets) : null; // the simulator's first, as before
  const phone = await stopDeviceWda(before, { address: tunnelAddress(), deviceRun, prior: sim });
  if (!sim && !phone) return { found: devices.length ? 'none running' : 'no simulator saved' };
  return joinReports([sim, phone]);
}

// Brings the window app to the front, but only one the lab opened (the state's `windowApp`)
// and that is still running: a window the lab didn't open is not the lab's to raise, and one a
// person quit is not opened again. Null when nothing was raised.
function raiseWindow(id) {
  const app = loadState().windowApp;
  if (!Object.hasOwn(WINDOW_APPS, app) || appRunning(WINDOW_APPS[app]) !== true) return null;
  const r = app === 'Simulator'
    ? run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', id], { allowFail: true })
    : run('open', ['-b', WINDOW_APPS[app]], { allowFail: true });
  return r.code === 0 ? app : null;
}

// The state's `simBoot` says the lab booted a simulator (see bootSim); a Shutdown simulator ends it.
// The idle stop shuts down only a simulator the lab booted: one someone else booted is left alone.
// `simBoot` holds one UDID, which is enough: only one of the lab's simulators is booted at a time.
async function shutDownOne({ devices, idle, before }, id) {
  const state = simState(id);
  if (state === null) return { found: `simulator ${id} isn't known to simctl` };
  const recorded = loadState().simBoot;
  if (state === 'Shutdown') {
    if (recorded !== undefined && (recorded === id || !devices.some(d => d.udid === recorded))) saveState({ simBoot: null });
    return { found: 'shutdown' };
  }
  if (idle && before.simBoot !== id) return { found: `${state.toLowerCase()}, not booted by the lab: left alone`, left: true };
  if (state === 'Booted' || state === 'Booting') run('xcrun', ['simctl', 'shutdown', id], { allowFail: true, timeoutMs: 60e3 });
  if (!await svc.waitUntil(() => simState(id) === 'Shutdown', svc.WAIT.portFreeMs)) {
    throw new Error(`simulator ${id} is still ${simState(id)} ${Math.round(svc.WAIT.portFreeMs / 1000)}s after \`simctl shutdown\``);
  }
  if (loadState().simBoot === id) saveState({ simBoot: null });
  return { found: state.toLowerCase(), did: 'shut down' };
}

// Both of the lab's simulators (clean, and configured when there is one) are stopped; with the
// configured one saved, what each found and did is labelled by profile. The transient profile goes.
async function simulatorStep(ctx) {
  const { devices, deviceRun } = ctx;
  if (deviceRun) return { found: 'skipped (device run)' };
  if (!devices.length) return { found: 'no simulator saved' };
  const results = [], errors = [];
  for (const d of devices) {
    try { results.push({ profile: d.profile, ...await shutDownOne(ctx, d.udid) }); } catch (e) {
      if (e instanceof InterruptError) throw e;
      errors.push({ profile: d.profile, error: e });
    }
  }
  const labelled = devices.some(d => d.profile === 'configured');
  if (errors.length) {
    if (!labelled) throw errors[0].error;
    throw new Error(errors.map(e => `${e.profile}: ${e.error.message}`).join('; '));
  }
  // A simulator left running keeps the profile: later commands must still agree with what is booted.
  if (!results.some(r => r.left) && loadState().profile !== undefined) saveState({ profile: null });
  if (!labelled) return results[0];
  const did = results.filter(r => r.did).map(r => `${r.profile}: ${r.did}`).join('; ');
  return { found: results.map(r => `${r.profile}: ${r.found}`).join('; '), did: did || null };
}

// Quit only a window app the lab opened, and only when no simulator at all is booted
// (Device Hub also shows physical iPhones), and never by killing it.
async function windowStep({ before, deviceRun }) {
  if (deviceRun) return { found: 'skipped (device run)' };
  const app = before.windowApp;
  if (!Object.hasOwn(WINDOW_APPS, app)) return { found: 'no window opened by the lab' };
  const bundle = WINDOW_APPS[app];
  if (appRunning(bundle) === false) {
    saveState({ windowApp: null });
    return { found: `${app} already closed` };
  }
  let list;
  try { list = JSON.parse(run('xcrun', ['simctl', 'list', '-j', 'devices']).stdout); } catch (e) {
    throw new Error(`couldn't read the output of \`simctl list\` (${e.message}), so ${app} was left open`);
  }
  const booted = Object.values(list?.devices || {}).flat().filter(d => d.state === 'Booted' || d.state === 'Booting');
  if (booted.length) return { found: `${app}, with ${booted.length} simulator${booted.length > 1 ? 's' : ''} still booted: left open` };
  const r = run('osascript', ['-e', `tell application id "${bundle}" to quit`], { allowFail: true, timeoutMs: 15e3 });
  if (r.code !== 0) throw new Error(`couldn't ask ${app} to quit: ${redactUrl((r.stderr || r.stdout).trim())}`);
  saveState({ windowApp: null });
  return { found: `${app}, opened by the lab`, did: `asked ${app} to quit` };
}

// A safaridriver the lab started for a --device session is stopped even with
// --keep-service, which is about the Appium service only.
async function safaridriverStep({ before, current }) {
  const pid = before.driverPid;
  if (!validPid(pid) || current?.backend === 'appium') return { found: 'none started by the lab' };
  const r = await svc.stopProcess(pid, SAFARIDRIVER);
  if (r.state === 'other' && !current) return { found: 'none started by the lab' }; // maybe a manual Appium: next step
  return pidOutcome('safaridriver', pid, r);
}

async function appiumStep({ flags, current }) {
  if (flags['keep-service']) return { found: 'kept (--keep-service)' };
  const pid = loadState().driverPid;
  if (svc.serviceInstalled()) {
    const u = await svc.unload();
    const problems = [];
    if (!u.disabled) problems.push(`couldn't disable the service (${u.disableError || 'launchctl disable failed'}), so it may start again at the next login: run \`launchctl disable ${svc.serviceTarget()}\``);
    if (!u.stopped) problems.push(`launchd still has the Appium service ${Math.round(svc.WAIT.portFreeMs / 1000)}s after bootout${u.bootoutError ? ` (${u.bootoutError})` : ''}: see \`lab service status\``);
    if (problems.length) throw new Error(problems.join('; '));
    if (validPid(pid) && current?.backend !== 'safaridriver') saveState({ driverPid: null }); // never ours to kill while launchd owns Appium
    return u.wasLoaded ? { found: 'LaunchAgent loaded', did: 'stopped it and disabled it at login (`lab up` starts it again)' } : { found: 'LaunchAgent installed, not loaded' };
  }
  if (!validPid(pid)) return { found: 'no Appium started by the lab' };
  return pidOutcome('Appium', pid, await svc.stopProcess(pid, APPIUM));
}

// --- the physical iPhone (state.phone, validated by phone.readPhone) ---

// A device session is recorded (even a damaged record that names a device counts).
function deviceSession(state) {
  try { return !!readSession(state)?.target?.device; } catch {
    return state.target !== null && typeof state.target === 'object' && state.target.device !== undefined;
  }
}

// The last session `lab up` / `safari start` made was on the phone. Kept after a `lab down` that failed (a clean one
// clears it), when its `wda` step may have left the runner on the phone.
const lastRunOnPhone = state => state.lastTarget === 'device';

// Whether `down` is stopping a phone run, so the simulator and its window are not its business:
// the recorded session is a device one, or none is recorded (`safari stop` ended it) and the last
// session `lab up` / `safari start` made was on the phone (`state.lastTarget`). A simulator
// session, or no record at all, leaves the simulator logic as it was.
function isDeviceRun(state) {
  if (deviceSession(state)) return true;
  let rec = null;
  try { rec = readSession(state); } catch { /* damaged: the last target decides */ }
  return !rec && lastRunOnPhone(state);
}

// What `phoneStatus` found, as output: transport only when the phone answered (the device list
// alone is stale), and a `needs` with steps for anything a person has to fix. No device name.
function phoneReport(s) {
  const out = { found: s.found, reachable: s.reachable, transport: s.reachable ? s.transport : null, via: s.reachable ? s.via ?? null : null, locked: s.locked, developerMode: s.developerMode, pairingState: s.pairingState, osVersion: s.osVersion ?? null, buildVersion: s.buildVersion ?? null };
  let { needs, error } = s;
  if (!needs && s.developerMode === false) { needs = 'developer-mode'; error = 'Developer Mode is off on the phone'; }
  else if (!needs && s.locked) { needs = 'unlock'; error = 'the phone is locked (a passcode is required)'; }
  if (needs) Object.assign(out, { error: redactMessage(error), ...needsError(needs, error ?? needs).extra });
  return out;
}

// What `down` says at the top level about the keyboard settings (the step holds the same).
const keyboardOut = ctx => (ctx.keyboard ? { keyboardRestored: ctx.keyboard.keyboardRestored, ...(ctx.keyboard.keyboardRestored ? {} : { human: [KEYBOARD_HUMAN] }) } : {});

// The phone's Appearance and orientation, which the lab may have changed (phone-restore.js): put back by the
// session step (`safari stop`'s way) or, when a record is left (a crash, or `safari stop` already ran), by this one.
// Only a step when something is waiting; a phone that can't be reached is reported (`phoneRestored: false`, `human`) and
// the record kept for the next `lab up`, `lab down` or `lab phone restore`: never a failure of `down`.
async function phoneSettingsStep(ctx) {
  const waiting = pendingNames(loadState());
  const r = await restorePending();
  const report = restoreReport(r);
  if (report.phoneRestored !== undefined) ctx.phone = { ...report, human: restoreHuman(report.phoneRestore) };
  const put = RESTORE_KINDS.filter(k => r[k]?.restored);
  const left = RESTORE_KINDS.filter(k => r[k]?.ownerChanged);
  const did = [put.length ? `put back ${put.join(' and ')}` : null, left.length ? `left ${left.join(' and ')} (changed by hand)` : null].filter(Boolean).join('; ') || null;
  return { found: `${Array.isArray(waiting) ? waiting.join(' and ') : 'a damaged record'} waiting to be put back`, did, report };
}

// Everything `down` says at the top level about what it put back on the phone: the keyboard and the phone settings.
function restoreOut(ctx) {
  const human = [...(keyboardOut(ctx).human ?? []), ...(ctx.phone?.human ?? []), ...(ctx.slot?.human ?? [])];
  const phone = { ...ctx.phone };
  delete phone.human;
  return { ...keyboardOut(ctx), ...phone, ...(ctx.slot ? { slotReturned: ctx.slot.slotReturned, slot: ctx.slot.slot } : {}), ...(human.length ? { human } : {}) };
}

// A slot borrowed from sideload (slot-lend.js) is given back by the idle stop, by `lab down` when nothing else would, and by
// `lab phone slot return`. The `slot` step runs when a record is there and: it is the idle stop, or the return already started
// (`returning`), or no idle stop is installed and loaded (nothing else would give it back).
function slotDue(ctx) {
  const lent = lendState();
  if (!lent.present) return false;
  if (ctx.idle || lent.damaged) return true; // damaged: the step says so
  if (lent.rec.phase === 'returning') return true;
  const agent = svc.idleStatus();
  return !(agent.installed && agent.loaded);
}

// What a return (slot-lend.js returnSlot) says, as the `slot` object of the JSON: no UDID.
function slotSummary(r) {
  const pick = ['app', 'reinstalled', 'alreadyPresent', 'nothingLent', 'dataRestored', 'dataFilesRestored', 'dataFilesFailed', 'warnings', 'phase', 'code', 'cause', 'needs', 'retryAt', 'skipped', 'aborted'];
  return { returned: r.returned, ...Object.fromEntries(pick.filter(k => r[k] !== undefined).map(k => [k, r[k]])) };
}

// Gives the borrowed slot back (the runner is taken off the phone, then `sideload slot return`). Never a failure of `down`: what could
// not be done is reported (`slotReturned: false`, `human`; the idle stop says it once) and the record is kept.
async function slotDownStep(ctx) {
  const who = ctx.idle ? lease.IDLE_OWNER : ctx.who;
  const r = await returnSlot({ idle: ctx.idle, touch: () => lease.touch({ owner: who }), sessionOpen: deviceSession(loadState()), lastActive: ctx.lastActive });
  const summary = slotSummary(r);
  ctx.slot = { slotReturned: r.returned, slot: summary, human: ctx.idle && !r.fresh ? [] : r.human ?? [] };
  if (r.aborted) ctx.slotAborted = true;
  return slotReturnStep(r);
}

// The step report of a return (returnSlot's answer): what was found and done, and the `slot` summary.
function slotReturnStep(r) {
  const found = `a slot borrowed from sideload${r.app ? ` (${r.app})` : ''}`;
  const { report } = withSlot(slotSummary(r));
  if (r.returned) {
    const did = r.reinstalled ? 'gave it back: took WebDriverAgent off the phone, and sideload put its app back'
      : r.alreadyPresent ? 'cleared the record (sideload\'s app is already on the phone)' : 'cleared the record (sideload has nothing lent)';
    return { found, did, report };
  }
  return { found: `${found}, not given back${r.skipped ? ` (${r.skipped})` : r.code ? ` (${r.code}${r.cause ? `/${r.cause}` : ''})` : ''}`, did: null, report };
}

const PHONE_USAGE = 'usage: lab phone setup --udid <phone UDID> --team <10-character team id> [--bundle-id <id>] [--autocorrection on|off] [--prediction on|off] [--focus on|off] [--focus-on-shortcut <name>] [--focus-off-shortcut <name>] | status | forget | restore [--forget] | focus test|off | slot return|forget';

const phoneHandlers = {
  async setup(argv) {
    const { pos, flags } = parseArgs(argv);
    if (pos.length || Object.keys(flags).some(k => !['udid', 'team', 'bundle-id', 'autocorrection', 'prediction', 'focus', 'focus-on-shortcut', 'focus-off-shortcut'].includes(k))) throw new Error(PHONE_USAGE);
    if (flags.udid === undefined || flags.team === undefined) throw new Error(PHONE_USAGE);
    if (!isUdid(flags.udid)) throw new Error(`--udid "${flags.udid}" is not a device UDID (find it in Xcode > Window > Devices and Simulators, or \`xcrun devicectl list devices\`)`);
    if (!isTeamId(flags.team)) throw new Error(`--team "${flags.team}" is not a team id (10 capital letters or digits; Xcode > Settings > Accounts shows it)`);
    const bundleId = flags['bundle-id'] ?? defaultBundleId(flags.team);
    if (!isBundleId(bundleId)) throw new Error(`--bundle-id "${bundleId}" is not a bundle id (letters, digits, dots and hyphens, with at least one dot)`);

    const asked = {};
    for (const k of ['autocorrection', 'prediction']) if (flags[k] !== undefined) asked[k] = parseOnOff(k, flags[k]);
    // Lab Focus (issue 16): on by default for device runs; the shortcut names are the owner's, checked here and URL-encoded when run.
    const focusAsked = {};
    if (flags.focus !== undefined) focusAsked.enabled = parseOnOff('focus', flags.focus);
    for (const [flag, key] of [['focus-on-shortcut', 'onShortcut'], ['focus-off-shortcut', 'offShortcut']]) {
      if (flags[flag] === undefined) continue;
      if (!isShortcutName(flags[flag])) throw new Error(`--${flag} "${flags[flag]}" is not a shortcut name (letters, digits, space, dot, hyphen and underscore, up to 60, no space at either end)`);
      focusAsked[key] = flags[flag];
    }

    if (deviceSession(loadState())) throw new Error('a device session is open: run `safari stop` first (or `lab down`), then `lab phone setup`');
    // A slot borrowed from sideload belongs to the phone it was lent for: saving another one would leave it with no way back.
    const lent = readLend(loadState());
    if (lent && lent.udid !== flags.udid) throw new Error(`a slot borrowed from sideload for the saved phone has not been given back: run \`${RETURN_SLOT}\` first (or \`${FORGET_SLOT}\` after returning it by hand), then \`lab phone setup\``);

    const status = phoneStatus(flags.udid);
    if (!status.found) throw needsError(status.needs ?? 'cable', status.error ?? 'the phone is not in `devicectl list devices`');

    let old = null;
    try { old = readPhone(loadState()); } catch { /* a damaged record is replaced */ }
    // The signing expiry belongs to one phone, team and bundle id.
    const same = old && old.udid === flags.udid && old.teamId === flags.team && old.bundleId === bundleId;
    // The keyboard settings restored at the end of a session: a flag that is left out keeps the saved value, else on.
    let phone = { ...(old ?? {}), udid: flags.udid, teamId: flags.team, bundleId, keyboard: { ...keyboardTarget({ phone: old }), ...asked } };
    if (Object.keys(focusAsked).length) phone.focus = { ...(old?.focus ?? {}), ...focusAsked }; // a flag that is left out keeps the saved value
    if (!same) { delete phone.wdaExpires; delete phone.seen; } // both belong to one phone
    phone = withSeen(phone, status);
    saveState({ phone });
    return { saved: true, phone, status: phoneReport(status) };
  },

  // Read-only: what the Mac can see of the saved phone, and the signing expiry.
  async status(argv) {
    if (argv.length) throw new Error(PHONE_USAGE);
    const phone = readPhone(loadState());
    if (!phone) throw needsError('setup', 'no phone is saved');
    const expires = profileExpiry() ?? phone.wdaExpires ?? null;
    return { phone: { ...phone, keyboard: keyboardTarget({ phone }), focus: focusConfig(phone) }, ...phoneReport(withRoute(phoneStatus(phone.udid), phone)), wdaExpires: expires, wdaHoursLeft: hoursLeft(expires) };
  },

  async forget(argv) {
    if (argv.length) throw new Error(PHONE_USAGE);
    const state = loadState();
    if (state.phone === undefined || state.phone === null) return { forgot: false, found: 'no phone saved' };
    if (deviceSession(state)) throw new Error('a device session is open on the saved phone: run `safari stop` first (or `lab down`), then `lab phone forget`');
    if (readLend(state)) throw new Error(`a slot borrowed from sideload has not been given back, and the lab needs the saved phone to do it: run \`${RETURN_SLOT}\` first (or \`${FORGET_SLOT}\` after returning it by hand), then \`lab phone forget\``);
    saveState({ phone: null });
    const waiting = pendingNames(state);
    const left = Array.isArray(waiting) && waiting.length ? { pendingRestore: waiting, human: [`The lab had changed the phone's ${waiting.join(' and ')} and had not put it back. Check it on the phone by hand, then run \`lab phone restore --forget\`.`] } : {};
    return { forgot: true, found: 'phone record removed', ...left };
  },

  // focus test|off: the owner's setup check for Lab Focus (issue 16). `test` runs the On shortcut the way `lab up` does (lock-checked, the
  // ledger entry first, so a stop, `lab down` or `lab phone restore` turns it off too) and says what to look for; `off` runs the Off
  // shortcut (lock-checked) and clears the focus entry. Checks the lease like `restore`. Phone only: a recorded simulator session
  // is refused, and so is an open device session (the Shortcuts app would cover the lab's tab; `safari stop` ends the Focus then).
  async focus(argv) {
    const [word, ...extra] = argv;
    if (!['test', 'off'].includes(word) || extra.length) throw new Error(PHONE_USAGE);
    await lease.check();
    const state = loadState();
    const phone = readPhone(state);
    if (!phone) throw needsError('setup', 'no phone is saved, so there is no Lab Focus to run');
    if (simulatorSession(state)) throw new Error(`lab phone focus ${word} runs a shortcut on the iPhone, but a simulator session is open: Lab Focus is not supported on the simulator`);
    if (deviceSession(state)) throw new Error(`a device session is open: run \`safari stop\` first (or \`lab down\`), then \`lab phone focus ${word}\` (the Shortcuts app would cover the lab's tab)`);
    const cfg = focusConfig(phone);
    if (word === 'test') {
      await changeFocus(phone); // lock-checked; the entry is written first; a failure is a needs error
      return {
        focus: { applied: true, shortcut: cfg.onShortcut, verified: false },
        human: [
          'Look at the top of the phone (status bar or Control Center > Focus): the Lab Focus icon should be showing. The lab can start the shortcut but not see the Focus change.',
          'Then run `lab phone focus off` to turn it off again (`lab down`, `safari stop` and `lab phone restore` do it too).',
        ],
        then: 'lab phone focus off',
      };
    }
    if (pendingFocus(state)) {
      const r = await restorePending({ only: 'focus' });
      const out = restoreReport(r);
      const focus = { applied: r.restored === true, shortcut: cfg.offShortcut, verified: false };
      return r.restored ? { focus, ...out } : { ok: false, error: 'Lab Focus was not turned off; the record is kept', focus, ...out };
    }
    // Nothing recorded (a test that was already turned off, or a Focus turned on by hand): run Off anyway.
    const sent = setFocus(phone.udid, 'off', phone);
    if (!sent.ok) throw needsError(sent.needs ?? 'unknown', `could not run ${cfg.offShortcut}: ${sent.error}`);
    return { focus: { applied: true, shortcut: cfg.offShortcut, verified: false }, found: 'no Lab Focus was recorded as on; ran the Off shortcut anyway' };
  },

  // slot return | forget: the slot the lab borrowed from sideload (slot-lend.js, issue 63). `return` gives it back now (the runner comes off the
  // phone, then `sideload slot return`); a retry time or an earlier failure does not hold it back. `forget` drops the record without touching
  // the phone or sideload (a person returned it by hand). Both check the lease, like `restore`; a device session is refused.
  async slot(argv) {
    const [word, ...extra] = argv;
    if (!['return', 'forget'].includes(word) || extra.length) throw new Error(PHONE_USAGE);
    await lease.check();
    const state = loadState();
    if (word === 'forget') {
      const r = forgetLend();
      return r.forgot
        ? { ...r, human: [`The lab no longer remembers that it borrowed a slot from sideload${r.app ? ` (${r.app}'s)` : ''}. Check \`sideload status\` and, if a slot is still lent, return it with \`sideload slot return --device <alias>\`.`] }
        : { ...r, found: 'no borrowed slot recorded' };
    }
    if (deviceSession(state)) throw new Error('a device session is open: run `safari stop` first (or `lab down`), then `lab phone slot return` (the runner it uses would come off the phone)');
    const r = await returnSlot({ manual: true, touch: () => lease.touch() });
    if (!r.pending) return { pending: false, found: 'no borrowed slot recorded' };
    const slot = slotSummary(r);
    if (r.returned) return { slotReturned: true, slot };
    return { ok: false, error: `the slot borrowed from sideload was not given back: ${r.error ?? r.skipped ?? r.code}`, slotReturned: false, slot, ...(r.needs ? { needs: r.needs } : {}), human: r.human ?? [] };
  },

  // restore [--forget]: puts back the Appearance and orientation the lab changed (phone-restore.js) and clears the
  // record once the phone reads back the old values. Checks the lease (it takes none). --forget drops
  // the record without touching the phone (a phone that is gone, a damaged record).
  async restore(argv) {
    const { pos, flags } = parseArgs(argv, ['forget']);
    if (pos.length || Object.keys(flags).some(k => k !== 'forget')) throw new Error(PHONE_USAGE);
    await lease.check(); // another owner's live lease refuses it, like the other commands that touch the phone's session
    if (flags.forget) {
      const r = forgetRestore();
      return r.forgot
        ? { ...r, human: [`The lab no longer remembers the settings it changed. Check ${CHECK_BY_HAND} on the phone by hand.`] }
        : { ...r, found: 'nothing waiting to be put back' };
    }
    const r = await restorePending();
    if (!r.pending) return { pending: false, phoneRestored: true, found: 'nothing waiting to be put back' };
    const out = restoreReport(r);
    return r.restored ? out : { ok: false, error: 'the phone\'s settings were not all put back; the record is kept', ...out };
  },
};

// --- up on the phone ---

const STATUS_USAGE = 'usage: lab status [--check-update]';
const SERVICE_USAGE = 'usage: lab service install [--replace] [--log-level info|debug] [--no-idle-stop] | uninstall | status';
const TUNNEL_USAGE = 'usage: lab tunnel up | down | status';

// The tunnel record, the agent that runs its host, and whether remotexpc's registry is where the host imports it from.
const tunnelBlock = () => ({ ...tunnelReport(), agent: svc.tunnelAgentStatus(), registry: { path: registryModule(), present: fs.existsSync(registryModule()) } });
// `lab tunnel status` adds whether the route works: `reaches` true or false (`reachesWhy` says what failed), or null when the
// tunnel is not up with a live host, in which case nothing is probed. WebDriverAgent is asked only when a session recorded
// that it runs over the tunnel. `lab status` stays record-only (it makes no device calls).
async function tunnelReach(block) {
  if (block.state !== 'up' || block.alive !== true) return { ...block, reaches: null };
  const r = await routeStatus({ wda: loadState().transport?.via === 'tunnel' });
  return { ...block, reaches: r.ok, ...(r.ok ? {} : { reachesWhy: r.why }) };
}
// The phone settings `lab up` can set (--appearance, --orientation): one flag per kind in the restore ledger's table.
const DISPLAY_FLAGS = COMMAND_KINDS.map(k => `--${k}`).join(' and ');
const UP_USAGE = `usage: lab up [--target auto|device|simulator] [--profile clean|configured] [--resign] [--url <http(s) URL>] ${COMMAND_KINDS.map(k => `[--${k} ${settingUsage(k)}]`).join(' ')} [--no-focus] [--allow-host <host>]... [--force]`;

// A `then` that is a `lab up` gets the flags this run was given, so running it as told starts the same session (issue 106).
// Its own --target and --resign stay (every `lab up` in NEEDS names a --target). Never --force: taking the lease
// is the person's call. A device `then` leaves off --profile (it picks a simulator); a simulator one leaves off the
// phone-only flags (`up` refuses --appearance and --orientation with it, and the rest do nothing there).
function thenWithFlags(then, flags, allowHosts) {
  if (typeof then !== 'string' || !/^lab up(?: |$)/.test(then)) return then;
  const own = then.split(' ');
  const at = own.indexOf('--target');
  const target = at >= 0 ? own[at + 1] : undefined;
  const add = [];
  const flag = (name, value) => add.push(value === true ? `--${name}` : `--${name} ${quote(value)}`);
  if (target !== 'simulator') for (const h of allowHosts) flag('allow-host', h);
  if (flags.url !== undefined) flag('url', flags.url);
  if (flags.profile !== undefined && target !== 'device') flag('profile', flags.profile);
  if (target !== 'simulator') {
    for (const k of COMMAND_KINDS) if (flags[k] !== undefined) flag(k, flags[k]);
    if (flags['no-focus']) flag('no-focus', true);
  }
  return [...own, ...add].join(' ');
}

const recordedSession = () => { try { return readSession(loadState()); } catch { return null; } };

// Whether a recorded Appium session still answers. Only the list of context ids is asked for: a
// simulator session also needs Safari's page in it; a device session is never switched into a page.
// A device session made on a Wi-Fi tunnel that is gone is dead without asking (a 10 s wait for nothing, issue 62).
async function sessionAlive(cur) {
  if (!cur || cur.backend !== 'appium') return false;
  if (cur.target.device !== undefined && (await sessionRouteGone(loadState().transport, { wda: true })).gone) return false;
  try {
    const list = await wd(backendUrl('appium', cur.port), 'GET', `/session/${cur.session}/contexts`, undefined, SAFARI_WAIT.callMs);
    if (cur.target.device !== undefined) return Array.isArray(list);
    return (Array.isArray(list) ? list : []).some(c => String(c?.id ?? c).startsWith('WEBVIEW_'));
  } catch { return false; }
}

const conflict = cur => new Error(`a session is already open on ${JSON.stringify(cur.target)}: run \`safari stop\` first`);

// The only delete `up` does: the WDA build under the Appium home, so xcodebuild builds and signs
// it again. The home must be an absolute, normalised path; it is resolved with realpath (the home
// itself may be a link), then `wda-device`, `Build` and `Products` under it are each checked with
// lstat and must be plain folders: a symlink at any level is refused, never followed. The resolved
// path must equal <real home>/wda-device/Build/Products. Returns whether something was deleted.
function deleteWdaBuild() {
  const home = appiumHome();
  if (!path.isAbsolute(home) || home.split(path.sep).includes('..') || path.normalize(home).replace(/\/+$/, '') !== home.replace(/\/+$/, '')) {
    throw new Error(`refusing to delete under ${home}: the Appium home is not an absolute, normalised path`);
  }
  let root;
  try { root = fs.realpathSync(home); } catch { return false; } // no Appium home, nothing to delete
  const parts = ['wda-device', 'Build', 'Products'];
  let p = root;
  for (const part of parts) {
    p = path.join(p, part);
    let st;
    try { st = fs.lstatSync(p); } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    if (!st.isDirectory()) throw new Error(`refusing to delete ${p}: it is not a plain folder (symlinks are never followed)`);
  }
  if (fs.realpathSync(p) !== path.join(root, ...parts)) throw new Error(`refusing to delete ${p}: it does not resolve to the WebDriverAgent build folder under the Appium home`);
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

const HOLD_USAGE = `usage: lab hold [--minutes N]  (N is a whole number from 1 to ${lease.HOLD_MAX_MIN}, default 60)`;
const HOLD_DEFAULT_MIN = 60;

// A `lab up` that failed after it turned Lab Focus on: turn it off again (lock-checked: a locked phone keeps the entry).
// Returns the fields for the failed JSON (`phoneRestored`, `phoneRestore`, and `human` when it is still on); never throws.
// Not when the session is open (the failure came after it was created): the Shortcuts app would cover the lab's tab, and
// `safari stop` (or `lab down`) turns it off with the rest; the failed JSON then says so.
async function focusOffAfterFailure() {
  const state = loadState();
  if (state.session != null) {
    return pendingFocus(state) ? { human: ['Lab Focus is still on, and the session is still open: `safari stop` (or `lab down`) turns it off.'] } : {};
  }
  try {
    const r = await restorePending({ only: 'focus' });
    if (!r.pending) return {};
    const report = restoreReport(r);
    const human = report.phoneRestored ? [] : ['`lab up` failed after it turned Lab Focus on, and the phone could not be reached to turn it off: Lab Focus is still on.', ...restoreHuman(r)];
    return { phoneRestored: report.phoneRestored, phoneRestore: report.phoneRestore, ...(report.restoredExactly === false ? { restoredExactly: false } : {}), ...(human.length ? { human } : {}) };
  } catch (e) {
    return { phoneRestored: false, human: [`\`lab up\` failed after it turned Lab Focus on and turning it off failed (${redactMessage(e.message, 160)}): Lab Focus may still be on. Run \`lab phone restore\` when the phone is unlocked.`] };
  }
}

const DOWN_USAGE = 'usage: lab down [--force] [--keep-service] | lab down --idle';

// The steps of `lab down`. With `idle` (the idle stop) the lease is the idle stop's, taken by
// idleDown and handed back by it, and each step first renews it: if that fails, someone took the
// lease over (`lab up --force`), and the rest does not run. A simulator is shut down only if the
// lab booted it, and the keyboard note stays pending (nobody is there to read it).
async function runDown(flags, { idle = false, lastActive = null } = {}) {
  const steps = [];
  const step = stepper(steps);
  const failed = [];
  let aborted = null; // idle: why it stopped early
  // After a signal no further step runs (the failure names the interrupt, and the lease is kept). A signal that came
  // during a synchronous child (simctl shutdown, launchctl) is handled one macrotask later, so it is waited for first.
  const soft = async (name, fn) => {
    await afterPendingSignals();
    if (interrupted() || aborted) return;
    if (idle && !await lease.touch({ owner: lease.IDLE_OWNER })) {
      aborted = 'someone took the lab over while the idle stop ran (the steps after that did not run)';
      return;
    }
    try { await step(name, fn); } catch (e) { failed.push(e); }
  };
  let who = lease.IDLE_OWNER;
  if (!idle) {
    try {
      await step('lease', async () => {
        who = lease.owner();
        return lease.check({ force: !!flags.force, owner: who });
      });
    } catch (e) {
      return { ok: false, error: errorText(e), failedStep: 'lease', steps, ...e.extra };
    }
  }

  const before = loadState();
  const ctx = { before, devices: labDevices(before), flags, current: null, deviceRun: isDeviceRun(before), keyboard: null, idle, who, lastActive, slot: null, slotAborted: false };
  await soft('session', () => sessionStep(ctx));
  // A record left behind (a crash, `safari stop` that could not reach the phone): no session is needed, devicectl does it.
  // Not tried again when the session step just tried.
  if (!ctx.phone && loadState().phoneRestore != null) await soft('phone-settings', () => phoneSettingsStep(ctx));
  await soft('wda', () => wdaStep(ctx));
  // After the WebDriverAgent step: its xcodebuild is stopped, so the runner can come off the phone.
  if (slotDue(ctx)) {
    await soft('slot', () => slotDownStep(ctx));
    if (ctx.slotAborted) aborted = 'someone took the lab over while the idle stop ran (the steps after that did not run)';
  }
  await soft('tunnel', stopTunnel); // always stopped, also with --keep-service
  await soft('simulator', () => simulatorStep(ctx));
  await soft('window', () => windowStep(ctx));
  if (!failed.length && !aborted && before.lastTarget !== undefined) saveState({ lastTarget: null }); // a retry after a failure still knows
  await soft('safaridriver', () => safaridriverStep(ctx));
  await soft('appium', () => appiumStep(ctx));

  await afterPendingSignals();
  const sig = interrupted();
  if (failed.length || sig || aborted) {
    const cut = failed.find(e => e instanceof InterruptError);
    // A signal between steps fails nothing, but the steps after it did not run: the lease is kept all the same.
    const why = [...failed.map(e => `${e.failedStep}: ${errorText(e)}`), ...(sig && !cut ? [`interrupted by ${sig}; the steps after it did not run`] : []), ...(aborted ? [aborted] : [])];
    return {
      ok: false,
      error: idle ? why.join('; ') : `${why.join('; ')}; the lease is kept, run \`lab down\` again`,
      failedStep: failed[0]?.failedStep ?? null,
      owner: who,
      steps,
      ...cut?.extra,
      ...restoreOut(ctx),
    };
  }
  lease.clearHold(); // the lab is stopped: a `lab hold` no longer applies
  if (idle) return { owner: who, steps, ...restoreOut(ctx) };
  try {
    await step('release', async () => {
      const r = await lease.release({ force: !!flags.force, owner: who });
      return r.released ? { found: r.was ? `lease of ${r.was}` : 'lease held', did: 'released' } : { found: 'no lease' };
    });
  } catch (e) {
    return { ok: false, error: errorText(e), failedStep: 'release', owner: who, steps, ...e.extra };
  }
  // A finished down has told the person to set the keyboard by hand: say it once, not on every later down.
  if (ctx.keyboard?.keyboardRestored === false) saveState({ keyboardPending: null });
  return { owner: who, steps, ...restoreOut(ctx) };
}

// --- the idle stop ---

// Idle means no live lease and no lease command for this long (the default, or MSL_IDLE_MINUTES).
export const IDLE_DEFAULT_MIN = 15;
// A stop that failed this many times in a row waits for new activity before it tries again.
export const IDLE_MAX_FAILURES = 3;

export function idleMinutes(env = process.env) {
  const raw = env.MSL_IDLE_MINUTES;
  if (raw === undefined || raw === '') return IDLE_DEFAULT_MIN;
  const m = Number(raw);
  if (!Number.isInteger(m) || m < 1 || m > 1440) throw new Error('MSL_IDLE_MINUTES must be a whole number of minutes from 1 to 1440');
  return m;
}

// The last idle stop's record (state.idleStop), or null when it isn't one.
function idleRecord(state = loadState()) {
  const r = state.idleStop;
  const ok = r && typeof r === 'object' && !Array.isArray(r) && Number.isFinite(Date.parse(r.at)) && Number.isInteger(r.failures) && r.failures >= 0;
  return ok ? r : null;
}

// Whether a readable lend record is there (a damaged one is not something the idle stop can act on: `lab status` shows it).
const hasLend = state => !!lendState(state).rec;

const pendingFocus = state => { const n = pendingNames(state); return Array.isArray(n) && n.includes('focus'); };

// What of the lab's is still running, as phrases; empty when there is nothing for the idle stop to
// stop. Cheap: the state file, one `launchctl print`, and (only for a recorded `simBoot`) one
// simctl list. A recorded `simBoot` whose simulator is down is cleared here.
function stillRunning(before, { retryRestore = true, slotWait } = {}) {
  const found = [];
  // A slot borrowed from sideload, waiting to go back: `slotWait` (the idle stop's) holds it back while sideload asked for a later
  // retry or the owner has to act and no lab command has run since; without it (`lab hold`) any readable record counts.
  if (slotWait ? wantsReturn(before, slotWait) : hasLend(before)) found.push(SLOT_PHRASE);
  // Lab Focus still on after a stop that could not reach the phone: the idle stop tries the (lock-checked) restore.
  if (retryRestore && pendingFocus(before)) found.push('Lab Focus is waiting to be turned off');
  if (svc.serviceInstalled() && svc.launchdState().loaded) found.push('the Appium LaunchAgent is loaded');
  if (before.session !== undefined) found.push('a session is recorded');
  if (validPid(before.driverPid)) found.push('an Appium started by the lab');
  if (tunnelRunning()) found.push('the tunnel is up');
  if (lastRunOnPhone(before)) found.push('the last run was on the phone and its stop did not finish');
  if (labDevices(before).some(d => d.udid === before.simBoot)) {
    const state = simState(before.simBoot);
    if (state === 'Booted' || state === 'Booting') found.push('the simulator, booted by the lab');
    else saveState({ simBoot: null });
  }
  return found;
}

// When the idle stop will stop the lab at the earliest, from what `lab status` has already read:
// { earliest (local time or null), note }. The agent only looks every intervalSeconds, so a stop
// lands up to that much later.
function nextStop({ idleStop, at, held, lease: l, t, running, state }) {
  const no = note => ({ earliest: null, note });
  if (!idleStop.installed || !idleStop.loaded) return no('the idle stop is not installed and loaded, so nothing stops the lab by itself');
  if (idleStop.thresholdMinutes === null) return no("the idle stop's threshold is invalid, so every run fails");
  if (!running) return no('nothing the lab started is running');
  const rec = idleRecord(state);
  if (rec && rec.failures >= IDLE_MAX_FAILURES && at !== null && at <= Date.parse(rec.at)) return no(`the last ${rec.failures} idle stops failed: it waits for the next lab command before trying again`);
  if (at === null) return no('no record of the last command: the idle clock starts at the idle stop\'s next look');
  const live = l && !l.corrupt && Date.parse(l.expires) > t ? Date.parse(l.expires) : 0;
  const earliest = Math.max(at + idleStop.thresholdMinutes * 60e3, held ?? 0, live);
  return { earliest: lease.localIso(earliest), note: `the idle stop looks every ${idleStop.intervalSeconds} s, so the stop lands up to that much later${held !== null ? '; a `lab hold` is in force' : ''}${live ? '; a lease is live' : ''}` };
}

const releaseIdle = async () => {
  try {
    await duringCleanup(() => lease.release({ owner: lease.IDLE_OWNER }));
  } catch (e) {
    if (e.extra?.lease) return; // someone else holds a live lease now (`lab up --force`): not ours to release
    console.error(maskDevices(`[idle] couldn't release the idle stop's lease: ${e.message}`));
  }
};

// lab down --idle: stops the lab if it has sat idle (see lease.acquireIdle). Prints one JSON
// object: { idle: false, reason } when it did nothing, else the result of the stop. Run by the
// idle stop's LaunchAgent every five minutes; it writes one line to stderr (the agent's log)
// only when it acts or fails.
async function idleDown() {
  const minutes = idleMinutes();
  const thresholdMs = minutes * 60e3;
  const no = reason => ({ idle: false, reason });

  const look = await lease.idleState({ thresholdMs });
  if (!look.idle) return no(look.reason);
  const before = loadState();
  const last = idleRecord(before);
  const failures = last && look.lastActive <= Date.parse(last.at) ? last.failures : 0; // new activity starts the count over
  if (failures >= IDLE_MAX_FAILURES) return no(`the last ${failures} idle stops failed: waiting for the next lab command before trying again (see \`lab status\`)`);
  // A restore the last idle stop could not do (locked phone) is not tried again until a lab command has run.
  const retryRestore = !(last?.phoneRestored === false && look.lastActive <= Date.parse(last.at));
  const running = stillRunning(before, { retryRestore, slotWait: { lastActive: look.lastActive } });
  if (!running.length) return no('nothing the lab started is running');

  const got = await lease.acquireIdle({ thresholdMs }); // the check again, and the take, in one step
  if (!got.idle) return no(got.reason);
  let out, record;
  try {
    out = await runDown({}, { idle: true, lastActive: look.lastActive });
    // Saved before the lease is handed back: a `lab up` that takes the lease next writes the state too, and the
    // state file is read, merged and written without a lock.
    record = idleRecordFor(out, { minutes, failures });
    saveState({ idleStop: record });
  } finally {
    await releaseIdle();
  }
  const did = out.steps.filter(s => s.did).map(s => `${s.step}: ${s.did}`).join('; ') || 'nothing to stop';
  // A slot that still cannot go back, with nothing else to stop and nothing new to say, is not logged again every five minutes.
  const quiet = running.every(p => p === SLOT_PHRASE) && out.ok !== false && !out.steps.some(s => s.did) && !out.human?.length;
  const slotNote = out.slot && !out.slot.returned && out.slot.code ? `; the slot borrowed from sideload is not back yet (${out.slot.code}${out.slot.cause ? `/${out.slot.cause}` : ''})` : '';
  if (!quiet) console.error(maskDevices(redactUrl(`[idle] ${out.ok === false ? `failed after ${minutes} min idle: ${out.error}` : `stopped the lab after ${minutes} min idle`} (${did})${record.tabLeft ? `; the lab's tab is still open on the phone (${record.tabLeft})` : ''}${slotNote}`)));
  return { idle: true, idleMin: minutes, running, ...out };
}

// What the state keeps of one idle stop (`lab status` shows it as idleStop.last).
function idleRecordFor(out, { minutes, failures }) {
  const session = out.steps.find(s => s.step === 'session');
  const sig = interrupted();
  return {
    at: new Date().toISOString(),
    idleMin: minutes,
    ok: out.ok !== false,
    steps: out.steps.map(s => ({ step: s.step, found: s.found, did: s.did, ...(s.error ? { error: s.error } : {}) })),
    ...(session?.tabLeft ? { tabLeft: session.tabLeft } : {}),
    ...(session?.human ? { human: session.human } : {}),
    ...(out.keyboardRestored === false ? { keyboardRestored: false } : {}),
    ...(out.phoneRestored === false ? { phoneRestored: false } : {}),
    ...(out.slot ? { slot: out.slot } : {}), // a slot that could not go back is not a failure of the stop (it is not counted below)
    failures: out.ok === false && !sig ? failures + 1 : 0,
    ...(out.ok === false ? { error: out.error } : {}),
  };
}

export const handlers = {
  // up [--target auto|device|simulator] [--profile clean|configured] [--resign] [--url <http(s)>] [--force]
  async up(argv) {
    const { flags } = parseArgs(argv, ['force', 'resign', 'no-focus'], ['allow-host']);
    const unknown = Object.keys(flags).find(k => ![...['target', 'profile', 'resign', 'url', 'force', 'no-focus', 'allow-host'], ...COMMAND_KINDS].includes(k));
    if (unknown || (flags.url !== undefined && !httpUrl(flags.url))) throw new Error(UP_USAGE);
    for (const k of COMMAND_KINDS) if (flags[k] !== undefined && !settingWords(k).includes(flags[k])) throw new Error(UP_USAGE);
    const display = COMMAND_KINDS.some(k => flags[k] !== undefined);
    if (display && flags.target === 'simulator') throw new Error(`${DISPLAY_FLAGS} change the iPhone: they can't go with --target simulator (the simulator is not supported for them; \`sim appearance\` sets its appearance)`);
    const allowHosts = parseAllowHosts(flags['allow-host']); // before the lease or anything else
    if (flags.profile !== undefined) checkProfile(flags.profile);
    if (flags.target !== undefined && !TARGETS.includes(flags.target)) throw new Error(`--target must be one of ${TARGETS.join(', ')} (got "${flags.target}")`);
    if (flags.profile !== undefined && flags.target === 'device') throw new Error('--profile picks a simulator: it can\'t go with --target device');
    if (flags.resign && flags.target === 'simulator') throw new Error('--resign re-signs the phone\'s WebDriverAgent: it can\'t go with --target simulator');
    const mode = flags.target ?? 'auto';
    // A phone step runs when the phone was asked for, or when auto has a saved phone to consider.
    const phoneStepRuns = mode === 'device' || (mode === 'auto' && loadState().phone != null);
    if (flags.resign && !phoneStepRuns) throw new Error('--resign re-signs the saved phone\'s WebDriverAgent: it needs a saved phone and a target other than simulator (see `lab phone setup`)');
    const steps = [];
    const step = stepper(steps);
    let version; // asked once the lease is ours: a refused `up` runs no command at all
    let focusTried = false; // the Lab Focus shortcut was started this run (so a failure after it must turn it off again)
    let lockChecked = false; // the early look at the signing lock ran (it runs once per `up`)
    // The early look at the signing lock (issue 63), for a phone session that will be created: busy stops `up` here, before Appium,
    // the tunnel, the phone settings and Lab Focus have done anything. A skipped lock (no sideload folder, MSL_SIGNLOCK=off)
    // records no step. A free lock is let go at once; the real take at the session step stays and decides.
    const checkSignLock = async () => {
      lockChecked = true;
      const t = Date.now();
      const note = rest => steps.push({ step: 'signing lock', did: null, ...rest, ms: Date.now() - t });
      let r;
      try { r = await probeSignLock(); } catch (thrown) {
        const e = asError(thrown);
        note({ found: null, error: errorText(e) });
        e.failedStep = 'signing lock';
        throw e;
      }
      if (r.skipped) return;
      if (r.busy) {
        note({ found: 'held by sideload', error: errorText(r.error) });
        r.error.failedStep = 'signing lock';
        throw r.error;
      }
      note({ found: 'free' });
    };
    try {
      let who;
      const taken = await step('lease', async () => {
        who = lease.owner();
        const r = await lease.acquire({ force: !!flags.force, owner: who });
        return { ...r, did: r.action === 'renewed' ? null : r.action };
      });
      const touch = () => lease.touch({ owner: who });
      version = labVersion();

      await step('prerequisites', async () => {
        // The simulator is only required when it may be the target; with a phone saved, `auto` may not need it.
        let sim = null;
        try { sim = simUdid(flags.profile ?? (simulatorSession(loadState()) ? undefined : 'clean')); } catch (e) { if (mode === 'simulator' || !phoneStepRuns) throw e; }
        const { override } = appiumEndpoint();
        if (!override && !svc.serviceInstalled() && !fs.existsSync(appiumBin())) throw new Error(INSTALL_HINT);
        const appium = override ? 'Appium at MSL_APPIUM_URL' : svc.serviceInstalled() ? 'Appium service installed' : 'Appium installed';
        return { found: `${mode === 'device' || !sim ? '' : `simulator ${sim}; `}${appium}` };
      });

      // --target device with no session on record can only create a new one: look at the signing lock before Appium starts.
      // Otherwise (auto, or a record that may still be live) the look comes after the phone step, which knows the target.
      if (mode === 'device' && !recordedSession()) await checkSignLock();

      await step('appium', () => ensureAppium(appiumEndpoint()));
      await touch();

      // phone: which target, and for the phone the checks and the signing. No step when there is
      // no phone to consider.
      let target = 'simulator';
      // A profile is a simulator's: never dropped quietly when auto picks the phone (--target device was refused above).
      // Checked as soon as the target is known, before the phone step can delete the WebDriverAgent build.
      const phoneWithProfile = () => {
        if (flags.profile !== undefined) throw new Error(`--profile ${flags.profile} picks a simulator, but --target auto chose the phone. Add --target simulator, or leave --profile out`);
      };
      const phoneOut = {};
      let liveDevice = false; // a working phone session was found: whatever the lab changed on the phone is in use, not left over
      let signing = false; // the WebDriverAgent is built and signed again with this session
      let expiryBefore = null; // the signing expiry before this session
      if (phoneStepRuns) {
        await step('phone', async () => {
          let rec = readPhone(loadState());
          if (!rec) throw needsError('setup', 'no phone is saved, so --target device has nothing to drive');
          const cur = recordedSession();
          if (cur && await sessionAlive(cur)) {
            // A working session decides: the phone is not asked (it may be unreachable now, and a
            // simulator run must not break because of that).
            if (cur.target.device === undefined) {
              if (mode === 'device') throw conflict(cur);
              return { found: 'live simulator session', did: 'kept it (the phone was not asked)' };
            }
            if (cur.target.device !== rec.udid) throw conflict(cur);
            if (flags.resign) throw new Error('a device session is open: the WebDriverAgent can\'t be re-signed under it. Run `safari stop` first, then `lab up --resign`');
            phoneWithProfile();
            target = 'device';
            liveDevice = true;
            // The session answers even while the phone is locked, but its pages will not: one bounded
            // lock check (a failed check does not fail a session that works).
            const lock = lockState(rec.udid);
            if (lock.ok && lock.locked) throw needsError('unlock', 'the phone is locked (a passcode is required); the live session is kept and works again once the phone is unlocked');
            return { found: 'live session on the phone', did: 'kept it (the phone is unlocked)' };
          }

          const status = withRoute(await checkPhone(rec.udid), rec); // CoreDevice stuck: one CoreDeviceService restart and one more look; a phone last reached over Wi-Fi that is gone needs `tunnel`, not `cable`
          if (status.osVersion) { rec = withSeen(rec, status); saveState({ phone: rec }); } // cached even when the phone is refused below
          if (status.coreDeviceRestarted) Object.assign(phoneOut, { coreDeviceRestarted: true });
          const chosen = chooseTarget({ flag: mode, phone: rec, status }); // throws a `needs` error when the phone can't be used
          if (chosen.target === 'device') phoneWithProfile();
          target = chosen.target;
          svc.requireRedactedService();

          const known = profileExpiry() ?? rec.wdaExpires ?? null;
          expiryBefore = known;
          let did = null;
          if (needsResign({ wdaExpires: known }, Date.now(), !!flags.resign)) {
            signing = true;
            did = deleteWdaBuild()
              ? `deleted the old WebDriverAgent build (${flags.resign ? '--resign' : known ? 'under 24 h left' : 'expiry unknown'}): Xcode signs it again with the session`
              : 'no WebDriverAgent build yet: Xcode signs one with the session';
          } else if (known !== rec.wdaExpires) {
            saveState({ phone: { ...rec, wdaExpires: known } });
          }
          Object.assign(phoneOut, { transport: status.transport, via: status.via ?? 'usbmux', locked: status.locked, developerMode: status.developerMode, osVersion: status.osVersion, buildVersion: status.buildVersion, resigned: signing });
          const devMode = status.developerMode === false ? 'off' : status.developerMode ? 'on' : 'unknown';
          const restarted = status.coreDeviceRestarted ? RESTARTED : null;
          return { found: `iPhone over ${status.transport}, ${status.locked ? 'locked' : 'unlocked'}, Developer Mode ${devMode}; ${signing ? 'signing to be renewed' : `signing valid for ${hoursLeft(known)} h`}`, did: [restarted, did].filter(Boolean).join('; ') || null, ...(restarted ? { report: { coreDeviceRestarted: true } } : {}) };
        });
        await touch();
      }

      // --appearance and --orientation change the iPhone only; refused before the simulator is touched.
      if (display && target !== 'device') {
        throw new Error(`${DISPLAY_FLAGS} change the iPhone, but this run is on the simulator (no phone is saved, or --target simulator): they are not supported there`);
      }

      // A simulator run gives a slot borrowed from sideload back when nothing else would (the idle stop is not installed and loaded, or the
      // return had started). A phone run keeps a held lend instead (returning and borrowing again is two round trips for sideload's app).
      // Never a failure of `up`: what could not be done is reported.
      let slotReturn = null;
      if (target === 'simulator' && slotDue({ idle: false })) {
        await step('slot', async () => {
          const r = await returnSlot({ touch, sessionOpen: deviceSession(loadState()) });
          slotReturn = { returned: r.returned, summary: slotSummary(r), human: r.human ?? [] };
          return slotReturnStep(r);
        });
        await touch();
      }

      if (target === 'device' && !liveDevice && !lockChecked) { await checkSignLock(); await touch(); }

      // Room for the lab's WebDriverAgent on the phone (issue 63, ADR 0008), for a new phone session: after the phone is known and the
      // signing lock looked at, before anything is changed on the phone, so a stop here opens no tunnel and turns no Focus on. If
      // the runner is missing and installd has no room for it, a slot is borrowed from sideload (this step can take 17 minutes).
      let slotOut = null; // the top-level `slot` of the result: only when a slot was borrowed or a record settled
      let slotHuman = [];
      if (target === 'device' && !liveDevice) {
        await step('slot', async () => {
          const r = await ensureWdaSlot({ phone: readPhone(loadState()), osVersion: phoneOut.osVersion, via: phoneOut.via, touch });
          slotOut = r.summary ?? null;
          slotHuman = r.human ?? [];
          return r;
        });
        await touch();
      }

      // A new phone session (no working one was found) first puts back what a crashed or unreachable earlier run left on the
      // phone, before this run records new values. A live session's changes are in use and stay. Never a failure of `up`.
      let stale = null;
      if (target === 'device' && !liveDevice && loadState().phoneRestore != null) {
        await step('phone-settings', async () => {
          const r = await phoneSettingsStep({});
          stale = r.report;
          return r;
        });
        await touch();
      }

      // The Wi-Fi tunnel, for a new device session: opened over Wi-Fi; over the cable a tunnel left up
      // is stopped (xcuitest would use its registry instead of usbmux). No step when neither applies.
      if (target === 'device' && phoneOut.via === 'tunnel') {
        await step('tunnel', async () => {
          const r = await ensureTunnel(readPhone(loadState()), { touch });
          if (r.coreDeviceRestarted) phoneOut.coreDeviceRestarted = true;
          return { found: r.found, did: r.did, ...(r.coreDeviceRestarted ? { report: { coreDeviceRestarted: true } } : {}) };
        });
        await touch();
      } else if (target === 'device' && phoneOut.via === 'usbmux' && tunnelRunning()) {
        await step('tunnel', async () => ({ ...(await stopTunnel()), report: { why: 'the cable was chosen' } }));
      }

      let profile = null; // the simulator profile this run is on
      let booted = false; // this run booted the simulator (a cold start)
      if (target === 'simulator') {
        await step('simulator', async () => {
          // Which profile: the one asked for; else the live session's; else clean, always the default. A session on the
          // other profile is not ended or moved from under its owner: that is a conflict. The session is only asked about when it matters.
          const rec = recordedSession();
          const recSim = rec?.target.simulator;
          const recProfile = recSim === undefined ? null : profileOfUdid(recSim);
          const matters = rec && (rec.target.device !== undefined || (recProfile !== null && recProfile !== (flags.profile ?? 'clean')));
          const live = matters ? await sessionAlive(rec) : false;
          if (live && rec.target.device !== undefined) throw conflict(rec); // never boot a simulator under a phone run
          profile = flags.profile ?? (live && recProfile ? recProfile : 'clean');
          const id = simUdid(profile);
          if (live && recSim !== id) throw conflict(rec);
          const state = simState(id);
          if (state === null) throw new Error(`simulator ${id} isn't known to simctl: run \`sim create${profile === 'configured' ? ' --profile configured' : ''}\``);
          const shut = yieldTo(id, { sessionChecked: true }); // one of the lab's simulators is booted at a time
          saveState({ profile });
          const report = { profile };
          const note = shut.length ? `shut down the ${shut.join(' and ')} simulator; ` : '';
          if (state === 'Booted') {
            const raised = raiseWindow(id);
            return { found: 'booted', report, ...(raised ? { did: `${note}brought ${raised} to the front` } : shut.length ? { did: note.replace(/; $/, '') } : {}) };
          }
          await bootSim(id, { onWait: touch }); // the limit is bootSim's: longer for a first boot
          booted = true;
          return { found: state.toLowerCase(), report, did: `${note}booted (was ${state})` };
        });
        await touch();
      }

      // Lab Focus (issue 16), for a new phone session: the Shortcuts app is left in front by the shortcut, so this runs before the
      // session opens and pins the lab's Safari tab. Never a failure of `up`: the output says `focus.applied: false` and what to do.
      let focus = null;
      if (target === 'device' && !liveDevice) {
        const rec = readPhone(loadState());
        const cfg = focusConfig(rec);
        if (flags['no-focus'] || !cfg.enabled) focus = { applied: false, skipped: flags['no-focus'] ? '--no-focus' : '`lab phone setup --focus off`' };
        else {
          await step('focus', async () => {
            try {
              focusTried = true;
              await changeFocus(rec);
              focus = { applied: true, shortcut: cfg.onShortcut, verified: false };
              return { found: `Lab Focus shortcut "${cfg.onShortcut}"`, did: 'ran it (Lab Focus is turned off again at the end; the lab can start the shortcut but not see the Focus change)' };
            } catch (thrown) {
              const e = asError(thrown);
              if (e instanceof InterruptError) throw e;
              const needs = e.extra?.needs ?? 'shortcut';
              const human = needs === 'shortcut' || !e.extra?.human ? NEEDS.shortcut.human : e.extra.human;
              focus = { applied: false, needs, error: errorText(e), human };
              return { found: 'Lab Focus not turned on', did: null, report: { focusError: errorText(e) } };
            }
          });
          await touch();
        }
      }

      const session = await step('session', () => startSession({ target, allowHosts, ...(target === 'simulator' ? { profile, coldBoot: booted } : {}), ...(target === 'device' && flags.url ? { url: flags.url } : {}) }));
      await touch();

      if (target === 'device') {
        // The signing expiry, read from the build Xcode made (or kept), is cached.
        const exp = profileExpiry();
        const rec = readPhone(loadState());
        const expires = exp ?? rec?.wdaExpires ?? null;
        if (rec && exp && exp !== rec.wdaExpires) saveState({ phone: { ...rec, wdaExpires: exp } });
        Object.assign(phoneOut, { wdaExpires: expires, wdaHoursLeft: hoursLeft(expires) });
        // Xcode reuses a provisioning profile that is still valid, so a re-sign does not move the expiry.
        if (signing && exp && expiryBefore === exp) {
          phoneOut.expiryMoved = false;
          phoneOut.note = flags.resign
            ? '--resign did not move the signing expiry: Xcode reuses the provisioning profile while it is valid, and renews it only near expiry (under 24 h left)'
            : 'the signing expiry did not move: Xcode reuses the provisioning profile while it is valid';
        }
        // A re-sign that leaves under 24 h did not work (Apple rejected the profile, or the old build was reused).
        if (signing && exp && Date.parse(exp) - Date.now() < RESIGN_WITHIN_MS) {
          throw Object.assign(needsError('resign', `the WebDriverAgent was signed again but its profile still runs out at ${exp} (${hoursLeft(exp)} h). The session is open; \`safari stop\` ends it`), { failedStep: 'session' });
        }
      }

      // Asked for with --appearance / --orientation: the same record-then-apply as the safari commands, before the page
      // opens so its first load sees them. The session is open if one fails (`safari stop` ends it and puts them back).
      for (const kind of COMMAND_KINDS) {
        if (flags[kind] === undefined) continue;
        await step(kind, async () => {
          const r = await safari[kind]([flags[kind]]);
          return { found: SETTINGS[kind].found(r.prior), did: r.changed ? `set ${r[kind]} (put back at the end)` : null, report: { [kind]: r[kind], prior: r.prior } };
        });
        await touch();
      }

      let page = {};
      if (flags.url) {
        page = await step('open', async () => ({ ...(await safari.open([flags.url])), found: 'ready', did: `opened ${redactUrl(flags.url)}` }));
        page = { url: page.url, title: page.title, ...(page.followed ? { followed: page.followed } : {}) };
      }
      await touch();

      const current = lease.read();
      return {
        owner: who,
        steps,
        session: session.session,
        backend: session.backend,
        target: session.target,
        targetType: targetType(session.target),
        ...(target === 'simulator' ? { profile } : {}),
        reused: session.reused,
        ...(target === 'device' ? { phone: phoneOut } : {}),
        ...(session.previousTab ? { previousTab: session.previousTab } : {}),
        ...(session.keyboardRestored !== undefined ? { keyboardRestored: session.keyboardRestored } : {}),
        ...(session.keyboardDeferred ? { keyboardDeferred: session.keyboardDeferred } : {}),
        ...(session.keyboardNote ? { keyboardNote: session.keyboardNote } : {}),
        ...(session.allowHosts ? { allowHosts: session.allowHosts } : {}),
        ...(session.note ? { note: session.note } : {}),
        ...lockReport(session),
        ...(focus ? { focus: Object.fromEntries(Object.entries(focus).filter(([k]) => k !== 'human')) } : {}), // its steps are in `human`
        ...(stale ? { phoneRestored: stale.phoneRestored, phoneRestore: stale.phoneRestore, ...(stale.restoredExactly === false ? { restoredExactly: false } : {}) } : {}),
        ...(slotOut ? { slot: slotOut } : {}),
        ...(slotReturn ? { slotReturned: slotReturn.returned, slot: slotReturn.summary } : {}),
        ...(session.human || stale?.human || focus?.human || slotHuman.length || slotReturn?.human.length ? { human: [...(session.human ?? []), ...(stale?.human ?? []), ...(focus?.human ?? []), ...slotHuman, ...(slotReturn?.human ?? [])] } : {}),
        ...page,
        lease: current && !current.corrupt ? { ...current, ...(lease.takeoverNote(taken) ?? {}) } : null,
        labVersion: version,
      };
    } catch (thrown) {
      const e = asError(thrown);
      const off = focusTried && !(e instanceof InterruptError) ? await focusOffAfterFailure() : {};
      const human = [...(e.extra?.human ?? []), ...(off.human ?? [])];
      // The cold-start hint is also on the failed step (see stepper).
      const withRunFlags = o => (o?.then === undefined ? o : { ...o, then: thenWithFlags(o.then, flags, allowHosts) });
      return { ok: false, error: errorText(e), failedStep: e.failedStep ?? null, steps: steps.map(withRunFlags), ...withRunFlags(e.extra), ...off, ...(human.length ? { human } : {}), ...(version ? { labVersion: version } : {}) };
    }
  },

  // down [--force] [--keep-service] | down --idle: stops what the lab started (session,
  // simulator, the window if the lab opened it, Appium), then hands the lease back. Best effort:
  // a step that fails is recorded and the rest still run; then the lease is kept, so a retry
  // stays yours. --idle is the idle stop (see idleDown), run by its LaunchAgent.
  async down(argv) {
    const { pos, flags } = parseArgs(argv, ['force', 'keep-service', 'idle']);
    if (pos.length || Object.keys(flags).some(k => !['force', 'keep-service', 'idle'].includes(k))) throw new Error(DOWN_USAGE);
    if (flags.idle && (flags.force || flags['keep-service'])) throw new Error(`${DOWN_USAGE} (--idle takes neither --force nor --keep-service)`);
    return flags.idle ? idleDown() : runDown(flags);
  },

  // hold [--minutes N]: keeps the idle stop off for N minutes (default 60, at most 120), for a
  // person using the simulator by hand. Takes no lease; counts as activity. `down` and a fresh boot end it.
  async hold(argv) {
    let parsed;
    try { parsed = parseArgs(argv); } catch { throw new Error(HOLD_USAGE); }
    const { pos, flags } = parsed;
    if (pos.length || Object.keys(flags).some(k => k !== 'minutes')) throw new Error(HOLD_USAGE);
    let minutes = HOLD_DEFAULT_MIN;
    if (flags.minutes !== undefined) {
      if (!/^\d{1,3}$/.test(flags.minutes)) throw new Error(HOLD_USAGE);
      minutes = Number(flags.minutes);
    }
    if (minutes < 1 || minutes > lease.HOLD_MAX_MIN) throw new Error(HOLD_USAGE);
    const running = stillRunning(loadState());
    if (!running.length) throw new Error('nothing the lab started is running, so there is nothing to hold: `lab up` first');
    const until = await lease.setHold({ minutes });
    return { held: true, minutes, until: lease.localIso(until), running, note: '`lab down`, or booting the simulator afresh, ends the hold' };
  },

  // status [--check-update]: everything `up` would look at, changing nothing (the cache of
  // the version check aside). --check-update asks origin again instead of using the cache.
  async status(argv = []) {
    let parsed;
    try { parsed = parseArgs(argv, ['check-update']); } catch { throw new Error(STATUS_USAGE); }
    const { pos, flags } = parsed;
    if (pos.length || Object.keys(flags).some(k => k !== 'check-update')) throw new Error(STATUS_USAGE);
    const who = lease.owner();
    const l = lease.read();
    const t = Date.now();
    const leaseOut = !l ? null
      : l.corrupt ? { corrupt: true, expired: true, mine: false }
        : { ...l, expired: Date.parse(l.expires) <= t, mine: l.owner === who };

    const service = await svc.status();
    const { url } = appiumEndpoint();
    let up = false;
    try { await wd(url, 'GET', '/status', undefined, svc.WAIT.statusMs); up = true; } catch { /* down */ }

    const id = loadState().udid;
    let sim = { state: null, runtime: null };
    try { if (id) sim = simInfo(id); } catch { /* simctl unavailable */ }

    // The configured profile's simulator (state only, plus its state from simctl), and the profile in use.
    let configured = null;
    try {
      const rec = configuredRecord(loadState());
      if (rec) {
        let info = { state: null, runtime: null };
        try { info = simInfo(rec.udid); } catch { /* simctl unavailable */ }
        configured = { udid: rec.udid, name: rec.name, state: info.state, runtime: info.runtime };
      }
    } catch (e) { configured = { damaged: true, error: errorText(e) }; }

    // Usable = answers and, on Appium, still has Safari's page (no context switching here).
    let session = null;
    try {
      const s = readSession(loadState());
      if (s) {
        let usable = false;
        try {
          if (s.backend === 'appium') {
            if (up) {
              const list = await wd(url, 'GET', `/session/${s.session}/contexts`, undefined, svc.WAIT.statusMs);
              usable = (Array.isArray(list) ? list : []).some(c => String(c?.id ?? c).startsWith('WEBVIEW_'));
            }
          } else {
            await wd(backendUrl(s.backend, s.port), 'GET', `/session/${s.session}/url`, undefined, svc.WAIT.statusMs);
            usable = true;
          }
        } catch { /* not usable */ }
        // A device script that got no answer holds Appium's queue for the session until it does (issue 104): say since when.
        const since = loadState().deviceTab?.waitingSince;
        const waiting = !usable && isTime(since) ? { waitingSince: since } : {};
        session = { id: s.session, backend: s.backend, usable, ...waiting, target: s.target, targetType: targetType(s.target) };
      }
    } catch { session = { damaged: true, usable: false }; }

    // The saved phone, from state only: no device calls, so `status` stays cheap.
    let phone = null;
    try {
      const rec = readPhone(loadState());
      if (rec) {
        phone = { ...rec, keyboard: keyboardTarget({ phone: rec }), wdaHoursLeft: hoursLeft(rec.wdaExpires), hint: '`lab phone status` checks the phone live; `seen` is the last time `lab up` or `lab phone setup` read it' };
        // Names only: the phone settings (appearance, orientation) the lab changed and has not put back yet.
        const waiting = pendingNames(loadState());
        if (!Array.isArray(waiting) || waiting.length) phone.pendingRestore = waiting;
      }
    } catch (e) { phone = { damaged: true, error: errorText(e) }; }

    // The Wi-Fi tunnel tool (a local `version` call only; nothing reaches the phone).
    const tool = checkPmd3();
    const tunnelTool = { ok: tool.ok, path: tool.path, version: tool.version, ...(tool.ok ? {} : { error: tool.error, hint: pmd3Hint(tool), ...(tool.slow ? { slow: true } : {}) }) };
    // The tunnel: its record, its agent and remotexpc's registry in the Appium home (no device calls).
    const tunnel = tunnelBlock();

    // A slot borrowed from sideload (record and binary; `sideload status` only while a record exists, display only).
    let slot;
    try { slot = slotStatus(loadState()); } catch (e) { slot = { error: errorText(e) }; }

    // Whether the lab started something that is still up, from what is above (stillRunning would write the state).
    const running = () => {
      const st = loadState();
      const booted = [[id, sim.state], [configured?.udid, configured?.state]].some(([u, v]) => u && u === st.simBoot && (v === 'Booted' || v === 'Booting'));
      return !!(service.loaded || session || validPid(st.driverPid) || booted || (tunnel.state !== 'down' && tunnel.alive) || pendingFocus(st) || lastRunOnPhone(st) || wantsReturn(st, { lastActive: lease.lastActive() }));
    };

    // The idle stop: its agent, the threshold, how long since the last lease command, and what the last stop did.
    let idleStop;
    try {
      const at = lease.lastActive();
      const agent = svc.idleStatus();
      // The agent's threshold is the one in its plist (what the installing shell had set), not this shell's.
      const issues = [...agent.issues];
      let thresholdMinutes = null;
      try { thresholdMinutes = idleMinutes(agent.installed ? agent.env : process.env); } catch {
        issues.push(agent.installed
          ? `the idle stop's plist has an invalid MSL_IDLE_MINUTES (${JSON.stringify(agent.env.MSL_IDLE_MINUTES)}), so every run fails: run \`lab service install\` again`
          : 'MSL_IDLE_MINUTES in this shell is not a whole number of minutes from 1 to 1440');
      }
      idleStop = {
        installed: agent.installed, loaded: agent.loaded, intervalSeconds: agent.intervalSeconds, thresholdMinutes,
        thresholdFrom: agent.installed ? "the idle stop's plist" : 'this shell (no idle stop installed)',
        lastActive: at === null ? null : lease.localIso(at), idleMinutes: at === null ? null : Math.max(0, Math.floor((t - at) / 60e3)),
        last: idleRecord(), issues,
      };
      const held = lease.holdUntil(t);
      idleStop.heldUntil = held === null ? null : lease.localIso(held);
      idleStop.nextStop = nextStop({ idleStop, at, held, lease: l, t, running: running(), state: loadState() });
    } catch (e) { idleStop = { error: errorText(e) }; }

    // Phone settings the lab changed and has not put back, whether or not a phone is still saved (names only).
    const owed = pendingNames(loadState());
    const pendingOut = !Array.isArray(owed) || owed.length
      ? { pendingRestore: owed, ...(phone ? {} : { human: [`The lab changed the phone's ${Array.isArray(owed) ? owed.join(' and ') : 'settings'} and had not put it back, but no phone is saved now. Save the phone again (\`lab phone setup\`) so \`lab phone restore\` can, or check it by hand and run \`lab phone restore --forget\`.`] }) }
      : {};
    return { owner: who, lease: leaseOut, service, idleStop, appium: { reachable: up, url }, simulator: { udid: id ?? null, state: sim.state, runtime: sim.runtime }, configuredSimulator: configured, profile: loadState().profile ?? null, session, phone, tunnelTool, tunnel, slot, labVersion: labVersion({ force: !!flags['check-update'] }), ...pendingOut };
  },

  // tunnel up | down | status: the Wi-Fi tunnel by hand. up and down take the lease like `service`;
  // status takes none. With the tunnel up it makes two bounded probes of the route (one TCP connect to the phone's
  // RSD port, and, when a session runs over the tunnel, one WebDriverAgent /status request): `reaches`.
  async tunnel(argv) {
    const [sub, ...rest] = argv;
    if (!['up', 'down', 'status'].includes(sub ?? '') || rest.length) throw new Error(TUNNEL_USAGE);
    if (sub === 'status') return { tunnel: await tunnelReach(tunnelBlock()), tool: checkPmd3() };
    let phone = null;
    if (sub === 'up') {
      phone = readPhone(loadState());
      if (!phone) throw needsError('setup', 'no phone is saved, so there is no tunnel to open');
    }
    const taken = await lease.acquire();
    let out;
    try {
      if (sub === 'up') {
        const r = await ensureTunnel(phone, { touch: () => lease.touch() });
        out = { found: r.found, did: r.did, ...(r.coreDeviceRestarted ? { coreDeviceRestarted: true } : {}), tunnel: tunnelBlock() };
      } else out = await stopTunnel();
    } finally {
      // As `service`: what this command took is handed back, even after a failure or a signal.
      try {
        await duringCleanup(() => (taken.action === 'created' || taken.action.startsWith('took over') ? lease.release() : lease.touch()));
      } catch (e) { console.error(maskDevices(`[lease] couldn't update the lease: ${e.message}`)); }
    }
    const note = lease.takeoverNote(taken);
    return note ? { ...out, lease: note } : out;
  },

  // phone setup --udid <UDID> --team <TEAM> [--bundle-id <id>] [--autocorrection on|off] [--prediction on|off] | status | forget
  async phone(argv) {
    const [sub, ...rest] = argv;
    if (!Object.hasOwn(phoneHandlers, sub ?? '')) throw new Error(PHONE_USAGE);
    return phoneHandlers[sub](rest);
  },

  // release [--force]
  async release(argv) {
    const { flags } = parseArgs(argv, ['force']);
    return lease.release({ force: !!flags.force });
  },

  // service install [--replace] [--log-level info|debug] [--no-idle-stop] | uninstall | status
  async service(argv) {
    const [sub, ...rest] = argv;
    if (sub === 'status') return { ...await svc.status(), idleStop: svc.idleStatus(), tunnelHost: svc.tunnelAgentStatus() };
    if (sub !== 'install' && sub !== 'uninstall') throw new Error(SERVICE_USAGE);
    const { flags } = parseArgs(rest, ['replace', 'no-idle-stop']);
    if (sub === 'uninstall' && flags['log-level'] !== undefined) throw new Error('usage: --log-level goes with lab service install');
    if (sub === 'uninstall' && flags['no-idle-stop']) throw new Error('usage: --no-idle-stop goes with lab service install (uninstall removes the idle stop too)');
    const logLevel = flags['log-level'] === undefined ? undefined : svc.checkLogLevel(flags['log-level']);
    // The lease keeps another agent from using the simulator while the service restarts; it is not a session.
    // What this command took is handed back when it ends, even when it fails; a lease the caller already held is kept (renewed).
    const taken = await lease.acquire();
    let out;
    try {
      out = sub === 'install' ? await svc.install({ replace: !!flags.replace, ...(logLevel ? { logLevel } : {}) }) : await svc.uninstall();
      // The idle stop agent goes with the service: installed with it (unless --no-idle-stop, which also removes one), removed with it.
      // A failure here is reported, and does not fail the service command.
      try {
        const idle = sub === 'install' && !flags['no-idle-stop'] ? await svc.installIdle() : { installed: false, ...(await svc.uninstallIdle()), ...(flags['no-idle-stop'] ? { optedOut: true } : {}) };
        out = { ...out, idleStop: idle };
      } catch (e) {
        if (e instanceof InterruptError) throw e;
        out = { ...out, idleStop: { installed: false, error: errorText(e) } };
      }
      // The tunnel host's agent always goes with the service (loaded idle: nothing runs until Wi-Fi is used). Reported the same way.
      try {
        out = { ...out, tunnelHost: sub === 'install' ? await svc.installTunnel() : { installed: false, ...(await svc.uninstallTunnel()) } };
      } catch (e) {
        if (e instanceof InterruptError) throw e;
        out = { ...out, tunnelHost: { installed: false, error: errorText(e) } };
      }
    } finally {
      // Under duringCleanup: after a signal the lease lock's retry wait still runs, so the lease is still handed back.
      try {
        await duringCleanup(() => (taken.action === 'created' || taken.action.startsWith('took over') ? lease.release() : lease.touch()));
      } catch (e) { console.error(maskDevices(`[lease] couldn't update the lease: ${e.message}`)); }
    }
    const note = lease.takeoverNote(taken);
    return note ? { ...out, lease: note } : out;
  },
};
