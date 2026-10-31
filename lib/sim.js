// bin/sim: the simulator itself, through `xcrun simctl` and AXe. Every command targets the
// UDID saved by `sim create`, never "booted", so other simulators are left alone.
import fs from 'node:fs';
import path from 'node:path';
import { run, failure, loadState, saveState, isUdid, newRun, artifact, logRun, pngSize, parseArgs, maskDevices } from './core.js';
import { appiumBin, INSTALL_HINT, redactUrl, registryModule, registryHint } from './appium.js';
import { readPhone, displaySupported } from './phone.js';
import { checkPmd3, pmd3Hint } from './pmd3.js';
import { labVersion } from './version.js';
import * as lease from './lease.js';
import { InterruptError, afterPendingSignals, interrupted } from './interrupt.js';

export const DEVICE_NAME = 'Claude iPhone';

const simctl = (...args) => run('xcrun', ['simctl', ...args]);
// Calls that can take minutes on a loaded Mac (a create or erase of a device, a shutdown) say so; the rest fall under the default timeout.
const SLOW_MS = 300e3;
const simctlSlow = (...args) => run('xcrun', ['simctl', ...args], { timeoutMs: SLOW_MS });
const TAP_STYLE = ['--tap-style', 'physical'];

// AXe's first call after the simulator has sat idle often fails; these two messages mean
// "try again", anything else is a real failure.
const AXE_TRANSIENT = /Timed out creating the simulator remote automation session|No translation object returned for simulator/;
const AXE_ATTEMPTS = 4;
let pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const setPause = fn => { pause = fn; }; // tests skip the 2 s waits

function axe(...args) {
  for (let attempt = 1; ; attempt++) {
    const r = run('axe', args, { allowFail: true });
    if (r.code === 0) return r;
    if (attempt >= AXE_ATTEMPTS || !AXE_TRANSIENT.test(`${r.stderr}\n${r.stdout}`)) throw failure('axe', args, r);
    pause(2000);
  }
}

// --- profiles: two simulators, one booted at a time ---
// `clean` is the state's `udid` (made by `sim create`, wiped by `sim reset`). `configured` is
// `profiles.configured` ({ udid, name }): the owner's hand-made sign-ins and settings live on it,
// and nothing wipes it but `sim reset --profile configured --yes`. The transient state `profile`
// (set by `lab up` and `sim boot`, cleared by `lab down` and `sim shutdown`) is the one in use.
export const PROFILES = ['clean', 'configured'];
export const CONFIGURED_NAME = `${DEVICE_NAME} (configured)`;

export function checkProfile(profile) {
  if (!PROFILES.includes(profile)) {
    const shown = typeof profile === 'string' && /^[\w-]{1,30}$/.test(profile) ? `"${profile}"` : 'that value';
    throw new Error(`--profile must be one of ${PROFILES.join(', ')} (got ${shown})`);
  }
  return profile;
}

// The saved configured simulator ({ udid, name }), null when there is none; a record that is not
// one throws, pointing at `sim create --profile configured`.
export function configuredRecord(state = loadState()) {
  const p = state.profiles;
  if (p === undefined || p === null) return null;
  const c = p && typeof p === 'object' && !Array.isArray(p) ? p.configured : undefined;
  if (c === undefined) return null;
  const ok = c && typeof c === 'object' && !Array.isArray(c) && isUdid(c.udid) && c.udid !== state.udid && (c.name === undefined || typeof c.name === 'string');
  if (!ok) throw new Error('The configured simulator record is damaged: run `sim create --profile configured` to save it again');
  return { udid: c.udid, name: c.name ?? CONFIGURED_NAME };
}

// --- unwarmed: a simulator whose next boot is its first ---
// A new (or just erased) simulator migrates its data on that boot, which took ~11 min on a loaded
// 8 GB Mac. The state's `unwarmed` ([UDID, ...]) lists them; `sim create` and `sim reset` add one,
// a boot that finishes removes it. Missing, or any shape but an array holding the UDID, reads as
// warmed: a simulator from before this marker is never held to the long limit.
export const isUnwarmed = (id, state = loadState()) => Array.isArray(state.unwarmed) && state.unwarmed.includes(id);

const validUdids = list => (Array.isArray(list) ? list.filter(isUdid) : []);

export function markUnwarmed(id) {
  const state = loadState();
  saveState({ unwarmed: [...new Set([...validUdids(state.unwarmed), id])] });
}

export function markWarmed(id) {
  const state = loadState();
  if (state.unwarmed === undefined) return;
  const left = validUdids(state.unwarmed).filter(u => u !== id);
  saveState({ unwarmed: left.length ? left : null });
}

// The UDID a profile names.
export function profileUdid(profile, state = loadState()) {
  checkProfile(profile);
  if (profile === 'configured') {
    const c = configuredRecord(state);
    if (!c) throw new Error('No configured simulator yet: run `sim create --profile configured` first');
    return c.udid;
  }
  if (!isUdid(state.udid)) throw new Error('No simulator yet: run `sim create` first');
  return state.udid;
}

// Which profile a UDID is: the configured simulator's, else clean.
export function profileOfUdid(id, state = loadState()) {
  let c = null;
  try { c = configuredRecord(state); } catch { /* damaged: nothing is configured */ }
  return c && c.udid === id ? 'configured' : 'clean';
}

// The lab's simulators that exist in the state, [{ profile, udid }]; a damaged record is skipped.
export function labDevices(state = loadState()) {
  const out = [];
  if (isUdid(state.udid)) out.push({ profile: 'clean', udid: state.udid });
  try { const c = configuredRecord(state); if (c) out.push({ profile: 'configured', udid: c.udid }); } catch { /* skipped */ }
  return out;
}

// The simulator the recorded Safari session is on (a record only: nothing is asked of Appium), else null.
export function simulatorSession(state = loadState()) {
  const t = state.target;
  const s = t && typeof t === 'object' && !Array.isArray(t) ? t.simulator : undefined;
  return typeof state.session === 'string' && state.session && isUdid(s) ? s : null;
}

// The simulator a command acts on: the profile asked for (`--profile`), else the recorded session's
// simulator, else the profile `lab up` / `sim boot` set, else clean (always the default).
export function udid(profile, state = loadState()) {
  if (profile !== undefined) return profileUdid(profile, state);
  const live = simulatorSession(state);
  if (live && labDevices(state).some(d => d.udid === live)) return live; // only a saved simulator: a record naming another is not trusted
  return profileUdid(state.profile === 'configured' ? 'configured' : 'clean', state);
}

// The UDID of the iPhone the recorded Safari session is on, else null. A device session is
// stored like a simulator one but with `target: { device: UDID }` (see readSession in
// safari.js, which this can't import: it imports this). A damaged record reads as "none".
export function deviceSession(state = loadState()) {
  const t = state.target;
  const d = t && typeof t === 'object' && !Array.isArray(t) ? t.device : undefined;
  return typeof state.session === 'string' && state.session && isUdid(d) ? d : null;
}

// Throws the refusal for a `sim` command that would act on the simulator while the
// session is on the phone; the command never reaches the lease or the simulator.
export function refuseOnDevice(name, state = loadState()) {
  if (!deviceSession(state)) return;
  const e = new Error(
    `sim ${name} is refused: the Safari session is on the iPhone, not the simulator. `
    + 'Use `safari shot|tap|keys|swipe` to look at or drive the phone, or `safari stop` (or `lab down`) to end the device session first.',
  );
  throw e;
}

const version = id => (id.match(/(\d+)-(\d+)(?:-(\d+))?$/) || []).slice(1).map(n => Number(n || 0));
const newer = (a, b) => {
  const [x, y] = [version(a.identifier), version(b.identifier)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

// Variant preference at the same model number: Pro first, then the base phone, and so on.
const VARIANT_RANK = ['Pro', '', 'Air', 'Plus', 'Pro Max'];
const phoneRank = t => {
  const m = /^iPhone (\d+)\s*(.*)$/.exec(t.name || '');
  if (!m) return [0, VARIANT_RANK.length + 1]; // SE and other unnumbered phones come last
  const v = VARIANT_RANK.indexOf(m[2].trim());
  return [Number(m[1]), v < 0 ? VARIANT_RANK.length : v]; // e / mini after the rest
};

// Picks the newest available iOS runtime and the newest iPhone it supports (highest model
// number, regardless of how Apple orders the list), or the type named by `type`.
export function pickDevice(list, type) {
  const runtimes = (list.runtimes || [])
    .filter(r => r.isAvailable && /SimRuntime\.iOS-/.test(r.identifier || ''))
    .sort(newer);
  const rt = runtimes[0];
  if (!rt) throw new Error('No iOS simulator runtime installed: run `xcodebuild -downloadPlatform iOS`');
  const phones = (rt.supportedDeviceTypes || []).filter(t => t.productFamily === 'iPhone');
  const newest = [...phones].sort((a, b) => {
    const [x, y] = [phoneRank(a), phoneRank(b)];
    return y[0] - x[0] || x[1] - y[1];
  })[0];
  const pick = type ? phones.find(t => t.name === type) : newest;
  if (!pick) throw new Error(type ? `No device type "${type}" for ${rt.name}` : `No iPhone types for ${rt.name}`);
  return { runtime: rt, deviceType: pick };
}

const allDevices = list => Object.values(list.devices || {}).flat();

// The simulator's state ("Booted", "Shutdown", ...) and its iOS runtime ("iOS 27.0"), each null
// when simctl doesn't list the simulator or the runtime key isn't one we can read.
export function simInfo(id) {
  const list = JSON.parse(simctl('list', '-j', 'devices').stdout);
  for (const [key, devices] of Object.entries(list.devices || {})) {
    const d = Array.isArray(devices) ? devices.find(x => x.udid === id) : undefined;
    if (!d) continue;
    const m = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/.exec(key);
    return { state: d.state ?? null, runtime: m ? `${m[1]} ${m[2]}.${m[3]}` : null };
  }
  return { state: null, runtime: null };
}

export const simState = id => simInfo(id).state;

// One lab simulator is booted at a time: shuts down the other one (when it is up) before `id`
// boots. A session recorded on the other one is a conflict, unless the caller has checked that
// it is dead (`sessionChecked`). Clears `simBoot` when it named the one shut down. Returns the
// profiles it shut down.
export function yieldTo(id, { sessionChecked = false } = {}) {
  const state = loadState();
  const shut = [];
  for (const other of labDevices(state).filter(d => d.udid !== id)) {
    const up = simState(other.udid);
    if (up !== 'Booted' && up !== 'Booting') continue;
    const live = simulatorSession(state);
    if (!sessionChecked && live === other.udid) {
      throw new Error(`a session is open on the ${other.profile} simulator, which is booted: run \`safari stop\` first (or \`lab down\`), then boot the other profile`);
    }
    run('xcrun', ['simctl', 'shutdown', other.udid], { allowFail: true, timeoutMs: SLOW_MS });
    const now = simState(other.udid);
    if (now !== 'Shutdown') throw new Error(`the ${other.profile} simulator ${other.udid} is still ${now} after \`simctl shutdown\`, so the other one was not booted`);
    if (state.simBoot === other.udid) saveState({ simBoot: null });
    shut.push(other.profile);
  }
  return shut;
}

// Refuses to go on when another of the lab's simulators is up (Booted or Booting): a session on
// `id` would boot a second one. Asks simctl only when the lab has a second simulator. `lab up`
// shuts the other one down first, so it never trips this.
export function requireOnlyBooted(id, state = loadState()) {
  for (const other of labDevices(state).filter(d => d.udid !== id)) {
    const up = simState(other.udid);
    if (up !== 'Booted' && up !== 'Booting') continue;
    const mine = profileOfUdid(id, state);
    throw new Error(`the ${other.profile} simulator is ${up.toLowerCase()}, and a session on the ${mine} one would boot a second simulator: run \`lab up --profile ${mine}\` (it shuts the ${other.profile} one down first), or \`lab down\``);
  }
}

// How long a boot may take: 4 to 10 minutes on a loaded Mac, and the first boot of a new or erased
// simulator (see `unwarmed`) longer still. `bootstatus` is run in BOOT_CHUNK_MS pieces because `run`
// blocks: between pieces the caller renews the lease, and a signal (issue 41) is seen within one piece.
export const BOOT_MS = 600e3;
export const FIRST_BOOT_MS = 1500e3;
export const BOOT_CHUNK_MS = 150e3;

// Boots the simulator (tolerating one that is already up or coming up), opens a window for
// it and waits for the boot to finish, at most `timeoutMs` (FIRST_BOOT_MS while it is unwarmed,
// else BOOT_MS), calling `onWait` after each piece that ran out. A boot that simctl accepted
// (the simulator was Shutdown) is recorded as the state's `simBoot`: the idle stop shuts
// down only a simulator the lab booted. One that was already up is not recorded.
export async function bootSim(id, { timeoutMs = isUnwarmed(id) ? FIRST_BOOT_MS : BOOT_MS, onWait } = {}) {
  const r = run('xcrun', ['simctl', 'boot', id], { allowFail: true, timeoutMs: 60e3 });
  if (r.code !== 0 && !/current state: (Booted|Booting)/i.test(r.stderr)) throw new Error(`simctl boot failed: ${r.stderr.trim()}`);
  if (r.code === 0) { saveState({ simBoot: id }); lease.clearHold(); } // a fresh boot ends any `lab hold`
  const window = openWindow(id);
  const pieces = Math.ceil(timeoutMs / BOOT_CHUNK_MS);
  for (let i = 1; i <= pieces; i++) {
    const piece = Math.min(BOOT_CHUNK_MS, timeoutMs - (i - 1) * BOOT_CHUNK_MS);
    const args = ['simctl', 'bootstatus', id, '-b'];
    const b = run('xcrun', args, { allowFail: true, timeoutMs: piece });
    if (b.code === 0) {
      markWarmed(id);
      return { window };
    }
    // A signal that arrived while the child ran is handled one macrotask later: it ends the wait, it is not a failed boot.
    await afterPendingSignals();
    if (interrupted()) throw new InterruptError(interrupted());
    if (b.code !== 124) throw failure('xcrun', args, b);
    if (i < pieces) await onWait?.();
  }
  throw new Error(`simulator still booting after ${Math.round(timeoutMs / 1000)} s; run \`sim boot\` again, the migration continues`);
}

// For bin/sim's hook, before the lease is taken: the `--profile` value of a command that takes
// one must be a profile. A missing value is left to the command's own parser.
export const PROFILE_COMMANDS = new Set(['create', 'udid', 'boot', 'shutdown', 'reset']);
export function checkProfileArg(name, args) {
  if (!PROFILE_COMMANDS.has(name)) return;
  const at = args.map((a, i) => (a === '--profile' ? i : -1)).filter(i => i >= 0);
  if (at.length > 1) throw new Error('--profile is given more than once: name one profile');
  if (at.length && at[0] + 1 < args.length) checkProfile(args[at[0] + 1]);
}

// `profile` in a command's output, named only for the configured one: the clean profile's output is what it always was.
const profileOut = id => (profileOfUdid(id) === 'configured' ? { profile: 'configured' } : {});

// The flags of a command that takes only `--profile`.
function onlyProfileFlag(argv = [], usage) {
  const { pos, flags } = parseArgs(argv);
  if (pos.length || Object.keys(flags).some(k => k !== 'profile')) throw new Error(`usage: ${usage}`);
  return flags;
}

const handlers = {
  // Creates (once) the dedicated simulator and saves its UDID. `--profile configured` makes the
  // second one, kept apart from the clean one (see PROFILES).
  async create(argv = []) {
    const { flags } = parseArgs(argv);
    const profile = flags.profile === undefined ? 'clean' : checkProfile(flags.profile);
    const state = loadState();
    const name = flags.name || (profile === 'configured' ? CONFIGURED_NAME : DEVICE_NAME);
    const mine = profile === 'configured' ? configuredRecord(state)?.udid : state.udid;
    const theirs = profile === 'configured' ? state.udid : configuredRecord(state)?.udid; // never the other profile's simulator
    const list = JSON.parse(simctl('list', '-j', 'devices', 'runtimes').stdout);
    const usable = d => d.isAvailable !== false && d.udid !== theirs;
    const existing = allDevices(list).find(d => d.udid === mine && usable(d))
      || allDevices(list).find(d => d.name === name && usable(d));
    const save = id => (profile === 'configured'
      ? saveState({ profiles: { ...(state.profiles && typeof state.profiles === 'object' ? state.profiles : {}), configured: { udid: id, name } } })
      : saveState({ udid: id }));
    if (existing && !flags.type) {
      save(existing.udid);
      return { udid: existing.udid, name: existing.name, ...(profile === 'configured' ? { profile } : {}), created: false };
    }
    const { runtime, deviceType } = pickDevice(list, flags.type);
    refuseOnDevice('create'); // a new simulator is booted below: not under a phone session
    const id = simctlSlow('create', name, deviceType.identifier, runtime.identifier).stdout.trim();
    if (!isUdid(id)) throw new Error(`simctl create returned "${id}"`);
    save(id);
    // The first boot migrates the device's data and takes the longest (see `unwarmed`): do it now,
    // with no session waiting on it, then shut the simulator down again.
    markUnwarmed(id);
    let shutDown;
    try {
      shutDown = yieldTo(id);
      await bootSim(id, { onWait: () => lease.touch() });
    } catch (e) {
      if (e instanceof InterruptError) throw e;
      throw new Error(`created and saved ${id}, but the warm-up boot failed: ${e.message}; \`sim boot${profile === 'configured' ? ' --profile configured' : ''}\` finishes it`);
    }
    run('xcrun', ['simctl', 'shutdown', id], { allowFail: true, timeoutMs: SLOW_MS });
    if (loadState().simBoot === id) saveState({ simBoot: null });
    return { udid: id, name, ...(profile === 'configured' ? { profile } : {}), device: deviceType.name, runtime: runtime.name, created: true, warmed: true, ...(shutDown.length ? { shutDown } : {}) };
  },

  udid(argv = []) {
    const { flags } = parseArgs(argv);
    const id = udid(flags.profile);
    return { udid: id, ...profileOut(id) };
  },

  // Boots it (if needed), opens a window for it (Simulator, or Device Hub on Xcode 27), and
  // waits until it's ready. A window that won't open never fails the boot. The lab's other
  // simulator is shut down first (one is booted at a time), and the profile is the one in use
  // until `lab down` or `sim shutdown`.
  async boot(argv) {
    const flags = onlyProfileFlag(argv, 'sim boot [--profile clean|configured]');
    const id = udid(flags.profile);
    const shutDown = yieldTo(id);
    const { window } = await bootSim(id, { onWait: () => lease.touch() });
    const profile = profileOfUdid(id);
    saveState({ profile });
    return { udid: id, ...profileOut(id), booted: true, window, ...(shutDown.length ? { shutDown } : {}) };
  },

  open([url]) {
    if (!/^(https?:\/\/|about:)/.test(url || '')) throw new Error('usage: sim open <http(s) URL>');
    simctl('openurl', udid(), url);
    logRun(`sim open ${url}`);
    return { url };
  },

  // Screenshot at full device resolution. Also records the pixels-per-point scale (from
  // AXe's screen frame) so `sim tap X Y --px` can take coordinates read off this image. The scale is saved with
  // the PNG width it was measured at: when AXe can't be read (the accessibility tree is not ready for a while after
  // a boot), a saved scale is reused only for a screenshot of that same width.
  shot(argv) {
    const { pos } = parseArgs(argv);
    const id = udid();
    const file = artifact(pos[0] || 'shot', 'png');
    simctl('io', id, 'screenshot', file);
    const { width, height } = pngSize(file);
    let scale = null;
    try {
      const w = screenWidth(JSON.parse(axe('describe-ui', '--udid', id).stdout));
      if (w) scale = Math.round((width / w) * 100) / 100;
    } catch (e) {
      console.error(maskDevices(`[sim] couldn't read the screen size from AXe: ${redactUrl(e.message)}`));
    }
    let note;
    if (scale) saveState({ scale, scaleWidth: width });
    else {
      const saved = loadState();
      if (saved.scale > 0 && saved.scaleWidth === width) scale = saved.scale;
      else note = 'scale is null: AXe could not read the screen size (the simulator may still be starting); retry `sim shot` in a few seconds before using `sim tap --px`';
    }
    logRun(`sim shot ${file}`);
    return { file, width, height, scale, ...(note ? { note } : {}) };
  },

  // tap --label TEXT | --id ID | X Y [--px]   (points by default; --px = screenshot pixels)
  tap(argv) {
    const { pos, flags } = parseArgs(argv, ['px']);
    const id = udid();
    // Physical style: on Xcode 27 AXe's default tap reports success but delivers nothing.
    if (flags.label) axe('tap', '--label', flags.label, ...TAP_STYLE, '--udid', id);
    else if (flags.id) axe('tap', '--id', flags.id, ...TAP_STYLE, '--udid', id);
    else {
      let [x, y] = pos.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('usage: sim tap --label TEXT | --id ID | X Y [--px]');
      if (flags.px) {
        const { scale } = loadState();
        if (!(scale > 0)) throw new Error('No scale yet: take a `sim shot` first');
        [x, y] = [Math.round(x / scale), Math.round(y / scale)];
      }
      axe('tap', '-x', String(x), '-y', String(y), ...TAP_STYLE, '--udid', id);
      return { x, y };
    }
    return { label: flags.label, id: flags.id };
  },

  type([text]) {
    if (typeof text !== 'string') throw new Error('usage: sim type <text>');
    axe('type', text, '--udid', udid());
    return { typed: text.length };
  },

  scroll([dir]) {
    if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error('usage: sim scroll up|down|left|right');
    axe('gesture', `scroll-${dir}`, '--udid', udid());
    return { scrolled: dir };
  },

  swipe(argv) {
    const n = argv.slice(0, 4).map(Number);
    if (n.length < 4 || !n.every(Number.isFinite)) throw new Error('usage: sim swipe X1 Y1 X2 Y2 (points)');
    axe('swipe', '--start-x', String(n[0]), '--start-y', String(n[1]), '--end-x', String(n[2]), '--end-y', String(n[3]), '--udid', udid());
    return { from: n.slice(0, 2), to: n.slice(2) };
  },

  // The accessibility tree, saved whole; prints the labels found (first 80).
  ui() {
    const out = axe('describe-ui', '--udid', udid()).stdout;
    const file = artifact('ui', 'json');
    fs.writeFileSync(file, out);
    const labels = [];
    walk(JSON.parse(out), n => {
      const l = n.AXLabel ?? n.label;
      if (typeof l === 'string' && l.trim() && labels.length < 80) labels.push(l.trim());
    });
    return { file, labels };
  },

  appearance([mode]) {
    if (!['dark', 'light'].includes(mode)) throw new Error('usage: sim appearance dark|light');
    simctl('ui', udid(), 'appearance', mode);
    return { appearance: mode };
  },

  // Clean status bar for README screenshots (`statusbar clear` undoes it).
  statusbar([what]) {
    const id = udid();
    if (what === 'clear') simctl('status_bar', id, 'clear');
    else simctl('status_bar', id, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularBars', '4', '--wifiBars', '3');
    return { statusbar: what === 'clear' ? 'cleared' : 'clean' };
  },

  shutdown(argv) {
    const flags = onlyProfileFlag(argv, 'sim shutdown [--profile clean|configured]');
    const id = udid(flags.profile);
    run('xcrun', ['simctl', 'shutdown', id], { allowFail: true, timeoutMs: SLOW_MS });
    if (loadState().simBoot === id) saveState({ simBoot: null });
    if (loadState().profile === profileOfUdid(id)) saveState({ profile: null });
    return { udid: id, ...profileOut(id), shutdown: true };
  },

  // Back to a fresh device: shut down and erase (Safari data, history, settings). On the
  // configured profile that also erases the sign-ins made by hand, so it is asked for twice:
  // `--profile configured` and `--yes`.
  reset(argv = []) {
    const { pos, flags } = parseArgs(argv, ['yes']);
    if (pos.length || Object.keys(flags).some(k => !['profile', 'yes'].includes(k))) throw new Error('usage: sim reset [--profile clean|configured] [--yes]  (--yes is for the configured profile)');
    const id = udid(flags.profile);
    const profile = profileOfUdid(id);
    if (profile === 'configured' && !(flags.profile === 'configured' && flags.yes)) {
      throw new Error('sim reset would erase the configured profile for good: every sign-in and setting made on it by hand. If that is what you want, run `sim reset --profile configured --yes`');
    }
    run('xcrun', ['simctl', 'shutdown', id], { allowFail: true, timeoutMs: SLOW_MS });
    simctlSlow('erase', id);
    markUnwarmed(id); // the next boot migrates the data again
    if (loadState().simBoot === id) saveState({ simBoot: null });
    return { udid: id, ...profileOut(id), erased: true };
  },

  // sim profile status: which simulators the lab has and which is booted. Read-only, and only
  // the devices: nothing on them is opened or read.
  profile(argv) {
    if (argv[0] !== 'status' || argv.length !== 1) throw new Error('usage: sim profile status');
    const state = loadState();
    const list = JSON.parse(simctl('list', '-j', 'devices').stdout);
    const device = (id, fallback) => {
      if (!id) return null;
      for (const [key, devices] of Object.entries(list.devices || {})) {
        const d = Array.isArray(devices) ? devices.find(x => x.udid === id) : undefined;
        if (!d) continue;
        const m = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/.exec(key);
        return { udid: id, name: d.name ?? fallback, state: d.state ?? null, runtime: m ? `${m[1]} ${m[2]}.${m[3]}` : null };
      }
      return { udid: id, name: fallback, state: null, runtime: null, known: false };
    };
    let configured = null, damaged = null;
    try { configured = configuredRecord(state); } catch (e) { damaged = e.message; }
    let current = null;
    try { current = profileOfUdid(udid(), state); } catch { /* no simulator yet */ }
    const clean = isUdid(state.udid) ? device(state.udid, null) : null; // the name is simctl's, not assumed
    const devices = { clean, configured: device(configured?.udid, configured?.name ?? null) };
    return {
      current,
      session: simulatorSession(state) ? profileOfUdid(simulatorSession(state), state) : null,
      devices,
      booted: Object.entries(devices).filter(([, d]) => d && (d.state === 'Booted' || d.state === 'Booting')).map(([k]) => k),
      ...(damaged ? { damaged } : {}),
    };
  },

  // Starts a new run folder for the following screenshots and logs.
  run([label]) {
    return { run: newRun(label || 'run') };
  },

  // Checks the tools this needs and says what's missing.
  doctor() {
    const check = (cmd, args) => {
      const r = run(cmd, args, { allowFail: true });
      return r.code === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
    };
    const s = loadState();
    // With a valid phone record the simulator and its tools are optional (the phone needs Xcode
    // and Appium; the page side no longer uses safaridriver). A damaged record counts as none.
    let phone = false;
    try { phone = readPhone(s) !== null; } catch { /* damaged: no phone is saved */ }
    const report = {
      xcode: check('xcodebuild', ['-version']),
      simctl: check('xcrun', ['simctl', 'help']) ? 'ok' : null,
      axe: check('axe', ['--version']),
      appium: check(appiumBin(), ['--version']),
      node: process.version,
      udid: isUdid(s.udid) ? s.udid : null,
    };
    const optional = phone ? SIMULATOR_ONLY : [];
    report.missing = Object.entries(report).filter(([k, v]) => !v && !optional.includes(k)).map(([k]) => k);
    report.phone = phone;
    // The Wi-Fi tunnel tool is optional (the cable and the simulator don't need it): its version is
    // reported, and with a phone saved a hint says how to get it; it is never in `missing`.
    const tool = checkPmd3();
    report.pymobiledevice3 = tool.version;
    // The registry the tunnel host imports from the Appium install is checked the same way.
    report.tunnelRegistry = fs.existsSync(registryModule());
    // `safari appearance` and `safari orientation` need Xcode 27's devicectl; optional like the tunnel tool, and only asked
    // about when a phone is saved (the help texts only: nothing is sent to the phone).
    if (phone) report.phoneDisplay = displaySupported().ok;
    const toolHint = {
      ...(phone && !tool.ok ? { pymobiledevice3: pmd3Hint(tool) } : {}),
      ...(phone && report.phoneDisplay === false ? { phoneDisplay: PHONE_DISPLAY_HINT } : {}),
      ...(phone && !report.tunnelRegistry ? { tunnelRegistry: registryHint() } : {}),
    };
    // Only a hint, never a failure: the checkout is behind origin or not on main.
    const version = labVersion();
    if (version.human) report.labVersion = version;
    if (!report.missing.length) return Object.keys(toolHint).length ? { ...report, hints: toolHint } : report;
    const hints = { ...Object.fromEntries(report.missing.map(k => [k, DOCTOR_HINTS[k]])), ...toolHint };
    return { ok: false, error: `missing: ${report.missing.join(', ')} - see hints`, hints, ...report };
  },
};

const PHONE_DISPLAY_HINT = '`safari appearance` and `safari orientation` need the appearance and orientation commands of Xcode 27\'s `xcrun devicectl` (`xcrun devicectl device info appearance --help` must work). Update Xcode, or ignore this if you do not change the phone\'s appearance or orientation.';

// Doctor checks only the simulator needs: not required once a phone is set up.
const SIMULATOR_ONLY = ['simctl', 'axe', 'udid'];

// One-line fixes for `doctor`, keyed by report field.
const DOCTOR_HINTS = {
  xcode: 'Install Xcode (App Store; on macOS Sequoia use Xcode 26.0-26.3 from developer.apple.com/download/all), then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and `sudo xcodebuild -license accept`',
  simctl: 'Comes with Xcode: point xcode-select at Xcode.app (see xcode) and run `xcodebuild -downloadPlatform iOS`',
  axe: '`brew install cameroncooke/axe/axe`',
  appium: INSTALL_HINT,
  udid: '`sim create` then `sim boot`',
};

// The apps `openWindow` can open, by the name it reports, and their bundle ids.
export const WINDOW_APPS = { Simulator: 'com.apple.iphonesimulator', 'Device Hub': 'com.apple.dt.Devices' };

// Whether the app is running; null when that can't be told (treat it as running).
export function appRunning(bundle) {
  const r = run('osascript', ['-e', `application id "${bundle}" is running`], { allowFail: true, timeoutMs: 10e3 });
  const out = r.stdout.trim();
  return r.code === 0 && (out === 'true' || out === 'false') ? out === 'true' : null;
}

// Opens a window onto the booted simulator and says which one: Xcode 26 and earlier have
// Simulator.app; Xcode 27 replaced it with Device Hub. Null (after a note) if neither opens.
// The state's `windowApp` names the app only when the lab opened it (it wasn't running
// before), which is the only one `lab down` may quit.
function openWindow(id) {
  const dev = run('xcode-select', ['-p'], { allowFail: true }).stdout.trim();
  let r = null, window = null;
  if (dev && fs.existsSync(path.join(dev, 'Applications', 'Simulator.app'))) window = 'Simulator';
  else if (dev && fs.existsSync(path.join(dev, '..', 'Applications', 'DeviceHub.app'))) window = 'Device Hub';
  const ours = window !== null && (loadState().windowApp === window || appRunning(WINDOW_APPS[window]) === false);
  if (window === 'Simulator') r = run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', id], { allowFail: true });
  else if (window) r = run('open', ['-b', WINDOW_APPS[window]], { allowFail: true });
  if (!r) console.error(maskDevices(`[sim] couldn't open a window: neither Simulator.app nor DeviceHub.app found under ${dev || 'xcode-select -p'}`));
  else if (r.code !== 0) console.error(maskDevices(`[sim] couldn't open a window: open failed: ${redactUrl((r.stderr || r.stdout || '').trim())}`));
  if (!r || r.code !== 0) return null;
  if (ours && !loadState().windowApp) saveState({ windowApp: window }); // the first record stays
  return window;
}

// The width in points of the screen, from AXe's describe-ui output (an array of root
// elements, each with a `frame`).
export function screenWidth(tree) {
  let w = 0;
  walk(tree, n => {
    const f = n.frame;
    if (f && typeof f.width === 'number' && f.width > w) w = f.width;
  }, 2);
  return w || null;
}

function walk(node, fn, depth = Infinity) {
  if (depth < 0 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn, depth); return; }
  fn(node);
  for (const k of ['children', 'AXChildren']) if (Array.isArray(node[k])) walk(node[k], fn, depth - 1);
}

export { handlers };
