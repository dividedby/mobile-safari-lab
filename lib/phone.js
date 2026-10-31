// Everything specific to the physical iPhone: reading `devicectl`, whether the phone is
// really reachable, the WebDriverAgent signing expiry, turning failure text into a `needs`
// value with steps for a person, target selection, and opening the run's own Safari tab.
// Commands go through core's `run`, so tests record them with `setRunner`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, isUdid } from './core.js';
import { appiumHome } from './appium.js';
import { PMD3_FLOOR } from './pmd3.js';

// `displayMs`: one devicectl appearance/orientation call. `shortcutMs`: the launch of one Lab Focus shortcut. `readBackMs`: the pause between the (at most
// READ_BACK_TRIES) readings that confirm a change. `appsMs`: the listing of the phone's apps; `installMs` / `uninstallMs`: putting the
// WebDriverAgent runner on the phone or taking it off.
export const WAIT = { listMs: 30e3, lockMs: 20e3, usbmuxMs: 15e3, launchMs: 120e3, profileMs: 15e3, displayMs: 20e3, shortcutMs: 30e3, readBackMs: 1e3, helpMs: 15e3, appsMs: 20e3, installMs: 300e3, uninstallMs: 120e3 };
export const READ_BACK_TRIES = 3;
export const RESIGN_WITHIN_MS = 24 * 3600e3;
export const SIMULATOR_FALLBACK = 'lab up --target simulator';

export const isTeamId = s => typeof s === 'string' && /^[A-Z0-9]{10}$/.test(s);

export const isBundleId = s => typeof s === 'string' && /^(?=.*\.)[A-Za-z0-9.-]{3,155}$/.test(s);

// WebDriverAgent turns Auto-Correction and Predictive off for the whole phone when it starts
// and nothing turns them back on. The lab leaves them off during a session (typing tests stay
// deterministic) and, when it ends a device session, sets them to the saved target: by default
// both on. `lab phone setup --autocorrection on|off --prediction on|off` changes the target.
export const KEYBOARD_DEFAULT = Object.freeze({ autocorrection: true, prediction: true });
export const KEYBOARD_HUMAN = 'Turn Auto-Correction and Predictive back on in Settings > General > Keyboard.';

const isKeyboard = k => k !== null && typeof k === 'object' && !Array.isArray(k)
  && Object.keys(k).length === 2 && typeof k.autocorrection === 'boolean' && typeof k.prediction === 'boolean';

// An `on` / `off` flag value as a boolean; anything else is refused.
export function parseOnOff(flag, value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`--${flag} "${value}" must be on or off`);
}

const VIAS = ['tunnel', 'usbmux'];
const OS_VERSION = /^\d+(\.\d+){1,2}$/;
const BUILD_VERSION = /^[0-9A-Za-z]{3,12}$/;
const isSeen = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && typeof v.osVersion === 'string' && OS_VERSION.test(v.osVersion)
  && (v.buildVersion === null || (typeof v.buildVersion === 'string' && BUILD_VERSION.test(v.buildVersion)))
  && typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at))
  && (v.via === undefined || VIAS.includes(v.via));

// Lab Focus (issue 16): the owner's own Focus "Lab" and two Shortcuts that turn it on and off; the lab runs the shortcuts by name
// through the Shortcuts app. `lab phone setup --focus on|off --focus-on-shortcut <name> --focus-off-shortcut <name>` saves
// `state.phone.focus = { enabled?, onShortcut?, offShortcut? }`; what is left out is the default. On by default.
export const FOCUS_BUNDLE = 'com.apple.shortcuts'; // the Shortcuts app (not is.workflow.my.app, which a phone reports as not installed)
export const FOCUS_DEFAULT = Object.freeze({ enabled: true, onShortcut: 'Lab Focus On', offShortcut: 'Lab Focus Off' });
// Letters, digits, space, dot, hyphen, underscore: nothing that needs more than a space escaped in the shortcuts:// URL.
export const isShortcutName = s => typeof s === 'string' && /^[A-Za-z0-9 ._-]{1,60}$/.test(s) && s.trim() === s;
const isFocus = f => f !== null && typeof f === 'object' && !Array.isArray(f)
  && Object.keys(f).every(k => ['enabled', 'onShortcut', 'offShortcut'].includes(k))
  && (f.enabled === undefined || typeof f.enabled === 'boolean')
  && (f.onShortcut === undefined || isShortcutName(f.onShortcut))
  && (f.offShortcut === undefined || isShortcutName(f.offShortcut));

// The saved phone (state.phone = { udid, teamId, bundleId, wdaExpires?, keyboard?, focus?, seen? }), or null
// when none; throws when the record is not the right shape. `seen` is the iOS version the phone
// last reported to `lab up` or `lab phone setup`: { osVersion, buildVersion, at, via? } (`via`: how it was last
// reached, 'tunnel' for Wi-Fi or 'usbmux' for the cable; records from before it have none).
export function readPhone(state) {
  const p = state?.phone;
  if (p === undefined || p === null) return null;
  const ok = typeof p === 'object' && !Array.isArray(p)
    && isUdid(p.udid) && isTeamId(p.teamId) && isBundleId(p.bundleId)
    && (p.wdaExpires === undefined || (typeof p.wdaExpires === 'string' && !Number.isNaN(Date.parse(p.wdaExpires))))
    && (p.keyboard === undefined || isKeyboard(p.keyboard))
    && (p.focus === undefined || isFocus(p.focus))
    && (p.seen === undefined || isSeen(p.seen));
  if (!ok) throw new Error('the saved phone record is damaged: run `lab phone forget`, then `lab phone setup`');
  return { ...p };
}

// The record with the iOS version the phone just reported, when it reported one (an unreadable
// version leaves the last one in place). `via` is how it was reached: a status that was not
// reachable has none, and keeps the one the phone was last reached by.
export const withSeen = (rec, status, now = Date.now()) => {
  if (!status?.osVersion) return rec;
  const via = VIAS.includes(status.via) ? status.via : rec?.seen?.via;
  return { ...rec, seen: { osVersion: status.osVersion, buildVersion: status.buildVersion ?? null, at: new Date(now).toISOString(), ...(via ? { via } : {}) } };
};

// A phone that is not reachable and was last reached over Wi-Fi is a lost route, not a missing cable:
// `needs: cable` becomes `tunnel` (the Wi-Fi steps). A cable-seen phone, or one now on the cable, keeps `cable`.
export function withRoute(status, rec) {
  if (!status || status.reachable || status.needs !== 'cable' || status.transport === 'cable' || rec?.seen?.via !== 'tunnel') return status;
  return { ...status, needs: 'tunnel', error: `${status.error ?? 'the phone is not reachable'} (last reached over Wi-Fi)` };
}

// What the keyboard settings are set to when a device session ends: the saved target, both on
// when the record has none (or is unreadable: ending a session must not depend on it).
export function keyboardTarget(state) {
  let k;
  try { k = readPhone(state)?.keyboard; } catch { k = undefined; }
  return { ...KEYBOARD_DEFAULT, ...(k ?? {}) };
}

// The Lab Focus settings of a saved phone, with the defaults filled in (a damaged record gives the defaults too).
export function focusConfig(phone) {
  return { ...FOCUS_DEFAULT, ...(isFocus(phone?.focus) ? phone.focus : {}) };
}

// The team is stored by `lab phone setup`, never written in code. The default bundle id carries
// the first four characters of the team so two teams don't collide on one Mac.
export function defaultBundleId(team) {
  if (!isTeamId(team)) throw new Error(`defaultBundleId: "${team}" is not a team id (10 letters or digits)`);
  return `com.dividedby.msl-wda-${team.slice(0, 4).toLowerCase()}`;
}

// A path or text from a command, with device ids and host names removed, one line, short.
export function redactMessage(text, max = 400) {
  const s = String(text ?? '')
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g, '<udid>')
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, '<id>')
    .replace(/[\w.-]+\.coredevice\.local\b/g, '<host>')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// --- devicectl ---

const NEVER_CONNECTED = /connection to this device could not be established/i;

// Runs `xcrun devicectl <args> --json-output <temp file>` and returns the exit result and the
// parsed file (undefined when the command wrote none). The temp folder is always removed.
// With `{ retry: true }` a call that failed with NEVER_CONNECTED (devicectl could not establish the connection: the first call after the
// phone idled on Wi-Fi, issue 81) is made once more, at once and with the same time limit. Only callers whose command is read-only or sets a
// state idempotently pass it: devicectl's text does not prove the command never reached the phone, so a call with an effect that a
// second run would repeat (a Safari launch opens another tab; a signal) never does. A timeout and any other failure are never retried.
function devicectl(args, timeoutMs, { retry = false } = {}) {
  const first = devicectlOnce(args, timeoutMs);
  if (!retry || first.r.code === 0 || first.r.code === 124 || !NEVER_CONNECTED.test(failureText(first))) return first;
  return devicectlOnce(args, timeoutMs);
}

function devicectlOnce(args, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-devicectl-'));
  const out = path.join(dir, 'out.json');
  try {
    const r = run('xcrun', ['devicectl', ...args, '--json-output', out], { allowFail: true, timeoutMs });
    let json;
    try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none, or not JSON */ }
    return { r, json };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The text of a failed devicectl call: what it printed plus the error it wrote to the JSON file, redacted but whole. `classify` and
// `isAppLimit` read this (the pattern for installd's free-app limit sits past char 400 of a real message); what is shown is
// `redactMessage` of it, which cuts it short.
function failureText({ r, json }) {
  const err = json?.error;
  const fromJson = err ? `${err.domain ?? ''} error ${err.code ?? ''} ${err.userInfo?.NSDescription?.string ?? err.userInfo?.NSLocalizedDescription?.string ?? ''}` : '';
  return redactMessage(`${(r.stderr || r.stdout || '').trim()} ${fromJson}`, Infinity);
}

const matching = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

const TRANSPORT = { wired: 'cable', localNetwork: 'wifi' };

// The physical iPhones/iPads in `devicectl list devices` JSON (simulators and other platforms are
// dropped). A listed phone is NOT necessarily reachable: the list keeps saying "connected" after
// Wi-Fi is switched off and the cable is pulled, so reachability comes from `phoneStatus`.
export function parseDevices(json) {
  const list = json?.result?.devices;
  if (!Array.isArray(list)) throw new Error('devicectl list devices: unexpected output (no result.devices)');
  return list
    .filter(d => d?.hardwareProperties?.reality === 'physical' && d.hardwareProperties.platform === 'iOS')
    .map(d => ({
      udid: d.hardwareProperties.udid,
      name: d.deviceProperties?.name ?? null,
      transport: TRANSPORT[d.connectionProperties?.transportType] ?? 'unknown',
      tunnelState: d.connectionProperties?.tunnelState ?? null,
      pairingState: d.connectionProperties?.pairingState ?? null,
      developerMode: d.deviceProperties?.developerModeStatus === 'enabled' ? true : d.deviceProperties?.developerModeStatus === 'disabled' ? false : null,
      osVersion: matching(d.deviceProperties?.osVersionNumber, OS_VERSION),
      buildVersion: matching(d.deviceProperties?.osBuildUpdate, BUILD_VERSION),
    }));
}

// Whether `devicectl list devices` lists the phone at all (after a CoreDeviceService restart).
export function deviceListed(udid) {
  const res = devicectl(['list', 'devices'], WAIT.listMs, { retry: true });
  try { return parseDevices(res.json).some(d => d.udid === udid); } catch { return false; }
}

// `devicectl device info lockState`: { ok: true, locked } or { ok: false, error, needs } (a phone that
// is off, asleep on another network or unplugged fails here after the timeout).
export function lockState(udid) {
  if (!isUdid(udid)) throw new Error(`lockState: "${udid}" is not a device UDID`);
  const res = devicectl(['device', 'info', 'lockState', '--device', udid], WAIT.lockMs, { retry: true });
  const passcode = res.json?.result?.passcodeRequired;
  if (res.r.code === 0 && typeof passcode === 'boolean') return { ok: true, locked: passcode };
  const text = res.r.code === 124 ? `devicectl lockState timed out after ${Math.round(WAIT.lockMs / 1000)}s` : failureText(res) || `devicectl lockState failed (exit ${res.r.code})`;
  return { ok: false, error: redactMessage(text), needs: classify(text) }; // `needs` from the whole text, not the cut `error`
}

// --- appearance and orientation (devicectl, Xcode 27; no WebDriverAgent session needed) ---

export const APPEARANCES = ['light', 'dark'];
export const FLAT_ORIENTATIONS = ['faceUp', 'faceDown'];
export const UPRIGHT_ORIENTATIONS = ['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight'];
export const ORIENTATIONS = [...UPRIGHT_ORIENTATIONS, ...FLAT_ORIENTATIONS];

// `result` of `devicectl device info appearance` / `settings appearance`: "light" or "dark", else null.
// The phone's Automatic setting is not in the output, so it can't be read.
export function parseAppearance(result) {
  const v = typeof result?.userInterfaceStyle === 'string' ? result.userInterfaceStyle.toLowerCase() : null;
  return APPEARANCES.includes(v) ? v : null;
}

// `result` of `devicectl device orientation get`: { deviceOrientation, nonFlat } or null. `nonFlat` is the
// last upright reading (what the interface follows when the phone lies flat); null when the phone gave none.
// `deviceIsOrientationLocked` is not read: it said false with Portrait Orientation Lock on.
export function parseOrientation(result) {
  const o = result?.deviceOrientation;
  if (!ORIENTATIONS.includes(o)) return null;
  const nf = result.deviceOrientationNonFlat;
  return { deviceOrientation: o, nonFlat: UPRIGHT_ORIENTATIONS.includes(nf) ? nf : UPRIGHT_ORIENTATIONS.includes(o) ? o : null };
}

// One devicectl call on the saved phone: { ok: true, result } or { ok: false, error, needs } (a locked or
// unreachable phone is `unlock` / `cable`, classified from the text).
function displayCall(udid, what, args) {
  if (!isUdid(udid)) throw new Error(`${what}: "${udid}" is not a device UDID`);
  const res = devicectl(args, WAIT.displayMs, { retry: true });
  if (res.r.code === 0) return { ok: true, result: res.json?.result };
  const text = res.r.code === 124 ? `devicectl ${what} timed out after ${Math.round(WAIT.displayMs / 1000)}s` : failureText(res) || `devicectl ${what} failed (exit ${res.r.code})`;
  return { ok: false, error: redactMessage(text), needs: classify(text) };
}

const unreadable = what => ({ ok: false, error: `devicectl ${what} printed output the lab does not recognise (Xcode 27 or newer is needed)`, needs: 'unknown' });

// All four return { ok: true, value } or { ok: false, error, needs }. Every call passes the saved UDID.
export function getAppearance(udid) {
  const r = displayCall(udid, 'info appearance', ['device', 'info', 'appearance', '--device', udid]);
  if (!r.ok) return r;
  const value = parseAppearance(r.result);
  return value ? { ok: true, value } : unreadable('info appearance');
}

// Only `--mode` is passed: `settings appearance` also reaches text size, contrast and the Liquid Glass look.
export function setAppearance(udid, mode) {
  if (!APPEARANCES.includes(mode)) throw new Error(`setAppearance: "${mode}" is not light or dark`);
  const r = displayCall(udid, 'settings appearance', ['device', 'settings', 'appearance', '--device', udid, '--mode', mode]);
  return r.ok ? { ok: true, value: parseAppearance(r.result) } : r;
}

export function getOrientation(udid) {
  const r = displayCall(udid, 'orientation get', ['device', 'orientation', 'get', '--device', udid]);
  if (!r.ok) return r;
  const value = parseOrientation(r.result);
  return value ? { ok: true, value } : unreadable('orientation get');
}

// A phone with Portrait Orientation Lock on takes this silently (exit 0, nothing changes): read it back.
export function setOrientation(udid, orientation) {
  if (!ORIENTATIONS.includes(orientation)) throw new Error(`setOrientation: "${orientation}" is not one of ${ORIENTATIONS.join(', ')}`);
  const r = displayCall(udid, 'orientation set', ['device', 'orientation', 'set', orientation, '--device', udid]);
  return r.ok ? { ok: true, value: orientation } : r;
}

// Whether this Mac's devicectl has the appearance and orientation commands (Xcode 27): each one's `--help` must
// exit 0. Nothing is sent to a phone. Returns { ok, missing: [the subcommands that failed] }; `sim doctor` reports it
// as `phoneDisplay` and never fails on it.
export const DISPLAY_COMMANDS = [['device', 'info', 'appearance'], ['device', 'settings', 'appearance'], ['device', 'orientation', 'get'], ['device', 'orientation', 'set']];
export function displaySupported() {
  const missing = DISPLAY_COMMANDS.filter(c => run('xcrun', ['devicectl', ...c, '--help'], { allowFail: true, timeoutMs: WAIT.helpMs }).code !== 0).map(c => c.join(' '));
  return { ok: missing.length === 0, missing };
}

// --- Lab Focus: a named shortcut run through the Shortcuts app ---

export const shortcutUrl = name => `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;

// Runs the owner's shortcut `name` on the saved phone: `devicectl device process launch --device <udid> --payload-url
// shortcuts://run-shortcut?name=<encoded> com.apple.shortcuts`. devicectl says success on a LOCKED phone while iOS shows a
// passcode prompt and does not run the shortcut, so the lock state is read first and a locked phone is never launched
// onto (no surprise passcode prompt, e.g. at the idle stop). Delivery is all that is confirmed, not the effect.
// Returns { ok: true } or { ok: false, error, needs, maybeSent? } (`maybeSent`: it timed out, so it may have run).
// The Shortcuts app is left in front: anything that must be in front afterwards (the lab's Safari tab) is opened after.
export function runShortcut(udid, name) {
  if (!isUdid(udid)) throw new Error(`runShortcut: "${udid}" is not a device UDID`);
  if (!isShortcutName(name)) throw new Error(`runShortcut: "${name}" is not a shortcut name (letters, digits, space, dot, hyphen and underscore, up to 60)`);
  const lock = lockState(udid);
  if (!lock.ok) return { ok: false, error: lock.error, needs: lock.needs };
  if (lock.locked) return { ok: false, error: 'the phone is locked: the lab does not run a shortcut on a locked phone (iOS would ask for the passcode and not run it)', needs: 'unlock' };
  const res = devicectl(['device', 'process', 'launch', '--device', udid, '--payload-url', shortcutUrl(name), FOCUS_BUNDLE], WAIT.shortcutMs, { retry: true });
  if (res.r.code === 0) return { ok: true };
  const timedOut = res.r.code === 124;
  const text = timedOut ? `devicectl launch timed out after ${Math.round(WAIT.shortcutMs / 1000)}s` : failureText(res) || `devicectl launch failed (exit ${res.r.code})`;
  const needs = classify(text);
  return { ok: false, error: redactMessage(text), needs: needs === 'unknown' ? 'shortcut' : needs, ...(timedOut ? { maybeSent: true } : {}) };
}

// Lab Focus on or off by running the saved phone's shortcut for it. { ok: true, value } or the failure of runShortcut.
// `entry` is the ledger entry being put back: the Off shortcut named in it (the one saved when On ran) is the one run,
// so a rename in between does not matter; an old entry without a name uses the current setting.
export function setFocus(udid, value, phone, entry) {
  if (value !== 'on' && value !== 'off') throw new Error(`setFocus: "${value}" is not on or off`);
  const cfg = focusConfig(phone);
  const r = runShortcut(udid, value === 'on' ? cfg.onShortcut : entry?.off ?? cfg.offShortcut);
  return r.ok ? { ok: true, value } : r;
}

// --- the usbmux listing (what Appium sees) ---

// Over the cable Appium finds the phone through usbmuxd, not CoreDevice, and the two can disagree
// (usbmux lists nothing while CoreDevice still reaches the phone). The check runs appium-ios-device
// from the managed Appium install in a small `node` process. It reads the raw usbmuxd list,
// because `getConnectedDevices` dedupes and drops each entry's ConnectionType ("USB" or
// "Network"). Returns { listed, types, error? }: `types` are the connection types seen for the UDID.
// Only a "USB" entry matters: Wi-Fi goes through the lab's own tunnel (tunnel.js), so usbmux's
// "Network" entries are ignored.
const USBMUX_SCRIPT = [
  'const { createRequire } = require("node:module");',
  'const { Usbmux, getDefaultSocket } = createRequire(process.argv[1])("appium-ios-device/build/lib/usbmux");',
  '(async () => {',
  '  const mux = new Usbmux(await getDefaultSocket());',
  '  try { return await mux.listDevices(); } finally { mux.close(); }',
  '})().then(',
  '  l => { process.stdout.write("MSL_USBMUX:" + JSON.stringify(l.map(d => ({ udid: d.Properties.SerialNumber, type: d.Properties.ConnectionType }))) + "\\n"); },',
  '  e => { process.stderr.write(String((e && e.message) || e)); process.exit(1); });',
].join('\n');

export function usbmuxListed(udid) {
  const driver = path.join(appiumHome(), 'node_modules', 'appium-xcuitest-driver', 'package.json');
  const r = run(process.execPath, ['-e', USBMUX_SCRIPT, driver], { allowFail: true, timeoutMs: WAIT.usbmuxMs });
  if (r.code !== 0) return { listed: false, types: [], error: redactMessage(`usbmux check failed: ${r.stderr || r.stdout}`) };
  const line = String(r.stdout).split('\n').find(l => l.startsWith('MSL_USBMUX:'));
  let entries;
  try { entries = JSON.parse(line.slice('MSL_USBMUX:'.length)); } catch { entries = null; }
  if (!Array.isArray(entries)) return { listed: false, types: [], error: 'usbmux check failed: unreadable output' };
  const types = [...new Set(entries.filter(e => e?.udid === udid).map(e => (typeof e.type === 'string' ? e.type : 'unknown')))];
  return { listed: types.length > 0, types };
}

let usbmuxCheck = usbmuxListed;
// Tests (and callers that fake the phone) swap the check; it takes a UDID and returns a boolean
// or { listed, types?, error? }. `setUsbmux()` restores the real one.
export const setUsbmux = fn => { usbmuxCheck = fn ?? usbmuxListed; };

// What we know about the saved phone, from live calls:
//   { udid, found, name, transport, via, tunnelState, pairingState, developerMode, osVersion, buildVersion,
//     usbmux, usbmuxTypes, locked, reachable, error?, needs? }
// `reachable` is true only when lockState answered AND the route works; the device list alone is
// stale. A listed USB entry in usbmux is the cable: `transport` "cable", `via` "usbmux" (Appium
// reaches the phone through usbmuxd). Otherwise a phone that CoreDevice lists on the network and
// that answered lockState is `transport` "wifi", `via` "tunnel" (the lab opens the tunnel itself:
// usbmux's Network entries are ignored). `usbmux` is whether usbmux lists the phone at all and
// `usbmuxTypes` the connection types it gave. When not reachable, `needs` says why (classified)
// and `error` has the redacted text.
export function phoneStatus(udid, { usbmux } = {}) {
  if (!isUdid(udid)) throw new Error(`phoneStatus: "${udid}" is not a device UDID`);
  const base = { udid, found: false, name: null, transport: 'unknown', via: null, tunnelState: null, pairingState: null, developerMode: null, osVersion: null, buildVersion: null, usbmux: false, usbmuxTypes: [], locked: null, reachable: false };
  const fail = (extra, text) => ({ ...base, ...extra, error: redactMessage(text), needs: classify(text) });

  const res = devicectl(['list', 'devices'], WAIT.listMs, { retry: true });
  let devices;
  try { devices = parseDevices(res.json); } catch (e) {
    return fail({}, res.r.code === 0 ? e.message : failureText(res) || `devicectl list devices failed (exit ${res.r.code})`);
  }
  const d = devices.find(x => x.udid === udid);
  if (!d) return { ...base, error: 'the saved phone is not in `devicectl list devices` (unplugged, off, or on another network)', needs: 'cable' };
  const known = { ...base, ...d, udid, found: true };
  if (d.pairingState !== 'paired') return { ...known, error: `the phone's pairing state is "${d.pairingState}"`, needs: 'trust' };

  const lock = lockState(udid);
  if (!lock.ok) {
    const needs = lock.needs;
    return { ...known, error: lock.error, needs: needs === 'unknown' ? 'cable' : needs }; // a phone that won't answer is out of reach
  }
  const listed = (usbmux ?? usbmuxCheck)(udid);
  const mux = typeof listed === 'boolean' ? { listed } : listed;
  const types = Array.isArray(mux.types) ? mux.types : [];
  const withLock = { ...known, locked: lock.locked, usbmux: mux.listed === true, usbmuxTypes: types };
  if (types.includes('USB') || (mux.listed === true && d.transport === 'cable' && !types.includes('Network'))) { // a listing with no connection type: the device list says it is wired
    return { ...withLock, transport: 'cable', via: 'usbmux', reachable: true };
  }
  if (d.transport === 'wifi') return { ...withLock, transport: 'wifi', via: 'tunnel', reachable: true };
  return { ...withLock, error: mux.error ?? 'usbmux does not list the phone (Unknown device or simulator UDID); Appium cannot reach it', needs: 'cable' };
}

// --- WebDriverAgent signing expiry ---

export const wdaDerivedData = () => path.join(appiumHome(), 'wda-device');

// The runner app under <derivedData>/Build/Products/*/ (the WebDriverAgentRunner one first) that carries a
// provisioning profile: its folder, or null when there is no build.
export function runnerApp(derivedData = wdaDerivedData()) {
  const products = path.join(derivedData, 'Build', 'Products');
  try {
    for (const cfg of fs.readdirSync(products).sort()) {
      let apps;
      try { apps = fs.readdirSync(path.join(products, cfg)).filter(n => n.endsWith('.app')).sort(); } catch { continue; }
      apps.sort((a, b) => Number(b.includes('WebDriverAgentRunner')) - Number(a.includes('WebDriverAgentRunner')));
      for (const app of apps) {
        if (fs.existsSync(path.join(products, cfg, app, 'embedded.mobileprovision'))) return path.join(products, cfg, app);
      }
    }
  } catch { return null; }
  return null;
}

// The runner app's provisioning profile: its expiry as an ISO string, or null when there is no build or the profile can't be read.
export function profileExpiry(derivedData = wdaDerivedData()) {
  const app = runnerApp(derivedData);
  if (!app) return null;
  const r = run('security', ['cms', '-D', '-i', path.join(app, 'embedded.mobileprovision')], { allowFail: true, timeoutMs: WAIT.profileMs });
  if (r.code !== 0) return null;
  const m = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(r.stdout);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// --- the WebDriverAgent runner on the phone (slot lending, issue 63) ---

// The runner's bundle id, from the saved phone only (never guessed from a listing).
export const runnerId = phone => `${phone.bundleId}.xctrunner`;
// The bundle ids sideload's apps carry: never touched by the lab.
export const SIDELOAD_APP_PREFIX = 'io.github.dividedby.free.';

// Whether the phone has app `id` installed: { ok: true, present } or { ok: false, error, needs }. One bounded `devicectl device info apps`,
// asked for the one bundle id and checked here again; an output the lab does not recognise is a failure, never "absent".
export function appListed(udid, id) {
  if (!isUdid(udid)) throw new Error(`appListed: "${udid}" is not a device UDID`);
  if (!isBundleId(id)) throw new Error(`appListed: "${id}" is not a bundle id`);
  const res = devicectl(['device', 'info', 'apps', '--device', udid, '--bundle-id', id], WAIT.appsMs, { retry: true });
  const apps = res.json?.result?.apps;
  if (res.r.code === 0 && Array.isArray(apps)) return { ok: true, present: apps.some(a => a?.bundleIdentifier === id) };
  if (res.r.code === 0) return { ok: false, error: 'devicectl info apps printed output the lab does not recognise (no result.apps)', needs: 'unknown' };
  const text = res.r.code === 124 ? `devicectl info apps timed out after ${Math.round(WAIT.appsMs / 1000)}s` : failureText(res) || `devicectl info apps failed (exit ${res.r.code})`;
  return { ok: false, error: redactMessage(text), needs: classify(text) };
}

// Takes the WebDriverAgent runner off the phone: only `<saved bundle id>.xctrunner`, and never an app of sideload's.
// { ok: true } or { ok: false, error, needs }.
export function uninstallRunner(udid, phone) {
  if (!isUdid(udid)) throw new Error(`uninstallRunner: "${udid}" is not a device UDID`);
  if (!phone || !isBundleId(phone.bundleId)) throw new Error('uninstallRunner: the saved phone has no bundle id');
  const id = runnerId(phone);
  if (id.startsWith(SIDELOAD_APP_PREFIX)) throw new Error(`uninstallRunner: "${id}" is one of sideload's apps; the lab never uninstalls those`);
  const res = devicectl(['device', 'uninstall', 'app', '--device', udid, id], WAIT.uninstallMs, { retry: true });
  if (res.r.code === 0) return { ok: true };
  const text = res.r.code === 124 ? `devicectl uninstall timed out after ${Math.round(WAIT.uninstallMs / 1000)}s` : failureText(res) || `devicectl uninstall failed (exit ${res.r.code})`;
  return { ok: false, error: redactMessage(text), needs: classify(text) };
}

// Puts a built runner app on the phone. { ok: true } or { ok: false, error, needs, limit } (`limit`: installd refused with its
// free-app limit, which is definite and changes nothing). Not used until the lend step (issue 63, second change).
export function installRunner(udid, appPath) {
  if (!isUdid(udid)) throw new Error(`installRunner: "${udid}" is not a device UDID`);
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath) || !appPath.endsWith('.app')) throw new Error(`installRunner: "${appPath}" is not an absolute path to an .app`);
  const res = devicectl(['device', 'install', 'app', '--device', udid, appPath], WAIT.installMs, { retry: true });
  if (res.r.code === 0) return { ok: true };
  const text = res.r.code === 124 ? `devicectl install timed out after ${Math.round(WAIT.installMs / 1000)}s` : failureText(res) || `devicectl install failed (exit ${res.r.code})`;
  return { ok: false, error: redactMessage(text), needs: classify(text), limit: isAppLimit(text) };
}

export function hoursLeft(expires, now = Date.now()) {
  const t = Date.parse(expires ?? '');
  return Number.isNaN(t) ? null : Math.round(((t - now) / 3600e3) * 10) / 10;
}

// Whether the WDA build must be deleted and re-signed before a device session: forced, never
// recorded, unreadable, or less than 24 h left. `rec` is state.phone.
export function needsResign(rec, now = Date.now(), force = false) {
  if (force) return true;
  const t = Date.parse(rec?.wdaExpires ?? '');
  return Number.isNaN(t) || t - now < RESIGN_WITHIN_MS;
}

// --- failures: needs values, steps, classifier ---

// Every unattended device failure carries one of these. `human` is what a person does;
// `then` is what the agent runs afterwards; `or` is the way out without the phone.
export const NEEDS = {
  setup: { human: ['Run `lab phone setup --udid <phone UDID> --team <10-character team id>` once to save the phone.'], then: 'lab phone setup --udid <UDID> --team <TEAM>' },
  'xcode-account': { human: ['On the Mac, open Xcode > Settings > Accounts and sign in with the Apple ID used for the lab (a free account works).', 'Make sure the account has an Apple Development certificate (Manage Certificates > +).'], then: 'lab up --target device' },
  keychain: { human: ['At the Mac itself (not over SSH), run `lab up --target device` and click Always Allow when the keychain prompt for codesign appears.'], then: 'lab up --target device' },
  'developer-mode': { human: ['On the phone: Settings > Privacy & Security > Developer Mode, turn it on, restart the phone and confirm.'], then: 'lab up --target device' },
  trust: { human: ['Unlock the phone, connect the cable and tap Trust This Computer.', 'On the phone: Settings > General > VPN & Device Management, open the developer profile and tap Trust.'], then: 'lab up --target device' },
  unlock: { human: ['Unlock the phone and keep it awake while the lab runs (Settings > Display & Brightness > Auto-Lock).'], then: 'lab up --target device' },
  passcode: { human: ['Enter the passcode on the phone when it asks to enable UI automation.'], then: 'lab up --target device' },
  cable: { human: ['Connect the phone to the Mac with a cable, unlock it, and tap Trust if asked.', 'Or, once the phone has been paired over the cable, put it on the same Wi-Fi network as the Mac.', 'If the phone is already connected and this came right after it sat idle, run the command below again: the connection to it dropped.'], then: 'lab up --target device' },
  resign: { human: ['The lab app\'s signing expired or was rejected. With the phone unlocked, run the command below to sign it again.', 'If a re-sign doesn\'t fix it, Apple is rejecting this team: run `lab phone setup` with another team.'], then: 'lab up --target device --resign', or: 'lab phone setup --udid <UDID> --team <ID>' },
  'tunnel-tool': { human: [`Wi-Fi needs the pymobiledevice3 tool, version ${PMD3_FLOOR} or newer, and it is missing or too old.`, 'Run `brew install uv` if uv is not installed, then `uv tool install --python 3.14 pymobiledevice3` (to upgrade: `uv tool upgrade pymobiledevice3`).', 'Or connect the phone with a cable.'], then: 'lab up --target device' },
  tunnel: { human: ['The Mac could not open a route to the phone over Wi-Fi: no tunnel within 45 s, it dropped, or it reached another device.', 'Unlock the phone and keep it on the same Wi-Fi network as the Mac. If the error names a refused, timed-out or no-route connection, check for a VPN, a different network or band, or the phone\'s Wi-Fi asleep.', 'Run the command below again, or connect the phone with a cable.'], then: 'lab up --target device' },
  slots: { human: ['A free Apple account allows 3 apps (or 10 new app IDs a week) on the phone. Delete an app you don\'t need, such as an old lab runner, then run the command below.'], then: 'lab up --target device' },
  busy: { human: ['sideload is signing or installing an app with the same Apple team; try again in a minute.'], then: 'lab up --target device' },
  tab: { human: ['The lab can\'t confirm that its own Safari tab on the phone is the one showing (it was switched away from, closed, or replaced). Nothing was read from any other tab.', 'Switch back to the lab\'s tab (the one the lab opened), or run the command below: it ends this session and opens a new one.'], then: 'safari start' },
  service: { human: ['Appium isn\'t running with up-to-date log redaction, so page URLs, titles, script arguments or typed text could reach its log (at debug level, command results too).', 'Run `lab service install` (again, if the log-filter rules are out of date): it starts Appium with a log that leaves out page URLs, titles, script arguments and typed text.'], then: 'lab service install' },
  shortcut: { human: [
    'The lab could not run its Lab Focus shortcut on the phone. Check that the Shortcuts app is installed, and that you made the Focus and the two shortcuts (once):',
    'On the phone: Settings > Focus > + > Custom, name it "Lab" and choose who may still notify you.',
    'Shortcuts > + : name it "Lab Focus On", add the action Set Focus, set it to Turn Lab On Until Turned Off.',
    'Shortcuts > + : name it "Lab Focus Off", add the action Set Focus, set it to Turn Lab Off.',
    'The shortcut names are the defaults; others are saved with `lab phone setup --focus-on-shortcut "<name>" --focus-off-shortcut "<name>"`. `lab up --no-focus` skips Lab Focus for one run.',
  ], then: 'lab up --target device' },
  unknown: { human: ['Read the error above. `lab phone status` shows what the Mac can see of the phone.'], then: 'lab phone status' },
};

// The `trust` texts, in two groups. Evidence in PROFILE_TRUST alone means the app is installed but the
// developer profile is not trusted yet: the Mac is already trusted, so "connect the cable and tap Trust
// This Computer" is wrong (needsError gives only the profile step).
const PROFILE_TRUST = [/has not been explicitly trusted/i, /Developer App Certificate .*is not trusted/i, /untrusted developer/i];
const COMPUTER_TRUST = [/not been trusted/i, /trust this computer/i, /pairing .*(denied|rejected|required)/i];

// A dropped CoreDevice control channel (issue 81): `cable` when it persists. Only NEVER_CONNECTED (above) is ever retried.
const DROPPED_CHANNEL = [/CoreDeviceError\W+(error\W+)?4000\b/i, NEVER_CONNECTED, /ControlChannelConnectionError/i, /Connection was invalidated/i];

// First match wins, so specific texts come before general ones. Patterns come from real
// failures (see test/fixtures/phone) and from Apple's documented error texts.
const PATTERNS = [
  ['passcode', [/Timed out while enabling automation mode/i]],
  ['unlock', [/passcodeRequired\W+true/i, /device (is|was) (currently )?locked/i, /could not be,? unlocked/i, /\bDeviceLocked\b/i]],
  ['keychain', [/errSecInternalComponent/i, /User interaction is not allowed/i, /\bkeychain\b/i]],
  ['slots', [/maximum number of (installed )?apps/i, /reached the maximum number/i, /cannot register more than \d+ App IDs/i, /free (development )?provisioning.*(limit|maximum)/i, /App ID limit/i]],
  ['developer-mode', [/developer mode (is )?(disabled|not enabled|turned off|off)/i, /enable developer mode/i, /developer mode.*required/i]],
  ['trust', [...PROFILE_TRUST, ...COMPUTER_TRUST]],
  ['resign', [/0xe8008018/i, /0xe8008024/i, /0xe8008015/i, /profile (has )?expired/i, /provisioning profile .*(no longer valid|expired)/i, /identity used to sign .*no longer valid/i]],
  ['xcode-account', [/\bbanned\b/i, /No Account for Team/i, /No signing certificate/i, /No profiles for/i, /Failed Registering Bundle Identifier/i]],
  ['cable', [/Unknown device or simulator UDID/i, /CoreDeviceError\W+(error\W+)?4016\b/i, /usage assertion requirements/i, /NWError\W+(error\W+)?60\b/i, /devicectl\b.*timed out/i, ...DROPPED_CHANNEL]],
];

// Whether an install failure is installd's free-app limit (the phone holds as many apps from a free account as it allows), as opposed to
// the App-ID-per-week limit, which is `slots` too but which no slot lend can fix. The first pattern is sideload's, the second the lab's own.
const APP_LIMIT = [/maximum number of (installed )?apps (using|with|for) (a )?free (developer |development )?profiles?/i, /maximum number of (installed )?apps/i];
export const isAppLimit = text => APP_LIMIT.some(re => re.test(String(text ?? ''))) && !/App ID/i.test(String(text ?? ''));

export function classify(text) {
  const s = String(text ?? '');
  for (const [needs, res] of PATTERNS) if (res.some(re => re.test(s))) return needs;
  return 'unknown';
}

// A run whose tab guard has stopped trusting the phone (`tainted`) can't be fixed by switching
// back to a tab, so its steps differ from those of a tab that is merely hidden.
const TAB_TAINTED_HUMAN = ['The lab lost track of its own Safari tab on the phone (the session moved to another page, or the tab changed under it), so it stopped reading the phone. Nothing was read from any other tab.', 'Run `safari start` (the command below): the lab will open a fresh tab. Close the old lab tab on the phone by hand.'];

const profileTrustOnly = text => PROFILE_TRUST.some(re => re.test(text)) && !COMPUTER_TRUST.some(re => re.test(text));
const PROFILE_TRUST_HUMAN = NEEDS.trust.human.slice(1);

// The Error to throw for a device failure: `cli` and `lab` merge `.extra` into their JSON, so the
// output is { ok: false, error, needs, human, then, or }. `tainted` picks the steps of a "tab"
// failure that ended the run's trust in the phone. `evidence` is the text `needs` was read from
// when that is not `error` itself (a log's tail): it picks the steps of a `trust`.
export function needsError(needs, error, { tainted = false, evidence = error } = {}) {
  let n = NEEDS[needs];
  if (needs === 'tab' && tainted) n = { ...NEEDS.tab, human: TAB_TAINTED_HUMAN };
  if (needs === 'trust' && profileTrustOnly(String(evidence ?? ''))) n = { ...n, human: PROFILE_TRUST_HUMAN };
  if (!n) throw new Error(`needsError: unknown needs value "${needs}" (one of ${Object.keys(NEEDS).join(', ')})`);
  const e = new Error(redactMessage(error));
  // `or` is the way out without this fix; resign's is another team, so the simulator route is then its own field.
  e.extra = { needs, human: [...n.human], then: n.then, or: n.or ?? SIMULATOR_FALLBACK, ...(n.or ? { simulator: SIMULATOR_FALLBACK } : {}) };
  return e;
}

// A `slots` failure about the slot lending (issue 63): `human` replaces the generic steps (a list of lines), and sideload's `fix` (redacted)
// is the last line. Same shape as needsError's.
export function slotsError(error, { human = NEEDS.slots.human, fix } = {}) {
  const e = needsError('slots', error);
  e.extra.human = [...human, ...(fix ? [redactMessage(fix, 300)] : [])];
  return e;
}

// --- target selection ---

export const TARGETS = ['auto', 'device', 'simulator'];

// `flag` is --target (auto when absent), `phone` is state.phone (or undefined), `status` is the
// result of `phoneStatus` (needed only when there is a phone). Returns { target, why } or throws
// a needs error: auto with no phone record picks the simulator; auto and explicit device need a
// reachable, unlocked, developer-mode phone; explicit simulator is always honoured.
export function chooseTarget({ flag, phone, status } = {}) {
  const mode = flag ?? 'auto';
  if (!TARGETS.includes(mode)) throw new Error(`--target must be one of ${TARGETS.join(', ')} (got "${mode}")`);
  if (mode === 'simulator') return { target: 'simulator', why: '--target simulator' };
  if (!phone) {
    if (mode === 'auto') return { target: 'simulator', why: 'no phone saved' };
    throw needsError('setup', 'no phone is saved, so --target device has nothing to drive');
  }
  if (!status) throw new Error('chooseTarget: a saved phone needs its phoneStatus');
  const why = mode === 'device' ? '--target device' : 'saved phone is reachable and unlocked';
  if (!status.reachable) throw needsError(status.needs ?? 'cable', status.error ?? 'the saved phone is not reachable');
  if (status.developerMode === false) throw needsError('developer-mode', 'Developer Mode is off on the phone');
  if (status.locked) throw needsError('unlock', 'the phone is locked (a passcode is required)');
  return { target: 'device', why };
}

// --- the run's own Safari tab ---

export const newTabTag = () => `msl-${crypto.randomBytes(4).toString('hex')}`;

// Launches Safari on the saved phone at a page whose URL carries `tag`, restarting Safari
// (--terminate-existing; its tabs are kept) so the new tab gets the lowest page id.
export function openTab(udid, tag) {
  if (!isUdid(udid)) throw new Error(`openTab: "${udid}" is not a device UDID`);
  if (!/^msl-[0-9a-f]{8}$/.test(tag)) throw new Error(`openTab: tag "${tag}" is not msl-<8 hex>`);
  const url = `https://example.com/?${tag}`;
  const res = devicectl(['device', 'process', 'launch', '--device', udid, '--terminate-existing', '--payload-url', url, 'com.apple.mobilesafari'], WAIT.launchMs);
  if (res.r.code !== 0) {
    const text = res.r.code === 124 ? `devicectl launch timed out after ${Math.round(WAIT.launchMs / 1000)}s` : failureText(res) || `devicectl launch failed (exit ${res.r.code})`;
    throw needsError(classify(text), text);
  }
  return { tag, url };
}

// --- the WebDriverAgent runner app on the phone (issue 86) ---

// The lab's runner is the app WebDriverAgentRunner-Runner.app whatever bundle id it was signed with, and the process
// list names an executable, not a bundle id, so the path is what is matched. `listMs`/`signalMs`: one devicectl call.
const RUNNER_APP = '/WebDriverAgentRunner-Runner.app/';
const RUNNER_WAIT = { listMs: 30e3, signalMs: 20e3 };

// The text of a failed runner devicectl call (`what`: "processes", "signal"; `ms`: the limit it ran under).
const runnerFailure = (res, what, ms) => redactMessage(res.r.code === 124 ? `devicectl ${what} timed out after ${Math.round(ms / 1000)}s` : failureText(res) || `devicectl ${what} failed (exit ${res.r.code})`);

// The runner processes in `devicectl device info processes` JSON: [{ pid, executable }], or null for output of another shape.
export function parseRunners(json) {
  const list = json?.result?.runningProcesses;
  if (!Array.isArray(list)) return null;
  return list
    .filter(p => typeof p?.executable === 'string' && p.executable.includes(RUNNER_APP) && Number.isInteger(p.processIdentifier) && p.processIdentifier > 1)
    .map(p => ({ pid: p.processIdentifier, executable: p.executable }));
}

// The runner processes now on the phone: { ok: true, runners } or { ok: false, error }.
export function listRunners(udid) {
  if (!isUdid(udid)) throw new Error(`listRunners: "${udid}" is not a device UDID`);
  const res = devicectl(['device', 'info', 'processes', '--device', udid], RUNNER_WAIT.listMs, { retry: true });
  if (res.r.code !== 0) return { ok: false, error: runnerFailure(res, 'processes', RUNNER_WAIT.listMs) };
  const runners = parseRunners(res.json);
  return runners ? { ok: true, runners } : { ok: false, error: 'devicectl processes printed output the lab does not recognise' };
}

// SIGKILLs one process on the phone (a runner pid from `listRunners`; SIGTERM is answered by a relaunch): { ok } or { ok: false, error }.
export function killRunner(udid, pid) {
  if (!isUdid(udid)) throw new Error(`killRunner: "${udid}" is not a device UDID`);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`killRunner: "${pid}" is not a process id`);
  const res = devicectl(['device', 'process', 'signal', '--device', udid, '--pid', String(pid), '--signal', 'SIGKILL'], RUNNER_WAIT.signalMs);
  if (res.r.code === 0) return { ok: true };
  return { ok: false, error: runnerFailure(res, 'signal', RUNNER_WAIT.signalMs) };
}
