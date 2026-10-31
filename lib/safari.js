// bin/safari: the page in Mobile Safari, through Appium's XCUITest driver (console, network
// log, trusted taps and keys), speaking W3C WebDriver. One session lives across commands;
// its port, backend and id are kept in the state file. A session recorded by the old
// safaridriver backend is only ever cleaned up (`safari stop`, `lab down`). On the iPhone
// every page command goes through the tab guard (see "the lab's own tab").
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, isUdid, artifact, artifactBase, logRun, parseArgs, sleep, runForSession, markSessionRun, maskDevices, isTime } from './core.js';
import { udid as simUdid, profileOfUdid, requireOnlyBooted } from './sim.js';
import { SERVICE, WAIT as SERVICE_WAIT, serviceInstalled, bootstrapIfNeeded, kickstart, launchdState, logPath, requireRedactedService, requireCurrentRules, requireServiceForValues, writeLogFilters, pluginProblem } from './service.js';
import { parseNodes, xmlText, isChrome, isProbe, isDeleteKey, isApplication, webViewSubtree } from './ui-tree.js';
import { decodePng, cropPng, scalePng, encodePng, PNG_LIMITS } from './png.js';
import { appiumHome, appiumBin, appiumCaps, SIM_CREATE_MS, appiumDeviceCaps, parseConsole, parseNetwork, LOG_CAP, INSTALL_HINT, redactUrl, errorText, PAGE_PIN, PLUGIN, PIN_RISK, PIN_MISSING, PIN_HUMAN } from './appium.js';
import { stopDeviceWda } from './wda.js';
import { InterruptError, afterPendingSignals, cleaningUp, duringCleanup, hasActed, interrupted, noteActed, requestSignal } from './interrupt.js';
import { TARGETS, readPhone, chooseTarget, classify, needsError, wdaDerivedData, newTabTag, openTab, lockState, keyboardTarget, withRoute, KEYBOARD_HUMAN } from './phone.js';
import { COMMAND_KINDS, SETTINGS, settingWords, settingUsage, changeSetting, settingStatus, restorePending, restoreReport, restoreHuman } from './phone-restore.js';
import { touch as touchLease } from './lease.js';
import { acquire as acquireSignLock, lockReport } from './signlock.js';
import { ensureTunnel, stopTunnel, tunnelRunning, tunnelAddress, launchWda, checkPhone, tunnelHealthy, routeStatus, sessionRouteGone, tailOf, sizeOf } from './tunnel.js';

export const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
// A live read: tests re-point SERVICE.port after import.
// (safaridriver: only where `stop` ends a legacy session whose record lost its port.)
const DEFAULT_PORT = { get appium() { return SERVICE.port; }, safaridriver: 4744 };
const LEGACY = 'legacy safaridriver session: run `safari stop`';

// How long `open` and `refresh` wait for the new document (tests shorten these).
// `usableMs` is the whole liveness probe of a session, `callMs` each request in it, and
// `staleMs` the request that ends a dead session. With Appium's idle wait off, `tap` and
// `swipe` pause `tapSettleMs` / `swipeSettleMs` for the page to stop moving; `tap` samples the
// element's rectangle `stableMs` apart and needs it to hold still, trying up to `stableTries`
// times before it refuses; `keys` checks
// that each character landed, polling every `landPollMs` for up to `landMs`, and sends a
// character that didn't land again up to `keyRetries` times. `readMs` is the longest `keys`
// waits for one read of the field: Safari's Web Inspector has stalled it past 11 s.
// `sourceMs` is the full native tree (`ui`); the lean reads of `tap`, `swipe` and Backspace use `callMs`.
export const WAIT = {
  pollMs: 250, timeoutMs: 30e3, probeMs: 2e3, deleteMs: 600, settleMs: 700, keyboardMs: 3e3, charGapMs: 120, usableMs: 30e3, callMs: 10e3, readMs: 30e3, sourceMs: 60e3, staleMs: 10e3,
  tapSettleMs: 400, swipeSettleMs: 600, stableMs: 150, stableTries: 3, landMs: 1500, landPollMs: 50, keyRetries: 2,
  // Waits longer than `fetchLimitMs` use node:http (fetch gives up at 300 s); a session create
  // that fails because Web Inspector listed no pages is tried once more after `createRetryMs`.
  fetchLimitMs: 280e3, createRetryMs: 3e3,
  // After `inject`, how long the lab watches for the page leaving the document the script ran in (a
  // navigation starts some time after a script asks for it), checking every `injectPollMs`.
  injectWatchMs: 500, injectPollMs: 100,
  // `eval` reads a Promise's slot every `evalPollMs` until it settles (see THENABLE).
  evalPollMs: 100,
  // Safari's lean native tree (tap, swipe, shot --page and --element): WebDriverAgent builds it from the
  // accessibility snapshot, which takes longer than `callMs` on a heavy page (issue 98). The full tree (`ui`) gets `sourceMs`.
  treeMs: 30e3,
  // A device session builds and signs WebDriverAgent with Xcode, then starts it on the phone.
  deviceCreateMs: 660e3,
  // The lab's tab on the phone: every guarded script gets `tabMs` (a tab that is not showing
  // does not answer), Safari gets `tabSettleMs` after the launch before the session picks its
  // page, and a closed tab is waited for up to `closeMs` after its timer, polling every `closePollMs`.
  // Each of the two requests that restore the phone's keyboard settings when a device session ends.
  restoreMs: 10e3,
  // The request that ends a session whose Wi-Fi tunnel is gone (nothing will answer it; Appium may still free the slot).
  deadDeleteMs: 3e3,
  // After a guarded script got no answer the session is parked in NATIVE_APP; Appium's queue is
  // probably blocked behind that script, so each request of the park waits only `parkSendMs`.
  parkSendMs: 1e3,
  tabMs: 10e3, tabSettleMs: 4000, closeMs: 5e3, closePollMs: 250,
  // The lab's tab is closed by a timer in the page, `closeDelayMs` after the script that sets it
  // (long enough for the session to go native first; short enough that a person doesn't wait),
  // and `closeMs` more is allowed for the tab to go.
  closeDelayMs: 3000,
  // After a navigation the lab started, the tab is marked again by polling every `plantPollMs`
  // (each poll enters the lab's page). With the page pin a page that appears never moves the driver,
  // so a move seen then means the pin failed; it is waited out once: the list of pages is read every
  // `navSettlePollMs` until two reads in a row agree, for at most `navSettleMs`.
  plantPollMs: 500, navSettleMs: 5000, navSettlePollMs: 500,
  // `wait` asks the page again every `waitPollMs` (a phone answers in about six requests, so
  // every `waitPollDeviceMs`). No loop runs inside a page script.
  waitPollMs: 250, waitPollDeviceMs: 500,
};
// What `wait` accepts (not shrunk by tests): --timeout and --quiet in ms, and how many matches
// are measured for visibility. The longest wait is below the simulator lease's TTL: no renewal.
export const WAIT_LIMITS = { timeoutDefault: 10e3, timeoutMin: 100, timeoutMax: 60e3, quietDefault: 500, quietMin: 100, quietMax: 10e3, measureCap: 50 };
// Appium's two ways of finding no page: no web applications at all, or applications with empty page lists (xcuitest context.js).
const NO_WEB_APPS = /did not return any connected web applications|returned \d+ web applications?, but none of them had pages/;
// Appium's own error when WebDriverAgent did not come up on a simulator (its launch or connection timeout, or XCTest never
// seeing the accessibility tree after a first boot). Matched on a server reply only: the lab's own fetch timeout is never retried.
const WDA_LAUNCH_FAILED = /WebDriverAgent|Timed out waiting for AX|wdaLaunchTimeout/;
// How a session create failed, for the one retry and for the cold-start hint (issue 46), or null for any other failure:
// 'web-inspector' and 'wda' are Appium's replies (a retry is worth one try); 'no-answer' is the lab's own simulator
// create limit (see `wd`), never retried. The phone is only ever retried on Web Inspector.
function createFailure(e, { device = false } = {}) {
  const m = typeof e?.message === 'string' ? e.message : '';
  if (NO_WEB_APPS.test(m)) return 'web-inspector';
  if (device) return null;
  if (e?.fromServer && WDA_LAUNCH_FAILED.test(m)) return 'wda';
  return e?.limitMs === SIM_CREATE_MS ? 'no-answer' : null;
}
const RETRIED_AS = { 'web-inspector': 'Web Inspector listed no pages', wda: 'WebDriverAgent failed to start' };
const FAILED_AS = { ...RETRIED_AS, 'no-answer': `Appium gave no answer within ${SIM_CREATE_MS / 1000} s` };

// What a person is told when a simulator create fails for a cold-start reason: known one-offs after a cold boot,
// where the simulator is up by the time the lab gives up and a second `lab up` normally works. `first` is the class
// of the attempt the lab retried (null when it did not retry). Static text (no server text or UDID in it) that says
// what happened. `coldBoot` is true only when this run booted the simulator (`lab up` says so): the wording and the
// advice claim a cold boot only then. Returns the `human` and `then` a device `needs` failure has, or null.
const COLD_AGAIN = 'The simulator is booted by now, so this usually works the second time: run the command below again. If it fails the same way again, stop and tell the person.';
const WARM_AGAIN = 'The simulator was already running, so this may not be a cold-start one-off. Run the command below again, once; if it fails the same way again, stop and tell the person.';
function coldStartHint(e, first, coldBoot) {
  const last = createFailure(e);
  if (!last) return null;
  const where = coldBoot ? 'on the simulator\'s cold boot' : 'on the simulator';
  const what = first ? `The session create failed twice ${where}: first ${FAILED_AS[first]}, then ${FAILED_AS[last]}.`
    : `The session create failed ${where}: ${FAILED_AS[last]}.`;
  return { human: [what, coldBoot ? COLD_AGAIN : WARM_AGAIN], then: 'lab up --target simulator' };
}

// Collects console.error/warn/log, uncaught errors and unhandled rejections into
// window.__mslConsole (cap 500). Installed after every `safari open`, so it misses anything
// logged before that point. For targets with no console log of their own (the iPhone);
// Appium's simulator session has a real one.
const CONSOLE_INSTALL = `if (!window.__mslConsole) {
  const buf = window.__mslConsole = [];
  const text = a => { if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch { return String(a); } };
  const keep = (level, args) => { if (buf.length < 500) buf.push({ level, t: Date.now(), text: args.map(text).join(' ') }); };
  for (const level of ['error', 'warn', 'log']) {
    const orig = console[level];
    console[level] = function (...a) { keep(level, a); return orig.apply(this, a); };
  }
  addEventListener('error', e => keep('error', [e.message + ' (' + e.filename + ':' + e.lineno + ')']));
  addEventListener('unhandledrejection', e => keep('error', ['Unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)]));
}`;
export const CONSOLE_HOOK = `${CONSOLE_INSTALL}\nreturn true;`;

// Collects the page's own Resource Timing into window.__mslNet = { entries, lost, early,
// unsupported } for targets with no network log of their own (the iPhone: Safari's log holds
// every tab's traffic). A PerformanceObserver with `buffered` replays what the page already
// loaded (the browser keeps 250 entries: a full replay sets `early`, the oldest may be gone),
// then follows new requests. Each entry is copied field by field into a fresh object (name,
// initiatorType, startTime, duration, transferSize, encodedBodySize, decodedBodySize,
// responseStatus, nextHopProtocol), 2000 at most (the rest only counted in `lost`), plus the
// document's navigation entry once. It never resizes or clears the browser's own buffer. The
// page's own requests show up (fetch, XHR, scripts, images); a request made from another
// JavaScript world (a userscript manager's) may not. A cross-origin request without
// Timing-Allow-Origin reports sizes and status 0.
const NET_INSTALL = `if (!window.__mslNet) {
  const buf = window.__mslNet = { entries: [], lost: 0, early: false, unsupported: false };
  const keep = e => {
    if (buf.entries.length >= 2000) { buf.lost++; return; }
    buf.entries.push({ name: String(e.name), initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, responseStatus: e.responseStatus, nextHopProtocol: e.nextHopProtocol });
  };
  try {
    if (performance.getEntriesByType('resource').length >= 250) buf.early = true;
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) keep(nav);
    new PerformanceObserver(list => { for (const e of list.getEntries()) keep(e); }).observe({ type: 'resource', buffered: true });
  } catch (e) { buf.unsupported = true; }
}`;
export const NET_HOOK = `${NET_INSTALL}\nreturn true;`;
const DEVICE_HOOKS = `${CONSOLE_INSTALL}\n${NET_INSTALL}\nreturn true;`; // installed after every open and refresh on the phone

// One guarded read: up to 500 entries, oldest first, and what is left, lost and early since the last read.
const NET_READ = `const b = window.__mslNet;
if (!b) return null;
const entries = b.entries.splice(0, 500);
const out = { entries, left: b.entries.length, lost: b.lost, early: b.early, unsupported: b.unsupported };
b.lost = 0; b.early = false;
return out;`;

// Notes on stderr; server-originated text can carry URLs with secrets in them.
const warn = msg => console.error(maskDevices(redactUrl(msg))); // stderr: urls redacted, device ids masked like the output

// --- WebDriver over HTTP ---

// Seams for tests; the real behaviour is the default. `NET.signal(ms)`: the signal that ends a request with a
// TimeoutError after `ms`. `CLOCK`: the time and the waits behind these deadlines only: the close race and its polls
// (endDeviceSession), settleTabList, devicePlant, waitForDocument and pollUntil (the polls of `wait` and `wait --settled`).
// A test can make time pass only in those waits, so a slow request never eats their budgets. Every other loop (the probe,
// the key-landing check, the service wait, the keyboard wait, the sleeps between commands) still reads the real clock.
export const NET = { signal: ms => AbortSignal.timeout(ms) };
export const CLOCK = { now: () => Date.now(), sleep };

// fetch (undici) gives up on a response whose headers take over 300 s, whatever the abort
// signal says, and a cold session create can take longer. Waits past `fetchLimitMs` go over
// node:http instead, which has no such limit. Returns what `wd` uses of a fetch Response.
function httpFetch(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, signal }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A limit or a wait in seconds, to one decimal place, for the words a person reads.
const secs = ms => Math.round(ms / 100) / 10;

export async function wd(base, method, path, body, timeoutMs = 60e3) {
  // A signal that arrived during a synchronous child (a `run`) is handled one macrotask later: wait for it, so it
  // refuses this request rather than aborting it after it left.
  if (!cleaningUp()) await afterPendingSignals();
  if (interrupted() && !cleaningUp()) throw Object.assign(new InterruptError(interrupted()), { unsent: true }); // a swallowed interrupt must not send the command on
  let res;
  const started = Date.now();
  try {
    res = await (timeoutMs > WAIT.fetchLimitMs ? httpFetch : fetch)(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A cleanup request (a park, a teardown) is not cut off by a signal that lands while it runs: its timeout bounds it.
      signal: cleaningUp() ? NET.signal(timeoutMs) : AbortSignal.any([NET.signal(timeoutMs), requestSignal()]),
    });
  } catch (e) {
    if (interrupted() && (e.name === 'AbortError' || e.cause?.name === 'AbortError')) throw new InterruptError(interrupted());
    // Appium answers slowly while Safari's Web Inspector is busy; the command keeps running
    // there, so it is no sign the server is down, and sending it again would queue behind it.
    const hint = `(Appium at ${base} may be busy or stuck; check \`lab status\`)`;
    if (e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError') throw Object.assign(new Error(`WebDriver ${method} ${path} got no answer in ${secs(timeoutMs)}s ${hint}`), { limitMs: timeoutMs }); // limitMs: the lab's own limit ran out (createFailure reads it)
    // fetch's own limits on a slow answer: the server is there, it just hasn't replied.
    if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(e.cause?.code)) throw new Error(`WebDriver ${method} ${path} got no answer in ${secs(Date.now() - started)}s ${hint}`);
    throw new Error(`WebDriver server not reachable at ${base} (${e.message}); run \`safari start\``);
  }
  let json;
  try { json = await res.json(); } catch (e) {
    if (interrupted() && e.name === 'AbortError') throw new InterruptError(interrupted());
    throw new Error(`WebDriver ${method} ${path}: HTTP ${res.status}, not JSON`);
  }
  const v = json && typeof json === 'object' ? json.value : undefined;
  if (!res.ok || (v && typeof v === 'object' && v.error)) {
    const err = new Error(redactUrl(`${v?.error || 'HTTP ' + res.status}${v?.message ? ': ' + v.message : ''}`));
    err.wd = v?.error;
    err.fromServer = true; // its text came from Appium or the page, which may repeat what was sent
    throw err;
  }
  return v;
}

// --- state: which backend, which session ---

const BACKENDS = ['appium', 'safaridriver'];
const DAMAGED = 'state file is damaged: run `safari stop`';

// The session recorded in the state file, checked: null when there is none, otherwise
// { backend, session, port, target, driverPid, injected, pagePin? }. A state from before the Appium
// backend (a session, no `backend`) is a safaridriver one, kept readable for cleanup. Throws if a session is recorded
// but the rest doesn't hold together.
export function readSession(state) {
  if (!state || state.session === undefined || state.session === null) return null;
  const backend = state.backend === undefined ? 'safaridriver' : state.backend;
  const t = state.target;
  const keys = t && typeof t === 'object' && !Array.isArray(t) ? Object.keys(t) : [];
  const ok = typeof state.session === 'string' && state.session
    && BACKENDS.includes(backend)
    && Number.isInteger(state.port) && state.port >= 1 && state.port <= 65535
    && keys.length === 1 && ['simulator', 'device'].includes(keys[0]) && isUdid(t[keys[0]])
    && (state.driverPid === undefined || (Number.isInteger(state.driverPid) && state.driverPid > 1))
    && (state.injected === undefined || (Array.isArray(state.injected) && state.injected.every(f => typeof f === 'string' && path.isAbsolute(f))))
    && (state.pagePin === undefined || Number.isInteger(state.pagePin));
  if (!ok) throw new Error(DAMAGED);
  return { backend, session: state.session, port: state.port, target: t, driverPid: state.driverPid, injected: state.injected || [], ...(state.pagePin !== undefined ? { pagePin: state.pagePin } : {}) };
}

// "device" or "simulator": which kind of target a recorded session drives (`target` is the id object).
export const targetType = t => (t?.device !== undefined ? 'device' : 'simulator');

export const backendUrl = (backend, port) =>
  (backend === 'appium' ? process.env.MSL_APPIUM_URL : process.env.MSL_SAFARIDRIVER_URL) || `http://127.0.0.1:${port}`;

function session() {
  const s = readSession(loadState());
  if (!s) throw new Error('No Safari session: run `safari start` first');
  if (s.backend === 'safaridriver') throw new Error(LEGACY);
  return { ...s, url: backendUrl(s.backend, s.port), device: s.target.device !== undefined };
}

// What a device session may ask of Appium outside the tab guard: native work only (WebDriverAgent
// answers `mobile:` calls, actions and the screenshot whatever the context). Anything that reads
// a page goes through `guarded`, which uses `rawCmd`.
// `mobile: getContexts` and the like list every tab's URL and title, and Safari's console and
// network logs hold every tab's traffic (the session is created without them; the lab's own
// collectors run in its page), so only what the native actions need is let through.
const DEVICE_MOBILE = new Set(['mobile: tap', 'mobile: keys', 'mobile: isKeyboardShown', 'mobile: source']);
export const deviceNative = (method, path, body) =>
  (method === 'POST' && path === '/execute/sync' && DEVICE_MOBILE.has(body?.script))
  || (['POST', 'DELETE'].includes(method) && path === '/actions')
  || (method === 'GET' && path === '/screenshot');

const rawCmd = (method, path, body, timeoutMs) => {
  const { url, session: id } = session();
  return wd(url, method, `/session/${id}${path}`, body, timeoutMs);
};

// Sends a request that acts on the lab's tab (a page script, a tap, keys) and notes it for an
// interrupt's words (noteActed), unless wd refused it before sending (`unsent`).
async function acting(send) {
  let left = true;
  try { return await send(); } catch (e) { left = !e.unsent; throw e; } finally { if (left) noteActed(); }
}

const ACTS = new Set(['mobile: tap', 'mobile: keys']);
const acts = (method, path, body) => method === 'POST' && (path === '/actions' || (path === '/execute/sync' && ACTS.has(body?.script)));

const cmd = (method, path, body, timeoutMs) => {
  if (session().device && !deviceNative(method, path, body)) {
    throw tabError(`${method} ${path} is not allowed on the phone outside the tab guard`);
  }
  return acts(method, path, body) ? acting(() => rawCmd(method, path, body, timeoutMs)) : rawCmd(method, path, body, timeoutMs);
};

// --- the lab's own tab on the phone (tab guard) ---
// The phone's Safari belongs to the owner. The run has ONE tab (state.deviceTab = { page, token,
// origin, tag, origins, navTo?, allowHosts? }): `page` is its Appium context id, `token` a marker kept in its
// window.name, `origin` where the lab last navigated it, `origins` the sites it visited this run,
// `navTo` the site `open` asked for while that navigation is not verified yet, `allowHosts` the hosts
// (host[:port], https and http) the session was started to follow the tab to (--allow-host, docs/adr/0009).
// The session sits in NATIVE_APP. A page script runs only through `guarded`, which selects that
// page, runs the script behind a check for the token, confirms the context is still that page
// and parks in NATIVE_APP again. Anything else (page gone, no answer, context moved, token
// missing) discards the result and refuses with needs "tab". The one script ever run in a page
// not yet verified is the boolean tag check at start.
// Appium runs with the lab's msl-page-pin plugin (appium-plugin/): it stops Appium following a page
// that appears and refuses a script whose page isn't the one selected, and a device session without
// the plugin's `msl:pagePin` marker is refused at start. The checks below stay as tripwires for a
// pin that fails.
// Navigation never goes through POST /url (that navigates whichever page is current) and the tab
// is never closed with DELETE /window.

const NATIVE = 'NATIVE_APP';
const TAB_GONE = 'the lab\'s tab is gone (closed, or Safari restarted)';
const CSS_REF = 'msl-css:'; // an element reference on the phone: msl-css: + the selector in base64url, resolved inside the guarded script
const CSS_REF_SHAPE = /^msl-css:[A-Za-z0-9_-]+$/;

// A refusal carrying `needs: "tab"`; nothing from the phone's pages is read for its artifacts.
// `tainted`: the run no longer trusts the phone (its steps are a fresh `safari start`, not a switch back).
function tabError(why, extra = {}, tainted = false) {
  const e = needsError('tab', why, { tainted });
  e.skipArtifacts = true;
  Object.assign(e, extra);
  return e;
}

// A catch that turns errors into a conclusion (no answer, a move, a dead session) lets an interrupt through
// first: after a signal every request is refused at entry, and that refusal is evidence of nothing.
const passCut = e => { if (e instanceof InterruptError) throw e; };
// What an interrupted page command says (guarded, plantAfterNav), once the session is parked: kept, tainted only
// when the park showed a move, and whether anything acting on the page left during this command.
function cutOff(e, tab, moved, where) {
  if (moved) taint(tab);
  logRun(`safari ${where}: interrupted by ${e.signal}, ${moved ? 'tainted' : 'not tainted'} page=${tab.page}`);
  e.extra = { ...e.extra, sessionKept: true, tainted: !!moved, human: [hasActed() ? 'The command was cut off; a request already sent may still finish in the lab\'s tab. Check the page before repeating it.' : 'The command was cut off before it sent anything to the lab\'s tab.'] };
  return e;
}

// A refusal of the guard: the tab can't be confirmed, the phone is locked (`locked`), or the route to it is down (`routeDown`).
const isTabError = e => e?.extra?.needs === 'tab' || e?.locked === true || e?.routeDown === true;
// A request that got no answer in time (the client's own timeout), as opposed to an answer that
// says it failed (`e.wd`: the driver's error code) or a server that could not be reached.
const busy = e => !e?.wd && /got no answer/.test(e?.message ?? '');
// The page pin plugin refused something (its errors all start with "msl-page-pin:"): the session was not
// on the page the lab selected, and nothing ran. With the pin this is a tripwire, not an expected answer.
const pinRefused = e => /msl-page-pin:/.test(e?.message ?? '');
const PIN_MOVED = 'the session was not on the lab\'s tab when the script was sent; the page pin refused it, nothing ran';
// Throws the move (tainted) when `e` is a pin refusal: the one place the guard, the select and the re-mark read it.
const throwIfPinRefused = e => { if (pinRefused(e)) throw movedError(PIN_MOVED); };
// The tab is not showing, or Safari paused it: nothing it was asked has been answered. Not a move.
const pauseText = ms => `the lab's tab did not answer within ${Math.round(ms / 1000)}s; it is not the one showing, Safari paused it, or the page is busy. The session is still good: switch back to the lab's tab`;
// After a guarded script got no answer (`deviceTab.waitingSince`), Appium runs nothing else for the session until it does (issue 104):
// what a later read or select that gets no answer (it waits behind that script) says instead of the pause.
const waitingText = since => `Appium is still waiting on a script the lab sent to its tab ${Math.max(0, Math.round((CLOCK.now() - Date.parse(since)) / 1000))}s ago, which got no answer: the page is busy, or the tab is not showing. Nothing else runs until it answers; if it has not within a minute, run \`safari start\``;
const noAnswerText = (tab, ms) => (isTime(tab.waitingSince) ? waitingText(tab.waitingSince) : pauseText(ms));
// The lab's own record of its tab, re-read (a caller's copy may be stale), while it is still `tab` and not tainted.
const sameTab = tab => { const cur = loadState().deviceTab; return cur && !cur.tainted && cur.page === tab.page ? cur : null; };
// Records the first script that got no answer; clearWaiting drops the record once a guarded script is answered.
function markWaiting(tab) {
  const cur = sameTab(tab);
  if (cur && !cur.waitingSince) saveState({ deviceTab: { ...cur, waitingSince: new Date(CLOCK.now()).toISOString() } });
}
function clearWaiting(tab) {
  const cur = sameTab(tab);
  if (cur?.waitingSince) { const { waitingSince: _, ...rest } = cur; saveState({ deviceTab: rest }); }
}
// What is left of a navigation phase that ends at `end`, never less than tabMs (issue 104): a page that is loading is busy.
const budgetLeft = end => Math.max(WAIT.tabMs, end - CLOCK.now());
const TAB_SHAPE = /^WEBVIEW_[\w.:-]+$/;
const TAG_SHAPE = /^msl-[0-9a-f]{8}$/;
const ORIGIN_SHAPE = /^https?:\/\/[^/\s]+$/;
const HOST_SHAPE = /^[^\s/?#@\\*]+$/;
const MAX_ALLOW_HOSTS = 10;
const ALLOW_USAGE = '--allow-host takes a host such as old.reddit.com, localhost:3000 or 192.168.1.5 (no scheme, path, login or wildcard)';

// The hosts --allow-host names, checked before anything runs: lowercased, one host each (the form `new URL` gives:
// punycode, no default port), no duplicates, at most MAX_ALLOW_HOSTS. Nothing from argv is echoed.
export function parseAllowHosts(list = []) {
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw) throw new Error(`an allowed host is empty: ${ALLOW_USAGE}`);
    if (raw.includes('*')) throw new Error('wildcards are not taken: name each host (old.reddit.com)');
    const h = raw.toLowerCase();
    let u;
    try { u = HOST_SHAPE.test(h) ? new URL(`https://${h}`) : null; } catch { u = null; }
    if (!u || u.pathname !== '/' || u.search || u.hash || u.username || u.password || !u.host) throw new Error(`not an allowed host: ${ALLOW_USAGE}`);
    if (!out.includes(u.host)) out.push(u.host);
  }
  if (out.length > MAX_ALLOW_HOSTS) throw new Error(`a session can name at most ${MAX_ALLOW_HOSTS} allowed hosts`);
  return out;
}
// A stored host is one parseAllowHosts gives back unchanged.
const hostOk = h => { try { return typeof h === 'string' && parseAllowHosts([h])[0] === h; } catch { return false; } };
// What a person is told when the lab's tab left the session's allowed hosts.
const offAllowed = hosts => `this session's allowed hosts (${hosts.join(', ')}); run \`safari start\` for a new session (and name the hosts again with \`--allow-host\`)`;
// A page-side test that `location.origin` is one of `origins`: plain === comparisons, no method call. A page on another site can
// patch Array.prototype.includes (and the like) before the lab's script runs, so no origin check in a page script may use one.
const originIs = origins => origins.map(o => `location.origin === ${JSON.stringify(o)}`).join(' || ');
// The origins the hosts mean: https and http each (a port is the same for both; a default port is dropped by URL).
const allowOrigins = (hosts = []) => [...new Set(hosts.flatMap(h => [`https://${h}`, `http://${h}`].map(u => new URL(u).origin)))];
const tabUrl = tag => `https://example.com/?${tag}`; // what openTab launches

// The recorded tab, checked; refuses when there is none or it doesn't hold together.
function readTab(state = loadState()) {
  const t = state.deviceTab;
  if (t?.tainted) throw tabError('the lab lost track of its tab (the session moved to another page, or the tab changed under it); nothing more is read from the phone: run `safari start`, which ends this session and opens a new one', {}, true);
  const ok = t && typeof t === 'object' && !Array.isArray(t)
    && typeof t.page === 'string' && TAB_SHAPE.test(t.page)
    && typeof t.token === 'string' && /^msl-tok-[0-9a-f]{16}$/.test(t.token)
    && typeof t.origin === 'string' && ORIGIN_SHAPE.test(t.origin)
    && typeof t.tag === 'string' && TAG_SHAPE.test(t.tag)
    && Array.isArray(t.origins) && t.origins.every(o => typeof o === 'string')
    && (t.allowHosts === undefined || (Array.isArray(t.allowHosts) && t.allowHosts.length <= MAX_ALLOW_HOSTS && t.allowHosts.every(hostOk)));
  if (!ok) throw tabError('this device session has no recorded lab tab (it was started without the tab guard, or the state is damaged): run `safari start` for a new session');
  return t;
}

const contextIds = list => (Array.isArray(list) ? list : []).map(c => (typeof c === 'string' ? c : c?.id)).filter(c => typeof c === 'string' && c !== NATIVE);

// Where the lab last sent a recorded tab, for the words a person is given about a tab left on the
// phone: a site (never a path or query), taken from the record's own fields, never read from a page here
// (a followed tab's origin was checked against the allowed list before it was recorded).
// Null when it is only the page the tab started on, which the tag already names.
const START_ORIGIN = new URL(tabUrl('x')).origin;
function lastSite(t) {
  for (const o of [t?.lastOrigin, t?.navTo, t?.origin]) if (typeof o === 'string' && ORIGIN_SHAPE.test(o)) return o === START_ORIGIN ? null : o;
  return null;
}

// A context that moved without the lab asking (a new page pulled the driver to it) means a
// script may have gone to a tab that is not the lab's. The run stops trusting the phone: the
// token and the recorded tab are voided (the tag and the last site the lab sent the tab to stay, to
// name the tab for a person) and every page command refuses until `safari start`. The site is the
// one asked for when a navigation had not been verified yet (never a redirect's target), else the
// verified one.
function taint(tab) {
  const last = [tab?.navTo, tab?.origin].find(o => typeof o === 'string' && ORIGIN_SHAPE.test(o));
  saveState({ deviceTab: { tainted: true, ...(typeof tab?.tag === 'string' && TAG_SHAPE.test(tab.tag) ? { tag: tab.tag } : {}), ...(last ? { lastOrigin: last } : {}) } });
}
// A move always ends in taint() (see parkAfterFailure), so its steps are the tainted ones.
const movedError = why => tabError(why, { moved: true }, true);
// An error that was made before the run was tainted, now that it is.
const retaint = e => {
  e.extra = needsError('tab', e.message, { tainted: true }).extra;
  e.moved = true;
  return e;
};

// Selects the lab's page and checks that it is the current context. Throws a tab error when it
// is gone or another page is current (a move); the caller parks in NATIVE_APP. `progress.selected`
// turns true the moment the select is sent: from then on the session may be anywhere.
async function selectTab(raw, tab, progress) {
  // A read that gets no answer (Appium's queue is blocked behind a script in a tab that is not showing)
  // says nothing about where the session is: the command is refused, nothing more is sent, the run is not tainted.
  const pending = e => (busy(e) ? tabError(noAnswerText(tab, WAIT.callMs), { pending: true }) : e);
  let listed, cur;
  try { listed = contextIds(await raw('GET', '/contexts')); } catch (e) { throw pending(e); }
  if (!listed.includes(tab.page)) throw tabError(TAB_GONE, { gone: true });
  // After a failed park the driver may still sit in a page the lab did not pick (an owner's tab).
  try { cur = await raw('GET', '/context'); } catch (e) { throw pending(e); }
  if (typeof cur === 'string' && cur !== NATIVE && cur !== tab.page) throw movedError('the session was in another page before the lab\'s tab was selected');
  progress.selected = true;
  // A select that gets no answer is the same pause as a script that gets none: not a move (see parkAfterTimeout).
  try { await raw('POST', '/context', { name: tab.page }); } catch (e) {
    throwIfPinRefused(e);
    throw busy(e) ? tabError(noAnswerText(tab, WAIT.callMs), { timedOut: true, stage: 'select' }) : e;
  }
  const landed = await raw('GET', '/context');
  // `afterSelect`: nothing was sent to the page yet; plantAfterNav may wait this one out (see there).
  if (landed !== tab.page) throw Object.assign(movedError('the session did not stay on the lab\'s tab'), { afterSelect: true, landed });
}

// After a failure: parks in NATIVE_APP and says whether the context was anywhere but the lab's
// page or the native app. Once the select was sent, a context that can't be read counts as moved.
// A `pending` refusal (the pre-select reads got no answer) sends nothing: it is not a move.
async function parkAfterFailure(raw, tab, e, progress) {
  if (e?.pending) return false;
  let moved = e?.moved === true;
  if (!moved) {
    const cur = await raw('GET', '/context').catch(() => null);
    moved = progress.selected ? cur !== NATIVE && cur !== tab.page : typeof cur === 'string' && cur !== NATIVE && cur !== tab.page;
  }
  await raw('POST', '/context', { name: NATIVE }).catch(() => {});
  return moved;
}

// After a guarded script got no answer: 'pending' (nothing answered: the next command's checks decide),
// 'parked' (the session is in NATIVE_APP), 'foreign' (a page that is not the lab's is current) or
// 'moved' (the park did not land). Sends a read of the context and a park, each waiting only `parkSendMs`,
// and nothing that touches a page. No answer is not evidence of a move: an unanswered request
// is probably queued behind the script, and runs once the tab shows again. A context that
// is read and is another page, or an answer that is an error, is.
async function parkAfterTimeout(raw, tab) {
  const send = (method, body) => raw(method, '/context', body, WAIT.parkSendMs);
  let cur = null; // an answered error stays null
  try { cur = await send('GET'); } catch (e) { if (busy(e)) cur = undefined; }
  const foreign = typeof cur === 'string' && cur !== NATIVE && cur !== tab.page;
  try { await send('POST', { name: NATIVE }); } catch (e) { if (busy(e)) return foreign ? 'foreign' : 'pending'; }
  if (foreign) return 'foreign';
  // The park was answered: it must have landed. An answered error here is a move; no answer is not.
  try { return (await send('GET')) === NATIVE ? 'parked' : 'moved'; } catch (e) { return busy(e) ? 'pending' : 'moved'; }
}

// After a guarded call timed out: a refusal with needs "unlock" when the phone says it is locked
// (one bounded devicectl call), else null. An answer that can't be read is no lock.
function phoneLocked() {
  let lock;
  try { lock = lockState(session().target.device); } catch { return null; }
  if (!lock.ok || !lock.locked) return null;
  const e = needsError('unlock', 'the phone is locked, so the lab\'s tab did not answer; nothing was read from any page and the session is still good: unlock the phone and run the command again');
  e.skipArtifacts = true;
  e.locked = true;
  return e;
}

// After a guarded call got no answer, or found the tab gone, on a session that runs over the Wi-Fi tunnel: a refusal with
// needs "tunnel" when the route to the phone is down (the tunnel does not answer, or WebDriverAgent does not through it),
// else null. Two bounded probes (routeStatus); a cable session is never probed. Nothing is read from any page.
async function routeDown() {
  const state = loadState();
  if (state.transport?.via !== 'tunnel' || state.target?.device === undefined) return null;
  const route = await routeStatus();
  if (route.ok) return null;
  const e = needsError('tunnel', `${route.why}, so the lab's tab did not answer; nothing was read from any page`);
  if (route.stage === 'wda') e.extra.human = ['The tunnel reaches the phone, but WebDriverAgent (the lab\'s runner app on the phone) does not answer, so the lab can\'t drive it.', 'Unlock the phone and keep it on the same Wi-Fi network as the Mac, then run the command below: it starts the session again. Or connect the phone with a cable.'];
  e.extra.tunnel = route.why;
  e.skipArtifacts = true; // no failure artifacts: the route check is already done
  e.routeDown = true;
  e.routeStage = route.stage;
  return e;
}

const rawFor = () => {
  const { url, session: id } = session();
  return (method, path, body, ms = WAIT.callMs) => wd(url, method, `/session/${id}${path}`, body, ms);
};

// While a navigation the lab started is not verified (`navTo` is still recorded), a tab that carries no marker or sits on another origin
// is named by where the lab sent it, not by what the page did.
const unconfirmed = tab => (typeof tab.navTo === 'string' && ORIGIN_SHAPE.test(tab.navTo)
  ? `the lab's tab could not be confirmed after it was sent to ${tab.navTo} (it was not marked again)` : null);
// What a refusal of the guard says about the allowed hosts: the session's list when it had one (the taint drops it, so
// this is the one place a person sees it), else how to get one. The site the tab is on is never named.
const refusal = (why, tab) => (tab.allowHosts?.length
  ? `${why}, and it is not on one of ${offAllowed(tab.allowHosts)}`
  : `${why}; run \`safari start\` for a new session. To let the lab follow its tab to another host, start the session with \`--allow-host <host>\``);

// The sites `guarded` followed the lab's tab to during this command (allowed hosts, see followTab); the handlers report them.
let followed = [];

// Runs `body` (a function body; `arguments` are `args`: plain values, never element references,
// which the remote debugger refuses unless it made them) in the lab's tab and gives back what it returned. Refuses with needs "tab" if
// anything is in doubt; a context that moved, a missing marker, or a page on another origin than
// the lab sent the tab to, taints the run. A script that throws in the lab's own page rethrows
// its error.
// With allowed hosts (and not `noFollow`) a missing marker or another origin that is one of them answers 3 instead of 0 or 2:
// the page is not read or written, and the command goes on only after followTab marked the tab again (see there).
async function guarded(body, args = [], { navTo, noFollow = false, limitMs = WAIT.tabMs, label = null } = {}) {
  // (The phone's driver never answers a script that throws, so the script catches the page's own error and returns it.)
  const tab = readTab();
  const raw = rawFor();
  const followCheck = !noFollow && tab.allowHosts?.length ? originIs(allowOrigins(tab.allowHosts)) : null;
  const gate = code => (followCheck === null ? `{ __msl: ${code} }` : `${followCheck} ? { __msl: 3 } : { __msl: ${code} }`);
  const script = `if (window.name !== ${JSON.stringify(tab.token)}) return ${gate(0)};
if (location.origin !== ${JSON.stringify(tab.origin)}) return ${gate(2)};
try { return { __msl: 1, v: (function () {\n${body}\n}).apply(null, arguments) }; } catch (e) {
  let m; try { m = String(e && e.message || e); } catch (_) { m = 'unreadable error'; }
  return { __msl: 1, threw: true, thrown: m.slice(0, 500) };
}`;
  const progress = { selected: false };
  let out, thrown = null;
  try {
    await selectTab(raw, tab, progress);
    // A navigation's destination is recorded only now, when the script that starts it is about to be sent, so a run
    // that fails before that never names a site the tab was not sent to (taint() keeps it).
    if (navTo) { tab.navTo = navTo; saveState({ deviceTab: tab }); }
    try { out = await acting(() => raw('POST', '/execute/sync', { script, args }, limitMs)); } catch (e) {
      if (e instanceof InterruptError) throw e;
      throwIfPinRefused(e);
      if (e.wd !== 'javascript error') {
        // Only a real timeout is "no answer"; an error the driver answered with names its code.
        if (busy(e)) throw tabError(pauseText(limitMs), { timedOut: true });
        throw tabError(`the lab's tab could not run the script (${e.wd || 'no usable answer'})`);
      }
      thrown = e; // the page's own script failed after the token check passed
    }
    if ((await raw('GET', '/context')) !== tab.page) throw movedError('the page changed while the command ran; its result was discarded');
    await raw('POST', '/context', { name: NATIVE });
  } catch (e) {
    // Whatever went wrong, the session must still be on the lab's page or in the native app.
    // A script that got no answer is not a move (see parkAfterTimeout); it is when the park shows one.
    // An interrupt is handled like a script that got no answer: the request already sent may still run.
    const cut = e instanceof InterruptError;
    // The park is cleanup (duringCleanup): sent after a signal, and not cut off by one that lands while it runs, so a
    // refused or aborted read is never taken for a move.
    const park = f => duringCleanup(f);
    const parked = e.timedOut || cut ? await park(() => parkAfterTimeout(raw, tab)) : null;
    const moved = e.timedOut || cut ? parked === 'moved' || parked === 'foreign' : await park(() => parkAfterFailure(raw, tab, e, progress));
    // The words go by whether anything acting on the page left during this command (this script, or an earlier step's),
    // not by whether the request that saw the signal was refused: a later GET refused at entry says nothing about the script.
    if (cut) throw cutOff(e, tab, moved, 'guard');
    if (moved) taint(tab);
    // A route that is down, or a phone that locked, answers nothing, from any page (a locked phone can also list no tab).
    // When the context is still the lab's page or the native app that is no move: it is not tainted, and the next
    // command works once the route is back or the phone is unlocked. The route is asked first, then the lock.
    else if (!interrupted() && (e.timedOut || e.pending || e.gone || (!isTabError(e) && busy(e)))) {
      // `gone` stays on whatever is thrown: endDeviceSession reads it. A tunnel that does not answer is reported as it is (the
      // lock check would wait on the same dead route); a silent WebDriverAgent is often a locked phone's, so the lock is asked first.
      const down = await routeDown();
      if (down && down.routeStage !== 'wda') throw e.gone ? Object.assign(down, { gone: true }) : down;
      const lock = phoneLocked();
      if (lock) throw e.gone ? Object.assign(lock, { gone: true }) : lock;
      if (down) throw e.gone ? Object.assign(down, { gone: true }) : down;
    }
    const within = `${Math.round(limitMs / 1000)}s${label ? ` (${label})` : ''}`;
    if (moved && e.timedOut) {
      logRun(`safari guard: no answer within ${within} and the session was not parked page=${tab.page}`);
      throw movedError(`the lab's tab did not answer, and ${parked === 'foreign' ? 'the session was attached to another page' : 'the session did not return to the native app'}`);
    }
    if (e.timedOut) {
      logRun(`safari guard: no answer within ${within}, not tainted page=${tab.page}`);
      markWaiting(tab);
    }
    const err = isTabError(e) ? e : tabError(`could not confirm the lab's tab (${e.wd || 'no answer'})`);
    throw moved && !err.moved ? retaint(err) : err;
  }
  clearWaiting(tab); // answered: Appium is not waiting on an earlier script any more
  if (thrown) throw thrown;
  // The tab is on an allowed host without its marker (or on another allowed host): mark it again, then run the body once more
  // with the strict script (a second 3 cannot come: that script answers 0 or 2, which taint).
  if (out?.__msl === 3 && followCheck !== null) {
    if (navTo) { const { navTo: _, ...clean } = tab; saveState({ deviceTab: clean }); } // the script that would have navigated never ran
    await followTab(tab);
    return guarded(body, args, { navTo, noFollow: true, limitMs, label });
  }
  if (!out || out.__msl === 0) {
    taint(tab); // the marker is gone and nothing says what the page is now
    throw tabError(refusal(unconfirmed(tab) ?? 'the lab\'s tab no longer carries its marker (it was navigated or replaced)', tab), {}, true);
  }
  if (out.__msl === 2 || out.__msl === 3) { // 3 here is not the guard's own answer (no list, or the strict script): a page forging it taints too
    taint(tab); // an origin change the lab did not ask for
    throw tabError(refusal(unconfirmed(tab) ?? 'the lab\'s tab moved to another site on its own', tab), {}, true);
  }
  if (out.__msl !== 1) throw tabError('the lab\'s tab gave an answer the lab does not understand');
  // The page's own exception: not a tab fault (the token and origin passed, the context stayed), so no needs and no taint.
  // The text is capped and type-checked here too: the page that wrote it can patch String.prototype.
  if (out.threw === true) {
    const err = new Error(`the page script threw: ${redactUrl(typeof out.thrown === 'string' ? out.thrown.slice(0, 500) : 'unreadable error')}`);
    err.fromPage = true; // the page wrote the text
    throw err;
  }
  return out.v;
}

// The origins a navigation to `url` may end on: its own, the https upgrade and the www / no-www
// twin of each. Any other final site (an off-site redirect) is refused.
function expectedOrigins(url) {
  const u = new URL(url);
  const host = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
  const out = new Set();
  for (const protocol of new Set([u.protocol, 'https:'])) {
    for (const hostname of [u.hostname, host]) {
      const v = new URL(u.href);
      v.protocol = protocol;
      v.hostname = hostname;
      out.add(v.origin);
    }
  }
  return [...out];
}

// The pages Safari lists, read every WAIT.navSettlePollMs until two reads in a row agree (a page
// that is still appearing or going away settles), for at most WAIT.navSettleMs. The lab's page
// must be listed at the end, else the usual "gone" refusal: no other page is looked for or selected.
async function settleTabList(raw, tab) {
  const end = CLOCK.now() + WAIT.navSettleMs;
  let prev = null, ids;
  for (;;) {
    ids = contextIds(await raw('GET', '/contexts'));
    const key = JSON.stringify([...ids].sort());
    if (key === prev && ids.includes(tab.page)) break;
    prev = key;
    if (CLOCK.now() >= end) break;
    await CLOCK.sleep(WAIT.navSettlePollMs);
  }
  if (!ids.includes(tab.page)) throw tabError(TAB_GONE, { gone: true });
}

// After a navigation the lab started (open, refresh): Safari clears window.name when the site
// changes, so once the lab's own page holds the new complete document (`beforeOrigin`: the
// old document's timeOrigin; `targetHref`: for a navigation that may make no new document),
// the marker goes back into it, but only if the page is on one of the `expected` origins: the
// marker is never written into a page on any other site (that taints the run). Within ONE
// selection of the lab's page two scripts run, each followed by a check that the context is
// still that page: a read-only probe (document complete and fresh, origin expected; gives its
// timeOrigin, origin and whether the marker is already there), then the mark, which writes the
// marker only if the document is still the probed one (a timeOrigin belongs to one document, so
// no other page can match it) and its origin is still expected.
// With the page pin a new page never pulls the driver away; if the pin is missing or fails it can,
// while the lab's page loads. A move seen right after the
// select, or after either script, is waited out ONCE per navigation (`nav.tries`, shared by every
// poll): the session parks in NATIVE_APP, the page list settles, and the next poll starts over;
// whatever a script returned after a move is discarded. A second move, or a context that is
// unreadable or not a listed page, taints as before. A move seen BEFORE the select (the session
// parked somewhere else) and a foreign final origin taint at once. Gives the final origin when
// marked, null when not ready yet (or when it is waiting out a move).
async function plantAfterNav(nav, end = 0) {
  const { beforeOrigin, targetHref, expected, tries } = nav;
  // Each script gets what is left of the navigation's budget (`end`; none: tabMs).
  const limitMs = budgetLeft(end);
  const tab = readTab();
  // A taint drops the allowed hosts, so this is the one place a person sees them.
  const offSite = nav.offSite ?? `the tab did not end on ${expected[0]}${tab.allowHosts?.length ? ` or one of ${offAllowed(tab.allowHosts)}` : '; open the final address directly'}`;
  const raw = rawFor();
  const park = () => raw('POST', '/context', { name: NATIVE });
  const here = originIs(expected), tok = JSON.stringify(tab.token);
  const fresh = targetHref ? `if (location.href !== ${JSON.stringify(targetHref)}) return null;`
    : beforeOrigin === null ? '' : `if (performance.timeOrigin === ${JSON.stringify(beforeOrigin)}) return null;`;
  const progress = { selected: false };
  // A probe or mark script that gets no answer (the queue is blocked behind it) is a pause, not a failure to read: the probe
  // only reads and the mark writes only into the probed document, so a script that runs late does no harm. Any other failure is no answer in the old sense.
  const noAnswer = stage => e => {
    passCut(e);
    throwIfPinRefused(e);
    if (busy(e)) throw tabError(pauseText(limitMs), { timedOut: true, stage });
    return null;
  };
  // `landed`: the context read after the move. Ids only go to run.log (movedTo says whether the
  // page was listed before the navigation started), never an address or a title.
  const onMove = async (where, landed, why) => {
    const web = typeof landed === 'string' && TAB_SHAPE.test(landed) && landed !== tab.page;
    const movedTo = typeof landed !== 'string' ? 'unreadable' : landed === NATIVE ? 'native' : !web ? 'unreadable' : !Array.isArray(nav.listed) ? 'unknown' : nav.listed.includes(landed) ? 'known' : 'new';
    logRun(`safari plant: context moved ${where} page=${tab.page} movedTo=${movedTo}${web ? ` landed=${landed}` : ''} retry=${web && !tries.retried}`);
    if (!web || tries.retried) throw movedError(why);
    tries.retried = true; // spent before anything is awaited: no failure below can leave the budget unused
    try {
      await park();
      if (!contextIds(await raw('GET', '/contexts')).includes(landed)) throw movedError(why);
      await settleTabList(raw, tab);
    } catch (e) {
      passCut(e);
      if (e?.gone) logRun(`safari plant: pListedAfterSettle=false page=${tab.page}`);
      // Only "the lab's tab is gone" is not a taint; any other failure while waiting out a move is one.
      throw e?.gone || e?.moved ? e : movedError(why);
    }
    logRun(`safari plant: pListedAfterSettle=true page=${tab.page}`);
    return null;
  };
  try {
    try { await selectTab(raw, tab, progress); } catch (e) {
      if (e.afterSelect) return await onMove('after the select', e.landed, e.message);
      throw e;
    }
    const probe = await raw('POST', '/execute/sync', {
      script: `if (document.readyState !== "complete") return null; ${fresh} if (!(${here})) return false; return [performance.timeOrigin, location.origin, window.name === ${tok}];`,
      args: [],
    }, limitMs).catch(noAnswer('probe'));
    const afterProbe = await raw('GET', '/context').catch(e => { passCut(e); return null; });
    if (afterProbe !== tab.page) return await onMove('after the probe', afterProbe, 'the page changed while the lab\'s tab was being marked again');
    // The foreign origin is never printed: only where the lab sent the tab.
    if (probe === false) { await park(); throw movedError(offSite); }
    const ready = Array.isArray(probe) && probe.length === 3 && typeof probe[0] === 'number' && typeof probe[1] === 'string' && expected.includes(probe[1]) && typeof probe[2] === 'boolean';
    if (!ready) { await park(); return null; }
    if (probe[2]) { await park(); return probe[1]; } // the marker survived this navigation
    const r = await raw('POST', '/execute/sync', {
      script: `if (performance.timeOrigin !== ${JSON.stringify(probe[0])}) return null; if (!(${here})) return false; window.name = ${tok}; return location.origin;`,
      args: [],
    }, limitMs).catch(noAnswer('mark'));
    const afterMark = await raw('GET', '/context').catch(e => { passCut(e); return null; });
    if (afterMark !== tab.page) return await onMove('after the mark', afterMark, 'the page changed while the lab\'s tab was being marked again');
    await park();
    if (r === false) throw movedError(offSite);
    return typeof r === 'string' && expected.includes(r) ? r : null;
  } catch (e) {
    // An interrupt is handled as in guarded: one read and one park, sent under duringCleanup; a move only if the park shows one.
    if (e instanceof InterruptError) {
      const parked = await duringCleanup(() => parkAfterTimeout(raw, tab));
      throw cutOff(e, tab, parked === 'moved' || parked === 'foreign', 'plant');
    }
    const parked = e?.timedOut ? await duringCleanup(() => parkAfterTimeout(raw, tab)) : null;
    const moved = e?.timedOut ? parked === 'moved' || parked === 'foreign' : await duringCleanup(() => parkAfterFailure(raw, tab, e, progress));
    if (moved) taint(tab);
    // A park that shows another page, or does not land, is a move: the taint text, never the pause's ("the session is still good").
    if (moved && e?.timedOut) {
      logRun(`safari plant: no answer stage=${e.stage} and the session was not parked page=${tab.page}`);
      throw movedError(`the lab's tab did not answer while it was being marked again, and ${parked === 'foreign' ? 'the session was attached to another page' : 'the session did not return to the native app'}`);
    }
    // No answer while the marker was being put back: not a move, but the marker never went back, so the next
    // command taints if the page changed site. Its own words, not the generic pause. A phone that locked answers nothing: needs unlock.
    if (!moved && (e?.timedOut || e?.pending)) {
      const lock = phoneLocked();
      if (lock) throw lock;
      if (e.timedOut) {
        logRun(`safari plant: no answer stage=${e.stage}, not tainted page=${tab.page}`);
        markWaiting(tab);
      }
      throw tabError('the lab\'s tab did not answer while it was being marked again after the navigation; switch back to it. If the page changed site, the next command refuses and needs `safari start`');
    }
    if (isTabError(e)) throw moved && !e.moved ? retaint(e) : e;
    return null;
  }
}

// --- selectors: plain CSS, or text / position / shadow roots ---

// A selector is a bare string (plain CSS) or { css, text, contains, nth, shadow: [host css...] }.
// Plain CSS keeps the old paths. Anything else is resolved in the page by RESOLVE, which every
// script that finds an element is prefixed with, so all of them agree on what "the element" is.
// `text` is innerText, trimmed, with each run of whitespace one space (the argument is made the
// same way in Node): exact, or a substring with `contains`. The candidates are the CSS matches, or
// every element under body (every element of a shadow root) when there is no CSS; script, style,
// noscript and template are skipped, and more than SEL_CAP candidates are not searched. Of the
// elements whose text matches, one that contains another that matches is dropped, so the
// innermost is kept. `shadow` is a chain of hosts: each is searched in the roots of the one
// before, and the target in the roots of the last. `nth` (1-based) picks among the matches.
// scanSel() gives { list, step, hosts, rooted, over }: `step` is the index of the host that
// ended the chain (no match, or a host with no open shadow root: `rooted` of its `hosts` have
// one), else -1; `over` is 1 when there were too many candidates to search.
const SEL_CAP = 5000;
const NTH_MAX = 10000;
export const RESOLVE = String.raw`function scanSel(sel) {
  const s = typeof sel === 'string' ? { css: sel } : sel;
  const res = { list: [], step: -1, hosts: 0, rooted: 0, over: 0 };
  const chain = s.shadow || [];
  let scopes = [document];
  for (let i = 0; i < chain.length; i++) {
    const hosts = [];
    for (const sc of scopes) for (const h of Array.from(sc.querySelectorAll(chain[i]))) hosts.push(h);
    const rooted = hosts.filter(h => h.shadowRoot).length;
    if (!hosts.length || rooted < hosts.length) { res.step = i; res.hosts = hosts.length; res.rooted = rooted; return res; }
    scopes = hosts.map(h => h.shadowRoot);
  }
  const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  let seen = 0;
  for (const sc of scopes) {
    const cand = Array.from(sc.querySelectorAll(s.css || (sc === document ? 'body *' : '*')));
    if (s.text === undefined) { for (const e of cand) res.list.push(e); continue; }
    seen += cand.length;
    if (seen > ${SEL_CAP}) { res.over = 1; res.list = []; return res; }
    const hit = [];
    for (const e of cand) {
      if (skip[String(e.tagName).toUpperCase()]) continue;
      const t = String(e.innerText == null ? '' : e.innerText).replace(/\s+/g, ' ').trim();
      if (s.contains ? t.includes(s.text) : t === s.text) hit.push(e);
    }
    for (let i = 0; i < hit.length; i++) if (!(i + 1 < hit.length && hit[i].contains(hit[i + 1]))) res.list.push(hit[i]);
  }
  return res;
}
function all(sel) { return typeof sel === 'string' ? Array.from(document.querySelectorAll(sel)) : scanSel(sel).list; }
function pick(sel) {
  if (typeof sel === 'string') return document.querySelector(sel);
  return scanSel(sel).list[(sel.nth || 1) - 1] || null;
}`;
// Numbers only: nothing the page holds comes back from a count.
export const SELECT_COUNT = `${RESOLVE}
const found = scanSel(arguments[0]);
return { count: found.list.length, hosts: found.hosts, rooted: found.rooted, step: found.step, over: found.over };`;
const RESOLVE_ELEMENT = `${RESOLVE}\nreturn pick(arguments[0]);`; // WebDriver answers a returned element with a reference to it
export const CLICK_SCRIPT = `${RESOLVE}
const el = pick(arguments[0]); if (!el) throw new Error("no such element"); el.click(); return true`;
export const TYPE_SCRIPT = `${RESOLVE}
const el = pick(arguments[0]); if (!el) throw new Error("no such element");
el.focus();
const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
set.call(el, (el.value || '') + arguments[1]);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return true`;

const normText = s => String(s).replace(/\s+/g, ' ').trim();
const quoted = s => JSON.stringify(s);
const SELECT_FLAGS = '[--text <text> [--contains]] [--nth <N>] [--shadow]';
const SELECTOR_USAGE = {
  click: `usage: safari click [css] ${SELECT_FLAGS} [--]`,
  type: `usage: safari type [css] ${SELECT_FLAGS} [--] <text>`,
  tap: `usage: safari tap [css] ${SELECT_FLAGS} [--]  or  safari tap --label "<a11y label>"`,
  wait: `usage: safari wait [css] ${SELECT_FLAGS} [--visible|--gone] [--timeout <ms>] [--]  or  safari wait --settled [--quiet <ms>] [--timeout <ms>]`,
  shot: `usage: safari shot [name] [--page | --element <css> [--text <text> [--contains]] [--nth <N>] [--shadow]] [--scale <0-1> | --width <px>] [--]`,
};

// How a selector reads in the output: `host >> inner text="Continue" #2`. Only what the agent typed.
export function describeSel(sel) {
  if (typeof sel === 'string') return sel;
  const where = [...(sel.shadow || []), ...(sel.css === undefined ? [] : [sel.css])].join(' >> ');
  const text = sel.text === undefined ? '' : `text${sel.contains ? '*' : ''}=${quoted(sel.text)}`;
  return [where, text, sel.nth === undefined ? '' : `#${sel.nth}`].filter(Boolean).join(' ');
}

// click, type and tap: [css...] [--text T] [--contains] [--nth N] [--shadow]; tap also --label L.
// Only these flags are known; a bare `--` ends the flags. An unknown --word is an error, except
// for `type` (`textLast`), whose last argument is the text and may be any word, like `--x`.
// `wait` adds its own: `bools` and `values` (flags without and with a value) come back in
// `opts` as given (a value is the raw string), and with `optional` no selector at all is allowed
// (`sel` is then undefined).
// With --shadow every argument is a selector and the last is the target. With `type` and --text
// and no css the only argument is the text. Returns { sel } (a string when it is plain CSS),
// { label } for tap --label, and { typed } for type. Nothing is sent before it all checks out.
export function parseSelectorArgs(argv, { name, textLast = false, label = false, bools = [], values = [], optional = false }) {
  const bad = msg => new Error(`${name}: ${msg}; ${SELECTOR_USAGE[name]}`);
  const pos = [], f = {};
  const takes = ['text', 'nth', ...(label ? ['label'] : []), ...values];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal || !a.startsWith('--')) pos.push(a);
    else if (a === '--') literal = true;
    else if (takes.includes(a.slice(2))) {
      const k = a.slice(2);
      if (k in f) throw bad(`--${k} was given twice`);
      if (i + 1 >= argv.length) throw bad(`--${k} needs a value`);
      f[k] = argv[++i];
    } else if (a === '--contains' || a === '--shadow' || bools.includes(a.slice(2))) f[a.slice(2)] = true;
    else if (textLast) pos.push(a);
    else throw bad(`${/^--[A-Za-z][A-Za-z0-9-]{0,30}$/.test(a) ? `unknown flag ${a}` : `argument #${i + 1} is not a flag ${name} knows`} (a selector that starts with -- goes after a bare --)`); // a word that isn't shaped like a flag name is not echoed
  }
  if (f.label !== undefined) {
    if (pos.length || f.text !== undefined || f.contains || f.nth !== undefined || f.shadow) throw bad('--label stands alone: no css, --text, --contains, --nth or --shadow');
    if (!f.label) throw bad('--label needs the accessibility label');
    return { label: f.label };
  }
  let typed;
  if (textLast) {
    if (!pos.length) throw bad('the text to type is missing');
    typed = pos.pop();
  }
  const text = f.text === undefined ? undefined : normText(f.text);
  if (text === '') throw bad('--text is empty');
  if (f.contains && text === undefined) throw bad('--contains needs --text');
  let nth;
  if (f.nth !== undefined) {
    if (!/^[0-9]+$/.test(f.nth) || Number(f.nth) < 1 || Number(f.nth) > NTH_MAX) throw bad(`--nth must be a whole number from 1 to ${NTH_MAX}`);
    nth = Number(f.nth);
  }
  if (pos.includes('')) throw bad('a selector is empty');
  let css, shadow;
  if (f.shadow) {
    if (pos.length < 2) throw bad('--shadow needs the host selector(s) and then the target (use "*" as the target with --text)');
    shadow = pos.slice(0, -1);
    css = pos.at(-1);
  } else {
    if (pos.length > 1) throw bad('one selector only (--shadow takes a chain of them)');
    css = pos[0];
  }
  const opts = Object.fromEntries([...bools, ...values].filter(k => k in f).map(k => [k, f[k]]));
  const withOpts = r => (bools.length || values.length ? { ...r, opts } : r);
  if (css === undefined && text === undefined) {
    if (nth !== undefined) throw bad('--nth needs a css selector or --text');
    if (!optional) throw bad('needs a css selector or --text');
    return withOpts({ sel: undefined });
  }
  const plain = text === undefined && nth === undefined && !shadow;
  const sel = plain ? css : {
    ...(css === undefined ? {} : { css }),
    ...(text === undefined ? {} : { text }),
    ...(f.contains ? { contains: true } : {}),
    ...(nth === undefined ? {} : { nth }),
    ...(shadow ? { shadow } : {}),
  };
  return withOpts(typed === undefined ? { sel } : { sel, typed });
}

// Page requests the WebDriver way, answered by guarded scripts on the phone.
async function devicePage(method, path, body) {
  const key = `${method} ${path}`;
  if (key === 'POST /execute/sync') return guarded(body.script, body.args ?? []);
  if (key === 'GET /url') return guarded('return location.href');
  if (key === 'GET /title') return guarded('return document.title');
  if (key === 'GET /source') return guarded('return document.documentElement.outerHTML');
  if (key === 'POST /elements' && body?.using === 'css selector') {
    const n = await guarded('return document.querySelectorAll(arguments[0]).length', [body.value]);
    const ref = CSS_REF + Buffer.from(String(body.value), 'utf8').toString('base64url');
    return Array.from({ length: Number.isInteger(n) ? n : 0 }, () => ({ [ELEMENT]: ref }));
  }
  const el = /^\/element\/([^/]+)\/(click|value)$/.exec(path);
  if (method === 'POST' && el && CSS_REF_SHAPE.test(el[1])) {
    const css = Buffer.from(el[1].slice(CSS_REF.length), 'base64url').toString('utf8');
    return el[2] === 'click' ? guarded(CLICK_SCRIPT, [css]) : guarded(TYPE_SCRIPT, [css, body.text]);
  }
  throw tabError(`${key} is not available on the phone`);
}

// Whether the lab's tab is the one showing. The native actions (tap, keys, swipe, shot, ui)
// act on the screen, so they need it. visibilityState only: hasFocus() is often false even
// when the tab is showing.
async function requireVisible() {
  const v = await guarded('return document.visibilityState');
  if (v !== 'visible') throw tabError('the lab\'s tab is not the one showing on the phone, so nothing was done on the screen');
}

// Runs right after a DEVICE session is created and recorded. The driver has picked a page and
// the context is read first. The one script ever run in a page not yet verified is a single
// conditional one: if the page carries this run's tag it gets the marker, otherwise it does
// nothing and says so. The context is read again afterwards and must be the same page. Then the
// tab is remembered and the session parks in NATIVE_APP; in every other case the session ends
// (the caller says the tab it opened is still on the phone).
async function pinDeviceTab(tag, allowHosts = []) {
  const raw = rawFor();
  const giveUp = async why => {
    await raw('POST', '/context', { name: NATIVE }).catch(() => {});
    const now = loadState();
    const keyboard = await restoreKeyboard({ session: now.session, port: now.port, state: now });
    await raw('DELETE', '', undefined, WAIT.staleMs).catch(() => {});
    saveState({ session: null, backend: null, target: null, injected: null, deviceTab: null, pagePin: null, transport: null });
    const err = tabError(why);
    err.extra.keyboardRestored = keyboard.keyboardRestored;
    if (keyboard.keyboardNote) err.extra.keyboardNote = keyboard.keyboardNote;
    if (keyboard.human) err.extra.human.push(...keyboard.human);
    throw err;
  };
  const token = `msl-tok-${randomBytes(8).toString('hex')}`;
  let picked, ours = false, here = null, broke = null;
  try {
    picked = await raw('GET', '/context');
    if (typeof picked === 'string' && TAB_SHAPE.test(picked)) {
      const done = await raw('POST', '/execute/sync', {
        script: `if (location.origin !== ${JSON.stringify(START_ORIGIN)} || location.search !== ${JSON.stringify(`?${tag}`)}) return false; window.name = ${JSON.stringify(token)}; return location.origin`,
        args: [],
      }, WAIT.tabMs);
      here = typeof done === 'string' && ORIGIN_SHAPE.test(done) ? done : null;
      ours = here !== null && (await raw('GET', '/context')) === picked;
      if (ours) await raw('POST', '/context', { name: NATIVE });
    }
  } catch (e) {
    passCut(e); // the session stays recorded (with no tab): `safari stop` or the next `safari start` ends it
    broke = `could not confirm the lab's tab at start (${e.wd || 'no answer'})`;
  }
  if (broke) return giveUp(broke);
  if (!ours) return giveUp('the first page Safari showed was not the tab the lab opened (or none was showing); nothing else was read');
  saveState({ deviceTab: { page: picked, token, origin: here, tag, origins: [here], ...(allowHosts.length ? { allowHosts } : {}) } });
}

// The ids Safari lists right now (null when unreadable), taken before a navigation to tell, in
// run.log, whether a page that later pulls the driver away was already there.
async function listedPages() {
  try { return contextIds(await rawFor()('GET', '/contexts')); } catch { return null; }
}

// After a guarded navigation: waits for the lab's page to hold the new document, puts the marker
// back (plantAfterNav) and records where the tab ended up. `requested` is the origin asked for
// (null on refresh); both it and the final origin join the visited ones. `nav.tries` is the
// navigation's one wait-out of a context move, shared by every poll.
async function devicePlant(nav, requested) {
  const end = CLOCK.now() + WAIT.timeoutMs;
  let origin;
  while (!(origin = await plantAfterNav(nav, end))) {
    if (CLOCK.now() >= end) throw tabError(nav.stalled ?? `the lab's tab did not finish loading within ${Math.round(WAIT.timeoutMs / 1000)}s, so it was not marked again; run \`safari stop\` and \`safari start\``);
    await CLOCK.sleep(WAIT.plantPollMs);
  }
  const { navTo, ...tab } = readTab(); // the navigation is verified now: `origin` says where the tab is
  const origins = [...tab.origins];
  for (const o of [requested, origin]) if (typeof o === 'string' && /^https?:\/\//.test(o) && !origins.includes(o)) origins.push(o);
  saveState({ deviceTab: { ...tab, origin, origins } });
}

// The lab's tab is on one of the session's allowed hosts without its marker, or on another of them: marks it again through
// the same select, probe and mark as after `open` (plantAfterNav: the context checked after each script, a move waited out
// once, the marker written only into a complete document whose origin is allowed, a foreign one taints), records where it
// is, and puts the console and network collectors back (a new document has none; scripts are never injected again).
// Not a taint: a page that does not finish loading in time (the next command tries again).
async function followTab(tab) {
  await devicePlant({
    beforeOrigin: null, targetHref: null, expected: allowOrigins(tab.allowHosts), tries: { retried: false }, listed: await listedPages(),
    offSite: `the lab's tab moved to a site that is not one of ${offAllowed(tab.allowHosts)}`,
    stalled: `the lab's tab went to one of its allowed hosts but the page did not finish loading within ${Math.round(WAIT.timeoutMs / 1000)}s, so it was not marked again; run the command again`,
  }, null);
  const now = readTab();
  logRun(`safari follow: page=${now.page} to=${now.origin}`);
  if (!followed.includes(now.origin)) followed.push(now.origin);
  await guarded(DEVICE_HOOKS, [], { noFollow: true, limitMs: WAIT.timeoutMs, label: 'collectors' }); // the tab just loaded: it may be busy
}

// WebDriverAgent turns the phone's Auto-Correction and Predictive off when it starts, for the whole
// phone, and nothing else turns them back on. Before a device session is deleted the lab sets them
// to the saved target (see keyboardTarget) with a native WDA call and reads them back. No page
// context, no tab: it works on a tainted session too. `state` is the lab state (the target comes
// from its saved phone). Never throws but for an interrupt; { keyboardRestored: true } once the phone reports the target
// (and the pending mark is cleared), else { keyboardRestored: false, human, keyboardNote } and the mark stays. The
// note (why, masked) goes in the JSON and run.log, never to stderr: the output stays one JSON object.
async function restoreKeyboard({ session, port, state }) {
  const want = keyboardTarget(state);
  const base = backendUrl('appium', Number.isInteger(port) ? port : DEFAULT_PORT.appium);
  const at = `/session/${session}/appium/settings`;
  const bool = v => (v === true || v === 1 ? true : v === false || v === 0 ? false : null);
  try {
    await wd(base, 'POST', at, { settings: { keyboardAutocorrection: want.autocorrection, keyboardPrediction: want.prediction } }, WAIT.restoreMs);
    const got = await wd(base, 'GET', at, undefined, WAIT.restoreMs);
    if (bool(got?.keyboardAutocorrection) !== want.autocorrection || bool(got?.keyboardPrediction) !== want.prediction) {
      throw new Error('the phone does not report the keyboard settings that were set');
    }
    saveState({ keyboardPending: null });
    return { keyboardRestored: true };
  } catch (e) {
    passCut(e); // the mark stays, and so does the session: its caller must not go on to delete it
    const keyboardNote = maskDevices(redactUrl(`restoring the keyboard settings: ${e.message}`));
    logRun(`safari ${keyboardNote}`);
    return { keyboardRestored: false, human: [KEYBOARD_HUMAN], keyboardNote };
  }
}

// Ends a device session the way the owner's phone needs: the lab's tab first, then the keyboard
// settings are restored (restoreKeyboard; a failure is reported, never thrown), then the Appium
// session (a failed delete is only warned about). It clears `deviceTab` from the state and
// nothing else: the caller clears the session record. The tab is closed by the page itself, from a timer, so that Appium
// never runs in the owner's tabs: one guarded script arms `window.close()` for
// WAIT.closeDelayMs and the session goes native at once; while it is native the driver only
// records that the page went (it attaches to nothing); if the timer wins that race, the pin takes
// the session native instead of letting Appium follow the owner's key tab. A tab with more than one page in its
// history is blanked instead; one that is still listed after the timer is blanked too. A tab
// that can't be confirmed to be the lab's is left alone, with a step for a person. Returns
// { tabClosed, tabLeft?, blanked?, closeRace?, tabGone?, keyboardRestored?, phoneRestored?, phoneRestore?, human? }
// (the phone fields only when the lab had changed Appearance or the orientation). `safari stop` and `lab down` use it.
// An interrupt while a session is being ended: nothing more is sent, and the session record (and the tab's) stays, so
// `safari stop` and `lab down` neither clear it nor report it stopped; running them again finishes the job.
function sessionKept(e) {
  const line = 'The session was not ended: run `safari stop` (or `lab down`) again to finish.';
  e.extra = { ...e.extra, sessionKept: true, human: [...(e.extra?.human ?? []), line] };
  return e;
}

export async function endDeviceSession() {
  const state = loadState();
  const live = typeof state.session === 'string' && state.session;
  let tabClosed = false, blanked = false, closeRace = false, arming = false, tabGone = false, human;
  const site = lastSite(state.deviceTab);
  const byHand = `Close the lab's tab on the phone by hand (Safari tab switcher, then the X on its card)${site ? `; the lab last sent it to ${site}` : ''}.`;
  const raceLine = 'The lab took longer to leave its tab than the close timer; the session went to the native app when the tab closed and nothing else was touched.';
  if (live && state.deviceTab) {
    try {
      const raw = rawFor();
      const tab = readTab(state);
      const delay = WAIT.closeDelayMs;
      const t0 = CLOCK.now();
      arming = true;
      const armed = await guarded(`if (history.length !== 1) { location.replace('about:blank'); return 'blanked'; }
setTimeout(function () { window.close(); }, ${Number(delay)});
return 'armed';`);
      const t1 = CLOCK.now();
      arming = false;
      if (armed === 'blanked') {
        blanked = true;
        human = ['The lab\'s tab has more than one page in its history, so it was blanked, not closed. Close the blank tab on the phone by hand.'];
      } else if (armed === 'armed') {
        if (t1 - t0 >= delay) {
          // The timer may have fired while the session was still in the page: with the pin the session went native, without it the driver may have moved to another tab.
          taint(tab);
          closeRace = true;
          human = [raceLine];
        }
        const end = t0 + delay + WAIT.closeMs;
        for (;;) {
          tabClosed = !contextIds(await raw('GET', '/contexts')).includes(tab.page);
          if (tabClosed || CLOCK.now() >= end) break;
          await CLOCK.sleep(WAIT.closePollMs);
        }
        if (!tabClosed && !closeRace) {
          await guarded('location.replace("about:blank"); return true');
          blanked = true;
          human = ['The lab\'s tab would not close, so it was blanked. Close the blank tab on the phone by hand.'];
        } else if (!tabClosed) human = [...human, byHand];
      } else human = [byHand];
    } catch (e) {
      if (e instanceof InterruptError) throw sessionKept(e);
      // A tab that was not there to arm is no race, whatever else the driver did.
      if (e?.gone) {
        tabGone = true;
        human = ['The lab\'s tab was already gone before the lab could close it (closed by hand, or Safari restarted); nothing was sent to the phone. If a Safari tab the lab opened is still open, close it by hand.'];
      // The context moved while the close was being armed: the timer fired while the session was still in the page (with the pin: the session went native).
      // (guarded counts a timed-out arm script as moved only when the park shows another page or doesn't land; otherwise it is a pause, no race, and the queued arm may still close or blank the lab's tab later.)
      } else if (arming && e?.moved) { closeRace = true; human = [raceLine, byHand]; } else human = human ?? [byHand];
    }
  } else if (state.deviceTab) human = [byHand];
  let keyboard = null, phoneRestore = null;
  try {
    if (live && state.target?.device !== undefined) {
      keyboard = await restoreKeyboard({ session: state.session, port: state.port, state });
      if (keyboard.human) human = [...(human ?? []), ...keyboard.human];
    }
    // The appearance and orientation the lab changed (the ledger in phone-restore.js): devicectl, so no session is needed; a
    // locked or unreachable phone is reported and the entry kept for the next stop, `lab up` or `lab phone restore`.
    if (state.target?.device !== undefined) {
      phoneRestore = await restorePending();
      const lines = restoreHuman(phoneRestore);
      if (lines.length) human = [...(human ?? []), ...lines];
    }
    if (live) {
      const port = Number.isInteger(state.port) ? state.port : DEFAULT_PORT.appium;
      try { await wd(backendUrl('appium', port), 'DELETE', `/session/${state.session}`, undefined, 30e3); } catch (e) {
        passCut(e);
        warn(`[safari] ending the session: ${e.message}`);
      }
    }
  } catch (e) {
    throw e instanceof InterruptError ? sessionKept(e) : e;
  }
  saveState({ deviceTab: null });
  const tabLeft = !state.deviceTab || tabClosed || tabGone ? null : blanked ? 'blank' : 'lab';
  logRun(`safari stop device tab ${tabClosed ? 'closed' : blanked ? 'blanked' : 'left open'}`);
  const phoneOut = restoreReport(phoneRestore);
  delete phoneOut.human; // its lines are in `human` already
  return { ...phoneOut, tabClosed, ...(tabLeft ? { tabLeft } : {}), ...(blanked ? { blanked: true } : {}), ...(closeRace ? { closeRace: true } : {}), ...(tabGone ? { tabGone: true } : {}), ...(keyboard ? { keyboardRestored: keyboard.keyboardRestored } : {}), ...(keyboard?.keyboardNote ? { keyboardNote: keyboard.keyboardNote } : {}), ...(human ? { human } : {}) };
}

// --- Appium: web and native contexts ---

const CONTEXT_LOST = /no such window|invalid context|NoSuchContext|no such context/i;

// Makes sure the session is in Safari's page (a WEBVIEW_ context), resolving the context id
// by listing: it changes between pages and sessions, so it is never remembered.
async function ensureWeb(force = false, timeoutMs = 30e3) {
  if (!force) {
    try {
      const cur = await cmd('GET', '/context', undefined, timeoutMs);
      if (typeof cur === 'string' && cur.startsWith('WEBVIEW_')) return cur;
    } catch { /* fall through to the list */ }
  }
  const list = await cmd('GET', '/contexts', undefined, timeoutMs);
  const name = (Array.isArray(list) ? list : []).map(c => (typeof c === 'string' ? c : c?.id)).find(c => typeof c === 'string' && c.startsWith('WEBVIEW_'));
  if (!name) throw new Error('Safari has no page open');
  await cmd('POST', '/context', { name }, timeoutMs);
  return name;
}

// Whether the recorded Appium session still works: in (or back in) Safari's page and able
// to answer. Only switches context when it has to, since each switch adds a log listener.
// Gives up after WAIT.usableMs altogether. Throws why not.
async function appiumUsable() {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(WAIT.usableMs / 1000)}s`)), WAIT.usableMs);
  });
  try {
    await Promise.race([
      (async () => {
        await ensureWeb(false, WAIT.callMs);
        await cmd('GET', '/url', undefined, WAIT.callMs);
      })(),
      deadline,
    ]);
  } finally { clearTimeout(timer); }
}

// A command on the page, in the web context (re-resolved once if it went stale).
async function pageCmd(method, path, body, timeoutMs) {
  if (session().device) return devicePage(method, path, body); // never switches to a page of its own accord
  await ensureWeb();
  try {
    return await cmd(method, path, body, timeoutMs);
  } catch (e) {
    if (!CONTEXT_LOST.test(`${e.wd || ''} ${e.message}`)) throw e;
    await ensureWeb(true);
    return cmd(method, path, body, timeoutMs);
  }
}

// WebDriverAgent waits up to 10 s before and after every native action for Safari to be
// idle, and on the simulator Safari never is: each tap or key cost about 20 s. Setting the
// timeout to 0 turns the wait off for the session. Best effort: a session where it fails
// works, only slowly.
async function disableIdleWait(url, id) {
  try {
    await wd(url, 'POST', `/session/${id}/appium/settings`, { settings: { waitForIdleTimeout: 0 } }, WAIT.callMs);
  } catch (e) {
    warn(`[safari] couldn't turn off Appium's idle wait (native commands will be slow): ${e.message}`);
  }
}

// --- helpers ---

// Script for WebDriver's execute: whatever parses as an expression is returned as is
// ("document.title", an IIFE that itself contains `return`); anything else (`return 5`,
// several statements) is the function body unchanged.
export function asScript(js) {
  try {
    new Function(`return (${js}\n);`); // syntax check only, never called
    return `return (${js}\n);`;
  } catch {
    return js;
  }
}

// `eval` and a Promise (or any thenable): the script parks it in a slot on the page's global, named by
// a random id, and answers `{ [THENABLE]: id }`; the lab then reads the slot until it settles. Over
// WebDriver a Promise itself would cross as `{}`, and there is no async execute on the phone.
const THENABLE = '__mslThenable';
const EVAL_USAGE = 'usage: safari eval \'<js>\' [--timeout <ms>]';
const AWAIT_READ = `const slots = globalThis.${THENABLE}, s = slots && slots[arguments[0]];
if (!s) return { gone: true };
if (arguments[1]) { delete slots[arguments[0]]; return { dropped: true }; } // eval stopped waiting
if (s.state === 'pending') return { pending: true };
delete slots[arguments[0]];
return s.state === 'ok' ? { done: true, value: s.value } : { done: true, rejected: s.reason };`; // not `error`: a WebDriver answer with one is a failure

// What `inject` leaves on the page's global, so it can tell afterwards that the document it ran in is
// still the one showing (a navigation under it, or one the script made, gives a new document).
const INJECT_MARK = '__mslInjected';

// The element a selector names. Plain CSS is looked up as WebDriver does ({ ref, count }).
// Anything else is counted in the page by SELECT_COUNT (numbers only come back) and refused
// when it names nothing, is ambiguous, or can't be entered; the answer carries the selector
// with its `nth` settled, which is what every later script resolves. Page text never reaches
// a message: only the agent's own words and counts.
async function find(sel) {
  if (typeof sel === 'string') {
    const els = await pageCmd('POST', '/elements', { using: 'css selector', value: sel });
    if (!Array.isArray(els) || !els.length) throw new Error(`no element matches ${sel}`);
    const ref = els[0][ELEMENT];
    if (typeof ref !== 'string') throw new Error('WebDriver returned an element without a reference');
    return { ref, count: els.length, sel };
  }
  const r = await pageCmd('POST', '/execute/sync', { script: SELECT_COUNT, args: [sel] });
  const chain = sel.shadow || [];
  const ints = r && typeof r === 'object' ? ['count', 'hosts', 'rooted', 'step', 'over'].every(k => Number.isInteger(r[k]) && r[k] >= (k === 'step' ? -1 : 0)) : false;
  if (!ints || r.step >= chain.length) throw new Error(`couldn't count the elements for ${describeSel(sel)}: the page gave an answer the lab does not understand`);
  if (r.over) throw new Error(`more than ${SEL_CAP} elements to search for text ${quoted(sel.text)}; give a css selector to narrow it`);
  if (r.step >= 0) {
    if (r.hosts === 0) throw new Error(`no element matches host ${quoted(chain[r.step])}`);
    throw new Error(`host ${quoted(chain[r.step])} has no open shadow root (none, or a closed one, which can't be entered); try tap --label`);
  }
  const css = sel.css === undefined ? '' : ` (${sel.css})`;
  if (r.count === 0) throw new Error(sel.text === undefined ? `no element matches ${describeSel(sel)}` : `no element matches text ${quoted(sel.text)}${css}`);
  if (sel.nth !== undefined && sel.nth > r.count) throw new Error(`--nth ${sel.nth} but only ${r.count} match`);
  if (sel.text !== undefined && sel.nth === undefined && r.count > 1) throw new Error(`${r.count} elements match text ${quoted(sel.text)}${css}; add --nth 1..${r.count}`);
  return { count: r.count, sel: { ...sel, nth: sel.nth ?? 1 } };
}

// The simulator's reference to the element a non-plain selector names: the page returns the
// element and WebDriver answers with its reference, which the ordinary element routes take.
async function elementRef(sel) {
  const ref = (await pageCmd('POST', '/execute/sync', { script: RESOLVE_ELEMENT, args: [sel] }))?.[ELEMENT];
  if (typeof ref !== 'string') throw new Error(`no element matches ${describeSel(sel)}`);
  return ref;
}

// A userscript's metadata (for a GM_info stand-in): @name and @version.
export function userscriptMeta(src) {
  const block = (src.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/) || [])[1] || '';
  const get = k => (block.match(new RegExp(`//\\s*@${k}\\s+(.+)`)) || [])[1]?.trim() || '';
  return { name: get('name'), version: get('version') };
}

// --- which pages a userscript is for (@match, @include, @exclude, @exclude-match) ---

const globToRegExp = (glob, flags = '') => new RegExp(`^${glob.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, flags);

// A WebExtension-style match pattern (`scheme://host/path`, or <all_urls>) against a parsed URL.
// Scheme `*` is http or https; host is `*`, `*.x.com` (x.com and its subdomains) or exact; the
// path (with the query) is a glob. null: the pattern cannot be read.
function matchPattern(pattern, u) {
  if (pattern === '<all_urls>') return u !== null && /^https?:$/.test(u.protocol);
  const m = pattern.match(/^(\*|https?):\/\/([^/]*)(\/.*)$/);
  if (!m) return null;
  if (u === null) return false;
  const [, scheme, host, rest] = m;
  if (scheme === '*' ? !/^https?:$/.test(u.protocol) : u.protocol !== `${scheme}:`) return false;
  const h = host.toLowerCase();
  const target = h.includes(':') ? u.host : u.hostname;
  const hostOk = h === '*' || (h.startsWith('*.') ? target === h.slice(2) || target.endsWith(h.slice(1)) : target === h);
  return hostOk && globToRegExp(rest).test(u.pathname + u.search);
}

// An @include / @exclude value: `/regex/flags`, or a glob on the whole URL. null: unreadable.
function includePattern(pattern, href) {
  const re = pattern.match(/^\/(.+)\/([a-z]*)$/);
  try { return re ? new RegExp(re[1], re[2]).test(href) : globToRegExp(pattern, 'i').test(href); } catch { return null; }
}

// Whether a userscript should run on `url`, and when not, why. No @match or @include: it runs
// everywhere. Any @exclude / @exclude-match that fits wins over the includes. A pattern that
// cannot be read never matches (so an unreadable exclude excludes nothing).
function userscriptVerdict(src, url) {
  const block = (src.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/) || [])[1] || '';
  const rules = { match: [], include: [], exclude: [], 'exclude-match': [] };
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*\/\/\s*@(match|include|exclude-match|exclude)\s+(.+?)\s*$/);
    if (m) rules[m[1]].push(m[2]);
  }
  let u = null;
  try { u = new URL(url); } catch { /* match patterns cannot fit; globs still can */ }
  const href = String(url);
  const hit = (list, test) => list.some(p => test(p) === true);
  if (hit(rules.exclude, p => includePattern(p, href)) || hit(rules['exclude-match'], p => matchPattern(p, u))) return { run: false, why: 'excluded by an @exclude' };
  if (!rules.match.length && !rules.include.length) return { run: true };
  if (hit(rules.match, p => matchPattern(p, u)) || hit(rules.include, p => includePattern(p, href))) return { run: true };
  return { run: false, why: 'the page fits none of its @match / @include' };
}

export const userscriptMatches = (src, url) => userscriptVerdict(src, url).run;

async function waitForDriver(url, ms = 10e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await wd(url, 'GET', '/status', undefined, 2e3); return true; } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

// Runs a userscript in the page now (after load) with a GM_info stand-in. Returns what the
// page threw, if anything.
async function runUserscript(file) {
  const src = fs.readFileSync(file, 'utf8');
  const meta = userscriptMeta(src);
  const mark = String(Math.random()).slice(2);
  const script = `globalThis.${INJECT_MARK} = ${JSON.stringify(mark)};\ntry { if (typeof GM_info === 'undefined') window.GM_info = { script: ${JSON.stringify(meta)}, scriptHandler: 'mobile-safari-lab' };\n${src}\n;return null; } catch (e) { return String(e && e.stack || e); }`;
  try { new Function(script); } catch (e) { throw new Error(`${file}: syntax error: ${redactUrl(e.message)}`); } // never called; before any page call (the phone never answers a script that fails to compile)
  const err = await pageCmd('POST', '/execute/sync', { script, args: [] });
  return { meta, err, mark };
}

// Whether the document showing is still the one `inject` ran in (its mark is on the page's global),
// watched for WAIT.injectWatchMs; false as soon as it is gone.
async function stillThere(mark) {
  const probe = () => pageCmd('POST', '/execute/sync', { script: `return globalThis.${INJECT_MARK} === arguments[0];`, args: [mark] });
  try {
    const gone = await pollUntil(probe, markHere => markHere !== true, { timeoutMs: WAIT.injectWatchMs, pollMs: WAIT.injectPollMs });
    return !gone.done;
  } catch (e) {
    passCut(e);
    if (isTabError(e)) throw e;
    return true; // can't tell: no warning
  }
}

// Runs again the recorded scripts that are for the page at `url`; { done, skipped: [{ file, why }] }.
async function reinject(files, url) {
  const done = [], skipped = [];
  for (const f of files) {
    let r;
    try {
      const verdict = userscriptVerdict(fs.readFileSync(f, 'utf8'), url);
      if (!verdict.run) { skipped.push({ file: f, why: verdict.why }); continue; }
      r = await runUserscript(f);
    } catch (e) { passCut(e); throw new Error(`can't reinject ${f}: ${e.message}`); }
    if (r.err) throw new Error(`reinjecting ${f}: the script threw: ${r.err}`);
    done.push(f);
  }
  return { done, skipped };
}

// `inject` runs a script wherever it is asked to; this says so when the page is not one its
// @match / @include / @exclude name (no URL in the text: it may carry secrets). {} when it fits,
// when the script has no such lines, or when the address can't be read.
async function offPage(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\/\/\s*@(match|include|exclude)/.test(src)) return {};
  let href;
  try { href = await pageCmd('GET', '/url'); } catch (e) {
    passCut(e);
    if (isTabError(e)) throw e;
    return {};
  }
  const verdict = userscriptVerdict(src, href);
  return verdict.run ? {} : { warning: `this page does not match the script's @match / @include / @exclude (${verdict.why}); it ran because inject is explicit` };
}

// open/refresh: re-runs the recorded scripts for the final page (`href`, as read, not redacted)
// and gives the output fields: `reinjected`, and `reinjectSkipped` (file names) when there are some.
// More than one script re-run is a `warning` (joined to `prior`, a warning already on the output):
// two scripts for one page fight over it, and `inject --forget` is the way to drop one.
async function reinjectFor(files, href, prior) {
  const { done, skipped } = await reinject(files, href);
  const several = done.length > 1 ? `${done.length} recorded scripts ran again (${done.join(', ')}); to run fewer, drop one with \`safari inject --forget <file>\`` : null;
  const warning = [prior, several].filter(Boolean).join('; ');
  return { reinjected: done, ...(skipped.length ? { reinjectSkipped: skipped.map(x => x.file) } : {}), ...(warning ? { warning } : {}) };
}

// inject --forget / --clear: the recorded list is keyed by the absolute path `inject` resolved,
// so a file is matched the same way (it need not exist any more). Paths are shown as `reinjected` shows them.
function forgetInjected(mode, file) {
  const recorded = session().injected;
  if (mode === 'clear') {
    saveState({ injected: [] });
    logRun('safari inject --clear');
    return { cleared: recorded.length, ...(recorded.length ? {} : { note: 'no scripts were recorded' }) };
  }
  const abs = path.resolve(file);
  if (!recorded.includes(abs)) {
    throw Object.assign(new Error(`inject --forget: ${file} is not recorded; ${recorded.length ? `recorded: ${recorded.join(', ')}` : 'no scripts are recorded'}`), { skipArtifacts: true, extra: { recorded } });
  }
  const remaining = recorded.filter(f => f !== abs);
  saveState({ injected: remaining });
  logRun(`safari inject --forget ${file}`);
  return { forgotten: file, remaining };
}

// --- waiting for a new document ---
// Navigating or refreshing returns before the page has changed, so wait until the document
// has a new performance.timeOrigin and is complete.

// On the phone the read gets `limitMs` (the page may be loading, so busy: issue 104), else tabMs.
const DOC_STATE = 'return [performance.timeOrigin, document.readyState, location.href];';
async function docState(limitMs = WAIT.tabMs) {
  try {
    const v = session().device
      ? await guarded(DOC_STATE, [], { limitMs, label: 'page state' })
      : await pageCmd('POST', '/execute/sync', { script: DOC_STATE, args: [] }, 10e3);
    return Array.isArray(v) ? { origin: v[0], ready: v[1], href: v[2] } : null;
  } catch (e) {
    passCut(e);
    if (isTabError(e)) throw e; // on the phone a refusal ends the wait; it is not a page still loading
    return null;
  }
}

// True when navigating from `from` to `to` may not make a new document: `to` is the same URL,
// or differs only by its #fragment (even an empty one, `page#`).
function sameDocument(from, to) {
  try {
    const [a, b] = [new URL(from), new URL(to)];
    return a.href === b.href || (b.href.includes('#') && a.href.split('#')[0] === b.href.split('#')[0]);
  } catch { return false; }
}

// `targetHref` (a navigation that may not make a new document) waits for the URL, with the
// document complete, instead of a new document.
async function waitForDocument(beforeOrigin, what, targetHref = null) {
  const end = CLOCK.now() + WAIT.timeoutMs;
  for (;;) {
    const d = await docState(budgetLeft(end));
    if (d) {
      if (targetHref) {
        try { if (d.ready === 'complete' && new URL(d.href).href === targetHref) return d; } catch { /* keep waiting */ }
      } else if (d.ready === 'complete' && (beforeOrigin === null || d.origin !== beforeOrigin)) return d;
    }
    if (CLOCK.now() >= end) {
      throw new Error(`${what}: the page didn't finish loading within ${Math.round(WAIT.timeoutMs / 1000)}s`);
    }
    await CLOCK.sleep(WAIT.pollMs);
  }
}

// --- native geometry (tap, swipe) ---

const rectOk = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]));
const round1 = n => Math.round(n * 10) / 10;
const inside = (r, p) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

// Safari's native tree, read from the web context: `mobile:` calls go straight to
// WebDriverAgent whatever the context, so the session never leaves the page (every switch
// back from the native layer adds a console and network listener to Appium for good). Lean
// unless `full`: only what the rectangles and labels need, about a third of the time.
const LEAN_SOURCE = 'value,name,enabled,accessible,index,hittable,placeholderValue,traits,nativeFrame,focused';
async function nativeTree({ full = false } = {}) {
  const limitMs = full ? WAIT.sourceMs : WAIT.treeMs;
  let xml;
  try {
    xml = await cmd('POST', '/execute/sync', {
      script: 'mobile: source',
      args: [{ format: 'xml', ...(full ? {} : { excludedAttributes: LEAN_SOURCE }) }],
    }, limitMs);
  } catch (e) {
    // Not sent again: WebDriverAgent goes on building the tree, and a second read would wait behind it.
    if (busy(e)) throw new Error(`Safari's screen layout (its UI tree) did not come back within ${secs(limitMs)}s; a heavy page makes it slow. The session is still good: \`safari wait --settled\` waits for a busy page to calm down`);
    throw e;
  }
  if (typeof xml !== 'string' || !/<XCUIElementTypeApplication[\s/>]/.test(xml)) throw new Error('Appium returned no UI source');
  return xml;
}

// Refuses a point outside the page area or on Safari's controls (a tap on the address bar
// followed by typing performs a web search). Refuses to guess when there are more than 50
// controls or one has no usable rectangle: a guard built on a partial list would let a bad
// point through.
function guardPoints(points, area, controls, what) {
  for (const p of points) {
    if (!inside(area, p)) throw new Error(`${what} (${p.x}, ${p.y}) is outside Safari's page area ${JSON.stringify(area)}`);
  }
  if (controls.length > 50) throw new Error(`too many matches (${controls.length}) for Safari's controls`);
  const chrome = controls.map(({ x, y, width, height }) => ({ x, y, width, height }));
  if (!chrome.every(rectOk)) throw new Error('Appium returned an element without a rectangle');
  for (const p of points) {
    for (const r of chrome) {
      if (inside(r, p)) throw new Error(`${what} (${p.x}, ${p.y}) is on Safari's toolbar or address bar ${JSON.stringify(r)}; scroll it clear first`);
    }
  }
}

// Where the page is on the screen. Safari 27 draws it behind the status bar and toolbar, so
// the native web view is the whole screen and says nothing useful. Instead a transparent
// 100x100 probe is pinned near the top-left of the visual viewport (the visible part, which
// moves when the page is zoomed or pinch-zoomed) so that it is on screen, and found in the
// native tree. Its native position and its client position (`getBoundingClientRect`, the
// frame `GEOMETRY` measures in) are the same point, which anchors the mapping: the placement
// offsets themselves are not that point's client coordinates when zoomed. The scale is
// `visualViewport.scale`: the native tree rounds the probe's size to whole points, which is
// off by up to 2%. Without `visualViewport` the probe sits at (0, 0) and its measured size
// gives the scale. The probe is removed again, except when the tab was refused (it is sent nothing more
// then; the next probe first removes any left over). The visual viewport is returned as the
// nested `vv` (Appium drops a top-level `scale` key from a script's result).
const PROBE_INSERT = `const label = arguments[0];
for (const old of Array.from(document.querySelectorAll('[aria-label^="msl-probe-"]'))) old.remove();
const vv = window.visualViewport;
const left = vv && Number.isFinite(vv.offsetLeft) ? vv.offsetLeft : 0;
const top = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
const p = document.createElement('div');
p.setAttribute('role', 'img');
p.setAttribute('aria-label', label);
p.style.cssText = 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:100px;height:100px;pointer-events:none;opacity:0;z-index:2147483647';
document.documentElement.appendChild(p);
const r = p.getBoundingClientRect();
const out = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, origin: { left: r.left, top: r.top } };
if (vv) out.vv = { scale: vv.scale, width: vv.width, height: vv.height };
return out;`;
const PROBE_REMOVE = `const p = document.querySelector('[aria-label="' + arguments[0] + '"]'); if (p) p.remove(); return true;`;

// The visual viewport as the page reported it, or null when it didn't or its size is unusable.
function visualViewportOf(vv) {
  return vv?.scale > 0 && vv.width > 0 && vv.height > 0 ? vv : null;
}

// Runs `fn({ toScreen, area, calibration, chrome, screen, probe, xml })`, all from one native tree read from the
// web context (`xml` is that tree, `probe` the calibration probe's node, `screen` the Application node: the whole screen in points). `toScreen(x, y)` maps client (`getBoundingClientRect`) coordinates to screen
// points; `area` is the visible part of the page on the screen; `chrome` is Safari's own
// controls (for guardPoints). Refuses when the probe is off the screen. With `measure`
// ({ el, arg }: the expression that finds the element in that script, and its argument: a selector), the element is
// measured in the same page script that places the probe, so the rectangle and the probe's
// origin describe one instant; `fn` gets it as `geo`.
async function withPage(fn, measure = null) {
  const label = `msl-probe-${randomBytes(6).toString('hex')}`;
  let failure = null;
  const page = await pageCmd('POST', '/execute/sync', measure
    ? { script: `${RESOLVE}\n${PROBE_INSERT.replace('return out;', `const el = ${measure.el};\nout.geo = (function () {${MEASURE}})();\nreturn out;`)}`, args: [label, measure.arg] }
    : { script: PROBE_INSERT, args: [label] });
  try {
    if (!(page?.innerWidth > 0) || !(page?.innerHeight > 0)) throw new Error('couldn\'t measure the page size');
    if (!Number.isFinite(page.origin?.left) || !Number.isFinite(page.origin?.top)) throw new Error('couldn\'t measure the calibration probe in the page');
    const vv = visualViewportOf(page.vv);
    const { left: clientX, top: clientY } = page.origin; // the probe's position in client coordinates
    let xml, nodes, probe = null;
    const end = Date.now() + WAIT.probeMs;
    for (;;) {
      xml = await nativeTree();
      nodes = parseNodes(xml);
      probe = nodes.find(n => isProbe(n, label));
      if (probe || Date.now() >= end) break;
      await sleep(100);
    }
    if (!probe || !(probe.width > 0) || !(probe.height > 0)) {
      throw new Error('couldn\'t locate the page on screen (the calibration probe is not in the native tree); run `safari ui` to see what is there');
    }
    const screen = nodes.find(isApplication); // the whole screen, in points
    if (!rectOk(screen)) throw new Error('Appium returned no screen size');
    if (probe.x < 0 || probe.y < 0 || probe.x >= screen.width || probe.y >= screen.height) {
      throw new Error(`couldn't place the page on screen: the calibration probe is at (${probe.x}, ${probe.y}), outside the ${screen.width}x${screen.height} screen; reset the zoom, scroll the page to the top, or reload it with \`safari open\`, then try again`);
    }
    const [scaleX, scaleY] = vv ? [vv.scale, vv.scale] : [probe.width / 100, probe.height / 100];
    const [viewW, viewH] = vv ? [vv.width, vv.height] : [page.innerWidth, page.innerHeight];
    const toScreen = (x, y) => ({ x: round1(probe.x + (x - clientX) * scaleX), y: round1(probe.y + (y - clientY) * scaleY) });
    const area = { x: probe.x, y: probe.y, width: round1(viewW * scaleX), height: round1(viewH * scaleY) };
    const calibration = { x: probe.x, y: probe.y, scaleX, scaleY, ...(vv ? { scaleFrom: 'visualViewport' } : {}) };
    return await fn({ toScreen, area, calibration, chrome: nodes.filter(isChrome), geo: page.geo, probe, xml, screen });
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // A refused tab (not showing, or not the lab's) is sent nothing more, nor is the page after an interrupt; the next probe removes this one.
    if (!isTabError(failure) && !(failure instanceof InterruptError)) {
      try { await pageCmd('POST', '/execute/sync', { script: PROBE_REMOVE, args: [label] }); } catch (e) {
        warn(`[safari] couldn't remove the calibration probe: ${e.message}`);
      }
    }
  }
}

// In the page, with `el` set: where the element is (layout-viewport coordinates) and whether
// it is what a tap there would hit; null when there is no such element. `hidden`: why it is
// invisible (a tap on it probably focuses nothing: a page may still listen to it), else null.
export const MEASURE = `if (!el) return null;
const r = el.getBoundingClientRect();
const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
let hit = document.elementFromPoint(cx, cy);
const within = n => { for (let c = n; c; c = c.parentNode || c.host) if (c === el) return true; return false; }; // contains() stops at a shadow root's edge
for (let d = 0; hit && hit.shadowRoot && d < 20; d++) { // a point inside a shadow root: the element there, not its host
  const inner = hit.shadowRoot.elementFromPoint(cx, cy);
  if (!inner || inner === hit) break;
  hit = inner;
}
let cs = null;
try { cs = window.getComputedStyle(el); } catch (e) { /* no style to read */ }
const why = [];
if (cs && cs.display === 'none') why.push('display none');
if (cs && cs.visibility === 'hidden') why.push('visibility hidden');
if (cs && parseFloat(cs.opacity) === 0) why.push('opacity 0');
if (r.width < 2 || r.height < 2) why.push(Math.round(r.width * 10) / 10 + 'x' + Math.round(r.height * 10) / 10 + ' px');
return {
  cx, cy, rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  covered: !hit ? '(nothing: off screen)' : within(hit) ? null : hit.tagName.toLowerCase(),
  hidden: why.length ? 'hidden (' + why.join(', ') + ')' : null,
};`;
// What the page said about being hidden, only if it has the shape the script above gives (the
// page is not trusted to put other text into the lab's output).
const HIDDEN_PART = /^(display none|visibility hidden|opacity 0|\d{1,5}(\.\d)?x\d{1,5}(\.\d)? px)$/;
const hiddenReason = h => {
  const m = typeof h === 'string' && h.length <= 120 ? h.match(/^hidden \((.+)\)$/) : null;
  return m && m[1].split(', ').every(part => HIDDEN_PART.test(part)) ? h : null;
};
// The expression that finds the tapped element inside a script (after RESOLVE): both targets
// pass the selector, so both find the same element (the phone's remote debugger refuses element
// ids it did not hand out).
const elOf = n => `pick(arguments[${n}])`;
// Scrolls the element to the middle when it is not wholly on screen or sits near the top or
// bottom edge (where Safari's own controls are). `instant`: a smooth scroll is still moving
// when the next read comes.
const scrollScript = `${RESOLVE}
const el = ${elOf(0)};
if (!el) return false;
const r = el.getBoundingClientRect(), cy = r.top + r.height / 2;
if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth || cy < window.innerHeight * 0.1 || cy > window.innerHeight * 0.9) {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}
return true;`;
// After a tap: whether the tapped text field now holds the focus (null: not a text field, where
// focus says nothing: Safari doesn't focus a button or a checkbox).
export const focusScript = `${RESOLVE}
const el = ${elOf(0)};
if (!el) return null;
const t = String(el.type).toLowerCase();
const field = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  || (el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes(t));
const seen = []; // the active element, and inside a shadow root the one active there, and so on
for (let a = document.activeElement, d = 0; a && d < 20; d++) { seen.push(a); a = a.shadowRoot && a.shadowRoot.activeElement; }
return field ? seen.includes(el) : null;`;
// The two reads of a tap's element are the same place when neither coordinate moved by more than a pixel.
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(k => Math.abs(a.rect[k] - b.rect[k]) <= 1);
const geoOk = g => g && rectOk(g.rect) && Number.isFinite(g.cx) && Number.isFinite(g.cy);

// A field is focused when the page's active element is a text field. `document.hasFocus()` is
// not asked: in the simulator it is false whenever the Simulator window isn't frontmost, and on
// the phone often false while the tab is showing (that is checked by `onScreen`); the keyboard
// check in `keys` guards the rest.
const FOCUSED = `const a = document.activeElement;
return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));`;

// The native actions act on the screen: on the phone the lab's tab must be the one showing.
async function onScreen() {
  if (session().device) await requireVisible();
}

// The focused field as `keys` verifies it: null when no field is focused, else its length
// (code units; contenteditable: its text), `maxlength` (-1: none), whether the selection is
// collapsed and where (`pos`: the caret, or the selection's end; -1 if unknown), and whether
// it is still the field that was focused at the first read. `sig`: a 32-bit hash of its text (the
// text itself never leaves the page) and `ev`: how many keydown, beforeinput and input events the
// marked field has received since the listeners were installed (by the first read): a field that
// rewrites its own text after every key (so the length never changes) still shows these.
const FIELD_STATE = `const a = document.activeElement;
if (!a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return null;
if (!window.__mslKeysField) window.__mslKeysField = a;
if (!window.__mslKeysEv) {
  const ev = window.__mslKeysEv = { keydown: 0, beforeinput: 0, input: 0 };
  window.__mslKeysOn = e => {
    const f = window.__mslKeysField, t = e.target;
    if (f && (t === f || (f.isContentEditable && typeof f.contains === 'function' && f.contains(t)))) ev[e.type]++;
  };
  for (const k of ['keydown', 'beforeinput', 'input']) document.addEventListener(k, window.__mslKeysOn, true);
}
let collapsed = true, pos = -1;
try {
  if (a.isContentEditable) {
    const s = window.getSelection();
    if (s) { collapsed = s.isCollapsed; pos = s.focusOffset; }
  } else if (typeof a.selectionStart === 'number') {
    collapsed = a.selectionStart === a.selectionEnd;
    pos = a.selectionEnd;
  }
} catch (e) { /* types without a selection */ }
const v = String(a.isContentEditable ? a.textContent : a.value);
let sig = 0;
for (let i = 0; i < v.length; i++) sig = (Math.imul(sig, 31) + v.charCodeAt(i)) | 0;
return {
  len: v.length, sig,
  max: typeof a.maxLength === 'number' ? a.maxLength : -1,
  collapsed, pos,
  same: window.__mslKeysField === a,
  ev: { keydown: window.__mslKeysEv.keydown, beforeinput: window.__mslKeysEv.beforeinput, input: window.__mslKeysEv.input },
};`;
// FIELD_FORGET starts with the marker's delete (the tests match it with startsWith).
const FIELD_FORGET = `delete window.__mslKeysField;
if (window.__mslKeysOn) for (const k of ['keydown', 'beforeinput', 'input']) document.removeEventListener(k, window.__mslKeysOn, true);
delete window.__mslKeysOn;
delete window.__mslKeysEv;
return true;`;

// The focused field's text, for the phone's post-check of `keys` (it compares what was typed with
// what the field holds). The text of a password field, or of a contenteditable one (its caret
// can't be placed from an offset), is never returned: `skip` says which. `end`: the caret is at the end,
// nothing selected (a field without a caret to read counts only while it is empty). null: no
// field is focused, or not the one the command started in.
const FIELD_VALUE = `const a = document.activeElement;
if (!a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return null;
if (window.__mslKeysField && window.__mslKeysField !== a) return null;
if (a.isContentEditable) return { skip: 'contenteditable' };
if (String(a.type).toLowerCase() === 'password') return { skip: 'password' };
let end = a.value === '';
try { if (typeof a.selectionStart === 'number') end = a.selectionStart === a.selectionEnd && a.selectionEnd === a.value.length; } catch (e) { /* types without a selection */ }
return { skip: false, value: a.value, end };`;

// Whether the keyboard is up (cheap, and answered by WebDriverAgent whatever the context).
async function keyboardShown() {
  try { return (await cmd('POST', '/execute/sync', { script: 'mobile: isKeyboardShown', args: [] })) === true; } catch (e) { passCut(e); return false; }
}

const NO_DELETE_KEY = 'the keyboard\'s delete key isn\'t on screen (is the keyboard shown?)';

// Where the keyboard's delete key is, in points (its centre), read from the native tree.
async function deleteKeyCentre() {
  const key = parseNodes(await nativeTree()).find(isDeleteKey);
  if (!key) throw new Error(NO_DELETE_KEY);
  if (!rectOk(key)) throw new Error('Appium returned the keyboard\'s delete key without a rectangle');
  return { x: round1(key.x + key.width / 2), y: round1(key.y + key.height / 2) };
}

// One character per call with a pause: sending them in bulk drops some mid-word. Returns the
// sender, which remembers whether the last character went out by `mobile: keys` (the gap).
// Backspace: `mobile: keys` deletes nothing with "\b", "\u007f", "\uE003" or "\u0008" (tried
// live), so it taps the keyboard's delete key, looked up on the first Backspace of the run
// and reused (the keyboard does not move while it is up), with a pause after each.
// `beforePress` (the phone: the lab's tab is showing) runs right before every tap or key, after
// the delete key's tree was read, so nothing sits between the check and the press. `onSend`
// runs just before a tap or key goes out: from there the field may hold what was typed.
function makeKeySender({ beforePress = null, onSend = null } = {}) {
  let gap = false, del = null;
  return async ch => {
    if (ch === '\b') {
      // A remembered key is only good while the keyboard is up: never tap its old spot blind.
      if (del && !(await keyboardShown())) throw new Error(NO_DELETE_KEY);
      del ||= await deleteKeyCentre();
      await beforePress?.();
      onSend?.();
      await cmd('POST', '/execute/sync', { script: 'mobile: tap', args: [del] });
      await sleep(WAIT.deleteMs);
      gap = false;
      return;
    }
    if (gap) await sleep(WAIT.charGapMs);
    await beforePress?.();
    onSend?.();
    await cmd('POST', '/execute/sync', { script: 'mobile: keys', args: [{ keys: [ch] }] });
    gap = true;
  };
}

// The focused field as the page sees it, polling until done(state) or WAIT.landMs.
// The state is null when no field is focused.
async function readField(done) {
  const end = Date.now() + WAIT.landMs;
  for (;;) {
    const v = await pageCmd('POST', '/execute/sync', { script: FIELD_STATE, args: [] }, WAIT.readMs);
    const st = v && typeof v === 'object' && Number.isFinite(v.len) ? v : null;
    if (done(st) || Date.now() >= end) return st;
    await sleep(WAIT.landPollMs);
  }
}

const usable = st => st !== null && st.same === true; // still the field the command started in
const EVENTS = ['keydown', 'beforeinput', 'input'];
// Whether the field received any key or input event since `before` was read.
const eventsRose = (st, before) => EVENTS.some(k => (st.ev?.[k] ?? 0) > (before.ev?.[k] ?? 0));
// Whether the field's text is a different text (its hash) than at `before`.
const sigChanged = (st, before) => st.sig !== undefined && before.sig !== undefined && st.sig !== before.sig;

const KEYBOARD_CHANGED = 'keys: the keyboard or the page changed the text (autocorrect, predictive text, smart punctuation, or a field that reformats what is typed): the field no longer holds exactly what was sent. Check the field and clear it; these can be turned off on the phone (Settings > General > Keyboard). The text is not shown here because the field may hold a secret';

// The field's text for the post-check: { value, end }, or { skip: reason } when it can't or must not
// be read ('password', 'contenteditable', or 'unreadable': no field, or not the one the command started in).
async function readFieldText() {
  const v = await pageCmd('POST', '/execute/sync', { script: FIELD_VALUE, args: [] }, WAIT.readMs);
  if (v && typeof v === 'object' && (v.skip === 'password' || v.skip === 'contenteditable')) return { skip: v.skip };
  return v && typeof v === 'object' && v.skip === false && typeof v.value === 'string' ? v : { skip: 'unreadable' };
}

// After a verified run: the field should hold what it held plus what was typed.
// Gives { textChecked: true, caseChanged? } (`caseChanged`: only the case differs, the keyboard's
// auto-capitalisation: "zq" becomes "Zq") or { textChecked: false, textSkip } with the reason it was
// not compared, and throws when the text differs beyond case. Compared only for plain typing into a
// field with the caret at its end, every character checked; the text of either side is never put in
// a message or a result. A character that landed only by event (`byEvent`, counted in `unverified`)
// does not stop the comparison unless the field is exactly as it was: only a field that
// rewrites itself after every key has nothing to compare.
async function checkTyped(before, chars, unverified, byEvent = 0) {
  const skip = textSkip => ({ textChecked: false, textSkip });
  if (before.skip) return skip(before.skip);
  if (chars.includes('\n')) return skip('newline');
  if (chars.includes('\b')) return skip('backspace');
  if (unverified > byEvent) return skip('unverified'); // a character that was not checked (maxlength, a selection, focus gone)
  if (!before.end) return skip('caret');
  const after = await readFieldText();
  if (after.skip) return skip(after.skip);
  if (unverified && after.value === before.value) return skip('unverified');
  const expected = before.value + chars.join('');
  if (after.value === expected) return { textChecked: true };
  if (after.value.toLowerCase() === expected.toLowerCase()) return { textChecked: true, caseChanged: true };
  throw new Error(KEYBOARD_CHANGED);
}

// How `keys` treats a character given the field before it: 'return' (`\n`, never checked),
// 'unusable' (focus left the field), 'inert' (it can't change the field), 'selection' (it
// replaces one), else 'normal'.
export function classifyKey(ch, before) {
  if (ch === '\n') return 'return';
  if (!usable(before)) return 'unusable';
  const del = ch === '\b';
  if (del ? before.len === 0 || (before.collapsed && before.pos === 0) : before.max >= 0 && before.len >= before.max && before.collapsed) return 'inert';
  if (!del && !before.collapsed) return 'selection';
  return 'normal';
}

// Messages about `keys` name places and counts, never the text: it may be a secret.
const typedCount = n => (n === 1 ? '1 character was' : `${n} characters were`);

// Sends each character through put and checks through read that it landed (see keys).
// A character has landed when the field's length changed, its text changed (the hash: a field that
// rewrites itself to the same length) or it received a key or input event (a field that resets itself
// to the same text after every key). One that landed only by event is counted in `byEvent` and as
// `unverified` (the text was not seen to change), and is never sent again. Events count only
// while the field has never been seen to differ from where the run started: a field that
// changes at all is not one that resets itself, so a press that fires events and adds nothing
// is a dropped press and is sent again.
// When every character was plain (no Backspace, Return, selection, full or lost field), one of them
// landed by event alone and the field ends up shorter than the text sent, a press was dropped whatever
// the events said, and it fails; a
// longer field (a mask or formatting) is a `warning`. Lengths only: it covers fields whose text is never read.
// Gives { retries, unverified, byEvent, warning? }; throws when a character never lands or lands twice.
async function typeVerified(chars, { put, read }) {
  let retries = 0, unverified = 0, byEvent = 0;
  let known = null; // the field as the last check left it (null: read it again)
  let start = null, last = null, diverged = false, sum = 0, plain = true;
  const note = st => { // where the field has been, as far as it was read
    if (!usable(st)) return;
    start ??= st;
    if (st.len !== start.len || sigChanged(st, start)) diverged = true;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const del = ch === '\b';
    const before = ch === '\n' ? null : known || await read(() => true);
    known = null;
    if (before) note(before);
    const kind = classifyKey(ch, before);
    if (kind !== 'normal' || del) plain = false;
    if (kind === 'return') { await put(ch); continue; }
    if (kind === 'unusable') { await put(ch); unverified++; continue; }
    if (kind === 'inert') {
      await put(ch); // it can't change the field
      if (!del) unverified++;
      continue;
    }
    if (kind === 'selection') {
      // The character replaces the selection, so the length may fall or stay the same, and a
      // resend would type over what the first press wrote: send once, never again.
      await put(ch);
      const shifted = st => st.len !== before.len || st.collapsed !== before.collapsed || st.pos !== before.pos || sigChanged(st, before);
      const moved = st => !usable(st) || shifted(st) || eventsRose(st, before);
      let after = await read(moved);
      // Events can come before the text does: wait for the text, so a late change is not taken for the next character's.
      if (usable(after) && !shifted(after) && eventsRose(after, before)) after = await read(st => !usable(st) || shifted(st));
      if (usable(after) && moved(after)) {
        known = after; // the settled read is where the next character starts
        note(after);
        if (!shifted(after)) { unverified++; byEvent++; }
      } else unverified++;
      continue;
    }
    const grew = st => del ? st.len < before.len : st.len > before.len; // `>`: an emoji adds 2
    const changed = st => !usable(st) || grew(st) || sigChanged(st, before) || (!diverged && eventsRose(st, before));
    let landed = null, sends = 0;
    while (!landed && sends <= WAIT.keyRetries) {
      if (sends > 0) {
        const again = await read(changed); // it may still land (up to ~1 s late): sending it again would double it
        if (changed(again)) { landed = again; break; }
      }
      await put(ch);
      sends++;
      const after = await read(changed);
      if (changed(after)) landed = after;
    }
    if (!landed) {
      throw new Error(`keys: character #${i + 1} did not land after ${sends} attempts; ${typedCount(i)} typed before it. The page may reject it (maxlength, input mask, number field); \`--no-verify\` sends without checking`);
    }
    // Landed by events alone: the text may still be on its way (events can come first). Wait for it
    // up to the whole window, so a late change is not taken for the next character's; a field that
    // rewrites itself never changes and is counted by event once the window is over.
    const textMoved = st => !usable(st) || grew(st) || sigChanged(st, before);
    if (usable(landed) && !textMoved(landed)) landed = await read(textMoved);
    if (sends > 1 && !del && usable(landed)) {
      // A resend can double a press that only arrived late. Give the field the whole window
      // to show more than this one character, and fail rather than report ok.
      const extra = st => !usable(st) || st.len - before.len > ch.length;
      const last = await read(extra);
      if (usable(last) && last.len - before.len > ch.length) {
        throw new Error(`keys: character #${i + 1} was typed more than once (the first press arrived late and it was sent again; extra characters can also come from the field's own formatting, such as an input mask or auto-correct); ${typedCount(i + 1)} typed in all. The field holds extra characters: check it and clear it`);
      }
      if (usable(last)) landed = last;
    }
    retries += sends - 1;
    if (usable(landed)) {
      known = landed;
      note(landed);
      last = landed;
      sum += ch.length;
      if (!grew(landed) && !sigChanged(landed, before)) { unverified++; byEvent++; }
    } else { unverified++; plain = false; }
  }
  const out = { retries, unverified, byEvent };
  if (plain && start && last && (last.len !== start.len || sigChanged(last, start))) {
    const got = last.len - start.len;
    // Short only counts after a press that landed by event alone: a page that rewrites its own text
    // (the length falls or stays while the text changes) is one where every key was seen to land.
    if (got < sum && byEvent > 0) {
      throw new Error(`keys: the field is ${sum - got} character${sum - got === 1 ? '' : 's'} short of what was sent (expected +${sum}, got +${got}); a keypress was probably dropped. Check the field and clear it; the text is not shown here because the field may hold a secret`);
    }
    if (got > sum) out.warning = `the field grew by ${got} characters, ${sum} were sent: the page may format input`;
  }
  return out;
}

// --- starting: the server, then the session ---

// Where the recorded (or default) Appium is: its port, URL, and whether MSL_APPIUM_URL fixes it.
export function appiumEndpoint(flagPort) {
  let cur = null;
  try { cur = readSession(loadState()); } catch { /* damaged: the default */ }
  const saved = cur?.backend === 'appium' && (process.env.MSL_APPIUM_URL || !serviceInstalled()) ? cur.port : null; // a port saved before the service was installed is stale
  const port = flagPort || saved || DEFAULT_PORT.appium;
  return { port, url: backendUrl('appium', port), override: process.env.MSL_APPIUM_URL };
}

// While the LaunchAgent is installed Appium is on its port and no other.
function assertServicePort(port) {
  if (port !== SERVICE.port) throw new Error(`the Appium service listens on ${SERVICE.port}, not ${port}: run \`lab service uninstall\` to use another port`);
}

// The arguments of an Appium the lab starts itself: the service's log level (info; Appium's own
// default is debug) and redaction rules, so typed text stays out of its log too, and the page pin
// plugin when `pin` (it is installed: Appium exits at start on a plugin it can't load). A device
// session needs the service anyway, so this Appium only ever hosts simulator sessions.
export const selfStartArgs = (port, log, filters, pin = false) => ['--address', '127.0.0.1', '--port', String(port), '--log', log, '--log-level', 'info', '--log-filters', filters, ...(pin ? ['--use-plugins', PLUGIN] : [])];

// Makes sure an Appium answers at `url`. Returns { found, did? }. When the LaunchAgent is
// installed launchd owns it: load it if needed and wait (kicking it once if it hasn't come
// back by SERVICE_WAIT.kickMs); never spawn a second one. Otherwise spawns one.
export async function ensureAppium({ port, url, override }) {
  const managed = !override && serviceInstalled();
  if (managed) {
    assertServicePort(port);
    saveState({ driverPid: null }); // launchd's Appium; an old pid (a manual one) must never be killed by `stop`
  }
  if (await waitForDriver(url, 500)) return { found: 'reachable' };
  if (override) throw new Error(`no WebDriver at ${url}`);
  if (managed) {
    const loaded = bootstrapIfNeeded();
    const start = Date.now();
    let kicked = false;
    for (;;) {
      if (await waitForDriver(url, 250)) break;
      const waited = Date.now() - start;
      if (waited >= SERVICE_WAIT.serviceMs) {
        throw new Error(`the Appium service didn't answer within ${Math.round(SERVICE_WAIT.serviceMs / 1000)}s: see ${logPath()}; run \`lab service status\``);
      }
      if (!kicked && waited >= SERVICE_WAIT.kickMs) {
        kicked = true;
        if (launchdState().state !== 'running') kickstart();
      }
      await sleep(SERVICE_WAIT.pollMs);
    }
    return { found: 'not reachable', did: `${loaded ? 'loaded the LaunchAgent and ' : ''}waited for launchd to start Appium` };
  }
  if (!fs.existsSync(appiumBin())) throw new Error(INSTALL_HINT);
  const log = path.join(os.homedir(), 'Library', 'Logs', 'msl-appium.log');
  const child = spawn(appiumBin(), selfStartArgs(port, log, writeLogFilters(), pluginProblem() === null), {
    detached: true, stdio: 'ignore', env: { ...process.env, APPIUM_HOME: appiumHome() },
  });
  child.on('error', e => warn(`[safari] couldn't start Appium: ${e.message}`));
  child.unref();
  if (Number.isInteger(child.pid)) saveState({ driverPid: child.pid });
  if (!(await waitForDriver(url, 60e3))) throw new Error(`Appium didn't start within 60s: see ${log}`);
  return { found: 'not reachable', did: `started Appium (pid ${child.pid})` };
}

// Validates start's flags without touching anything. `mode` is --target (auto, device or
// simulator); `--device <UDID>` means device and must be the saved phone. Returns
// { backend, flagPort, phone, resolveWant }: `resolveWant(alive)` decides the target (a live
// session's target is `alive`; the phone is only asked about when there is no such session).
function parseStartFlags(flags) {
  if (flags.target !== undefined && !TARGETS.includes(flags.target)) throw new Error(`--target must be one of ${TARGETS.join(', ')} (got "${flags.target}")`);
  if (flags.device !== undefined && !isUdid(flags.device)) throw new Error('--device needs the phone\'s UDID (see `lab phone status`)');
  if (flags.device !== undefined && flags.target === 'simulator') throw new Error('--device and --target simulator contradict each other: use one');
  const mode = flags.device !== undefined ? 'device' : flags.target ?? 'auto';
  let flagPort;
  if (flags.port !== undefined) {
    flagPort = Number(flags.port);
    if (!Number.isInteger(flagPort) || flagPort < 1 || flagPort > 65535) throw new Error('--port needs a number from 1 to 65535');
  }
  if (flagPort !== undefined && !process.env.MSL_APPIUM_URL && serviceInstalled()) assertServicePort(flagPort); // before anything probes that port
  const phone = mode === 'simulator' ? null : readPhone(loadState()); // a damaged record throws, pointing to `lab phone setup`
  if (flags.device !== undefined) {
    if (!phone) throw needsError('setup', '--device needs a saved phone, and none is saved');
    if (flags.device !== phone.udid) throw needsError('setup', '--device is not the saved phone; save this one with `lab phone setup`, or leave --device out');
  }
  const simulator = () => ({ simulator: simUdid(flags.profile) }); // `lab up` names the profile; otherwise the live session's, else the one in use
  const eager = mode === 'simulator' || (mode === 'auto' && !phone) ? simulator() : null;
  // What the phone said when it was asked (the transport and iOS version a new device session needs).
  let status = null;
  const resolveWant = async alive => {
    if (eager) return eager;
    if (phone && alive?.device === phone.udid) return alive; // a live session on the saved phone: no need to ask the phone again
    status = phone ? withRoute(await checkPhone(phone.udid), phone) : null;
    const { target } = chooseTarget({ flag: mode, phone, status: status ?? undefined });
    return target === 'device' ? { device: phone.udid } : simulator();
  };
  return { backend: 'appium', flagPort, phone, resolveWant, phoneSaid: () => status };
}

// Whether a recorded device session still answers, asking for nothing from a page: only the
// list of context ids, never a switch into one or a read of its URL.
// A device session is only usable with a trusted tab: one that is recorded, not tainted, and
// still listed (a session that fails this is replaced by `safari start`).
async function deviceUsable(cur) {
  const list = await wd(backendUrl(cur.backend, cur.port), 'GET', `/session/${cur.session}/contexts`, undefined, WAIT.callMs);
  let tab;
  try { tab = readTab(); } catch (e) { throw new Error(`the lab's tab is not trusted any more: ${e.message}`); }
  if (!contextIds(list).includes(tab.page)) throw Object.assign(new Error('the lab\'s tab is gone (closed, or Safari restarted)'), { tabGone: true });
}

// What a person is told when a device session is replaced: the old run's lab tab may still be on
// the phone, and the lab won't touch it (it can't confirm it is the lab's). The tag, kept in the
// record, names the tab's first address.
// `routeGone`: its session was on a Wi-Fi tunnel that is gone, so it could not be asked to close the tab; and the tab is
// never looked for among the phone's pages (they may be the owner's).
function previousTabNote({ routeGone = false } = {}) {
  const t = loadState().deviceTab;
  const tag = typeof t?.tag === 'string' && TAG_SHAPE.test(t.tag) ? t.tag : null;
  const site = lastSite(t);
  const where = site ? `; the lab last sent it to ${site}${tag ? ` (it started on ${tabUrl(tag)})` : ''}` : tag ? ` (${tabUrl(tag)})` : '';
  const why = routeGone ? ' Its session was on a tunnel that is gone, so the lab could not close it.' : '';
  return {
    tabClosed: false,
    tabLeft: 'previous',
    human: [site ? `The previous run's lab tab may still be open${where}. The lab didn't touch it.${why} Close it by hand.` : `The previous run's lab tab${where} may still be open; the lab didn't touch it.${why} Close it by hand.`],
  };
}

// Probes the recorded session `cur` (null: none). `resolveWant(alive)` says which target is
// wanted. Returns { reuse } when the session works and is for it, else { found, did, recovered,
// want, previousTab?, keyboardRestored?, keyboardDeferred?, keyboardNote? } once a dead one is deleted (`previousTab`: its lab tab may be left on the phone).
// A device session made on a Wi-Fi tunnel that is gone (sessionRouteGone) is not asked anything: no liveness probe, no
// keyboard restore (they would wait out 10 s each for a route that is not there), only a short DELETE; its keyboard
// restore is left to the new session's end (`keyboardDeferred`; the mark `keyboardPending` stays). Throws when it works but is for another target.
async function settleExistingSession(cur, backend, resolveWant) {
  if (!cur) return { found: 'no session', did: null, recovered: false, want: await resolveWant(null) };
  if (cur.backend === 'safaridriver') throw new Error(LEGACY);
  const device = cur.target.device !== undefined;
  let why = null, tabGone = false, routeGone = false;
  if (device) {
    const route = await sessionRouteGone(loadState().transport, { wda: true });
    if (route.gone) { routeGone = true; why = `its route to the phone is gone (${route.why})`; }
  }
  if (!routeGone) try { await (device ? deviceUsable(cur) : appiumUsable()); } catch (e) { passCut(e); why = e.message; tabGone = e.tabGone === true; }
  // A phone session that was not started under the page pin (an older lab's) is ended, not reused: a tab the owner opens could pull it away.
  if (!why && cur.target.device !== undefined && cur.pagePin !== PAGE_PIN) why = 'it was started without the page pin';
  const want = await resolveWant(why ? null : cur.target);
  if (!why && cur.backend === backend && JSON.stringify(cur.target) === JSON.stringify(want)) {
    await disableIdleWait(backendUrl(cur.backend, cur.port), cur.session); // sessions from before this was set
    return { reuse: { session: cur.session, backend, reused: true, recovered: false, target: cur.target, found: 'session alive', did: null } };
  }
  if (!why) throw new Error(`a session is already open on ${JSON.stringify(cur.target)}: run \`safari stop\` first`);
  const previousTab = device && !tabGone ? previousTabNote({ routeGone }) : null; // read before the record goes
  // A phone session that is replaced (a tainted one, or one that stopped answering) gets its keyboard
  // settings restored first like any other end. The new session turns them off again and its own
  // end restores them, so a failure here is only reported. Over a dead route nothing could answer the restore.
  const keyboard = device && !routeGone ? await restoreKeyboard({ session: cur.session, port: cur.port, state: loadState() }) : null;
  // Best effort: free whatever the server still holds for it.
  try { await wd(backendUrl(cur.backend, cur.port), 'DELETE', `/session/${cur.session}`, undefined, routeGone ? WAIT.deadDeleteMs : WAIT.staleMs); } catch (e) { passCut(e); /* it is gone or unreachable */ }
  saveState({ session: null, injected: null, deviceTab: null, transport: null }); // driverPid stays, so `stop` can end a server we spawned
  return {
    found: `session dead: ${why}`, did: 'deleted the stale session and created a new one', recovered: true, want,
    ...(previousTab ? { previousTab } : {}),
    ...(keyboard ? { keyboardRestored: keyboard.keyboardRestored } : {}),
    ...(keyboard?.keyboardNote ? { keyboardNote: keyboard.keyboardNote } : {}),
    ...(routeGone ? { keyboardDeferred: 'the new session puts them back when it ends' } : {}),
  };
}

// The `needs` error for a device failure that has none yet. Appium's message for a WebDriverAgent that
// would not start is generic ("xcodebuild failed with code 65"); the reason, such as an untrusted
// developer, is only in its log. So when the message says nothing (`unknown`), the end of that log
// is classified, from `logFrom` (its size when the request began) so an older failure is not read.
const LOG_TAIL_BYTES = 16384;
function deviceNeedsError(e, logFrom) {
  const needs = classify(e.message);
  if (needs !== 'unknown') return needsError(needs, e.message);
  const evidence = tailOf(logPath(), LOG_TAIL_BYTES, logFrom);
  const logged = classify(evidence);
  if (logged === 'unknown') return needsError(needs, e.message);
  return needsError(logged, `${e.message} (Appium's log, ${logPath()}, points to: ${logged})`, { evidence });
}

// A failure after the lab opened its tab on the phone: the tab is still there, and the person is
// told so first (the same shape as every leftover tab: tabClosed false, tabLeft, human).
function leftTab(e, tag, logFrom) {
  if (e instanceof InterruptError) e.extra ??= {};
  else if (!e.extra) e = deviceNeedsError(e, logFrom);
  if (e.extra.tabLeft) return e;
  e.extra = {
    ...e.extra,
    tabClosed: false,
    tabLeft: 'new',
    human: [`The lab opened a Safari tab (${tabUrl(tag)}) but couldn't confirm it, so it touched nothing. Close it by hand: tab switcher, X on its card.`, ...(e.extra.human ?? [])],
  };
  return e;
}

// Creates the session and records it. The last argument is { found, did, recovered, want } from settling the old one.
// `said` is what the phone reported (phoneStatus): `via` "tunnel" is Wi-Fi, anything else the cable.
// Renews the lease while a start waits (a first build, the tunnel and the session create can outlast its TTL);
// tests swap it to record the renewals.
export const hooks = { touch: () => touchLease() };

async function createSession(backend, url, port, phone, { found, did, recovered, want, previousTab, keyboardRestored, keyboardDeferred, keyboardNote }, said = null, { coldBoot = false, allowHosts = [] } = {}) {
  const device = want.device !== undefined;
  // Over Wi-Fi the tunnel comes first; over the cable a tunnel left up is stopped, or xcuitest would
  // find the phone through its registry instead of usbmux.
  const via = device ? (said?.via === 'tunnel' ? 'tunnel' : 'usbmux') : null;
  let tun = null;
  if (via === 'tunnel') tun = (await ensureTunnel(phone, { touch: hooks.touch })).rec;
  else if (device && tunnelRunning()) await stopTunnel();
  // The iOS version: what the phone just said, else the handshake's (tunnel.json), else the last one seen.
  // Over the tunnel Appium can't read it through usbmux (it would try and fail on Wi-Fi), so it must be known.
  const platformVersion = said?.osVersion ?? tun?.osVersion ?? phone?.seen?.osVersion ?? null;
  if (tun && !platformVersion) {
    const e = needsError('unknown', 'the phone\'s iOS version is not known, and over Wi-Fi Appium cannot read it itself');
    e.extra.human = ['The lab could not read the phone\'s iOS version (the device list and the tunnel did not give it), and it needs it to start a session over Wi-Fi.', 'Unlock the phone, then run `lab phone status` (the command below): it shows what the Mac can see. If it shows `osVersion`, run `lab up --target device` again; if not, connect the cable and run `lab up --target device`.'];
    e.extra.then = 'lab phone status';
    throw e;
  }
  // The first Appium session builds WebDriverAgent (~2 min on the simulator; on the phone Xcode
  // signs it too), hence the long timeouts.
  const caps = device
    ? appiumDeviceCaps({ udid: phone.udid, teamId: phone.teamId, bundleId: phone.bundleId, derivedData: wdaDerivedData(), ...(tun ? { tunnel: tun, platformVersion } : {}) })
    : appiumCaps(want.simulator, { keepData: profileOfUdid(want.simulator) === 'configured' });
  // The run's own tab is opened first, so the new session picks it (Safari is restarted with its
  // tabs kept: the new tab gets the lowest page id). The tag in its URL is how start recognises it.
  // sideload shares the Apple team: the signing lock is held from here (the tab, WebDriverAgent's build and launch, the
  // re-sign and the session create) to the create's answer. A busy lock stops the start before the lab's tab is opened.
  const lock = device ? await acquireSignLock() : null;
  let v, retried = null, first = null;
  try {
    let tag = null;
    if (device) {
      tag = newTabTag();
      openTab(phone.udid, tag);
      await sleep(WAIT.tabSettleMs);
    }
    // WebDriverAgent turns the phone's Auto-Correction and Predictive off in its own setUp, which can
    // happen before a create that then fails or times out: the mark goes down first, and stays if the
    // create fails, so `lab down` says the person has to set them.
    if (device) saveState({ keyboardPending: true });
    const logFrom = device ? sizeOf(logPath()) : 0; // Appium's log from here on is this request's
    const create = () => wd(url, 'POST', '/session', { capabilities: { alwaysMatch: caps } }, device ? WAIT.deviceCreateMs : SIM_CREATE_MS);
    try {
      try {
        // Over the tunnel the lab starts WebDriverAgent itself, after the mark above (its setUp turns the keyboard settings off).
        if (tun) await launchWda({ phone, tunnel: tun, platformVersion, touch: hooks.touch });
        await hooks.touch(); // the create below can wait up to WAIT.deviceCreateMs
        try { v = await create(); } catch (e) {
          // After a cold simulator boot Web Inspector can list no pages for ~30 s and Appium gives up
          // with a 500; a second try, a moment later, finds Safari. The same one try for a simulator whose
          // WebDriverAgent failed to start (Appium's timeouts end before the lab's own, so Appium has cleaned up).
          const kind = createFailure(e, { device });
          if (!RETRIED_AS[kind]) throw e;
          first = kind;
          retried = RETRIED_AS[kind];
          await sleep(WAIT.createRetryMs);
          v = await create();
        }
        if (typeof v?.sessionId !== 'string') throw new Error(`${backend} returned no session id`);
        // The plugin marks a phone session it has pinned. Without the marker (no plugin, or it could not pin the driver) the session
        // is ended before anything is sent to a page: a tab the owner opens could pull it away. The new tab is still on the phone (leftTab).
        if (device && v.capabilities?.['msl:pagePin'] !== PAGE_PIN) {
          // Not recorded yet: it is ended under duringCleanup, so a signal before or during the restore still lets the DELETE go.
          const end = async () => {
            const k = await restoreKeyboard({ session: v.sessionId, port, state: loadState() });
            await wd(url, 'DELETE', `/session/${v.sessionId}`, undefined, WAIT.staleMs).catch(() => {});
            return k;
          };
          const keyboard = await duringCleanup(end);
          const err = needsError('service', `${PIN_MISSING}, so ${PIN_RISK}; the session was ended before anything was read`);
          err.extra.human = [...PIN_HUMAN, ...(keyboard.human ?? [])];
          err.extra.keyboardRestored = keyboard.keyboardRestored;
          if (keyboard.keyboardNote) err.extra.keyboardNote = keyboard.keyboardNote;
          throw err;
        }
      } catch (e) {
        passCut(e);
        if (device && !e.extra) throw deviceNeedsError(e, logFrom); // `needs` and the steps for a person
        const cold = device ? null : coldStartHint(e, first, coldBoot);
        if (cold) { e.extra = { ...e.extra, ...cold }; e.coldStart = true; } // `lab up` copies it onto the failed step
        throw e;
      }
      await lock?.release(); // the session exists: nothing more is signed or installed
      saveState({ backend, session: v.sessionId, port, target: want, injected: null, deviceTab: null, pagePin: device ? PAGE_PIN : null, transport: device ? { via, ...(tun ? { address: tun.address, startedAt: tun.startedAt } : {}) } : null }); // keyboardPending stays until a restore is verified; startedAt tells a later `lab up` whether this tunnel is still the one
      await disableIdleWait(url, v.sessionId);
      if (device) await pinDeviceTab(tag, allowHosts);
    } catch (e) {
      const err = device ? leftTab(e, tag, logFrom) : e;
      if (lock?.disabled) err.extra = { ...err.extra, ...lockReport(lock) }; // a failed start says the lock was off too
      throw err;
    }
  } finally {
    await lock?.release();
  }
  logRun(`safari start ${backend} ${JSON.stringify(want)}`);
  const made = `${did ?? 'created a new session'}${retried ? ` (retried after ${retried})` : ''}`;
  // The old tab's step goes in `human` too (issue 103): agents relay `human`, and a tab left on the phone is the owner's to close.
  const human = [...(previousTab?.human ?? []), ...(keyboardRestored === false ? [KEYBOARD_HUMAN] : [])];
  return { session: v.sessionId, backend, reused: false, recovered, target: want, found, did: made, ...(previousTab ? { previousTab } : {}), ...(keyboardRestored !== undefined ? { keyboardRestored } : {}), ...(keyboardNote ? { keyboardNote } : {}), ...(keyboardDeferred ? { keyboardDeferred } : {}), ...(human.length ? { human } : {}), ...lockReport(lock) };
}

// Opens a session, or keeps the recorded one if it still works. `flags` are start's parsed
// flags ({ port, target, device, allowHosts }). Returns { session, backend, target, reused, recovered, found, did }:
// `found` says what was seen ("no session", "session alive", "session dead: <why>") and
// `did` what was done (null when nothing was).
// `allowHosts` (--allow-host, validated again here) are kept in the phone session's tab record; a reused session takes the
// union (hosts are only added). The simulator has no tab guard: they are only reported there, with a note.
export async function startSession(flags = {}) {
  const allowHosts = parseAllowHosts(flags.allowHosts ?? []);
  const { backend, flagPort, phone, resolveWant, phoneSaid } = parseStartFlags(flags);
  let cur = null;
  try { cur = readSession(loadState()); } catch { /* damaged: start fresh */ }
  const settled = await settleExistingSession(cur, backend, resolveWant);
  // What `lab down` goes by when `safari stop` has already ended the session.
  const made = settled.reuse ? settled.reuse.target : settled.want;
  const onPhone = made.device !== undefined;
  const report = hosts => (hosts.length ? { allowHosts: hosts, ...(onPhone ? {} : { note: 'the simulator has no tab guard; its tab may go to any site' }) } : {});
  let union = null; // a reused phone session: its hosts and the new ones, checked before anything is written
  if (settled.reuse && onPhone) {
    const had = readTab().allowHosts ?? []; // a session that is reused has a trusted tab (deviceUsable)
    union = [...new Set([...had, ...allowHosts])];
    if (union.length > MAX_ALLOW_HOSTS) throw new Error(`a session can name at most ${MAX_ALLOW_HOSTS} allowed hosts; this one already has ${had.length}${had.length ? ` (${had.join(', ')})` : ''}`);
    if (union.length > had.length) saveState({ deviceTab: { ...readTab(), allowHosts: union } });
  }
  saveState({ lastTarget: onPhone ? 'device' : 'simulator' });
  if (settled.reuse) return { ...settled.reuse, ...report(union ?? allowHosts) };
  if (settled.want.device !== undefined) requireRedactedService(); // page URLs and titles stay out of Appium's log, and what listens is the service
  else {
    requireCurrentRules(); // the simulator too sends typed text and storage values: the service's rules must be this lab's
    requireOnlyBooted(settled.want.simulator); // every new simulator session passes here: Appium would boot the device it targets
  }
  const ep = appiumEndpoint(flagPort);
  await ensureAppium(ep);
  runForSession(); // the run `sim run` just made, else a fresh folder; a reused session keeps its own
  const started = await createSession(backend, ep.url, ep.port, phone, settled, phoneSaid(), { coldBoot: flags.coldBoot === true, allowHosts: onPhone ? allowHosts : [] });
  markSessionRun(); // only once it exists: a failed start retried keeps the labelled run
  return { ...started, ...report(allowHosts) };
}

// --- commands ---

// Added to `console` / `network` output when Appium's buffer filled (LOG_CAP entries): it
// drops the oldest silently, and every context switch adds another copy of every message.
const lossNote = (copies, what) => ({
  truncated: true,
  copies,
  note: `Appium's ${LOG_CAP}-entry buffer filled, so earlier entries may have been lost. Read \`safari ${what}\` more often, or restart the session (\`safari stop\` then \`safari start\`).`,
});

// What one `safari network` read of the lab page's Resource Timing (NET_READ) gives, rebuilt in
// Node from an allowlist: only an http(s) URL on one of the sites the lab's tab visited this run
// (`origins`, and no credentials in it) is kept; each kept entry is a fresh object with the
// fields below, type-checked, the URL's secret query/fragment values masked and its length
// capped. Anything else (another site, a URL that doesn't parse, a malformed entry) is only
// counted in `outside`. At most 500 entries are looked at, whatever the page said.
const NET_FIELDS = ['startTime', 'duration', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStatus'];
export function resourceEntries(got, origins) {
  const allowed = new Set(origins);
  const list = Array.isArray(got?.entries) ? got.entries.slice(0, 500) : [];
  const num = n => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const word = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  const entries = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || e.name.length > 8192) continue;
    let u;
    try { u = new URL(e.name); } catch { continue; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !allowed.has(u.origin)) continue;
    entries.push({
      name: redactUrl(e.name),
      initiatorType: word(e.initiatorType, /^[\w-]{1,32}$/),
      ...Object.fromEntries(NET_FIELDS.map(k => [k, num(e[k])])),
      nextHopProtocol: word(e.nextHopProtocol, /^[\w./-]{1,32}$/),
    });
  }
  const count = n => (Number.isInteger(n) && n > 0 ? n : 0);
  return {
    entries,
    requests: entries.map(e => ({ method: null, url: e.name, status: e.responseStatus || null })),
    outside: list.length - entries.length,
    left: count(got?.left),
    lost: count(got?.lost),
    early: got?.early === true,
    unsupported: got?.unsupported === true,
  };
}

// Once text has been sent to the page, a failure keeps no screenshot or page source (the field
// may show it) and says nothing the page or Appium wrote about it (it may repeat the text): a
// refusal of the tab guard and the lab's own messages pass as they are. The line in run.log is
// written here, as the failure artifacts would have.
function afterTyping(name, e) {
  let err = e;
  if (e.fromServer || e.fromPage) {
    const code = typeof e.wd === 'string' && /^[a-z ]{3,40}$/.test(e.wd) ? ` (${e.wd})` : '';
    err = Object.assign(new Error(`${name}: a command failed after the text was sent${code}; some of it may have been typed`), { extra: e.extra });
  }
  err.skipArtifacts = true;
  logRun(`safari ${name} FAILED: ${err.message}`);
  return err;
}

async function sendingText(name, send) {
  try { return await send(); } catch (e) { throw afterTyping(name, e); }
}

const KEYS_USAGE = 'usage: safari keys [--no-verify] [--] <text>';

// `keys` takes the text and one flag, `--no-verify`, anywhere; any other --word is refused, by
// its place and never by echoing it (after a bare `--` everything is text, for text that starts with --).
function parseKeysArgs(argv) {
  const pos = [];
  let verify = true, literal = false;
  for (const [i, a] of argv.entries()) {
    if (literal) pos.push(a);
    else if (a === '--') literal = true;
    else if (a === '--no-verify') verify = false;
    else if (a.startsWith('--')) { // the word may be the text itself: named by place only
      const e = new Error(`keys: argument #${i + 1} starts with -- and is not --no-verify; to type text that starts with --, put -- before it; ${KEYS_USAGE}`);
      e.skipArtifacts = true;
      throw e;
    } else pos.push(a);
  }
  return { text: pos[0], verify };
}

// `tap --label`: the one element of the web view's native subtree whose accessibility label is
// exactly `label`, tapped at the centre of its frame (points; no scaling). Only the web view's
// subtree is read, so Safari's tab bar (which can carry the owner's other tabs' titles) is never
// looked at, and the calibration probe, Safari's controls and anything without a real rectangle
// are not candidates. 0 or several hits are refused with their count only. There is no scroll and
// no covered check here: a target outside the visible page is refused, and the point goes through
// the same page-area and toolbar guard as every tap, with the tab-showing check right before it.
async function tapLabel(label) {
  await onScreen();
  const done = await withPage(async ({ area, calibration, chrome, probe, xml }) => {
    const hits = parseNodes(webViewSubtree(xml)).filter(n => n.type !== 'XCUIElementTypeWebView' && !isApplication(n) && !isChrome(n) && !isProbe(n, probe.label)
      && rectOk(n) && n.width > 0 && n.height > 0 && n.label === label);
    if (hits.length !== 1) throw new Error(`${hits.length} elements are labelled ${quoted(label)}; run \`safari ui\` to see the labels in the web view`);
    const x = round1(hits[0].x + hits[0].width / 2), y = round1(hits[0].y + hits[0].height / 2);
    if (!inside(area, { x, y })) throw new Error(`the element labelled ${quoted(label)} is outside the visible page (${x}, ${y}); scroll with \`safari swipe\`, then try again`);
    guardPoints([{ x, y }], area, chrome, 'the tap point');
    await onScreen(); // the tab may have left the screen since the first check
    await cmd('POST', '/execute/sync', { script: 'mobile: tap', args: [{ x, y }] });
    await sleep(WAIT.tapSettleMs);
    return { x, y, area, calibration };
  });
  return { tapped: `label ${quoted(label)}`, via: 'label', x: done.x, y: done.y, page: done.area, calibration: done.calibration };
}

// --- wait: for an element, or for the page to settle ---
// Each poll is one page script (on the phone one guarded call); nothing loops inside the page.
// Output carries counts and timings, never what the page says.

// In the page: how many elements the selector matches, and how many of the first
// `measureCap` (only the --nth one with --nth) are rendered: MEASURE's `hidden` is null (not
// display none, visibility hidden or opacity 0, at least 2x2 px). Covered or off-screen still
// counts as visible; a hidden ancestor with opacity 0 is missed, as in MEASURE. Numbers only.
// `step`, `hosts`, `rooted` and `over` are as in SELECT_COUNT.
export const WAIT_SELECT = `${RESOLVE}
const sel = arguments[0];
const found = scanSel(sel);
const nth = sel && typeof sel === 'object' ? sel.nth : undefined;
const subject = nth === undefined ? found.list.slice(0, ${WAIT_LIMITS.measureCap}) : found.list.slice(nth - 1, nth);
let visible = 0;
for (const el of subject) {
  const g = (function () {${MEASURE}})();
  if (g && g.hidden === null) visible++;
}
return { count: found.list.length, present: subject.length, visible, hosts: found.hosts, rooted: found.rooted, step: found.step, over: found.over };`;

// In the page: installs window.__mslSettle on the first call (so a page that never waits has no
// observers), then reads it. It watches resource loads (PerformanceObserver, not buffered), DOM
// changes (MutationObserver on the root) and, at each read, a change in the page's scroll size
// (Safari has no layout-shift entries). `idleMs` is the time since the last of those, `watchedMs`
// the time since the install. A request still in flight is invisible until it completes, and a page
// that animates through the DOM never settles. A navigation drops the state; the next call
// installs it again. Numbers and booleans only.
export const SETTLE_READ = `const now = performance.now();
const root = document.scrollingElement || document.documentElement;
const dims = () => [Number(root && root.scrollWidth) || 0, Number(root && root.scrollHeight) || 0];
let s = window.__mslSettle;
if (!s) {
  const [w, h] = dims();
  s = window.__mslSettle = { start: now, last: now, res: 0, mut: 0, size: 0, w, h, dom: false, net: false };
  try {
    new MutationObserver(() => { s.mut++; s.last = performance.now(); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    s.dom = true;
  } catch (e) { /* no MutationObserver: the size is still watched */ }
  try {
    new PerformanceObserver(list => { s.res += list.getEntries().length; s.last = performance.now(); }).observe({ type: 'resource' });
    s.net = true;
  } catch (e) { /* no resource entries */ }
}
const [w, h] = dims();
if (w !== s.w || h !== s.h) { s.size++; s.w = w; s.h = h; s.last = now; }
let pendingImages = 0, skippedImages = 0;
for (const img of Array.from(document.images || [])) {
  if (img.complete) continue;
  // An image with no box (display: none, a collapsed or content-visibility: hidden ancestor) has no client rects and never
  // loads when lazy: not waited for. Nor is a lazy image far off screen or 0 x 0 (not started). An eager one that is 0 x 0
  // but has a rect may be a picture whose headers have not arrived, so it is still waited for.
  const lazy = img.loading === 'lazy';
  const hidden = (typeof img.checkVisibility === 'function' && !img.checkVisibility()) || (typeof img.getClientRects === 'function' && img.getClientRects().length === 0);
  const r = !hidden && typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null;
  const empty = hidden || (lazy && r && (r.right - r.left <= 0 || r.bottom - r.top <= 0));
  if (empty || (lazy && (!r || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth))) { skippedImages++; continue; }
  pendingImages++;
}
return {
  complete: document.readyState === 'complete', pendingImages, skippedImages, fontsLoading: !!document.fonts && document.fonts.status === 'loading',
  idleMs: Math.round(now - s.last), watchedMs: Math.round(now - s.start),
  resources: s.res, mutations: s.mut, sizeChanges: s.size, observing: s.dom, resourcesWatched: s.net,
};`;

// Asks again until `test(answer)` holds or `timeoutMs` has passed (checked between asks: one
// that hangs can overrun by its own time limit). { done, polls, elapsedMs, last }; an error from
// `probe` ends the wait.
export async function pollUntil(probe, test, { timeoutMs, pollMs }) {
  const start = CLOCK.now();
  for (let polls = 1; ; polls++) {
    const last = await probe();
    const elapsedMs = CLOCK.now() - start;
    if (test(last)) return { done: true, polls, elapsedMs, last };
    if (elapsedMs >= timeoutMs) return { done: false, polls, elapsedMs, last };
    await CLOCK.sleep(Math.min(pollMs, timeoutMs - elapsedMs));
  }
}

// A timeout is an error carrying what the output should say besides its message.
const timedOut = (what, timeoutMs, detail, extra) => Object.assign(new Error(`timed out after ${timeoutMs} ms waiting for ${what} (${detail})`), { extra: { timeoutMs, ...extra } });

const WAIT_VERB = { present: 'to exist', visible: 'to be visible', gone: 'to be gone (removed or hidden)' };
const WAIT_FIELDS = ['count', 'present', 'visible', 'hosts', 'rooted', 'step', 'over'];

// Until the selector's elements exist (`present`), are rendered (`visible`: at least one) or none
// is rendered (`gone`: removed or hidden; with more matches than are measured, not gone). A shadow chain whose host is missing or has no open
// root keeps the wait going (`gone` counts a missing host as gone, not one it can't look into);
// the timeout names the host.
async function waitForSelector(sel, mode, timeoutMs, pollMs) {
  const what = describeSel(sel);
  const chain = typeof sel === 'string' ? [] : sel.shadow || [];
  const probe = async () => {
    const r = await pageCmd('POST', '/execute/sync', { script: WAIT_SELECT, args: [sel] }, WAIT.callMs);
    const ints = r && typeof r === 'object' && WAIT_FIELDS.every(k => Number.isInteger(r[k]) && r[k] >= (k === 'step' ? -1 : 0));
    if (!ints || r.step >= chain.length || r.visible > r.present || r.present > r.count) throw new Error(`couldn't check ${what}: the page gave an answer the lab does not understand`);
    if (r.over) throw new Error(`more than ${SEL_CAP} elements to search for text ${quoted(sel.text)}; give a css selector to narrow it`);
    return r;
  };
  const blind = r => r.step >= 0 && r.hosts > 0; // a host without an open root: what is inside can't be seen
  const unchecked = r => typeof sel === 'string' || sel.nth === undefined ? r.count > WAIT_LIMITS.measureCap : false; // matches past the ones measured: one of them may be visible
  const test = r => (mode === 'gone' ? r.visible === 0 && !blind(r) && !unchecked(r) : mode === 'visible' ? r.visible > 0 : r.present > 0);
  const res = await pollUntil(probe, test, { timeoutMs, pollMs });
  const r = res.last;
  if (!res.done) {
    let why;
    if (r.step >= 0) why = r.hosts === 0 ? `no element matches host ${quoted(chain[r.step])}` : `host ${quoted(chain[r.step])} has no open shadow root`;
    else if (mode === 'gone') why = r.visible === 0 ? `${r.count} match, only the first ${WAIT_LIMITS.measureCap} were checked` : `${r.visible} of ${r.count} match still visible`;
    else if (r.count === 0) why = 'no match';
    else if (r.present === 0) why = `--nth ${sel.nth} but only ${r.count} match`;
    else why = `${r.count} match, none visible`;
    throw timedOut(`${what} ${WAIT_VERB[mode]}`, timeoutMs, why, { elapsedMs: res.elapsedMs, polls: res.polls, matches: r.count, visible: r.visible });
  }
  return { waited: what, for: mode, matches: r.count, visible: r.visible, elapsedMs: res.elapsedMs, polls: res.polls };
}

// Until the document is complete, no image or font is loading, and nothing has happened in the
// page (a resource loaded, the DOM changed, the scroll size changed) for `quietMs`.
async function waitSettled(quietMs, timeoutMs, pollMs) {
  const bools = ['complete', 'fontsLoading', 'observing', 'resourcesWatched'], ints = ['pendingImages', 'skippedImages', 'idleMs', 'watchedMs', 'resources', 'mutations', 'sizeChanges'];
  const probe = async () => {
    const r = await pageCmd('POST', '/execute/sync', { script: SETTLE_READ, args: [] }, WAIT.callMs);
    if (!r || typeof r !== 'object' || !bools.every(k => typeof r[k] === 'boolean') || !ints.every(k => Number.isInteger(r[k]) && r[k] >= 0)) {
      throw new Error('couldn\'t read the page\'s activity: the page gave an answer the lab does not understand');
    }
    return r;
  };
  const test = r => r.complete && r.pendingImages === 0 && !r.fontsLoading && Math.min(r.idleMs, r.watchedMs) >= quietMs;
  const res = await pollUntil(probe, test, { timeoutMs, pollMs });
  const r = res.last;
  const activity = { resources: r.resources, mutations: r.mutations, sizeChanges: r.sizeChanges };
  if (!res.done) {
    const parts = [];
    if (!r.complete) parts.push('the document is still loading');
    if (r.pendingImages) parts.push(`${r.pendingImages} image${r.pendingImages === 1 ? '' : 's'} still loading${r.skippedImages ? ` (${r.skippedImages} more off-screen or hidden, not waited for)` : ''}`);
    if (r.fontsLoading) parts.push('fonts are still loading');
    parts.push(`last change ${r.idleMs} ms ago, ${r.resources} resources, ${r.mutations} DOM changes, ${r.sizeChanges} size changes`);
    throw timedOut('the page to settle', timeoutMs, `quiet ${quietMs} ms: ${parts.join('; ')}`, {
      elapsedMs: res.elapsedMs, polls: res.polls, quietMs, activity, pendingImages: r.pendingImages, skippedImages: r.skippedImages, complete: r.complete,
    });
  }
  return {
    settled: true, quietMs, elapsedMs: res.elapsedMs, polls: res.polls, activity, pendingImages: r.pendingImages, skippedImages: r.skippedImages,
    ...(r.resourcesWatched ? {} : { resourcesWatched: false }), ...(r.observing ? {} : { domWatched: false }),
  };
}

// A whole number of milliseconds in range, from a flag's raw text; `dflt` when the flag is absent.
function wholeMs(label, flag, raw, lo, hi, dflt, tail = '') {
  if (raw === undefined) return dflt;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < lo || Number(raw) > hi) throw new Error(`${label}: --${flag} must be a whole number of milliseconds from ${lo} to ${hi}${tail}`);
  return Number(raw);
}

// wait [css] [--text T [--contains]] [--nth N] [--shadow] [--visible|--gone] [--timeout ms], or
// wait --settled [--quiet ms] [--timeout ms]. Nothing is sent before it all checks out.
// { mode: present|visible|gone|settled, sel, timeoutMs, quietMs }.
export function parseWaitArgs(argv) {
  const bad = msg => new Error(`wait: ${msg}; ${SELECTOR_USAGE.wait}`);
  for (let i = 0; i < argv.length && argv[i] !== '--'; i++) {
    if (argv[i] === '--label') throw bad('--label is not supported: wait looks in the page, not at the native tree');
    if (['--text', '--nth', '--timeout', '--quiet'].includes(argv[i])) i++; // the value is not a flag
  }
  const { sel, opts } = parseSelectorArgs(argv, { name: 'wait', bools: ['visible', 'gone', 'settled'], values: ['timeout', 'quiet'], optional: true });
  if (opts.visible && opts.gone) throw bad('--visible and --gone exclude each other');
  if (opts.settled) {
    if (sel !== undefined || opts.visible || opts.gone) throw bad('--settled stands alone: no css, --text, --visible or --gone');
  } else {
    if (sel === undefined) throw bad('needs a css selector, --text or --settled');
    if (opts.quiet !== undefined) throw bad('--quiet goes with --settled');
  }
  const { timeoutDefault, timeoutMin, timeoutMax, quietDefault, quietMin, quietMax } = WAIT_LIMITS;
  const timeoutMs = wholeMs('wait', 'timeout', opts.timeout, timeoutMin, timeoutMax, timeoutDefault, `; ${SELECTOR_USAGE.wait}`);
  const quietMs = wholeMs('wait', 'quiet', opts.quiet, quietMin, quietMax, quietDefault, `; ${SELECTOR_USAGE.wait}`);
  if (opts.settled && quietMs >= timeoutMs) throw bad(`--quiet (${quietMs} ms) must be less than --timeout (${timeoutMs} ms)`);
  return { mode: opts.settled ? 'settled' : opts.gone ? 'gone' : opts.visible ? 'visible' : 'present', sel, timeoutMs, quietMs };
}

// --- shot ---
// `shot` alone is the whole screen, as the driver gave it. With --page, --element or a size
// (--scale, --width) the picture is cut and shrunk in memory (lib/png.js) and only the result is
// written: a crop that cannot be made saves nothing, never the full screen.

// shot [name] [--page | --element <css> [--text T [--contains]] [--nth N] [--shadow]] [--scale N | --width px] [--]:
// `--element` can repeat (with --shadow every one is a selector and the last is the target) and
// stands for the selector's css, so the one word left over is the name; --text, --contains, --nth
// and --shadow go to parseSelectorArgs. Nothing is sent before it all checks out. Gives { mode:
// plain|screen|page|element, name, sel, scale, width }. As in parseSelectorArgs, a word that is not
// shaped like a flag name is never echoed.
export function parseShotArgs(argv) {
  const bad = msg => new Error(`shot: ${msg}; ${SELECTOR_USAGE.shot}`);
  const forward = [], css = [], pos = [], f = {};
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], k = a.slice(2);
    if (literal || !a.startsWith('--')) pos.push(a);
    else if (a === '--') literal = true;
    else if (a === '--page' || a === '--contains' || a === '--shadow') {
      if (a === '--page') f.page = true;
      else forward.push(a);
    } else if (['element', 'scale', 'width', 'text', 'nth'].includes(k)) {
      if (i + 1 >= argv.length) throw bad(`--${k} needs a value`);
      const v = argv[++i];
      if (k === 'element') css.push(v);
      else if (k === 'text' || k === 'nth') forward.push(a, v);
      else if (k in f) throw bad(`--${k} was given twice`);
      else f[k] = v;
    } else throw bad(`${/^--[A-Za-z][A-Za-z0-9-]{0,30}$/.test(a) ? `unknown flag ${a}` : `argument #${i + 1} is not a flag shot knows`} (a name that starts with -- goes after a bare --)`);
  }
  if (pos.length > 1) throw bad('one name only');
  if (f.page && css.length) throw bad('--page and --element exclude each other');
  if (f.scale !== undefined && f.width !== undefined) throw bad('--scale and --width exclude each other');
  if (forward.length && !css.length) throw bad('--text, --contains, --nth and --shadow go with --element (use --element \'*\' --text <text> to find by text alone)');
  let scale, width;
  if (f.scale !== undefined) {
    scale = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(f.scale) ? Number(f.scale) : NaN;
    if (!(scale > 0 && scale <= 1)) throw bad('--scale must be a number above 0 and at most 1 (0.5 is half the size)');
  }
  if (f.width !== undefined) {
    width = /^[0-9]{1,5}$/.test(f.width) ? Number(f.width) : NaN;
    if (!(width >= 1 && width <= PNG_LIMITS.side)) throw bad(`--width must be a whole number of pixels from 1 to ${PNG_LIMITS.side}`);
  }
  const sel = css.length ? parseSelectorArgs([...forward, '--', ...css], { name: 'shot' }).sel : undefined;
  const mode = f.page ? 'page' : css.length ? 'element' : scale !== undefined || width !== undefined ? 'screen' : 'plain';
  return { mode, name: pos[0], sel, scale, width };
}

// In the page: the top safe-area inset in CSS px (what the status bar and the notch take, 0 where
// the page is already laid out below them), read from a throwaway element that is always removed.
const INSET_SCRIPT = `const d = document.createElement('div');
d.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top)';
document.documentElement.appendChild(d);
try { const v = parseFloat(window.getComputedStyle(d).paddingTop); return Number.isFinite(v) ? v : 0; } finally { d.remove(); }`;

// Two rectangles share more than an edge.
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const SLACK = 0.5; // points: toScreen and the area are each rounded to a tenth

// The part of the screen to keep, in points, read from withPage's answer, with the numbers that
// led to it. `--element`: the element's own rectangle, which must be rendered, wholly inside the
// page area and clear of Safari's controls (the lab scrolls nothing). `--page`: the page area
// less the top safe-area inset (the status bar, when the page is drawn under it) and less every
// Safari control that overlaps it (a bar in the lower half cuts from there down, one in the
// upper half cuts up to its bottom edge). No height is assumed: they come from the native tree.
async function shotRegion(mode, ctx, what) {
  const { area, chrome, screen, toScreen, calibration, geo } = ctx;
  guardPoints([], area, chrome, 'the crop'); // too many controls, or one without a rectangle: refused rather than guessed
  const bars = chrome.map(({ x, y, width, height }) => ({ x, y, width, height }));
  if (mode === 'element') {
    if (!geoOk(geo)) throw new Error(`couldn't measure ${what} in the page`);
    if (geo.hidden) throw new Error(`${what} is ${hiddenReason(geo.hidden) ?? 'hidden'}, so there is nothing to show`);
    const a = toScreen(geo.rect.x, geo.rect.y), b = toScreen(geo.rect.x + geo.rect.width, geo.rect.y + geo.rect.height);
    const rect = { x: a.x, y: a.y, width: round1(b.x - a.x), height: round1(b.y - a.y) };
    if (rect.x < area.x - SLACK || rect.y < area.y - SLACK || rect.x + rect.width > area.x + area.width + SLACK || rect.y + rect.height > area.y + area.height + SLACK) {
      throw new Error(`${what} is not wholly inside the page area ${JSON.stringify(area)} (it is at ${JSON.stringify(rect)}); scroll it fully into view first`);
    }
    const under = bars.find(bar => overlaps(rect, bar));
    if (under) throw new Error(`${what} runs under Safari's toolbar or address bar ${JSON.stringify(under)}; scroll it clear first`);
    const covered = typeof geo.covered === 'string' ? (/^[a-z][a-z0-9-]{0,30}$/.test(geo.covered) ? `<${geo.covered}>` : 'something else') : null;
    return { rect, area, screen, ...(covered ? { warning: `${what} is covered by ${covered}; the picture shows that over it` } : {}) };
  }
  const raw = await pageCmd('POST', '/execute/sync', { script: INSET_SCRIPT, args: [] });
  if (!Number.isFinite(raw) || raw < 0 || raw > 2000) throw new Error('couldn\'t measure the page\'s top safe-area inset');
  const inset = round1(raw * calibration.scaleY);
  let [left, top, right, bottom] = [Math.max(0, area.x), Math.max(0, area.y) + inset, Math.min(screen.width, area.x + area.width), Math.min(screen.height, area.y + area.height)];
  for (const bar of bars) {
    if (!overlaps({ x: left, y: top, width: right - left, height: bottom - top }, bar)) continue;
    if (bar.y + bar.height / 2 >= (top + bottom) / 2) bottom = Math.min(bottom, bar.y);
    else top = Math.max(top, bar.y + bar.height);
  }
  const rect = { x: round1(left), y: round1(top), width: round1(right - left), height: round1(bottom - top) };
  if (rect.width < 1 || rect.height < 1) throw new Error(`nothing of the page is left after the status bar and Safari's controls are taken off (page area ${JSON.stringify(area)}, top inset ${inset}, controls ${JSON.stringify(bars)})`);
  return { rect, area, screen, inset };
}

// The cut and shrunk screenshot behind `shot --page`, `--element` and a size on its own. The
// geometry is read in the page, the picture taken while that read stands, and the geometry read
// again: the picture is cut only if both reads agree (else tried again, up to WAIT.stableTries).
// The phone's tab must be showing right before the picture and right before the file is written.
async function cutShot(opt, name) {
  const device = session().device;
  const what = opt.sel === undefined ? 'the page' : describeSel(opt.sel);
  const take = async () => {
    const b64 = device ? await cmd('GET', '/screenshot') : await pageCmd('GET', '/screenshot');
    if (typeof b64 !== 'string') throw new Error('Appium returned no screenshot');
    return Buffer.from(b64, 'base64');
  };
  await onScreen();
  let png, region = null, found = null;
  if (opt.mode === 'screen') {
    png = await take();
  } else {
    if (opt.mode === 'element') found = await find(opt.sel);
    const measure = found ? { el: elOf(1), arg: found.sel } : null;
    for (let attempt = 0; attempt < WAIT.stableTries && !region; attempt++) {
      const first = await withPage(async ctx => {
        const r = await shotRegion(opt.mode, ctx, what);
        await onScreen(); // the tab may have left the screen since the first check
        return { ...r, png: await take() };
      }, measure);
      const again = await withPage(ctx => shotRegion(opt.mode, ctx, what), measure);
      if (sameRect(first, again) && sameRect({ rect: first.screen }, { rect: again.screen })) region = first;
    }
    if (!region) throw new Error(`${what} kept moving or resizing (scrolling, zooming or Safari's controls changing) while the picture was taken, so nothing was written; wait for the page to settle, then try again`);
    png = region.png;
  }
  const img = decodePng(png);
  let crop = { x: 0, y: 0, width: img.width, height: img.height };
  if (region) {
    const { rect, screen } = region;
    const [rx, ry] = [img.width / screen.width, img.height / screen.height];
    if (Math.abs(rx / ry - 1) > 0.01) throw new Error(`the screenshot (${img.width}x${img.height} px) is not the shape of the ${screen.width}x${screen.height} pt screen, so it can't be cut by the screen's coordinates`);
    const [x0, y0] = [Math.max(0, Math.floor(rect.x * rx + 1e-6)), Math.max(0, Math.floor(rect.y * ry + 1e-6))];
    const [x1, y1] = [Math.min(img.width, Math.ceil((rect.x + rect.width) * rx - 1e-6)), Math.min(img.height, Math.ceil((rect.y + rect.height) * ry - 1e-6))];
    crop = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  let outWidth = crop.width;
  if (opt.scale !== undefined) outWidth = Math.max(1, Math.round(crop.width * opt.scale));
  else if (opt.width !== undefined) {
    if (opt.width > crop.width) throw new Error(`--width ${opt.width} is wider than the ${crop.width} px picture; only shrinking is supported`);
    outWidth = opt.width;
  }
  const cut = region ? cropPng(img, crop) : img;
  const out = outWidth < cut.width ? scalePng(cut, outWidth) : cut;
  const bytes = encodePng(out);
  await onScreen(); // the file is written only if the lab's tab was showing throughout
  const file = artifact(name, 'png');
  fs.writeFileSync(file, bytes);
  return {
    file, width: out.width, height: out.height,
    source: { width: img.width, height: img.height }, crop, scale: Math.round(out.width / crop.width * 1e4) / 1e4, mode: opt.mode,
    ...(found ? { matches: found.count } : {}),
    ...(region ? { points: { screen: { width: region.screen.width, height: region.screen.height }, area: region.area, ...(region.inset === undefined ? {} : { inset: region.inset }), crop: region.rect } } : {}),
    ...(region?.warning ? { warning: region.warning } : {}),
  };
}

const INJECT_USAGE = 'safari inject <file.user.js>  or  safari inject --forget <file.user.js>  or  safari inject --clear';

// The one reader of inject's words: a file, or `--forget <file>`, or `--clear`. Gives
// { mode: 'run'|'forget'|'clear', file }. Checked before the session is asked anything.
export function parseInjectArgs(argv) {
  const refuse = msg => Object.assign(new Error(`inject: ${msg}; usage: ${INJECT_USAGE}`), { skipArtifacts: true });
  const files = argv.filter(a => !a.startsWith('--'));
  const bad = argv.find(a => a.startsWith('--') && a !== '--forget' && a !== '--clear');
  if (bad !== undefined) throw refuse(`argument #${argv.indexOf(bad) + 1} is not a flag inject knows (a file whose name starts with -- is given as ./--name)`);
  const forget = argv.includes('--forget'), clear = argv.includes('--clear');
  if (forget && clear) throw refuse('--forget and --clear cannot be used together');
  if (clear) {
    if (files.length) throw refuse('--clear takes no file');
    return { mode: 'clear' };
  }
  if (forget) {
    if (files.length !== 1) throw refuse('--forget takes exactly one file');
    return { mode: 'forget', file: files[0] };
  }
  if (!files.length) throw new Error(`usage: ${INJECT_USAGE}`);
  return { mode: 'run', file: files[0] };
}

const LOAD_WAIT_USAGE = '[--reinject] [--wait-for <css>] [--settle] [--timeout <ms>]';
const OPEN_USAGE = `${LOAD_WAIT_USAGE} [--storage <key=value>]...`;

// --- open --storage ---
// localStorage pairs set on the page's own origin before the requested page loads. The values are
// secrets (a login flag, a token): they travel only as the first argument of a page script, never
// in a script's source, the output, run.log, a run-folder file, an error or the log of a failed
// command. Errors name the pair's place and the rule, never a key or a value.

export const STORAGE_LIMITS = { keyMax: 256, valueMax: 4096, pairs: 20, totalBytes: 16 * 1024 };

// Any spelling of the --storage flag: dashes of any kind, any case, with or without `=`.
const storageLike = w => /^[-\u2010-\u2015\u2212]+storage(=|$)/i.test(w);

// The one reader of open's and refresh's words: `--reinject`, `--settle`, `--wait-for <css>`,
// `--timeout <ms>` and (open) `--storage <key=value>`, which can repeat, and the URL (open). Gives
// { url, flags, pairs: [[key, value]...] }. Any word it does not take is refused by its place
// (#N, counting from the first word after the command), never by the word itself: a --storage given
// in a form this does not know would otherwise be printed, logged or silently dropped. Every error
// skips the failure artifacts. The pairs are all checked here, before the session is asked anything.
export function parseOpenArgs(argv, name = 'open') {
  const usage = name === 'open' ? `safari open <http(s) URL> ${OPEN_USAGE}` : `safari refresh ${LOAD_WAIT_USAGE}`;
  const refuse = msg => Object.assign(new Error(`${name}: ${msg}; usage: ${usage}`), { skipArtifacts: true });
  if (name === 'refresh' && argv.some(storageLike)) throw Object.assign(new Error('refresh: --storage is for open only'), { skipArtifacts: true });
  const flags = {}, pairs = [];
  const { keyMax, valueMax, pairs: maxPairs, totalBytes } = STORAGE_LIMITS;
  const bad = msg => Object.assign(new Error(`${name}: --storage ${msg}`), { skipArtifacts: true });
  const seen = new Map();
  let url, bytes = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], at = i + 1;
    if (a.toLowerCase().startsWith('--storage=')) throw refuse('--storage takes its pair as the next word (--storage key=value), not after =');
    if (a.startsWith('--') && a.includes('=')) throw refuse(`argument #${at}: give a flag's value as the next word, not after =`);
    if (a === '--reinject' || a === '--settle') flags[a.slice(2)] = true;
    else if (a === '--wait-for' || a === '--timeout') {
      if (a.slice(2) in flags) throw refuse(`${a} was given twice`);
      if (i + 1 >= argv.length || storageLike(argv[i + 1])) throw refuse(`${a} needs a value`);
      if (a === '--wait-for' && argv[i + 1].startsWith('--')) throw refuse('--wait-for needs a css selector'); // a flag, not a selector: the word after it is not its value
      flags[a.slice(2)] = argv[++i];
    } else if (a === '--storage' && name === 'open') {
      const n = pairs.length + 1;
      if (i + 1 >= argv.length) throw bad(`#${n} needs key=value`);
      const kv = argv[++i];
      const eq = kv.indexOf('=');
      if (eq < 0) throw bad(`#${n} needs key=value`);
      const key = kv.slice(0, eq), value = kv.slice(eq + 1);
      if (key.length < 1 || key.length > keyMax || /[\u0000-\u001f\u007f]/.test(key)) throw bad(`#${n}: the key must be 1 to ${keyMax} characters with no control characters`);
      if (value.length > valueMax) throw bad(`#${n}: the value must be at most ${valueMax} characters`);
      if (seen.has(key)) throw bad(`#${n} repeats the key of #${seen.get(key)}`);
      if (n > maxPairs) throw bad(`takes at most ${maxPairs} pairs`);
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
      if (bytes > totalBytes) throw bad(`pairs add up to more than ${totalBytes / 1024} KiB`);
      seen.set(key, n);
      pairs.push([key, value]);
    } else if (a.startsWith('--')) throw refuse(`argument #${at} is not a flag ${name} knows`);
    else if (name === 'open' && url === undefined) url = a;
    else throw refuse(`argument #${at} is extra (${name === 'open' ? 'open takes one URL' : 'refresh takes no URL'})`);
  }
  return { url, flags, pairs };
}

// Runs in the page with the pairs as arguments[0] and the origin they are for as arguments[1].
// Gives -1 when the page is not on that origin, the number written, or { failed, name }: the
// index that failed and the error's name. Never the page's message, which could carry the pair.
// The name is the page's to choose, so it is not cut or judged here (the page can patch what
// would do it): the lab maps it to one it knows.
export const STORAGE_WRITE = `const pairs = arguments[0];
if (location.origin !== arguments[1]) return -1;
let i = 0;
try {
  for (; i < pairs.length; i++) localStorage.setItem(pairs[i][0], pairs[i][1]);
} catch (e) {
  let name; try { name = String(e && e.name || 'Error'); } catch (_) { name = 'Error'; }
  return { failed: i, name };
}
return pairs.length;`;

// The error names the lab reports for a refused write. Whatever else the page calls its error is `Error`.
const STORAGE_ERROR_NAMES = new Set(['QuotaExceededError', 'SecurityError', 'InvalidStateError', 'TypeError']);

// Writes the pairs into the page's localStorage; throws, naming the pair and the error's name
// (one of STORAGE_ERROR_NAMES: the page chose it) and never a key or a value. Whatever else goes
// wrong with the page command (a script the page made throw, an answer from Appium) is a fixed
// message: both carry text from the page or the server. A refusal of the tab guard passes untouched.
async function writeStorage(pairs, origin) {
  let r;
  try {
    r = session().device
      ? await guarded(STORAGE_WRITE, [pairs, origin], { limitMs: WAIT.timeoutMs, label: 'storage' }) // right after a load (issue 104)
      : await pageCmd('POST', '/execute/sync', { script: STORAGE_WRITE, args: [pairs, origin] }, WAIT.callMs);
  } catch (e) {
    if (isTabError(e)) throw e;
    throw Object.assign(new Error('open: the page command that writes --storage failed; pairs before it may have been written'), { skipArtifacts: true, extra: e.extra });
  }
  if (r === pairs.length) return;
  if (r === -1) throw new Error(`open: the page was not on ${origin} when the storage was to be written, so none of it was`);
  if (r && typeof r === 'object' && Number.isInteger(r.failed) && r.failed >= 0 && r.failed < pairs.length) {
    const name = typeof r.name === 'string' && STORAGE_ERROR_NAMES.has(r.name) ? r.name : 'Error';
    throw new Error(`open: the page refused --storage #${r.failed + 1} (${name}); the pairs before it were written`);
  }
  throw new Error('open: the page gave an answer the lab does not understand when the storage was written');
}

const originOfUrl = u => { try { return new URL(u).origin; } catch { return null; } };

// open and refresh: --wait-for <css> (the element exists) and --settle (as wait --settled),
// each with its own --timeout, run after the page has loaded. Checked before navigating.
function parseLoadWaits(name, flags) {
  const bad = msg => new Error(`${name}: ${msg}`);
  if (flags['wait-for'] !== undefined && (!flags['wait-for'].trim() || flags['wait-for'].startsWith('--'))) throw bad('--wait-for needs a css selector');
  if (flags.timeout !== undefined && flags['wait-for'] === undefined && !flags.settle) throw bad('--timeout goes with --wait-for or --settle');
  const timeoutMs = wholeMs(name, 'timeout', flags.timeout, WAIT_LIMITS.timeoutMin, WAIT_LIMITS.timeoutMax, WAIT_LIMITS.timeoutDefault);
  if (flags.settle && WAIT_LIMITS.quietDefault >= timeoutMs) throw bad(`--timeout must be more than the ${WAIT_LIMITS.quietDefault} ms the page has to stay quiet`);
  return { waitFor: flags['wait-for'], settle: !!flags.settle, timeoutMs };
}

// What open and refresh report: where the tab is, once the waits asked for have passed. A wait
// that fails still says the page loaded (`navigated`) and where; a refusal of the tab guard passes untouched.
async function loadResult(c, raw, out, waits) {
  const here = redactUrl(raw);
  const where = { url: here, ...(c.device ? { finalUrl: here } : {}) };
  const pollMs = c.device ? WAIT.waitPollDeviceMs : WAIT.waitPollMs;
  const waited = {};
  try {
    if (waits.waitFor !== undefined) waited.waitFor = await waitForSelector(waits.waitFor, 'present', waits.timeoutMs, pollMs);
    if (waits.settle) waited.settle = await waitSettled(WAIT_LIMITS.quietDefault, waits.timeoutMs, pollMs);
  } catch (e) {
    if (isTabError(e)) throw e;
    let title;
    try { title = await pageCmd('GET', '/title'); } catch { /* the wait's own error is the news */ }
    e.extra = { ...e.extra, navigated: true, ...where, ...(title === undefined ? {} : { title }), ...out, ...waited };
    throw e;
  }
  return { ...where, title: await pageCmd('GET', '/title'), ...out, ...waited };
}

// The address right after a load: on the phone the page may still be busy, so the read gets the navigation's 30 s (issue 104).
const loadedUrl = () => (session().device ? guarded('return location.href', [], { limitMs: WAIT.timeoutMs, label: 'url' }) : pageCmd('GET', '/url'));

// A navigation may also end on the session's allowed hosts (a redirect there); the message still names the first origin.
const withAllowed = expected => [...new Set([...expected, ...allowOrigins(readTab().allowHosts)])];

// Loads `url` in the lab's page and waits for the new document: the phone's tab by a guarded
// location.replace and the marker put back, the simulator's by POST /url. `before` is docState()
// from just before. Gives { retried }: a context move was waited out once.
async function loadPage(c, url, before) {
  const target = sameDocument(before?.href, url) ? new URL(url).href : null; // no new document may come
  const nav = c.device ? { beforeOrigin: before?.origin ?? null, targetHref: target, expected: withAllowed(expectedOrigins(url)), tries: { retried: false }, listed: await listedPages() } : null;
  if (c.device) {
    // Never POST /url on the phone (it navigates whichever page is current): replace the lab's own page.
    // Where it was asked to go is recorded just before the script is sent, so a run that loses the tab can say which site to look for.
    await guarded('location.replace(arguments[0]); return true', [url], { navTo: new URL(url).origin, limitMs: WAIT.timeoutMs, label: 'navigate' });
    await devicePlant(nav, new URL(url).origin);
  } else await pageCmd('POST', '/url', { url }, 120e3);
  await waitForDocument(before?.origin ?? null, `opening ${redactUrl(url)}`, target);
  if (c.device) await guarded(DEVICE_HOOKS, [], { limitMs: WAIT.timeoutMs, label: 'collectors' });
  return { retried: !!nav?.tries.retried };
}

// Reloads the lab's page and waits for the new document (the phone's tab by a guarded
// location.reload and the marker put back). Gives { retried }, as loadPage does.
async function reloadPage(c) {
  const before = await docState(WAIT.timeoutMs);
  const nav = c.device ? { beforeOrigin: before?.origin ?? null, targetHref: null, expected: withAllowed([readTab().origin]), tries: { retried: false }, listed: await listedPages() } : null;
  if (c.device) {
    await guarded('location.reload(); return true', [], { limitMs: WAIT.timeoutMs, label: 'reload' });
    await devicePlant(nav, null);
  } else await pageCmd('POST', '/refresh', {}, 120e3);
  await waitForDocument(before?.origin ?? null, 'refreshing');
  if (c.device) await guarded(DEVICE_HOOKS, [], { limitMs: WAIT.timeoutMs, label: 'collectors' });
  return { retried: !!nav?.tries.retried };
}

// `safari <kind> <word>|restore|status` for one kind of phone setting (the table is SETTINGS in phone-restore.js).
function displayCommand(kind) {
  const s = SETTINGS[kind];
  const usage = `usage: safari ${kind} ${settingUsage(kind)}|restore|status`;
  const noun = s.noun[0].toUpperCase() + s.noun.slice(1);
  return async argv => {
    const [word, ...extra] = argv;
    if (![...settingWords(kind), 'restore', 'status'].includes(word) || extra.length) throw new Error(usage);
    const phone = displayPhone(kind);
    if (word === 'status') return { target: 'device', ...settingStatus(kind, phone) };
    if (word === 'restore') return restoreOutput(await restorePending({ only: kind }), noun, kind);
    const r = await changeSetting(kind, phone, s.words[word]);
    logRun(`safari ${kind} ${word}`);
    return { target: 'device', [kind]: r[kind], ...(s.requested ? { requested: word } : {}), prior: r.prior, changed: r.changed, restoredAtStop: r.pending, ...(s.note ? { note: s.note } : {}) };
  };
}

// The saved phone behind the open session, for `appearance` and `orientation`: the session must be on the iPhone.
function displayPhone(name) {
  const c = session();
  if (!c.device) {
    throw new Error(`safari ${name} works on the iPhone only: this session is on the simulator, which is not supported here (\`sim appearance\` sets the simulator's appearance)`);
  }
  const phone = readPhone(loadState());
  if (!phone || phone.udid !== c.target.device) throw needsError('setup', 'the session\'s phone is not the saved phone; save it with `lab phone setup`');
  return phone;
}

// The output of `restore`: what was done, or `ok: false` with the steps for a person when it could not be.
function restoreOutput(r, what, kind) {
  if (!r.pending) return { target: 'device', phoneRestored: true, pending: false, note: `${what} had not been changed by the lab: nothing to put back` };
  const out = { target: 'device', ...restoreReport(r) };
  return r.restored ? out : { ok: false, error: `${what} was not put back: ${r[kind]?.error ?? r.error}; the record is kept`, ...out };
}

const commands = {
  // start [--target auto|device|simulator] [--device <UDID>] [--port N]: opens a session on
  // the simulator or the saved iPhone through Appium (starting it if needed). `--device` is
  // `--target device` for the saved phone. A recorded session that no longer works is replaced
  // (`recovered`).
  async start(argv) {
    const { flags } = parseArgs(argv, [], ['allow-host']);
    // Only these: the simulator profile is `lab up`'s (it shuts the other simulator down first; this would not).
    if (flags.profile !== undefined) throw new Error('safari start takes no --profile: use `lab up --profile clean|configured` (or `sim boot --profile ...` first); the profile of a session is chosen when the simulator boots');
    const unknown = Object.keys(flags).find(k => !['target', 'device', 'port', 'allow-host'].includes(k));
    if (unknown !== undefined) throw new Error(`usage: safari start [--target auto|device|simulator] [--device <UDID>] [--port N] [--allow-host <host>]... (${/^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(unknown) ? `--${unknown}` : 'a flag'} is not a start flag)`);
    const { 'allow-host': hosts, ...rest } = flags;
    const r = await startSession({ ...rest, allowHosts: parseAllowHosts(hosts) });
    const out = { session: r.session, backend: r.backend, ...(r.reused ? { reused: true } : {}), target: r.target, targetType: targetType(r.target) };
    return { ...out, ...(r.recovered ? { recovered: true } : {}), ...(r.previousTab ? { previousTab: r.previousTab } : {}), ...(r.keyboardRestored !== undefined ? { keyboardRestored: r.keyboardRestored } : {}), ...(r.keyboardNote ? { keyboardNote: r.keyboardNote } : {}), ...(r.keyboardDeferred ? { keyboardDeferred: r.keyboardDeferred } : {}), ...(r.allowHosts ? { allowHosts: r.allowHosts } : {}), ...(r.note ? { note: r.note } : {}), ...lockReport(r), ...(r.human ? { human: r.human } : {}) };
  },

  // open <url> [--reinject] [--wait-for <css>] [--settle] [--timeout <ms>] [--storage <key=value>]...:
  // loads the page and waits until the new document is complete, then (each with its own --timeout)
  // until the element exists and/or the page has settled (see wait). --storage first sets the
  // localStorage pairs on the URL's origin: written into the page the tab is already on if that is
  // the same origin, else into the origin's root (`/`), loaded for it. Then the URL loads.
  async open(argv) {
    const { url, flags, pairs } = parseOpenArgs(argv, 'open');
    if (!/^https?:\/\//.test(url || '')) throw new Error(`usage: safari open <http(s) URL> ${OPEN_USAGE}`);
    const waits = parseLoadWaits('open', flags);
    const origin = originOfUrl(url);
    if (pairs.length && !origin) throw new Error(`usage: safari open <http(s) URL> ${OPEN_USAGE}`);
    const c = session();
    if (pairs.length) requireServiceForValues(c.port); // the Appium log must hold no values, so only the service receives them
    let before = await docState(WAIT.timeoutMs);
    const store = pairs.length ? { count: pairs.length, keys: pairs.map(([k]) => k), origin, extraLoad: originOfUrl(before?.href) !== origin } : null;
    // Without a new document the page would not load with the values: refused before anything changes.
    if (store && before?.href !== undefined && sameDocument(before.href, url) && new URL(before.href).href !== new URL(url).href) {
      throw new Error('open: with --storage the address must differ from the current page by more than its #fragment, or no new page loads; open it without --storage, or refresh');
    }
    const out = {};
    let retried = false, started = false;
    const go = async () => {
      if (store) {
        if (store.extraLoad) { // the origin's own page, so the values go to the right place
          retried = (await loadPage(c, `${origin}/`, before)).retried;
          const landed = originOfUrl(await loadedUrl());
          if (landed !== origin) throw new Error(`open: the root redirected to ${landed}; open the final address`);
          before = await docState(WAIT.timeoutMs);
        }
        out.storage = { count: store.count, keys: store.keys, origin, extraLoad: store.extraLoad };
        started = true; // from the first byte sent: the page may hold values from here on
        await writeStorage(pairs, origin);
      }
      if (store && sameDocument(before?.href, url)) {
        // The page the values went into is already the address (the root with a #fragment, or the same URL): no new
        // document would come from navigating, so set the fragment and then reload, and the page's scripts run after the write.
        if (new URL(before.href).href !== new URL(url).href) retried = (await loadPage(c, url, before)).retried || retried;
        retried = (await reloadPage(c)).retried || retried;
      } else retried = (await loadPage(c, url, before)).retried || retried;
      if (retried) out.markRetried = true;
      const raw = await loadedUrl(); // read once: the scripts are matched against it, the output shows it redacted
      if (store && originOfUrl(raw) !== origin) {
        out.storage.applied = false;
        out.warning = `the page ended on another origin than ${origin}, where --storage wrote; it will not see those values (see url)`;
      }
      if (flags.reinject) Object.assign(out, await reinjectFor(c.injected, raw, out.warning));
      logRun(`safari open ${url}${store ? ` storage=${store.count} keys=${store.keys.join(',')}` : ''}`);
      return loadResult(c, raw, out, waits);
    };
    if (!store) return go();
    try { return await go(); } catch (e) {
      if (started) { // the page may show the values, so a screenshot or its source is not kept
        e.skipArtifacts = true;
        e.extra = { ...e.extra, storage: out.storage };
        logRun(`safari open FAILED: ${e.message}`);
      }
      throw e;
    }
  },

  // refresh [--reinject] [--wait-for <css>] [--settle] [--timeout <ms>]: reloads and waits for the
  // new document, then as open does.
  async refresh(argv) {
    const { flags } = parseOpenArgs(argv, 'refresh');
    const waits = parseLoadWaits('refresh', flags);
    const c = session();
    const out = {};
    if ((await reloadPage(c)).retried) out.markRetried = true;
    const raw = await loadedUrl();
    if (flags.reinject) Object.assign(out, await reinjectFor(c.injected, raw, out.warning));
    logRun('safari refresh');
    return loadResult(c, raw, out, waits);
  },

  // eval '<js>' [--timeout <ms>]: the value of the agent's script. A Promise is awaited (see THENABLE)
  // for up to --timeout (10 s by default); one that rejects is an error with its reason, and one whose
  // page went away while waiting (a navigation, a reload) is an error that says so.
  async eval([js, ...rest]) {
    if (typeof js !== 'string') throw new Error(EVAL_USAGE);
    let raw;
    if (rest.length) {
      if (rest.length !== 2 || rest[0] !== '--timeout') throw new Error(EVAL_USAGE);
      raw = rest[1];
    }
    const timeoutMs = wholeMs('eval', 'timeout', raw, WAIT_LIMITS.timeoutMin, WAIT_LIMITS.timeoutMax, WAIT_LIMITS.timeoutDefault);
    const body = asScript(js);
    try { new Function(body); } catch (e) { throw new Error(`eval: syntax error: ${redactUrl(e.message)}`); } // never called; before any phone call
    const script = `const v = (function () {\n${body}\n}).apply(null, arguments);
if (v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function') {
  const slots = globalThis.${THENABLE} || (globalThis.${THENABLE} = {});
  const id = String(Math.random()).slice(2), s = slots[id] = { state: 'pending' };
  Promise.resolve(v).then(x => { s.state = 'ok'; s.value = x; }, e => { s.state = 'err'; let t; try { t = e instanceof Error ? e.message : typeof e === 'object' && e !== null ? JSON.stringify(e) : String(e); } catch { t = String(e); } s.reason = String(t).slice(0, 500); });
  return { ${THENABLE}: id };
}
return v;`;
    const value = await pageCmd('POST', '/execute/sync', { script, args: [] });
    const id = value !== null && typeof value === 'object' ? value[THENABLE] : undefined;
    if (typeof id !== 'string') return { value };
    let res;
    try {
      res = await pollUntil(() => pageCmd('POST', '/execute/sync', { script: AWAIT_READ, args: [id] }, WAIT.callMs), r => !r?.pending, { timeoutMs, pollMs: WAIT.evalPollMs });
    } catch (e) {
      passCut(e);
      if (isTabError(e)) throw e;
      throw new Error(`eval couldn't read what the Promise settled with (a value WebDriver can't return, such as a cyclic object?): ${redactUrl(e.message)}`);
    }
    const r = res.last;
    if (!res.done) {
      try { await pageCmd('POST', '/execute/sync', { script: AWAIT_READ, args: [id, true] }, WAIT.callMs); } catch (e) { passCut(e); if (isTabError(e)) throw e; } // best effort: the slot goes with the page anyway
      throw timedOut('the Promise to settle', timeoutMs, 'still pending');
    }
    if (r?.gone) throw new Error('the page changed while eval waited for the Promise (a navigation or reload), so its value is lost');
    if (r?.rejected !== undefined) throw new Error(`the Promise rejected: ${redactUrl(String(r.rejected))}`);
    return { value: r?.value ?? null, awaited: true, awaitedMs: res.elapsedMs };
  },

  // Runs a userscript in the page now (after load, not at document-start), with a GM_info
  // stand-in, and remembers it for `--reinject`. Returns what the page threw, if anything.
  // `--forget <file>` drops one recorded file and `--clear` all of them; neither touches the page.
  async inject(argv) {
    const { mode, file } = parseInjectArgs(argv);
    if (mode !== 'run') return forgetInjected(mode, file);
    const abs = path.resolve(file);
    const { meta, err, mark } = await runUserscript(file);
    logRun(`safari inject ${file}${err ? ' threw: ' + err : ''}`);
    if (err) throw new Error(`the script threw: ${redactUrl(String(err))}`);
    const injected = session().injected;
    if (!injected.includes(abs)) saveState({ injected: [...injected, abs] });
    const out = { injected: file, ...meta, note: 'lost on navigation or refresh; use open/refresh --reinject', ...(await offPage(file)) };
    if (!(await stillThere(mark))) {
      const gone = 'the page showing now is not the document the script ran in (a navigation happened during or after it, maybe one the script made); if the script does not navigate, run inject again';
      Object.assign(out, { pageChanged: true, warning: out.warning ? `${out.warning}; ${gone}` : gone });
    }
    return out;
  },

  // click [css] [--text T [--contains]] [--nth N] [--shadow] [--]: a script click on the element.
  // A selector that is more than plain CSS also reports its description and `matches`.
  async click(argv) {
    const { sel } = parseSelectorArgs(argv, { name: 'click' });
    const found = await find(sel);
    if (typeof sel === 'string') {
      await pageCmd('POST', `/element/${found.ref}/click`, {});
      return { clicked: sel, matches: found.count };
    }
    if (session().device) await guarded(CLICK_SCRIPT, [found.sel]);
    else await pageCmd('POST', `/element/${await elementRef(found.sel)}/click`, {});
    return { clicked: describeSel(sel), matches: found.count };
  },

  // Synthetic key events (isTrusted false); `keys` types like a finger on the keyboard. The
  // same selectors as `click`; the last argument is the text. On the simulator the keystrokes go
  // through WebDriver's element route for a plain selector and a resolved one alike.
  async type(argv) {
    requireCurrentRules(); // the text goes through Appium: its log must be clean
    const { sel, typed } = parseSelectorArgs(argv, { name: 'type', textLast: true });
    const found = await find(sel);
    if (typeof sel === 'string') {
      await sendingText('type', () => pageCmd('POST', `/element/${found.ref}/value`, { text: typed }));
      return { typed: typed.length, into: sel };
    }
    if (session().device) await sendingText('type', () => guarded(TYPE_SCRIPT, [found.sel, typed]));
    else {
      const ref = await elementRef(found.sel);
      await sendingText('type', () => pageCmd('POST', `/element/${ref}/value`, { text: typed }));
    }
    return { typed: typed.length, into: describeSel(sel), matches: found.count };
  },

  // tap [css] [--text T [--contains]] [--nth N] [--shadow] [--]: a real touch on the element
  // (isTrusted true), found in the page and tapped in the native layer. Refuses an element
  // something else covers, one that keeps moving and any point on Safari's UI. On a text field it
  // says whether the field took the focus (`focused`). An invisible target (opacity 0, hidden,
  // display none, under 2 px) is still tapped, with a `warning`.
  // tap --label "<text>": for what the page cannot name (a closed shadow root, a canvas): taps the
  // one native element in the web view with exactly that accessibility label (see tapLabel).
  async tap(argv) {
    const { sel, label } = parseSelectorArgs(argv, { name: 'tap', label: true });
    if (label !== undefined) return tapLabel(label);
    await onScreen();
    const found = await find(sel);
    // The element is found again inside each page script from its selector (on the phone the
    // remote debugger refuses element ids it did not hand out; the simulator resolves it alike).
    const el = found.sel;
    const what = describeSel(sel);
    const page = (script, args = [el]) => pageCmd('POST', '/execute/sync', { script, args });
    const measure = async () => {
      const g = await page(`${RESOLVE}\nconst el = ${elOf(0)};\n${MEASURE}`);
      if (!geoOk(g)) throw new Error(`couldn't measure ${what} in the page`);
      return g;
    };
    // The page can scroll or reflow while the native tree is read (about a second on the phone),
    // and a tap then lands on the wrong spot. So the element is read three times: before the
    // probe, in the very script that places the probe (so the rectangle and the probe's origin
    // are one instant), and right before the touch; a tap goes out only when all three agree.
    for (let attempt = 0; attempt < WAIT.stableTries; attempt++) {
      await page(scrollScript);
      const first = await measure();
      if (first.covered) throw new Error(`${what} is covered by <${first.covered}>; a tap would hit that instead`);
      await sleep(WAIT.stableMs);
      const done = await withPage(async ({ toScreen, area, calibration, chrome, geo }) => {
        if (!geoOk(geo)) throw new Error(`couldn't measure ${what} in the page`);
        if (!sameRect(first, geo)) return null;
        const { x, y } = toScreen(geo.cx, geo.cy);
        guardPoints([{ x, y }], area, chrome, 'the tap point');
        const last = await measure();
        if (!sameRect(geo, last)) return null;
        if (last.covered) throw new Error(`${what} is covered by <${last.covered}>; a tap would hit that instead`);
        await onScreen(); // the tab may have left the screen since the first check
        await cmd('POST', '/execute/sync', { script: 'mobile: tap', args: [{ x, y }] });
        await sleep(WAIT.tapSettleMs); // the page may scroll, zoom or shift for the keyboard
        return { x, y, area, calibration, hidden: hiddenReason(last.hidden) };
      }, { el: elOf(1), arg: el });
      if (!done) continue;
      const focused = await page(focusScript);
      return { tapped: what, ...(typeof sel === 'string' ? {} : { matches: found.count }), x: done.x, y: done.y, ...(typeof focused === 'boolean' ? { focused } : {}), page: done.area, calibration: done.calibration, ...(done.hidden ? { warning: `${what} is ${done.hidden}; the tap probably focused nothing` } : {}) };
    }
    throw new Error(`${what} kept moving (the page was scrolling or reflowing), so no tap was sent; wait for the page to settle, then try again`);
  },

  // wait [css] [--text T [--contains]] [--nth N] [--shadow] [--visible|--gone] [--timeout ms]: until
  // the element exists, is rendered (--visible) or none is (--gone: removed or hidden). Or
  // wait --settled [--quiet ms] [--timeout ms]: until nothing has loaded, changed or resized for
  // --quiet. Bounded (--timeout, 10 s by default, 60 s at most); a timeout is an error with the
  // counts. Reads the page only: it does not look at the screen.
  async wait(argv) {
    const w = parseWaitArgs(argv);
    const pollMs = session().device ? WAIT.waitPollDeviceMs : WAIT.waitPollMs;
    return w.mode === 'settled' ? waitSettled(w.quietMs, w.timeoutMs, pollMs) : waitForSelector(w.sel, w.mode, w.timeoutMs, pollMs);
  },

  // keys [--no-verify] [--] <text>: trusted key events into the focused page field (`\b` =
  // Backspace, by tapping the delete key: see makeKeySender). Never into the address bar.
  // Each character is checked to have landed (the field's length or text changed, or it got a
  // keydown, beforeinput or input event) and sent again if not, up to WAIT.keyRetries times, then
  // the command fails. Events count only while the field has never changed: a field that resets
  // itself after each key is counted in `byEvent` and `unverified` (sent once), but once a field
  // has been seen to change, a press that fires events and adds nothing is sent again.
  // `--no-verify` sends each once and checks nothing. Not checked, sent once: `\n` (Return may
  // submit or navigate), a character in a field at its maxlength, Backspace in an empty one or at
  // its start, and anything once focus has left the field the command started in. Over a selection
  // the first character replaces it (the length may fall or stay), so it is sent once and any
  // change of length or caret counts. When every character was plain and one landed only by event,
  // a field that ends up shorter than what was sent fails (lengths only, so password fields are
  // covered); a longer one is a `warning`. A verified run on either target also compares the
  // field's text with what was typed: a difference in case only (auto-capitalisation) is reported
  // as `caseChanged`, any other difference fails. Every run says `textChecked`, and when false
  // `textSkip` (password, contenteditable, caret, newline, backspace, unverified, unreadable,
  // no-verify), so a skipped check never looks like a passed one.
  async keys(argv) {
    requireCurrentRules(); // the text goes through Appium: its log must be clean
    const { text, verify } = parseKeysArgs(argv);
    if (typeof text !== 'string' || !text) throw new Error(KEYS_USAGE);
    if (text.length > 500) throw new Error('keys takes at most 500 characters');
    // Everything runs in the web context, switching nowhere: each native-to-web switch adds
    // a console and network listener to Appium for good. `mobile:` calls go straight to
    // WebDriverAgent whatever the context, so they need no switch; pageCmd finds the page
    // first (and again if its context id changes).
    await onScreen();
    if (!(await pageCmd('POST', '/execute/sync', { script: FOCUSED, args: [] }))) {
      throw new Error('no page field is focused: run `safari tap <css>` on it first');
    }
    const chars = Array.from(text);
    let started = false; // from the first press: the field may hold the text
    let failure = null;
    try {
      // A killed run leaves its marker in the page: the next one would see every field as another.
      // Separate from the clear in `finally`: this one must succeed (a failure stops the run), that one only warns.
      if (verify) await pageCmd('POST', '/execute/sync', { script: FIELD_FORGET, args: [] });
      let up = false;
      for (const end = Date.now() + WAIT.keyboardMs; !(up = await keyboardShown()) && Date.now() < end;) await sleep(250);
      if (!up) throw new Error(`the keyboard didn't appear within ${Math.round(WAIT.keyboardMs / 1000)}s: run \`safari tap <css>\` on the field first`);
      await sleep(WAIT.settleMs); // typing while it is still animating in loses the first character
      const device = session().device;
      const before = verify ? await readFieldText() : null; // for the post-check
      // On the phone every press is checked first: a press goes to whatever is on the screen.
      const put = makeKeySender({ beforePress: device ? requireVisible : null, onSend: () => { started = true; } });
      if (!verify) {
        for (const ch of chars) await put(ch);
        return { keyed: chars.length, verified: false, textChecked: false, textSkip: 'no-verify' };
      }
      const { retries, unverified, byEvent, warning } = await typeVerified(chars, { put, read: readField });
      const text = await checkTyped(before, chars, unverified, byEvent);
      return { keyed: chars.length, ...(retries ? { retries } : {}), ...(unverified ? { unverified } : {}), ...(byEvent ? { byEvent } : {}), ...text, ...(warning ? { warning } : {}) };
    } catch (e) {
      failure = e;
      throw started ? afterTyping('keys', e) : e;
    } finally {
      // A refused tab (not showing, or not the lab's) is sent nothing more, nor is the page after an interrupt; the next run clears the marker first.
      if (verify && !isTabError(failure) && !(failure instanceof InterruptError)) {
        try { await pageCmd('POST', '/execute/sync', { script: FIELD_FORGET, args: [] }); } catch (e) {
          warn(`[safari] couldn't clear the keys marker from the page: ${e.message}`);
        }
      }
    }
  },

  // swipe up|down: a touch drag across the page (up = finger moves up, page scrolls down).
  async swipe([dir]) {
    if (!['up', 'down'].includes(dir)) throw new Error('usage: safari swipe up|down');
    await onScreen();
    return withPage(async ({ area, chrome }) => {
      const x = Math.round(area.x + area.width / 2);
      const [f, t] = dir === 'up' ? [0.7, 0.3] : [0.3, 0.7];
      const from = { x, y: Math.round(area.y + area.height * f) };
      const to = { x, y: Math.round(area.y + area.height * t) };
      guardPoints([from, to], area, chrome, 'the swipe');
      await onScreen();
      await cmd('POST', '/actions', {
        actions: [{
          type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 100 },
            { type: 'pointerMove', duration: 400, x: to.x, y: to.y },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      // Sent even after an interrupt: it lifts a finger the swipe may have left down on the phone.
      try { await duringCleanup(() => cmd('DELETE', '/actions')); } catch (e) { warn(`[safari] releasing actions: ${e.message}`); }
      await sleep(WAIT.swipeSettleMs); // momentum scrolling
      return { swiped: dir, from, to };
    });
  },

  // ui: Safari's native accessibility tree (what `swipe` and `tap` see around the page).
  async ui() {
    await onScreen();
    const tree = await nativeTree({ full: true });
    await onScreen(); // the tree holds the page's visible text: kept only if the lab's tab was showing throughout
    // On the phone only the one web view is kept: Safari's tab bar, outside it, can carry the titles of the owner's other tabs.
    const xml = session().device ? webViewSubtree(tree) : tree;
    const file = artifact('ui', 'xml');
    fs.writeFileSync(file, xml);
    const labels = [];
    for (const m of xml.matchAll(/\blabel="([^"]*)"/g)) {
      const l = xmlText(m[1]).trim();
      if (l && !labels.includes(l)) labels.push(l);
      if (labels.length >= 80) break;
    }
    return { file, labels };
  },

  async source([name]) {
    artifactBase(name || 'page', 'html'); // a path is refused before the page is read
    const file = artifact(name || 'page', 'html');
    fs.writeFileSync(file, await pageCmd('GET', '/source'));
    return { file };
  },

  // shot [name] [--page | --element <css> ...] [--scale N | --width px]: the screen, or the page
  // area or one element of it, optionally shrunk (see cutShot). Alone it is the whole screen,
  // untouched.
  async shot(argv) {
    let opt;
    try { opt = parseShotArgs(argv); } catch (e) { throw Object.assign(e, { skipArtifacts: true }); } // a refused flag leaves nothing to take pictures of
    const name = opt.name || 'page';
    artifactBase(name, 'png'); // a path is refused before the screen is read
    if (opt.mode !== 'plain') {
      // A cut that fails leaves no fail.png either: that would be the full screen the cut was asked to keep out.
      try { return await cutShot(opt, name); } catch (e) { throw Object.assign(e, { skipArtifacts: true }); }
    }
    if (session().device) {
      // The whole screen, from the native layer: the lab's tab must be showing before and after,
      // and the picture is only written once it was.
      await requireVisible();
      const png = Buffer.from(await cmd('GET', '/screenshot'), 'base64');
      await requireVisible();
      const file = artifact(name, 'png');
      fs.writeFileSync(file, png);
      return { file };
    }
    const file = artifact(name, 'png');
    fs.writeFileSync(file, Buffer.from(await pageCmd('GET', '/screenshot'), 'base64'));
    return { file };
  },

  // Console messages since the last `safari console` (then cleared).
  async console() {
    const file = artifact('console', 'json');
    if (session().device) {
      // Never Safari's console log (it holds every tab's messages): the collector in the lab's own page.
      const got = await guarded('const b = window.__mslConsole; return b ? b.splice(0, b.length) : null');
      if (got === null) await guarded(CONSOLE_HOOK); // not installed yet (nothing opened since the session started): from now on
      const entries = (Array.isArray(got) ? got : []).map(e => ({ level: e.level, text: redactUrl(String(e.text)) }));
      fs.writeFileSync(file, JSON.stringify(entries, null, 2));
      return { file, entries, dropped: 0, ...(got === null ? { note: 'the console collector was not installed yet; it is now, and records from here on' } : {}) };
    }
    const { entries, dropped, full, copies } = parseConsole(await cmd('POST', '/se/log', { type: 'safariConsole' }));
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
    return { file, entries, dropped, ...(full ? lossNote(copies, 'console') : {}) };
  },

  // The network log since the last `safari network` (then cleared), with cookies,
  // authorization headers, request bodies and secret URL parameters removed before anything
  // is written or printed. On the iPhone there is no log to read (Safari's holds every tab's
  // traffic): the lab page's own Resource Timing is, read through the tab guard (see NET_HOOK),
  // 500 entries at a time, and only requests to the sites the lab's tab visited this run are kept.
  async network() {
    if (session().device) {
      const tab = readTab();
      const got = await guarded(NET_READ);
      let note;
      if (got === null) { // not installed yet (nothing opened since the session started): from now on
        await guarded(NET_HOOK);
        note = 'the network collector was not installed yet; it is now, and records requests from the page\'s own timing buffer on';
      }
      const r = resourceEntries(got, tab.origins);
      if (r.unsupported) note = 'this Safari does not offer the Resource Timing observer the network collector needs';
      const file = artifact('network', 'json');
      fs.writeFileSync(file, JSON.stringify(r.entries, null, 2));
      return {
        file, count: r.entries.length, requests: r.requests, outside: r.outside, origins: tab.origins, dropped: 0,
        ...(r.left ? { truncated: true, note: `${r.left} more entries are waiting: run \`safari network\` again` } : {}),
        ...(r.lost ? { lost: r.lost } : {}),
        ...(r.early ? { early: true } : {}),
        ...(note ? { note } : {}),
      };
    }
    const { events, requests, dropped, full, copies } = parseNetwork(await cmd('POST', '/se/log', { type: 'safariNetwork' }));
    const file = artifact('network', 'json');
    fs.writeFileSync(file, JSON.stringify(events, null, 2));
    return { file, count: events.length, dropped, requests, ...(full ? lossNote(copies, 'network') : {}) };
  },

  async url() {
    return { url: redactUrl(await pageCmd('GET', '/url')), title: await pageCmd('GET', '/title') };
  },

  // One command per kind of phone setting in the restore ledger (lib/phone-restore.js SETTINGS): `appearance
  // light|dark|restore|status` (the phone's Appearance) and `orientation portrait|landscape|restore|status`
  // (`landscape` is landscapeLeft), through devicectl (no page, no tab). The value it had is written to the ledger
  // first, and put back by `restore`, `safari stop`, `lab down`, the idle stop and the next `lab up`. iPhone only:
  // a simulator session is refused.
  ...Object.fromEntries(COMMAND_KINDS.map(kind => [kind, displayCommand(kind)])),

  // Ends the session, and the server this started (if it did). Also ends a legacy safaridriver one.
  async stop() {
    const s = loadState();
    let device = null;
    if (typeof s.session === 'string' && s.session && s.backend === 'appium' && s.target?.device !== undefined) {
      device = await endDeviceSession(); // the lab's tab first, then the session
    } else if (typeof s.session === 'string' && s.session) {
      const backend = s.backend === 'appium' ? 'appium' : 'safaridriver';
      const port = Number.isInteger(s.port) ? s.port : DEFAULT_PORT[backend];
      try { await wd(backendUrl(backend, port), 'DELETE', `/session/${s.session}`, undefined, 30e3); } catch (e) {
        if (e instanceof InterruptError) throw sessionKept(e); // the record stays: `safari stop` again ends it
        warn(`[safari] ending the session: ${e.message}`);
      }
    }
    // With the LaunchAgent installed launchd owns Appium: never kill an Appium by a recorded
    // pid. A safaridriver an older version started for --device is still ours to end.
    const launchdOwned = s.backend === 'appium' && serviceInstalled();
    if (Number.isInteger(s.driverPid) && s.driverPid > 1 && !launchdOwned) {
      try { process.kill(s.driverPid, 'SIGTERM'); } catch (e) {
        if (e.code !== 'ESRCH') warn(`[safari] stopping the server: ${e.message}`);
      }
    }
    // The phone's WebDriverAgent xcodebuild outlives the deleted session (ppid 1): stop it too.
    let wda = null;
    try { wda = await stopDeviceWda(s, { address: tunnelAddress() }); } catch (e) {
      wda = { did: null, error: errorText(e) };
      warn(`[safari] stopping the WebDriverAgent: ${errorText(e)}`);
    }
    saveState({ session: null, driverPid: null, target: null, backend: null, injected: null, deviceTab: null, pagePin: null, transport: null });
    logRun('safari stop');
    return { stopped: true, ...(device ?? {}), ...(wda?.did ? { wda: wda.did } : {}), ...(wda?.error ? { wdaError: wda.error } : {}) };
  },
};

// Every command says which allowed hosts the lab followed its tab to while it ran (`followed`), on a refusal too.
export const handlers = Object.fromEntries(Object.entries(commands).map(([name, run]) => [name, async argv => {
  followed = [];
  try {
    const out = await run(argv);
    return followed.length && out && typeof out === 'object' ? { ...out, followed: [...followed] } : out;
  } catch (e) {
    if (followed.length && e && typeof e === 'object') e.extra = { ...e.extra, followed: [...followed] };
    throw e;
  }
}]));

// On a failed page command: keep a screenshot, the page source and the error in the run.
// A device command that failed over Wi-Fi: when the tunnel is not up, or one TCP check of the
// phone through it fails, the failure is `needs: tunnel` (merged over the error's own steps, whatever
// they were: with no route to the phone nothing else can be fixed first). A healthy tunnel leaves
// the command's own need as it is.
async function tunnelNeeds() {
  if (loadState().transport?.via !== 'tunnel') return {};
  const health = await tunnelHealthy();
  if (health.ok) return {};
  return { ...needsError('tunnel', health.why).extra, tunnel: health.why };
}

export async function failureArtifacts(name, error) {
  if (['start', 'stop', 'appearance', 'orientation'].includes(name)) return {};
  let c;
  try { c = readSession(loadState()); } catch { return {}; }
  if (c?.target.device !== undefined) return tunnelNeeds(); // nothing from the phone: a shot or the source would show the owner's other tabs
  if (!c || c.backend !== 'appium') return {};
  const out = {};
  try {
    const shot = artifact('fail', 'png');
    fs.writeFileSync(shot, Buffer.from(await cmd('GET', '/screenshot', undefined, 15e3), 'base64'));
    out.screenshot = shot;
  } catch (e) { out.screenshotError = errorText(e); }
  await ensureWeb().catch(() => {}); // the page source needs the web context; switches only if the session is not already in it
  try {
    const html = artifact('fail', 'html');
    fs.writeFileSync(html, await cmd('GET', '/source', undefined, 15e3));
    out.source = html;
  } catch (e) { out.sourceError = errorText(e); }
  logRun(`safari ${name} FAILED: ${error.message}`);
  return { artifacts: out };
}
