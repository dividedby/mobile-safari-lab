import { test, beforeEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, stepClock, REAL_CLOCK, tempDir, linkPlugin, fakeRunner, standin, gradientPng, addResource, addMutation, neverUnsafe as sharedNeverUnsafe, PAGE, OTHER, CURRENT_RULES, havePerl, holdLock, lockIsFree, withSignLock } from './helpers.js';
import { OFF_WARNING } from '../lib/signlock.js';
import { cli, loadState, saveState, newRun, REPO } from '../lib/core.js';
import * as tunnelLib from '../lib/tunnel.js';
import { InterruptError, withInterrupt } from '../lib/interrupt.js';
import * as phoneLib from '../lib/phone.js';
import { SERVICE, buildPlist, plistPath, logFiltersPath, logPath } from '../lib/service.js';
import { handlers as safari, failureArtifacts, readSession, endDeviceSession, deviceNative, userscriptMatches, parseShotArgs, parseAllowHosts, STORAGE_WRITE, WAIT, NET, CLOCK, ELEMENT } from '../lib/safari.js';
import { decodePng } from '../lib/png.js';
import { appiumCaps, appiumDeviceCaps, WDA_BINDING_IP, SIM_CREATE_MS, simCreateWorstMs, WDA_POLL_WORST_MS, LOG_FILTERS, appiumBin, parseConsole, parseNetwork, redact, redactUrl, LOG_CAP, INSTALL_HINT } from '../lib/appium.js';

const U = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
const D = '00008110-001A2B3C4D5E801E';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const HOME = linkPlugin(tempDir('msl-appium-home-'));

// The page, as the stand-in sees it, and everything it was asked.
let server, log, fx, mainUrl;

// Runs the probe script against a fake window and document, as the page would, and returns
// what Appium would: it drops a top-level `scale` key from a script's result (nested keys
// survive). Records the probe's CSS in fx.probeCss.
function runProbeScript(script, args) {
  const style = {};
  // Where the probe's client rect is need not be where it was placed: when zoomed it isn't.
  const probe = { setAttribute() {}, style, getBoundingClientRect: () => ({ left: 0, top: 0, ...fx.page.probeRect }) };
  const window = { innerWidth: fx.page.innerWidth, innerHeight: fx.page.innerHeight, visualViewport: fx.page.visualViewport };
  // The page has no element for the selector here: the measurement is replaced by `fx.geometry` below.
  const document = { createElement: () => probe, documentElement: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [] };
  const out = new Function('window', 'document', 'args', `return (function () {${script}}).apply(null, args);`)(window, document, args);
  fx.probeCss = style.cssText;
  const { scale, ...kept } = out;
  return kept;
}

// What the page says about the tapped element: `fx.geometry`, or `fx.geometryFor(n)` for the nth reading.
const geometry = () => fx.geometryFor ? fx.geometryFor(++fx.measures) : fx.geometry;

// What the `wait` scripts answer: the next of fx.waitSeq over the defaults of that script (nothing found; a page that has been quiet for a second).
const WAIT_NONE = { count: 0, present: 0, visible: 0, hosts: 0, rooted: 0, step: -1, over: 0 };
const WAIT_QUIET = { complete: true, pendingImages: 0, skippedImages: 0, fontsLoading: false, idleMs: 1000, watchedMs: 1000, resources: 0, mutations: 0, sizeChanges: 0, observing: true, resourcesWatched: true };
function waitAnswer(script, args, send, fail) {
  const settle = script.includes('window.__mslSettle');
  fx.waitCalls.push([settle ? 'settle' : 'select', args]);
  const seq = fx.waitSeq ?? [];
  const next = (seq.length > 1 ? seq.shift() : seq[0]) ?? {};
  if (next.throws) return fail('javascript error', next.throws, 500);
  return send({ ...(settle ? WAIT_QUIET : WAIT_NONE), ...next });
}

// The focused field `keys` types into. `drops` / `deleteDrops`: key presses and delete-key
// clicks that deliver nothing; `always`: every key press does nothing; `reject`: characters
// (a RegExp) the field refuses; `max`: maxlength; `lagMs` / `lagPresses`: the next
// `lagPresses` key presses show up in the field `lagMs` after they are sent (Infinity: when
// the next press arrives); `sel`: the selected range (null: a caret at the end); `active`: the page's activeElement (null: nothing focused); `onType`:
// called after a character lands; `dropsFire`: the numbers (1 = the first press of the run) of key presses that fire their events but insert nothing; `resetTo`: the text the field rewrites itself to after every key;
// `fireEvents`: a key press (or the delete key) fires keydown, beforeinput and input to the document's
// listeners (`true`, or `{ types, target }`); `listeners`: what the page registered.
function fieldFixture() {
  const f = { value: '', resetTo: null, dropsFire: [], presses: 0, fireEvents: false, listeners: {}, sel: null, max: -1, drops: 0, deleteDrops: 0, always: false, deleteAlways: false, reject: null, lagMs: 0, lagPresses: 0, late: [], reads: 0, window: {} };
  // What the page shows: the value without the characters that have not arrived yet.
  const hidden = () => f.late.filter(l => l.at > Date.now()).reduce((n, l) => n + l.ch.length, 0);
  const shown = () => f.value.slice(0, f.value.length - hidden());
  // The selection (null: the caret at the end), as a range [start, end].
  const range = () => f.sel || [f.value.length, f.value.length];
  f.active = { tagName: 'INPUT', isContentEditable: false, get value() { return shown(); }, get maxLength() { return f.max; }, get selectionStart() { return range()[0]; }, get selectionEnd() { return range()[1]; } };
  f.window.getSelection = () => ({ isCollapsed: range()[0] === range()[1], focusOffset: range()[1] });
  f.child = {};
  f.contentEditable = { tagName: 'DIV', isContentEditable: true, get textContent() { return shown(); }, contains: n => n === f.child };
  return f;
}
// What a key press on the field does: the field may rewrite itself, then the page's listeners hear of it.
function afterKey() {
  const f = fx.field;
  if (f.resetTo !== null) f.value = f.resetTo;
  if (!f.fireEvents) return;
  const { types = ['keydown', 'beforeinput', 'input'], target = f.active } = f.fireEvents === true ? {} : f.fireEvents;
  for (const type of types) for (const fn of f.listeners[type] ?? []) fn({ type, target });
}
function typeKey(ch) {
  const f = fx.field;
  if (ch === '\n' || f.always || f.reject?.test(ch)) return;
  if (f.dropsFire.includes(++f.presses)) { afterKey(); return; }
  if (f.drops > 0) { f.drops--; return; }
  if (f.max >= 0 && f.value.length + ch.length > f.max) return;
  const [start, end] = f.sel || [f.value.length, f.value.length]; // typing replaces the selection
  f.value = f.value.slice(0, start) + ch + f.value.slice(end);
  f.sel = f.sel && [start + ch.length, start + ch.length];
  for (const l of f.late) if (l.at === Infinity) l.at = 0; // a press that waited for the next one shows up
  if (f.lagPresses > 0) { f.lagPresses--; f.late.push({ at: Date.now() + f.lagMs, ch }); }
  afterKey();
  f.onType?.();
}
function clickDelete() {
  const f = fx.field;
  if (f.deleteAlways) return;
  if (f.deleteDrops > 0) { f.deleteDrops--; return; }
  if (!f.sel) { f.value = Array.from(f.value).slice(0, -1).join(''); afterKey(); return; }
  const [start, end] = f.sel; // a selection is deleted; a caret deletes the character before it
  if (start === end && start === 0) return;
  const from = start === end ? start - 1 : start;
  f.value = f.value.slice(0, from) + f.value.slice(end);
  f.sel = [from, from];
  afterKey();
}
// Runs a page script of `keys` against the fake field, as the page would.
function runFieldScript(script) {
  const f = fx.field;
  if (!script.startsWith('delete window.__mslKeysField')) f.reads++;
  const document = {
    activeElement: f.active,
    addEventListener: (type, fn) => { (f.listeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { f.listeners[type] = (f.listeners[type] ?? []).filter(x => x !== fn); },
  };
  return new Function('window', 'document', `return (function () {${script}})();`)(f.window, document);
}

// The native tree as `mobile: source` returns it from the web context (WebDriverAgent XML):
// the screen, Safari's controls, a page text field, the calibration probe while one is in the
// page, and the keyboard's delete key while the keyboard is up. Without `excludedAttributes`
// (the full form) every node also carries the attributes the lean form leaves out.
const rectAttrs = r => Object.entries(r).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${v}"`).join('');
function sourceXml(opts) {
  const extra = opts?.excludedAttributes ? '' : ' enabled="true" name="n"';
  const node = (type, attrs) => `<${type}${attrs}${extra}/>`;
  const kids = [
    ...fx.chrome.map(id => node('XCUIElementTypeToolbar', rectAttrs(fx.rects[id] ?? { x: 'n/a', y: 'n/a', width: 'n/a', height: 'n/a' }))),
    node('XCUIElementTypeTextField', rectAttrs({ x: 20, y: 300, width: 200, height: 40 })), // a page field: not Safari's
    node('XCUIElementTypeButton', ' label="Reload &amp; stop"'),
    node('XCUIElementTypeButton', ' label="Safari"'),
    node('XCUIElementTypeStaticText', ' label=" "'),
    ...(fx.probeLabel && !fx.probeMissing ? [node('XCUIElementTypeImage', ` label="${fx.probeLabel}"${rectAttrs(fx.probe)}`)] : []),
    ...(fx.deleteKey ? [node('XCUIElementTypeKey', ` label="delete"${rectAttrs(fx.deleteKeyRect)}`)] : []),
    // The page's own native nodes (`fx.webView`: [{ label, x, y, width, height }]), for `tap --label`.
    ...(fx.webView ? [`<XCUIElementTypeWebView x="0" y="0" width="414" height="896">\n${fx.webView.map(l => node('XCUIElementTypeButton', ` label="${l.label.replace(/&/g, '&amp;')}"${rectAttrs({ x: l.x, y: l.y, width: l.width, height: l.height })}`)).join('\n')}\n</XCUIElementTypeWebView>`] : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<XCUIElementTypeApplication label="Safari"${rectAttrs(fx.screen)}${extra}>\n${kids.join('\n')}\n</XCUIElementTypeApplication>`;
}
const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const fresh = () => ({
  field: fieldFixture(),
  settings: null, // what the last Appium settings call set
  settingsFail: false,
  context: 'WEBVIEW_1.1',
  webviews: ['WEBVIEW_1.1'],
  doc: { origin: 1000, ready: 'complete', href: 'about:blank' },
  nextOrigin: 2000,
  staleReads: 0, // after a navigation, this many reads still see the old document
  freeze: false, // navigation never produces a new document
  pending: null,
  focused: true, // a page field is the active element
  focusedEl: null, // ... that element, when it is not the field `keys` types into
  hasFocus: false, // document.hasFocus(): false in the simulator whenever its window is not frontmost
  tapFocus: null, // what a tap reports about the field: null (not a text field), true or false
  geometryFor: null, // (n) => geometry: the nth measurement of the tapped element, when it moves
  measures: 0,
  deleteKey: true, // the keyboard's delete key is on screen
  deleteKeyRect: { x: 340, y: 790, width: 60, height: 40 },
  readDelayMs: 0, // the focused field's reads are answered this long after they are asked
  readHang: false, // ... or never
  sourceDelayMs: 0, // `mobile: source` is answered this long after it is asked
  source: undefined, // what `mobile: source` returns instead of the tree, when set
  keyboard: [true], // answers to successive isKeyboardShown calls (the last one repeats)
  screenshot: null, // the base64 PNG the screenshot route answers (default: just the PNG signature)
  onScreenshot: null, // called when the screenshot is taken
  inset: 0, // env(safe-area-inset-top) in px
  geometry: { cx: 100, cy: 200, rect: { x: 80, y: 190, width: 40, height: 20 }, covered: null },
  selectCount: { count: 1, hosts: 0, rooted: 0, step: -1, over: 0 }, // what the count script of a text / nth / shadow selector gives (or (sel) => that)
  resolveNone: false, // the script that resolves a selector to an element gives none
  waitSeq: null, // the answers of the `wait` scripts (selector and settle alike), in order; the last repeats (see waitAnswer). { throws: 'msg' } makes the page script fail
  waitCalls: [], // [script kind, args] of every wait script
  webView: null, // native nodes inside the web view in the tree (see sourceXml)
  // Safari 27: the page sits 48pt down on a 414x896 screen, scale 1, and is 414x750.
  page: { innerWidth: 414, innerHeight: 750, visualViewport: null }, // visualViewport: null is an old Safari without it
  probeCss: null, // the style the probe was given
  probe: { x: 0, y: 48, width: 100, height: 100 }, // where the calibration probe appears on screen
  screen: { x: 0, y: 0, width: 414, height: 896 }, // the native window
  probeMissing: false, // the probe never shows up in the native tree
  probeLabel: null, // set while a probe is in the page
  probesInserted: 0,
  // Safari's controls by id (a chrome id with no rectangle here comes out unparseable).
  rects: { C1: { x: 0, y: 750, width: 400, height: 50 }, C2: { x: 0, y: 0, width: 400, height: 40 } },
  chrome: ['C1', 'C2'],
  storage: {}, // the simulator page's localStorage by origin
  storageFail: null,
  storageThrow: null, // a message: the storage script throws it outside its try
  storageSets: 0,
  redirect: {},
  consoleLog: [],
  networkLog: [],
  createError: null, // the message the next session create fails with (500)
  pin: true, // the session create answers with the page pin plugin's `msl:pagePin` marker
});

before(async () => {
  process.env.MSL_APPIUM_HOME = HOME;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : undefined;
      log.push([req.method, req.url, json]);
      const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value })); return true; };
      const fail = (error, message = error, status = 404) => send({ error, message }, status);
      const p = req.url.replace(/^\/session\/S1/, '');
      if (req.url === '/status') return send({ ready: true });
      if (req.method === 'POST' && req.url === '/session') {
        if (fx.createError) return fail('session not created', fx.createError, 500);
        return send({ sessionId: 'S1', capabilities: fx.pin ? { 'msl:pagePin': 1 } : {} }); // the page pin plugin marks a pinned session
      }
      if (!req.url.startsWith('/session/S1')) return fail('invalid session id', 'gone');
      const native = fx.context === 'NATIVE_APP';
      const webOnly = () => {
        if (native) return fail('invalid context', 'not in a web context', 400);
        if (!fx.webviews.includes(fx.context)) return fail('no such window', 'window gone');
      };
      if (req.method === 'DELETE' && p === '') return fx.deleteError ? fail('unknown error', fx.deleteError, 500) : send(null);
      if (req.method === 'DELETE' && p === '/actions') return send(null);
      if (req.method === 'POST' && p === '/appium/settings') {
        if (fx.settingsFail) return fail('unknown error', typeof fx.settingsFail === 'string' ? fx.settingsFail : 'settings refused', 500);
        fx.settings = json.settings;
        return send(null);
      }
      if (p === '/context' && req.method === 'GET') return send(fx.context);
      if (p === '/context') {
        if (json.name !== 'NATIVE_APP' && !fx.webviews.includes(json.name)) return fail('invalid context', json.name, 400);
        fx.context = json.name;
        return send(null);
      }
      if (p === '/contexts') return send(['NATIVE_APP', ...fx.webviews]);
      if (p === '/se/log') {
        const key = json.type === 'safariConsole' ? 'consoleLog' : 'networkLog';
        const out = fx[key];
        fx[key] = [];
        return send(out);
      }
      if (p === '/actions') return send(null);
      // The CSS window in the web context, not the screen: nothing may read it as one.
      if (p === '/window/rect') return webOnly() || send({ x: 0, y: 0, width: 980, height: 1773 });
      if (p === '/source') return webOnly() || send('<html><body>hi</body></html>');
      if (p === '/screenshot') { fx.onScreenshot?.(); return send(fx.screenshot ?? PNG); }
      if (p === '/elements') { // the native lookups are gone: only CSS ones are answered
        if (json.using === 'css selector') return webOnly() || send([{ [ELEMENT]: 'E1' }]);
        return fail('unknown error', `native lookup ${json.using} ${json.value}`, 500);
      }
      if (p === '/element/E1/value' && fx.valueFail) return webOnly() || fail('unknown error', fx.valueFail(json), 500); // fx.valueFail(body): the message the server gives
      if (p.startsWith('/element/E1/')) return webOnly() || send(null);
      if (p === '/url' && req.method === 'POST') {
        const bad = webOnly();
        if (bad) return bad;
        const [to, from] = [new URL(json.url), fx.doc.href];
        const hashOnly = to.href.includes('#') && from.split('#')[0] === to.href.split('#')[0];
        if (hashOnly) fx.doc.href = to.href;
        else navigate(to.href);
        return send(null);
      }
      if (p === '/refresh') { navigate(fx.doc.href); return send(null); }
      if (p === '/url') return webOnly() || send(fx.doc.href);
      if (p === '/title') return webOnly() || send('Example');
      if (p === '/execute/sync') {
        // Appium 3.8 rejects an execute call with no args array.
        if (!Array.isArray(json.args)) return fail('invalid argument', 'The following required parameter is missing: ["args"]\nKnown required parameters are: ["script","args"]\nYou have provided: ["script"]', 400);
        const s = json.script;
        if (s.startsWith('mobile:')) { // Appium routes these to WebDriverAgent whatever the context
          if (s === 'mobile: keys') typeKey(json.args[0].keys[0]);
          if (s === 'mobile: source') {
            const out = fx.source !== undefined ? fx.source : sourceXml(json.args[0]);
            return fx.sourceDelayMs ? void setTimeout(() => send(out), fx.sourceDelayMs) : send(out);
          }
          if (s === 'mobile: tap' && fx.deleteKey) {
            const c = centre(fx.deleteKeyRect);
            if (json.args[0].x === c.x && json.args[0].y === c.y) clickDelete();
          }
          return send(s === 'mobile: isKeyboardShown' ? (fx.keyboard.length > 1 ? fx.keyboard.shift() : fx.keyboard[0]) : null);
        }
        const bad = webOnly();
        if (bad) return bad;
        if (s.includes('localStorage.setItem')) {
          if (fx.storageThrow) return fail('javascript error', fx.storageThrow, 500); // the page makes the script throw outside its own try
          return send(runStorageScript(s, json.args));
        }
        if (s.includes('performance.timeOrigin')) {
          if (fx.pending && fx.staleReads > 0) fx.staleReads--;
          else if (fx.pending) { fx.doc = fx.pending; fx.pending = null; }
          return send([fx.doc.origin, fx.doc.ready, fx.doc.href]);
        }
        if (s.includes('location.search !== ')) return send('https://example.com'); // the start script of a device session
        if (s.includes('const found = scanSel(arguments[0]);')) return send(typeof fx.selectCount === 'function' ? fx.selectCount(json.args[0]) : fx.selectCount);
        if (s.includes('const found = scanSel(sel);') || s.includes('window.__mslSettle')) return waitAnswer(s, json.args, send, fail);
        if (s.endsWith('return pick(arguments[0]);')) return send(fx.resolveNone ? null : { [ELEMENT]: 'E1' }); // a returned element comes back as a reference
        if (s.includes('throw-secret')) return fail('javascript error', 'Failed to navigate to https://h/cb?code=SECRETSERVER&x=1', 500);
        if (s.includes('safe-area-inset-top')) return webOnly() || send(fx.inset);
        if (s.includes('createElement')) {
          fx.probeLabel = json.args[0];
          fx.probesInserted++;
          const out = runProbeScript(s, json.args);
          if (json.args.length > 1) out.geo = geometry(); // the element, measured in the probe's own script
          return send(out);
        }
        if (s.includes('p.remove()')) { fx.probeLabel = null; return send(true); }
        if (s.includes('scrollIntoView')) return send(true);
        if (s.includes('elementFromPoint')) return send(geometry());
        if (s.includes('field ? seen.includes(el)')) return send(fx.tapFocus); // after a tap: did the field take the focus
        if (s.includes('return !!(a && (a.tagName')) { // is a page field focused: the real script, against a document whose hasFocus() is fx.hasFocus
          return send(new Function('document', `return (function () {${s}})();`)({ hasFocus: () => fx.hasFocus, activeElement: fx.focused ? fx.focusedEl ?? fx.field.active : null }));
        }
        if (s.includes('GM_info')) return send(s.includes('THROWSECRET') ? 'Error: failed at http://h/x?code=SECRETINJECT&z=1' : null);
        if (s.includes('__mslKeysField')) {
          const read = !s.startsWith('delete window.__mslKeysField'); // the field reads, not the marker's clearing
          if (read && fx.readHang) return true; // Safari's Web Inspector never answers
          if (read && fx.readDelayMs) return void setTimeout(() => send(runFieldScript(s)), fx.readDelayMs);
          return send(runFieldScript(s));
        }
        if (s.includes('__mslInjected ===')) return send(!fx.injectGone); // inject's check that its document is still showing
        if (s.includes('__mslThenable')) return send(new Function(s).apply(null, json.args ?? [])); // eval's script and its Promise reads, run as the page would
        return send(true);
      }
      fail('unknown command', p);
    });
  });
  // The storage script, against the page's own origin's localStorage (fx.storage: origin -> Map). `fx.storageFail`: the setItem number `at` throws an error of that name whose message holds the value.
  const runStorageScript = (script, args) => {
    const location = { origin: new URL(fx.doc.href).origin };
    const localStorage = { setItem: (k, v) => {
      if (fx.storageFail && fx.storageSets++ === fx.storageFail.at) throw Object.assign(new Error(`cannot store ${k}=${v}`), { name: fx.storageFail.name });
      (fx.storage[location.origin] ??= new Map()).set(k, v);
    } };
    return new Function('location', 'localStorage', 'args', `return (function () {${script}}).apply(null, args);`)(location, localStorage, args);
  };
  const navigate = href => {
    if (fx.freeze) return;
    const redirect = fx.redirect[new URL(href).host]; // host -> host the server sends the browser to
    if (redirect) href = href.replace(new URL(href).host, redirect);
    fx.pending = { origin: fx.nextOrigin++, ready: 'complete', href };
  };
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  mainUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.MSL_APPIUM_URL = mainUrl;
});
after(() => {
  server.close();
  delete process.env.MSL_APPIUM_URL;
  delete process.env.MSL_APPIUM_HOME;
});
const SERVICE_PORT = SERVICE.port; // tests that stand in for the service move it
// The short limits the tests run with; beforeEach and startPhone both start from these.
const BASE_WAIT = { tabMs: 10e3, parkSendMs: 1e3, tabSettleMs: 0, closeMs: 400, closeDelayMs: 250, closePollMs: 5, pollMs: 5, plantPollMs: 5, navSettleMs: 200, navSettlePollMs: 5, timeoutMs: 400, probeMs: 100, deleteMs: 5, settleMs: 5, keyboardMs: 600, charGapMs: 2, tapSettleMs: 5, swipeSettleMs: 5, stableMs: 5, stableTries: 3, landMs: 30, landPollMs: 3, keyRetries: 2, callMs: 10e3, readMs: 30e3, treeMs: 30e3, sourceMs: 60e3, waitPollMs: 5, waitPollDeviceMs: 5, injectWatchMs: 20, injectPollMs: 5, evalPollMs: 5 };
const REAL_NET = { ...NET }; // the seam in lib/safari.js, as shipped
beforeEach(() => {
  sandbox();
  SERVICE.port = SERVICE_PORT;
  log = [];
  fx = fresh();
  process.env.MSL_APPIUM_URL = mainUrl;
  Object.assign(WAIT, BASE_WAIT);
  Object.assign(NET, REAL_NET);
  stepClock();
  saveState({ udid: U });
  phoneLib.setUsbmux();
});

const start = () => safari.start([]);
const posts = pathSuffix => log.filter(([m, u]) => m === 'POST' && u.endsWith(pathSuffix));
const predicates = () => log.filter(([, u, b]) => u.endsWith('/elements') && b.using === '-ios predicate string').map(([, , b]) => b.value);
const lastContextSwitch = () => posts('/context').at(-1)[2].name;

// --- start, state, stop ---

test('start opens an Appium session on the saved simulator with exactly these capabilities', async () => {
  const out = await start();
  const create = log.find(([m, u]) => m === 'POST' && u === '/session');
  assert.deepEqual(create[2], { capabilities: { alwaysMatch: appiumCaps(U) } });
  assert.deepEqual(create[2].capabilities.alwaysMatch, {
    platformName: 'iOS',
    browserName: 'Safari',
    'appium:automationName': 'XCUITest',
    'appium:udid': U,
    'appium:derivedDataPath': path.join(HOME, 'wda'),
    'appium:newCommandTimeout': 1800,
    'appium:webviewConnectTimeout': 30000,
    'appium:showSafariConsoleLog': true,
    'appium:showSafariNetworkLog': true,
    'appium:wdaLaunchTimeout': 30000,
    'appium:wdaStartupRetries': 2,
    'appium:wdaStartupRetryInterval': 10000,
    'appium:wdaConnectionTimeout': 90000,
    'appium:wdaBindingIP': '127.0.0.1',
  });
  assert.deepEqual(out, { session: 'S1', backend: 'appium', target: { simulator: U }, targetType: 'simulator' });
  const s = loadState();
  assert.equal(s.backend, 'appium');
  assert.equal(s.session, 'S1');
  assert.equal(s.port, 4723);
  assert.deepEqual(s.target, { simulator: U });
  assert.equal(s.driverPid, undefined); // nothing was spawned: the server was already there
});

test('start --allow-host on the simulator stores nothing and says the simulator has no tab guard', async () => {
  const out = await safari.start(['--allow-host', 'Old.Test', '--allow-host', 'localhost:3000']);
  assert.deepEqual(out.allowHosts, ['old.test', 'localhost:3000']);
  assert.equal(out.note, 'the simulator has no tab guard; its tab may go to any site');
  assert.equal(loadState().deviceTab, undefined);
  const again = await safari.start(['--allow-host', 'old.test']);
  assert.equal(again.reused, true);
  assert.deepEqual(again.allowHosts, ['old.test']);
  assert.equal((await safari.start([])).allowHosts, undefined, 'no hosts asked for, none reported');
  await assert.rejects(safari.start(['--allow-host', '*.test']), /wildcards are not taken/);
});

test('start never spawns when MSL_APPIUM_URL points at nothing', async () => {
  const saved = process.env.MSL_APPIUM_URL;
  process.env.MSL_APPIUM_URL = 'http://127.0.0.1:1';
  try {
    await assert.rejects(start(), /no WebDriver at http:\/\/127\.0\.0\.1:1/);
  } finally { process.env.MSL_APPIUM_URL = saved; }
  assert.equal(loadState().driverPid, undefined);
});

test('start without Appium installed says how to install it, before launching anything', async () => {
  const saved = process.env.MSL_APPIUM_URL;
  delete process.env.MSL_APPIUM_URL;
  const empty = tempDir('msl-empty-');
  const prev = process.env.MSL_APPIUM_HOME;
  process.env.MSL_APPIUM_HOME = empty;
  const free = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
  try {
    assert.equal(appiumBin(), path.join(empty, 'node_modules', '.bin', 'appium'));
    await assert.rejects(safari.start(['--port', String(free)]), err => {
      assert.equal(err.message, INSTALL_HINT);
      assert.match(err.message, /pnpm add appium@3\.8\.0 appium-xcuitest-driver@12\.18\.1/);
      return true;
    });
    assert.equal(loadState().driverPid, undefined);
  } finally {
    process.env.MSL_APPIUM_URL = saved;
    process.env.MSL_APPIUM_HOME = prev;
  }
});

test('start validates its flags before doing anything', async () => {
  await assert.rejects(safari.start(['--port', 'abc']), /--port/);
  await assert.rejects(safari.start(['--port', '70000']), /--port/);
  await assert.rejects(safari.start(['--target', 'phone']), /--target must be one of auto, device, simulator \(got "phone"\)/);
  await assert.rejects(safari.start(['--device', 'nope']), /--device needs the phone's UDID/);
  await assert.rejects(safari.start(['--device', PU, '--target', 'simulator']), /contradict/);
  assert.equal(log.length, 0);
  assert.equal(loadState().session, undefined);
});

test('start reuses a live session and replaces a dead one', async () => {
  await start();
  assert.equal((await start()).reused, true);
  assert.equal(posts('').filter(([, u]) => u === '/session').length, 1);
  assert.ok(log.some(([m, u]) => m === 'GET' && u === '/session/S1/context')); // liveness probe

  saveState({ backend: 'appium', session: 'GONE', port: 4723, target: { simulator: U }, injected: ['/tmp/a.user.js'], driverPid: 4242 });
  assert.equal((await start()).session, 'S1');
  assert.deepEqual(loadState().injected, undefined);
  assert.equal(loadState().driverPid, 4242); // kept, so `stop` can still end a server we spawned
});

test('readSession accepts a good state, reads an old one as safaridriver, and rejects the rest', () => {
  const good = { backend: 'appium', session: 'S', port: 4723, target: { simulator: U }, driverPid: 99, injected: ['/a/b.user.js'] };
  assert.deepEqual(readSession(good), good);
  assert.equal(readSession({}), null);
  assert.equal(readSession({ udid: U }), null);
  assert.equal(readSession({ session: null }), null);
  const old = readSession({ session: 'S', port: 4744, target: { device: D } });
  assert.equal(old.backend, 'safaridriver');
  assert.deepEqual(old.injected, []);
  const bad = patch => assert.throws(() => readSession({ ...good, ...patch }), /state file is damaged: run `safari stop`/);
  bad({ port: 0 });
  bad({ port: 70000 });
  bad({ port: '4723' });
  bad({ port: undefined });
  bad({ target: undefined });
  bad({ target: { simulator: 'nope' } });
  bad({ target: { simulator: U, device: D } });
  bad({ target: { phone: U } });
  bad({ backend: 'selenium' });
  bad({ session: '' });
  bad({ session: 7 });
  bad({ driverPid: 'x' });
  bad({ driverPid: 1 });
  bad({ injected: 'a.js' });
  bad({ injected: ['relative.user.js'] });
});

test('a damaged state is reported by page commands and replaced by start', async () => {
  saveState({ backend: 'appium', session: 'S1', port: 99999, target: { simulator: U } });
  await assert.rejects(safari.eval(['1']), /state file is damaged: run `safari stop`/);
  assert.equal((await start()).session, 'S1');
  assert.equal(loadState().port, 4723);
});

test('stop ends the session and clears the Appium state, keeping the simulator', async () => {
  await start();
  const f = path.join(path.dirname(loadState().run), 'x.user.js');
  fs.writeFileSync(f, '1;');
  await safari.inject([f]);
  assert.equal(loadState().injected.length, 1);
  assert.deepEqual(await safari.stop(), { stopped: true });
  assert.ok(log.some(([m, u]) => m === 'DELETE' && u === '/session/S1'));
  const s = loadState();
  for (const k of ['session', 'backend', 'target', 'injected', 'driverPid']) assert.equal(s[k], undefined, k);
  assert.equal(s.udid, U);
});

// --- web context ---

test('the web context is found by listing and found again when its id changes', async () => {
  await start();
  fx.context = 'NATIVE_APP'; // a session that starts in (or is left in) the native layer
  assert.equal((await safari.eval(['1 + 1'])).value, 2);
  assert.equal(lastContextSwitch(), 'WEBVIEW_1.1');

  fx.webviews = ['WEBVIEW_2.1']; // Safari renumbered it; the old id is still "current"
  assert.equal((await safari.eval(['1 + 1'])).value, 2);
  assert.equal(lastContextSwitch(), 'WEBVIEW_2.1');
  assert.ok(!JSON.stringify(log).includes('WEBVIEW_9'));

  fx.webviews = [];
  await assert.rejects(safari.eval(['1']), /Safari has no page open/);
});

// --- open, refresh, reinject ---

test('open waits for the new document, not just for the request to return', async () => {
  await start();
  fx.staleReads = 3;
  const out = await safari.open(['http://127.0.0.1:3000/page']);
  assert.deepEqual(out, { url: 'http://127.0.0.1:3000/page', title: 'Example' });
  assert.ok(posts('/execute/sync').filter(([, , b]) => b.script.includes('performance.timeOrigin')).length >= 5); // before + 3 stale + new
  assert.equal(fx.doc.origin, 2000);
  await assert.rejects(safari.open(['javascript:alert(1)']), /usage/);
  await assert.rejects(safari.open([]), /usage/);
});

test('open and refresh time out with a clear error when no new document comes', async () => {
  await start();
  fx.freeze = true;
  await assert.rejects(safari.open(['http://127.0.0.1:3000/never']), /opening http:\/\/127\.0\.0\.1:3000\/never: the page didn't finish loading/);
  await assert.rejects(safari.refresh([]), /refreshing: the page didn't finish loading/);
});

test('open to the same page with only a #fragment changed returns once the URL matches', async () => {
  await start();
  await safari.open(['http://127.0.0.1:3000/page']);
  const origin = fx.doc.origin;
  const t = CLOCK.now();
  const out = await safari.open(['http://127.0.0.1:3000/page#section']);
  assert.equal(out.url, 'http://127.0.0.1:3000/page#section');
  assert.equal(fx.doc.origin, origin); // same document
  assert.ok(CLOCK.now() - t <= WAIT.pollMs, 'returned on the first look, not after the load deadline'); // the clock moves only in the waits
  // An empty fragment is a fragment too.
  const t2 = CLOCK.now();
  await safari.open(['http://127.0.0.1:3000/page#']);
  assert.equal(fx.doc.origin, origin);
  assert.ok(CLOCK.now() - t2 <= WAIT.pollMs, 'returned on the first look, not after the load deadline');
  // Going back to the bare URL is a real navigation again and waits for a new document.
  fx.staleReads = 1;
  await safari.open(['http://127.0.0.1:3000/page']);
  assert.notEqual(fx.doc.origin, origin);
});

test('refresh waits for the reload and returns where it is', async () => {
  await start();
  await safari.open(['http://127.0.0.1:3000/page']);
  const origin = fx.doc.origin;
  fx.staleReads = 2;
  const out = await safari.refresh([]);
  assert.deepEqual(out, { url: 'http://127.0.0.1:3000/page', title: 'Example' });
  assert.notEqual(fx.doc.origin, origin);
  assert.ok(posts('/refresh').length === 1);
});

test('inject says so when the page showing afterwards is not the document the script ran in (#102)', async () => {
  await start();
  const f = path.join(path.dirname(loadState().run), 'm.user.js');
  fs.writeFileSync(f, 'window.m = 1;\n');
  const ran = (await safari.inject([f]));
  assert.equal(ran.pageChanged, undefined);
  assert.equal(ran.warning, undefined);
  const sent = posts('/execute/sync').map(([, , x]) => x);
  const run = sent.findLast(x => x.script.includes('GM_info')), check = sent.findLast(x => x.script.includes('__mslInjected ==='));
  const mark = /__mslInjected = "(\d+)";/.exec(run.script)?.[1];
  assert.ok(mark, 'the script sets its mark first');
  assert.deepEqual(check.args, [mark], 'the check asks for that same mark');
  fx.injectGone = true;
  const gone = await safari.inject([f]);
  assert.equal(gone.pageChanged, true);
  assert.match(gone.warning, /not the document the script ran in/);
  assert.deepEqual(loadState().injected, [f], 'still recorded for --reinject');
});

test('inject is recorded once, and open/refresh --reinject run every recorded file again', async () => {
  await start();
  const dir = path.dirname(loadState().run);
  const [a, b] = ['a.user.js', 'b.user.js'].map(n => path.join(dir, n));
  fs.writeFileSync(a, '// ==UserScript==\n// @name A\n// ==/UserScript==\nwindow.a = 1;\n');
  fs.writeFileSync(b, 'window.b = 1;\n');
  const out = await safari.inject([a]);
  assert.equal(out.note, 'lost on navigation or refresh; use open/refresh --reinject');
  await safari.inject([b]);
  await safari.inject([a]);
  assert.deepEqual(loadState().injected, [a, b]);
  const scripts = () => posts('/execute/sync').map(([, , x]) => x.script).filter(s => s.includes('GM_info'));
  const before = scripts().length;

  await safari.open(['http://127.0.0.1:3000/x']);
  assert.equal(scripts().length, before); // plain open does not re-run anything
  const o = await safari.open(['http://127.0.0.1:3000/x2', '--reinject']);
  assert.deepEqual(o.reinjected, [a, b]);
  assert.equal(scripts().length, before + 2);
  assert.match(scripts().at(-2), /window\.a = 1/);
  assert.match(scripts().at(-1), /window\.b = 1/);
  const r = await safari.refresh(['--reinject']);
  assert.deepEqual(r.reinjected, [a, b]);
  assert.equal(scripts().length, before + 4);

  fs.rmSync(b);
  await assert.rejects(safari.refresh(['--reinject']), /can't reinject .*b\.user\.js/);
});

const header = (...lines) => `// ==UserScript==\n${lines.map(l => `// ${l}`).join('\n')}\n// ==/UserScript==\nwindow.ran = 1;\n`;
const CONN = 'https://www.nytimes.com/games/connections';
const WORDLE = 'https://www.nytimes.com/games/wordle/index.html';

test('userscriptMatches follows @match, @include, @exclude and @exclude-match', () => {
  const table = [
    // [header lines, url, runs]
    [[], WORDLE, true], // no @match / @include: everywhere
    [['@name X'], WORDLE, true],
    [['@match https://www.nytimes.com/games/connections*'], CONN, true],
    [['@match https://www.nytimes.com/games/connections*'], WORDLE, false],
    [['@match https://www.nytimes.com/games/connections*'], `${CONN}?x=1#h`, true], // the hash is not part of the path
    [['@match https://www.nytimes.com/games/connections'], `${CONN}?x=1`, false], // the query is
    [['@match *://www.nytimes.com/*'], 'http://www.nytimes.com/a', true], // * is http or https
    [['@match *://www.nytimes.com/*'], 'ftp://www.nytimes.com/a', false],
    [['@match https://www.nytimes.com/*'], 'http://www.nytimes.com/a', false],
    [['@match https://*.nytimes.com/*'], 'https://nytimes.com/a', true], // x.com and its subdomains
    [['@match https://*.nytimes.com/*'], 'https://a.b.nytimes.com/a', true],
    [['@match https://*.nytimes.com/*'], 'https://evilnytimes.com/a', false],
    [['@match https://*.nytimes.com/*'], 'https://nytimes.com.evil.test/a', false],
    [['@match https://*/*'], 'https://anything.test/a', true],
    [['@match <all_urls>'], 'http://127.0.0.1:3000/', true],
    [['@match https://a.test/x'], 'https://a.test/x', true],
    [['@match https://a.test/x', '@match https://b.test/*'], 'https://b.test/y', true], // any of several
    [['@include https://www.nytimes.com/games/connections*'], CONN, true],
    [['@include https://www.nytimes.com/games/connections*'], WORDLE, false],
    [['@include /^https:\\/\\/www\\.nytimes\\.com\\/games\\/(wordle|spelling)/'], WORDLE, true],
    [['@include /^https:\\/\\/www\\.nytimes\\.com\\/games\\/(wordle|spelling)/'], CONN, false],
    [['@include /nytimes/i'], 'https://WWW.NYTIMES.COM/', true],
    [['@include /(unclosed/'], WORDLE, false], // unreadable: never matches
    [['@match nonsense'], WORDLE, false],
    [['@match https://www.nytimes.com/*', '@exclude https://www.nytimes.com/games/wordle*'], WORDLE, false], // exclude wins
    [['@match https://www.nytimes.com/*', '@exclude https://www.nytimes.com/games/wordle*'], CONN, true],
    [['@match https://www.nytimes.com/*', '@exclude-match https://www.nytimes.com/games/wordle/*'], WORDLE, false],
    [['@match https://www.nytimes.com/*', '@exclude /(unclosed/'], WORDLE, true], // an unreadable exclude excludes nothing
    [['@exclude https://www.nytimes.com/games/wordle*'], WORDLE, false], // only an exclude: everywhere else
    [['@exclude https://www.nytimes.com/games/wordle*'], CONN, true],
    [['@match https://a.test/*'], 'not a url', false],
  ];
  for (const [lines, url, runs] of table) assert.equal(userscriptMatches(header(...lines), url), runs, `${lines.join(' | ')} on ${url}`);
  assert.equal(userscriptMatches('window.ran = 1;', WORDLE), true); // no header at all
  assert.equal(userscriptMatches('// @match https://a.test/*\nwindow.ran = 1;', WORDLE), true); // not inside a header: ignored
});

const recordedScripts = names => {
  const dir = path.dirname(loadState().run);
  return Object.fromEntries(Object.entries(names).map(([n, src]) => [n, path.join(dir, `${n}.user.js`)].map((v, i) => i ? (fs.writeFileSync(v, src), v) : v)));
};
const ranScripts = () => posts('/execute/sync').map(([, , x]) => x.script).filter(s => s.includes('GM_info'));

test('open --reinject skips a script whose @match does not fit the page, and says which', async () => {
  await start();
  const f = recordedScripts({
    conn: header('@name Connections', '@match https://www.nytimes.com/games/connections*') + 'window.conn = 1;\n',
    wordle: header('@name Wordle', '@match https://www.nytimes.com/games/wordle/*') + 'window.wordle = 1;\n',
    plain: 'window.plain = 1;\n',
  });
  for (const file of Object.values(f)) await safari.inject([file]);
  const before = ranScripts().length;
  const out = await safari.open([WORDLE, '--reinject']);
  assert.deepEqual(out.reinjected, [f.wordle, f.plain]);
  assert.deepEqual(out.reinjectSkipped, [f.conn]); // file names only
  const ran = ranScripts().slice(before);
  assert.equal(ran.length, 2);
  assert.ok(ran.every(r => !r.includes('window.conn')), 'the Connections script was not executed');
  const refreshed = await safari.refresh(['--reinject']);
  assert.deepEqual(refreshed.reinjectSkipped, [f.conn]);
  assert.equal(ranScripts().length, before + 4);
  // On a page it matches, it runs.
  const there = await safari.open([CONN, '--reinject']);
  assert.deepEqual(there.reinjected, [f.conn, f.plain]);
  assert.deepEqual(there.reinjectSkipped, [f.wordle]);
  assert.ok(ranScripts().at(-2).includes('window.conn'));
});

test('open --reinject: @exclude wins over @match, and open reads the address once', async () => {
  await start();
  const f = recordedScripts({ x: header('@match https://www.nytimes.com/*', '@exclude https://www.nytimes.com/games/wordle*') + 'window.x = 1;\n' });
  await safari.inject([f.x]);
  const urlReads = () => log.filter(([m, u]) => m === 'GET' && u.endsWith('/url')).length;
  const base = urlReads();
  const out = await safari.open([WORDLE, '--reinject']);
  assert.deepEqual(out.reinjected, []);
  assert.deepEqual(out.reinjectSkipped, [f.x]);
  assert.equal(urlReads() - base, 1); // one read serves the matching and the output
});

test('the matching is on the real address, the output still redacts it', async () => {
  await start();
  const f = recordedScripts({ cb: header('@match https://h.test/cb?code=SECRETCODE*') + 'window.cb = 1;\n' });
  await safari.inject([f.cb]);
  const out = await safari.open(['https://h.test/cb?code=SECRETCODE&ok=1', '--reinject']);
  assert.deepEqual(out.reinjected, [f.cb]); // matched against the unredacted address
  assert.ok(!JSON.stringify(out).includes('SECRETCODE'));
});

test('inject still runs a script on a page that does not match, and warns without naming the page', async () => {
  await start();
  const f = recordedScripts({
    conn: header('@match https://www.nytimes.com/games/connections*') + 'window.conn = 1;\n',
    plain: 'window.plain = 1;\n',
  });
  await safari.open([WORDLE]);
  const off = await safari.inject([f.conn]);
  assert.match(off.warning, /does not match the script's @match/);
  assert.doesNotMatch(off.warning, /nytimes|wordle/i);
  assert.ok(ranScripts().some(r => r.includes('window.conn = 1')), 'it ran');
  assert.deepEqual(loadState().injected, [f.conn]); // and is recorded
  await safari.open([CONN]);
  assert.equal((await safari.inject([f.conn])).warning, undefined);
  assert.equal((await safari.inject([f.plain])).warning, undefined);
});

test('inject --forget drops one recorded file, matched by its resolved path, and runs nothing in the page', async () => {
  await start();
  const f = recordedScripts({ a: 'window.a = 1;\n', b: 'window.b = 1;\n' });
  await safari.inject([f.a]);
  await safari.inject([f.b]);
  const sent = posts('/execute/sync').length;
  const out = await safari.inject(['--forget', f.a]);
  assert.deepEqual(out, { forgotten: f.a, remaining: [f.b] });
  assert.deepEqual(loadState().injected, [f.b]);
  assert.equal(posts('/execute/sync').length, sent, 'no page call');
  fs.rmSync(f.b); // a deleted file can still be forgotten
  const rel = path.relative(process.cwd(), f.b);
  assert.deepEqual(await safari.inject(['--forget', rel]), { forgotten: rel, remaining: [] });
  assert.deepEqual(loadState().injected, []);
});

test('inject --forget of a file that is not recorded is an error that lists what is', async () => {
  await start();
  const f = recordedScripts({ a: 'window.a = 1;\n', b: 'window.b = 1;\n', c: 'window.c = 1;\n' });
  await safari.inject([f.a]);
  await safari.inject([f.b]);
  const e = await failing(safari.inject(['--forget', f.c]));
  assert.equal(e.message, `inject --forget: ${f.c} is not recorded; recorded: ${f.a}, ${f.b}`);
  assert.deepEqual(e.extra.recorded, [f.a, f.b]);
  assert.equal(e.skipArtifacts, true);
  assert.deepEqual(loadState().injected, [f.a, f.b]);
  await safari.inject(['--clear']);
  assert.match((await failing(safari.inject(['--forget', f.a]))).message, /is not recorded; no scripts are recorded$/);
});

test('inject --clear drops every recorded file and counts them; on an empty list it is ok with a note', async () => {
  await start();
  const f = recordedScripts({ a: 'window.a = 1;\n', b: 'window.b = 1;\n' });
  await safari.inject([f.a]);
  await safari.inject([f.b]);
  const sent = posts('/execute/sync').length;
  assert.deepEqual(await safari.inject(['--clear']), { cleared: 2 });
  assert.deepEqual(loadState().injected, []);
  assert.deepEqual(await safari.inject(['--clear']), { cleared: 0, note: 'no scripts were recorded' });
  assert.equal(posts('/execute/sync').length, sent, 'no page call');
  assert.deepEqual((await safari.open(['http://127.0.0.1:3000/x', '--reinject'])).reinjected, []);
});

test('inject --forget and --clear refuse other combinations with usage text, before anything runs', async () => {
  await start();
  const f = recordedScripts({ a: 'window.a = 1;\n', b: 'window.b = 1;\n' });
  await safari.inject([f.a]);
  const sent = log.length;
  const cases = [
    [['--forget'], /--forget takes exactly one file/],
    [['--forget', f.a, f.b], /--forget takes exactly one file/],
    [['--forget', f.a, '--forget', f.b], /--forget takes exactly one file/],
    [['--clear', f.a], /--clear takes no file/],
    [['--forget', '--clear'], /--forget and --clear cannot be used together/],
    [['--forget', f.a, '--clear'], /--forget and --clear cannot be used together/],
    [['--forget=' + f.a], /argument #1 is not a flag inject knows/],
    [['--only', f.a], /argument #1 is not a flag inject knows/],
  ];
  for (const [args, re] of cases) {
    const e = await failing(safari.inject(args));
    assert.match(e.message, re, args.join(' '));
    assert.match(e.message, /usage: safari inject <file\.user\.js>  or  safari inject --forget <file\.user\.js>  or  safari inject --clear$/, args.join(' '));
    assert.equal(e.skipArtifacts, true);
  }
  assert.equal(log.length, sent, 'nothing was sent to Appium');
  assert.deepEqual(loadState().injected, [f.a]);
  await assert.rejects(safari.inject([]), /^Error: usage: safari inject <file\.user\.js>  or  safari inject --forget <file\.user\.js>  or  safari inject --clear$/);
});

test('inject --forget and --clear need a session, like inject does', async () => {
  await assert.rejects(safari.inject(['--clear']), /No Safari session/);
  await assert.rejects(safari.inject(['--forget', '/tmp/x.user.js']), /No Safari session/);
});

test('open and refresh --reinject warn when more than one recorded script ran again, and not for one', async () => {
  await start();
  const f = recordedScripts({ a: 'window.a = 1;\n', b: 'window.b = 1;\n' });
  await safari.inject([f.a]);
  await safari.inject([f.b]);
  const o = await safari.open(['http://127.0.0.1:3000/x', '--reinject']);
  assert.equal(o.warning, `2 recorded scripts ran again (${f.a}, ${f.b}); to run fewer, drop one with \`safari inject --forget <file>\``);
  assert.equal((await safari.refresh(['--reinject'])).warning, o.warning);
  assert.equal((await safari.open(['http://127.0.0.1:3000/x'])).warning, undefined);
  await safari.inject(['--forget', f.a]);
  const one = await safari.open(['http://127.0.0.1:3000/x', '--reinject']);
  assert.deepEqual(one.reinjected, [f.b]);
  assert.equal(one.warning, undefined);
  assert.equal((await safari.refresh(['--reinject'])).warning, undefined);
});

test('the reinject warning counts only the scripts that ran, not the skipped ones', async () => {
  await start();
  const f = recordedScripts({
    wordle: header('@match https://www.nytimes.com/games/wordle*') + 'window.w = 1;\n',
    conn: header('@match https://www.nytimes.com/games/connections*') + 'window.c = 1;\n',
  });
  await safari.inject([f.wordle]);
  await safari.inject([f.conn]);
  const out = await safari.open([WORDLE, '--reinject']);
  assert.deepEqual(out.reinjected, [f.wordle]);
  assert.deepEqual(out.reinjectSkipped, [f.conn]);
  assert.equal(out.warning, undefined);
});

// --- console and network ---

// Each logged message carries its own timestamp and column, so genuine repeats differ.
const entry = (level, text, url = 'http://127.0.0.1:3000/', line = 1, t = 1) =>
  ({ level: 'INFO', timestamp: t, message: JSON.stringify({ level, text, source: 'console-api', url, line, timestamp: t, column: t }) });

test('console drops the double delivery and WDA noise but keeps a message logged twice', async () => {
  await start();
  fx.consoleLog = [
    entry('error', 'A'), entry('error', 'A'), // one message, delivered twice
    entry('error', 'Failed to load favicon', 'http://127.0.0.1:8100/favicon.ico'), entry('error', 'Failed to load favicon', 'http://127.0.0.1:8100/favicon.ico'),
    entry('log', 'C', undefined, 1, 2), entry('log', 'C', undefined, 1, 2), entry('log', 'C', undefined, 1, 3), entry('log', 'C', undefined, 1, 3), // logged twice by the page, each delivered twice
    { level: 'INFO', timestamp: 2, message: 'plain text, not JSON' },
  ];
  const out = await safari.console();
  assert.deepEqual(out.entries.map(e => [e.level, e.text]), [['error', 'A'], ['log', 'C'], ['log', 'C'], ['log', 'plain text, not JSON']]);
  assert.equal(out.dropped, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(out.file, 'utf8')), out.entries);
  assert.equal(path.dirname(out.file), loadState().run);
  assert.deepEqual((await safari.console()).entries, []); // reading drained it
  assert.deepEqual(posts('/se/log')[0][2], { type: 'safariConsole' });
});

test('console copies from repeated context switches collapse to one, genuine repeats stay', () => {
  const same = Array.from({ length: 23 }, () => entry('warn', 'careful', undefined, 7, 5));
  assert.deepEqual(parseConsole(same), { entries: [{ level: 'warn', text: 'careful', source: 'console-api', url: 'http://127.0.0.1:3000/', line: 7 }], dropped: 22, full: false, copies: 23 });
  const twice = parseConsole([...same.slice(0, 5), ...Array.from({ length: 5 }, () => entry('warn', 'careful', undefined, 7, 6))]);
  assert.equal(twice.entries.length, 2); // same text and line, different timestamp and column
  assert.equal(twice.dropped, 8);
  const mixed = parseConsole([entry('log', 'x', undefined, 1, 1), entry('log', 'y', undefined, 1, 2), entry('log', 'x', undefined, 1, 1)]);
  assert.deepEqual(mixed.entries.map(e => e.text), ['x', 'y']); // first occurrence kept, order kept
});

test('console url and text lose their secret query parameters', () => {
  const { entries } = parseConsole([entry('error', 'GET http://h/api?token=SECRETTOKEN&a=1 failed', 'http://127.0.0.1:3000/?code=SECRETCODE&x=2')]);
  const text = JSON.stringify(entries);
  assert.ok(!text.includes('SECRET'));
  assert.match(text, /a=1/);
  assert.match(text, /x=2/);
});

test('parseConsole copes with odd input', () => {
  assert.deepEqual(parseConsole(undefined), { entries: [], dropped: 0, full: false, copies: 0 });
  assert.deepEqual(parseConsole([{ message: '{"text":"hi"}' }]).entries, [{ level: 'log', text: 'hi' }]);
  assert.equal(parseConsole([entry('log', 'x', 'not a url')]).entries.length, 1);
  assert.equal(parseConsole([entry('log', 'x', 'http://127.0.0.1:8100/a'), entry('log', 'x', 'http://127.0.0.1:3000/')]).entries.length, 1);
});

const SECRETS = ['SECRETLOCATION', 'SECRETCOOKIE', 'SECRETSETCOOKIE', 'SECRETBEARER', 'SECRETBODY', 'SECRETTOKEN', 'SECRETCODE', 'SECRETKEY', 'SECRETREF', 'SECRETRAW', 'SECRETPROXY', 'SECRETFRAG'];
// The real shape: the payload is under `event` (the raw protocol calls it `params`).
const ev = (method, event) => ({ level: 'DEBUG', timestamp: 1, message: JSON.stringify({ method, event }) });

test('network redacts cookies, authorization, bodies and secret URL parameters before writing or returning', async () => {
  await start();
  fx.networkLog = [
    ev('Network.requestWillBeSent', {
      requestId: 'r1',
      documentURL: 'http://127.0.0.1:3000/app?session=SECRETKEY&keep=1',
      request: {
        method: 'POST', url: 'http://127.0.0.1:3000/api?access_token=SECRETTOKEN&page=2&Code=SECRETCODE#id_token=SECRETFRAG',
        headers: { Cookie: 'sid=SECRETCOOKIE', Authorization: 'Bearer SECRETBEARER', 'Proxy-Authorization': 'Basic SECRETPROXY', Referer: 'http://127.0.0.1:3000/?key=SECRETREF', Accept: '*/*' },
        postData: 'password=SECRETBODY',
      },
    }),
    ev('Network.responseReceived', { requestId: 'r1', response: { status: 201, url: 'http://127.0.0.1:3000/api?access_token=SECRETTOKEN', headers: { 'Set-Cookie': 'sid=SECRETSETCOOKIE; HttpOnly', Location: '/cb?code=SECRETLOCATION&ok=1', 'content-type': 'text/plain' } } }),
    ev('Network.requestWillBeSent', { requestId: 'w1', request: { method: 'GET', url: 'http://127.0.0.1:8100/favicon.ico', headers: {} } }), // WebDriverAgent's own
    ev('Network.responseReceived', { requestId: 'w1', response: { status: 404 } }),
    ev('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'GET', url: 'http://127.0.0.1:3000/favicon.ico', headers: {} } }),
    ev('Network.loadingFinished', { requestId: 'r2' }),
    { level: 'DEBUG', timestamp: 3, message: 'Cookie: sid=SECRETRAW\nGET http://127.0.0.1:3000/x?token=SECRETRAW' },
  ];
  const out = await safari.network();
  const everything = fs.readFileSync(out.file, 'utf8') + JSON.stringify(out);
  for (const secret of SECRETS) assert.ok(!everything.includes(secret), `${secret} leaked`);
  assert.match(everything, /\[redacted\]/);
  assert.match(everything, /page=2/); // the rest is intact
  assert.match(everything, /keep=1/);
  assert.match(everything, /image\/|text\/plain/);
  assert.equal(out.count, 5);
  assert.equal(out.dropped, 2);
  assert.ok(!everything.includes(':8100'));
  assert.match(everything, /ok=1/);
  assert.deepEqual(out.requests, [
    { method: 'POST', url: 'http://127.0.0.1:3000/api?access_token=[redacted]&page=2&Code=[redacted]#id_token=[redacted]', status: 201 },
    { method: 'GET', url: 'http://127.0.0.1:3000/favicon.ico', status: null },
  ]);
  assert.deepEqual(posts('/se/log')[0][2], { type: 'safariNetwork' });
  const saved = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  assert.equal(saved[0].event.request.headers.Cookie, '[redacted]');
  assert.equal(saved[0].event.request.headers.Accept, '*/*');
  assert.equal('postData' in saved[0].event.request, false);
  assert.equal(path.dirname(out.file), loadState().run);
});

test('network events repeated once per context switch collapse to one request', () => {
  const trio = [
    ev('Network.requestWillBeSent', { requestId: '0.56', request: { method: 'GET', url: 'http://127.0.0.1:3000/a?id=1', headers: {} } }),
    ev('Network.responseReceived', { requestId: '0.56', response: { status: 200 } }),
    ev('Network.loadingFinished', { requestId: '0.56' }),
  ];
  const out = parseNetwork(Array.from({ length: 23 }, () => trio).flat());
  assert.equal(out.events.length, 3);
  assert.deepEqual(out.requests, [{ method: 'GET', url: 'http://127.0.0.1:3000/a?id=1', status: 200 }]);
  assert.equal(out.dropped, 66);
  assert.equal(out.copies, 23);
  assert.equal(out.full, false);
});

// 3 copies of each of N distinct messages, N * 3 raw entries.
const copiesOf = (n, make) => Array.from({ length: n }, (_, i) => make(i)).flatMap(e => [e, e, e]);

test('parseConsole and parseNetwork say when the raw log reached Appium\'s cap, and how many copies there are', () => {
  assert.equal(LOG_CAP, 5000);
  const consoleAt = n => parseConsole(Array.from({ length: n }, (_, i) => entry('log', `m${i}`, undefined, 1, i)));
  assert.equal(consoleAt(LOG_CAP - 1).full, false);
  assert.equal(consoleAt(LOG_CAP).full, true);
  const netAt = n => parseNetwork(Array.from({ length: n }, (_, i) => ev('Network.loadingFinished', { requestId: String(i) })));
  assert.equal(netAt(LOG_CAP - 1).full, false);
  assert.equal(netAt(LOG_CAP).full, true);

  const c = parseConsole(copiesOf(10, i => entry('error', `m${i}`, undefined, 1, i)));
  assert.deepEqual([c.entries.length, c.dropped, c.copies], [10, 20, 3]); // three listeners
  const n = parseNetwork(copiesOf(10, i => ev('Network.loadingFinished', { requestId: String(i) })));
  assert.deepEqual([n.events.length, n.dropped, n.copies], [10, 20, 3]);
});

test('console and network add truncated and a note only when the buffer filled', async () => {
  await start();
  fx.consoleLog = [entry('error', 'A'), entry('error', 'A'), entry('error', 'A')];
  fx.networkLog = copiesOf(2, i => ev('Network.loadingFinished', { requestId: String(i) }));
  for (const out of [await safari.console(), await safari.network()]) {
    assert.ok(!('truncated' in out) && !('note' in out) && !('copies' in out) && !('full' in out), JSON.stringify(out));
  }

  fx.consoleLog = Array.from({ length: LOG_CAP }, (_, i) => entry('log', `m${i % 1700}`, undefined, 1, i % 1700)); // about 3 copies each
  fx.networkLog = Array.from({ length: LOG_CAP }, (_, i) => ev('Network.loadingFinished', { requestId: String(i % 1700) }));
  const c = await safari.console();
  assert.equal(c.truncated, true);
  assert.equal(c.copies, 3);
  assert.match(c.note, /^Appium's 5000-entry buffer filled, so earlier entries may have been lost\. Read \`safari console\` more often, or restart the session \(\`safari stop\` then \`safari start\`\)\.$/);
  const n = await safari.network();
  assert.equal(n.truncated, true);
  assert.equal(n.copies, 3);
  assert.match(n.note, /\`safari network\` more often/);
  assert.equal(n.count, 1700);
});

test('redact masks secret keys and query parameters, case-insensitively, at any depth', () => {
  const names = ['token', 'access_token', 'id_token', 'key', 'apikey', 'api_key', 'password', 'passwd', 'secret', 'signature', 'sig', 'code', 'session', 'auth'];
  for (const n of names) {
    for (const name of [n, n.toUpperCase()]) {
      assert.equal(redactUrl(`https://h/p?a=1&${name}=V&b=2`), `https://h/p?a=1&${name}=[redacted]&b=2`, name);
      assert.equal(redactUrl(`https://h/p?${name}=V`), `https://h/p?${name}=[redacted]`, name);
    }
  }
  assert.equal(redactUrl('https://h/p?tokens=1&keyboard=2&q=code'), 'https://h/p?tokens=1&keyboard=2&q=code'); // exact names only
  assert.equal(redactUrl('https://h/p#access_token=V&state=1'), 'https://h/p#access_token=[redacted]&state=1');
  const out = redact({
    a: [{ Headers: { 'SET-COOKIE': 'x', cookie: 'y', Authorization: 'z', 'proxy-authorization': 'w', ok: 'fine' }, postData: 'body' }],
    documentURL: 'http://h/?password=pw', location: '/cb?code=c&x=1', rel: 'cb?token=t', note: 'see http://h/?token=t', pairs: [{ name: 'Cookie', value: 'v' }, { name: 'Accept', value: 'a' }],
  });
  assert.deepEqual(out, {
    a: [{ Headers: { 'SET-COOKIE': '[redacted]', cookie: '[redacted]', Authorization: '[redacted]', 'proxy-authorization': '[redacted]', ok: 'fine' } }],
    documentURL: 'http://h/?password=[redacted]', location: '/cb?code=[redacted]&x=1', rel: 'cb?token=[redacted]', note: 'see http://h/?token=t', pairs: [{ name: 'Cookie', value: '[redacted]' }, { name: 'Accept', value: 'a' }],
  });
  assert.deepEqual(redact(null), null);
  assert.deepEqual(redact(5), 5);
});

test('parseNetwork redacts raw lines and tolerates events with missing fields', () => {
  const { events, requests } = parseNetwork([
    { message: 'Set-Cookie: a=SECRETRAW; Path=/' },
    { message: '{"postData":"SECRETBODY","Authorization":"SECRETBEARER"}' },
    ev('Network.requestWillBeSent', { requestId: 'r1' }),
    ev('Network.responseReceived', { requestId: 'r1', response: {} }),
    ev('Network.requestWillBeSent', {}),
    { message: '{}' },
  ]);
  const text = JSON.stringify(events);
  for (const secret of ['SECRETRAW', 'SECRETBODY', 'SECRETBEARER']) assert.ok(!text.includes(secret));
  assert.deepEqual(requests, [{ method: null, url: null, status: null }]);
  assert.deepEqual(parseNetwork(undefined), { events: [], requests: [], dropped: 0, full: false, copies: 0 });

  // The raw protocol spelling (`params`) is accepted too.
  const raw = parseNetwork([{ message: JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: '9', request: { method: 'PUT', url: 'http://h/x?sig=S' } } }) }]);
  assert.deepEqual(raw.requests, [{ method: 'PUT', url: 'http://h/x?sig=[redacted]', status: null }]);
});

// --- native commands ---

const taps = () => posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: tap');
const probesGone = () => assert.equal(fx.probeLabel, null, 'the calibration probe was left in the page');

test('tap calibrates against a probe, taps the mapped point, and cleans up', async () => {
  await start();
  const out = await safari.tap(['input']);
  // Safari 27: 48pt top inset, scale 1: (100, 200) in the page is (100, 248) on screen.
  assert.deepEqual(out, {
    tapped: 'input', x: 100, y: 248,
    page: { x: 0, y: 48, width: 414, height: 750 },
    calibration: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
  });
  assert.deepEqual(taps()[0][2].args, [{ x: 100, y: 248 }]);
  probesGone();
  assert.equal(fx.probesInserted, 1);
  assert.equal(fx.context, 'WEBVIEW_1.1');
  assert.equal(posts('/context').length, 0); // the session never left the page
  const probeCall = posts('/execute/sync').find(([, , b]) => b.script.includes('createElement'));
  assert.match(probeCall[2].args[0], /^msl-probe-[0-9a-f]{12}$/);
  for (const part of ['position:fixed', 'width:100px', 'height:100px', 'pointer-events:none', 'opacity:0', 'role', 'img', 'aria-label']) {
    assert.ok(probeCall[2].script.includes(part), part);
  }
  assert.ok(fx.probeCss.includes('left:0px;top:0px'), 'without visualViewport the probe is at (0, 0)');
  // One lean tree read from the web context gives the probe, the screen and Safari's controls.
  const sources = posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source');
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0][2].args, [{ format: 'xml', excludedAttributes: 'value,name,enabled,accessible,index,hittable,placeholderValue,traits,nativeFrame,focused' }]);
  assert.deepEqual(predicates(), []);
  assert.equal(log.filter(([, u]) => u.endsWith('/window/rect') || /\/element\/\w+\/rect$/.test(u)).length, 0);
  await assert.rejects(safari.tap([]), /usage/);
});

test('tap scales and offsets by what the probe measures', async () => {
  await start();
  fx.probe = { x: 10, y: 20, width: 200, height: 200 }; // a 2x screen, page origin at (10, 20)
  const out = await safari.tap(['input']);
  assert.deepEqual([out.x, out.y], [210, 420]); // 10 + 100 * 2, 20 + 200 * 2
  assert.deepEqual(out.page, { x: 10, y: 20, width: 828, height: 1500 });
  probesGone();
});

// What each page script was, in order, for the tap tests (native calls by name).
const kindOf = b => b.script.startsWith('mobile:') ? b.script
  : b.script.includes('createElement') ? 'probe'
  : b.script.includes('p.remove()') ? 'remove'
  : b.script.includes('scrollIntoView') ? 'scroll'
  : b.script.includes('elementFromPoint') ? 'measure'
  : b.script.includes('field ? seen.includes(el)') ? 'focus' : 'other';
const tapKinds = () => posts('/execute/sync').map(([, , b]) => kindOf(b)).filter(k => k !== 'other');

test('tap measures the element in the very script that places the probe, and again right before the touch', async () => {
  await start();
  await safari.tap(['input']);
  assert.deepEqual(tapKinds(), ['scroll', 'measure', 'probe', 'mobile: source', 'measure', 'mobile: tap', 'remove', 'focus']);
  const probe = posts('/execute/sync').find(([, , b]) => kindOf(b) === 'probe')[2];
  assert.equal(probe.args.length, 2); // the label, and the element the script measures
  assert.ok(probe.script.indexOf('getBoundingClientRect') < probe.script.lastIndexOf('elementFromPoint'));
  const scroll = posts('/execute/sync').find(([, , b]) => kindOf(b) === 'scroll')[2].script;
  assert.match(scroll, /behavior: 'instant'/);
  assert.doesNotMatch(scroll, /smooth/);
});

test('tap waits out an element that is still moving, and taps where it came to rest', async () => {
  await start();
  // The first two readings (before the probe, and in the probe\'s script) disagree: the page was scrolling.
  fx.geometryFor = n => ({ ...fx.geometry, cy: n <= 2 ? 200 + n * 10 : 200, rect: { x: 80, y: n <= 2 ? 190 + n * 10 : 190, width: 40, height: 20 } });
  const out = await safari.tap(['input']);
  assert.deepEqual([out.x, out.y], [100, 248]);
  assert.equal(taps().length, 1);
  assert.equal(fx.probesInserted, 2); // the first probe was placed, found stale, and removed
  probesGone();

  // The third reading, right before the touch, is what catches a move during the tree read.
  fx.probesInserted = 0;
  fx.measures = 0;
  fx.geometryFor = n => ({ ...fx.geometry, cy: n === 3 ? 260 : 200, rect: { x: 80, y: n === 3 ? 250 : 190, width: 40, height: 20 } });
  assert.deepEqual([(await safari.tap(['input'])).y], [248]);
  assert.equal(taps().length, 2);
  assert.deepEqual(taps().map(t => t[2].args[0].y), [248, 248]); // never the stale 308
  assert.equal(fx.probesInserted, 2);
  probesGone();
});

test('tap refuses, sending no touch, when the element never holds still', async () => {
  await start();
  fx.geometryFor = n => ({ ...fx.geometry, cy: 200 + n * 10, rect: { x: 80, y: 190 + n * 10, width: 40, height: 20 } });
  await assert.rejects(safari.tap(['input']), /input kept moving.*no tap was sent/);
  assert.equal(taps().length, 0);
  assert.equal(fx.probesInserted, WAIT.stableTries);
  probesGone();
  // A move of a pixel or less is not a move.
  fx.geometryFor = n => ({ ...fx.geometry, rect: { x: 80, y: 190 + (n % 2) * 0.5, width: 40, height: 20 } });
  assert.equal((await safari.tap(['input'])).tapped, 'input');
});

test('tap says whether a text field took the focus, and says nothing for other elements', async () => {
  await start();
  assert.equal('focused' in await safari.tap(['input']), false); // not a text field
  fx.tapFocus = true;
  assert.equal((await safari.tap(['input'])).focused, true);
  fx.tapFocus = false;
  assert.equal((await safari.tap(['input'])).focused, false);
});

test('tap still taps an invisible element, with a warning that says why and not a word more', async () => {
  await start();
  fx.tapFocus = false;
  fx.geometry = { ...fx.geometry, hidden: 'hidden (opacity 0, 1x1 px)' };
  const out = await safari.tap(['input[aria-label="Type your answer"]']);
  assert.equal(out.warning, 'input[aria-label="Type your answer"] is hidden (opacity 0, 1x1 px); the tap probably focused nothing');
  assert.equal(out.focused, false);
  assert.equal(taps().length, 1); // warn only
  // A normal element: no warning.
  fx.geometry = { ...fx.geometry, hidden: null };
  assert.equal('warning' in await safari.tap(['input']), false);
  // Text the page made up is not passed on.
  for (const odd of ['see https://evil.example/?k=SECRET', 'hidden (see evil.example)', 'hidden (opacity 0, evil)']) {
    fx.geometry = { ...fx.geometry, hidden: odd };
    assert.equal('warning' in await safari.tap(['input']), false, odd);
  }
  assert.equal(taps().length, 5);
});

// A page zoomed to 2x, scrolled so the probe is placed at (100, 300) from the visual viewport's
// offsets, yet its client rect is at (0, 0), as measured live; the native tree reports it at
// the visible corner, its size rounded.
const zoomed = (extra = {}, probeRect = { left: 0, top: 0 }) => ({ innerWidth: 414, innerHeight: 750, probeRect, visualViewport: { scale: 2, width: 207, height: 375, offsetLeft: 100, offsetTop: 300, ...extra } });

test('tap on a zoomed page maps from the probe\'s client rect, not from where it was placed', async () => {
  await start();
  fx.page = zoomed();
  fx.probe = { x: 0, y: 62, width: 200, height: 201 };
  fx.geometry = { ...fx.geometry, cx: 50, cy: 200 };
  const out = await safari.tap(['input']);
  // 0 + (50 - 0) * 2 and 62 + (200 - 0) * 2: not 62 + (200 - 300) * 2, which is off screen
  assert.deepEqual(out, {
    tapped: 'input', x: 100, y: 462,
    page: { x: 0, y: 62, width: 414, height: 750 },
    calibration: { x: 0, y: 62, scaleX: 2, scaleY: 2, scaleFrom: 'visualViewport' },
  });
  assert.equal(out.calibration.scaleFrom, 'visualViewport');
  assert.deepEqual(taps()[0][2].args, [{ x: 100, y: 462 }]);
  assert.ok(fx.probeCss.includes('position:fixed;left:100px;top:300px;'), fx.probeCss);
  probesGone();
});

test('tap still maps from the probe\'s client rect when the visual viewport\'s scale is unusable', async () => {
  await start();
  fx.page = zoomed({ scale: 0, offsetTop: NaN }, { left: 20, top: 10 }); // placed at (100, 0)
  fx.probe = { x: 0, y: 62, width: 200, height: 200 };
  fx.geometry = { ...fx.geometry, cx: 150, cy: 100 };
  const out = await safari.tap(['input']);
  assert.ok(fx.probeCss.includes('left:100px;top:0px'), fx.probeCss);
  assert.deepEqual([out.x, out.y], [260, 242]); // 0 + (150 - 20) * 2, 62 + (100 - 10) * 2
  assert.equal(out.calibration.scaleFrom, undefined);
  probesGone();
});

test('tap takes the scale from the visual viewport, not from the rounded probe size', async () => {
  await start();
  fx.page = { innerWidth: 980, innerHeight: 1670, visualViewport: { scale: 0.449, width: 922, height: 1670, offsetLeft: 0, offsetTop: 0 } };
  fx.probe = { x: 0, y: 48, width: 45, height: 46 }; // 0.449 * 100 rounded to whole points
  fx.geometry = { ...fx.geometry, cx: 500, cy: 800 };
  const out = await safari.tap(['input']);
  assert.deepEqual([out.x, out.y], [224.5, 407.2]); // the rounded probe would give 225, 413.6
  assert.deepEqual([out.calibration.scaleX, out.calibration.scaleY], [0.449, 0.449]);
  assert.deepEqual(out.page, { x: 0, y: 48, width: 414, height: 749.8 });
});

test('tap and swipe refuse when the calibration probe is off the screen, and still remove the probe', async () => {
  await start();
  fx.page = zoomed();
  for (const probe of [{ x: -100, y: -300 }, { x: 0, y: -1 }, { x: 414, y: 62 }, { x: 0, y: 896 }]) {
    fx.probe = { ...probe, width: 200, height: 201 };
    await assert.rejects(safari.tap(['input']), /couldn't place the page on screen.*414x896 screen/);
    await assert.rejects(safari.swipe(['up']), /couldn't place the page on screen/);
    probesGone();
  }
  assert.equal(taps().length, 0);
  assert.equal(posts('/actions').length, 0);
  assert.equal(fx.context, 'WEBVIEW_1.1');
});

test('tap refuses when the screen size is not known', async () => {
  await start();
  fx.screen = {};
  await assert.rejects(safari.tap(['input']), /no screen size/);
  assert.equal(taps().length, 0);
  probesGone();
});

test('tap refuses when the probe cannot be found, and still removes it', async () => {
  await start();
  fx.probeMissing = true;
  WAIT.probeMs = 50;
  await assert.rejects(safari.tap(['input']), /couldn't locate the page on screen/);
  assert.equal(taps().length, 0);
  probesGone();
  assert.equal(fx.context, 'WEBVIEW_1.1');
});

test('tap refuses a covered element, a point outside the page, and a point on Safari\'s controls', async () => {
  await start();
  fx.geometry.covered = 'div';
  await assert.rejects(safari.tap(['input']), /covered by <div>/);
  assert.equal(fx.probesInserted, 0); // refused before touching the native layer
  assert.equal(taps().length, 0);

  fx.probe = { x: 10, y: 20, width: 200, height: 200 };
  fx.geometry = { ...fx.geometry, covered: null, cx: 500 }; // x = 10 + 500 * 2 = 1010, right of the page
  await assert.rejects(safari.tap(['input']), /outside Safari's page area/);
  probesGone();

  fx.geometry = { ...fx.geometry, cx: 100, cy: 365 }; // y = 20 + 365 * 2 = 750: under the toolbar
  await assert.rejects(safari.tap(['input']), /on Safari's toolbar or address bar/);
  assert.equal(taps().length, 0);
  probesGone(); // even after a refusal
  assert.equal(fx.context, 'WEBVIEW_1.1');
});

test('the chrome guard fails closed when there are too many controls to check', async () => {
  await start();
  fx.chrome = Array.from({ length: 51 }, (_, i) => `X${i}`);
  fx.rects = Object.fromEntries(fx.chrome.map(id => [id, { x: 0, y: 900, width: 1, height: 1 }]));
  await assert.rejects(safari.tap(['input']), /too many matches/);
  assert.equal(taps().length, 0);
  probesGone();
});

// --- text, nth and shadow selectors; tap --label ---

const executesOf = pred => posts('/execute/sync').filter(([, , b]) => pred(b.script)).map(([, , b]) => b);
const resolves = () => executesOf(s => s.endsWith('return pick(arguments[0]);'));
const counts = () => executesOf(s => s.includes('const found = scanSel(arguments[0]);'));
const lookups = () => posts('/elements');

test('click by text counts in the page, resolves an element reference and clicks it the WebDriver way', async () => {
  await start();
  fx.selectCount = { count: 1, hosts: 0, rooted: 0, step: -1, over: 0 };
  const out = await safari.click(['button', '--text', 'Continue']);
  assert.deepEqual(out, { clicked: 'button text="Continue"', matches: 1 });
  assert.equal(lookups().length, 0, 'no /elements lookup for a text selector');
  assert.deepEqual(counts().map(b => b.args), [[{ css: 'button', text: 'Continue' }]]);
  assert.deepEqual(resolves().map(b => b.args), [[{ css: 'button', text: 'Continue', nth: 1 }]]); // the nth is settled
  assert.equal(posts('/element/E1/click').length, 1);
  // Plain CSS is untouched: /elements, no count, no resolve, the same route.
  log.length = 0;
  assert.deepEqual(await safari.click(['.tile']), { clicked: '.tile', matches: 1 });
  assert.equal(lookups().length, 1);
  assert.equal(counts().length + resolves().length, 0);
  assert.equal(posts('/element/E1/click').length, 1);
});

test('click and type with --nth and --shadow send the selector as a plain argument and report what they matched', async () => {
  await start();
  fx.selectCount = { count: 3, hosts: 0, rooted: 0, step: -1, over: 0 };
  assert.deepEqual(await safari.click(['li', '--nth', '3']), { clicked: 'li #3', matches: 3 });
  assert.deepEqual(resolves().at(-1).args, [{ css: 'li', nth: 3 }]);
  fx.selectCount = { count: 1, hosts: 0, rooted: 0, step: -1, over: 0 };
  assert.deepEqual(await safari.click(['--shadow', 'x-app', 'x-card', 'button']), { clicked: 'x-app >> x-card >> button', matches: 1 });
  assert.deepEqual(resolves().at(-1).args, [{ css: 'button', shadow: ['x-app', 'x-card'], nth: 1 }]);
  // Text with the shadow chain, and --contains.
  await safari.click(['--shadow', 'x-app', '*', '--text', 'Buy', '--contains']);
  assert.deepEqual(resolves().at(-1).args, [{ css: '*', text: 'Buy', contains: true, shadow: ['x-app'], nth: 1 }]);
  assert.equal(lookups().length, 0);
});

test('type behaves the same for a plain and a text selector: keystrokes through the element value route', async () => {
  await start();
  assert.deepEqual(await safari.type(['input', 'cats']), { typed: 4, into: 'input' });
  const plain = posts('/element/E1/value').at(-1);
  assert.deepEqual(plain[2], { text: 'cats' });
  assert.deepEqual(await safari.type(['input', '--text', 'Email', 'cats']), { typed: 4, into: 'input text="Email"', matches: 1 });
  const smart = posts('/element/E1/value').at(-1);
  assert.deepEqual(smart[2], plain[2]);
  assert.equal(smart[1], plain[1], 'the same route');
  assert.equal(posts('/element/E1/value').length, 2);
  // No script sets the field's value directly on the simulator.
  assert.deepEqual(executesOf(s => /Object\.getOwnPropertyDescriptor|dispatchEvent/.test(s)), []);
  // With --text and no css the only argument is the text.
  assert.deepEqual(await safari.type(['--text', 'Email', 'a@b.test']), { typed: 8, into: 'text="Email"', matches: 1 });
  assert.deepEqual(resolves().at(-1).args, [{ text: 'Email', nth: 1 }]);
  assert.equal(posts('/element/E1/value').at(-1)[2].text, 'a@b.test');
  // The text may start with --.
  assert.deepEqual(await safari.type(['input', '--x']), { typed: 3, into: 'input' });
});

test('a selector that names too many, too few or nothing is refused with counts and the agent\'s own words, and nothing is clicked', async () => {
  await start();
  const count = (n, extra = {}) => { fx.selectCount = { count: n, hosts: 0, rooted: 0, step: -1, over: 0, ...extra }; };
  const clicks = () => posts('/element/E1/click').length + posts('/element/E1/value').length;
  count(3);
  await assert.rejects(safari.click(['button', '--text', 'OK']), err => err.message === '3 elements match text "OK" (button); add --nth 1..3');
  await assert.rejects(safari.tap(['--text', 'OK']), err => err.message === '3 elements match text "OK"; add --nth 1..3');
  await assert.rejects(safari.type(['--text', 'OK', 'hi']), /3 elements match text "OK"; add --nth 1\.\.3/);
  count(0);
  await assert.rejects(safari.click(['button', '--text', 'Zed']), err => err.message === 'no element matches text "Zed" (button)');
  await assert.rejects(safari.click(['li', '--nth', '2']), err => err.message === 'no element matches li #2');
  count(3);
  await assert.rejects(safari.click(['li', '--nth', '9']), err => err.message === '--nth 9 but only 3 match');
  await assert.rejects(safari.click(['--text', 'OK', '--nth', '4']), err => err.message === '--nth 4 but only 3 match');
  count(3);
  await safari.click(['li']); // plain CSS with several matches keeps the first-match behaviour
  assert.equal(clicks(), 1);
  await safari.click(['li', '--nth', '2']); // css and nth only: no ambiguity refusal
  count(2);
  await safari.click(['--shadow', 'x-a', 'li']); // shadow without text: the first match, as plain CSS does
  assert.equal(clicks(), 3);
  count(0, { step: 0, hosts: 1, rooted: 0 });
  await assert.rejects(safari.click(['--shadow', 'x-app', 'button']), err => err.message === 'host "x-app" has no open shadow root (none, or a closed one, which can\'t be entered); try tap --label');
  count(0, { step: 1, hosts: 0, rooted: 0 });
  await assert.rejects(safari.click(['--shadow', 'x-app', 'x-gone', 'button']), err => err.message === 'no element matches host "x-gone"');
  count(0, { over: 1 });
  await assert.rejects(safari.click(['--text', 'OK']), /more than 5000 elements to search for text "OK"; give a css selector to narrow it/);
  for (const bogus of [null, 'x', { count: '1', hosts: 0, rooted: 0, step: -1, over: 0 }, { count: 1.5, hosts: 0, rooted: 0, step: -1, over: 0 }, { count: -1, hosts: 0, rooted: 0, step: -1, over: 0 }, { count: 1, hosts: 0, rooted: 0, step: 5, over: 0 }]) {
    fx.selectCount = bogus;
    await assert.rejects(safari.click(['--text', 'OK']), /answer the lab does not understand/, JSON.stringify(bogus));
  }
  assert.equal(clicks(), 3);
  fx.selectCount = { count: 1, hosts: 0, rooted: 0, step: -1, over: 0 };
  fx.resolveNone = true;
  await assert.rejects(safari.click(['--text', 'OK']), /no element matches text="OK"/);
  assert.equal(clicks(), 3);
});

test('a bad argument is refused before the session is asked anything', async () => {
  await start();
  log.length = 0;
  for (const [cmd, argv] of [['click', []], ['click', ['a', '--contains']], ['click', ['a', '--nth', '0']], ['tap', ['a', 'b']], ['tap', ['--label', 'x', 'a']], ['type', ['--text', 'x']], ['click', ['a', '--shadow']], ['tap', ['a', '--bogus']]]) {
    await assert.rejects(safari[cmd](argv), /usage: safari/, `${cmd} ${argv}`);
  }
  assert.deepEqual(log, []);
});

test('tap by text finds the element in every script by its selector, on the simulator as on the phone', async () => {
  await start();
  fx.selectCount = { count: 3, hosts: 0, rooted: 0, step: -1, over: 0 };
  const out = await safari.tap(['button', '--text', 'OK', '--nth', '2']);
  assert.deepEqual(out, {
    tapped: 'button text="OK" #2', matches: 3, x: 100, y: 248,
    page: { x: 0, y: 48, width: 414, height: 750 },
    calibration: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
  });
  const sel = { css: 'button', text: 'OK', nth: 2 };
  assert.deepEqual(tapKinds(), ['scroll', 'measure', 'probe', 'mobile: source', 'measure', 'mobile: tap', 'remove', 'focus']);
  for (const kind of ['scroll', 'measure', 'focus']) {
    const b = posts('/execute/sync').find(([, , x]) => kindOf(x) === kind)[2];
    assert.deepEqual(b.args, [sel], kind);
    assert.match(b.script, /pick\(arguments\[0\]\)/, kind);
  }
  const probe = posts('/execute/sync').find(([, , b]) => kindOf(b) === 'probe')[2];
  assert.deepEqual(probe.args.slice(1), [sel]);
  assert.match(probe.script, /pick\(arguments\[1\]\)/);
  assert.equal(lookups().length, 0);
  assert.equal(posts('/element/E1/click').length, 0, 'a tap is a touch, not a click');
  probesGone();
  // Plain CSS: the same scripts, with the selector as the argument (no element reference any more).
  log.length = 0;
  await safari.tap(['input']);
  assert.deepEqual(tapKinds(), ['scroll', 'measure', 'probe', 'mobile: source', 'measure', 'mobile: tap', 'remove', 'focus']);
  for (const [, , b] of posts('/execute/sync').filter(([, , x]) => ['scroll', 'measure', 'focus'].includes(kindOf(x)))) assert.deepEqual(b.args, ['input']);
  assert.equal(lookups().length, 1);
  assert.equal(counts().length, 0);
});

test('tap by text refuses a covered or invisible match like any tap, naming it as the agent did', async () => {
  await start();
  fx.geometry.covered = 'div';
  await assert.rejects(safari.tap(['--text', 'OK']), err => err.message === 'text="OK" is covered by <div>; a tap would hit that instead');
  assert.equal(taps().length, 0);
  fx.geometry = { ...fx.geometry, covered: null, hidden: 'hidden (opacity 0)' };
  const out = await safari.tap(['--shadow', 'x-app', 'button']);
  assert.equal(out.warning, 'x-app >> button is hidden (opacity 0); the tap probably focused nothing');
  assert.equal(taps().length, 1);
});

// The page's own native nodes for `tap --label`.
const labelled = (...nodes) => { fx.webView = nodes; };

test('tap --label taps the centre of the one native element with exactly that label, inside the web view only', async () => {
  await start();
  labelled({ label: 'Share', x: 100, y: 300, width: 60, height: 40 }, { label: 'Share this', x: 10, y: 400, width: 60, height: 40 }, { label: 'A & B', x: 200, y: 400, width: 20, height: 10 });
  const out = await safari.tap(['--label', 'Share']);
  assert.deepEqual(out, {
    tapped: 'label "Share"', via: 'label', x: 130, y: 320,
    page: { x: 0, y: 48, width: 414, height: 750 },
    calibration: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
  });
  assert.deepEqual(taps().map(t => t[2].args), [[{ x: 130, y: 320 }]]);
  assert.deepEqual(tapKinds(), ['probe', 'mobile: source', 'mobile: tap', 'remove']); // one tree read; no scroll, no measuring
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source').length, 1);
  assert.equal(lookups().length + counts().length + resolves().length, 0);
  probesGone();
  assert.equal((await safari.tap(['--label', 'A & B'])).x, 210); // entities are decoded
  // Safari's own controls in the tree are outside the web view and never candidates.
  for (const outside of ['Safari', 'Reload & stop', ' ']) {
    const before = taps().length;
    await assert.rejects(safari.tap(['--label', outside]), err => err.message === `0 elements are labelled ${JSON.stringify(outside)}; run \`safari ui\` to see the labels in the web view`, outside);
    assert.equal(taps().length, before);
  }
  probesGone();
});

test('tap --label refuses none or several, a label that is only part of one, and an element with no usable rectangle', async () => {
  await start();
  labelled(
    { label: 'Share', x: 100, y: 300, width: 60, height: 40 }, { label: 'Share', x: 100, y: 400, width: 60, height: 40 },
    { label: 'Flat', x: 100, y: 300, width: 0, height: 40 }, { label: 'Nan', x: 'n/a', y: 300, width: 10, height: 10 });
  await assert.rejects(safari.tap(['--label', 'Share']), err => err.message === '2 elements are labelled "Share"; run `safari ui` to see the labels in the web view');
  await assert.rejects(safari.tap(['--label', 'Shar']), /^Error: 0 elements are labelled "Shar"/);
  await assert.rejects(safari.tap(['--label', 'share']), /0 elements are labelled/);
  await assert.rejects(safari.tap(['--label', 'Flat']), /0 elements are labelled/);
  await assert.rejects(safari.tap(['--label', 'Nan']), /0 elements are labelled/);
  assert.equal(taps().length, 0);
  probesGone();
  // No web view in the tree: nothing to look in.
  fx.webView = null;
  await assert.rejects(safari.tap(['--label', 'Share']), /0 web views/);
  assert.equal(taps().length, 0);
});

test('tap --label goes through the same guard as every tap: Safari\'s controls and points outside the page are refused', async () => {
  await start();
  labelled({ label: 'Bar', x: 20, y: 760, width: 60, height: 20 }, { label: 'Far', x: 20, y: 840, width: 60, height: 20 }, { label: 'Top', x: 20, y: 5, width: 60, height: 20 });
  await assert.rejects(safari.tap(['--label', 'Bar']), /on Safari's toolbar or address bar/); // inside C1 (0, 750, 400, 50)
  await assert.rejects(safari.tap(['--label', 'Far']), /the element labelled "Far" is outside the visible page \(50, 850\); scroll with `safari swipe`/);
  await assert.rejects(safari.tap(['--label', 'Top']), /outside the visible page/);
  assert.equal(taps().length, 0);
  probesGone();
});

test('tap --label never matches the calibration probe, even a node of the web view that carries its label', async () => {
  await start();
  // The probe's label is random; fix it so the test can ask for it.
  mock.method(crypto, 'randomBytes', () => Buffer.from('aabbccddeeff', 'hex'));
  syncBuiltinESMExports();
  try {
    labelled({ label: 'msl-probe-aabbccddeeff', x: 20, y: 300, width: 60, height: 20 });
    await assert.rejects(safari.tap(['--label', 'msl-probe-aabbccddeeff']), /^Error: 0 elements are labelled/);
    assert.equal(taps().length, 0);
    probesGone();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('tap --label refuses a node of Safari\'s own controls even inside the web view', async () => {
  await start();
  labelled({ label: 'TabBarItemTitle', x: 20, y: 300, width: 60, height: 20 }, { label: 'Address', x: 20, y: 340, width: 60, height: 20 });
  await assert.rejects(safari.tap(['--label', 'TabBarItemTitle']), /0 elements are labelled/);
  await assert.rejects(safari.tap(['--label', 'Address']), /0 elements are labelled/);
  assert.equal(taps().length, 0);
});

test('keys refuses when no page field is focused, and otherwise types one string per character', async () => {
  await start();
  fx.focused = false;
  await assert.rejects(safari.keys(['hello']), /no page field is focused: run `safari tap <css>` on it first/);
  assert.ok(!posts('/context').some(([, , b]) => b.name === 'NATIVE_APP'));
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: keys').length, 0);

  fx.focused = true;
  const out = await safari.keys(['Hi \u{1F600}\n']);
  assert.deepEqual(out, { keyed: 5, textChecked: false, textSkip: 'newline' });
  const keys = posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: keys');
  assert.deepEqual(keys.map(k => k[2].args), [['H'], ['i'], [' '], ['\u{1F600}'], ['\n']].map(k => [{ keys: k }])); // one call per character
  assert.equal(posts('/context').length, 0); // typing never leaves the page
  await assert.rejects(safari.keys([]), /usage/);
  await assert.rejects(safari.keys(['x'.repeat(501)]), /500/);
});

test('keys sends characters one per mobile: keys call and Backspace by tapping the delete key, looked up once per run', async () => {
  await start();
  const out = await safari.keys(['ab\b\bc']);
  assert.equal(out.keyed, 5);
  // Only the native-layer calls, in order: the tree is read for the delete key once, on the first Backspace.
  const seq = posts('/execute/sync').filter(([, , b]) => ['mobile: keys', 'mobile: source', 'mobile: tap'].includes(b.script))
    .map(([, , b]) => (b.script === 'mobile: keys' ? b.args[0].keys.join('') : b.script === 'mobile: source' ? 'lookup' : 'tap'));
  assert.deepEqual(seq, ['a', 'b', 'lookup', 'tap', 'tap', 'c']);
  const { x, y } = centre(fx.deleteKeyRect);
  assert.deepEqual(taps().map(t => t[2].args), [[{ x, y }], [{ x, y }]]); // the key's centre, in points
  assert.equal(deleteClicks(), 2);
  const lookup = posts('/execute/sync').find(([, , b]) => b.script === 'mobile: source')[2];
  assert.deepEqual(lookup.args, [{ format: 'xml', excludedAttributes: 'value,name,enabled,accessible,index,hittable,placeholderValue,traits,nativeFrame,focused' }]);
  assert.deepEqual(predicates(), []);
  assert.equal(posts('/context').length, 0); // Backspace never leaves the page
  assert.ok(!posts('/execute/sync').some(([, , b]) => b.script === 'mobile: keys' && b.args[0].keys.includes('\b')));

  // A new run looks the key up again: the keyboard may have moved between commands.
  await safari.keys(['\b']);
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source').length, 2);
});

test('keys refuses a Backspace when the delete key is not on screen', async () => {
  await start();
  fx.deleteKey = false;
  await assert.rejects(safari.keys(['\b']), /delete key isn't on screen/);
  assert.equal(fx.context, 'WEBVIEW_1.1');
  fx.deleteKey = true;
  fx.deleteKeyRect = { x: 'n/a', y: 340, width: 60, height: 40 };
  await assert.rejects(safari.keys(['\b']), /delete key without a rectangle/);
  assert.equal(taps().length, 0);
  fx.deleteKeyRect = { x: 340, y: 790, width: 60, height: 40 };
  fx.focused = false;
  await assert.rejects(safari.keys(['\b']), /no page field is focused/); // the focus check still comes first
});

test('keys does not tap the remembered delete key once the keyboard is gone', async () => {
  await start();
  fx.field.value = 'abc';
  fx.keyboard = [true, false]; // up for the wait (the first Backspace reads the tree instead), down at the second's check
  await assert.rejects(safari.keys(['\b\b']), /delete key isn't on screen \(is the keyboard shown\?\)/);
  assert.equal(deleteClicks(), 1); // the first one only
  assert.equal(fx.field.value, 'ab');
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source').length, 1); // not looked up again
});

test('keys waits for the keyboard to appear', async () => {
  await start();
  fx.keyboard = [false, false, true];
  const out = await safari.keys(['a']);
  assert.equal(out.keyed, 1);
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: isKeyboardShown').length, 3);
});

test('keys pauses between characters', async () => {
  await start();
  WAIT.charGapMs = 60;
  const t = Date.now();
  await safari.keys(['abcd']);
  assert.ok(Date.now() - t >= 170, 'three gaps of 60 ms'); // none after the last character
});

test('keys always lets the keyboard settle before the first character, and refuses if it never appears', async () => {
  await start();
  WAIT.settleMs = 150;
  const t = Date.now();
  await safari.keys(['a']); // the keyboard was already up on the first check
  assert.ok(Date.now() - t >= 140, 'typed before the keyboard settled');

  fx.keyboard = [false];
  const before = posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: keys').length;
  await assert.rejects(safari.keys(['a']), /keyboard didn't appear.*safari tap/);
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: keys').length, before); // nothing typed
  assert.equal(fx.context, 'WEBVIEW_1.1');
});

test('keys types into the simulator\'s field though document.hasFocus() is false, and still needs the keyboard', async () => {
  await start();
  assert.equal(fx.hasFocus, false); // the Simulator window is not frontmost
  assert.deepEqual(await safari.keys(['hi']), { keyed: 2, textChecked: true });
  assert.equal(fx.field.value, 'hi');

  fx.keyboard = [false]; // an active element alone is not enough
  await assert.rejects(safari.keys(['a']), /the keyboard didn't appear within \d+s/);
  assert.equal(fx.field.value, 'hi');

  fx.keyboard = [true];
  fx.focused = false; // no active field: refused whatever hasFocus says
  fx.hasFocus = true;
  await assert.rejects(safari.keys(['a']), /no page field is focused/);
});

// --- keys: each character is checked to have landed ---

const sentKeys = () => posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: keys').map(([, , b]) => b.args[0].keys[0]);
const deleteClicks = () => taps().filter(([, , b]) => b.args[0].x === centre(fx.deleteKeyRect).x && b.args[0].y === centre(fx.deleteKeyRect).y).length;
const markerGone = () => {
  const { window, listeners } = fx.field;
  assert.equal(window.__mslKeysField, undefined, 'the keys marker was left in the page');
  assert.equal(window.__mslKeysEv, undefined, 'the event counters were left in the page');
  assert.equal(window.__mslKeysOn, undefined, 'the event listener was left in the page');
  assert.deepEqual(Object.values(listeners).flat(), [], 'a listener was left on the document');
};

test('keys waits for a slow read of the field (up to readMs, past callMs) and sends each character once', async () => {
  await start();
  WAIT.callMs = 30;
  WAIT.readMs = 1000;
  fx.readDelayMs = 100; // longer than callMs: Safari's Web Inspector stalled
  assert.deepEqual(await safari.keys(['ab']), { keyed: 2, textChecked: true });
  assert.deepEqual(sentKeys(), ['a', 'b']); // never sent again because a read was slow
  assert.equal(fx.field.value, 'ab');
});

test('a read of the field that is never answered says Appium is busy, not unreachable, and sends nothing again', async () => {
  await start();
  WAIT.readMs = 80;
  fx.readHang = true;
  await assert.rejects(safari.keys(['ab']), err => {
    assert.match(err.message, /^WebDriver POST \/session\/S1\/execute\/sync got no answer in 0\.1s \(Appium at http:\/\/127\.0\.0\.1:\d+ may be busy or stuck; check `lab status`\)$/);
    assert.doesNotMatch(err.message, /not reachable|safari start/);
    return true;
  });
  assert.deepEqual(sentKeys(), []); // the first read, before any character, is what stalled
  markerGone();
});

test('keys checks the field after each character without leaving the page', async () => {
  await start();
  const out = await safari.keys(['Hi \u{1F600}!']);
  assert.deepEqual(out, { keyed: 5, textChecked: true });
  assert.equal(fx.field.value, 'Hi \u{1F600}!');
  assert.deepEqual(sentKeys(), ['H', 'i', ' ', '\u{1F600}', '!']);
  // Every switch adds a console and network listener to Appium for good: none here.
  assert.equal(posts('/context').length, 0);
  assert.equal(log.filter(([m, u]) => m === 'GET' && u.endsWith('/contexts')).length, 0);
  assert.equal(fx.context, 'WEBVIEW_1.1');
  markerGone();
  const forgets = posts('/execute/sync').filter(([, , b]) => b.script.startsWith('delete window.__mslKeysField'));
  assert.equal(forgets.length, 2); // before the first read, and after the last
});

test('keys never leaves the page, Backspace included: nothing but the tree read and a tap', async () => {
  await start();
  assert.deepEqual(await safari.keys(['a\bb']), { keyed: 3, textChecked: false, textSkip: 'backspace' });
  assert.equal(fx.field.value, 'b');
  assert.equal(posts('/context').length, 0);
  assert.equal(fx.context, 'WEBVIEW_1.1');
  assert.equal(deleteClicks(), 1);
  assert.equal(log.filter(([, u]) => u.endsWith('/elements') || /\/element\/\w+\/click$/.test(u)).length, 0);
  markerGone();
});

test('keys sends a character again when it did not land, and does not double it', async () => {
  await start();
  fx.field.drops = 1;
  const out = await safari.keys(['ab']);
  assert.deepEqual(out, { keyed: 2, retries: 1, textChecked: true });
  assert.equal(fx.field.value, 'ab');
  assert.deepEqual(sentKeys(), ['a', 'a', 'b']);
  markerGone();
});

test('keys fails after three attempts naming the character and index, and sends nothing after it', async () => {
  await start();
  fx.field.reject = /b/;
  await assert.rejects(safari.keys(['abc']), err => {
    assert.match(err.message, /^keys: character #2 did not land after 3 attempts; 1 character was typed before it\. The page may reject it/);
    assert.match(err.message, /--no-verify/);
    assert.ok(!err.message.includes('abc'), 'never echoes more than what was sent');
    return true;
  });
  assert.deepEqual(sentKeys(), ['a', 'b', 'b', 'b']);
  assert.equal(fx.context, 'WEBVIEW_1.1');
  markerGone();
});

test('keys waits out a press that arrives late and does not send it again', async () => {
  await start();
  WAIT.landMs = 600;
  fx.field.lagPresses = 1;
  fx.field.lagMs = 60; // far past the test window of the other tests (30 ms), far inside this one
  const out = await safari.keys(['a']);
  assert.deepEqual(out, { keyed: 1, textChecked: true });
  assert.deepEqual(sentKeys(), ['a']);
  assert.equal(fx.field.value, 'a');
  markerGone();
});

test('keys sends again after the whole window and the re-check, and fails when the late press then doubles it', async () => {
  await start();
  WAIT.landMs = 20;
  fx.field.lagPresses = 1;
  fx.field.lagMs = Infinity; // never inside the window or the re-check: shows up only when it is sent again
  await assert.rejects(safari.keys(['ab']), err => {
    assert.match(err.message, /^keys: character #1 was typed more than once/);
    assert.ok(!/\bok\b/.test(err.message) && !err.message.includes('aa'), 'does not echo the field');
    return true;
  });
  assert.deepEqual(sentKeys(), ['a', 'a']); // nothing after it
  assert.equal(fx.context, 'WEBVIEW_1.1');
  markerGone();
});

test('keys types over a selection once: the first character replaces it', async () => {
  await start();
  fx.field.value = 'abcde';
  fx.field.sel = [0, 5]; // the page selected everything on focus
  const out = await safari.keys(['hello']);
  assert.deepEqual(out, { keyed: 5, textChecked: false, textSkip: 'caret' });
  assert.equal(fx.field.value, 'hello');
  assert.deepEqual(sentKeys(), ['h', 'e', 'l', 'l', 'o']);

  fx.field.value = 'a';
  fx.field.sel = [0, 1]; // same length after: the caret moving is the change
  assert.deepEqual(await safari.keys(['b']), { keyed: 1, textChecked: false, textSkip: 'caret' });
  assert.equal(fx.field.value, 'b');
  assert.deepEqual(sentKeys().slice(5), ['b']);
});

test('keys does not send again over a selection, and counts it unverified when nothing changed', async () => {
  await start();
  fx.field.value = 'abc';
  fx.field.sel = [0, 3];
  fx.field.reject = /h/;
  const out = await safari.keys(['h']);
  assert.deepEqual(out, { keyed: 1, unverified: 1, textChecked: false, textSkip: 'unverified' });
  assert.deepEqual(sentKeys(), ['h']);
  assert.equal(fx.field.value, 'abc');
});

test('keys sees a selection in a contenteditable too', async () => {
  await start();
  fx.field.active = fx.field.contentEditable;
  fx.field.value = 'abcde';
  fx.field.sel = [0, 5];
  assert.deepEqual(await safari.keys(['hi']), { keyed: 2, textChecked: false, textSkip: 'contenteditable' });
  assert.equal(fx.field.value, 'hi');
  assert.deepEqual(sentKeys(), ['h', 'i']);
});

test('keys clears a marker a killed run left behind, before its first read', async () => {
  await start();
  fx.field.window.__mslKeysField = {}; // stale: not the focused field
  assert.deepEqual(await safari.keys(['ab']), { keyed: 2, textChecked: true }); // checked, not unverified
  const forgets = posts('/execute/sync').filter(([, , b]) => b.script.startsWith('delete window.__mslKeysField'));
  assert.equal(forgets.length, 2);
  assert.ok(log.indexOf(forgets[0]) < log.findIndex(([, , b]) => b && b.script && b.script.includes('window.__mslKeysField = a')));
  markerGone();
});

test('keys verifies Backspace by the field getting shorter', async () => {
  await start();
  fx.field.value = 'abc';
  fx.field.deleteDrops = 1;
  const out = await safari.keys(['\b']);
  assert.deepEqual(out, { keyed: 1, retries: 1, textChecked: false, textSkip: 'backspace' });
  assert.equal(fx.field.value, 'ab');
  assert.equal(deleteClicks(), 2);

  fx.field.deleteAlways = true;
  await assert.rejects(safari.keys(['\b']), err => {
    assert.ok(err.message.startsWith('keys: character #1 did not land after 3 attempts'), err.message);
    return true;
  });
  assert.equal(deleteClicks(), 5);
  assert.equal(fx.context, 'WEBVIEW_1.1');
});

test('keys presses Backspace once in an empty field and does not count it', async () => {
  await start();
  const out = await safari.keys(['\b']);
  assert.deepEqual(out, { keyed: 1, textChecked: false, textSkip: 'backspace' });
  assert.equal(deleteClicks(), 1);
});

test('keys presses Backspace once, uncounted, with the caret at the start of a field', async () => {
  await start();
  fx.field.value = 'abc';
  fx.field.sel = [0, 0];
  const out = await safari.keys(['\b']);
  assert.deepEqual(out, { keyed: 1, textChecked: false, textSkip: 'backspace' });
  assert.equal(deleteClicks(), 1);
  assert.equal(fx.field.value, 'abc');
});

test('keys sends once, and reports unverified, where a character cannot change the field', async () => {
  await start();
  fx.field.max = 3;
  const out = await safari.keys(['abcde']);
  assert.deepEqual(out, { keyed: 5, unverified: 2, textChecked: false, textSkip: 'unverified' }); // d and e: the field is full
  assert.equal(fx.field.value, 'abc');
  assert.deepEqual(sentKeys(), ['a', 'b', 'c', 'd', 'e']);
});

test('keys fails at a character a filtering field refuses', async () => {
  await start();
  fx.field.reject = /[a-z]/;
  await assert.rejects(safari.keys(['12x']), /character #3 did not land after 3 attempts; 2 characters were typed before it/);
  assert.equal(fx.field.value, '12');
});

// A field that rewrites its own text after every key (the length never changes) but fires the events.
test('keys counts a character that only fired events as landed: sent once, byEvent and unverified', async () => {
  await start();
  Object.assign(fx.field, { value: '  ', resetTo: '  ', fireEvents: true });
  assert.deepEqual(await safari.keys(['zqx']), { keyed: 3, unverified: 3, byEvent: 3, textChecked: false, textSkip: 'unverified' });
  assert.deepEqual(sentKeys(), ['z', 'q', 'x']); // exactly one press each
  markerGone();
});

test('keys presses Backspace once each in a field that rewrites itself, events counted', async () => {
  await start();
  Object.assign(fx.field, { value: '  ', resetTo: '  ', fireEvents: true });
  assert.deepEqual(await safari.keys(['\b\b\b\b\b']), { keyed: 5, unverified: 5, byEvent: 5, textChecked: false, textSkip: 'backspace' });
  assert.equal(deleteClicks(), 5);
  markerGone();
});

test('keys does not send again for an input event alone, whatever the length does', async () => {
  await start();
  Object.assign(fx.field, { value: 'ab', resetTo: 'ab', fireEvents: { types: ['input'] } });
  assert.deepEqual(await safari.keys(['x']), { keyed: 1, unverified: 1, byEvent: 1, textChecked: false, textSkip: 'unverified' });
  assert.deepEqual(sentKeys(), ['x']);
  markerGone();
});

// A press that is dropped but still fires its events (a page that swallows the key): the events must not
// count as the character landing once the field has been seen to change, and a field that ends up short fails.
test('keys sends a dropped press again though it fired its events, once the field has changed: exact, one retry, text compared', async () => {
  await start();
  Object.assign(fx.field, { fireEvents: true, dropsFire: [2] });
  assert.deepEqual(await safari.keys(['abc']), { keyed: 3, retries: 1, textChecked: true });
  assert.equal(fx.field.value, 'abc');
  assert.deepEqual(sentKeys(), ['a', 'b', 'b', 'c']);
  markerGone();
});

test('keys fails when the first press was dropped with its events and the rest landed: the field is short, and its text is not shown', async () => {
  await start();
  Object.assign(fx.field, { fireEvents: true, dropsFire: [1] });
  const e = await failing(safari.keys(['CANARY']));
  assert.match(e.message, /^keys: the field is 1 character short of what was sent \(expected \+6, got \+5\); a keypress was probably dropped\. Check the field and clear it/);
  assert.doesNotMatch(e.message, /CANARY|ANARY/);
  assert.equal(fx.field.value, 'ANARY');
  markerGone();
});

test('keys checks lengths in a field whose text is never read, short fails and long is a warning', async () => {
  await start();
  Object.assign(fx.field, { fireEvents: true, dropsFire: [1] });
  fx.field.active.type = 'password';
  await assert.rejects(safari.keys(['abc']), /the field is 1 character short of what was sent \(expected \+3, got \+2\)/);
  fx.field.value = '';
  fx.field.dropsFire = [];
  fx.field.onType = () => { fx.field.value += '-'; }; // a page that formats what is typed
  assert.deepEqual(await safari.keys(['abc']), { keyed: 3, textChecked: false, textSkip: 'password', warning: 'the field grew by 6 characters, 3 were sent: the page may format input' });
  markerGone();
});

test('keys fails a readable field the page reformats: the text comparison catches it, and the message holds no typed text', async () => {
  await start();
  fx.field.onType = () => { fx.field.value += '-'; }; // a page that formats what is typed
  const e = await failing(safari.keys(['qzjxk']));
  assert.match(e.message, /^keys: the keyboard or the page changed the text/);
  assert.doesNotMatch(e.message, /qzjxk|qz/i);
  markerGone();
});

test('keys counts a changed text of the same length as landed, without byEvent', async () => {
  await start();
  fx.field.value = 'aa';
  fx.field.onType = () => { fx.field.value = fx.field.value.slice(1); }; // the page drops its first character
  fx.field.active.type = 'password'; // its text is rewritten on purpose here: the landing is what is under test, not the text
  assert.deepEqual(await safari.keys(['qz']), { keyed: 2, textChecked: false, textSkip: 'password' });
  assert.deepEqual(sentKeys(), ['q', 'z']);
  assert.equal(fx.field.value, 'qz');
  markerGone();
});

test('keys waits for the text when the events come first, so a late change is not taken for the next character', async () => {
  await start();
  WAIT.landMs = 600;
  // 'a': events at once, the text 200 ms later; the next key press is lost.
  Object.assign(fx.field, { fireEvents: true, lagMs: 200, lagPresses: 1 });
  fx.field.onType = () => { fx.field.drops = 1; fx.field.onType = null; };
  const out = await safari.keys(['ab']);
  assert.equal(fx.field.value, 'ab'); // never ok with the wrong text
  assert.deepEqual(out, { keyed: 2, retries: 1, textChecked: true });
  assert.deepEqual(sentKeys(), ['a', 'b', 'b']);
  markerGone();
});

test('keys over a selection waits for the text when the events come first, so a late change is not taken for the next character', async () => {
  await start();
  WAIT.landMs = 600;
  Object.assign(fx.field, { value: 'abcde', resetTo: 'abcde', fireEvents: true, sel: [0, 5] });
  fx.field.onType = () => {
    fx.field.sel = [0, 5]; // the page keeps the selection ...
    setTimeout(() => { fx.field.value = 'hbcde'; }, 200); // ... and shows the replacement later, same length
    fx.field.drops = 1; // the next key press is lost
    fx.field.onType = null;
  };
  const out = await safari.keys(['hi']);
  assert.deepEqual(out, { keyed: 2, unverified: 1, textChecked: false, textSkip: 'unverified' }); // 'h' landed (by its text); 'i' did not, and is not claimed with h's late change
  assert.deepEqual(sentKeys(), ['h', 'i']);
  markerGone();
});

test('keys: a self-resetting field is still counted by event, each key sent once, after the window', async () => {
  await start();
  WAIT.landMs = 60;
  Object.assign(fx.field, { value: '  ', resetTo: '  ', fireEvents: true });
  const t = Date.now();
  assert.deepEqual(await safari.keys(['zq']), { keyed: 2, unverified: 2, byEvent: 2, textChecked: false, textSkip: 'unverified' });
  assert.deepEqual(sentKeys(), ['z', 'q']);
  assert.ok(Date.now() - t >= 100, 'each character waited out the window for its text');
});

test('keys ignores events from another element, and still fails when nothing changed', async () => {
  await start();
  Object.assign(fx.field, { value: '  ', resetTo: '  ', fireEvents: { target: { tagName: 'INPUT' } } });
  await assert.rejects(safari.keys(['zq']), /character #1 did not land after 3 attempts/);
  assert.deepEqual(sentKeys(), ['z', 'z', 'z']);
  markerGone(); // also after a failure
});

test('keys fails as before when the field neither changes nor fires, even if it rewrites itself', async () => {
  await start();
  Object.assign(fx.field, { value: '  ', resetTo: '  ' });
  await assert.rejects(safari.keys(['z']), /character #1 did not land after 3 attempts/);
  markerGone();
});

test('keys over a selection that only fires events is sent once, byEvent and unverified', async () => {
  await start();
  Object.assign(fx.field, { value: 'abcde', resetTo: 'abcde', fireEvents: true, sel: [0, 5] });
  fx.field.onType = () => { fx.field.sel = [0, 5]; }; // the page keeps the selection
  assert.deepEqual(await safari.keys(['hi']), { keyed: 2, unverified: 2, byEvent: 2, textChecked: false, textSkip: 'caret' });
  assert.deepEqual(sentKeys(), ['h', 'i']);
  markerGone();
});

test('keys counts events from inside a contenteditable, not from outside it', async () => {
  await start();
  fx.field.active = fx.field.contentEditable;
  Object.assign(fx.field, { value: 'abc', resetTo: 'abc', fireEvents: { target: fx.field.child } });
  assert.deepEqual(await safari.keys(['z']), { keyed: 1, unverified: 1, byEvent: 1, textChecked: false, textSkip: 'contenteditable' });
  fx.field.fireEvents = { target: {} };
  await assert.rejects(safari.keys(['z']), /did not land after 3 attempts/);
  markerGone();
});

test('keys --no-verify installs no listeners', async () => {
  await start();
  Object.assign(fx.field, { value: '  ', resetTo: '  ', fireEvents: true });
  assert.deepEqual(await safari.keys(['--no-verify', 'ab']), { keyed: 2, verified: false, textChecked: false, textSkip: 'no-verify' });
  assert.deepEqual(Object.values(fx.field.listeners).flat(), []);
  markerGone();
});

test('keys sends once, and reports unverified, once focus has left the field it started in', async () => {
  await start();
  const other = { tagName: 'INPUT', isContentEditable: false, value: '', maxLength: -1, selectionStart: 0, selectionEnd: 0 };
  fx.field.onType = () => { fx.field.active = other; fx.field.onType = null; }; // focus moves on after the first character
  assert.deepEqual(await safari.keys(['ab']), { keyed: 2, unverified: 2, textChecked: false, textSkip: 'unverified' });
  assert.deepEqual(sentKeys(), ['a', 'b']);

  fx.focusedEl = { tagName: 'INPUT' }; // a field is focused when the run starts ...
  fx.field.active = null; // ... and nothing is by the time of its first read (the page blurred it)
  assert.deepEqual(await safari.keys(['c']), { keyed: 1, unverified: 1, textChecked: false, textSkip: 'unreadable' });
  assert.deepEqual(sentKeys(), ['a', 'b', 'c']);
});

test('keys does not check Return, which may submit or navigate', async () => {
  await start();
  const out = await safari.keys(['a\nb']);
  assert.deepEqual(out, { keyed: 3, textChecked: false, textSkip: 'newline' });
  assert.deepEqual(sentKeys(), ['a', '\n', 'b']);
  assert.equal(fx.field.value, 'ab');
});

test('keys finds the page again when its context id changed during the run', async () => {
  await start();
  fx.field.onType = () => { fx.webviews = ['WEBVIEW_2.1']; fx.field.onType = null; };
  assert.deepEqual(await safari.keys(['ab']), { keyed: 2, textChecked: true });
  assert.equal(fx.field.value, 'ab');
  assert.deepEqual(posts('/context').map(([, , b]) => b.name), ['WEBVIEW_2.1']); // found again by pageCmd, no detour through native
  assert.equal(fx.context, 'WEBVIEW_2.1');
});

test('keys --no-verify sends each character once and checks nothing in the page', async () => {
  await start();
  fx.field.always = true; // every key press is lost
  const out = await safari.keys(['--no-verify', 'ab\b']);
  assert.deepEqual(out, { keyed: 3, verified: false, textChecked: false, textSkip: 'no-verify' });
  assert.deepEqual(sentKeys(), ['a', 'b']);
  assert.equal(deleteClicks(), 1);
  assert.equal(fx.field.reads, 0);
  assert.equal(posts('/context').length, 0); // not even for Backspace
  assert.ok(!posts('/execute/sync').some(([, , b]) => b.script.includes('__mslKeysField')));
  assert.deepEqual(await safari.keys(['c', '--no-verify']), { keyed: 1, verified: false, textChecked: false, textSkip: 'no-verify' }); // anywhere
});

test('keys refuses an unknown flag before doing anything, and -- ends the flags', async () => {
  await start();
  const before = log.length;
  await assert.rejects(safari.keys(['--bogus', 'x']), /keys: argument #1 starts with -- and is not --no-verify.*usage: safari keys \[--no-verify\]/);
  await assert.rejects(safari.keys(['--no-verify']), /usage: safari keys/);
  assert.equal(log.length, before);
  assert.deepEqual(await safari.keys(['--', '--no-verify']), { keyed: 11, textChecked: true }); // typed as text
  assert.equal(fx.field.value, '--no-verify');
});

test('the keyboard check still runs before any character is checked', async () => {
  await start();
  fx.keyboard = [false];
  await assert.rejects(safari.keys(['a']), /keyboard didn't appear/);
  assert.equal(fx.field.reads, 0);
  assert.equal(fx.context, 'WEBVIEW_1.1');
});

// --- the idle wait ---

const settingsPosts = () => posts('/appium/settings');

test('stderr warnings redact urls and mask device ids', async () => {
  fx.settingsFail = 'refused for 00008000-000A1B2C3D4E5F60 at http://h/cb?code=SECRETCODE';
  const err = console.error;
  const notes = [];
  console.error = m => notes.push(m);
  try { await start(); } finally { console.error = err; }
  assert.equal(notes.length, 1);
  assert.match(notes[0], /couldn't turn off Appium's idle wait/);
  assert.doesNotMatch(notes[0], /00008000-000A1B2C3D4E5F60|SECRETCODE/);
  assert.match(notes[0], /…5F60/);
});

test('start turns off Appium\'s idle wait after creating a session, and again on a reused one', async () => {
  await start();
  assert.equal(settingsPosts().length, 1);
  assert.deepEqual(settingsPosts()[0][2], { settings: { waitForIdleTimeout: 0 } });
  assert.deepEqual(fx.settings, { waitForIdleTimeout: 0 });
  const iCreate = log.findIndex(([m, u]) => m === 'POST' && u === '/session');
  assert.ok(log.findIndex(([m, u]) => m === 'POST' && u.endsWith('/appium/settings')) > iCreate);

  fx.settings = null;
  assert.equal((await start()).reused, true);
  assert.equal(settingsPosts().length, 2);
  assert.deepEqual(fx.settings, { waitForIdleTimeout: 0 });
  assert.equal(log.filter(([m, u]) => m === 'POST' && u === '/session').length, 1);
});

test('start sets it on a session recorded before this existed', async () => {
  saveState({ backend: 'appium', session: 'S1', port: 4723, target: { simulator: U }, injected: [] });
  const out = await start();
  assert.equal(out.reused, true);
  assert.deepEqual(fx.settings, { waitForIdleTimeout: 0 });
});

test('a failure to set it warns and still starts', async () => {
  fx.settingsFail = true;
  const errors = [];
  const err0 = console.error;
  console.error = l => errors.push(l);
  let out;
  try { out = await start(); } finally { console.error = err0; }
  assert.equal(out.session, 'S1');
  assert.equal(loadState().session, 'S1');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /idle wait.*settings refused/);
});

test('tap and swipe pause for the page to settle', async () => {
  await start();
  WAIT.tapSettleMs = 80;
  let t = Date.now();
  await safari.tap(['input']);
  assert.ok(Date.now() - t >= 75, 'tap returned before the page settled');
  WAIT.tapSettleMs = 5;
  WAIT.swipeSettleMs = 80;
  t = Date.now();
  await safari.swipe(['up']);
  assert.ok(Date.now() - t >= 75, 'swipe returned before the page settled');
});

test('swipe on a zoomed page starts and ends inside the visible area', async () => {
  await start();
  fx.page = zoomed();
  fx.probe = { x: 0, y: 62, width: 200, height: 201 };
  const out = await safari.swipe(['down']);
  // visible area (0, 62, 414, 750): 30% = 287, 70% = 587
  assert.deepEqual(out, { swiped: 'down', from: { x: 207, y: 287 }, to: { x: 207, y: 587 } });
  assert.equal(posts('/actions').length, 1);
  probesGone();
});

test('swipe drags across the calibrated page area and releases the pointer', async () => {
  await start();
  const up = await safari.swipe(['up']);
  // page area (0, 48, 414, 750): centre x 207, 70% = 573, 30% = 273
  assert.deepEqual(up, { swiped: 'up', from: { x: 207, y: 573 }, to: { x: 207, y: 273 } });
  const [, , body] = posts('/actions')[0];
  assert.equal(body.actions.length, 1);
  const finger = body.actions[0];
  assert.equal(finger.type, 'pointer');
  assert.equal(finger.parameters.pointerType, 'touch');
  assert.deepEqual(finger.actions.map(a => a.type), ['pointerMove', 'pointerDown', 'pause', 'pointerMove', 'pointerUp']);
  assert.deepEqual([finger.actions[0].x, finger.actions[0].y, finger.actions[3].x, finger.actions[3].y], [207, 573, 207, 273]);
  assert.equal(finger.actions[3].duration, 400);
  assert.ok(log.some(([m, u]) => m === 'DELETE' && u === '/session/S1/actions'));
  assert.equal(posts('/context').length, 0);
  probesGone();

  const down = await safari.swipe(['down']);
  assert.deepEqual([down.from.y, down.to.y], [273, 573]);
  assert.ok(!posts('/execute/sync').some(([, , b]) => /swipe/.test(b.script))); // never mobile: swipe
  await assert.rejects(safari.swipe(['left']), /usage/);

  fx.rects.C1 = { x: 0, y: 500, width: 400, height: 200 }; // a toolbar over the start point
  await assert.rejects(safari.swipe(['up']), /on Safari's toolbar/);
  assert.equal(posts('/actions').length, 2);
  probesGone();

  fx.rects.C1 = { x: 0, y: 750, width: 400, height: 50 };
  fx.probeMissing = true;
  WAIT.probeMs = 50;
  await assert.rejects(safari.swipe(['up']), /couldn't locate the page on screen/);
  assert.equal(posts('/actions').length, 2);
  probesGone();
});

test('a control of Safari\'s with no usable rectangle fails the chrome guard closed', async () => {
  await start();
  fx.chrome = ['NORECT']; // in the tree, but its x, y, width and height are not numbers
  await assert.rejects(safari.tap(['input']), /element without a rectangle/);
  await assert.rejects(safari.swipe(['up']), /element without a rectangle/);
  assert.equal(taps().length, 0);
  assert.equal(posts('/actions').length, 0);
  probesGone();
});

test('a text field in the page is not one of Safari\'s controls', async () => {
  await start();
  fx.geometry = { ...fx.geometry, cx: 100, cy: 272 }; // screen (100, 320): inside the page field at (20, 300, 200x40)
  assert.deepEqual([(await safari.tap(['input'])).x, taps()[0][2].args[0].y], [100, 320]);
});

test('server error text is redacted in the printed JSON, run.log, artifacts and stderr', async () => {
  await start();
  const printed = [], errors = [];
  const [log0, err0] = [console.log, console.error];
  console.log = l => printed.push(l);
  console.error = l => errors.push(l);
  try {
    assert.equal(await cli(safari, ['eval', 'throw-secret()'], { onError: failureArtifacts }), 1);
    fx.deleteError = 'could not end https://h/s?session=SECRETSTOP&y=2';
    await safari.stop();
  } finally { console.log = log0; console.error = err0; }
  const out = JSON.parse(printed[0]);
  assert.equal(out.ok, false);
  assert.match(out.error, /code=\[redacted\]&x=1/);
  const logText = fs.readFileSync(path.join(loadState().run, 'run.log'), 'utf8');
  assert.match(logText, /safari eval FAILED:.*code=\[redacted\]/);
  assert.ok(!printed.join('') .includes('SECRET'));
  assert.ok(!logText.includes('SECRET'));
  assert.match(errors.join('\n'), /ending the session.*session=\[redacted\]&y=2/);
  assert.ok(!errors.join('\n').includes('SECRET'));
});

test('open to the URL the page is already on returns once it is loaded instead of waiting for a new document', async () => {
  await start();
  await safari.open(['http://127.0.0.1:3000/page#sec']);
  fx.freeze = true; // no new document will come
  const t = CLOCK.now();
  const out = await safari.open(['http://127.0.0.1:3000/page#sec']);
  assert.equal(out.url, 'http://127.0.0.1:3000/page#sec');
  assert.ok(CLOCK.now() - t <= WAIT.pollMs, 'returned on the first look, not after the load deadline');
  fx.doc.ready = 'loading';
  await assert.rejects(safari.open(['http://127.0.0.1:3000/page#sec']), /didn't finish loading/); // URL matches but not complete
});

test('run.log and failure messages carry no query secrets', async () => {
  await start();
  const opened = await safari.open(['http://127.0.0.1:3000/cb?code=SECRETCODE&ok=1']);
  assert.equal(opened.url, 'http://127.0.0.1:3000/cb?code=[redacted]&ok=1'); // the printed url too
  assert.equal((await safari.url()).url, opened.url);
  assert.equal((await safari.refresh([])).url, opened.url);
  const script = path.join(path.dirname(loadState().run), 'bad.user.js');
  fs.writeFileSync(script, '// THROWSECRET\n');
  const thrown = await safari.inject([script]).catch(e => e);
  assert.ok(!thrown.message.includes('SECRET')); // the script's own error text, from the page
  fx.freeze = true;
  const err = await safari.open(['http://127.0.0.1:3000/x?token=SECRETTOKEN']).catch(e => e);
  assert.ok(!err.message.includes('SECRET'));
  const { failureArtifacts } = await import('../lib/safari.js');
  await failureArtifacts('open', err);
  const logText = fs.readFileSync(path.join(loadState().run, 'run.log'), 'utf8');
  assert.ok(!logText.includes('SECRET'));
  assert.match(logText, /safari inject .*threw: Error: failed at http:\/\/h\/x\?code=\[redacted\]&z=1/);
  assert.match(logText, /safari open http:\/\/127\.0\.0\.1:3000\/cb\?code=\[redacted\]&ok=1/);
});

test('ui saves the full native tree and lists its distinct labels', async () => {
  await start();
  fx.deleteKey = false; // keyboard down
  const out = await safari.ui();
  assert.deepEqual(out.labels, ['Safari', 'Reload & stop']);
  assert.match(out.file, /ui\.xml$/);
  const xml = fs.readFileSync(out.file, 'utf8');
  assert.match(xml, /XCUIElementTypeApplication/);
  assert.match(xml, /enabled="true"/); // the full form, not the lean one
  assert.deepEqual(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source').map(([, , b]) => b.args), [[{ format: 'xml' }]]);
  assert.equal(posts('/context').length, 0);
  fx.source = '<html/>';
  await assert.rejects(safari.ui(), /Appium returned no UI source/);
  fx.source = null;
  await assert.rejects(safari.ui(), /Appium returned no UI source/);
});

test('ui waits up to sourceMs for the full tree; the lean reads of tap give up at treeMs (#98)', async () => {
  await start();
  WAIT.treeMs = 150;
  WAIT.sourceMs = 1000;
  fx.sourceDelayMs = 300; // longer than treeMs
  assert.ok((await safari.ui()).labels.length > 0);
  await assert.rejects(safari.tap(['input']), /^Error: Safari's screen layout \(its UI tree\) did not come back within 0\.\d+s; a heavy page makes it slow\./);
  probesGone();
});

test('tap, swipe, ui, keys with Backspace and a failure\'s artifacts never switch context', async () => {
  await start();
  await safari.tap(['input']);
  await safari.swipe(['up']);
  await safari.swipe(['down']);
  await safari.ui();
  fx.field.value = 'abc';
  assert.deepEqual(await safari.keys(['x\b\by']), { keyed: 4, textChecked: false, textSkip: 'backspace' });
  assert.equal(fx.field.value, 'aby');
  fx.geometry.covered = 'div';
  await assert.rejects(safari.tap(['input']), /covered/);
  await failureArtifacts('tap', new Error('boom'));
  assert.equal(posts('/context').length, 0);
  assert.equal(log.filter(([m, u]) => m === 'GET' && u.endsWith('/contexts')).length, 0);
  assert.equal(fx.context, 'WEBVIEW_1.1');
  assert.deepEqual(predicates(), []);
  // One lean tree per tap or swipe, one full one for ui, one for the delete key in the run.
  const sources = posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source');
  assert.equal(sources.length, 1 + 2 + 1 + 1);
});

// --- the page commands in the web context ---

test('click, type, source, shot, url and eval run in the web context', async () => {
  await start();
  fx.context = 'NATIVE_APP';
  assert.deepEqual(await safari.click(['.tile']), { clicked: '.tile', matches: 1 });
  await safari.type(['input', 'cats']);
  assert.ok(posts('/element/E1/value').length === 1);
  assert.match(fs.readFileSync((await safari.source([])).file, 'utf8'), /hi/);
  assert.match((await safari.shot(['tile'])).file, /tile\.png$/);
  const named = (await safari.shot(['tile.png'])).file;
  assert.match(named, /tile-2\.png$/, 'a name that ends in .png is not given a second .png');
  assert.equal(path.dirname(named), loadState().run);
  const outside = path.join(process.env.MSL_RUNS, '..', 'mc.png');
  const refused = await failing(safari.shot([outside]));
  assert.match(refused.message, /is a path.*Pass just the name/);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.readdirSync(loadState().run).some(f => /mc/.test(f)), false, 'nothing under a made-up name either');
  assert.equal((await safari.url()).title, 'Example');
});

const THENABLES = [
  ['a Promise', 'Promise.resolve(1)', 1],
  ['a fetch-like thenable', '({ then(ok) { ok({ status: 200 }); } })', { status: 200 }],
  ['a Promise from a statement body', 'const p = Promise.resolve(1); return p', 1],
  ['a Promise that settles later', 'new Promise(r => setTimeout(() => r("late"), 30))', 'late'],
  ['a Promise of undefined', 'Promise.resolve()', null],
];
const NOT_THENABLES = [
  ['a plain object', '({ a: 1 })', { a: 1 }],
  ['an object whose then is not a function', '({ then: 1 })', { then: 1 }],
  ['null', 'null', null],
  ['a number', '1 + 1', 2],
];

// eval awaits Promises and other thenables, reports how long, and fails with a reason for one that
// rejects, never settles, or whose page went away.
async function evalAwaits() {
  for (const [what, js, value] of THENABLES) {
    const out = await safari.eval([js]);
    assert.deepEqual([out.value, out.awaited, Number.isInteger(out.awaitedMs)], [value, true, true], what);
  }
  for (const [what, js, value] of NOT_THENABLES) assert.deepEqual(await safari.eval([js]), { value }, what);
  assert.match((await failing(safari.eval(['Promise.reject(new Error("nope"))']))).message, /^the Promise rejected: nope$/);
  const never = await failing(safari.eval(['Object.assign(() => 1, { then() {} })', '--timeout', '150']));
  assert.match(never.message, /^timed out after 150 ms waiting for the Promise to settle/);
  assert.equal(never.extra?.awaited, undefined, 'a failure does not say awaited');
  assert.deepEqual(Object.keys(globalThis.__mslThenable ?? {}), [], 'a timed-out Promise\'s slot is dropped; settled ones were dropped on read');
  assert.match((await failing(safari.eval(['Promise.reject({ code: 7 })']))).message, /^the Promise rejected: \{"code":7\}$/, 'an object reason is readable');
  assert.equal((await failing(safari.eval(['Promise.reject("x".repeat(2000))']))).message, `the Promise rejected: ${'x'.repeat(500)}`, 'a reason is cut at 500 characters');
  const gone = await failing(safari.eval(['const p = new Promise(() => {}); setTimeout(() => { delete globalThis.__mslThenable; }, 20); return p']));
  assert.match(gone.message, /page changed while eval waited/);
  for (const bad of [['1', '--timeout', '5'], ['1', '--timeout'], ['1', '--wait', '100'], ['1', '2']]) {
    assert.match((await failing(safari.eval(bad))).message, /--timeout must be|usage: safari eval/, bad.join(' '));
  }
}

test('eval awaits a Promise or another thenable, on the simulator', async () => {
  await start();
  await evalAwaits();
});

test('a failed command leaves artifacts taken from the web context', async () => {
  const { failureArtifacts } = await import('../lib/safari.js');
  await start();
  fx.context = 'NATIVE_APP';
  const out = await failureArtifacts('click', new Error('boom'));
  assert.match(fs.readFileSync(out.artifacts.source, 'utf8'), /<html>/);
  assert.ok(fs.existsSync(out.artifacts.screenshot));
});

test('the caps helper pins the UDID and the build cache, and nothing insecure', () => {
  const caps = appiumCaps(U);
  assert.equal(caps['appium:udid'], U);
  assert.ok(path.isAbsolute(caps['appium:derivedDataPath']));
  assert.ok(!Object.keys(caps).some(k => /relaxed|insecure/i.test(k)));
});

test('WebDriverAgent listens on loopback only, on the phone and on the simulator (#51)', () => {
  assert.equal(WDA_BINDING_IP, '127.0.0.1');
  assert.equal(appiumCaps(U)['appium:wdaBindingIP'], '127.0.0.1');
  assert.equal(appiumCaps(U, { keepData: true })['appium:wdaBindingIP'], '127.0.0.1');
  assert.equal(appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: '/d' })['appium:wdaBindingIP'], '127.0.0.1');
  // Nothing points the driver at WebDriverAgent by another address.
  for (const caps of [appiumCaps(U), appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: '/d' })]) {
    assert.ok(!Object.keys(caps).some(k => /wdaBaseUrl|webDriverAgentUrl/i.test(k)));
  }
});

test('the simulator\'s Appium worst case, with WebDriverAgent\'s polling and retries, ends before the lab\'s own limit on a session create, so Appium reports a failed WebDriverAgent first', () => {
  const caps = appiumCaps(U);
  assert.equal(SIM_CREATE_MS, 420e3);
  assert.equal(caps['appium:wdaLaunchTimeout'], 30e3);
  assert.equal(caps['appium:wdaStartupRetries'], 2);
  assert.equal(caps['appium:wdaStartupRetryInterval'], 10e3);
  assert.equal(caps['appium:wdaConnectionTimeout'], 90e3);
  assert.equal(caps['appium:webviewConnectTimeout'], 30e3);
  // WebDriverAgent polls /status `launch / 500` times per attempt, the attempts 10 s apart; a poll is ~1.2 s when the port
  // refuses at once and up to 2 s (1 s limit plus the 1 s sleep) when it accepts and hangs, which the worst case assumes.
  assert.equal(WDA_POLL_WORST_MS, 2000);
  const attempt = Math.ceil(caps['appium:wdaLaunchTimeout'] / 500) * WDA_POLL_WORST_MS;
  assert.equal(attempt, 120e3);
  assert.equal(Math.ceil(caps['appium:wdaLaunchTimeout'] / 500) * 1200, 72e3); // refused at once
  const worst = caps['appium:wdaStartupRetries'] * attempt + (caps['appium:wdaStartupRetries'] - 1) * caps['appium:wdaStartupRetryInterval']
    + caps['appium:wdaConnectionTimeout'] + caps['appium:webviewConnectTimeout'];
  assert.equal(worst, 370e3);
  assert.equal(simCreateWorstMs(), worst);
  assert.ok(worst < SIM_CREATE_MS - 30e3, 'keeps a margin for what runs around the launch');
  // The phone\'s are untouched: a first build and signing there takes the time.
  const device = appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: '/d' });
  assert.deepEqual([device['appium:wdaLaunchTimeout'], device['appium:wdaConnectionTimeout']], [600000, 600000]);
  assert.ok(!('appium:wdaStartupRetries' in device) && !('appium:wdaStartupRetryInterval' in device));
});

test('appiumDeviceCaps has exactly these keys and takes the team, bundle id and cache from the caller', () => {
  const caps = appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'com.example.msl-wda-abcde', derivedData: '/d/wda-device' });
  assert.deepEqual(caps, {
    platformName: 'iOS',
    browserName: 'Safari',
    'appium:automationName': 'XCUITest',
    'appium:udid': 'UDID-1',
    'appium:xcodeOrgId': 'ABCDE12345',
    'appium:xcodeSigningId': 'Apple Development',
    'appium:updatedWDABundleId': 'com.example.msl-wda-abcde',
    'appium:allowProvisioningDeviceRegistration': true,
    'appium:derivedDataPath': '/d/wda-device',
    'appium:noReset': true,
    'appium:safariInitialUrl': '',
    'appium:wdaLaunchTimeout': 600000,
    'appium:wdaConnectionTimeout': 600000,
    'appium:wdaBindingIP': '127.0.0.1',
    'appium:newCommandTimeout': 1800,
    'appium:showXcodeLog': true,
  });
  assert.ok(!('appium:showSafariConsoleLog' in caps) && !('appium:showSafariNetworkLog' in caps), 'neither of Safari\'s logs (every tab\'s) is switched on');
  assert.ok(!('appium:usePreinstalledWDA' in caps));
  assert.ok(!Object.keys(caps).some(k => /relaxed|insecure/i.test(k)));
  // useNewWDA makes the driver uninstall WebDriverAgent every session, which drops the phone's trust for the developer (#58).
  assert.ok(!('appium:useNewWDA' in caps) && !('appium:usePrebuiltWDA' in caps));
  // No team is baked in: another team shows up as given.
  const other = appiumDeviceCaps({ udid: 'UDID-2', teamId: 'ZZZZZ99999', bundleId: 'b.c', derivedData: '/x' });
  assert.equal(other['appium:xcodeOrgId'], 'ZZZZZ99999');
  assert.ok(!JSON.stringify(other).includes('ABCDE12345'));
});

test('appiumDeviceCaps over the tunnel adds the Wi-Fi keys, binds the tunnel address and drops the build and signing keys; the cable\'s are unchanged', () => {
  const cable = appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: '/d' });
  const tun = appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: '/d', tunnel: { address: 'fd00:1234::1' }, platformVersion: '27.0.1' });
  assert.deepEqual(tun, {
    platformName: 'iOS',
    browserName: 'Safari',
    'appium:automationName': 'XCUITest',
    'appium:udid': 'UDID-1',
    'appium:platformVersion': '27.0.1',
    'appium:webDriverAgentUrl': 'http://[fd00:1234::1]:8100',
    'appium:noReset': true,
    'appium:safariInitialUrl': '',
    'appium:wdaLaunchTimeout': 600000,
    'appium:wdaConnectionTimeout': 600000,
    'appium:wdaBindingIP': 'fd00:1234::1',
    'appium:newCommandTimeout': 1800,
    'appium:showXcodeLog': true,
  });
  for (const k of ['xcodeOrgId', 'xcodeSigningId', 'updatedWDABundleId', 'allowProvisioningDeviceRegistration', 'derivedDataPath']) {
    assert.ok(k in Object.fromEntries(Object.entries(cable).map(([n, v]) => [n.replace('appium:', ''), v])), `${k} is the cable's`);
    assert.ok(!(`appium:${k}` in tun), `${k} is not the tunnel's`);
  }
  assert.equal(cable['appium:wdaBindingIP'], '127.0.0.1');
  assert.ok(!Object.keys(cable).some(k => /webDriverAgentUrl|platformVersion|useNewWDA/.test(k)));
  assert.ok(!('appium:useNewWDA' in tun));
  assert.ok(!('appium:platformVersion' in appiumDeviceCaps({ udid: 'UDID-1', teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: '/d', tunnel: { address: 'fd00:1234::1' } })), 'no version known, none sent');
});

test('the phone\'s build cache is not the simulator\'s', () => {
  const sim = appiumCaps(U)['appium:derivedDataPath'];
  const dev = appiumDeviceCaps({ udid: D, teamId: 'ABCDE12345', bundleId: 'b.c', derivedData: path.join(HOME, 'wda-device') })['appium:derivedDataPath'];
  assert.notEqual(dev, sim);
});

test('the log-filter rules compile and mask URLs and titles', () => {
  const apply = text => LOG_FILTERS.reduce((t, r) => t.replace(new RegExp(r.pattern, r.flags), r.replacer), text);
  for (const r of LOG_FILTERS) assert.deepEqual(Object.keys(r), ['pattern', 'flags', 'replacer']);
  const out = apply('Navigating to https://example.com/a?token=s3cret and {"title":"My Bank","pageTitle": \'Inbox\'} title=Secret page: x');
  assert.ok(!/example\.com|s3cret|My Bank|Inbox|Secret/.test(out), out);
  assert.match(out, /<url>/);
  assert.match(out, /"title":<redacted>/);
  assert.equal(apply('Proxying GET /status to session'), 'Proxying GET /status to session');
});

// Appium logs each request body on one line, JSON, cut at 1024 characters with an ellipsis
// (@appium/base-driver express-logging.js), and at debug level `Calling X.cmd() with args:`.
// These are those shapes, checked against the real SecureValuesPreprocessor by hand.
test('the log-filter rules keep script arguments and typed text out of the log, whole or cut off', () => {
  const apply = text => LOG_FILTERS.reduce((t, r) => t.replace(new RegExp(r.pattern, r.flags), r.replacer), text);
  const CANARY = 'CANARY-zq7k';
  const awkward = `${CANARY}"],[\\"x\\"]}{,https://a.test/?token=${CANARY}`;
  const cut = body => (body.length <= 1024 ? body : `${body.slice(0, 1023)}…`);
  const grey = b => `\x1b[90m${b}\x1b[39m`;
  const exec = (script, args) => JSON.stringify({ script, args });
  const lines = {
    'storage pairs': `--> POST /session/S1/execute/sync ${exec('return 1', [[['flag', awkward], ['b', CANARY]], 'https://a.test'])}`,
    'storage pairs, coloured': `\x1b[37m-->\x1b[39m \x1b[37mPOST\x1b[39m \x1b[37m/session/S1/execute/sync\x1b[39m ${grey(exec('return 1', [[['k', awkward]]]))}`,
    'cut inside the value': `--> POST /session/S1/execute/sync ${cut(exec('x'.repeat(990), [[['k', awkward]]]))}`,
    'cut before the key, so no value was logged': `--> POST /session/S1/execute/sync ${cut(exec('x'.repeat(1010), [[['k', awkward]]]))}`,
    'args first': `--> POST /session/S1/execute/sync ${JSON.stringify({ args: [[['k', awkward]]], script: 's' })}`,
    'mobile: keys': `--> POST /session/S1/execute/sync ${exec('mobile: keys', [{ keys: [CANARY] }])}`,
    'element value': `--> POST /session/S1/element/0A1B-2C/value ${JSON.stringify({ text: awkward, value: [...awkward] })}`,
    'element value, value first, coloured': `\x1b[37m/session/S1/element/0A1B-2C/value\x1b[39m ${grey(JSON.stringify({ value: [...awkward], text: awkward }))}`,
    'element value, cut': `--> POST /session/S1/element/0A1B-2C/value ${cut(JSON.stringify({ text: awkward.repeat(60), value: [...awkward] }))}`,
    'debug executeScript': `Calling XCUITestDriver.executeScript() with args: ${cut(JSON.stringify(['return 1', [['k', awkward]], 'S1']))}`,
    // appium-remote-debugger's atom line (execute.js), not cut: a script call with the storage pairs, and the type atom.
    'atom execute_script': `Executing atom 'execute_script' with 'args=${JSON.stringify(['return 1', [[['flag', awkward]], 'https://a.test']])}; frames='`,
    'atom type': `Executing atom 'type' with 'args=${JSON.stringify([{ ELEMENT: 'atom-1' }, awkward])}; frames='`,
    // base-driver's proxy line for what is sent on to WebDriverAgent (native keys, element value).
    'proxied keys': `Proxying [POST /session/S1/wda/keys] to [POST http://127.0.0.1:8100/session/W1/wda/keys] with body: ${JSON.stringify({ value: [...awkward] })}`,
    'proxied element value': `Proxying [POST /session/S1/wda/element/E1/value] to [POST http://127.0.0.1:8100/session/W1/wda/element/E1/value] with body: ${JSON.stringify({ value: [...awkward], text: awkward })}`,
    'debug setValue': `Calling XCUITestDriver.setValue() with args: ${JSON.stringify([awkward, '0A1B-2C', 'S1'])}`,
  };
  for (const [name, line] of Object.entries(lines)) {
    const out = apply(line);
    assert.ok(!/CANARY|zq7k|token=|a\.test/.test(out), `${name}: ${out}`);
    if (!/before the key/.test(name)) assert.match(out, /<redacted>/, name);
  }
  // What is around the secret stays, so the log still says which call it was.
  assert.match(apply(lines['storage pairs']), /^--> POST \/session\/S1\/execute\/sync \{"script":"return 1","args":<redacted>$/);
  assert.match(apply(lines['element value']), /^--> POST \/session\/S1\/element\/0A1B-2C\/value <redacted>$/);
  // The rest of the log is as before: other bodies, the response line of the value route, other routes.
  for (const same of [
    '--> POST /session/S1/timeouts {"implicit":0}',
    '<-- POST /session/S1/element/0A1B-2C/value 200 31 ms - 14',
    '--> POST /session/S1/element {"using":"css selector","value":"input"}',
    '<-- POST /session/S1/execute/sync 200 4 ms - 14',
  ]) assert.equal(apply(same), same);
  // URLs and titles are still masked in the body that is left.
  assert.match(apply('--> POST /session/S1/url {"url":"https://a.test/p?token=s3cret"}'), /"url":<redacted>/);
});

// --- start on the iPhone ---

const PU = '00008000-000A1B2C3D4E5F60'; // the fake phone in test/fixtures/phone
const PHONE = { udid: PU, teamId: 'ABCDE12345', bundleId: 'com.example.msl-wda-abcd' };
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phone');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');

// The phone as devicectl and usbmux show it. Returns the recorded commands.
function phoneIs(kind = 'reachable', extra = null) {
  const files = {
    reachable: { 'list devices': { json: 'devices-cable.json' }, lockState: { json: 'lock-unlocked.json' } },
    locked: { 'list devices': { json: 'devices-cable.json' }, lockState: { json: 'lock-locked.json' } },
    offline: { 'list devices': { json: 'devices-offline-stale.json' }, lockState: { json: 'lock-offline.json', code: 1, stderr: fixture('lock-offline-stderr.txt') } },
  }[kind];
  phoneLib.setUsbmux(() => true);
  return fakeRunner((cmd, args) => {
    const other = extra?.(cmd, args);
    if (other) return other;
    if (cmd !== 'xcrun') return undefined;
    if (args.includes('launch')) { onLaunch?.(args[args.indexOf('--payload-url') + 1]); return { code: 0 }; }
    const f = files[args.includes('lockState') ? 'lockState' : 'list devices'];
    if (f.json) fs.writeFileSync(args[args.indexOf('--json-output') + 1], fixture(f.json));
    return { code: f.code ?? 0, stderr: f.stderr ?? '' };
  });
}
const withPhone = () => saveState({ phone: PHONE });
let onLaunch = null; // called with the URL Safari is launched on
// Whether the session create went through fetch (as opposed to node:http, which has no 300 s limit).
async function createUsesFetch(fn) {
  const real = globalThis.fetch;
  let used = false;
  globalThis.fetch = (u, o) => { if (o?.method === 'POST' && String(u).endsWith('/session')) used = true; return real(u, o); };
  try { await fn(); } finally { globalThis.fetch = real; }
  return used;
}
const sessionPosts = () => log.filter(([m, u]) => m === 'POST' && u === '/session');
const failing = async p => { try { await p; } catch (e) { return e; } assert.fail('expected a rejection'); };

test('--device must be the saved phone, and a missing record needs setup, all before anything is contacted', async () => {
  phoneIs();
  let e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'setup');
  assert.equal(e.extra.then, 'lab phone setup --udid <UDID> --team <TEAM>');
  e = await failing(safari.start(['--target', 'device']));
  assert.equal(e.extra.needs, 'setup');
  withPhone();
  e = await failing(safari.start(['--device', '00008000-000A1B2C3D4E5F61']));
  assert.equal(e.extra.needs, 'setup');
  assert.match(e.message, /--device is not the saved phone/);
  assert.equal(e.message.includes(PU), false);
  assert.equal(log.length, 0);
  assert.equal(loadState().session, undefined);
});

test('a new session starts a fresh run folder, and a reused one keeps the current one', async () => {
  const scratch = tempDir('msl-scratch-run-');
  saveState({ run: scratch }); // a leftover folder outside the runs root
  const first = await safari.start(['--target', 'simulator']);
  const run1 = loadState().run;
  assert.notEqual(run1, scratch);
  assert.equal(path.dirname(run1), process.env.MSL_RUNS);
  assert.match(path.basename(run1), /^\d{8}-\d{6}-session$/);
  const again = await safari.start(['--target', 'simulator']);
  assert.equal(again.reused, true);
  assert.equal(again.session, first.session);
  assert.equal(loadState().run, run1, 'a reused session keeps its run folder');
});

test('a session started right after `sim run <label>` uses that run; the next one after it rotates', async () => {
  const labelled = newRun('iphone-recheck');
  await safari.start(['--target', 'simulator']);
  assert.equal(loadState().run, labelled);
  assert.deepEqual(fs.readdirSync(process.env.MSL_RUNS), [path.basename(labelled)], 'artifacts are not split over two folders');
  assert.match(fs.readFileSync(path.join(labelled, 'run.log'), 'utf8'), /safari start/);
  await safari.stop([]);
  await safari.start(['--target', 'simulator']);
  assert.notEqual(loadState().run, labelled, 'a second session gets its own run folder');
  assert.match(path.basename(loadState().run), /-session$/);
});

test('a damaged phone record stops start with the way to fix it, but not --target simulator', async () => {
  saveState({ phone: { udid: PU, teamId: 'nope' } });
  phoneIs();
  for (const flags of [[], ['--device', PU], ['--target', 'device']]) {
    await assert.rejects(safari.start(flags), /saved phone record is damaged.*lab phone setup/);
  }
  assert.equal(log.length, 0);
  assert.deepEqual((await safari.start(['--target', 'simulator'])).target, { simulator: U });
});

test('auto, --device and --target device start on the saved phone with the device caps, over node:http', async () => {
  withPhone();
  for (const flags of [[], ['--target', 'auto'], ['--device', PU], ['--target', 'device'], ['--target', 'device', '--device', PU]]) {
    log.length = 0;
    fx.context = 'WEBVIEW_1.1'; // where the driver leaves a new session
    saveState({ session: null, backend: null, target: null });
    const calls = phoneIs();
    let out;
    const viaFetch = await createUsesFetch(async () => { out = await safari.start(flags); });
    assert.equal(viaFetch, false, 'a device create waits over node:http, not fetch');
    assert.deepEqual(out, { session: 'S1', backend: 'appium', target: { device: PU }, targetType: 'device' }, flags.join(' '));
    assert.deepEqual(loadState().target, { device: PU });
    assert.equal(loadState().backend, 'appium');
    const create = sessionPosts()[0];
    assert.deepEqual(create[2], { capabilities: { alwaysMatch: appiumDeviceCaps({ udid: PU, teamId: 'ABCDE12345', bundleId: PHONE.bundleId, derivedData: path.join(HOME, 'wda-device') }) } });
    assert.equal(create[2].capabilities.alwaysMatch['appium:udid'], PU);
    assert.deepEqual(fx.settings, { waitForIdleTimeout: 0 }); // the idle wait is turned off on the phone too
    assert.ok(calls.some(c => c.includes('lockState') && c.includes(PU)), 'the phone was asked live');
    // Of the phone's pages only the tag check and the marker are touched, then it parks in the native app.
    assert.deepEqual(log.map(([m, u]) => `${m} ${u}`).filter(l => l !== 'GET /status'), [
      'POST /session', 'POST /session/S1/appium/settings', 'GET /session/S1/context',
      'POST /session/S1/execute/sync', 'GET /session/S1/context', 'POST /session/S1/context',
    ]);
    assert.equal(lastContextSwitch(), 'NATIVE_APP');
  }
  assert.equal(WAIT.deviceCreateMs, 660e3);
});

test('--target simulator ignores a saved phone and keeps the simulator caps', async () => {
  withPhone();
  const calls = phoneIs();
  const out = await safari.start(['--target', 'simulator']);
  assert.deepEqual(out.target, { simulator: U });
  assert.deepEqual(sessionPosts()[0][2], { capabilities: { alwaysMatch: appiumCaps(U) } });
  assert.equal(calls.length, 0, 'the phone is not asked');
});

test('an unreachable or locked phone is a needs error with the simulator way out, never a silent fallback', async () => {
  withPhone();
  phoneIs('offline');
  let e = await failing(safari.start([]));
  assert.equal(e.extra.needs, 'cable');
  assert.equal(e.extra.or, 'lab up --target simulator');
  assert.ok(e.extra.human.length > 0 && e.extra.then);
  phoneIs('locked');
  e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'unlock');
  assert.equal(sessionPosts().length, 0);
  assert.equal(loadState().session, undefined);
});

test('safari start with a phone that went silent after Wi-Fi needs tunnel, after the cable needs cable (#59)', async () => {
  const seen = via => ({ osVersion: '27.0.1', buildVersion: '24A446', at: new Date().toISOString(), ...(via ? { via } : {}) });
  for (const [via, needs] of [['tunnel', 'tunnel'], ['usbmux', 'cable'], [undefined, 'cable']]) {
    saveState({ phone: { ...PHONE, seen: seen(via) } });
    phoneIs('offline');
    const e = await failing(safari.start([]));
    assert.equal(e.extra.needs, needs, String(via));
  }
  assert.equal(sessionPosts().length, 0);
});

test('a failed device session create prints needs, human, then and or, classified from the text', async () => {
  withPhone();
  phoneIs();
  fx.createError = 'Timed out while enabling automation mode on https://h/p?code=SECRETX';
  const spoken = [];
  const log0 = console.log;
  console.log = l => spoken.push(l);
  let code;
  try { code = await cli({ start: a => safari.start(a) }, ['start', '--target', 'device']); } finally { console.log = log0; }
  const out = JSON.parse(spoken.join(''));
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.equal(out.needs, 'passcode');
  assert.ok(out.human.length > 0);
  assert.equal(out.then, 'lab up --target device');
  assert.equal(out.or, 'lab up --target simulator');
  assert.match(out.error, /Timed out while enabling automation mode/);
  assert.equal(JSON.stringify(out).includes('SECRETX'), false);
  assert.equal(loadState().session, undefined);

  fx.createError = 'something nobody has seen before';
  const e = await failing(safari.start(['--target', 'device']));
  assert.equal(e.extra.needs, 'unknown');
  assert.match(e.message, /something nobody has seen before/);

  // A simulator failure is not rewritten.
  fx.createError = 'Timed out while enabling automation mode';
  const sim = await failing(safari.start(['--target', 'simulator']));
  assert.equal(sim.extra, undefined);
});

test('start keeps a live device session without asking the phone or reading any page', async () => {
  withPhone();
  phoneIs();
  await safari.start([]);
  const calls = phoneIs();
  log.length = 0;
  const out = await safari.start([]);
  assert.equal(out.reused, true);
  assert.deepEqual(out.target, { device: PU });
  assert.equal(calls.length, 0);
  assert.deepEqual(log.map(([m, u]) => `${m} ${u}`), ['GET /session/S1/contexts', 'POST /session/S1/appium/settings']);
  // ... and it will not be switched to the simulator underneath.
  await assert.rejects(safari.start(['--target', 'simulator']), /a session is already open on \{"device":.*run `safari stop` first/);
});

test('a dead device session is replaced after asking the phone again', async () => {
  withPhone();
  saveState({ backend: 'appium', session: 'GONE', port: 4723, target: { device: PU }, injected: [] });
  const calls = phoneIs();
  const out = await safari.start([]);
  assert.equal(out.session, 'S1');
  assert.equal(out.recovered, true);
  assert.ok(calls.length > 0);
  assert.deepEqual(loadState().target, { device: PU });
});

test('a device session needs the Appium service with log filters, and a simulator one does not', async () => {
  withPhone();
  phoneIs();
  const url = process.env.MSL_APPIUM_URL;
  const port = SERVICE.port;
  delete process.env.MSL_APPIUM_URL;
  SERVICE.port = server.address().port;
  const plist = filters => buildPlist({ node: process.execPath, main: '/x/appium/main.js', home: HOME, port: SERVICE.port, log: '/x/log', filters, developerDir: '/x/dev', path: '/usr/bin' });
  const old = () => plist('/x/f.json').replace(/\s*<string>--log-level<\/string>\s*<string>info<\/string>\s*<string>--log-filters<\/string>\s*<string>[^<]*<\/string>/, '');
  const install = text => { fs.mkdirSync(path.dirname(plistPath()), { recursive: true }); fs.writeFileSync(plistPath(), text); };
  try {
    // Not installed.
    let e = await failing(safari.start(['--device', PU]));
    assert.match(e.message, /the LaunchAgent is not installed/);
    assert.equal(e.extra.then, 'lab service install');
    assert.ok(e.extra.human.length > 0 && e.extra.needs && e.extra.or);
    // An old plist, without --log-level info / --log-filters.
    install(old());
    assert.doesNotMatch(fs.readFileSync(plistPath(), 'utf8'), /log-filters/);
    e = await failing(safari.start(['--device', PU]));
    assert.match(e.message, /the plist starts Appium without log redaction \(`--log-filters`, at log level info or debug\)/);
    // Filters named but the rules file is missing.
    install(plist(logFiltersPath()));
    e = await failing(safari.start(['--device', PU]));
    assert.match(e.message, /rules file.*missing/);
    // A plist whose arguments can't be read can't be shown to redact anything.
    install('not a plist');
    e = await failing(safari.start(['--device', PU]));
    assert.match(e.message, /the plist's arguments can't be read/);
    assert.equal(e.extra.needs, 'service');
    assert.equal(sessionPosts().length, 0, 'refused before any session was created');
    assert.equal(loadState().session, undefined);
    // The simulator behind the service needs it too (typed text and storage values go through Appium); without the service it does not.
    install(old());
    e = await failing(safari.start(['--target', 'simulator']));
    assert.match(e.message, /the plist starts Appium without log redaction/);
    assert.equal(e.extra.needs, 'service');
    install('not a plist');
    e = await failing(safari.start(['--target', 'simulator']));
    assert.match(e.message, /the plist's arguments can't be read/);
    assert.equal(sessionPosts().length, 0, 'refused before any session was created');
    // Rules from an older lab: the phone and the simulator behind the service are both refused
    // before any session, and a current file lets the simulator through.
    fs.mkdirSync(path.dirname(logFiltersPath()), { recursive: true });
    fs.writeFileSync(logFiltersPath(), JSON.stringify(LOG_FILTERS.slice(3), null, 2) + '\n');
    install(plist(logFiltersPath()));
    const before = sessionPosts().length;
    for (const args of [['--device', PU], ['--target', 'simulator']]) {
      e = await failing(safari.start(args));
      assert.match(e.message, /log-filter rules are older than this lab's/);
      assert.equal(e.extra.needs, 'service');
      assert.equal(e.extra.then, 'lab service install');
    }
    assert.equal(sessionPosts().length, before, 'refused before any session was created');
    fs.writeFileSync(logFiltersPath(), CURRENT_RULES);
    assert.deepEqual((await safari.start(['--target', 'simulator'])).target, { simulator: U });
    await safari.stop();
    // A good plist, but something else listens on the service's port: refused before any session.
    let listener = '999\n';
    const created = sessionPosts().length;
    phoneIs('reachable', cmd => (cmd === 'launchctl' ? { stdout: 'state = running\n\tpid = 4242\n' } : cmd === 'lsof' ? { stdout: listener } : undefined));
    e = await failing(safari.start(['--target', 'device']));
    assert.equal(e.extra.needs, 'service');
    assert.match(e.message, /not the service \(launchd's pid 4242, listener 999\)/);
    assert.equal(sessionPosts().length, created, 'refused before any session was created');
    // ... and one that is the service starts.
    listener = '4242\n';
    assert.deepEqual((await safari.start(['--device', PU])).target, { device: PU });
  } finally {
    process.env.MSL_APPIUM_URL = url;
    SERVICE.port = port;
  }
});

// --- the lab's own tab on the phone ---
// test/helpers.js plays Appium with a phone's Safari behind it (standin({ phone: true })): pages
// with a URL, a window.name, a history and visibility, scripts run against a fake
// window/location/document (so the real guard scripts are what is tested), the real driver's
// habit of following a vanished or new page, and the owner's other tab, which must never be touched.

let ps, dlog, dv; // the stand-in, its request log, the phone's state (replaced by every reset)

// `stock`: the phone's Appium is the stock driver, without the page pin plugin (it follows a page that
// appears, and the key tab when the page goes). The tests that use it are about the lab's own tripwires.
const STOCK = true;
const deviceReset = (stock = false) => {
  ps.reset();
  dv = ps.dv;
  dv.pinned = !stock;
  dlog = ps.log;
  onLaunch = url => ps.launch(url);
};
const addPage = (id, href, extra) => ps.addPage(id, href, extra);
// What a tainted record keeps: the tag and the last site the lab sent the tab to (the page it started on unless a navigation was asked for).
const tainted = (lastOrigin = 'https://example.com') => ({ tainted: true, tag: dv.tag, lastOrigin });

before(async () => {
  ps = standin({ phone: true });
  await ps.listen();
});
after(() => ps.close());

// Starts a device session against the phone stand-in and forgets what that took.
async function startPhone(stock = false, hosts = []) {
  Object.assign(WAIT, BASE_WAIT); // a loop's earlier iteration may have narrowed the limits
  Object.assign(NET, REAL_NET);
  stepClock();
  deviceReset(stock);
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  withPhone();
  phoneIs();
  await safari.start(['--device', PU, ...hosts.flatMap(h => ['--allow-host', h])]);
  dlog.length = 0;
}
const mark = ([m, u, b]) => `${m} ${u.replace(/^\/session\/S1/, '') || '/session'}${u.endsWith('/context') && m === 'POST' ? ` ${b.name}` : ''}`;
const seq = () => dlog.map(mark);
const executes = () => dlog.filter(([m, u]) => m === 'POST' && u.endsWith('/execute/sync')).map(([, , b]) => b);
const GUARDED = ['GET /contexts', 'GET /context',`POST /context ${PAGE}`, 'GET /context', 'POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP'];
// The two scripts that follow a navigation: a read-only probe, then the mark (tied to the probed document's timeOrigin).
const PROBE = /readyState !== "complete"/;
const MARK = /timeOrigin !== [\d.]+\) return null; .*window\.name = /s;
const probes = () => executes().filter(b => PROBE.test(b.script));
const marks = () => executes().filter(b => MARK.test(b.script));
const runLog = () => fs.readFileSync(path.join(loadState().run, 'run.log'), 'utf8');

// What may never happen on the phone, whatever the test did.
const neverUnsafe = () => sharedNeverUnsafe(ps);
const PAGE_COMMANDS = {
  open: ['https://example.com/'], refresh: [], eval: ['1'], inject: [], click: ['a'], type: ['a', 'b'],
  tap: ['a'], keys: ['x'], swipe: ['up'], ui: [], source: [], shot: [], console: [], url: [],
};

test('device start opens the lab\'s tab first, checks the tag in the page the driver picked, plants a marker and parks native', async () => {
  deviceReset();
  withPhone();
  const calls = phoneIs();
  let launchedBeforeCreate = null;
  onLaunch = url => {
    launchedBeforeCreate = dlog.filter(([m, u]) => m === 'POST' && u === '/session').length === 0;
    ps.launch(url);
  };
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  await safari.start(['--device', PU]);
  assert.equal(launchedBeforeCreate, true, 'Safari is launched on the tag page before the session is created');
  const launch = calls.find(c => c.includes('launch'));
  assert.deepEqual(launch.slice(0, 9), ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', PU, '--terminate-existing', '--payload-url']);
  assert.match(launch[9], /^https:\/\/example\.com\/\?msl-[0-9a-f]{8}$/);
  assert.equal(launch[10], 'com.apple.mobilesafari');
  const all = seq();
  assert.deepEqual(all.slice(all.indexOf('POST /session')), ['POST /session', 'POST /appium/settings', 'GET /context', 'POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP']);
  assert.equal(executes().length, 1, 'one script, the only code run in an unverified page');
  const tab = loadState().deviceTab;
  assert.equal(executes()[0].script, `if (location.origin !== "https://example.com" || location.search !== ${JSON.stringify(`?${dv.tag}`)}) return false; window.name = ${JSON.stringify(tab.token)}; return location.origin`);
  assert.deepEqual(Object.keys(tab).sort(), ['origin', 'origins', 'page', 'tag', 'token']);
  assert.equal(tab.page, PAGE);
  assert.equal(tab.tag, dv.tag);
  assert.equal(tab.origin, 'https://example.com');
  assert.deepEqual(tab.origins, ['https://example.com']);
  assert.equal(dv.pages[PAGE].win.name, tab.token);
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('device start refuses when the page the driver picked is not the lab\'s: nothing else runs, the session ends', async () => {
  deviceReset();
  withPhone();
  phoneIs();
  dv.pick = OTHER; // the driver picked the owner's tab
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  const e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'tab');
  assert.ok(e.extra.human.length > 0);
  assert.equal(e.skipArtifacts, true);
  // The tab the lab opened is still on the phone, and the person is told first.
  assert.equal(e.extra.tabClosed, false);
  assert.equal(e.extra.tabLeft, 'new');
  assert.match(e.extra.human[0], /^The lab opened a Safari tab \(https:\/\/example\.com\/\?msl-[0-9a-f]{8}\) but couldn't confirm it, so it touched nothing\. Close it by hand: tab switcher, X on its card\.$/);
  assert.ok(e.extra.human.length > 1, 'the needs steps follow');
  const pageRequests = seq().filter(l => !['POST /session', 'POST /appium/settings', 'GET /context', 'DELETE /session', 'POST /context NATIVE_APP', 'GET /status', 'GET /appium/settings'].includes(l));
  assert.deepEqual(pageRequests, ['POST /execute/sync'], 'exactly the one conditional script');
  assert.match(executes()[0].script, /^if \(location\.origin !== "https:\/\/example\.com" \|\| location\.search !== "\?msl-[0-9a-f]{8}"\) return false; window\.name = /);
  assert.equal(dv.pages[OTHER].win.name, 'owner-state', 'nothing was planted in it');
  assert.equal(dv.pages[PAGE].win.name, '');
  assert.equal(dv.context, 'NATIVE_APP');
  assert.ok(seq().includes('DELETE /session'), 'the session was ended');
  const st = loadState();
  assert.equal(st.session, undefined);
  assert.equal(st.deviceTab, undefined);
  assert.deepEqual(dlog.filter(([m, u]) => m === 'DELETE' && u.endsWith('/window')), []);
});

test('a device page command selects the lab\'s tab, runs behind the marker check, confirms the context and parks', async () => {
  await startPhone();
  assert.deepEqual((await safari.eval(['1 + 1'])).value, 2);
  assert.deepEqual(seq(), GUARDED);
  const { script } = executes()[0];
  assert.match(script, /^if \(window\.name !== "msl-tok-[0-9a-f]{16}"\) return \{ __msl: 0 \};/);
  const out = await safari.url([]);
  assert.deepEqual(out, { url: `https://example.com/?${dv.tag}`, title: 'Example' });
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('eval awaits a Promise or another thenable, on the phone', async () => {
  await startPhone();
  await evalAwaits();
  const e = await failing(safari.eval(['throw new Error("boom")']));
  assert.match(e.message, /boom/, 'a page exception is still an error');
  neverUnsafe();
});

test('when the lab\'s tab is gone every page command refuses with needs "tab", and the owner\'s tab is never selected', async () => {
  await startPhone();
  delete dv.pages[PAGE];
  const file = path.join(path.dirname(loadState().run), 'x.user.js');
  fs.writeFileSync(file, '1;');
  for (const [name, args] of Object.entries(PAGE_COMMANDS)) {
    dlog.length = 0;
    const e = await failing(safari[name](name === 'inject' ? [file] : args));
    assert.equal(e.extra.needs, 'tab', name);
    assert.ok(e.extra.human.length > 0 && e.extra.then, name);
    assert.equal(e.skipArtifacts, true, name);
    assert.equal(executes().length, 0, `${name}: no script was sent`);
    assert.ok(!seq().some(l => l.startsWith('POST /context WEBVIEW')), `${name}: no page was selected`);
    assert.equal(seq().at(-1), 'POST /context NATIVE_APP', name);
    neverUnsafe();
  }
  assert.deepEqual(await failureArtifacts('eval', new Error('x')), {}); // no screenshot or source from the phone
});

test('a context that moved while a command ran discards its result', async () => {
  await startPhone();
  dv.onExecute = () => { dv.context = OTHER; }; // the driver pulled the session to another page
  const e = await failing(safari.eval(['"secret-value-" + 42']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /discarded/);
  assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /secret-value/);
  assert.equal(dv.context, 'NATIVE_APP', 'parked again');
  assert.equal(dv.pages[OTHER].runs, 0);
  assert.deepEqual(loadState().deviceTab, tainted(), 'the run no longer trusts the phone');
  dlog.length = 0;
  const again = await failing(safari.eval(['1']));
  assert.equal(again.extra.needs, 'tab');
  assert.match(again.message, /run `safari start`/);
  assert.equal(dlog.length, 0, 'nothing more is sent to the phone');
});

test('a missing marker refuses before the command body runs', async () => {
  await startPhone();
  dv.pages[PAGE].win.name = ''; // navigated or replaced
  const e = await failing(safari.eval(['window.__ran = true; return 1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /marker/);
  assert.equal(dv.pages[PAGE].win.__ran, undefined, 'the body never ran');
  assert.deepEqual(loadState().deviceTab, tainted());
  dlog.length = 0;
  await assert.rejects(safari.url([]), e2 => e2.extra.needs === 'tab');
  assert.equal(dlog.length, 0);
  neverUnsafe();
});

test('a tab that does not answer in time refuses after tabMs and parks native', async () => {
  await startPhone();
  WAIT.tabMs = 4321; // a budget no other request has (callMs is 10 s); the stand-in cuts the parked script off, so nothing waits for it
  const sent = noAnswerWhenParked();
  dv.hang = true;
  const e = await failing(safari.eval(['1']));
  assert.deepEqual(sent.filter(r => r.parked).map(r => r.ms), [WAIT.tabMs], 'the script that got no answer was given tabMs, not callMs');
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /did not answer/);
  assert.deepEqual(seq().slice(-3), ['GET /context', 'POST /context NATIVE_APP', 'GET /context'], 'read, park, and a check that the park landed');
  assert.equal(dv.context, 'NATIVE_APP');
});

test('a tab that does not answer while the phone is locked needs unlock, does not taint the run, and works again after unlocking', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  const calls = phoneIs('locked');
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'unlock');
  assert.match(e.extra.human.join(' '), /Unlock the phone/);
  assert.equal(e.skipArtifacts, true);
  assert.ok(calls.some(c => c.includes('lockState') && c.includes(PU)), 'the lock was asked');
  assert.equal(loadState().deviceTab.tainted, undefined, 'a lock is not a page move');
  assert.equal(dv.context, 'NATIVE_APP');
  // Unlocked: the same session and tab carry on.
  dv.hang = false;
  phoneIs();
  assert.equal((await safari.eval(['1'])).value, 1);
  neverUnsafe();
});

test('a timeout with the lock check unanswered or unlocked stays a tab refusal, still untainted when nothing moved', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  for (const kind of ['reachable', 'offline']) {
    phoneIs(kind);
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tab', kind);
    assert.match(e.message, /did not answer/);
    assert.equal(loadState().deviceTab.tainted, undefined, kind);
  }
});

test('a timeout while the phone is locked but the context moved still taints the run, and does not ask the lock', async () => {
  await startPhone(STOCK);
  noAnswerWhenParked();
  dv.hang = true;
  dv.onExecute = () => { dv.onExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
  const calls = phoneIs('locked');
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(calls.some(c => c.includes('lockState')), false);
  assert.equal(dv.context, 'NATIVE_APP');
});

// --- a session on the Wi-Fi tunnel whose route is down (#59): needs tunnel (or unlock), not tab ---

// The tunnel as the lab's record shows it (the host's pid answers `ps` as the host), the tunnel probe answering `reach`, and
// WebDriverAgent's /status (a local server) answering `wda`. The session is recorded as running over the tunnel (`via`).
// `body(hits, phones)`: `hits` counts the probes made, `phones(kind)` re-arms the devicectl stand-in with the host's `ps`.
async function overTunnel({ reach = true, wda = true, hostAlive = true, via = 'tunnel' } = {}, body) {
  const hits = { probe: 0, wda: 0 };
  const server = http.createServer((req, res) => { hits.wda++; res.statusCode = wda ? 200 : 503; res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const real = { probe: tunnelLib.hooks.probe, url: tunnelLib.WDA.url, probeMs: tunnelLib.WDA_WAIT.probeMs };
  tunnelLib.hooks.probe = async () => { hits.probe++; return reach; };
  tunnelLib.WDA.url = () => `http://127.0.0.1:${server.address().port}`;
  tunnelLib.WDA_WAIT.probeMs = 500;
  tunnelLib.writeTunnel({ v: 1, pid: 4242, udid: PU, address: 'fd00:1234::1', rsdPort: 54321, registryPort: 42999, startedAt: new Date().toISOString(), state: 'up', strongboxWas: null, strongboxOurs: false });
  saveState({ transport: via === 'tunnel' ? { via, address: 'fd00:1234::1' } : { via } });
  const host = cmd => (cmd !== 'ps' ? undefined : hostAlive ? { stdout: `${REPO}/bin/lab-tunnel-host\n` } : { code: 1 });
  try { return await body(hits, kind => phoneIs(kind, host)); } finally {
    tunnelLib.WDA_WAIT.probeMs = real.probeMs;
    tunnelLib.hooks.probe = real.probe;
    tunnelLib.WDA.url = real.url;
    await new Promise(r => server.close(r));
  }
}

test('a tab that does not answer over a tunnel that does not answer is needs tunnel, not tab: untainted, session kept, nothing read from any page', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  await overTunnel({ reach: false }, async (hits, phones) => {
    const calls = phones('reachable');
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tunnel');
    assert.equal(e.extra.then, 'lab up --target device');
    assert.equal(e.extra.or, 'lab up --target simulator');
    assert.match(e.extra.tunnel, /does not answer through the tunnel/);
    assert.equal(e.skipArtifacts, true);
    assert.equal(e.routeDown, true);
    assert.equal(hits.wda, 0, 'WebDriverAgent is not asked once the tunnel itself is silent');
    assert.equal(calls.some(c => c.includes('lockState')), false, 'a dead route is not a lock question');
    assert.equal(loadState().deviceTab.tainted, undefined);
    assert.equal(loadState().session, 'S1', 'the session is kept');
    assert.equal(dv.context, 'NATIVE_APP');
  });
  // The host gone is the same refusal, with its own words, and no connect is tried.
  await overTunnel({ hostAlive: false }, async (hits, phones) => {
    phones('reachable');
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tunnel');
    assert.match(e.extra.tunnel, /host is gone/);
    assert.equal(hits.probe, 0);
  });
  neverUnsafe();
});

test('a tunnel that answers while WebDriverAgent does not is needs tunnel with the WebDriverAgent words, unless the phone is locked: then unlock', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  await overTunnel({ reach: true, wda: false }, async (hits, phones) => {
    const calls = phones('reachable');
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tunnel');
    assert.match(e.extra.human.join(' '), /WebDriverAgent/);
    assert.match(e.extra.tunnel, /WebDriverAgent does not answer/);
    assert.equal(e.extra.then, 'lab up --target device');
    assert.equal(hits.wda, 1);
    assert.ok(calls.some(c => c.includes('lockState')), 'the lock was asked first: a locked phone silences WebDriverAgent');
    assert.equal(loadState().deviceTab.tainted, undefined);
    assert.equal(e.gone, undefined);

    // Locked: the silent WebDriverAgent is the lock's, not a lost route.
    phones('locked');
    const locked = await failing(safari.eval(['1']));
    assert.equal(locked.extra.needs, 'unlock');
    assert.equal(locked.routeDown, undefined);

    // A tab that is gone over a silent WebDriverAgent keeps `gone` (safari stop words it), locked or not.
    dv.hang = false;
    delete dv.pages[PAGE];
    assert.equal((await failing(safari.eval(['1']))).gone, true);
    phones('reachable');
    const gone = await failing(safari.eval(['1']));
    assert.deepEqual([gone.extra.needs, gone.gone], ['tunnel', true]);
  });
});

test('over a healthy route the lock decides: a hang or a gone tab while locked needs unlock, otherwise it stays a tab refusal', async () => {
  await startPhone();
  noAnswerWhenParked();
  await overTunnel({}, async (hits, phones) => {
    dv.hang = true;
    const calls = phones('locked');
    let e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'unlock');
    assert.equal(e.gone, undefined);
    assert.equal(hits.probe, 1, 'the route was looked at first');
    assert.equal(hits.wda, 1);
    assert.ok(calls.some(c => c.includes('lockState')));

    // A locked phone can list no tab at all: the tab is "gone", and the phone says why.
    dv.hang = false;
    const page = dv.pages[PAGE];
    delete dv.pages[PAGE];
    e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'unlock');
    assert.equal(e.gone, true, 'endDeviceSession reads gone');
    assert.equal(e.skipArtifacts, true);
    assert.equal(loadState().deviceTab.tainted, undefined);

    // Unlocked: a tab that is gone stays gone, and a hang stays the pause.
    phones('reachable');
    e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tab');
    assert.equal(e.gone, true);
    assert.match(e.message, /is gone/);
    dv.pages[PAGE] = page;
    dv.hang = true;
    e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tab');
    assert.match(e.message, /did not answer within/);
    assert.match(e.message, /switch back to the lab's tab/);
    assert.equal(e.routeDown, undefined);
  });
  neverUnsafe();
});

test('a tab that is gone over a dead route is needs tunnel too', async () => {
  await startPhone();
  delete dv.pages[PAGE];
  await overTunnel({ reach: false }, async (hits, phones) => {
    phones('locked');
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tunnel');
    assert.equal(hits.probe, 1);
  });
});

test('a session on the cable, or with no transport recorded, is never route-checked: a hang is still tab (or unlock)', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  await overTunnel({ reach: false, via: 'usbmux' }, async (hits, phones) => {
    phones('reachable');
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tab');
    assert.equal(hits.probe, 0);
    assert.equal(hits.wda, 0);
    phones('locked');
    assert.equal((await failing(safari.eval(['1']))).extra.needs, 'unlock');
    saveState({ transport: null });
    phones('reachable');
    assert.equal((await failing(safari.eval(['1']))).extra.needs, 'tab');
    assert.equal(hits.probe, 0);
  });
});

test('a route error ends a wait at once, like any other refusal of the guard', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  await overTunnel({ reach: false }, async (hits, phones) => {
    phones('reachable');
    const t0 = Date.now();
    const e = await failing(safari.wait(['#cta', '--timeout', '8000']));
    assert.equal(e.extra.needs, 'tunnel');
    assert.ok(Date.now() - t0 < 4000, 'did not wait out the timeout');
    assert.equal(hits.probe, 1, 'one route check, not one per poll');
  });
});

test('through cli a tab refusal never reaches the failure artifacts, so the route check lives in the guard and prints needs tunnel', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  await overTunnel({ reach: false }, async (hits, phones) => {
    phones('reachable');
    const spoken = [];
    let artifacts = 0;
    const log0 = console.log;
    console.log = l => spoken.push(l);
    let code;
    try { code = await cli({ eval: a => safari.eval(a) }, ['eval', '1'], { onError: async () => { artifacts++; return {}; } }); } finally { console.log = log0; }
    const out = JSON.parse(spoken.join(''));
    assert.equal(code, 1);
    assert.equal(out.ok, false);
    assert.equal(out.needs, 'tunnel');
    assert.equal(out.then, 'lab up --target device');
    assert.match(out.tunnel, /does not answer through the tunnel/);
    assert.equal(spoken.length, 1, 'one JSON object');
    assert.equal(artifacts, 0, 'a refusal of the guard skips the artifacts');
  });
});

test('a script that throws in the lab\'s own tab reports its error, not a tab refusal', async () => {
  await startPhone();
  const e = await failing(safari.eval(['throw new Error("boom")']));
  assert.equal(e.extra, undefined);
  assert.match(e.message, /boom/);
  assert.equal(dv.context, 'NATIVE_APP');
});

// The real driver never answers a script that throws (hangOnThrow); the guard's in-page catch is what makes
// the page's exception come back at once as the page's own error.
test('a script that throws on the phone is the page\'s error at once: no needs, no taint, no wait, and the next command works', async () => {
  await startPhone();
  WAIT.tabMs = 20e3; // a wait of this length would be a tab timeout; the loose bound below is half of it
  dv.hangOnThrow = true;
  const before = loadState().deviceTab;
  const t0 = Date.now();
  const e = await failing(safari.eval(['null.x']));
  assert.ok(Date.now() - t0 < WAIT.tabMs / 2, 'answered at once, not after tabMs');
  assert.match(e.message, /^the page script threw: .*null/);
  assert.equal(e.extra, undefined, 'no needs');
  assert.equal(e.moved, undefined);
  assert.doesNotMatch(e.message, /did not answer/);
  assert.deepEqual(loadState().deviceTab, before, 'the tab record is untouched (not tainted)');
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(seq().at(-1), 'POST /context NATIVE_APP');
  assert.match(dv.pages[PAGE].win.name, /./, 'the marker is still on the lab\'s page');
  assert.match((await safari.url([])).url, /^https:\/\/example\.com\//, 'the next command works');
  neverUnsafe();
});

test('the page\'s error text is redacted and capped, and a thrown non-error still comes back', async () => {
  await startPhone();
  dv.hangOnThrow = true;
  const e = await failing(safari.eval(['throw new Error("failed https://h/cb?code=SECRETPAGE&x=1")']));
  assert.match(e.message, /^the page script threw: /);
  assert.doesNotMatch(e.message, /SECRETPAGE/);
  const long = await failing(safari.eval(['throw new Error("x".repeat(2000))']));
  assert.ok(long.message.length < 600);
  const odd = await failing(safari.eval(['throw Object.create(null)']));
  assert.match(odd.message, /^the page script threw: /);
  assert.equal(odd.extra, undefined);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('a thrown text the page tampered with is capped and type-checked here, and still an error, never ok:true', async () => {
  await startPhone();
  const answers = [
    [{ __msl: 1, threw: true, thrown: 'x'.repeat(5000) }, /^the page script threw: x{500}$/],
    [{ __msl: 1, threw: true, thrown: { toString: 'no' } }, /^the page script threw: unreadable error$/],
    [{ __msl: 1, threw: true }, /^the page script threw: unreadable error$/], // the page patched slice, so the text was dropped
  ];
  for (const [forged, text] of answers) {
    dv.mapResult = (value, s) => (/null\.x/.test(s) ? forged : value);
    const e = await failing(safari.eval(['(function () { try { null.x } catch (e) { return 1 } })(); null.x']));
    assert.match(e.message, text);
    assert.equal(e.extra, undefined);
    assert.equal(loadState().deviceTab.tainted, undefined);
  }
  neverUnsafe();
});

test('inject checks a userscript\'s syntax in Node first: no page call for a script that cannot compile', async () => {
  await startPhone();
  const file = path.join(tempDir(), 'bad.user.js');
  fs.writeFileSync(file, 'window.x = (;\n');
  const e = await failing(safari.inject([file]));
  assert.match(e.message, /bad\.user\.js: syntax error: /);
  assert.equal(e.extra, undefined);
  assert.equal(dlog.length, 0, 'zero requests');
  assert.equal(loadState().injected, undefined);
});

test('a real timeout on the phone still needs the tab, and a page exception is not mistaken for one', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  dv.hangOnThrow = true;
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.timedOut, true);
  assert.match(e.message, /did not answer/);
  assert.equal(dv.context, 'NATIVE_APP');
  dv.hang = false;
  const thrown = await failing(safari.eval(['null.x']));
  assert.equal(thrown.extra, undefined);
  neverUnsafe();
});

// --- a tab that is not showing blocks Appium's queue (no answer is not a move) ---
// A script sent to a tab that is not showing is not answered, and Appium runs a session's commands
// one at a time, so every later request waits behind it until the tab shows again. `dv.hang =
// 'queue'` plays that, and `ps.switchBack()` is the owner switching back to the lab's tab.

const pauseSteps = e => e.extra.human.join(' ');
const PROBE_REMOVED = /querySelector\('\[aria-label="'/;

test('F1 a: a script that gets no answer behind a blocked queue is a pause: one read and one park, no taint, and the same tab works after switching back', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.timedOut, true);
  assert.match(e.message, /did not answer within/);
  assert.match(e.message, /session is still good.*switch back to the lab's tab/);
  assert.doesNotMatch(e.message, /lost track/);
  assert.match(pauseSteps(e), /Switch back to the lab's tab/);
  assert.doesNotMatch(pauseSteps(e), /lost track/);
  assert.equal(e.skipArtifacts, true);
  assert.equal(loadState().deviceTab.tainted, undefined, 'no answer is not a move');
  const s = seq();
  assert.deepEqual(s.slice(s.indexOf('POST /execute/sync')), ['POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP'], 'after the script: one read and one park, nothing else');
  assert.equal(executes().length, 1, 'no further script');
  assert.equal(dlog.filter(([, , b]) => typeof b?.script === 'string' && b.script.startsWith('mobile:')).length, 0);
  // The owner switches back: the queue clears in order, the late script finishes in the lab's tab only.
  ps.switchBack();
  assert.equal(dv.context, 'NATIVE_APP', 'the park ran when the queue cleared');
  assert.ok(dv.executed.every(([id]) => id === PAGE), 'the late script finished in the lab\'s tab');
  dlog.length = 0;
  assert.equal((await safari.eval(['1 + 1'])).value, 2);
  assert.deepEqual(seq(), GUARDED);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('an interrupt while a script waits parks the session native, keeps it, and does not taint the run', async () => {
  await startPhone();
  WAIT.tabMs = 5000;
  dv.hang = true;
  const e = await withInterrupt(async () => {
    const run = failing(safari.eval(['1']));
    for (let i = 0; i < 200 && !executes().length; i++) await new Promise(r => setTimeout(r, 10)); // the script is waiting
    assert.equal(executes().length, 1);
    process.emit('SIGTERM', 'SIGTERM');
    return run;
  });
  assert.ok(e instanceof InterruptError);
  assert.equal(e.signal, 'SIGTERM');
  assert.equal(e.extra.sessionKept, true);
  assert.equal(e.extra.tainted, false);
  assert.match(e.extra.human.join(' '), /may still finish in the lab's tab/);
  assert.equal(e.skipArtifacts, true);
  const s = seq();
  assert.deepEqual(s.slice(s.indexOf('POST /execute/sync')), ['POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP', 'GET /context'], 'the park was sent after the signal');
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.match(runLog(), /safari guard: interrupted by SIGTERM, not tainted/);
  dv.hang = false;
  dlog.length = 0;
  assert.equal((await safari.eval(['1 + 1'])).value, 2, 'the same session and tab carry on');
  neverUnsafe();
});

test('an interrupt that arrives before anything is sent says so, and still parks', async () => {
  await startPhone();
  const e = await withInterrupt(async () => {
    process.emit('SIGHUP', 'SIGHUP');
    return failing(safari.eval(['1']));
  });
  assert.ok(e instanceof InterruptError);
  assert.match(e.extra.human.join(' '), /before it sent anything/);
  assert.equal(executes().length, 0);
  assert.equal(e.extra.tainted, false);
  neverUnsafe();
});

// Emits `signal` once the answer to the request matching `when` has been read, before the next request goes out.
async function signalAfter(when, signal, fn) {
  const orig = globalThis.fetch;
  let fired = false;
  globalThis.fetch = async (u, o) => {
    const r = await orig(u, o);
    if (fired || !when(String(u), o)) return r;
    fired = true;
    const text = await r.text();
    process.emit(signal, signal);
    return new Response(text, { status: r.status, headers: r.headers });
  };
  try { return await withInterrupt(fn); } finally { globalThis.fetch = orig; }
}

test('an interrupt after the script answered, before the context check, says the script may have run', async () => {
  await startPhone();
  dlog.length = 0;
  const e = await signalAfter(u => u.endsWith('/execute/sync'), 'SIGTERM', () => failing(safari.eval(['1'])));
  assert.ok(e instanceof InterruptError);
  assert.equal(executes().length, 1, 'the script ran');
  assert.match(e.extra.human.join(' '), /may still finish in the lab's tab/);
  assert.doesNotMatch(e.extra.human.join(' '), /before it sent anything/);
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('an interrupt that refuses the script itself at entry says nothing was sent', async () => {
  await startPhone();
  dlog.length = 0;
  // The tab is selected and confirmed; the signal lands before the script is sent.
  let reads = 0;
  const e = await signalAfter((u, o) => u.endsWith('/context') && (o?.method ?? 'GET') === 'GET' && ++reads === 2, 'SIGINT', () => failing(safari.eval(['1'])));
  assert.ok(e instanceof InterruptError);
  assert.equal(executes().length, 0);
  assert.match(e.extra.human.join(' '), /before it sent anything/);
  neverUnsafe();
});

test('an interrupt after a key was typed, refusing the next guarded read at entry, does not say nothing was sent', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '' };
  dlog.length = 0;
  // keys: the first key is sent and answered, then the signal lands before the guarded read of the field.
  const e = await signalAfter((u, o) => u.endsWith('/execute/sync') && /"mobile: keys"/.test(o?.body), 'SIGTERM', () => failing(safari.keys(['ab'])));
  assert.ok(e instanceof InterruptError);
  assert.equal(executes().filter(b => b.script === 'mobile: keys').length, 1, 'one key was typed');
  assert.equal(dv.pages[PAGE].field.value, 'a');
  assert.match(e.extra.human.join(' '), /may still finish in the lab's tab/);
  assert.doesNotMatch(e.extra.human.join(' '), /before it sent anything/);
  neverUnsafe();
});

test('an interrupt while open puts the marker back parks the session native, keeps it, and does not taint the run', async () => {
  await startPhone();
  dlog.length = 0;
  // The re-mark's probe answers, then the signal lands before the context check after it.
  const e = await signalAfter((u, o) => u.endsWith('/execute/sync') && /document\.readyState !== \\"complete\\"/.test(o?.body), 'SIGTERM', () => failing(safari.open(['https://other.test/path'])));
  assert.ok(e instanceof InterruptError);
  assert.equal(e.extra.sessionKept, true);
  assert.equal(e.extra.tainted, false);
  assert.match(e.extra.human.join(' '), /may still finish in the lab's tab/);
  const s = seq();
  const probeAt = s.lastIndexOf('POST /execute/sync');
  assert.deepEqual(s.slice(probeAt), ['POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP', 'GET /context'], 'one read and one park after the probe, nothing else');
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.match(runLog(), /safari plant: interrupted by SIGTERM, not tainted/);
  neverUnsafe();
});

test('an interrupt while stop arms the close keeps the session record, sends no keyboard restore or delete, and does not report stopped', async () => {
  await startPhone();
  const before = loadState();
  dlog.length = 0;
  let out, e;
  await signalAfter((u, o) => u.endsWith('/execute/sync') && /window\.close/.test(o?.body), 'SIGTERM', async () => { try { out = await safari.stop([]); } catch (x) { e = x; } });
  assert.equal(out, undefined, 'not reported stopped');
  assert.ok(e instanceof InterruptError);
  assert.equal(e.extra.sessionKept, true);
  assert.match(e.extra.human.join(' '), /may still finish in the lab's tab/);
  assert.match(e.extra.human.join(' '), /run `safari stop` \(or `lab down`\) again/);
  assert.equal(dlog.filter(([m]) => m === 'DELETE').length, 0, 'no DELETE /session');
  assert.equal(settingsPosts().length, 0, 'no keyboard restore');
  assert.equal(dv.context, 'NATIVE_APP', 'parked');
  assert.equal(loadState().session, before.session, 'the session record stays');
  assert.ok(loadState().deviceTab, 'and so does the tab record');
  neverUnsafe();
});

test('F1 b: the next command while the queue is still blocked is refused as pending, untainted, before anything is selected', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  await failing(safari.eval(['1']));
  const before = loadState().deviceTab;
  dlog.length = 0;
  const e = await failing(safari.url([]));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.pending, true);
  assert.match(e.message, /^Appium is still waiting on a script the lab sent to its tab/, 'it waits behind the earlier script (#104)');
  assert.match(pauseSteps(e), /Switch back to the lab's tab/);
  assert.deepEqual(loadState().deviceTab, before, 'untainted');
  assert.deepEqual(seq(), ['GET /contexts'], 'the one read that got no answer; no select, no park, no script');
  ps.switchBack();
  assert.equal((await safari.url([])).title, 'Example', 'the same tab carries on');
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('F1 b2: a pre-select context read that gets no answer is pending too, and sends nothing more', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  dv.queue = []; // the queue is blocked before this command's first request
  const e = await failing(safari.eval(['1']));
  assert.equal(e.pending, true);
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(seq(), ['GET /contexts']);
  assert.equal(loadState().deviceTab.tainted, undefined);
  ps.switchBack();
  assert.equal((await safari.eval(['1'])).value, 1);
  neverUnsafe();
});

test('F1 d: a park that is answered but does not land in the native app taints the run', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  dv.onExecute = () => { dv.onExecute = null; dv.contextReads = [PAGE, PAGE]; }; // the read after the timeout, then the check after the park
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /the session did not return to the native app/);
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.match(pauseSteps(e), /fresh tab/);
  assert.doesNotMatch(pauseSteps(e), /Switch back/);
});

test('F1 e: a foreign context that can be read after a timeout taints the run, with and without a lock', async () => {
  for (const kind of ['reachable', 'locked']) {
    await startPhone(STOCK);
    noAnswerWhenParked();
    dv.hang = true;
    dv.onExecute = () => { dv.onExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
    const calls = phoneIs(kind);
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tab', kind);
    assert.match(e.message, /did not answer.*attached to another page/, kind);
    assert.doesNotMatch(e.message, /did not return/, kind);
    assert.deepEqual(loadState().deviceTab, tainted(), kind);
    assert.equal(calls.some(c => c.includes('lockState')), false, `${kind}: a move is not a lock`);
    assert.equal(dv.context, 'NATIVE_APP', kind);
    neverUnsafe();
  }
});

test('F1 j: a select of the lab\'s page that gets no answer is a pause too: untainted, nothing page-bound sent, and the next command works after switching back', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hangOnSelect = true;
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.timedOut, true);
  assert.match(e.message, /did not answer/);
  assert.match(pauseSteps(e), /Switch back to the lab's tab/);
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.deepEqual(seq(), ['GET /contexts', 'GET /context', `POST /context ${PAGE}`, 'GET /context', 'POST /context NATIVE_APP'], 'the select, then one read and one park');
  assert.equal(executes().length, 0, 'no script was sent');
  ps.switchBack();
  assert.equal(dv.context, 'NATIVE_APP');
  dlog.length = 0;
  assert.equal((await safari.eval(['1 + 1'])).value, 2);
  assert.deepEqual(seq(), GUARDED);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('F1 f: a lab tab that was navigated or replaced while the queue was blocked is found out by the next command, and a closed one is gone', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  await failing(safari.eval(['1']));
  assert.equal(loadState().deviceTab.tainted, undefined);
  dv.pages[PAGE].href = 'https://other.test/';
  dv.pages[PAGE].win.name = ''; // navigated away while nobody could look
  ps.switchBack();
  const e = await failing(safari.eval(['window.__ran = true; return 1']));
  assert.match(e.message, /no longer carries its marker/);
  assert.equal(dv.pages[PAGE].win.__ran, undefined);
  assert.deepEqual(loadState().deviceTab, tainted());
  neverUnsafe();

  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  await failing(safari.eval(['1']));
  delete dv.pages[PAGE]; // closed while nobody could look
  ps.switchBack();
  dlog.length = 0;
  const gone = await failing(safari.eval(['1']));
  assert.match(gone.message, /the lab's tab is gone/);
  assert.equal(gone.gone, true);
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.ok(!seq().some(l => l.startsWith('POST /context WEBVIEW')), 'nothing was selected');
  neverUnsafe();
});

// The first guarded call of each command, and for two of them the guarded call inside the page
// measurement (after the native tree was read): the queue blocks there.
const BLOCKED = [
  ['shot', ['x'], false], ['shot --page', ['x', '--page'], false], ['shot --element', ['x', '--element', '#go'], false], ['tap', ['#go'], false], ['swipe', ['up'], false],
  ['ui', [], false], ['keys', ['x'], false], ['eval', ['1'], false], ['url', [], false],
  ['shot --page (inside the measurement)', ['x', '--page'], true], ['tap (inside the measurement)', ['#go'], true],
];
test('F1 g: every command that reads or acts on the phone is refused as a pause when the queue blocks, and sends nothing to the screen, the page or the file system', async () => {
  for (const [label, args, inside] of BLOCKED) {
    await startPhone();
    noAnswerWhenParked();
    dv.pages[PAGE].els = { '#go': 1 };
    if (inside) dv.onNative = s => { if (s === 'mobile: source') { dv.onNative = null; dv.hang = 'queue'; } };
    else dv.hang = 'queue';
    const name = label.split(' ')[0];
    const e = await failing(safari[name](args));
    assert.equal(e.extra.needs, 'tab', label);
    assert.equal(e.timedOut, true, label);
    assert.doesNotMatch(e.message, /lost track/, label);
    assert.equal(loadState().deviceTab.tainted, undefined, `${label}: untainted`);
    const sent = dlog.filter(([, , b]) => typeof b?.script === 'string').map(([, , b]) => b.script);
    assert.equal(dlog.filter(([m, u]) => u.endsWith('/actions') || (m === 'GET' && u.endsWith('/screenshot'))).length, 0, `${label}: no action, no screenshot`);
    assert.ok(!sent.includes('mobile: tap') && !sent.includes('mobile: keys'), `${label}: no tap, no key`);
    if (!inside) assert.ok(!sent.includes('mobile: source'), `${label}: the screen was not read`);
    assert.ok(!sent.some(s => PROBE_REMOVED.test(s)), `${label}: nothing was sent to the lab's page while blocked`);
    assert.deepEqual(fs.readdirSync(loadState().run).filter(f => /\.(png|xml)$/.test(f)), [], `${label}: no file`);
    const s = seq();
    const last = s.lastIndexOf('POST /execute/sync');
    assert.deepEqual(s.slice(last + 1), ['GET /context', 'POST /context NATIVE_APP'], `${label}: after the script that got no answer, one read and one park`);
    ps.switchBack();
    assert.equal((await safari.url([])).title, 'Example', `${label}: the same tab carries on`);
    neverUnsafe();
  }
});

test('F1 g2: the calibration probe left behind by a refused command is removed by the next one before its own is placed', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.pages[PAGE].els = { '#go': 1 };
  dv.onNative = s => { if (s === 'mobile: source') { dv.onNative = null; dv.hang = 'queue'; } };
  await failing(safari.tap(['#go']));
  ps.switchBack();
  assert.ok(dv.pages[PAGE].probeLabel, 'the probe is still in the page: nothing was sent to remove it');
  assert.equal(dv.pages[PAGE].probesCleared, undefined);
  await safari.tap(['#go']);
  assert.equal(dv.pages[PAGE].probesCleared, 1, 'the leftover was removed by the next probe');
  assert.equal(dv.pages[PAGE].probeLabel, null);
  neverUnsafe();
});

test('F1 h: a driver error on the script names its code and is not reported as a missing answer', async () => {
  await startPhone();
  dv.executeFails = 'unknown error';
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /could not run the script \(unknown error\)/);
  assert.doesNotMatch(e.message, /did not answer/);
  assert.equal(e.timedOut, undefined);
  assert.equal(loadState().deviceTab.tainted, undefined, 'the context stayed on the lab\'s page or the native app');
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('F1 i: a locked phone behind a blocked queue is needs "unlock", untainted, and works after unlocking and switching back', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  const calls = phoneIs('locked');
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'unlock');
  assert.equal(e.skipArtifacts, true);
  assert.ok(calls.some(c => c.includes('lockState') && c.includes(PU)));
  assert.equal(loadState().deviceTab.tainted, undefined);
  phoneIs();
  ps.switchBack();
  assert.equal((await safari.eval(['1'])).value, 1);
  neverUnsafe();
});

test('click on an element that is gone reports the page\'s "no such element", not a tab refusal', async () => {
  await startPhone();
  dv.hangOnThrow = true;
  dv.pages[PAGE].els = { a: 1 };
  dv.beforeExecute = s => { if (/el\.click\(\)/.test(s)) dv.pages[PAGE].els = {}; };
  const e = await failing(safari.click(['a']));
  assert.match(e.message, /no such element/);
  assert.equal(e.extra, undefined);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('a page exception while the context moved still taints the run', async () => {
  await startPhone(STOCK);
  dv.hangOnThrow = true;
  dv.afterExecute = () => { dv.afterExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
  const e = await failing(safari.eval(['null.x']));
  assert.equal(e.extra.needs, 'tab');
  assert.doesNotMatch(e.message, /the page script threw/, 'the moved page\'s result is discarded');
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.context, 'NATIVE_APP');
});

test('eval checks the syntax in Node first and makes no phone call for a script that cannot parse', async () => {
  await startPhone();
  const e = await failing(safari.eval(['foo(']));
  assert.match(e.message, /^eval: syntax error: /);
  assert.equal(e.extra, undefined);
  assert.equal(dlog.length, 0, 'zero requests');
  assert.equal(loadState().deviceTab.tainted, undefined);
  // A body with several statements and a return is still fine.
  assert.equal((await safari.eval(['const a = 1; return a + 1'])).value, 2);
  neverUnsafe();
});

test('the native actions need the lab\'s tab showing, and send nothing to the screen when it is not', async () => {
  await startPhone();
  dv.pages[PAGE].visible = false;
  for (const [name, args] of Object.entries({ tap: ['a'], keys: ['x'], swipe: ['up'], shot: [], ui: [] })) {
    dlog.length = 0;
    const e = await failing(safari[name](args));
    assert.equal(e.extra.needs, 'tab', name);
    assert.match(e.message, /not the one showing/, name);
    assert.deepEqual(dlog.filter(([, u, b]) => /\/(screenshot|actions)$/.test(u) || b?.script?.startsWith('mobile:')), [], `${name}: nothing sent to the screen`);
    assert.equal(executes().length, 1, `${name}: only the visibility check`);
    assert.match(executes()[0].script, /visibilityState/);
    assert.doesNotMatch(executes()[0].script, /hasFocus/);
  }
  neverUnsafe();
});

test('shot and ui work while the tab is showing; a shot is checked before and after and not kept when the tab left', async () => {
  await startPhone();
  const ui = await safari.ui();
  assert.ok(fs.existsSync(ui.file));
  const shot = await safari.shot(['one']);
  assert.ok(fs.existsSync(shot.file));
  assert.equal(executes().filter(b => /visibilityState/.test(b.script)).length, 4); // ui before and after, shot before and after
  dlog.length = 0;
  let checks = 0;
  dv.onExecute = page => { if (++checks === 2) page.visible = false; }; // the tab goes away while the picture is taken
  const e = await failing(safari.shot(['two']));
  assert.equal(e.extra.needs, 'tab');
  assert.ok(seq().includes('GET /screenshot'));
  assert.deepEqual(fs.readdirSync(loadState().run).filter(f => /^two.*\.png$/.test(f)), []);
  // The same for the native tree: it holds the page's text, so it is dropped when the tab left during the read.
  checks = 0;
  const before = fs.readdirSync(loadState().run).filter(f => f.endsWith('.xml')).length;
  const e2 = await failing(safari.ui());
  assert.equal(e2.extra.needs, 'tab');
  assert.equal(fs.readdirSync(loadState().run).filter(f => f.endsWith('.xml')).length, before);
  neverUnsafe();
});

test('open replaces the lab\'s own page, never POSTs /url, and puts the marker back on the new origin', async () => {
  await startPhone();
  const out = await safari.open(['https://other.test/path?x=1']);
  assert.equal(out.url, 'https://other.test/path?x=1');
  const replace = executes().find(b => /location\.replace\(arguments\[0\]\)/.test(b.script));
  assert.deepEqual(replace.args, ['https://other.test/path?x=1']);
  const probe = probes()[0];
  assert.ok(probe, 'the new document is probed once it is complete');
  assert.match(probe.script, /if \(!\(location\.origin === "https:\/\/other\.test" \|\| location\.origin === "https:\/\/www\.other\.test"\)\) return false; return \[performance\.timeOrigin, location\.origin, window\.name === /, 'the probe is read-only and only accepts the origins asked for');
  assert.doesNotMatch(probe.script, /window\.name = |__mslPlant/, 'the probe writes nothing');
  assert.equal(marks().length, 1);
  const T = dv.pages[PAGE].origin;
  assert.ok(marks()[0].script.startsWith(`if (performance.timeOrigin !== ${T}) return null; if (!(location.origin === "https://other.test" || location.origin === "https://www.other.test")) return false; window.name = `), 'the marker goes only into the document that was probed, and only on the origins asked for');
  const tab = loadState().deviceTab;
  assert.equal(dv.pages[PAGE].win.name, tab.token);
  assert.equal(tab.origin, 'https://other.test');
  assert.deepEqual(tab.origins, ['https://example.com', 'https://other.test']);
  assert.equal(dv.pages[PAGE].hist, 1);
  assert.equal(dv.context, 'NATIVE_APP');
  await safari.eval(['1']); // still guarded and working afterwards
  neverUnsafe();
});

// #104: a page that is loading is busy, so the scripts of a navigation the lab started get the navigation's budget, not tabMs.
const DOC_READ = /performance\.timeOrigin, document\.readyState, location\.href/;

test('open on the phone waits past tabMs for a busy page\'s reads, up to the navigation\'s budget (#104)', async () => {
  await startPhone();
  WAIT.tabMs = 40;
  WAIT.timeoutMs = 2000;
  dv.delay = s => (DOC_READ.test(s) || /location\.replace/.test(s) ? 120 : 0); // the old page and the new one answer late
  const out = await safari.open(['https://other.test/path']);
  assert.equal(out.url, 'https://other.test/path');
  assert.equal(loadState().deviceTab.origin, 'https://other.test');
  assert.equal(loadState().deviceTab.waitingSince, undefined);
  neverUnsafe();
});

test('the marker is put back on a busy page whose probe answers past tabMs (#104)', async () => {
  await startPhone();
  WAIT.tabMs = 40;
  WAIT.timeoutMs = 2000;
  dv.delay = s => (/return \[performance\.timeOrigin, location\.origin, window\.name === /.test(s) ? 120 : 0);
  await safari.open(['https://other.test/']);
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token);
  neverUnsafe();
});

test('a navigation\'s page script still gives up at the navigation\'s budget (#104)', async () => {
  await startPhone();
  noAnswerWhenParked();
  WAIT.tabMs = 40;
  WAIT.timeoutMs = 150;
  dv.hang = true;
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /did not answer within/);
});

test('after a script got no answer the next command says Appium is still waiting on it, and a command that works clears that (#104)', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = 'queue';
  const first = await failing(safari.eval(['1']));
  assert.match(first.message, /it is not the one showing, Safari paused it, or the page is busy/);
  const since = loadState().deviceTab.waitingSince;
  assert.match(since, /^\d{4}-\d\d-\d\dT/, 'the time of the script that got no answer is kept');
  assert.match(runLog(), /safari guard: no answer within 10s, not tainted/);
  const e = await failing(safari.url([]));
  assert.equal(e.pending, true);
  assert.match(e.message, /^Appium is still waiting on a script the lab sent to its tab \d+s ago, which got no answer: the page is busy, or the tab is not showing\. Nothing else runs until it answers; if it has not within a minute, run `safari start`/);
  assert.equal(loadState().deviceTab.waitingSince, since, 'still the first script\'s time');
  ps.switchBack();
  assert.equal((await safari.url([])).title, 'Example');
  assert.equal(loadState().deviceTab.waitingSince, undefined, 'cleared once a command worked');
  neverUnsafe();
});

test('open accepts the www / no-www twin and the https upgrade of the address asked for: the final origin is reported and remembered', async () => {
  await startPhone();
  dv.redirect = { 'a.test': 'www.a.test' };
  const out = await safari.open(['https://a.test/start']);
  assert.equal(out.finalUrl, 'https://www.a.test/start');
  const tab = loadState().deviceTab;
  assert.equal(tab.origin, 'https://www.a.test');
  assert.deepEqual(tab.origins, ['https://example.com', 'https://a.test', 'https://www.a.test']);
  assert.equal(dv.pages[PAGE].win.name, tab.token);
  await safari.eval(['1']);
  dv.redirect = { 'www.b.test': 'b.test' }; // the other way round
  assert.equal((await safari.open(['https://www.b.test/'])).finalUrl, 'https://b.test/');
  dv.upgradeHttps = true;
  assert.equal((await safari.open(['http://c.test/'])).finalUrl, 'https://c.test/');
  assert.equal(loadState().deviceTab.origin, 'https://c.test');
  await safari.eval(['1']);
  neverUnsafe();
});

test('open refuses a redirect to any other site: the marker is never written there, the run is tainted, and the other site is not named', async () => {
  await startPhone();
  const { token } = loadState().deviceTab;
  dv.redirect = { 'a.test': 'private.test' };
  dlog.length = 0;
  const e = await failing(safari.open(['https://a.test/start']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /the tab did not end on https:\/\/a\.test; open the final address directly/);
  assert.doesNotMatch(JSON.stringify([e.message, e.extra, e.stack?.split('\n')[0]]), /private\.test/);
  assert.equal(dv.pages[PAGE].href, 'https://private.test/start', 'the tab did land there');
  assert.equal(dv.pages[PAGE].win.name, '', 'the token is not in that page');
  assert.ok(Object.values(dv.pages).every(p => p.win.name !== token), 'the token is in no page');
  assert.deepEqual(loadState().deviceTab, tainted('https://a.test'));
  assert.equal(dv.context, 'NATIVE_APP');
  const probeAt = executes().findIndex(b => PROBE.test(b.script));
  assert.equal(executes().length, probeAt + 1, 'nothing was sent to the phone after the probe');
  assert.equal(marks().length, 0, 'the marking script was never sent');
  neverUnsafe();
});

test('refresh reloads the lab\'s own page and plants the marker again', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  dlog.length = 0;
  const out = await safari.refresh([]);
  assert.equal(out.url, 'https://other.test/');
  assert.ok(executes().some(b => /location\.reload\(\)/.test(b.script)));
  assert.match(probes()[0].script, /if \(!\(location\.origin === "https:\/\/other\.test"\)\) return false;/, 'a reload may only end where the tab was');
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token);
  neverUnsafe();
});

test('device console reads the in-page collector installed after open, never Safari\'s console log', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  assert.ok(Array.isArray(dv.pages[PAGE].win.__mslConsole), 'the collector is installed after open');
  dv.pages[PAGE].win.__mslConsole.push({ level: 'error', t: 1, text: 'boom at https://other.test/cb?code=SECRETC' });
  const out = await safari.console();
  assert.deepEqual(out.entries, [{ level: 'error', text: 'boom at https://other.test/cb?code=[redacted]' }]);
  assert.deepEqual((await safari.console()).entries, [], 'read once, then cleared');
  assert.ok(!fs.readFileSync(out.file, 'utf8').includes('SECRETC'));
  neverUnsafe();
});

// The phone's network: the lab page's own Resource Timing, read through the tab guard. Appium's network log (every tab's traffic) is never asked for.
const res = (url, extra = {}) => ({ name: url, entryType: 'resource', initiatorType: 'fetch', startTime: 10, duration: 5, transferSize: 300, encodedBodySize: 200, decodedBodySize: 500, responseStatus: 200, nextHopProtocol: 'h2', ...extra });
const FOREIGN = 'https://private.test/inbox?id=7';
const keysOf = o => Object.keys(o).sort();
const NET_KEYS = ['decodedBodySize', 'duration', 'encodedBodySize', 'initiatorType', 'name', 'nextHopProtocol', 'responseStatus', 'startTime', 'transferSize'];
const NET_READ = /splice\(0, 500\)/;
const runFiles = () => { const dir = loadState().run; return fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]); };

test('device network reads the lab page\'s Resource Timing, keeps the sites the tab visited, and only counts the rest', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  const page = dv.pages[PAGE];
  assert.ok(page.win.__mslNet, 'the collector is installed after open');
  addResource(page, res('https://other.test/api?id=1'));
  addResource(page, res('https://other.test/app.js', { initiatorType: 'script' }));
  addResource(page, res('https://example.com/x?x=1', { responseStatus: 404 }));
  const foreign = [FOREIGN, 'https://tracker.example/pixel', 'data:text/html,hi', 'blob:https://other.test/abc', 'not a url', 'https://user:pw@other.test/cred', `https://other.test/${'a'.repeat(9000)}`];
  for (const u of foreign) addResource(page, res(u));
  const out = await safari.network();
  assert.deepEqual(out.requests, [
    { method: null, url: 'https://other.test/', status: 200 },
    { method: null, url: 'https://other.test/api?id=1', status: 200 },
    { method: null, url: 'https://other.test/app.js', status: 200 },
    { method: null, url: 'https://example.com/x?x=1', status: 404 },
  ]);
  assert.equal(out.count, 4);
  assert.equal(out.outside, 7);
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.origins, ['https://example.com', 'https://other.test']);
  for (const k of ['copies', 'truncated', 'lost', 'early', 'note']) assert.equal(out[k], undefined, k);
  const entries = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  assert.equal(entries.length, 4);
  assert.deepEqual(keysOf(entries[1]), NET_KEYS);
  assert.deepEqual(entries[1], { name: 'https://other.test/api?id=1', initiatorType: 'fetch', startTime: 10, duration: 5, transferSize: 300, encodedBodySize: 200, decodedBodySize: 500, responseStatus: 200, nextHopProtocol: 'h2' });
  for (const [f, text] of [['out', JSON.stringify(out)], ...runFiles()]) assert.doesNotMatch(text, /private\.test|tracker\.example|data:text|blob:|user:pw|aaaaaaaa/, f);
  assert.deepEqual(dlog.filter(([, u]) => u.endsWith('/se/log')), [], 'Appium\'s network log is never asked for');
  neverUnsafe();
});

test('device network gives what came since the last call, and a refresh installs the collector on the new document', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  const page = dv.pages[PAGE];
  addResource(page, res('https://other.test/a'));
  assert.deepEqual((await safari.network()).requests.map(r => r.url), ['https://other.test/', 'https://other.test/a']);
  const none = await safari.network();
  assert.equal(none.count, 0);
  assert.deepEqual(none.requests, []);
  addResource(page, res('https://other.test/b'));
  assert.deepEqual((await safari.network()).requests.map(r => r.url), ['https://other.test/b']);
  await safari.refresh([]);
  assert.ok(page.win.__mslNet, 'installed again after refresh');
  addResource(page, res('https://other.test/c'));
  assert.deepEqual((await safari.network()).requests.map(r => r.url), ['https://other.test/', 'https://other.test/c'], 'the old document\'s entries are not repeated');
  neverUnsafe();
});

test('device network rebuilds each entry from an allowlist, in the page and again in Node', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  const page = dv.pages[PAGE];
  addResource(page, res('https://other.test/ok', { serverTiming: [{ description: FOREIGN }], workerStart: 1, secret: FOREIGN, contentType: FOREIGN }));
  assert.deepEqual(keysOf(page.win.__mslNet.entries.at(-1)), NET_KEYS, 'the page copies nine fields and nothing else');
  // A page that tampers with its own answer: wrong types, extra fields, junk entries, junk counters.
  const forged = {
    entries: [
      { ...res('https://other.test/forged'), extra: FOREIGN, serverTiming: [FOREIGN], initiatorType: FOREIGN, nextHopProtocol: FOREIGN, startTime: '1', duration: { v: 1 }, transferSize: null, responseStatus: '200' },
      5, null, 'str', { name: 5 }, { name: { href: 'https://other.test/x' } }, [],
    ],
    left: -1, lost: 'many', early: 'yes', unsupported: 1,
  };
  dv.mapResult = (value, s) => (NET_READ.test(s) ? { ...value, v: forged } : value); // the guard's envelope stays; the page's answer is replaced
  const out = await safari.network();
  assert.equal(out.count, 1);
  assert.equal(out.outside, 6);
  const [e] = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  assert.deepEqual(keysOf(e), NET_KEYS);
  assert.deepEqual(e, { name: 'https://other.test/forged', initiatorType: null, startTime: null, duration: null, transferSize: null, encodedBodySize: 200, decodedBodySize: 500, responseStatus: null, nextHopProtocol: null });
  assert.deepEqual(out.requests, [{ method: null, url: 'https://other.test/forged', status: null }]);
  for (const k of ['truncated', 'lost', 'early']) assert.equal(out[k], undefined, `${k}: a counter that is not a count is ignored`);
  assert.doesNotMatch(JSON.stringify(out) + fs.readFileSync(out.file, 'utf8'), /private\.test/);
  // Answers that are not even the right shape give nothing and do not throw; at most 500 entries are looked at.
  for (const answer of ['text', 7, { entries: 'x' }, { entries: {} }, {}]) {
    dv.mapResult = (value, s) => (NET_READ.test(s) ? { ...value, v: answer } : value);
    const o = await safari.network();
    assert.equal(o.count, 0);
    assert.equal(o.outside, 0);
  }
  dv.mapResult = (value, s) => (NET_READ.test(s) ? { ...value, v: { entries: Array.from({ length: 5000 }, (_, i) => res(`https://other.test/${i}`)), left: 4500 } } : value);
  const many = await safari.network();
  assert.equal(many.count, 500);
  assert.equal(many.truncated, true);
  neverUnsafe();
});

test('device network masks secret query and fragment values in what it prints and writes', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  addResource(dv.pages[PAGE], res('https://other.test/cb?token=SECRETN&a=1&code=SECRETC#access_token=SECRETH'));
  const out = await safari.network();
  assert.equal(out.requests[1].url, 'https://other.test/cb?token=[redacted]&a=1&code=[redacted]#access_token=[redacted]');
  for (const [f, text] of [['out', JSON.stringify(out)], ...runFiles()]) assert.doesNotMatch(text, /SECRETN|SECRETC|SECRETH/, f);
  neverUnsafe();
});

// 300 switches of 7 requests each: slow by design when every request takes long (about 6 minutes at 80 ms), so it gets its own limit.
test('device network still lists the page\'s requests, once each, after hundreds of context switches', { timeout: 600e3 }, async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  const page = dv.pages[PAGE];
  for (let i = 0; i < 30; i++) addResource(page, res(`https://other.test/r${i}`));
  for (let i = 0; i < 300; i++) await safari.url([]); // every one of them is a switch into the page and back
  const out = await safari.network();
  assert.equal(out.count, 31);
  assert.equal(new Set(out.requests.map(r => r.url)).size, 31, 'no entry is repeated');
  for (const k of ['copies', 'truncated', 'lost']) assert.equal(out[k], undefined, k);
  assert.deepEqual(dlog.filter(([, u]) => u.endsWith('/se/log')), [], 'no Appium log call at all');
  neverUnsafe();
});

test('device network reads 500 entries at a time, says more are waiting, and counts what the page\'s own 2000-entry buffer dropped', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  const page = dv.pages[PAGE];
  for (let i = 0; i < 1200; i++) addResource(page, res(`https://other.test/r${i}`));
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const o = await safari.network();
    sizes.push([o.count, o.truncated === true]);
  }
  assert.deepEqual(sizes, [[500, true], [500, true], [201, false]]);
  // More than the page keeps: the nav entry and 1999 resources are held, the other 101 are only counted.
  for (let i = 0; i < 2100; i++) addResource(page, res(`https://other.test/s${i}`));
  const first = await safari.network();
  assert.equal(first.count, 500);
  assert.equal(first.truncated, true);
  assert.equal(first.lost, 2100 - 2000);
  assert.equal((await safari.network()).lost, undefined, 'lost is reported once');
  neverUnsafe();
});

test('device network installs the collector when nothing opened since the session started, flags a full replay as early, and says when Safari has no observer', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  const page = dv.pages[PAGE];
  delete page.win.__mslNet;
  page.observers = [];
  page.resources = Array.from({ length: 260 }, (_, i) => res(`https://other.test/old${i}`));
  const first = await safari.network();
  assert.equal(first.count, 0);
  assert.match(first.note, /was not installed yet/);
  const second = await safari.network();
  assert.equal(second.count, 261);
  assert.equal(second.early, true);
  assert.equal((await safari.network()).early, undefined, 'early is reported once');
  delete page.win.__mslNet;
  page.noObserver = true;
  await safari.network();
  assert.match((await safari.network()).note, /does not offer the Resource Timing observer/);
  neverUnsafe();
});

test('device network goes through the tab guard: a tainted run refuses it without a request, and the timing buffer is never resized or cleared', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  assert.ok(executes().every(b => !/setResourceTimingBufferSize|clearResourceTimings/.test(b.script)));
  saveState({ deviceTab: { tainted: true, tag: dv.tag } });
  dlog.length = 0;
  const e = await failing(safari.network());
  assert.equal(e.extra.needs, 'tab');
  assert.equal(dlog.length, 0);
});

test('closing: a tab alone in its history is closed by a timer in the page after the session went native, then the session is deleted', async () => {
  await startPhone();
  await safari.open(['https://other.test/']);
  dlog.length = 0;
  const out = await safari.stop();
  assert.deepEqual(out, { stopped: true, tabClosed: true, keyboardRestored: true });
  assert.equal(dv.pages[PAGE], undefined);
  assert.equal(dv.closedWhile, 'NATIVE_APP', 'the page went away only while the session was native');
  assert.equal(dv.pages[OTHER].driverRuns, 0, 'so the driver never ran anything in the owner\'s tab');
  const scripts = executes().map(b => b.script);
  assert.equal(scripts.length, 1, 'one guarded script both checks the history and arms the close');
  assert.match(scripts[0], /history\.length !== 1/);
  assert.match(scripts[0], new RegExp(`setTimeout\\(function \\(\\) \\{ window\\.close\\(\\); \\}, ${WAIT.closeDelayMs}\\)`));
  const l = seq();
  const arm = l.indexOf('POST /execute/sync');
  assert.deepEqual(l.slice(arm, arm + 3), ['POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP'], 'native right after the script');
  assert.deepEqual(l.slice(arm + 3).filter(x => x.startsWith('POST /context')), [], 'never back in a page');
  assert.ok(l.lastIndexOf('POST /context NATIVE_APP') < l.indexOf('DELETE /session'), 'parked native before the session ends');
  assert.ok(l.indexOf('GET /contexts', arm + 3) < l.indexOf('DELETE /session'));
  assert.equal(l.at(-1), 'DELETE /session');
  const st = loadState();
  assert.equal(st.session, undefined);
  assert.equal(st.deviceTab, undefined);
  neverUnsafe();
});

test('closing: an arm reply slower than the close timer is a race: the run is not trusted, the tab is not touched again, and the person is told', async () => {
  await startPhone();
  WAIT.closeDelayMs = 30;
  Object.assign(CLOCK, REAL_CLOCK); // the race is real time: the reply is delayed past the timer
  dv.closeWorks = false; // the timer fires and nothing closes
  dv.delay = s => (/setTimeout/.test(s) ? 90 : 0); // the answer to the arming script comes after the timer was due
  const out = await safari.stop();
  assert.equal(out.closeRace, true);
  assert.equal(out.tabClosed, false);
  assert.equal(out.tabLeft, 'lab');
  assert.equal(out.blanked, undefined);
  assert.match(out.human[0], /longer to leave its tab than the close timer/);
  assert.match(out.human.at(-1), /by hand/);
  assert.ok(!executes().some(b => /about:blank/.test(b.script) && !/history\.length/.test(b.script)), 'nothing was sent to the tab after the arm');
  assert.equal(dv.pages[PAGE].href.startsWith('https://example.com'), true);
  assert.equal(loadState().session, undefined);
});

test('closing: a timer that fires before the session left the page is reported as a race, not as a closed tab', async () => {
  await startPhone(STOCK);
  WAIT.closeDelayMs = 30;
  Object.assign(CLOCK, REAL_CLOCK); // the race is real time: the reply is delayed past the timer
  dv.delay = s => (/setTimeout/.test(s) ? 90 : 0);
  const out = await safari.stop();
  assert.equal(out.closeRace, true);
  assert.equal(out.tabClosed, false, 'the lab cannot say what happened to the tab');
  assert.match(out.human.at(-1), /by hand/);
  assert.equal(dv.pages[OTHER].win.name, 'owner-state');
  assert.equal(dv.pages[OTHER].runs, 0, 'no lab script ran in the owner\'s tab');
  assert.equal(dv.pages[OTHER].driverRuns, 1, 'only the driver\'s own check did: this is the harm the delay avoids');
  assert.equal(loadState().session, undefined);
});

test('closing: a tab with more history is blanked, not closed, and the person is told', async () => {
  await startPhone();
  dv.pages[PAGE].hist = 3;
  const out = await safari.stop();
  assert.equal(out.tabClosed, false);
  assert.equal(out.blanked, true);
  assert.equal(out.tabLeft, 'blank');
  assert.match(out.human[0], /blank/);
  assert.equal(dv.pages[PAGE].href, 'about:blank');
  assert.equal(dv.closedWhile, undefined, 'no close was armed');
  assert.equal(loadState().session, undefined);
  neverUnsafe();
});

test('closing: a tab that will not close (the timer never works) is blanked after the wait', async () => {
  await startPhone();
  dv.closeWorks = false;
  // The wait runs on a clock the stand-in drives (a poll of the contexts after the arm script ran takes closePollMs), not the wall
  // clock: a slow arm reply is not a race, and the wait is not a real 650 ms.
  let t = 0, armed = false;
  CLOCK.now = () => t;
  CLOCK.sleep = async () => {};
  dv.onExecute = () => { armed = true; };
  dv.onContexts = () => { if (armed) t += WAIT.closePollMs; };
  const out = await safari.stop();
  assert.equal(out.tabClosed, false);
  assert.equal(out.blanked, true);
  assert.equal(out.tabLeft, 'blank');
  assert.match(out.human[0], /would not close/);
  assert.equal(out.closeRace, undefined);
  assert.equal(dv.pages[PAGE].href, 'about:blank');
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('closing: a tab that cannot be verified is left alone, the session still ends, and the person is told', async () => {
  for (const spoil of [p => { p.win.name = ''; }, p => { p.win.name = 'x'; }]) {
    await startPhone();
    spoil(dv.pages[PAGE]);
    const out = await safari.stop();
    assert.equal(out.tabClosed, false);
    assert.equal(out.tabLeft, 'lab');
    assert.equal(out.blanked, undefined);
    assert.match(out.human[0], /by hand/);
    assert.equal(dv.closedWhile, undefined, 'nothing armed a close');
    assert.ok(!dv.pages[PAGE] || dv.pages[PAGE].href.startsWith('https://example.com'), 'the page was not touched');
    assert.ok(seq().includes('DELETE /session'));
    assert.equal(loadState().session, undefined);
    assert.equal(loadState().deviceTab, undefined);
    neverUnsafe();
  }
});

test('closing: a tab that was already gone is explained as gone, not as a close race, even if the driver was elsewhere', async () => {
  for (const driverAt of ['NATIVE_APP', OTHER]) {
    await startPhone();
    delete dv.pages[PAGE];
    dv.context = driverAt; // a failed park may have left the driver in the owner's tab
    const out = await safari.stop();
    assert.equal(out.closeRace, undefined, driverAt);
    assert.equal(out.tabGone, true, driverAt);
    assert.equal(out.tabClosed, false, driverAt);
    assert.equal(out.tabLeft, undefined, driverAt);
    assert.equal(out.human.length, 1);
    assert.match(out.human[0], /already gone before the lab could close it/);
    assert.doesNotMatch(out.human.join(' '), /close timer/);
    assert.equal(dv.closedWhile, undefined, 'nothing armed a close');
    assert.equal(dv.pages[OTHER].runs, 0);
    assert.ok(seq().includes('DELETE /session'));
    assert.equal(loadState().session, undefined);
    neverUnsafe();
  }
});

test('endDeviceSession is the shared way out: the tab first, and a second call has no tab left to touch', async () => {
  await startPhone();
  assert.deepEqual(await endDeviceSession(), { tabClosed: true, keyboardRestored: true });
  assert.equal(loadState().deviceTab, undefined);
  dlog.length = 0;
  // The record is still there (callers clear it), but the session is gone: nothing can be restored through it.
  // Why the restore failed is a field of the JSON (`keyboardNote`), not a line on stderr.
  const gone = { tabClosed: false, keyboardRestored: false, human: [phoneLib.KEYBOARD_HUMAN] };
  const notes = [];
  const note = (out, extra = {}) => { const { keyboardNote, ...rest } = out; notes.push(keyboardNote); assert.deepEqual(rest, { ...extra, ...gone }); };
  const stderr = await quietly(async () => {
    note(await endDeviceSession());
    assert.equal(executes().length, 0);
    assert.ok(!seq().some(l => l.startsWith('POST /context')));
    note(await safari.stop(), { stopped: true });
  });
  assert.deepEqual(stderr.filter(l => /keyboard/.test(l)), [], 'no keyboard line on stderr (the "ending the session" warning is another path)');
  for (const n of notes) assert.match(n, /^restoring the keyboard settings: /);
});

// --- the keyboard settings: WebDriverAgent turns Auto-Correction and Predictive off; the lab sets them back ---

const KB_POST = 'POST /appium/settings';
const keyboardCalls = () => dlog.filter(([m, u, b]) => u.endsWith('/appium/settings') && (m === 'GET' || Object.keys(b.settings).some(k => k.startsWith('keyboard'))));
const quietly = async fn => { // the stderr warnings of fn
  const real = console.error, notes = [];
  console.error = m => notes.push(m);
  try { await fn(); } finally { console.error = real; }
  return notes;
};

test('a device session leaves the keyboard settings off while it runs and marks the restore as pending', async () => {
  await startPhone();
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: false, keyboardPrediction: false });
  assert.equal(loadState().keyboardPending, true);
  assert.deepEqual(keyboardCalls(), [], 'nothing restores them before the session ends');
});

test('safari stop sets the keyboard settings back to on (the default) before DELETE /session, reads them back, and clears the mark', async () => {
  await startPhone();
  const out = await safari.stop();
  assert.equal(out.keyboardRestored, true);
  assert.equal(out.human, undefined);
  const l = seq();
  const post = l.indexOf(KB_POST), get = l.indexOf('GET /appium/settings'), del = l.indexOf('DELETE /session');
  assert.ok(post >= 0 && post < get && get < del, l.join(', '));
  assert.deepEqual(keyboardCalls().map(([m, , b]) => [m, b]), [['POST', { settings: { keyboardAutocorrection: true, keyboardPrediction: true } }], ['GET', undefined]]);
  assert.deepEqual(l.slice(post, del + 1), [KB_POST, 'GET /appium/settings', 'DELETE /session'], 'a native call and nothing else: no page, no context, no navigation');
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: true, keyboardPrediction: true }, 'the phone really has them on');
  assert.equal(loadState().keyboardPending, undefined);
  neverUnsafe();
});

test('the saved restore target is honoured, including off, and a bad keyboard field in the record falls back to on', async () => {
  await startPhone();
  saveState({ phone: { ...PHONE, keyboard: { autocorrection: false, prediction: true } } });
  assert.equal((await safari.stop()).keyboardRestored, true);
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: false, keyboardPrediction: true });
  assert.deepEqual(keyboardCalls()[0][2], { settings: { keyboardAutocorrection: false, keyboardPrediction: true } });

  await startPhone();
  saveState({ phone: { ...PHONE, keyboard: { autocorrection: 'off' } } }); // damaged: ending the session must still restore
  assert.equal((await safari.stop()).keyboardRestored, true);
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: true, keyboardPrediction: true });
});

test('a restore that fails (refused, late, or not taken by the phone) is reported with the human step, masked, and the teardown still finishes', async () => {
  const real = WAIT.restoreMs;
  try {
    for (const [name, spoil] of [
      ['refused', () => { ps.fx.keyboardFail = 'refused for 00008000-000A1B2C3D4E5F60'; }],
      ['timed out', () => { WAIT.restoreMs = 100; ps.fx.keyboardDelayMs = 600; }],
      ['not taken', () => { ps.fx.keyboardIgnored = true; }],
    ]) {
      await startPhone();
      spoil();
      let out;
      const notes = await quietly(async () => { out = await safari.stop(); });
      assert.equal(out.stopped, true, name);
      assert.equal(out.tabClosed, true, name);
      assert.equal(out.keyboardRestored, false, name);
      assert.deepEqual(out.human, [phoneLib.KEYBOARD_HUMAN], name);
      assert.equal(out.human[0], 'Turn Auto-Correction and Predictive back on in Settings > General > Keyboard.');
      assert.ok(seq().includes('DELETE /session'), `${name}: the session was still deleted`);
      assert.equal(loadState().session, undefined, name);
      assert.equal(loadState().keyboardPending, true, `${name}: still pending, so \`lab down\` can say so`);
      assert.deepEqual(notes, [], `${name}: nothing on stderr`);
      assert.match(out.keyboardNote, /^restoring the keyboard settings: /, name);
      assert.doesNotMatch(out.keyboardNote, /00008000-000A1B2C3D4E5F60/, `${name}: masked`);
      neverUnsafe();
      await new Promise(r => setTimeout(r, 700)); // let a late answer land before the next round
    }
  } finally { WAIT.restoreMs = real; }
});

test('a tainted session still restores the keyboard (it is not a page command), and touches no page', async () => {
  await startPhone();
  saveState({ deviceTab: tainted() });
  const out = await safari.stop();
  assert.equal(out.keyboardRestored, true);
  assert.equal(executes().length, 0);
  const l = seq();
  assert.ok(l.indexOf(KB_POST) >= 0 && l.indexOf(KB_POST) < l.indexOf('DELETE /session'));
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: true, keyboardPrediction: true });
  neverUnsafe();
});

test('ending a session whose tunnel is gone waits only 3 s for the delete (#62)', () => {
  assert.equal(WAIT.deadDeleteMs, 3e3);
  assert.ok(WAIT.deadDeleteMs < WAIT.staleMs);
});

test('safari start replacing a tainted session restores the keyboard before it deletes the old one, then marks the new one pending', async () => {
  await startPhone();
  saveState({ deviceTab: tainted() });
  phoneIs();
  const out = await safari.start(['--device', PU]);
  assert.equal(out.recovered, true);
  assert.equal(out.keyboardRestored, true);
  assert.deepEqual(out.human, out.previousTab.human, 'a verified restore needs no human step; the old tab\'s is there (#103)');
  const l = seq();
  assert.ok(l.indexOf(KB_POST) >= 0 && l.indexOf(KB_POST) < l.indexOf('DELETE /session'), l.join(', '));
  assert.ok(l.indexOf('DELETE /session') < l.indexOf('POST /session'));
  assert.equal(loadState().keyboardPending, true, 'the new session turned them off again');
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: false, keyboardPrediction: false });
  neverUnsafe();
});

test('safari start replacing a tainted session whose restore fails says what to do by hand, and keeps the previous tab note', async () => {
  await startPhone();
  saveState({ deviceTab: tainted() });
  phoneIs();
  ps.fx.keyboardFail = true;
  let out;
  const stderr = await quietly(async () => { out = await safari.start(['--device', PU]); });
  assert.deepEqual(stderr, [], 'nothing on stderr');
  assert.equal(out.recovered, true);
  assert.equal(out.keyboardRestored, false);
  assert.deepEqual(out.human, [...out.previousTab.human, phoneLib.KEYBOARD_HUMAN], 'the old tab\'s step first (#103), then the keyboard\'s');
  assert.match(out.keyboardNote, /^restoring the keyboard settings: /, 'why, in the JSON');
  assert.equal(out.keyboardDeferred, undefined);
  assert.equal(out.previousTab.tabLeft, 'previous');
  assert.equal(out.previousTab.human.length, 1, 'the previous tab note is kept');
  assert.ok(seq().indexOf('DELETE /session') < seq().indexOf('POST /session'), 'the old session was still replaced');
  assert.equal(loadState().keyboardPending, true);
  neverUnsafe();
});

test('a device session create that fails leaves the restore pending, because WebDriverAgent may already have turned the settings off', async () => {
  deviceReset();
  withPhone();
  phoneIs();
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  assert.equal(loadState().keyboardPending, undefined);
  ps.fx.createErrors = ['Timed out while enabling automation mode'];
  await failing(safari.start(['--device', PU]));
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().keyboardPending, true);
});

test('a simulator session create that fails is never marked pending', async () => {
  fx.createError = 'something nobody has seen before';
  await failing(safari.start(['--target', 'simulator']));
  assert.equal(loadState().keyboardPending, undefined);
});

test('a start that gives up on the first page restores the keyboard before it deletes the session', async () => {
  deviceReset();
  withPhone();
  phoneIs();
  dv.pick = OTHER;
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  const e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.extra.keyboardRestored, true);
  const l = seq();
  assert.ok(l.indexOf(KB_POST) >= 0 && l.indexOf(KB_POST) < l.indexOf('DELETE /session'), l.join(', '));
  assert.deepEqual(ps.fx.keyboard, { keyboardAutocorrection: true, keyboardPrediction: true });
  assert.equal(loadState().keyboardPending, undefined);
  assert.equal(e.extra.human.includes(phoneLib.KEYBOARD_HUMAN), false);

  deviceReset();
  withPhone();
  phoneIs();
  dv.pick = OTHER;
  ps.fx.keyboardFail = true;
  let f;
  await quietly(async () => { f = await failing(safari.start(['--device', PU])); });
  assert.equal(f.extra.keyboardRestored, false);
  assert.equal(f.extra.human.at(-1), phoneLib.KEYBOARD_HUMAN);
  assert.ok(seq().includes('DELETE /session'), 'the session was still deleted');
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().keyboardPending, true);
});

test('a simulator session never touches the keyboard settings and is never marked pending', async () => {
  await start();
  assert.equal(loadState().keyboardPending, undefined);
  log.length = 0;
  const out = await safari.stop();
  assert.equal(out.keyboardRestored, undefined);
  assert.equal(out.human, undefined);
  assert.deepEqual(log.filter(([, u]) => u.endsWith('/appium/settings')), []);
  assert.ok(log.some(([m, u]) => m === 'DELETE' && u === '/session/S1'));
});

test('nothing in the device paths ever sends DELETE /window or POST /url, whatever the commands', async () => {
  await startPhone();
  dv.pages[PAGE].els = { a: 1 };
  await safari.open(['https://other.test/']);
  await safari.refresh([]);
  await safari.click(['a']);
  await safari.type(['a', 'hello']);
  await safari.source([]);
  await safari.network();
  await safari.stop();
  neverUnsafe();
});

test('a script that lands in a tab the driver moved to runs nothing past the marker check, and taints the run', async () => {
  await startPhone(STOCK);
  // Between selecting the lab's tab and running the script a new page appears on the same site and takes the context.
  let landed = null;
  dv.beforeExecute = () => { dv.beforeExecute = null; landed = addPage('WEBVIEW_9.3', 'https://example.com/other-tab', { win: { name: 'owner-state-2' } }); };
  const e = await failing(safari.eval(['window.__ran = true; return "secret-from-owner"']));
  assert.equal(e.extra.needs, 'tab');
  assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /secret-from-owner/);
  assert.equal(landed.runs, 1, 'the script did land there');
  assert.equal(landed.win.__ran, undefined, 'but nothing ran past the marker check');
  assert.equal(landed.win.name, 'owner-state-2');
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.context, 'NATIVE_APP');
  dlog.length = 0;
  await assert.rejects(safari.url([]), err => err.extra.needs === 'tab');
  assert.equal(dlog.length, 0);
  neverUnsafe();
});

test('a context that moves right after the lab\'s tab was selected taints the run before any script is sent', async () => {
  await startPhone(STOCK);
  dv.onSelect = () => { dv.onSelect = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(executes().length, 0);
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.context, 'NATIVE_APP');
});

test('start: a context that moved after the one conditional script ends the session without trusting the tab', async () => {
  deviceReset(STOCK);
  withPhone();
  phoneIs();
  dv.onExecute = () => { dv.onExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  const e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(executes().length, 1);
  assert.ok(seq().includes('DELETE /session'));
  assert.equal(loadState().deviceTab, undefined);
  assert.equal(loadState().session, undefined);
});

test('after open, a context that moves after the probe is waited out once: the retry marks the lab\'s page and no other, and says so', async () => {
  await startPhone(STOCK);
  const { token } = loadState().deviceTab;
  let moved;
  dv.afterExecute = (page, s) => {
    if (!PROBE.test(s)) return;
    dv.afterExecute = null;
    moved = addPage('WEBVIEW_9.4', 'https://other.test/inbox', { win: { name: '' } }); // a page on the very site asked for takes the context
  };
  const out = await safari.open(['https://other.test/']);
  assert.equal(out.markRetried, true);
  assert.equal(out.finalUrl, 'https://other.test/');
  assert.equal(dv.pages[PAGE].win.name, token);
  assert.equal(moved.win.name, '', 'the page that took the context never carried the marker');
  assert.equal(moved.runs, 0, 'no script ran in it');
  assert.equal(probes().length, 2);
  assert.equal(marks().length, 1, 'the result of the first probe was discarded: no mark followed it');
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal(loadState().deviceTab.origin, 'https://other.test');
  assert.equal(dv.context, 'NATIVE_APP');
  const plant = runLog().split('\n').filter(l => /safari plant/.test(l)).join('\n');
  assert.match(plant, /context moved after the probe page=WEBVIEW_9\.1 movedTo=new landed=WEBVIEW_9\.4 retry=true/);
  assert.match(plant, /pListedAfterSettle=true/);
  assert.doesNotMatch(plant, /https?:|other\.test|example\.com/, 'ids only');
  assert.equal((await safari.eval(['1'])).value, 1);
  neverUnsafe();
});

test('a mark that lands in the page that took the context writes nothing there, whatever its site, and the retry marks the lab\'s page', async () => {
  for (const href of ['https://other.test/inbox', 'https://private.test/inbox']) {
    await startPhone(STOCK);
    WAIT.timeoutMs = 60e3; // two real opens and a retry must not hit the 400 ms load deadline on a slow runner
    const { token } = loadState().deviceTab;
    let moved;
    dv.beforeExecute = s => { if (MARK.test(s)) { dv.beforeExecute = null; moved = addPage('WEBVIEW_9.4', href, { win: { name: '' } }); } };
    const out = await safari.open(['https://other.test/']);
    assert.equal(out.markRetried, true, href);
    assert.equal(moved.runs, 1, `${href}: the mark script did land there`);
    assert.equal(moved.win.name, '', `${href}: but the marker did not`);
    assert.ok(Object.entries(dv.pages).every(([id, p]) => (p.win.name === token) === (id === PAGE)), 'the marker is in the lab\'s page only');
    assert.equal(marks().length, 2);
    assert.equal(loadState().deviceTab.tainted, undefined);
    neverUnsafe();
  }
});

test('a context that moves after the mark is waited out once; the marker is already in the lab\'s page, so the retry does not mark again', async () => {
  await startPhone(STOCK);
  const { token } = loadState().deviceTab;
  let moved;
  dv.afterExecute = (page, s) => { if (MARK.test(s)) { dv.afterExecute = null; moved = addPage('WEBVIEW_9.3', 'https://other.test/inbox'); } };
  const out = await safari.open(['https://other.test/']);
  assert.equal(out.markRetried, true);
  assert.equal(marks().length, 1);
  assert.equal(probes().length, 2);
  assert.equal(dv.pages[PAGE].win.name, token);
  assert.equal(moved.runs, 0);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('open skips the mark when the probe finds the marker still in the page (a same-site navigation keeps window.name)', async () => {
  await startPhone();
  const { token } = loadState().deviceTab;
  const out = await safari.open(['https://example.com/elsewhere']);
  assert.equal(out.markRetried, undefined);
  assert.equal(probes().length, 1);
  assert.equal(marks().length, 0);
  assert.equal(dv.pages[PAGE].win.name, token);
  assert.equal(loadState().deviceTab.origin, 'https://example.com');
  neverUnsafe();
});

test('the wait-out of a context move is once per navigation across every poll, polls are plantPollMs apart, and the next navigation has its own', async () => {
  await startPhone(STOCK);
  WAIT.plantPollMs = 40;
  WAIT.timeoutMs = 60e3; // the test ends at the second move; a slow runner must not hit the 400 ms load deadline first
  let n = 0;
  dv.afterExecute = (page, s) => {
    if (/location\.replace/.test(s)) page.loading = 2; // the document is still loading for the first two probes
    if (PROBE.test(s) && ++n >= 3) addPage(`WEBVIEW_9.${n + 2}`, 'https://other.test/inbox'); // a move in poll 3 (waited out) and again in poll 4
  };
  const t0 = Date.now();
  const e = await failing(safari.open(['https://other.test/']));
  assert.ok(Date.now() - t0 >= 80, 'two polls found the document loading, 40 ms apart');
  assert.equal(e.extra.needs, 'tab');
  assert.equal(probes().length, 4, 'polls 1-2 not ready, 3 moved (the one retry), 4 moved again');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.equal(dv.context, 'NATIVE_APP');
  // A new navigation gets a new budget.
  await startPhone(STOCK);
  for (const k of [1, 2]) {
    dv.afterExecute = (page, s) => { if (PROBE.test(s)) { dv.afterExecute = null; addPage(`WEBVIEW_9.${k + 4}`, 'https://other.test/inbox'); } };
    assert.equal((await safari.open([`https://other.test/p${k}`])).markRetried, true, `open ${k}`);
  }
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('when the lab\'s tab is gone as the page list settles, open refuses with "gone": not tainted, bounded, and no other page is selected', async () => {
  await startPhone(STOCK);
  WAIT.navSettleMs = 60;
  dv.afterExecute = (page, s) => { if (PROBE.test(s)) { dv.afterExecute = null; addPage('WEBVIEW_9.4', 'https://other.test/inbox'); delete dv.pages[PAGE]; } };
  const t0 = CLOCK.now();
  const e = await failing(safari.open(['https://other.test/']));
  assert.ok(CLOCK.now() - t0 >= 60 && CLOCK.now() - t0 < 60 + WAIT.navSettlePollMs, 'the settle wait ends at navSettleMs (to within one poll), well before the 5000 ms default');
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.gone, true);
  assert.match(e.message, /the lab's tab is gone/);
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal(dv.context, 'NATIVE_APP');
  assert.deepEqual(dlog.filter(([m, u, b]) => m === 'POST' && u.endsWith('/context') && b.name !== 'NATIVE_APP'), dlog.filter(([m, u, b]) => m === 'POST' && u.endsWith('/context') && b.name === PAGE), 'only the lab\'s tab was ever selected');
  assert.equal(probes().length, 1);
  neverUnsafe();
});

test('the settle wait is bounded by navSettleMs when the page list never stops changing, and the retry still goes ahead', async () => {
  await startPhone(STOCK);
  WAIT.navSettleMs = 80;
  let n = 0;
  dv.afterExecute = (page, s) => {
    if (!PROBE.test(s)) return;
    dv.afterExecute = null;
    addPage('WEBVIEW_9.4', 'https://other.test/inbox');
    dv.onContexts = () => { dv.pages[`WEBVIEW_8.${++n}`] = ps.newPage(`WEBVIEW_8.${n}`, 'https://x.test/'); }; // a new page on every read
  };
  const t0 = CLOCK.now();
  const out = await safari.open(['https://other.test/']);
  dv.onContexts = null;
  assert.ok(CLOCK.now() - t0 >= 80 && CLOCK.now() - t0 <= 80 + WAIT.plantPollMs, 'the settle wait ends at navSettleMs; the only other wait is the poll before the retry');
  assert.equal(out.markRetried, true);
  assert.ok(n >= 2 && n < 40, `a bounded number of list reads (${n})`);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('keys on the phone checks the tab is showing before every press, --no-verify included', async () => {
  await startPhone();
  dv.pages[PAGE].field = true;
  const out = await safari.keys(['--no-verify', 'abc']);
  assert.equal(out.keyed, 3);
  const l = dlog.filter(([, , b]) => b?.script === 'mobile: keys' || /visibilityState/.test(b?.script ?? ''));
  const kinds = l.map(([, , b]) => (b.script === 'mobile: keys' ? 'key' : 'check'));
  const first = kinds.indexOf('key');
  const run = kinds.slice(first - 1); // from the check before the first press
  assert.deepEqual(run, ['check', 'key', 'check', 'key', 'check', 'key']);
  // The tab leaves after the first press: no second press is sent.
  dlog.length = 0;
  dv.keys = 0;
  dv.onExecute = page => { if (dv.keys >= 1 && /visibilityState/.test(dv.executed.at(-1)[1])) page.visible = false; };
  const e = await failing(safari.keys(['--no-verify', 'xyz']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(dv.keys, 1);
  neverUnsafe();
});

test('a device session lets through only the native calls the actions need', () => {
  const ok = [['POST', '/execute/sync', { script: 'mobile: tap' }], ['POST', '/execute/sync', { script: 'mobile: keys' }], ['POST', '/execute/sync', { script: 'mobile: isKeyboardShown' }],
    ['POST', '/execute/sync', { script: 'mobile: source' }], ['POST', '/actions', {}], ['DELETE', '/actions'], ['GET', '/screenshot']];
  for (const c of ok) assert.equal(deviceNative(...c), true, c.join(' '));
  const no = [['POST', '/execute/sync', { script: 'mobile: getContexts' }], ['POST', '/execute/sync', { script: 'mobile: launchApp' }], ['POST', '/execute/sync', { script: 'return 1' }],
    ['POST', '/se/log', { type: 'safariNetwork' }], ['POST', '/se/log', { type: 'safariConsole' }], ['POST', '/se/log', { type: 'syslog' }], ['POST', '/se/log'], ['GET', '/contexts'], ['POST', '/context', { name: 'x' }],
    ['GET', '/source'], ['POST', '/url', { url: 'https://x.test' }], ['DELETE', '/window']];
  for (const c of no) assert.equal(deviceNative(...c), false, c.join(' '));
});

// The index of the last request matching `pick` in dlog, and the execute scripts after `from`.
const lastIndex = pick => dlog.findLastIndex(pick);
// A visibility check is the last page script sent before the native action at `at`.
function visibilityRightBefore(at) {
  const before = dlog.slice(0, at).filter(([m, u]) => m === 'POST' && u.endsWith('/execute/sync'));
  assert.match(before.at(-1)[2].script, /visibilityState/, 'the last script before the native action is the visibility check');
  // ... and nothing but its own context housekeeping sits between them.
  const between = dlog.slice(dlog.indexOf(before.at(-1)) + 1, at).map(mark);
  assert.deepEqual(between, ['GET /context', 'POST /context NATIVE_APP']);
}

test('a device tap finds the element by a plain selector argument, and checks the tab is showing right before the touch', async () => {
  await startPhone();
  dv.pages[PAGE].els = { '#go': 1 };
  const out = await safari.tap(['#go']);
  assert.equal(out.tapped, '#go');
  assert.deepEqual([out.x, out.y], [100, 248]);
  // No script was sent an element reference: only strings.
  for (const b of executes()) assert.ok(b.args.every(a => typeof a === 'string' || typeof a === 'number' || a === null || (typeof a === 'object' && !Object.keys(a).some(k => k.startsWith('element-')))), JSON.stringify(b.args));
  assert.ok(executes().some(b => /scrollIntoView/.test(b.script) && b.args[0] === '#go'));
  const at = lastIndex(([, , b]) => b?.script === 'mobile: tap');
  assert.ok(at > 0);
  visibilityRightBefore(at);
  neverUnsafe();
});

test('a device tap is not sent if the tab left the screen after the probe was read', async () => {
  await startPhone();
  dv.pages[PAGE].els = { '#go': 1 };
  let n = 0;
  dv.onExecute = page => { if (/visibilityState/.test(dv.executed.at(-1)[1]) && ++n === 2) page.visible = false; }; // the check right before the touch
  const e = await failing(safari.tap(['#go']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
});

test('a device tap scrolls an off-screen element in with an instant scroll, and leaves an on-screen one', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.els = { '#go': 1 };
  await safari.tap(['#go']);
  assert.equal(page.scrolls, undefined); // already on screen: the page is not moved

  let scrolled = false;
  page.rectOf = () => ({ left: 80, top: scrolled ? 300 : 2000, width: 40, height: 20 });
  page.onScroll = () => { scrolled = true; };
  const out = await safari.tap(['#go']);
  assert.deepEqual(page.scrolls, [['#go', { block: 'center', inline: 'center', behavior: 'instant' }]]);
  assert.deepEqual([out.x, out.y], [100, 358]); // 300 + 10 + 48
  neverUnsafe();
});

test('a device tap measures the element in the probe\'s own script, and every page script goes through the tab guard', async () => {
  await startPhone();
  dv.pages[PAGE].els = { '#go': 1 };
  await safari.tap(['#go']);
  const probe = executes().find(b => /createElement/.test(b.script));
  assert.deepEqual(probe.args.slice(1), ['#go']); // the selector, as a plain string
  assert.match(probe.script, /pick\(arguments\[1\]\)/);
  assert.match(probe.script, /getBoundingClientRect[\s\S]*elementFromPoint/);
  neverUnsafe();
});

test('a device tap waits out a moving element, and refuses without a touch when it never stops', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.els = { '#go': 1 };
  let moving = 2; // the first two readings find the page still scrolling
  page.rectOf = () => ({ left: 80, top: 190 + (moving > 0 ? moving-- * 40 : 0), width: 40, height: 20 });
  const out = await safari.tap(['#go']);
  assert.deepEqual([out.x, out.y], [100, 248]); // where it came to rest
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 1);

  dlog.length = 0;
  let n = 0;
  page.rectOf = () => ({ left: 80, top: 190 + ++n * 40, width: 40, height: 20 });
  const e = await failing(safari.tap(['#go']));
  assert.match(e.message, /#go kept moving.*no tap was sent/);
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  assert.equal(page.probeLabel ?? null, null); // no probe left behind
  neverUnsafe();
});

test('a device tap on a text field reports whether it took the focus', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.els = { '#name': 1, '#go': 1 };
  page.tags = { '#name': 'INPUT', '#go': 'DIV' };
  assert.equal('focused' in await safari.tap(['#go']), false);
  assert.equal((await safari.tap(['#name'])).focused, false); // the page kept the focus elsewhere
  page.activeCss = '#name';
  assert.equal((await safari.tap(['#name'])).focused, true);
  neverUnsafe();
});

test('a device tap on an invisible element warns, still taps, and says nothing for a normal one', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.els = { '#hidden': 1, '#plain': 1, '#none': 1 };
  page.tags = { '#hidden': 'INPUT', '#plain': 'INPUT', '#none': 'DIV' };
  const tapsSent = () => dlog.filter(([, , b]) => b?.script === 'mobile: tap').length;
  const base = tapsSent();
  page.rectOf = css => (css === '#hidden' ? { left: 80, top: 190, width: 1, height: 1 } : { left: 80, top: 190, width: 40, height: 20 });
  page.styleOf = css => ({ display: css === '#none' ? 'none' : 'block', visibility: 'visible', opacity: css === '#hidden' ? '0' : '1' });
  const out = await safari.tap(['#hidden']);
  assert.equal(out.warning, '#hidden is hidden (opacity 0, 1x1 px); the tap probably focused nothing');
  assert.equal(out.focused, false);
  assert.equal(tapsSent(), base + 1);
  assert.equal((await safari.tap(['#none'])).warning, '#none is hidden (display none); the tap probably focused nothing');
  assert.equal('warning' in await safari.tap(['#plain']), false);
  assert.equal(tapsSent(), base + 3);
  neverUnsafe();
});

test('on the phone a text selector is counted, resolved and acted on inside the tab guard, and no page text comes back', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.texts = { button: ['Cancel', 'OK', '  OK \n', 'SECRET-PAGE-TEXT'], input: ['Email'] };
  const e = await failing(safari.click(['button', '--text', 'OK']));
  assert.equal(e.message, '2 elements match text "OK" (button); add --nth 1..2');
  assert.equal(page.clicked, undefined);
  assert.deepEqual(await safari.click(['button', '--text', 'OK', '--nth', '2']), { clicked: 'button text="OK" #2', matches: 2 });
  assert.equal(page.clicked, 'button[2]');
  assert.equal((await failing(safari.click(['button', '--text', 'ok', '--contains']))).message, 'no element matches text "ok" (button)'); // case matters
  assert.deepEqual(await safari.type(['input', '--text', 'Email', 'hi']), { typed: 2, into: 'input text="Email"', matches: 1 });
  assert.equal(page.elCache['input[0]'].v, 'hi');
  assert.deepEqual(await safari.type(['input', '--text', 'Em', '--contains', ' there']), { typed: 6, into: 'input text*="Em"', matches: 1 });
  assert.equal(page.elCache['input[0]'].v, 'hi there', 'the same value script as a plain selector: it appends');
  // Every script that ran in the tab went through the guard (the token check first); none carries an element reference.
  for (const b of executes().filter(x => !x.script.startsWith('mobile:'))) {
    assert.match(b.script, /^if \(window\.name !== "msl-tok-[0-9a-f]{16}"\)/);
    assert.ok(b.args.every(a => typeof a === 'string' || (typeof a === 'object' && a !== null && !Object.keys(a).some(k => k.startsWith('element-')))), JSON.stringify(b.args));
  }
  assert.deepEqual(dlog.filter(([, u]) => /\/element\//.test(u)), [], 'no element request reaches Appium on the phone');
  // The count script's answer is numbers; nothing of the page's text is in any output.
  const counted = dv.results.filter(([s]) => s.includes('scanSel(arguments[0]);\nreturn { count'));
  assert.ok(counted.length >= 3);
  for (const [, v] of counted) assert.ok(Object.values(v.v).every(Number.isInteger), JSON.stringify(v));
  assert.doesNotMatch(JSON.stringify(e.message), /SECRET/);
  neverUnsafe();
});

test('a text selector that matches nothing on the phone says so in the agent\'s words, never the page\'s', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.texts = { button: ['SECRET-PAGE-TEXT', 'Other'] };
  for (const [argv, want] of [
    [['button', '--text', 'Zed'], 'no element matches text "Zed" (button)'],
    [['button', '--text', 'Other', '--nth', '2'], '--nth 2 but only 1 match'],
    [['--text', 'Zed'], 'no element matches text "Zed"'],
  ]) {
    for (const cmdName of ['click', 'tap']) assert.equal((await failing(safari[cmdName](argv))).message, want, `${cmdName} ${argv}`);
  }
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  assert.equal(page.clicked, undefined);
  neverUnsafe();
});

test('a device tap by text taps where the match is, scrolls and measures it by selector, and checks the tab is showing right before the touch', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.texts = { button: ['OK', 'Cancel', 'OK'] };
  page.rectOf = css => ({ left: css === 'button[2]' ? 200 : 80, top: 190, width: 40, height: 20 });
  const out = await safari.tap(['button', '--text', 'OK', '--nth', '2']);
  assert.equal(out.tapped, 'button text="OK" #2');
  assert.equal(out.matches, 2);
  assert.deepEqual([out.x, out.y], [220, 248]);
  const sel = { css: 'button', text: 'OK', nth: 2 };
  assert.ok(executes().some(b => /scrollIntoView/.test(b.script) && /pick\(arguments\[0\]\)/.test(b.script) && JSON.stringify(b.args) === JSON.stringify([sel])));
  const probe = executes().find(b => /createElement/.test(b.script));
  assert.deepEqual(probe.args.slice(1), [sel]);
  visibilityRightBefore(lastIndex(([, , b]) => b?.script === 'mobile: tap'));
  neverUnsafe();
});

test('a device tap by text sends no touch, and counts nothing, when the tab is not showing', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.texts = { button: ['OK'] };
  page.visible = false;
  const e = await failing(safari.tap(['button', '--text', 'OK']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  assert.ok(executes().every(b => /visibilityState/.test(b.script)), 'only the visibility check ran');
  // It leaves after the count: still no touch.
  page.visible = true;
  let n = 0;
  dv.onExecute = p => { if (/visibilityState/.test(dv.executed.at(-1)[1]) && ++n === 2) p.visible = false; }; // the check right before the touch
  const e2 = await failing(safari.tap(['button', '--text', 'OK']));
  assert.equal(e2.extra.needs, 'tab');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  neverUnsafe();
});

test('on the phone a shadow chain is entered only through open roots; a host without one is refused with the way out', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.texts = { 'x-app': [''], 'x-closed': [''] };
  page.roots = { 'x-app': { button: ['Go'], '*': ['Go'] } };
  assert.deepEqual(await safari.click(['--shadow', 'x-app', 'button']), { clicked: 'x-app >> button', matches: 1 });
  assert.equal(page.clicked, 'button[0]');
  const out = await safari.tap(['--shadow', 'x-app', '*', '--text', 'Go']);
  assert.deepEqual([out.tapped, out.matches], ['x-app >> * text="Go"', 1]);
  const closed = await failing(safari.click(['--shadow', 'x-closed', 'button']));
  assert.equal(closed.message, 'host "x-closed" has no open shadow root (none, or a closed one, which can\'t be entered); try tap --label');
  const none = await failing(safari.tap(['--shadow', 'x-missing', 'button']));
  assert.equal(none.message, 'no element matches host "x-missing"');
  neverUnsafe();
});

test('a device tap --label taps the centre of the one labelled native element in the web view, checking the tab right before', async () => {
  await startPhone();
  dv.labels = [{ label: 'Share', x: 100, y: 300, width: 60, height: 40 }, { label: 'Share', x: 100, y: 400, width: 60, height: 40, type: 'XCUIElementTypeLink' }, { label: 'Menu', x: 300.5, y: 200, width: 21, height: 31 }];
  const dup = await failing(safari.tap(['--label', 'Share']));
  assert.equal(dup.message, '2 elements are labelled "Share"; run `safari ui` to see the labels in the web view');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  dlog.length = 0;
  const out = await safari.tap(['--label', 'Menu']);
  assert.deepEqual([out.tapped, out.via, out.x, out.y], ['label "Menu"', 'label', 311, 215.5]);
  assert.deepEqual(out.page, { x: 0, y: 48, width: 414, height: 750 });
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: source').length, 1, 'one tree read');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 1);
  visibilityRightBefore(lastIndex(([, , b]) => b?.script === 'mobile: tap'));
  assert.ok(!executes().some(b => /scrollIntoView|elementFromPoint|scanSel/.test(b.script) && !/createElement/.test(b.script)), 'no page search: the label is the native tree\'s');
  assert.equal(dv.pages[PAGE].probeLabel ?? null, null);
  neverUnsafe();
});

test('a device tap --label never matches or touches anything outside the web view: the tab bar\'s titles are not candidates', async () => {
  await startPhone();
  // The tab bar (outside the web view) carries the owner's other tab's title, as a label and as a button.
  for (const label of ['Inbox - private.test', 'TabBarItemTitle']) {
    const e = await failing(safari.tap(['--label', label]));
    assert.equal(e.message, `0 elements are labelled ${JSON.stringify(label)}; run \`safari ui\` to see the labels in the web view`);
  }
  // A node inside the web view that sits on the tab bar or past the page is refused, with no touch.
  dv.labels = [{ label: 'Bar', x: 20, y: 810, width: 60, height: 20 }];
  assert.match((await failing(safari.tap(['--label', 'Bar']))).message, /outside the visible page/);
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  assert.doesNotMatch(JSON.stringify(dlog.filter(([, u]) => !u.endsWith('/execute/sync'))), /private\.test/);
  assert.equal(dv.pages[PAGE].probeLabel ?? null, null);
  neverUnsafe();
});

test('a device tap --label is not sent when the tab is not showing, or leaves after the tree was read', async () => {
  await startPhone();
  dv.labels = [{ label: 'Menu', x: 300, y: 200, width: 20, height: 30 }];
  const tapsSent = () => dlog.filter(([, , b]) => b?.script === 'mobile: tap').length;
  dv.pages[PAGE].visible = false;
  assert.equal((await failing(safari.tap(['--label', 'Menu']))).extra.needs, 'tab');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: source').length, 0, 'nothing was read from the screen');
  dv.pages[PAGE].visible = true;
  let n = 0;
  dv.onExecute = page => { if (/visibilityState/.test(dv.executed.at(-1)[1]) && ++n === 2) page.visible = false; }; // the check right before the touch
  assert.equal((await failing(safari.tap(['--label', 'Menu']))).extra.needs, 'tab');
  assert.equal(tapsSent(), 0);
  neverUnsafe();
});

test('a device swipe checks the tab is showing right before the drag', async () => {
  await startPhone();
  const out = await safari.swipe(['up']);
  assert.equal(out.swiped, 'up');
  const at = lastIndex(([m, u]) => m === 'POST' && u.endsWith('/actions'));
  assert.ok(at > 0);
  visibilityRightBefore(at);
  neverUnsafe();
});

test('a guarded script that gets no answer while the context moved taints the run', async () => {
  await startPhone(STOCK);
  noAnswerWhenParked();
  dv.hang = true;
  dv.onExecute = () => { dv.onExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.context, 'NATIVE_APP');
});

test('a tab found on another host than the lab sent it to, with the marker still there, taints the run', async () => {
  await startPhone();
  dv.pages[PAGE].href = 'https://sub.example.com/page'; // moved on its own, marker intact
  const e = await failing(safari.eval(['window.__ran = true; return 1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /another site on its own/);
  assert.equal(dv.pages[PAGE].win.__ran, undefined);
  assert.deepEqual(loadState().deviceTab, tainted());
});

test('start replaces a device session whose tab is tainted, unverifiable, dead or gone, ending the old one without touching any page, and says what is left on the phone', async () => {
  const spoils = [
    ['tainted', () => saveState({ deviceTab: { tainted: true, tag: loadState().deviceTab.tag } }), true],
    ['unverifiable', () => saveState({ deviceTab: { page: 'junk', tag: loadState().deviceTab.tag } }), true],
    ['unverifiable, no tag', () => saveState({ deviceTab: { page: 'junk' } }), true],
    ['dead', () => ps.fx.sessions.clear(), true],
    ['gone', () => { delete dv.pages[PAGE]; }, false],
  ];
  for (const [name, spoil, left] of spoils) {
    await startPhone();
    const oldTag = loadState().deviceTab.tag;
    spoil();
    dlog.length = 0;
    phoneIs();
    const out = await safari.start(['--device', PU]);
    assert.equal(out.recovered, true, name);
    assert.equal(out.reused, undefined, name);
    if (name !== 'dead') {
      const l = seq();
      assert.ok(l.indexOf('DELETE /session') < l.indexOf('POST /session'), `${name}: the old session ended first`);
    }
    assert.equal(executes().length, 1, `${name}: only the new session's one start script ran`);
    assert.equal(loadState().deviceTab.page, PAGE);
    assert.equal(loadState().deviceTab.tainted, undefined);
    assert.equal(await safari.eval(['1 + 1']).then(r => r.value), 2);
    if (!left) {
      assert.equal(out.previousTab, undefined, `${name}: the tab is not on the phone any more`);
      assert.equal(out.human, undefined, `${name}: so no step for it either (#103)`);
    } else {
      const url = name === 'unverifiable, no tag' ? '' : ` (https://example.com/?${oldTag})`;
      assert.deepEqual(out.previousTab, { tabClosed: false, tabLeft: 'previous', human: [`The previous run's lab tab${url} may still be open; the lab didn't touch it. Close it by hand.`] }, name);
    }
    neverUnsafe();
  }
});

const previousTabHuman = async () => { phoneIs(); return (await safari.start(['--device', PU])).previousTab.human; };

test('a run that loses the tab during open tells the next start which site to look for: the one asked for, never a redirect\'s target or a path', async () => {
  await startPhone();
  dv.redirect = { 'b.test': 'private.test' };
  let during;
  dv.afterExecute = (page, s) => { if (/location\.replace/.test(s)) during = loadState().deviceTab.navTo; };
  const e = await failing(safari.open(['https://b.test/secret/path?q=SECRETQ#frag']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(during, 'https://b.test', 'recorded before the page was told to go there');
  assert.deepEqual(loadState().deviceTab, tainted('https://b.test'));
  const stopped = await safari.stop(); // the tab can't be confirmed, so it is left alone and named
  assert.match(stopped.human.join(' '), /by hand \(Safari tab switcher, then the X on its card\); the lab last sent it to https:\/\/b\.test\./);
  await startPhone();
  const oldTag = dv.tag;
  dv.redirect = { 'b.test': 'private.test' };
  await failing(safari.open(['https://b.test/secret/path?q=SECRETQ#frag']));
  const human = await previousTabHuman();
  assert.equal(human.length, 1);
  assert.equal(human[0], `The previous run's lab tab may still be open; the lab last sent it to https://b.test (it started on https://example.com/?${oldTag}). The lab didn't touch it. Close it by hand.`);
  assert.doesNotMatch(JSON.stringify([human, stopped]), /private\.test|secret|SECRETQ|frag/);
  neverUnsafe();
});

test('a start after a taint puts the step for the old tab in the top-level human too, so it is relayed (#103)', async () => {
  await startPhone();
  dv.redirect = { 'c.test': 'private.test' };
  await failing(safari.open(['https://c.test/']));
  assert.equal(loadState().deviceTab.tainted, true);
  phoneIs();
  const out = await safari.start(['--device', PU]);
  assert.equal(out.previousTab.tabLeft, 'previous');
  assert.deepEqual(out.human, out.previousTab.human, 'the same step, where a person\'s steps always are');
  assert.match(out.human[0], /Close it by hand\.$/);
  neverUnsafe();
});

test('after a verified open the record names the verified origin, the pending one is cleared, and a later taint keeps it', async () => {
  await startPhone();
  dv.redirect = { 'a.test': 'www.a.test' };
  await safari.open(['https://a.test/start']);
  const tab = loadState().deviceTab;
  assert.equal(tab.origin, 'https://www.a.test');
  assert.equal(tab.navTo, undefined, 'cleared once the final origin was verified');
  assert.equal(await safari.eval(['1']).then(r => r.value), 1, 'readTab ignores the extra key');
  dv.pages[PAGE].win.name = ''; // the marker is lost: the next command taints the run
  await failing(safari.eval(['1']));
  assert.deepEqual(loadState().deviceTab, tainted('https://www.a.test'));
  assert.match((await previousTabHuman())[0], /the lab last sent it to https:\/\/www\.a\.test \(it started on https:\/\/example\.com\/\?msl-[0-9a-f]{8}\)\./);
  neverUnsafe();
});

test('the last site is only taken from a well-formed origin, and a tab that never left its first page is named by its tag alone', async () => {
  const tagOnly = tag => `The previous run's lab tab (https://example.com/?${tag}) may still be open; the lab didn't touch it. Close it by hand.`;
  for (const [name, spoil, named] of [
    ['a pending navigation', t => ({ ...t, navTo: 'https://b.test' }), 'https://b.test'],
    ['a tainted record from before lastOrigin existed', t => ({ tainted: true, tag: t.tag }), null],
    ['a junk lastOrigin', t => ({ tainted: true, tag: t.tag, lastOrigin: 'https://b.test/path?x=1' }), null],
    ['a script URL as lastOrigin', t => ({ tainted: true, tag: t.tag, lastOrigin: 'javascript:alert(1)' }), null],
    ['a tab still on its first page', t => ({ ...t, navTo: 'https://example.com' }), null],
  ]) {
    await startPhone();
    const t = loadState().deviceTab;
    saveState({ deviceTab: spoil(t) });
    ps.fx.sessions.clear(); // a dead session: the old tab stays on the phone
    const [text] = await previousTabHuman();
    if (named) assert.equal(text, `The previous run's lab tab may still be open; the lab last sent it to ${named} (it started on https://example.com/?${t.tag}). The lab didn't touch it. Close it by hand.`, name);
    else assert.equal(text, tagOnly(t.tag), name);
  }
  neverUnsafe();
});

test('a session create that fails after the lab opened its tab says the tab is still on the phone', async () => {
  deviceReset();
  withPhone();
  phoneIs();
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  ps.fx.createErrors = ['Timed out while enabling automation mode'];
  const e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'passcode');
  assert.equal(e.extra.tabClosed, false);
  assert.equal(e.extra.tabLeft, 'new');
  assert.equal(e.extra.human[0], `The lab opened a Safari tab (https://example.com/?${dv.tag}) but couldn't confirm it, so it touched nothing. Close it by hand: tab switcher, X on its card.`);
  assert.ok(e.extra.human.length > 1, 'the needs steps follow');
  assert.ok(dv.pages[PAGE], 'the tab is there');
  assert.equal(loadState().session, undefined);
});

// Appium's message for a WebDriverAgent that would not start says nothing; the reason is in its log (#58).
const XCODEBUILD_65 = 'An unknown server-side error occurred while processing the command. Original error: Unable to launch WebDriverAgent because of xcodebuild failure: xcodebuild failed with code 65';
const UNTRUSTED = 'Unable to launch com.example.msl-wda because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.\n';
const appendAppiumLog = text => { fs.mkdirSync(path.dirname(logPath()), { recursive: true }); fs.appendFileSync(logPath(), text); };

async function createFailsWith(prepare) {
  deviceReset();
  withPhone();
  phoneIs();
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  prepare();
  ps.fx.createErrors = [XCODEBUILD_65];
  return failing(safari.start(['--device', PU]));
}

test('a device create that fails with exit 65 is needs trust when Appium\'s log, written during the request, says the profile is untrusted', async () => {
  appendAppiumLog('[old] some earlier line\n');
  const e = await createFailsWith(() => { ps.fx.onCreateRequest = () => appendAppiumLog(UNTRUSTED); });
  assert.equal(e.extra.needs, 'trust');
  assert.match(e.message, /xcodebuild failed with code 65 \(Appium's log, .*msl-appium\.log, points to: trust\)/);
  // The evidence is the developer profile, so the Mac's cable step is not offered.
  assert.deepEqual(e.extra.human.slice(1), phoneLib.NEEDS.trust.human.slice(1));
  assert.equal(e.extra.tabLeft, 'new', 'the tab note still comes first');
  assert.equal(loadState().session, undefined);
});

test('the same text only in the log before the request is not read: needs unknown', async () => {
  const e = await createFailsWith(() => appendAppiumLog(UNTRUSTED));
  assert.equal(e.extra.needs, 'unknown');
  assert.doesNotMatch(e.message, /points to/);
});

test('only the last 16 KB of this request\'s log is read: trust text before that is missed, within it is found', async () => {
  const filler = bytes => `${'filler line\n'.repeat(Math.ceil(bytes / 12))}`;
  const beyond = await createFailsWith(() => { ps.fx.onCreateRequest = () => appendAppiumLog(UNTRUSTED + filler(17 * 1024)); });
  assert.equal(beyond.extra.needs, 'unknown');
  const within = await createFailsWith(() => { ps.fx.onCreateRequest = () => appendAppiumLog(UNTRUSTED + filler(8 * 1024)); });
  assert.equal(within.extra.needs, 'trust');
});

test('a log replaced during the request (shorter than where it was) is read from its start', async () => {
  const e = await createFailsWith(() => {
    appendAppiumLog(`${'x'.repeat(500)}\n`);
    ps.fx.onCreateRequest = () => fs.writeFileSync(logPath(), UNTRUSTED);
  });
  assert.equal(e.extra.needs, 'trust');
});

test('a create that fails with exit 65 and no Appium log is needs unknown', async () => {
  const e = await createFailsWith(() => { assert.equal(fs.existsSync(logPath()), false); });
  assert.equal(e.extra.needs, 'unknown');
  assert.match(e.message, /xcodebuild failed with code 65/);
});

test('trust from the log keeps the Mac\'s step when the log asks for Trust This Computer', async () => {
  const e = await createFailsWith(() => { ps.fx.onCreateRequest = () => appendAppiumLog('Trust This Computer on the device\n'); });
  assert.equal(e.extra.needs, 'trust');
  assert.deepEqual(e.extra.human.slice(1), phoneLib.NEEDS.trust.human);
});

test('a context that moves again on the retry taints the run: one retry only, the marker is in no page, and nothing is sent after the last probe', async () => {
  await startPhone(STOCK);
  const { token } = loadState().deviceTab;
  let n = 0;
  dv.afterExecute = (page, s) => { if (PROBE.test(s)) addPage(`WEBVIEW_9.${++n + 2}`, 'https://other.test/inbox'); };
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.equal(probes().length, 2, 'one retry');
  assert.equal(marks().length, 0, 'no result after a move was used');
  assert.equal(PROBE.test(executes().at(-1).script), true, 'the second probe was the last script sent');
  assert.ok(Object.values(dv.pages).every(p => p.win.name !== token), 'the marker is in no page');
  assert.equal(dv.context, 'NATIVE_APP');
  dlog.length = 0;
  await assert.rejects(safari.eval(['1']), err => err.extra.needs === 'tab');
  assert.equal(dlog.length, 0);
  neverUnsafe();
});

// The re-mark select after a navigation gets no answer (the lab's tab is not showing): a pause, not a move, but the
// marker never went back, so the next command taints if the page changed site.
// The short wait comes with the hold (see holdStage), not up front: the reads before the select must not time out on a loaded runner.
const holdTheRemark = () => holdStage('select');
const MARK_PAUSE = /did not answer while it was being marked again after the navigation; switch back to it\. If the page changed site, the next command refuses and needs `safari start`/;

test('open whose re-mark select gets no answer says so in its own words, untainted, and sends nothing page-bound afterwards', async () => {
  await startPhone();
  holdTheRemark();
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, MARK_PAUSE);
  assert.doesNotMatch(e.message, /still good/);
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal(probes().length, 0, 'no probe was sent');
  assert.equal(marks().length, 0);
  const s = seq();
  assert.deepEqual(s.slice(s.lastIndexOf(`POST /context ${PAGE}`)), [`POST /context ${PAGE}`, 'GET /context', 'POST /context NATIVE_APP'], 'after the select: one read and one park');
  // Still blocked: the next command is pending, with one read sent.
  dlog.length = 0;
  const next = await failing(safari.url([]));
  assert.equal(next.pending, true);
  assert.deepEqual(seq(), ['GET /contexts']);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('an off-site redirect with the re-mark select unanswered: the next command taints, at the requested site, and no page script body runs', async () => {
  await startPhone();
  dv.redirect = { 'other.test': 'evil.test' };
  holdTheRemark();
  const e = await failing(safari.open(['https://other.test/']));
  assert.match(e.message, MARK_PAUSE);
  assert.equal(loadState().deviceTab.tainted, undefined);
  ps.switchBack();
  const again = await failing(safari.eval(['window.__ran = true; return 1']));
  assert.match(again.message, /could not be confirmed after it was sent to https:\/\/other\.test \(it was not marked again\)/);
  assert.equal(dv.pages[PAGE].win.__ran, undefined, 'the body never ran');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.ok(Object.values(dv.pages).every(p => p.win.name !== loadState().deviceTab.token));
  neverUnsafe();
});

test('refresh after switching back recovers from an open whose re-mark select got no answer, when the site did not change', async () => {
  await startPhone();
  holdTheRemark();
  const e = await failing(safari.open(['https://example.com/other-page']));
  assert.match(e.message, MARK_PAUSE);
  ps.switchBack();
  const out = await safari.refresh([]);
  assert.match(out.url, /^https:\/\/example\.com\//);
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

// The probe or the mark that puts the marker back gets no answer (Appium's queue is blocked behind it: the tab is not
// showing). Only that is a pause: the probe only reads, and the mark writes only into the document the probe checked, so a
// late mark writes into the lab's tab or nowhere. The record is not updated, so a navigation to another site is found out by
// the next command, whether or not the late mark ran.
const REMARK_REFUSAL = /the lab's tab could not be confirmed after it was sent to https:\/\/other\.test \(it was not marked again\); run `safari start` for a new session/;
const OTHER_PAGE = 'WEBVIEW_9.3';
const HOLD_AT = { probe: /location\.replace/, mark: PROBE }; // the script after which the next one is not answered
// A request the stand-in parks (the tab is not showing) gets no answer the moment it reaches the stand-in, with the lab's own
// "no answer" error, not when a short timer runs out (a loaded runner can stall the loop past a 60 ms budget before the request is sent).
// The requests keep their real budgets; this cuts off only the one that arrived. That one is the newest signal made: the lab sends one
// request at a time (each wd call is awaited before the next, nothing in lib/ races or fans out requests), so no later signal can exist
// while a request is still on its way to the stand-in.
// Returns the budgets it saw, `{ ms, parked }` per request, for a test that asks which limit a request was given.
function noAnswerWhenParked() {
  const sent = [];
  NET.signal = ms => {
    const c = new AbortController();
    sent.push({ ms, parked: false, abort: () => c.abort(new DOMException('parked: no answer', 'TimeoutError')) });
    return AbortSignal.any([c.signal, AbortSignal.timeout(ms)]);
  };
  dv.onPark = () => { const r = sent.at(-1); r.parked = true; r.abort(); };
  return sent;
}
// `late`: only that step is unanswered and the rest are answered, so the park can read a context; `reads`: what the context reads
// after the unanswered step say. (The select has no script: `reads` begins with the confirm after the navigation and the read before the select.)
function holdStage(stage, { late = false, reads = null } = {}) {
  noAnswerWhenParked(); // the steps before the held one are answered as usual, so none of them can time out on a loaded runner
  dv.afterExecute = (page, s) => {
    if (!(stage === 'select' ? /location\.replace/ : HOLD_AT[stage]).test(s)) return;
    dv.afterExecute = null;
    // The reads are in sequence, not armed by what reaches the stand-in: a loaded runner can deliver the park's read before the held request.
    // Before them, one answer per GET /context the lab sends between this script and the held step: the confirm after the navigation
    // and the read before the select (select), then the check after the select (probe); the check after the probe (mark).
    if (stage === 'select') {
      dv.hangOnSelect = late ? 'late' : true;
      if (reads) dv.contextReads = [PAGE, 'NATIVE_APP', ...reads];
      return;
    }
    dv.hang = late ? true : 'queue';
    if (reads) dv.contextReads = [...(stage === 'probe' ? [PAGE, 'NATIVE_APP', PAGE] : [PAGE]), ...reads];
  };
}
const executedMarks = () => dv.executed.filter(([, s]) => MARK.test(s));
const onlyPlantStep = (stage, e) => {
  assert.equal(e.extra.needs, 'tab', stage);
  assert.match(e.message, MARK_PAUSE, stage);
  assert.doesNotMatch(e.message, /still good/, stage);
  assert.equal(loadState().deviceTab.tainted, undefined, `${stage}: no answer is not a move`);
};

test('a re-mark probe that gets no answer records it, so the next read behind it says Appium is still waiting (#104)', async () => {
  await startPhone();
  holdStage('probe');
  await failing(safari.open(['https://other.test/']));
  assert.match(loadState().deviceTab.waitingSince, /^\d{4}-/);
  dv.queue ??= []; // the probe still holds the queue
  const e = await failing(safari.url([]));
  assert.match(e.message, /^Appium is still waiting on a script the lab sent to its tab/);
});

test('open\'s read of the address right after the load waits past tabMs for a busy page (#104)', async () => {
  await startPhone();
  WAIT.tabMs = 40;
  WAIT.timeoutMs = 2000;
  let loaded = false;
  dv.delay = s => (loaded && /return location\.href/.test(s) ? 120 : 0);
  dv.afterExecute = (_, s) => { if (/location\.replace/.test(s)) loaded = true; };
  const out = await safari.open(['https://other.test/path']);
  assert.equal(out.url, 'https://other.test/path');
  neverUnsafe();
});

test('open whose probe gets no answer says so, untainted: one read and one park after it, the mark is never sent, and the marker is in no page', async () => {
  await startPhone();
  holdStage('probe');
  const e = await failing(safari.open(['https://other.test/']));
  onlyPlantStep('probe', e);
  assert.equal(probes().length, 1);
  assert.equal(marks().length, 0, 'no mark was sent');
  const s = seq();
  assert.deepEqual(s.slice(s.lastIndexOf('POST /execute/sync')), ['POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP'], 'after the probe: one read and one park, nothing else');
  assert.match(runLog(), /safari plant: no answer stage=probe, not tainted page=/);
  ps.switchBack();
  assert.equal(dv.context, 'NATIVE_APP', 'the park ran when the queue cleared');
  assert.equal(executedMarks().length, 0, 'still no mark');
  assert.equal(loadState().deviceTab.tainted, undefined);
  // The page went to another site and holds no marker: the next command finds out, and its body never runs.
  const again = await failing(safari.eval(['window.__ran = true; return 1']));
  assert.match(again.message, REMARK_REFUSAL);
  assert.equal(dv.pages[PAGE].win.__ran, undefined, 'the body never ran');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.ok(Object.values(dv.pages).every(p => p.win.name !== loadState().deviceTab.token));
  neverUnsafe();
});

test('open on the same site whose probe gets no answer goes on untainted after switching back', async () => {
  await startPhone();
  holdStage('probe');
  const e = await failing(safari.open(['https://example.com/other-page']));
  onlyPlantStep('probe', e);
  ps.switchBack();
  assert.equal((await safari.url([])).title, 'Example');
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal(executedMarks().length, 0);
  neverUnsafe();
});

test('open whose mark gets no answer says so, untainted: the mark that runs late runs in the lab\'s tab, and the next command taints at the new site', async () => {
  await startPhone();
  holdStage('mark');
  const e = await failing(safari.open(['https://other.test/']));
  onlyPlantStep('mark', e);
  assert.equal(probes().length, 1);
  assert.equal(marks().length, 1, 'the mark was sent once');
  const s = seq();
  assert.deepEqual(s.slice(s.lastIndexOf('POST /execute/sync')), ['POST /execute/sync', 'GET /context', 'POST /context NATIVE_APP'], 'after the mark: one read and one park, nothing else');
  assert.match(runLog(), /safari plant: no answer stage=mark, not tainted page=/);
  ps.switchBack();
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(executedMarks().length, 1);
  assert.ok(executedMarks().every(([id]) => id === PAGE), 'the late mark ran in the lab\'s tab only');
  assert.equal(loadState().deviceTab.tainted, undefined);
  const again = await failing(safari.eval(['window.__ran = true; return 1']));
  assert.match(again.message, REMARK_REFUSAL);
  assert.equal(dv.pages[PAGE].win.__ran, undefined, 'the body never ran');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  neverUnsafe();
});

test('open whose mark gets no answer, when the page came back to its own origin, goes on untainted after switching back', async () => {
  await startPhone();
  noAnswerWhenParked();
  // The marker is gone (the page went through another site and came back), so the probe asks for the mark.
  dv.afterExecute = (page, s) => {
    if (!/location\.replace/.test(s)) return;
    page.win.name = '';
    dv.afterExecute = (p, t) => { if (PROBE.test(t)) { dv.afterExecute = null; dv.hang = 'queue'; } };
  };
  const e = await failing(safari.open(['https://example.com/other-page']));
  onlyPlantStep('mark', e);
  assert.equal(marks().length, 1);
  ps.switchBack();
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token, 'the late mark put the marker back');
  assert.equal((await safari.url([])).title, 'Example');
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('an off-site redirect while the probe or the mark is unanswered: the next command taints at the requested site, and the late mark writes nothing', async () => {
  for (const stage of ['probe', 'mark']) {
    await startPhone();
    holdStage(stage);
    const e = await failing(safari.open(['https://other.test/']));
    onlyPlantStep(stage, e);
    // While the tab is not showing it is redirected: a new document on another site.
    Object.assign(dv.pages[PAGE], { href: 'https://evil.test/', origin: dv.nextOrigin++ });
    dv.pages[PAGE].win.name = '';
    ps.switchBack();
    const again = await failing(safari.eval(['window.__ran = true; return 1']));
    assert.match(again.message, REMARK_REFUSAL, stage);
    assert.equal(dv.pages[PAGE].win.__ran, undefined, stage);
    assert.deepEqual(loadState().deviceTab, tainted('https://other.test'), stage);
    assert.ok(Object.values(dv.pages).every(p => p.win.name !== loadState().deviceTab.token), `${stage}: the marker is in no page`);
    neverUnsafe();
  }
});

test('a mark that runs late runs in the page it was sent to, not the page the driver is in by then, and writes nothing there', async () => {
  await startPhone();
  holdStage('mark');
  const { token } = loadState().deviceTab;
  const e = await failing(safari.open(['https://other.test/']));
  onlyPlantStep('mark', e);
  // The queue is still blocked: a new page takes the driver, and the lab's document is replaced. The held mark was
  // sent to the lab's tab (the driver fixes the page when a command starts), so it runs there, finds another document, and writes nothing.
  addPage(OTHER_PAGE, 'https://other.test/inbox');
  dv.pages[PAGE].origin = dv.nextOrigin++;
  ps.switchBack();
  assert.equal(executedMarks().length, 1);
  assert.ok(executedMarks().every(([id]) => id === PAGE), 'the late mark ran in the lab\'s tab only');
  assert.equal(dv.pages[OTHER_PAGE].runs, 0, 'nothing ran in the page that took the driver');
  assert.ok(Object.values(dv.pages).every(p => p.win.name !== token), 'no page holds the marker');
  assert.equal(loadState().deviceTab.tainted, undefined);
  const again = await failing(safari.eval(['1']));
  assert.equal(again.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  neverUnsafe();
});

// The one route to another page that remains (it exists without the queue): while the session rests in a page, Appium's
// onPageChange (outside its queue) can switch the driver to a page that just appeared between the lab's context check and a
// script. That script is the guard's first check, the probe or the mark: they read window.name and performance.timeOrigin
// (location.origin only on a timeOrigin match) and the lab discards what comes back from a context that moved.
test('a page that appears between the context check and the probe takes the probe: read-only, discarded, and nothing is written into it', async () => {
  await startPhone(STOCK);
  const { token } = loadState().deviceTab;
  dv.beforeExecute = s => { if (PROBE.test(s)) { dv.beforeExecute = null; addPage(OTHER_PAGE, 'https://other.test/inbox'); } };
  await safari.open(['https://other.test/']);
  const ran = dv.executed.filter(([id]) => id === OTHER_PAGE);
  assert.deepEqual(ran.filter(([, s]) => !PROBE.test(s)), [], 'only the probe ran there');
  assert.equal(ran.length, 1);
  assert.equal(dv.pages[OTHER_PAGE].win.name, '', 'nothing was written into it');
  assert.ok(dv.pages[OTHER_PAGE].win.name !== token);
  neverUnsafe();
});

test('an unanswered select, probe or mark after which the park shows another page, or no landing, taints in the taint text, never "still good"', async () => {
  const moves = [
    ['another page', [OTHER_PAGE], /did not answer while it was being marked again, and the session was attached to another page/],
    ['no landing', ['NATIVE_APP', PAGE], /did not answer while it was being marked again, and the session did not return to the native app/],
  ];
  for (const stage of ['select', 'probe', 'mark']) {
    for (const [name, tail, text] of moves) {
      await startPhone();
      holdStage(stage, { late: true, reads: tail });
      const e = await failing(safari.open(['https://other.test/']));
      const label = `${stage}, ${name}`;
      assert.equal(e.extra.needs, 'tab', label);
      assert.match(e.message, text, label);
      assert.doesNotMatch(e.message, /still good|switch back to the lab's tab/i, label);
      assert.match(pauseSteps(e), /fresh tab/, label);
      assert.doesNotMatch(pauseSteps(e), /Switch back/, label);
      assert.equal(e.moved, true, label);
      assert.deepEqual(loadState().deviceTab, tainted('https://other.test'), label);
      assert.equal(dv.context, 'NATIVE_APP', label);
      assert.match(runLog(), new RegExp(`safari plant: no answer stage=${stage} and the session was not parked page=`), label);
      neverUnsafe();
    }
  }
});

test('an unanswered select, probe or mark on a locked phone is needs "unlock", untainted, and still untainted after unlocking and switching back', async () => {
  for (const stage of ['select', 'probe', 'mark']) {
    await startPhone();
    holdStage(stage);
    const calls = phoneIs('locked');
    const e = await failing(safari.open(['https://other.test/']));
    assert.equal(e.extra.needs, 'unlock', stage);
    assert.equal(e.skipArtifacts, true, stage);
    assert.ok(calls.some(c => c.includes('lockState') && c.includes(PU)), stage);
    assert.equal(loadState().deviceTab.tainted, undefined, stage);
    phoneIs();
    ps.switchBack();
    assert.equal(dv.context, 'NATIVE_APP', stage);
    assert.equal(loadState().deviceTab.tainted, undefined, stage);
    neverUnsafe();
  }
});

test('a context that cannot be read after the probe or after the mark taints the run at once, with no retry', async () => {
  for (const which of [PROBE, MARK]) {
    await startPhone();
    dv.afterExecute = (page, s) => { if (which.test(s)) { dv.afterExecute = null; dv.contextFails = true; } };
    const e = await failing(safari.open(['https://other.test/']));
    assert.equal(e.extra.needs, 'tab', String(which));
    dv.contextFails = false;
    assert.deepEqual(loadState().deviceTab, tainted('https://other.test'), String(which));
    assert.equal(probes().length, 1);
    assert.equal(dv.context, 'NATIVE_APP');
  }
});

test('a move whose page list then cannot be read taints the run: the one retry is spent first, so moves cannot be skipped for ever', async () => {
  await startPhone(STOCK);
  let n = 0;
  dv.afterExecute = (page, s) => {
    if (!PROBE.test(s)) return;
    addPage(`WEBVIEW_9.${++n + 2}`, 'https://other.test/inbox');
    dv.contextsFail = true; // the list read that follows the move fails with a non-tab error
  };
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.equal(probes().length, 1, 'no probe is repeated');
  dv.contextsFail = false;
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('a mark that answers false after a move is discarded, not taken as an off-site redirect: the retry goes ahead', async () => {
  await startPhone(STOCK);
  dv.mapResult = (value, s) => (MARK.test(s) ? false : value); // what a mark that ran in some other page would say
  dv.afterExecute = (page, s) => { if (MARK.test(s)) { dv.afterExecute = null; addPage('WEBVIEW_9.3', 'https://other.test/inbox'); } };
  const out = await safari.open(['https://other.test/']);
  assert.equal(out.markRetried, true);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
  // With the lab's page still current, the same answer is the off-site refusal.
  await startPhone(STOCK);
  dv.mapResult = (value, s) => (MARK.test(s) ? false : value);
  const e = await failing(safari.open(['https://other.test/']));
  assert.match(e.message, /the tab did not end on https:\/\/other\.test/);
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
});

test('an open that fails before the navigation script is sent never names the site it was asked for', async () => {
  await startPhone(STOCK);
  dv.afterExecute = (page, s) => { if (/document\.readyState, location\.href/.test(s)) { dv.afterExecute = null; delete dv.pages[PAGE]; } };
  const gone = await failing(safari.open(['https://b.test/']));
  assert.equal(gone.gone, true);
  assert.equal(loadState().deviceTab.navTo, undefined);
  await startPhone(STOCK);
  dv.afterExecute = (page, s) => { if (/document\.readyState, location\.href/.test(s)) { dv.afterExecute = null; dv.onSelect = name => { if (name !== PAGE) return; dv.onSelect = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); }; } };
  const moved = await failing(safari.open(['https://b.test/']));
  assert.equal(moved.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://example.com'));
  assert.equal(executes().filter(b => /location\.replace/.test(b.script)).length, 0, 'the navigation was never sent');
  neverUnsafe();
});

test('a context that moved to something that is not a listed page is not waited out: it taints at once', async () => {
  await startPhone();
  dv.afterExecute = (page, s) => { if (PROBE.test(s)) { dv.afterExecute = null; dv.context = 'WEBVIEW_9.9'; } };
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.equal(probes().length, 1, 'no retry');
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('a context that moves right after the lab\'s tab was selected for the marker is waited out once, with nothing sent to the page that took it', async () => {
  await startPhone();
  const known = addPage('WEBVIEW_9.5', 'https://other.test/old', { win: { name: '' } }); // already listed before the navigation
  dv.context = 'NATIVE_APP';
  const replaced = () => dv.executed.some(([, s]) => /location\.replace/.test(s));
  dv.onSelect = name => { if (name === PAGE && replaced()) { dv.onSelect = null; dv.context = 'WEBVIEW_9.5'; } };
  const out = await safari.open(['https://other.test/']);
  assert.equal(out.markRetried, true);
  assert.equal(known.runs, 0);
  assert.equal(known.win.name, '');
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token);
  assert.match(runLog(), /context moved after the select page=WEBVIEW_9\.1 movedTo=known landed=WEBVIEW_9\.5 retry=true/);
  neverUnsafe();
  // The same move on the retry too: taint, and the probe was never sent.
  await startPhone();
  const known2 = addPage('WEBVIEW_9.5', 'https://other.test/old');
  dv.context = 'NATIVE_APP';
  dv.onSelect = name => { if (name === PAGE && dv.executed.some(([, s]) => /location\.replace/.test(s))) dv.context = 'WEBVIEW_9.5'; };
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.equal(probes().length, 0, 'no script was sent');
  assert.equal(known2.runs, 0);
  assert.equal(dlog.filter(([m, u, b]) => m === 'POST' && u.endsWith('/context') && b.name === PAGE).length, 4, 'selected for the state read, the replace, and twice for the mark');
  assert.equal(dv.context, 'NATIVE_APP');
  neverUnsafe();
});

test('a tab that times out and then cannot say which context the session is in taints the run', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  dv.onExecute = () => { dv.onExecute = null; dv.contextFails = true; };
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /did not answer/);
  dv.contextFails = false;
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.context, 'NATIVE_APP');
});

test('Backspace checks the tab is showing after the delete key was looked up, right before the tap', async () => {
  await startPhone();
  dv.pages[PAGE].field = true;
  dv.onNative = s => { if (s === 'mobile: source') dv.pages[PAGE].visible = false; }; // the tab leaves while the tree is read
  const e = await failing(safari.keys(['--no-verify', '\b']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /not the one showing/);
  assert.deepEqual(dlog.filter(([, , b]) => b?.script === 'mobile: tap'), [], 'no tap was sent');
  neverUnsafe();
});

// --- keys on the phone: the post-check of the field's text ---

const lowercaseKeyboard = { keyboard: (ch, v) => v + (v === '' ? ch.toUpperCase() : ch) }; // auto-capitalisation: "zq" -> "Zq"
const unguardedScripts = () => executes().filter(b => !b.script.startsWith('mobile:') && !b.script.startsWith('if (window.name !== '));
const textReads = () => dv.results.filter(([s]) => /skip: false/.test(s)).map(([s, r]) => [s, r.v]); // [script, what the page gave back]

test('keys on the phone reports caseChanged when only the case differs, and reads the field only through the guard', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '', ...lowercaseKeyboard };
  assert.deepEqual(await safari.keys(['zq']), { keyed: 2, textChecked: true, caseChanged: true });
  assert.equal(dv.pages[PAGE].field.value, 'Zq');
  assert.deepEqual(unguardedScripts(), [], 'every page script ran behind the marker check');
  assert.ok(dv.executed.every(([id]) => id === PAGE));
  assert.ok(textReads().length > 0, 'the text was compared');
  neverUnsafe();
  // Text that arrives as typed is not flagged, and what the field held before is part of the expectation.
  dv.pages[PAGE].field = { value: 'ab' };
  assert.deepEqual(await safari.keys(['cd']), { keyed: 2, textChecked: true });
  dv.pages[PAGE].field = { value: 'Ab', keyboard: (ch, v) => v + ch.toUpperCase() };
  assert.deepEqual(await safari.keys(['cd']), { keyed: 2, textChecked: true, caseChanged: true });
});

test('keys on the phone sends each character once to a field that resets itself but fires events, and skips the text check', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '  ', keyboard: () => '  ', resetTo: '  ', fireEvents: true };
  assert.deepEqual(await safari.keys(['zqx']), { keyed: 3, unverified: 3, byEvent: 3, textChecked: false, textSkip: 'unverified' });
  assert.equal(dv.keys, 3);
  assert.deepEqual(unguardedScripts(), [], 'listeners were installed and removed behind the marker check');
  assert.equal(dv.pages[PAGE].win.__mslKeysEv, undefined);
  assert.deepEqual(Object.values(dv.pages[PAGE].listeners).flat(), []);
  dv.keys = 0;
  assert.deepEqual(await safari.keys(['\b\b\b\b\b']), { keyed: 5, unverified: 5, byEvent: 5, textChecked: false, textSkip: 'backspace' });
  assert.equal(dv.pages[PAGE].field.value, '  ');
  neverUnsafe();
});

// The same on the phone: a press the keyboard dropped (`keyboard` gives the text back unchanged) that still fires its events.
const droppingKeyboard = (...drops) => { let n = 0; return (ch, v) => (drops.includes(++n) ? v : v + ch); };

test('keys on the phone sends a dropped press again though it fired its events, once the field has changed: exact, text compared', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '', fireEvents: true, keyboard: droppingKeyboard(2) };
  assert.deepEqual(await safari.keys(['abc']), { keyed: 3, retries: 1, textChecked: true });
  assert.equal(dv.pages[PAGE].field.value, 'abc');
  assert.equal(dv.keys, 4);
  neverUnsafe();
});

test('keys on the phone fails when the first press was dropped with its events and the rest landed, and does not show the text', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '', fireEvents: true, keyboard: droppingKeyboard(1) };
  const e = await failing(safari.keys(['CANARY']));
  assert.match(e.message, /^keys: the field is 1 character short of what was sent \(expected \+6, got \+5\); a keypress was probably dropped/);
  assert.doesNotMatch(e.message, /ANARY/);
  assert.equal(e.extra, undefined, 'not a tab failure');
  neverUnsafe();
});

test('keys on the phone fails a readable field the page reformats, without the typed text', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '', keyboard: (ch, v) => `${v}${ch}-` };
  const e = await failing(safari.keys(['qzjxk']));
  assert.match(e.message, /^keys: the keyboard or the page changed the text/);
  assert.doesNotMatch(e.message, /qzjxk|qz/i);
  assert.equal(e.extra, undefined, 'not a tab failure');
  neverUnsafe();
});

test('keys on the phone sends nothing more to the page once the tab was refused: the marker is not cleared in the finally', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '' };
  dv.onExecute = page => { if (dv.executed.at(-1)[1].includes('delete window.__mslKeysField')) page.visible = false; }; // the tab leaves after the first clear
  const e = await failing(safari.keys(['ab']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(executes().filter(b => b.script.includes('delete window.__mslKeysField')).length, 1, 'the clear in the finally was not sent');
  assert.equal(dv.keys, 0);
  assert.equal(loadState().deviceTab.tainted, undefined);
  neverUnsafe();
});

test('keys on the phone checks the length of a password field: short fails, long is a warning, and neither shows text', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '', type: 'password', fireEvents: true, keyboard: droppingKeyboard(1) };
  await assert.rejects(safari.keys(['abc']), /the field is 1 character short of what was sent \(expected \+3, got \+2\)/);
  dv.pages[PAGE].field = { value: '', type: 'password', keyboard: (ch, v) => `${v}${ch}-` };
  assert.deepEqual(await safari.keys(['abc']), { keyed: 3, textChecked: false, textSkip: 'password', warning: 'the field grew by 6 characters, 3 were sent: the page may format input' });
  neverUnsafe();
});

test('keys on the phone still fails on a field that neither changes nor fires events', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '  ', keyboard: () => '  ' };
  const e = await failing(safari.keys(['z']));
  assert.match(e.message, /character #1 did not land after 3 attempts/);
  assert.equal(dv.keys, 3);
  assert.equal(dv.pages[PAGE].win.__mslKeysEv, undefined);
  neverUnsafe();
});

test('keys on the phone fails when the keyboard changed the text beyond case, without saying what is in the field', async () => {
  await startPhone();
  dv.pages[PAGE].field = { value: '', keyboard: (ch, v) => (v + ch === 'zqx' ? 'zqy' : v + ch) }; // an autocorrect that keeps the length
  const e = await failing(safari.keys(['zqx']));
  assert.match(e.message, /^keys: the keyboard or the page changed the text/);
  assert.doesNotMatch(e.message, /zq/i);
  assert.equal(e.extra, undefined, 'not a tab failure');
  assert.deepEqual(unguardedScripts(), []);
  neverUnsafe();
});

test('keys on the phone does not compare a password field, says so, and its text never leaves the page', async () => {
  await startPhone();
  dv.pages[PAGE].field = { type: 'password', value: '', keyboard: (ch, v) => v + 'Q' }; // differs beyond case from what was sent
  assert.deepEqual(await safari.keys(['hunter2']), { keyed: 7, textChecked: false, textSkip: 'password' });
  assert.equal(dv.pages[PAGE].field.value, 'QQQQQQQ');
  assert.ok(textReads().some(([, v]) => v?.skip === 'password'), 'the field was asked about and said to skip');
  assert.equal(textReads().some(([, v]) => 'value' in (v ?? {})), false, 'no value came back');
  assert.doesNotMatch(JSON.stringify(textReads()), /Q|hunter/);
  neverUnsafe();
});

test('keys on the phone says why the text was not compared: every skip has a reason and none shows the text', async () => {
  const differ = (ch, v) => v + 'Q'; // would fail the check if it ran
  const cases = [
    ['no-verify', ['--no-verify', 'ab'], { value: '', keyboard: differ }, { keyed: 2, verified: false, textChecked: false, textSkip: 'no-verify' }],
    ['newline', ['a\n'], { value: '', keyboard: differ }, { keyed: 2, textChecked: false, textSkip: 'newline' }],
    ['backspace', ['ab\b'], { value: '', keyboard: differ }, { keyed: 3, textChecked: false, textSkip: 'backspace' }],
    ['unverified', ['c'], { value: 'ab', max: 2, keyboard: (ch, v) => (v.length >= 2 ? v : v + ch) }, { keyed: 1, unverified: 1, textChecked: false, textSkip: 'unverified' }],
    ['caret', ['x'], { value: 'abc', sel: [0, 0], keyboard: differ }, { keyed: 1, textChecked: false, textSkip: 'caret' }],
    ['contenteditable', ['ab'], { value: '', editable: true, keyboard: differ }, { keyed: 2, textChecked: false, textSkip: 'contenteditable' }],
  ];
  for (const [name, argv, field, want] of cases) {
    await startPhone();
    dv.pages[PAGE].field = field;
    if (name === 'backspace') dv.pages[PAGE].field.keyboard = (ch, v) => v + ch;
    const out = await safari.keys(argv);
    assert.deepEqual(out, want, name);
    assert.doesNotMatch(JSON.stringify(out), /Q|abc/, name);
    neverUnsafe();
  }
  // The field vanishes before the lab can read it.
  await startPhone();
  dv.pages[PAGE].field = { value: '' };
  dv.onExecute = page => { if (/skip: false/.test(dv.executed.at(-1)[1])) page.field = null; };
  assert.deepEqual(await safari.keys(['ab']), { keyed: 2, unverified: 2, textChecked: false, textSkip: 'unreadable' });
  // A run that was compared says so, and the simulator's output has none of these fields.
  await startPhone();
  dv.pages[PAGE].field = { value: '' };
  assert.deepEqual(await safari.keys(['ab']), { keyed: 2, textChecked: true });
});

test('ui on the phone keeps only the web view: the owner\'s tab title in Safari\'s tab bar is neither written nor listed, and a tree with two web views is refused', async () => {
  await startPhone();
  const out = await safari.ui();
  const xml = fs.readFileSync(out.file, 'utf8');
  assert.match(xml, /^<XCUIElementTypeWebView[\s\S]*<\/XCUIElementTypeWebView>$/);
  assert.doesNotMatch(xml + JSON.stringify(out), /private\.test|TabBarItemTitle|Inbox/);
  assert.deepEqual(out.labels, ['Example Domain']);
  dv.webViews = 2;
  const files = () => fs.readdirSync(loadState().run).filter(f => f.endsWith('.xml')).length;
  const before = files();
  const e = await failing(safari.ui());
  assert.match(e.message, /2 web views/);
  assert.equal(files(), before, 'nothing was written');
  neverUnsafe();
});

test('a selector with / or % works on the phone: its reference is URL-safe and click and type find the element again', async () => {
  await startPhone();
  const css = 'a[href="/a%20b/c"]';
  dv.pages[PAGE].els = { [css]: 1 };
  assert.deepEqual(await safari.click([css]), { clicked: css, matches: 1 });
  assert.equal(dv.pages[PAGE].clicked, css);
  assert.deepEqual(await safari.type([css, 'hi']), { typed: 2, into: css });
  assert.equal(dv.pages[PAGE].elCache[css].v, 'hi');
  assert.deepEqual(dlog.filter(([, u]) => /\/element\//.test(u)), [], 'no element request ever reaches Appium on the phone');
  assert.ok(executes().some(b => b.args[0] === css && /el\.click\(\)/.test(b.script)) && executes().some(b => b.args[0] === css && b.args[1] === 'hi'), 'the selector travels as a plain argument of the guarded script');
  // A reference the lab did not make is refused, not guessed at.
  await assert.rejects(safari.click(['nothing']), /no element matches/);
  neverUnsafe();
});

// --- the tab guard: where the driver is before a select, a timed-out close, the steps for a person ---

test('a guarded call finds the driver already in a page that is not the lab\'s: it taints the run and sends nothing to that page', async () => {
  await startPhone();
  dv.context = OTHER; // a park that failed earlier left the driver in the owner's tab
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.extra.human.join(' '), /fresh tab/); // a moved error is a tainted one: no "switch back"
  assert.doesNotMatch(e.extra.human.join(' '), /Switch back/);
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(executes().length, 0, 'no script was sent');
  assert.deepEqual(dlog.filter(([m, u, b]) => m === 'POST' && u.endsWith('/context') && b.name !== 'NATIVE_APP'), [], 'nothing was selected');
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(dv.pages[OTHER].runs, 0);
  assert.equal(dv.pages[OTHER].win.name, 'owner-state');
  // The marker step after a navigation is held to the same rule.
  await startPhone();
  dv.afterExecute = (page, s) => { if (/location\.replace/.test(s)) { dv.afterExecute = null; dv.context = OTHER; } };
  const e2 = await failing(safari.open(['https://other.test/']));
  assert.equal(e2.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.equal(executes().filter(b => /readyState !== "complete"/.test(b.script)).length, 0, 'the marker script was never sent');
});

test('closing: an arm script that times out while the context moved is a race too', async () => {
  await startPhone(STOCK);
  noAnswerWhenParked();
  dv.hang = true;
  dv.onExecute = () => { dv.onExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); }; // a page pulled the driver away
  const out = await safari.stop();
  assert.equal(out.closeRace, true);
  assert.equal(out.tabClosed, false);
  assert.match(out.human[0], /longer to leave its tab than the close timer/);
  assert.match(out.human.at(-1), /by hand/);
  assert.equal(loadState().session, undefined);
  neverUnsafe();
  // A timeout that left the driver where it was is not a race.
  await startPhone(STOCK);
  noAnswerWhenParked();
  dv.hang = true;
  const out2 = await safari.stop();
  assert.equal(out2.closeRace, undefined);
  assert.equal(out2.human.length, 1);
  assert.match(out2.human[0], /by hand/);
});

test('a tab failure tells a person to switch back when the tab is only hidden, and to start over when the run is tainted', async () => {
  await startPhone(STOCK);
  dv.pages[PAGE].field = true;
  dv.pages[PAGE].visible = false;
  const hidden = await failing(safari.keys(['--no-verify', 'a']));
  assert.equal(hidden.extra.needs, 'tab');
  assert.match(hidden.extra.human.join(' '), /Switch back to the lab's tab/);
  assert.equal(loadState().deviceTab.tainted, undefined, 'a hidden tab does not taint');
  const spoils = [['no marker', () => { dv.pages[PAGE].win.name = ''; }], ['moved to another site', () => { dv.pages[PAGE].href = 'https://sub.example.com/page'; }]];
  for (const [name, spoil] of spoils) {
    await startPhone(STOCK);
    spoil();
    const first = await failing(safari.eval(['1']));
    const again = await failing(safari.eval(['1'])); // the recorded run is tainted now
    for (const e of [first, again]) {
      assert.equal(e.extra.needs, 'tab', name);
      assert.doesNotMatch(e.extra.human.join(' '), /Switch back/, name);
      assert.match(e.extra.human.join(' '), /Run `safari start`.*fresh tab.*Close the old lab tab on the phone by hand/, name);
    }
  }
  // A context that moved taints, and the error made before the taint carries the same steps.
  await startPhone(STOCK);
  noAnswerWhenParked();
  dv.hang = true;
  dv.onExecute = () => { dv.onExecute = null; addPage('WEBVIEW_9.3', 'https://example.com/other-tab'); };
  const moved = await failing(safari.eval(['1']));
  assert.match(moved.message, /did not answer/);
  assert.doesNotMatch(moved.extra.human.join(' '), /Switch back/);
  assert.match(moved.extra.human.join(' '), /fresh tab/);
  // A tab that is merely gone is not a taint: switching back is still the first step.
  await startPhone(STOCK);
  delete dv.pages[PAGE];
  assert.match((await failing(safari.eval(['1']))).extra.human.join(' '), /Switch back to the lab's tab/);
});

test('a tab error made before the taint, while the marker is put back after a navigation, carries the tainted steps', async () => {
  await startPhone();
  // The lab's tab vanishes once the navigation was sent, and the driver is found in the owner's tab when the park looks.
  dv.afterExecute = (page, script) => {
    if (!/location\.replace/.test(script)) return;
    dv.afterExecute = null;
    delete dv.pages[PAGE];
    dv.contextReads = [PAGE, OTHER]; // the confirm after the navigation, then the park after the failed marker step
  };
  const e = await failing(safari.open(['https://other.test/']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /the lab's tab is gone/);
  assert.deepEqual(loadState().deviceTab, tainted('https://other.test'));
  assert.doesNotMatch(e.extra.human.join(' '), /Switch back/);
  assert.match(e.extra.human.join(' '), /fresh tab/);
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(dv.pages[OTHER].runs, 0);
  neverUnsafe();
});

// --- the page pin: a tab the owner opens never receives a lab script ---
// The phone's Appium runs the lab's msl-page-pin plugin (the stand-in's default: `dv.pinned`): a page that
// appears is only listed, a page that goes takes the session native, and a script is refused when the session
// is not on the page the lab selected. Every one of these ends with neverUnsafe and nothing run in the new tab.

const NEW_TAB = 'WEBVIEW_9.3';
const newTab = () => addPage(NEW_TAB, 'https://private.test/new', { win: { name: 'owner-state-2' } });
const untouched = tab => {
  assert.equal(tab.runs, 0, 'no lab script ran in the new tab');
  assert.equal(tab.driverRuns, 0, 'the driver ran nothing in the new tab');
  assert.equal(tab.win.name, 'owner-state-2');
};
const GUARD_CHECK = s => s.includes('if (window.name !==');

test('pin: a tab that opens between the context check and the guard\'s check does not take the script', async () => {
  await startPhone();
  let tab;
  dv.beforeExecute = s => { if (GUARD_CHECK(s)) { dv.beforeExecute = null; tab = newTab(); } };
  const out = await safari.eval(['1']);
  assert.equal(out.value, 1);
  assert.ok(tab, 'the tab did open mid-command');
  assert.ok(dv.executed.every(([id]) => id === PAGE), 'every script ran in the lab\'s tab');
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal(dv.context, 'NATIVE_APP');
  untouched(tab);
  neverUnsafe();
});

test('pin: a tab that opens before the re-mark probe, or before the mark, does not take it', async () => {
  for (const [name, hook, scripts] of [['probe', s => PROBE.test(s), probes], ['mark', s => MARK.test(s), marks]]) {
    await startPhone();
    const { token } = loadState().deviceTab;
    let tab;
    dv.beforeExecute = s => { if (hook(s)) { dv.beforeExecute = null; tab = newTab(); } };
    const out = await safari.open(['https://example.org/']);
    assert.equal(out.markRetried, undefined, `${name}: no move to wait out`);
    assert.equal(scripts().length, 1, name);
    assert.equal(probes().length, 1, name);
    assert.equal(marks().length, 1, name);
    assert.equal(dv.pages[PAGE].win.name, token, `${name}: the lab's tab is marked`);
    assert.equal(loadState().deviceTab.tainted, undefined);
    assert.ok(dv.executed.every(([id]) => id === PAGE), name);
    untouched(tab);
    neverUnsafe();
  }
});

test('pin: a tab that opens between the select and the read that confirms it does not move the lab, for eval and for open', async () => {
  for (const command of [() => safari.eval(['1']), () => safari.open(['https://example.org/'])]) {
    await startPhone();
    let tab;
    dv.onSelect = n => { if (n === PAGE) { dv.onSelect = null; tab = newTab(); } };
    const out = await command();
    assert.ok(out.value === 1 || out.finalUrl === 'https://example.org/', JSON.stringify(out));
    assert.equal(out.markRetried, undefined);
    assert.equal(loadState().deviceTab.tainted, undefined);
    assert.ok(tab);
    untouched(tab);
    neverUnsafe();
  }
});

test('pin: the lab\'s tab closing under a select takes the session native: refused, tainted, and the owner\'s tab is never followed', async () => {
  await startPhone();
  dv.onSelect = n => { if (n === PAGE) { dv.onSelect = null; dv.pages[PAGE].win.close(); } };
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(executes().length, 0, 'nothing was sent to a page');
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.closedWhile, PAGE);
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(dv.pages[OTHER].driverRuns, 0, 'the driver did not follow the key tab');
  neverUnsafe();
});

test('pin: without the plugin\'s pin the lab\'s own checks still catch a page that took the script (the tripwires)', async () => {
  // The same three moments as above, now with the stock driver taking the new tab.
  await startPhone();
  dv.pinned = false;
  let tab;
  dv.beforeExecute = s => { if (GUARD_CHECK(s)) { dv.beforeExecute = null; tab = newTab(); } };
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(tab.runs, 1, 'the check did land there: this is what the pin prevents');
  assert.equal(tab.win.name, 'owner-state-2');
  for (const hook of [s => PROBE.test(s), s => MARK.test(s)]) {
    await startPhone();
    dv.pinned = false;
    dv.beforeExecute = s => { if (hook(s)) { dv.beforeExecute = null; tab = newTab(); } };
    const out = await safari.open(['https://example.org/']);
    assert.equal(out.markRetried, true);
    assert.equal(tab.win.name, 'owner-state-2', 'nothing was written into it');
    assert.equal(loadState().deviceTab.tainted, undefined);
  }
});

test('pin: a refusal from the plugin is a move: tainted, nothing ran, said in words a person can act on', async () => {
  // A script sent while the driver holds another page (the plugin's execute guard).
  await startPhone();
  const started = dv.executed.length; // the tag check at start
  dv.beforeExecute = s => { if (GUARD_CHECK(s)) { dv.beforeExecute = null; dv.context = OTHER_PAGE; } };
  let e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /the session was not on the lab's tab when the script was sent; the page pin refused it, nothing ran/);
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(dv.executed.length, started, 'the script ran nowhere');
  assert.equal(dv.context, 'NATIVE_APP');
  // The probe and the mark, after a navigation.
  for (const hook of [s => PROBE.test(s), s => MARK.test(s)]) {
    await startPhone();
    dv.beforeExecute = s => { if (hook(s)) { dv.beforeExecute = null; dv.context = OTHER_PAGE; } };
    e = await failing(safari.open(['https://example.org/']));
    assert.equal(e.extra.needs, 'tab');
    assert.match(e.message, /the page pin refused it, nothing ran/);
    assert.deepEqual(loadState().deviceTab, tainted('https://example.org'));
    assert.equal(dv.executed.filter(([id]) => id !== PAGE).length, 0);
    assert.equal(dv.context, 'NATIVE_APP');
  }
  // The select itself refused (the plugin's selectPage guard).
  await startPhone();
  dv.refuseSelect = true;
  e = await failing(safari.eval(['1']));
  assert.match(e.message, /the page pin refused it, nothing ran/);
  assert.deepEqual(loadState().deviceTab, tainted());
  assert.equal(executes().length, 0);
  neverUnsafe();
});

test('pin: a device session without the plugin\'s marker is ended before anything is read, and the tab it opened is named', async () => {
  deviceReset();
  ps.fx.pin = false; // an Appium without the plugin
  withPhone();
  phoneIs();
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  const e = await failing(safari.start(['--device', PU]));
  assert.equal(e.extra.needs, 'service');
  assert.match(e.message, /Appium is running without the lab's page pin/);
  assert.equal(e.extra.tabLeft, 'new');
  assert.equal(e.extra.tabClosed, false);
  assert.match(e.extra.human[0], /^The lab opened a Safari tab \(https:\/\/example\.com\/\?msl-[0-9a-f]{8}\) but couldn't confirm it/);
  assert.ok(e.extra.human.some(h => /page pin plugin/.test(h)) && e.extra.human.some(h => /lab service install/.test(h)), 'the pin\'s own steps');
  assert.equal(e.extra.keyboardRestored, true);
  assert.deepEqual(keyboardCalls().map(([m, , b]) => [m, b]), [['POST', { settings: { keyboardAutocorrection: true, keyboardPrediction: true } }], ['GET', undefined]]);
  assert.equal(executes().length, 0, 'not one script was sent');
  assert.deepEqual(seq().filter(l => /context|execute/.test(l)), [], 'no page was selected or read');
  assert.ok(seq().includes('DELETE /session'), 'the session was ended');
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().deviceTab, undefined);
  assert.equal(ps.fx.sessions.size, 0);
  neverUnsafe();
});

test('pin: the session records the marker, and a recorded phone session without it is ended, not reused', async () => {
  await startPhone();
  assert.equal(loadState().pagePin, 1);
  assert.equal(readSession(loadState()).pagePin, 1);
  const old = loadState().session;
  const calls = phoneIs();
  let out = await safari.start(['--device', PU]);
  assert.equal(out.reused, true, 'a pinned session is kept');
  // A session from before the pin: no record of it.
  saveState({ pagePin: null });
  assert.equal(readSession(loadState()).pagePin, undefined);
  dlog.length = 0;
  out = await safari.start(['--device', PU]);
  assert.equal(out.reused, undefined);
  assert.equal(out.recovered, true);
  assert.notEqual(out.session, old);
  assert.ok(ps.fx.sessions.has(out.session) && !ps.fx.sessions.has(old), 'the old session was deleted, a new one made');
  assert.equal(out.previousTab.tabLeft, 'previous');
  assert.equal(loadState().pagePin, 1);
  assert.ok(calls.length > 0);
  assert.throws(() => readSession({ ...loadState(), pagePin: 'yes' }), /state file is damaged/);
});

test('pin: a tab closing while the session leaves it takes the session native; the owner\'s tab is not followed', async () => {
  await startPhone();
  WAIT.closeDelayMs = 30;
  Object.assign(CLOCK, REAL_CLOCK); // the race is real time: the reply is delayed past the timer
  dv.delay = s => (/setTimeout/.test(s) ? 90 : 0); // the answer comes after the timer fired
  const out = await safari.stop();
  assert.equal(out.closeRace, true);
  assert.equal(out.tabClosed, false, 'the lab cannot say what happened to the tab');
  assert.equal(out.human[0], 'The lab took longer to leave its tab than the close timer; the session went to the native app when the tab closed and nothing else was touched.');
  assert.match(out.human.at(-1), /by hand/);
  assert.equal(dv.closedWhile, PAGE, 'the tab closed while the session was in it');
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(dv.pages[OTHER].win.name, 'owner-state');
  assert.equal(dv.pages[OTHER].runs, 0);
  assert.equal(dv.pages[OTHER].driverRuns, 0, 'the driver did not follow the key tab');
  assert.equal(loadState().session, undefined);
  neverUnsafe();
});

// --- wait: for an element, or for the page to settle ---

const waitSelectCalls = () => fx.waitCalls.filter(([k]) => k === 'select');
const settleCalls = () => fx.waitCalls.filter(([k]) => k === 'settle');
const seen = (count, visible, extra = {}) => ({ count, present: count, visible, ...extra });

test('wait returns once the element exists, with the polls it took, and sends the plain selector as it is', async () => {
  await start();
  fx.waitSeq = [{}, {}, seen(2, 1)];
  const out = await safari.wait(['#cta']);
  assert.ok(out.elapsedMs >= 0);
  assert.deepEqual({ ...out, elapsedMs: 0 }, { waited: '#cta', for: 'present', matches: 2, visible: 1, elapsedMs: 0, polls: 3 });
  assert.deepEqual(waitSelectCalls().map(([, a]) => a), [['#cta'], ['#cta'], ['#cta']]);
  assert.equal(lookups().length, 0, 'no /elements lookup');
  assert.equal(posts('/url').length, 0);
});

test('wait --visible waits until one match is rendered; --gone until none is, removed or hidden', async () => {
  await start();
  fx.waitSeq = [seen(1, 0), seen(1, 1)];
  const v = await safari.wait(['#cta', '--visible']);
  assert.deepEqual([v.for, v.matches, v.visible, v.polls], ['visible', 1, 1, 2]);
  fx.waitSeq = [seen(2, 2), seen(2, 1), seen(2, 0)];
  const hidden = await safari.wait(['.spinner', '--gone']);
  assert.deepEqual([hidden.waited, hidden.for, hidden.matches, hidden.visible, hidden.polls], ['.spinner', 'gone', 2, 0, 3]);
  fx.waitSeq = [seen(1, 1), {}];
  const removed = await safari.wait(['.spinner', '--gone']);
  assert.deepEqual([removed.matches, removed.visible, removed.polls], [0, 0, 2]);
  // Already gone: one look.
  fx.waitSeq = [{}];
  assert.equal((await safari.wait(['.spinner', '--gone'])).polls, 1);
});

test('wait --gone is not satisfied by 50 hidden matches when more exist, but is with --nth or once all were checked', async () => {
  await start();
  fx.waitSeq = [{ count: 51, present: 50, visible: 0 }];
  const e = await failing(safari.wait(['li', '--gone', '--timeout', '100']));
  assert.equal(e.message, 'timed out after 100 ms waiting for li to be gone (removed or hidden) (51 match, only the first 50 were checked)');
  assert.deepEqual([e.extra.matches, e.extra.visible], [51, 0]);
  fx.waitSeq = [{ count: 51, present: 50, visible: 0 }, { count: 50, present: 50, visible: 0 }];
  assert.equal((await safari.wait(['li', '--gone'])).polls, 2);
  fx.waitSeq = [{ count: 51, present: 1, visible: 0 }];
  assert.equal((await safari.wait(['li', '--nth', '51', '--gone'])).polls, 1);
});

test('wait sends text, nth and shadow selectors as the descriptor the other commands use, and names them as the agent typed them', async () => {
  await start();
  fx.waitSeq = [seen(3, 3)];
  const out = await safari.wait(['button', '--text', 'OK', '--nth', '2', '--visible']);
  assert.deepEqual(waitSelectCalls().at(-1)[1], [{ css: 'button', text: 'OK', nth: 2 }]);
  assert.equal(out.waited, 'button text="OK" #2');
  fx.waitSeq = [{}];
  await safari.wait(['--shadow', 'x-app', 'x-card', 'button', '--gone']);
  assert.deepEqual(waitSelectCalls().at(-1)[1], [{ css: 'button', shadow: ['x-app', 'x-card'] }]);
  fx.waitSeq = [seen(1, 1)];
  await safari.wait(['--text', 'Done', '--contains']);
  assert.deepEqual(waitSelectCalls().at(-1)[1], [{ text: 'Done', contains: true }]);
  assert.equal(lookups().length + counts().length + resolves().length, 0);
});

test('wait times out at the limit with ok:false counts and the reason, no needs, and a screenshot of the simulator', async () => {
  await start();
  const printed = [];
  const log0 = console.log;
  console.log = l => printed.push(l);
  let code;
  try { code = await cli(safari, ['wait', '#cta', '--timeout', '100'], { onError: failureArtifacts }); } finally { console.log = log0; }
  assert.equal(code, 1);
  const out = JSON.parse(printed[0]);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'timed out after 100 ms waiting for #cta to exist (no match)');
  assert.deepEqual([out.timeoutMs, out.matches, out.visible], [100, 0, 0]);
  assert.ok(out.elapsedMs >= 100 && out.elapsedMs < 3000, `elapsedMs ${out.elapsedMs}`);
  assert.ok(out.polls >= 2);
  assert.equal(out.needs, undefined);
  assert.ok(fs.existsSync(out.artifacts.screenshot) && /fail\.png$/.test(out.artifacts.screenshot));
  assert.ok(fs.existsSync(out.artifacts.source));
});

test('a wait that times out says why: how many matched, which --nth, which host, what is still visible', async () => {
  await start();
  const why = async (argv, seq) => { fx.waitSeq = seq; const e = await failing(safari.wait([...argv, '--timeout', '100'])); assert.equal(e.extra.needs, undefined); return e; };
  assert.equal((await why(['#cta', '--visible'], [seen(3, 0)])).message, 'timed out after 100 ms waiting for #cta to be visible (3 match, none visible)');
  assert.equal((await why(['#cta', '--visible'], [{}])).message, 'timed out after 100 ms waiting for #cta to be visible (no match)');
  assert.equal((await why(['li', '--nth', '5'], [{ count: 2 }])).message, 'timed out after 100 ms waiting for li #5 to exist (--nth 5 but only 2 match)');
  assert.equal((await why(['.spinner', '--gone'], [seen(4, 2)])).message, 'timed out after 100 ms waiting for .spinner to be gone (removed or hidden) (2 of 4 match still visible)');
  assert.match((await why(['--shadow', 'x-app', 'button'], [{ step: 0, hosts: 0 }])).message, /\(no element matches host "x-app"\)$/);
  const closed = await why(['--shadow', 'x-app', 'button', '--visible'], [{ step: 0, hosts: 1, rooted: 0 }]);
  assert.match(closed.message, /\(host "x-app" has no open shadow root\)$/);
  // A missing host is gone; a host that can't be looked into is not.
  fx.waitSeq = [{ step: 0, hosts: 0 }];
  assert.equal((await safari.wait(['--shadow', 'x-app', 'button', '--gone', '--timeout', '100'])).polls, 1);
  assert.match((await why(['--shadow', 'x-app', 'button', '--gone'], [{ step: 0, hosts: 1, rooted: 0 }])).message, /\(host "x-app" has no open shadow root\)$/);
  const e = await why(['#cta'], [seen(0, 0)]);
  assert.deepEqual([e.extra.timeoutMs, e.extra.matches, e.extra.visible], [100, 0, 0]);
});

test('a page error ends the wait at the first poll, and an answer the lab does not understand is refused', async () => {
  await start();
  fx.waitSeq = [{ throws: 'not a valid selector' }];
  const e = await failing(safari.wait(['a[', '--timeout', '1000']));
  assert.match(e.message, /not a valid selector/);
  assert.equal(waitSelectCalls().length, 1);
  for (const bad of [{ count: 'x' }, { visible: 2, present: 1, count: 1 }, { step: 3 }, { count: -1 }, { present: 2 }]) {
    fx.waitSeq = [bad];
    fx.waitCalls = [];
    const e2 = await failing(safari.wait(['#a', '--timeout', '1000']));
    assert.equal(e2.message, 'couldn\'t check #a: the page gave an answer the lab does not understand', JSON.stringify(bad));
    assert.equal(waitSelectCalls().length, 1);
  }
  fx.waitSeq = [{ over: 1 }];
  assert.match((await failing(safari.wait(['--text', 'x', '--timeout', '1000']))).message, /more than 5000 elements to search for text "x"; give a css selector to narrow it/);
});

test('wait --settled returns once the page has been quiet for --quiet, with what it saw', async () => {
  await start();
  fx.waitSeq = [{ idleMs: 100, watchedMs: 100 }, { idleMs: 200, watchedMs: 300, mutations: 5, resources: 2 }, { idleMs: 600, watchedMs: 900, mutations: 5, resources: 2, sizeChanges: 1 }];
  const out = await safari.wait(['--settled']);
  assert.deepEqual({ ...out, elapsedMs: 0 }, { settled: true, quietMs: 500, elapsedMs: 0, polls: 3, activity: { resources: 2, mutations: 5, sizeChanges: 1 }, pendingImages: 0, skippedImages: 0 });
  assert.deepEqual(waitSelectCalls(), []);
  assert.deepEqual(settleCalls().map(([, a]) => a), [[], [], []]);
  // --quiet is what is waited for; images, fonts and the document count too; the idle time counts from the install.
  fx.waitSeq = [{ complete: false, idleMs: 900 }, { pendingImages: 1, idleMs: 900 }, { fontsLoading: true, idleMs: 900 }, { idleMs: 900, watchedMs: 150 }, { idleMs: 900, watchedMs: 600 }];
  const second = await safari.wait(['--settled', '--quiet', '500']);
  assert.equal(second.polls, 5);
  fx.waitSeq = [{ idleMs: 120, watchedMs: 120, resourcesWatched: false, observing: false }];
  const blind = await safari.wait(['--settled', '--quiet', '100']);
  assert.deepEqual([blind.resourcesWatched, blind.domWatched], [false, false]);
});

test('wait --settled times out with ok:false and the activity it saw, never the page\'s text', async () => {
  await start();
  fx.waitSeq = [{ complete: false, pendingImages: 2, fontsLoading: true, idleMs: 10, watchedMs: 900, resources: 3, mutations: 40, sizeChanges: 1 }];
  const e = await failing(safari.wait(['--settled', '--quiet', '100', '--timeout', '200']));
  assert.equal(e.message, 'timed out after 200 ms waiting for the page to settle (quiet 100 ms: the document is still loading; 2 images still loading; fonts are still loading; last change 10 ms ago, 3 resources, 40 DOM changes, 1 size changes)');
  assert.equal(e.extra.needs, undefined);
  assert.deepEqual({ ...e.extra, elapsedMs: 0, polls: 0 }, { timeoutMs: 200, elapsedMs: 0, polls: 0, quietMs: 100, activity: { resources: 3, mutations: 40, sizeChanges: 1 }, pendingImages: 2, skippedImages: 0, complete: false });
  assert.ok(e.extra.polls >= 2);
  fx.waitSeq = [{ pendingImages: 1, skippedImages: 36, idleMs: 900 }];
  const skipped = await failing(safari.wait(['--settled', '--quiet', '100', '--timeout', '200']));
  assert.match(skipped.message, /1 image still loading \(36 more off-screen or hidden, not waited for\); last change 900 ms ago/);
  assert.equal(skipped.extra.skippedImages, 36);
  for (const bad of [{ idleMs: 1.5 }, { complete: 'yes' }, { mutations: -1 }, { observing: 1 }]) {
    fx.waitSeq = [bad];
    assert.match((await failing(safari.wait(['--settled', '--timeout', '1000']))).message, /couldn't read the page's activity: the page gave an answer the lab does not understand/, JSON.stringify(bad));
  }
});

test('a bad wait is refused before the session is asked anything', async () => {
  await start();
  log.length = 0;
  for (const argv of [[], ['--settled', 'a'], ['a', '--visible', '--gone'], ['a', '--quiet', '200'], ['a', '--label', 'x'], ['a', '--timeout', '5'], ['a', '--timeout', '70000'], ['--settled', '--quiet', '600', '--timeout', '500']]) {
    await assert.rejects(safari.wait(argv), /usage: safari wait/, JSON.stringify(argv));
  }
  assert.deepEqual(log, []);
});

test('open --wait-for and --settle wait after the page, the reinjected scripts first, and report both', async () => {
  await start();
  const file = path.join(path.dirname(loadState().run), 'a.user.js');
  fs.writeFileSync(file, 'window.a = 1;\n');
  await safari.inject([file]);
  fx.waitSeq = [seen(1, 1)];
  log.length = 0;
  const out = await safari.open(['http://127.0.0.1:3000/x', '--reinject', '--wait-for', '.card', '--settle']);
  assert.deepEqual([out.url, out.title, out.reinjected], ['http://127.0.0.1:3000/x', 'Example', [file]]);
  assert.deepEqual({ ...out.waitFor, elapsedMs: 0 }, { waited: '.card', for: 'present', matches: 1, visible: 1, elapsedMs: 0, polls: 1 });
  assert.equal(out.settle.settled, true);
  assert.equal(out.settle.quietMs, 500);
  const order = posts('/execute/sync').map(([, , b]) => (b.script.includes('performance.timeOrigin') ? 'doc' : b.script.includes('GM_info') ? 'inject' : b.script.includes('scanSel(sel)') ? 'select' : b.script.includes('__mslSettle') ? 'settle' : '?'));
  assert.deepEqual([...new Set(order)], ['doc', 'inject', 'select', 'settle']);
  assert.ok(order.lastIndexOf('doc') < order.indexOf('inject') && order.indexOf('inject') < order.indexOf('select') && order.indexOf('select') < order.indexOf('settle'));
  // refresh takes the same flags; --timeout is each wait's own.
  fx.waitSeq = [{}, seen(1, 0)];
  const r = await safari.refresh(['--wait-for', '#a', '--timeout', '2000']);
  assert.equal(r.waitFor.polls, 2);
  assert.equal(r.settle, undefined);
  assert.equal((await safari.refresh(['--settle'])).settle.settled, true);
  // Without the flags the output is what it was.
  assert.deepEqual(await safari.refresh([]), { url: 'http://127.0.0.1:3000/x', title: 'Example' });
});

test('open --wait-for that never comes fails with ok:false, and still says the page loaded and where', async () => {
  await start();
  fx.waitSeq = [{}];
  const e = await failing(safari.open(['http://127.0.0.1:3000/never', '--wait-for', '.card', '--timeout', '100']));
  assert.equal(e.message, 'timed out after 100 ms waiting for .card to exist (no match)');
  assert.deepEqual([e.extra.navigated, e.extra.url, e.extra.title, e.extra.timeoutMs, e.extra.matches], [true, 'http://127.0.0.1:3000/never', 'Example', 100, 0]);
  assert.equal(e.extra.needs, undefined);
  assert.equal(fx.doc.href, 'http://127.0.0.1:3000/never');
  const s = await failing((fx.waitSeq = [{ idleMs: 0, watchedMs: 0 }], safari.refresh(['--settle', '--timeout', '600'])));
  assert.match(s.message, /^timed out after 600 ms waiting for the page to settle/);
  assert.equal(s.extra.navigated, true);
});

test('open and refresh refuse a bad --wait-for, --timeout or --settle before navigating', async () => {
  await start();
  log.length = 0;
  for (const [cmdName, argv, re] of [
    ['open', ['http://127.0.0.1:3000/x', '--wait-for', ' '], /open: --wait-for needs a css selector/],
    ['open', ['http://127.0.0.1:3000/x', '--wait-for'], /--wait-for needs a value/],
    ['open', ['http://127.0.0.1:3000/x', '--wait-for', '--settle'], /open: --wait-for needs a css selector/],
    ['refresh', ['--wait-for', '--timeout', '500'], /refresh: --wait-for needs a css selector/],
    ['open', ['http://127.0.0.1:3000/x', '--timeout', '500'], /open: --timeout goes with --wait-for or --settle/],
    ['open', ['http://127.0.0.1:3000/x', '--settle', '--timeout', '70000'], /open: --timeout must be a whole number of milliseconds from 100 to 60000/],
    ['open', ['http://127.0.0.1:3000/x', '--wait-for', 'a', '--timeout', 'soon'], /--timeout must be a whole number/],
    ['open', ['http://127.0.0.1:3000/x', '--settle', '--timeout', '400'], /--timeout must be more than the 500 ms/],
    ['refresh', ['--timeout', '500'], /refresh: --timeout goes with/],
    ['refresh', ['--wait-for', ''], /refresh: --wait-for needs a css selector/],
  ]) await assert.rejects(safari[cmdName](argv), re, `${cmdName} ${argv}`);
  assert.deepEqual(log, []);
});

// wait on the phone: the real scripts run against the stand-in's fake page, one guarded call per poll.

const pageScripts = () => executes().filter(b => !b.script.startsWith('mobile:'));
const answered = () => dv.results.filter(([s]) => /scanSel\(sel\)|__mslSettle/.test(s)).map(([, v]) => v.v);

test('a device wait polls through the tab guard, one guarded call per poll, and the answers are numbers only', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.texts = { button: ['SECRET-PAGE-TEXT', 'Other'] };
  page.els = { '.card': 0 };
  let n = 0;
  dv.onExecute = () => { if (++n === 3) page.els = { '.card': 2 }; }; // appears in the third poll
  const out = await safari.wait(['.card', '--visible']);
  assert.deepEqual({ ...out, elapsedMs: 0 }, { waited: '.card', for: 'visible', matches: 2, visible: 2, elapsedMs: 0, polls: 3 });
  assert.equal(pageScripts().length, 3, 'one script per poll');
  assert.deepEqual(seq(), [...GUARDED, ...GUARDED, ...GUARDED], 'each poll is exactly one guarded call');
  for (const b of pageScripts()) assert.match(b.script, /^if \(window\.name !== "msl-tok-[0-9a-f]{16}"\)/);
  assert.deepEqual(dlog.filter(([, u]) => /\/(element|elements|url|title|source)/.test(u)), [], 'only scripts reach the page');
  for (const v of answered()) assert.ok(Object.values(v).every(x => Number.isInteger(x)), JSON.stringify(v));
  const t = await safari.wait(['button', '--text', 'Other', '--visible']);
  assert.deepEqual([t.waited, t.matches, t.visible], ['button text="Other"', 1, 1]);
  assert.ok(!JSON.stringify([out, t]).includes('SECRET'));
  neverUnsafe();
});

test('a device wait measures the same way MEASURE does: hidden elements are not visible, --gone ends when none is', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.els = { '.spin': 3 };
  const hiddenIf = pred => { page.styleOf = css => ({ display: pred(css) ? 'none' : 'block', visibility: 'visible', opacity: '1' }); };
  hiddenIf(css => css === '.spin');
  const some = await safari.wait(['.spin', '--visible']);
  assert.deepEqual([some.matches, some.visible], [3, 2], 'the first of three is display none');
  hiddenIf(() => true);
  const e = await failing(safari.wait(['.spin', '--visible', '--timeout', '100']));
  assert.match(e.message, /\(3 match, none visible\)$/);
  const gone = await safari.wait(['.spin', '--gone']);
  assert.deepEqual([gone.matches, gone.visible, gone.polls], [3, 0, 1], 'hidden counts as gone');
  page.els = {};
  assert.equal((await safari.wait(['.spin', '--gone'])).matches, 0, 'removed counts as gone');
  page.rectOf = () => ({ left: 0, top: 0, width: 1, height: 1 });
  hiddenIf(() => false);
  page.els = { '.dot': 1 };
  assert.equal((await safari.wait(['.dot', '--gone'])).visible, 0, 'under 2 px is hidden');
  neverUnsafe();
});

test('a device wait polls waitPollDeviceMs apart, not waitPollMs', async () => {
  await startPhone();
  Object.assign(WAIT, { waitPollMs: 1, waitPollDeviceMs: 40 });
  const e = await failing(safari.wait(['.never', '--timeout', '200']));
  assert.ok(e.extra.polls >= 2 && e.extra.polls <= 6, `polls ${e.extra.polls}`);
  assert.ok(e.extra.elapsedMs >= 200 && e.extra.elapsedMs < 2000);
  neverUnsafe();
});

test('a device wait that times out is ok:false with counts, no needs, and nothing read from the phone for artifacts', async () => {
  await startPhone();
  dv.pages[PAGE].texts = { button: ['SECRET-PAGE-TEXT'] };
  const e = await failing(safari.wait(['button', '--text', 'Nope', '--timeout', '100']));
  assert.equal(e.message, 'timed out after 100 ms waiting for button text="Nope" to exist (no match)');
  assert.equal(e.extra.needs, undefined);
  assert.equal(e.skipArtifacts, undefined);
  assert.deepEqual(await failureArtifacts('wait', e), {}, 'no screenshot or source from the phone');
  assert.ok(!JSON.stringify([e.message, e.extra]).includes('SECRET'));
  neverUnsafe();
});

test('a guard trip during a wait ends it with needs tab, with no further poll and no retry', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  const before = page.runs;
  let n = 0;
  dv.onExecute = p => { if (++n === 2) p.win.name = 'taken-over'; };
  const e = await failing(safari.wait(['.never', '--timeout', '5000']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(e.skipArtifacts, true);
  assert.equal(pageScripts().length, 2);
  assert.equal(page.runs - before, 2);
  neverUnsafe();
});

test('a page error in a device wait fails at the first poll with the page\'s message, no needs', async () => {
  await startPhone();
  dv.pages[PAGE].invalid = ['a['];
  const e = await failing(safari.wait(['a[', '--timeout', '5000']));
  assert.equal(e.message, 'the page script threw: not a valid selector');
  assert.equal(e.extra, undefined);
  assert.equal(pageScripts().length, 1);
  neverUnsafe();
});

test('a device wait on a locked phone is needs unlock, and polls no more', async () => {
  await startPhone();
  noAnswerWhenParked();
  dv.hang = true;
  phoneIs('locked');
  const e = await failing(safari.wait(['.never', '--timeout', '5000']));
  assert.equal(e.extra.needs, 'unlock');
  assert.equal(pageScripts().length, 1);
  neverUnsafe();
});

test('a device wait does not look at the screen: no visibility check, no native call', async () => {
  await startPhone();
  dv.pages[PAGE].els = { '.a': 1 };
  dv.pages[PAGE].visible = false;
  await safari.wait(['.a']);
  await safari.wait(['--settled', '--quiet', '100', '--timeout', '1000']);
  assert.ok(!executes().some(b => /visibilityState|^mobile:/.test(b.script)));
  neverUnsafe();
});

test('a device wait --settled installs its observers on the first poll, counts what the page does, and a new document drops them', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  await safari.open(['https://example.com/a']);
  assert.equal(page.win.__mslSettle, undefined, 'a page that never waits has no observers');
  const t0 = Date.now();
  let n = 0;
  dv.onExecute = p => { if (++n === 2) { addMutation(p, 3); addResource(p, { name: 'https://example.com/img.png', entryType: 'resource', startTime: 1, duration: 1 }); } };
  const out = await safari.wait(['--settled', '--quiet', '120', '--timeout', '3000']);
  assert.equal(out.settled, true);
  assert.equal(out.quietMs, 120);
  assert.ok(out.polls >= 3 && Date.now() - t0 >= 120);
  assert.deepEqual(out.activity, { resources: 1, mutations: 3, sizeChanges: 0 });
  assert.equal(out.pendingImages, 0);
  assert.ok(page.win.__mslSettle);
  for (const v of answered()) assert.ok(Object.values(v).every(x => typeof x === 'boolean' || Number.isInteger(x)), JSON.stringify(v));
  assert.ok(!JSON.stringify(out).includes('img.png'), 'no address from the page');
  await safari.open(['https://example.com/b']);
  assert.equal(page.win.__mslSettle, undefined, 'a navigation drops it');
  const again = await safari.wait(['--settled', '--quiet', '100', '--timeout', '1000']);
  assert.deepEqual(again.activity, { resources: 0, mutations: 0, sizeChanges: 0 });
  neverUnsafe();
});

test('a device wait --settled that never goes quiet times out with the activity, a size change counts, and pending images hold it', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  let n = 0;
  dv.onExecute = p => { addMutation(p); if (++n % 2 === 0) p.scroll = { w: 414, h: 900 + n }; };
  const e = await failing(safari.wait(['--settled', '--quiet', '100', '--timeout', '300']));
  assert.match(e.message, /^timed out after 300 ms waiting for the page to settle \(quiet 100 ms: last change \d+ ms ago, 0 resources, \d+ DOM changes, \d+ size changes\)$/);
  assert.ok(e.extra.activity.mutations >= 2 && e.extra.activity.sizeChanges >= 1, JSON.stringify(e.extra.activity));
  assert.equal(e.extra.needs, undefined);
  dv.onExecute = null;
  await safari.open(['https://example.com/c']); // a new document: the observers are new too
  page.images = [{ complete: false }];
  const held = await failing(safari.wait(['--settled', '--quiet', '100', '--timeout', '300']));
  assert.match(held.message, /1 image still loading/);
  page.images = [];
  assert.equal((await safari.wait(['--settled', '--quiet', '100', '--timeout', '1000'])).settled, true);
  neverUnsafe();
});

test('device open --wait-for and --settle wait through the guard after the tab is marked again, and a failed wait still reports the page', async () => {
  await startPhone();
  const page = dv.pages[PAGE];
  page.els = { '.card': 1 };
  const out = await safari.open(['https://example.com/x', '--wait-for', '.card', '--settle', '--timeout', '1000']);
  assert.equal(out.finalUrl, 'https://example.com/x');
  assert.deepEqual([out.waitFor.waited, out.waitFor.matches, out.settle.settled], ['.card', 1, true]);
  const kinds = pageScripts().map(b => (/location\.replace/.test(b.script) ? 'nav' : PROBE.test(b.script) ? 'probe' : /__mslNet/.test(b.script) ? 'hooks' : /scanSel\(sel\)/.test(b.script) ? 'select' : /__mslSettle/.test(b.script) ? 'settle' : 'other'));
  const at = k => kinds.indexOf(k);
  assert.ok(at('nav') < at('probe') && at('probe') < at('hooks') && at('hooks') < at('select') && at('select') < at('settle'), kinds.join());
  // The wait fails: the tab loaded, and the output says where.
  page.els = {};
  const e = await failing(safari.refresh(['--wait-for', '.late', '--timeout', '100']));
  assert.deepEqual([e.extra.navigated, e.extra.url, e.extra.finalUrl, e.extra.needs], [true, 'https://example.com/x', 'https://example.com/x', undefined]);
  // A guard refusal during the wait passes through untouched.
  let n = 0;
  dv.onExecute = p => { if (/scanSel\(sel\)/.test(dv.executed.at(-1)[1]) && ++n === 2) p.win.name = 'taken-over'; };
  const t = await failing(safari.open(['https://example.com/y', '--wait-for', '.late', '--timeout', '5000']));
  assert.equal(t.extra.needs, 'tab');
  assert.equal(t.extra.navigated, undefined);
  neverUnsafe();
});

// --- open --storage ---
// The values are secrets. CANARY stands for one: it must never reach the output, run.log, a file in
// the run folder, an error, a script's source or the state; only a script's arguments carry it.

const CANARY = 'CANARY-zq7k';
const PAIR = `flag=${CANARY}`;

// `open --storage` goes only through the lab's Appium service with current log-filter rules (MSL_APPIUM_URL unset,
// the plist installed, the rules file as `lab service install` writes it). The stand-ins play that service: the
// session is started on their port as the service's, then the override is dropped.
const svcWorld = { pid: 4242, listener: '4242\n' }; // launchd's pid for the service, and what `lsof` says listens on its port
const serviceReplies = (cmd) => (cmd === 'launchctl' ? { stdout: `state = running\n\tpid = ${svcWorld.pid}\n` } : cmd === 'lsof' ? { stdout: svcWorld.listener } : undefined);
const useService = (target, rules = CURRENT_RULES) => {
  Object.assign(svcWorld, { pid: 4242, listener: '4242\n' });
  if (target === 'phone') phoneIs('reachable', serviceReplies); else fakeRunner(serviceReplies);
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.mkdirSync(path.dirname(logFiltersPath()), { recursive: true });
  fs.writeFileSync(plistPath(), buildPlist({ node: process.execPath, main: '/x/appium/main.js', home: HOME, port: SERVICE.port, log: '/x/log', filters: logFiltersPath(), developerDir: '/x/dev', path: '/usr/bin' }));
  if (rules !== null) fs.writeFileSync(logFiltersPath(), rules);
  delete process.env.MSL_APPIUM_URL;
};
async function startStoragePhone(stock = false) {
  SERVICE.port = ps.port;
  await startPhone(stock);
  useService('phone');
}
async function startStorageSim() {
  SERVICE.port = server.address().port;
  await start();
  useService('sim');
}

// Every place a value could land, other than the argument it travels in. `sent`: the requests the
// stand-in saw ([method, url, body]).
function noCanary(what, sent, ...printed) {
  const hay = { printed: printed.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'), state: JSON.stringify(loadState()) };
  const run = loadState().run;
  if (run && fs.existsSync(run)) {
    hay['run.log'] = runLog();
    for (const f of fs.readdirSync(run, { recursive: true })) {
      const file = path.join(run, f);
      if (fs.statSync(file).isFile()) hay[f] = fs.readFileSync(file).toString('latin1');
    }
  }
  sent.forEach(([m, u, b], i) => { hay[`request ${i} ${m} ${u}`] = `${m} ${u} ${typeof b?.script === 'string' ? b.script : ''}`; });
  for (const [where, text] of Object.entries(hay)) assert.ok(!text.includes('CANARY') && !text.includes('zq7k'), `${what}: a value is in ${where}`);
}
const holders = sent => sent.filter(([, , b]) => JSON.stringify(b ?? null).includes(CANARY)); // requests that carry a value

// What an open did on the phone, in order: the scripts that move or write.
const phoneSteps = () => pageScripts().flatMap(b => (b.script.includes(STORAGE_WRITE) ? ['write'] : /location\.replace/.test(b.script) ? [`go ${b.args[0]}`] : /location\.reload\(\)/.test(b.script) ? ['reload'] : []));

test('open --storage on the origin the tab is already on writes first, then navigates once', async () => {
  await startStoragePhone();
  const out = await safari.open(['https://example.com/app', '--storage', PAIR, '--storage', 'two=2']);
  assert.deepEqual(out.storage, { count: 2, keys: ['flag', 'two'], origin: 'https://example.com', extraLoad: false });
  assert.equal(out.finalUrl, 'https://example.com/app');
  assert.deepEqual(phoneSteps(), ['write', 'go https://example.com/app']);
  assert.deepEqual([...dv.storage['https://example.com']], [['flag', CANARY], ['two', '2']]);
  const write = executes().find(b => b.script.includes(STORAGE_WRITE));
  assert.deepEqual(write.args, [[['flag', CANARY], ['two', '2']], 'https://example.com'], 'the values are the first argument, the origin the second');
  assert.equal(holders(dlog).length, 1, 'no other request carries a value');
  assert.match(runLog(), /safari open https:\/\/example\.com\/app storage=2 keys=flag,two\n/);
  noCanary('same origin', dlog, out);
  assert.equal(out.markRetried, undefined);
  assert.equal((await safari.eval(['1'])).value, 1); // still guarded and working
  neverUnsafe();
});

test('open --storage on another origin loads its root first, writes there, then loads the address', async () => {
  await startStoragePhone();
  const out = await safari.open(['https://other.test/path?x=1', '--storage', PAIR]);
  assert.deepEqual(out.storage, { count: 1, keys: ['flag'], origin: 'https://other.test', extraLoad: true });
  assert.equal(out.finalUrl, 'https://other.test/path?x=1');
  assert.deepEqual(phoneSteps(), ['go https://other.test/', 'write', 'go https://other.test/path?x=1']);
  assert.equal(dv.storage['https://other.test'].get('flag'), CANARY);
  assert.equal(dv.storage['https://example.com'], undefined, 'nothing went into the origin the tab started on');
  const probe = probes()[0];
  assert.match(probe.script, /location\.origin === "https:\/\/other\.test" \|\| location\.origin === "https:\/\/www\.other\.test"/, 'the root load may end only on the origins asked for');
  assert.equal(probes().length, 2, 'each load was probed');
  assert.equal(marks().length, 1, 'the marker went back once: the second load stayed on the site, so it was still there');
  const tab = loadState().deviceTab;
  assert.equal(dv.pages[PAGE].win.name, tab.token);
  assert.deepEqual(tab.origins, ['https://example.com', 'https://other.test']);
  assert.equal(tab.origin, 'https://other.test');
  noCanary('other origin', dlog, out);
  neverUnsafe();
});

test('open --storage: a root that redirects off the origin taints the run and aborts before any write', async () => {
  await startStoragePhone();
  dv.redirect = { 'a.test': 'private.test' };
  dlog.length = 0;
  const e = await failing(safari.open(['https://a.test/start', '--storage', PAIR]));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(phoneSteps(), ['go https://a.test/'], 'no write, no second load');
  assert.deepEqual(dv.storage, {}, 'nothing was stored anywhere');
  assert.deepEqual(holders(dlog), []);
  assert.equal(loadState().deviceTab.tainted, true);
  assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /private\.test/);
  noCanary('root off-origin', dlog, e.message, e.extra);
  neverUnsafe();
});

test('open --storage: a root that lands on the www or https twin is refused before any write, and the run is not tainted', async () => {
  await startStoragePhone();
  dv.redirect = { 'a.test': 'www.a.test' };
  dlog.length = 0;
  const e = await failing(safari.open(['https://a.test/start', '--storage', PAIR]));
  assert.equal(e.message, 'open: the root redirected to https://www.a.test; open the final address');
  assert.equal(e.extra?.needs, undefined);
  assert.deepEqual(phoneSteps(), ['go https://a.test/']);
  assert.deepEqual(dv.storage, {});
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal((await safari.eval(['1'])).value, 1, 'the tab is still the lab\'s');
  noCanary('root twin', dlog, e.message);
  neverUnsafe();
});

test('open --storage that ends on a different origin than it wrote to is ok, with applied:false and a warning', async () => {
  await startStoragePhone();
  dv.redirect = { 'example.com': 'www.example.com' }; // the requested page lands on the www twin
  const out = await safari.open(['https://example.com/app', '--storage', PAIR]);
  assert.equal(out.storage.applied, false);
  assert.equal(out.storage.origin, 'https://example.com');
  assert.match(out.warning, /ended on another origin than https:\/\/example\.com, where --storage wrote/);
  assert.equal(out.finalUrl, 'https://www.example.com/app');
  assert.equal(dv.storage['https://example.com'].get('flag'), CANARY);
  noCanary('applied false', dlog, out);
  neverUnsafe();
});

test('open --storage refuses an address that differs from the current page only by its #fragment, before anything changes; the same address is fine', async () => {
  await startStoragePhone();
  const here = dv.pages[PAGE].href;
  dlog.length = 0;
  const e = await failing(safari.open([`${here}#frag`, '--storage', PAIR]));
  assert.match(e.message, /^open: with --storage the address must differ from the current page by more than its #fragment/);
  assert.deepEqual(phoneSteps(), []);
  assert.deepEqual(dv.storage, {});
  assert.deepEqual(holders(dlog), []);
  noCanary('fragment', dlog, e.message);
  const out = await safari.open([here, '--storage', PAIR]); // exactly the page it is on: it reloads, with the value there
  assert.equal(out.storage.extraLoad, false);
  assert.deepEqual(phoneSteps(), ['write', 'reload'], 'no navigation would load a new page, so it reloads');
  assert.equal(dv.storage['https://example.com'].get('flag'), CANARY);
  neverUnsafe();
});

test('open --storage to a #fragment of the root (another origin) still loads a new page after the write: the page\'s scripts run after it', async () => {
  await startStoragePhone();
  const out = await safari.open(['https://other.test/#x', '--storage', PAIR]);
  assert.equal(out.finalUrl, 'https://other.test/#x');
  assert.equal(out.warning, undefined);
  assert.equal(out.storage.applied, undefined);
  assert.deepEqual(phoneSteps(), ['go https://other.test/', 'write', 'go https://other.test/#x', 'reload']);
  assert.equal(dv.storage['https://other.test'].get('flag'), CANARY);
  const order = [];
  dv.executed.forEach(([, s], i) => { if (s.includes(STORAGE_WRITE)) order.push(['write', i]); else if (/location\.reload\(\)/.test(s)) order.push(['reload', i]); });
  assert.deepEqual(order.map(([k]) => k), ['write', 'reload'], 'the reload came after the write');
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token, 'the tab is marked again');
  assert.equal(marks().length >= 1, true);
  noCanary('fragment of the root', dlog, out);
  neverUnsafe();
  // The very address the tab is on: also a reload.
  const same = await safari.open(['https://other.test/#x', '--storage', 'k=v']);
  assert.equal(same.storage.extraLoad, false);
  assert.deepEqual(phoneSteps().slice(-2), ['write', 'reload']);
});

test('open --storage to a #fragment of the root on the simulator: set the fragment, then reload', async () => {
  await startStorageSim();
  log.length = 0;
  const out = await safari.open(['http://127.0.0.1:3000/#x', '--storage', PAIR]);
  assert.equal(out.url, 'http://127.0.0.1:3000/#x');
  assert.equal(out.warning, undefined);
  const steps = log.flatMap(([m, u, b]) => (m === 'POST' && u.endsWith('/url') ? [`go ${b.url}`] : m === 'POST' && u.endsWith('/refresh') ? ['reload'] : m === 'POST' && b?.script?.includes(STORAGE_WRITE) ? ['write'] : []));
  assert.deepEqual(steps, ['go http://127.0.0.1:3000/', 'write', 'go http://127.0.0.1:3000/#x', 'reload']);
  noCanary('simulator fragment', log, out);
});

test('open --storage with --reinject, --wait-for, --settle and --timeout: they apply to the final load only', async () => {
  await startStoragePhone();
  const file = path.join(path.dirname(loadState().run), 'a.user.js');
  fs.writeFileSync(file, 'window.a = 1;\n');
  await safari.inject([file]);
  dv.pages[PAGE].els = { '.card': 1 };
  dlog.length = 0;
  const out = await safari.open(['https://other.test/x', '--storage', PAIR, '--reinject', '--wait-for', '.card', '--settle', '--timeout', '1000']);
  assert.deepEqual([out.reinjected, out.waitFor.waited, out.settle.settled, out.storage.extraLoad], [[file], '.card', true, true]);
  const kinds = pageScripts().map(b => (b.script.includes(STORAGE_WRITE) ? 'write' : /location\.replace/.test(b.script) ? 'nav' : /GM_info/.test(b.script) ? 'inject' : /scanSel\(sel\)/.test(b.script) ? 'select' : /__mslSettle/.test(b.script) ? 'settle' : 'other'));
  assert.equal(kinds.filter(k => k === 'nav').length, 2);
  const [rootNav, finalNav] = [kinds.indexOf('nav'), kinds.lastIndexOf('nav')];
  assert.ok(rootNav < kinds.indexOf('write') && kinds.indexOf('write') < finalNav, kinds.join());
  for (const k of ['inject', 'select', 'settle']) assert.ok(kinds.indexOf(k) > finalNav && kinds.lastIndexOf(k) > finalNav && kinds.indexOf(k) > finalNav, `${k} after the final load only: ${kinds.join()}`);
  assert.equal(kinds.filter(k => k === 'inject').length, 1);
  noCanary('composition', dlog, out);
  neverUnsafe();
});

test('open --storage says markRetried when either load waited out a context move', async () => {
  await startStoragePhone(STOCK);
  let probesSeen = 0;
  dv.afterExecute = (page, s) => {
    if (!PROBE.test(s) || ++probesSeen !== 1) return; // the first probe: the root load's
    addPage('WEBVIEW_9.4', 'https://other.test/inbox', { win: { name: '' } });
  };
  const out = await safari.open(['https://other.test/x', '--storage', PAIR]);
  assert.equal(out.markRetried, true);
  assert.equal(out.storage.extraLoad, true);
  assert.equal(dv.storage['https://other.test'].get('flag'), CANARY);
  assert.equal(dv.pages['WEBVIEW_9.4'].runs, 0, 'no script ran in the page that took the context');
  noCanary('retried', dlog, out);
  neverUnsafe();
});

test('open --storage refuses a bad pair before any call, naming the place and never the value', async () => {
  await startStoragePhone();
  for (const argv of [['--storage', `=${CANARY}`], ['--storage', `no-equals-${CANARY}`], ['--storage', `a=${CANARY}`, '--storage', `a=${CANARY}`]]) {
    const e = await failing(safari.open(['https://other.test/', ...argv]));
    assert.match(e.message, /^open: --storage #\d/);
    noCanary('bad pair', dlog, e.message);
  }
  assert.deepEqual(dlog, [], 'nothing was asked of the phone');
  const r = await failing(safari.refresh(['--storage', PAIR]));
  assert.equal(r.message, 'refresh: --storage is for open only');
  const w = await failing(safari.refresh(['--wait-for', '--storage'])); // refresh has no --storage, wherever it sits
  assert.equal(w.message, 'refresh: --storage is for open only');
  assert.deepEqual(dlog, []);
});

test('open --storage: a page that refuses the write names the pair and the error, never the page\'s message, and keeps no artifacts', async () => {
  await startStoragePhone();
  dv.storageFail = { at: 1, name: 'QuotaExceededError' }; // the message holds the pair
  const e = await failing(safari.open(['https://example.com/app', '--storage', 'a=1', '--storage', PAIR]));
  assert.equal(e.message, 'open: the page refused --storage #2 (QuotaExceededError); the pairs before it were written');
  assert.equal(e.skipArtifacts, true);
  assert.deepEqual(e.extra.storage, { count: 2, keys: ['a', 'flag'], origin: 'https://example.com', extraLoad: false });
  assert.match(runLog(), /safari open FAILED: open: the page refused --storage #2 \(QuotaExceededError\)/);
  assert.equal(dv.storage['https://example.com'].get('a'), '1');
  assert.equal(dv.storage['https://example.com'].has('flag'), false);
  assert.deepEqual(phoneSteps(), ['write'], 'the address was not loaded');
  noCanary('page refused', dlog, e.message, e.extra);
  neverUnsafe();
});

test('open --storage: a page that moved before the write says nothing was written (-1), and a nonsense answer is refused', async () => {
  await startStoragePhone();
  dv.mapResult = (v, s) => (s.includes(STORAGE_WRITE) ? { __msl: 1, v: -1 } : v); // what the guard wraps an answer in
  const e = await failing(safari.open(['https://example.com/app', '--storage', PAIR]));
  assert.equal(e.message, 'open: the page was not on https://example.com when the storage was to be written, so none of it was');
  dv.mapResult = (v, s) => (s.includes(STORAGE_WRITE) ? { __msl: 1, v: { failed: 99, name: CANARY } } : v);
  const n = await failing(safari.open(['https://example.com/app', '--storage', PAIR]));
  assert.equal(n.message, 'open: the page gave an answer the lab does not understand when the storage was written');
  dv.mapResult = (v, s) => (s.includes(STORAGE_WRITE) ? { __msl: 1, v: { failed: 0, name: `${CANARY} bad name` } } : v);
  const m = await failing(safari.open(['https://example.com/app', '--storage', PAIR]));
  assert.equal(m.message, 'open: the page refused --storage #1 (Error); the pairs before it were written', 'a name the page made up is not printed');
  noCanary('nonsense answers', dlog, e.message, n.message, m.message);
});

test('open --storage: a failure after the write is logged without the values and keeps no artifacts of the phone, and the tab guard still refuses as before', async () => {
  await startStoragePhone();
  dv.pages[PAGE].els = {};
  const e = await failing(safari.open(['https://example.com/app', '--storage', PAIR, '--wait-for', '.late', '--timeout', '100']));
  assert.match(e.message, /timed out after 100 ms waiting for \.late/);
  assert.equal(e.skipArtifacts, true);
  assert.equal(e.extra.storage.count, 1);
  assert.equal(e.extra.navigated, true);
  assert.match(runLog(), /safari open FAILED: timed out after 100 ms/);
  noCanary('wait failed', dlog, e.message, e.extra);
  // A refusal of the guard after the write passes through with its needs, and now says the storage too.
  let n = 0;
  dv.onExecute = p => { if (/scanSel\(sel\)/.test(dv.executed.at(-1)[1]) && ++n === 1) p.win.name = 'taken-over'; };
  const t = await failing(safari.open(['https://example.com/y', '--storage', PAIR, '--wait-for', '.late', '--timeout', '5000']));
  assert.equal(t.extra.needs, 'tab');
  assert.equal(t.extra.storage.count, 1);
  noCanary('guard refused', dlog, t.message, t.extra);
  neverUnsafe();
});

const storageNeedsService = async target => {
  const refused = async (why, start) => {
    const before = start === 'phone' ? dlog.length : log.length;
    const e = await failing(safari.open(['https://example.com/app', '--storage', PAIR]));
    assert.equal(e.extra.needs, 'service', why);
    assert.equal(e.extra.then, 'lab service install');
    assert.match(e.extra.human.join(' '), /--storage .*lab service install/s);
    assert.match(e.message, why);
    assert.equal(start === 'phone' ? dlog.length : log.length, before, 'nothing was asked of the page');
    noCanary(String(why), start === 'phone' ? dlog : log, e.message, e.extra);
  };
  {
    if (target === 'phone') await startStoragePhone(); else await startStorageSim();
    fs.writeFileSync(logFiltersPath(), JSON.stringify(LOG_FILTERS.slice(3), null, 2) + '\n');
    await refused(/log-filter rules are older than this lab's/, target); // installed, stale
    fs.rmSync(logFiltersPath());
    await refused(/rules file .* is missing/, target);
    fs.writeFileSync(plistPath(), buildPlist({ node: process.execPath, main: '/x/appium/main.js', home: HOME, port: SERVICE.port, log: '/x/log', filters: logFiltersPath(), developerDir: '/x/dev', path: '/usr/bin' })
      .replace(/\s*<string>--log-filters<\/string>\s*<string>[^<]*<\/string>/, ''));
    await refused(/names no log-filter rules file/, target);
    fs.rmSync(plistPath()); // no service at all
    await refused(/the LaunchAgent is not installed/, target);
    useService(target);
    process.env.MSL_APPIUM_URL = 'http://127.0.0.1:9'; // an Appium the lab can't check
    await refused(/MSL_APPIUM_URL/, target);
    delete process.env.MSL_APPIUM_URL;
    // The files are right, but is it the service that gets the values?
    svcWorld.pid = 0;
    await refused(/launchd is not running the service/, target);
    svcWorld.pid = 4242;
    svcWorld.listener = '999\n';
    await refused(/not the service \(launchd's pid 4242, listener 999\)/, target);
    svcWorld.listener = '4242\n999\n';
    await refused(/listener 4242, 999/, target);
    svcWorld.listener = '4242\n';
    const port = loadState().port;
    saveState({ port: port + 1 }); // a session on another port than the service's
    await refused(/the session is on port \d+, not the service's \d+/, target);
    saveState({ port });
    // Current rules: it goes ahead.
    const out = await safari.open(['https://example.com/app', '--storage', PAIR]);
    assert.equal(out.storage.count, 1);
    // And without --storage nothing of this matters.
    fs.rmSync(plistPath());
    assert.equal((await safari.open(['https://example.com/plain'])).finalUrl ?? 'ok', target === 'phone' ? 'https://example.com/plain' : 'ok');
  }
};
test('open --storage on the phone needs the lab\'s service with current rules, and is refused before any page call otherwise', () => storageNeedsService('phone'));
test('open --storage on the simulator needs the lab\'s service with current rules, and is refused before any page call otherwise', () => storageNeedsService('sim'));

test('open --storage on the simulator: the same order through the page commands', async () => {
  await startStorageSim();
  const steps = () => log.flatMap(([m, u, b]) => (m === 'POST' && u.endsWith('/url') ? [`go ${b.url}`] : m === 'POST' && b?.script?.includes(STORAGE_WRITE) ? ['write'] : []));
  log.length = 0;
  const out = await safari.open(['http://127.0.0.1:3000/app?x=1', '--storage', PAIR, '--storage', 'two=2']);
  assert.deepEqual(out.storage, { count: 2, keys: ['flag', 'two'], origin: 'http://127.0.0.1:3000', extraLoad: true });
  assert.deepEqual(steps(), ['go http://127.0.0.1:3000/', 'write', 'go http://127.0.0.1:3000/app?x=1']);
  assert.deepEqual([...fx.storage['http://127.0.0.1:3000']], [['flag', CANARY], ['two', '2']]);
  assert.equal(holders(log).length, 1);
  assert.equal(out.url, 'http://127.0.0.1:3000/app?x=1');
  assert.match(runLog(), /safari open http:\/\/127\.0\.0\.1:3000\/app\?x=1 storage=2 keys=flag,two\n/);
  noCanary('simulator', log, out);
  // Already on the origin: no extra load.
  log.length = 0;
  const again = await safari.open(['http://127.0.0.1:3000/other', '--storage', 'k=v']);
  assert.equal(again.storage.extraLoad, false);
  assert.deepEqual(steps(), ['write', 'go http://127.0.0.1:3000/other']);
  // A fragment-only change is refused, and so is a root that lands elsewhere; the same address is fine.
  log.length = 0;
  await assert.rejects(safari.open(['http://127.0.0.1:3000/other#x', '--storage', 'k=v']), /more than its #fragment/);
  assert.deepEqual(steps(), []);
  assert.equal((await safari.open(['http://127.0.0.1:3000/other', '--storage', 'k=w'])).storage.applied, undefined);
  assert.equal(fx.storage['http://127.0.0.1:3000'].get('k'), 'w');
  // The page ends elsewhere than it wrote.
  fx.redirect = { '127.0.0.1:3000': '127.0.0.1:3001' };
  const moved = await safari.open(['http://127.0.0.1:3000/z', '--storage', 'k=v']);
  assert.equal(moved.storage.applied, false);
  assert.match(moved.warning, /another origin than http:\/\/127\.0\.0\.1:3000/);
  fx.redirect = { 'a.test': 'b.test' };
  log.length = 0;
  await assert.rejects(safari.open(['http://a.test/p', '--storage', PAIR]), /^Error: open: the root redirected to http:\/\/b\.test; open the final address$/);
  assert.deepEqual(steps(), ['go http://a.test/']);
  assert.equal(fx.storage['http://b.test'], undefined);
  assert.equal(fx.storage['http://a.test'], undefined);
});

test('open --storage on the simulator: a failure after the write keeps no fail.png or fail.html and logs the message only; one before it keeps them', async () => {
  await startStorageSim();
  const run = async argv => {
    const printed = [];
    const log0 = console.log;
    console.log = l => printed.push(l);
    try { assert.equal(await cli(safari, ['open', ...argv], { onError: failureArtifacts }), 1); } finally { console.log = log0; }
    return JSON.parse(printed[0]);
  };
  const failFiles = () => fs.readdirSync(loadState().run).filter(f => /^fail/.test(f));
  fx.waitSeq = [{}];
  const after = await run(['http://127.0.0.1:3000/x', '--storage', PAIR, '--wait-for', '.card', '--timeout', '100']);
  assert.equal(after.ok, false);
  assert.match(after.error, /timed out after 100 ms/);
  assert.deepEqual(after.storage, { count: 1, keys: ['flag'], origin: 'http://127.0.0.1:3000', extraLoad: true });
  assert.equal(after.artifacts, undefined);
  assert.deepEqual(failFiles(), []);
  assert.match(runLog(), /safari open FAILED: timed out after 100 ms/);
  noCanary('simulator failed after the write', log, after);
  // Before the write the page holds none of it, so the usual screenshot and source are kept.
  fx.redirect = { 'a.test': 'b.test' };
  const before = await run(['http://a.test/p', '--storage', PAIR]);
  assert.match(before.error, /the root redirected to http:\/\/b\.test/);
  assert.ok(fs.existsSync(before.artifacts.screenshot) && /fail\.png$/.test(before.artifacts.screenshot));
  assert.deepEqual(failFiles().sort(), ['fail.html', 'fail.png']);
  noCanary('simulator failed before the write', log, before);
});

// --- nothing typed or stored reaches a message, run.log or a failure artifact, by any argument form or failure path ---

// One command through `cli` with the failure artifacts on, as bin/safari runs it.
async function cliRun(...argv) {
  const printed = [];
  const log0 = console.log;
  console.log = l => printed.push(l);
  let code;
  try { code = await cli(safari, argv, { onError: failureArtifacts }); } finally { console.log = log0; }
  return { code, out: JSON.parse(printed[0]), text: printed.join('\n') };
}
const failFiles = () => (loadState().run && fs.existsSync(loadState().run) ? fs.readdirSync(loadState().run).filter(f => /^fail/.test(f)) : []);
const SIM_URL = 'http://127.0.0.1:3000/';

// What open and refresh were given that would have echoed or silently dropped a value.
const STRAY_OPEN = [
  [`--storage=tok=${CANARY}`],
  [`--storage=tok=${CANARY}`, '--settle'],
  ['--settle', `--storage=tok=${CANARY}`],
  ['--Storage', `tok=${CANARY}`],
  ['-storage', `tok=${CANARY}`],
  ['—storage', `tok=${CANARY}`],
  ['--wait-for', '--storage', `tok=${CANARY}`],
  ['--', '--storage', `tok=${CANARY}`],
  [`--x=${CANARY}`],
  [`--wait-for=${CANARY}`],
  [`--reinject=${CANARY}`],
];

test('open refuses every stray form of --storage by position, with no value in the output, run.log, a file or a request, and no fail.*', async () => {
  await startStorageSim();
  log.length = 0;
  for (const words of STRAY_OPEN) {
    const r = await cliRun('open', SIM_URL, ...words);
    assert.equal(r.code, 1, JSON.stringify(words));
    assert.equal(r.out.ok, false, `a value was dropped silently: ${JSON.stringify(words)}`);
    assert.match(r.out.error, /^open: (--storage takes its pair as the next word|argument #\d+ (is not a flag open knows|is extra|: give)|argument #\d+: give|--wait-for needs a value)/);
    assert.equal(r.out.artifacts, undefined);
    noCanary(JSON.stringify(words), log, r.text);
  }
  assert.deepEqual(failFiles(), []);
  assert.equal(log.length, 0, 'refused before anything was asked of Appium');
  // the form they were meant to be written in still works
  const ok = await cliRun('open', SIM_URL, '--storage', `tok=${CANARY}`);
  assert.equal(ok.code, 0);
  assert.equal(fx.storage['http://127.0.0.1:3000'].get('tok'), CANARY);
});

test('open refuses stray forms the same way on the phone', async () => {
  await startStoragePhone();
  dlog.length = 0;
  for (const words of STRAY_OPEN) {
    const r = await cliRun('open', 'https://example.com/', ...words);
    assert.equal(r.out.ok, false, JSON.stringify(words));
    noCanary(JSON.stringify(words), dlog, r.text);
  }
  assert.deepEqual(phoneSteps(), []);
  neverUnsafe();
});

test('refresh refuses --storage in any spelling, and any --flag=value, without echoing it', async () => {
  await startStorageSim();
  log.length = 0;
  for (const words of [[`--storage=tok=${CANARY}`], ['--storage', `tok=${CANARY}`], ['--Storage', `tok=${CANARY}`], ['-storage', `tok=${CANARY}`], ['--wait-for', '--storage', `tok=${CANARY}`], [`--x=${CANARY}`]]) {
    const r = await cliRun('refresh', ...words);
    assert.equal(r.code, 1, JSON.stringify(words));
    assert.match(r.out.error, /^refresh: (--storage is for open only|argument #1: give a flag's value as the next word, not after =)/);
    noCanary(`refresh ${JSON.stringify(words)}`, log, r.text);
  }
  assert.deepEqual(failFiles(), []);
  assert.equal(log.length, 0);
});

test('keys refuses an unknown --word by position, and nothing of it reaches the output, run.log or a file', async () => {
  await startStorageSim();
  log.length = 0;
  for (const words of [[`--${CANARY}`], ['--no-verify', `--${CANARY}`], [`--hunter2`]]) {
    const r = await cliRun('keys', ...words);
    assert.equal(r.code, 1);
    assert.match(r.out.error, /^keys: argument #\d starts with -- and is not --no-verify; to type text that starts with --, put -- before it; usage: safari keys /);
    assert.ok(!/hunter2/.test(r.text));
    noCanary(`keys ${JSON.stringify(words)}`, log, r.text);
  }
  assert.deepEqual(failFiles(), []);
  assert.equal(log.length, 0);
  // after -- it is text
  fx.field.value = '';
  assert.equal((await cliRun('keys', '--', `--${CANARY}`)).code, 0);
});

test('type and keys: a failure after the first character was sent saves no fail.* and logs a message with no typed text; one before it keeps them', async () => {
  const TYPED = `${CANARY}-pw`;
  await startStorageSim();
  // type: the server refuses the keystrokes and its message repeats them
  fx.valueFail = body => `Unable to type ${body.text} into the element`;
  let r = await cliRun('type', 'input', TYPED);
  assert.equal(r.code, 1);
  assert.equal(r.out.ok, false);
  assert.match(r.out.error, /^type: .*(some of the text may have been typed|after the text was sent)/);
  assert.equal(r.out.artifacts, undefined);
  assert.deepEqual(failFiles(), []);
  assert.match(runLog(), /safari type FAILED: type: /);
  noCanary('type failed after sending', [], r.text);
  fx.valueFail = null;
  // keys: the 2nd character never lands
  fx.field.reject = /A/;
  r = await cliRun('keys', TYPED);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /^keys: character #2 did not land after 3 attempts; 1 character was typed before it\./);
  assert.equal(r.out.artifacts, undefined);
  assert.deepEqual(failFiles(), []);
  assert.match(runLog(), /safari keys FAILED: keys: character #2 did not land/);
  noCanary('keys failed after typing', [], r.text);
  fx.field.reject = null;
  // Before anything is typed: the usual screenshot and source are kept.
  fx.focused = false;
  r = await cliRun('keys', TYPED);
  assert.match(r.out.error, /no page field is focused/);
  assert.ok(r.out.artifacts?.screenshot && /fail\.png$/.test(r.out.artifacts.screenshot));
  assert.deepEqual(failFiles().sort(), ['fail.html', 'fail.png']);
  noCanary('keys failed before typing', [], r.text);
  fs.rmSync(path.join(loadState().run, 'fail.png'));
  fs.rmSync(path.join(loadState().run, 'fail.html'));
  fx.focused = true;
  fx.selectCount = { count: 0, hosts: 0, rooted: 0, step: -1, over: 0 };
  r = await cliRun('type', 'input', '--text', 'Name', TYPED);
  assert.match(r.out.error, /^no element matches text "Name"/);
  assert.ok(r.out.artifacts?.screenshot);
  assert.deepEqual(failFiles().sort(), ['fail.html', 'fail.png']);
  noCanary('type failed before typing', [], r.text);
});

test('keys failures that named what was typed now name only places and counts', async () => {
  await startStorageSim();
  fx.field.reject = /C/;
  await assert.rejects(safari.keys([`a${CANARY}`]), err => {
    assert.match(err.message, /^keys: character #2 did not land after 3 attempts; 1 character was typed before it\. The page may reject it/);
    assert.ok(!/CANARY|zq7k/.test(err.message));
    return true;
  });
});

test('type and keys refuse while the service still holds old rules, before any request', async () => {
  for (const make of [startStorageSim, startStoragePhone]) {
    await make();
    const sim = make === startStorageSim;
    const asked = () => (sim ? log : dlog);
    // an older lab's rules file
    fs.writeFileSync(logFiltersPath(), JSON.stringify(LOG_FILTERS.slice(3), null, 2) + '\n');
    asked().length = 0;
    for (const [name, argv] of [['type', ['input', `x${CANARY}`]], ['keys', [CANARY]]]) {
      const e = await failing(safari[name](argv));
      assert.equal(e.extra.needs, 'service');
      assert.match(e.message, /older than this lab's/);
      assert.deepEqual(asked(), [], `${name} asked something before it was refused`);
      noCanary(name, asked(), e.message);
    }
    // current rules but a service older than the file
    fs.writeFileSync(logFiltersPath(), CURRENT_RULES);
    const old = new Date(Date.now() + 60e3);
    fs.utimesSync(logFiltersPath(), old, old); // written "in the future": the running process started before it
    for (const [name, argv] of [['type', ['input', 'x']], ['keys', ['x']]]) {
      const e = await failing(safari[name](argv));
      assert.equal(e.extra.needs, 'service');
      assert.match(e.message, /started before its log-filter rules were written/);
      assert.deepEqual(asked(), []);
    }
    await safari.stop().catch(() => {});
  }
});

const NAMES = [['QuotaExceededError', 'QuotaExceededError'], ['SecurityError', 'SecurityError'], ['InvalidStateError', 'InvalidStateError'], ['TypeError', 'TypeError'], ['CANARYabc', 'Error'], [CANARY, 'Error'], ['Error', 'Error'], ['quotaexceedederror', 'Error']];
const storageNames = async (phoneNow) => {
  await (phoneNow ? startStoragePhone() : startStorageSim());
  const url = phoneNow ? 'https://example.com/app' : 'http://127.0.0.1:3000/app';
  for (const [name, shown] of NAMES) {
    if (phoneNow) Object.assign(dv, { storageFail: { at: 0, name }, storageSets: 0 }); else Object.assign(fx, { storageFail: { at: 0, name }, storageSets: 0 });
    const e = await failing(safari.open([url, '--storage', PAIR]));
    assert.equal(e.message, `open: the page refused --storage #1 (${shown}); the pairs before it were written`, name);
    assert.ok(!/CANARY|zq7k/.test(e.message));
  }
};
test('the storage write maps the page\'s error name to one the lab knows, and any other to Error (phone)', () => storageNames(true));
test('the storage write maps the page\'s error name to one the lab knows, and any other to Error (simulator)', () => storageNames(false));

test('a page that makes the storage script throw outside its own try gets a fixed message and no artifacts (phone)', async () => {
  await startStoragePhone();
  dv.storageThrow = `boom ${CANARY}`;
  let e = await failing(safari.open(['https://example.com/app', '--storage', PAIR]));
  assert.equal(e.message, 'open: the page command that writes --storage failed; pairs before it may have been written');
  assert.equal(e.skipArtifacts, true);
  assert.match(runLog(), /safari open FAILED: open: the page command that writes --storage failed/);
  noCanary('phone, page threw', dlog, e.message, e.extra);
  neverUnsafe();
  dv.storageThrow = null;
  assert.equal((await safari.open(['https://example.com/app', '--storage', PAIR])).storage.count, 1, 'the tab is still the lab\'s');
});

test('a page that makes the storage script throw outside its own try gets a fixed message and no artifacts (simulator)', async () => {
  await startStorageSim();
  fx.storageThrow = `boom ${CANARY}`;
  const r = await cliRun('open', 'http://127.0.0.1:3000/app', '--storage', PAIR);
  assert.equal(r.out.error, 'open: the page command that writes --storage failed; pairs before it may have been written');
  assert.equal(r.out.artifacts, undefined);
  assert.deepEqual(failFiles(), []);
  assert.match(runLog(), /safari open FAILED: open: the page command that writes --storage failed/);
  assert.equal(r.out.storage.count, 1, 'the extra is kept');
  noCanary('simulator, page threw', log, r.text);
  // A refusal of the tab guard passes untouched (phone): see the tab-guard tests above.
});

// --- shot: --page, --element, --scale, --width ---

// A 2x phone screenshot of the 414x896 pt screen: pixel (x, y) is [x & 255, y & 255, (x + y) & 255].
const SHOT2X = gradientPng(828, 1792);
const shotFile = out => decodePng(fs.readFileSync(out.file));
const pngsInRun = () => fs.readdirSync(loadState().run).filter(f => f.endsWith('.png'));
const shotsTaken = entries => entries.filter(([m, u]) => m === 'GET' && u.endsWith('/screenshot')).length;

test('parseShotArgs: the forms of shot, and every rule that refuses, with no odd word echoed', () => {
  const p = argv => parseShotArgs(argv);
  assert.deepEqual(p([]), { mode: 'plain', name: undefined, sel: undefined, scale: undefined, width: undefined });
  assert.equal(p(['home']).mode, 'plain');
  assert.deepEqual(p(['home', '--page']), { mode: 'page', name: 'home', sel: undefined, scale: undefined, width: undefined });
  assert.deepEqual(p(['--page', '--scale', '0.5']), { mode: 'page', name: undefined, sel: undefined, scale: 0.5, width: undefined });
  assert.deepEqual(p(['--element', '.card', 'x']), { mode: 'element', name: 'x', sel: '.card', scale: undefined, width: undefined });
  assert.deepEqual(p(['x', '--element', '*', '--text', 'Buy', '--contains', '--nth', '2', '--width', '600']).sel, { css: '*', text: 'Buy', contains: true, nth: 2 });
  assert.equal(p(['x', '--element', '*', '--text', 'Buy', '--width', '600']).width, 600);
  assert.deepEqual(p(['--element', 'x-app', '--element', 'button', '--shadow']).sel, { css: 'button', shadow: ['x-app'] });
  assert.deepEqual(p(['--scale', '1', '--', '--odd']), { mode: 'screen', name: '--odd', sel: undefined, scale: 1, width: undefined });
  assert.equal(p(['--width', '16384']).width, 16384);
  assert.equal(p(['--scale', '.5']).scale, 0.5);
  const bad = (argv, re) => assert.throws(() => p(argv), e => re.test(e.message) && /usage: safari shot \[name\]/.test(e.message) && !e.message.includes('SECRET'), JSON.stringify(argv));
  bad(['--page', '--element', 'a'], /--page and --element exclude each other/);
  bad(['--scale', '0.5', '--width', '300'], /--scale and --width exclude each other/);
  for (const v of ['0', '1.01', '2', '-1', 'x', '', '1e-1', '0x1', ' 0.5']) bad(['--page', '--scale', v], /--scale must be a number above 0 and at most 1/);
  for (const v of ['0', '1.5', '-5', 'x', '', '16385', '123456', '1e3']) bad(['--page', '--width', v], /--width must be a whole number of pixels from 1 to 16384/);
  bad(['--scale'], /--scale needs a value/);
  bad(['--width'], /--width needs a value/);
  bad(['--element'], /--element needs a value/);
  bad(['--scale', '0.5', '--scale', '0.4'], /--scale was given twice/);
  bad(['--width', '5', '--width', '6'], /--width was given twice/);
  bad(['--text', 'Buy'], /go with --element/);
  bad(['--nth', '2'], /go with --element/);
  bad(['--shadow'], /go with --element/);
  bad(['--contains'], /go with --element/);
  bad(['--element', 'a', '--contains'], /--contains needs --text/);
  bad(['--element', 'a', '--nth', '0'], /--nth must be a whole number/);
  bad(['--element', 'a', '--text', 'x', '--text', 'y'], /--text was given twice/);
  bad(['--element', 'a', '--element', 'b'], /one selector only/);
  bad(['--element', ''], /a selector is empty/);
  bad(['--element', 'a', '--shadow'], /--shadow needs the host selector/);
  bad(['one', 'two'], /one name only/);
  bad(['--bogus'], /unknown flag --bogus/);
  bad(['--label', 'x'], /unknown flag --label/);
  bad(['--SECRET=abc'], /argument #1 is not a flag shot knows/);
  bad(['--page', '--s ecret SECRET'], /argument #2 is not a flag shot knows/);
  bad(['--' + 'x'.repeat(40) + 'SECRET'], /argument #1 is not a flag shot knows/);
});

test('shot with no flags is the whole screen as the driver gave it, byte for byte, and touches no page', async () => {
  await start();
  fx.screenshot = SHOT2X;
  const out = await safari.shot(['plain']);
  assert.deepEqual(Object.keys(out), ['file']);
  assert.ok(fs.readFileSync(out.file).equals(Buffer.from(SHOT2X, 'base64')));
  assert.equal(shotsTaken(log), 1);
  assert.equal(posts('/execute/sync').length, 0, 'no page script, no tree read');
  fx.screenshot = null;
  assert.ok(fs.readFileSync((await safari.shot([])).file).equals(Buffer.from(PNG, 'base64')), 'even a file that is no PNG is passed on as it came');
});

test('shot --page cuts to the page area less Safari\'s controls, and reports every number', async () => {
  await start();
  fx.screenshot = SHOT2X;
  const out = await safari.shot(['home', '--page']);
  // Page area (0, 48) 414x750 pt; the toolbar starts at 750, so 48..750 is kept; at 2x that is 96..1500 px.
  assert.deepEqual(out.crop, { x: 0, y: 96, width: 828, height: 1404 });
  assert.deepEqual(out.source, { width: 828, height: 1792 });
  assert.deepEqual([out.width, out.height, out.scale, out.mode], [828, 1404, 1, 'page']);
  assert.deepEqual(out.points, { screen: { width: 414, height: 896 }, area: { x: 0, y: 48, width: 414, height: 750 }, inset: 0, crop: { x: 0, y: 48, width: 414, height: 702 } });
  assert.equal(out.matches, undefined);
  assert.match(out.file, /home\.png$/);
  const png = shotFile(out);
  assert.deepEqual([png.width, png.height], [828, 1404]);
  assert.deepEqual([...png.data.subarray(0, 3)], [0, 96, 96], 'the corner is the pixel at (0, 96) of the screenshot');
  assert.deepEqual([...png.data.subarray((1403 * 828 + 827) * 3)], [827 & 255, 1499 & 255, (827 + 1499) & 255]);
  probesGone();
  assert.equal(fx.context, 'WEBVIEW_1.1');
  assert.equal(fx.probesInserted, 2 * 1, 'one read before the picture and one after');
  assert.equal(shotsTaken(log), 1);
});

test('shot --page waits for a slow read of Safari\'s UI tree (up to treeMs, past callMs) (#98)', async () => {
  await start();
  fx.screenshot = SHOT2X;
  WAIT.callMs = 30;
  WAIT.treeMs = 1000;
  fx.sourceDelayMs = 100; // a heavy page: WebDriverAgent takes longer than callMs to build the tree
  const out = await safari.shot(['busy', '--page']);
  assert.deepEqual(out.crop, { x: 0, y: 96, width: 828, height: 1404 });
  const sources = posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source');
  assert.equal(sources.length, 2, 'one tree read before the picture and one after, none sent again');
  probesGone();
});

test('a read of Safari\'s UI tree that gets no answer says the page is slow, not that Appium is stuck (#98)', async () => {
  await start();
  fx.screenshot = SHOT2X;
  WAIT.treeMs = 60;
  fx.sourceDelayMs = 400;
  const e = await failing(safari.shot(['busy', '--page']));
  assert.match(e.message, /^Safari's screen layout \(its UI tree\) did not come back within 0\.1s; a heavy page makes it slow\. The session is still good: `safari wait --settled` waits for a busy page to calm down$/);
  assert.doesNotMatch(e.message, /busy or stuck|lab status/);
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script === 'mobile: source').length, 1, 'not sent again');
});

test('ui gives the full tree its own longer limit and the same words when it gets no answer (#98)', async () => {
  await start();
  WAIT.treeMs = 10;
  WAIT.sourceMs = 60;
  fx.sourceDelayMs = 400;
  const e = await failing(safari.ui([]));
  assert.match(e.message, /^Safari's screen layout \(its UI tree\) did not come back within 0\.1s; a heavy page makes it slow\./);
});

test('shot --page sends an args array with every page script, the inset read included (#45)', async () => {
  await start();
  fx.screenshot = SHOT2X;
  await safari.shot(['home', '--page']);
  const sent = posts('/execute/sync');
  assert.ok(sent.length > 0);
  for (const [, , body] of sent) assert.ok(Array.isArray(body.args), `${body.script.slice(0, 40)} has args`);
  const inset = sent.find(([, , b]) => b.script.includes('env(safe-area-inset-top)'));
  assert.ok(inset, 'the inset script ran');
  assert.deepEqual(inset[2].args, []);
});

test('shot --page also drops the top safe-area inset, in points (CSS px times the zoom), and a control at the top', async () => {
  await start();
  fx.screenshot = SHOT2X;
  fx.inset = 6;
  let out = await safari.shot(['--page']);
  assert.equal(out.points.inset, 6);
  assert.deepEqual(out.points.crop, { x: 0, y: 54, width: 414, height: 696 });
  assert.deepEqual(out.crop, { x: 0, y: 108, width: 828, height: 1392 });
  // Zoomed 2x: the inset is 6 CSS px = 12 pt.
  fx.page.visualViewport = { scale: 2, width: 207, height: 375 };
  fx.probe = { x: 0, y: 48, width: 200, height: 200 };
  out = await safari.shot(['--page']);
  assert.equal(out.points.inset, 12);
  assert.equal(out.points.crop.y, 60);
  // A bar across the top of the page (a top address bar) cuts from its bottom edge.
  fx.page.visualViewport = null;
  fx.probe = { x: 0, y: 48, width: 100, height: 100 };
  fx.inset = 0;
  fx.rects.C2 = { x: 0, y: 40, width: 414, height: 40 };
  out = await safari.shot(['--page']);
  assert.deepEqual(out.points.crop, { x: 0, y: 80, width: 414, height: 670 });
  // Nothing to shoot: the controls fill the area.
  fx.rects.C1 = { x: 0, y: 0, width: 414, height: 900 };
  await assert.rejects(safari.shot(['--page']), /nothing of the page is left/);
  probesGone();
});

test('shot --page --scale and --width shrink the cut, and report the factor', async () => {
  await start();
  fx.screenshot = SHOT2X;
  let out = await safari.shot(['--page', '--scale', '0.5']);
  assert.deepEqual([out.width, out.height, out.scale], [414, 702, 0.5]);
  assert.deepEqual(out.crop, { x: 0, y: 96, width: 828, height: 1404 });
  assert.deepEqual([shotFile(out).width, shotFile(out).height], [414, 702]);
  out = await safari.shot(['--page', '--width', '300']);
  assert.deepEqual([out.width, out.height, out.scale], [300, 509, 0.3623]);
  out = await safari.shot(['--page', '--width', '828']);
  assert.deepEqual([out.width, out.scale], [828, 1]);
  out = await safari.shot(['--page', '--scale', '1']);
  assert.deepEqual([out.width, out.scale], [828, 1]);
  const before = pngsInRun().length;
  const e = await failing(safari.shot(['--page', '--width', '829']));
  assert.match(e.message, /--width 829 is wider than the 828 px picture/);
  assert.equal(pngsInRun().length, before, 'nothing written');
});

test('shot --scale on its own shrinks the whole screen, without reading the page', async () => {
  await start();
  fx.screenshot = SHOT2X;
  const out = await safari.shot(['all', '--scale', '0.25']);
  assert.deepEqual([out.mode, out.width, out.height, out.scale], ['screen', 207, 448, 0.25]);
  assert.deepEqual(out.crop, { x: 0, y: 0, width: 828, height: 1792 });
  assert.equal(out.points, undefined);
  assert.equal(posts('/execute/sync').length, 0);
});

test('shot --element cuts to the element\'s rectangle on screen, and says how many matched', async () => {
  await start();
  fx.screenshot = SHOT2X;
  // The element is at (80, 190) 40x20 in the page, which sits 48 pt down: (80, 238) on screen, (160, 476) px.
  const out = await safari.shot(['card', '--element', 'input']);
  assert.deepEqual(out.crop, { x: 160, y: 476, width: 80, height: 40 });
  assert.deepEqual([out.mode, out.matches, out.width, out.height, out.scale], ['element', 1, 80, 40, 1]);
  assert.deepEqual(out.points.crop, { x: 80, y: 238, width: 40, height: 20 });
  assert.equal(out.points.inset, undefined);
  assert.deepEqual([...shotFile(out).data.subarray(0, 3)], [160 & 255, 476 & 255, (160 + 476) & 255]);
  assert.equal(out.warning, undefined);
  // By text, as tap does it; the selector the page counted is the one measured.
  fx.selectCount = { count: 1, hosts: 0, rooted: 0, step: -1, over: 0 };
  const byText = await safari.shot(['--element', '*', '--text', 'Buy', '--scale', '0.5']);
  assert.deepEqual([byText.mode, byText.matches, byText.width, byText.scale], ['element', 1, 40, 0.5]);
  probesGone();
  assert.equal(taps().length, 0);
  assert.equal(posts('/execute/sync').filter(([, , b]) => b.script.includes('scrollIntoView')).length, 0, 'the page is never scrolled');
});

test('shot --element follows a zoomed page: the rectangle is mapped by the probe, not assumed', async () => {
  await start();
  fx.screenshot = SHOT2X;
  fx.page.visualViewport = { scale: 2, width: 207, height: 375 };
  fx.probe = { x: 0, y: 48, width: 200, height: 200 };
  fx.geometry = { ...fx.geometry, rect: { x: 10, y: 20, width: 50, height: 30 } };
  const out = await safari.shot(['--element', 'input']);
  assert.deepEqual(out.points.crop, { x: 20, y: 88, width: 100, height: 60 });
  assert.deepEqual(out.crop, { x: 40, y: 176, width: 200, height: 120 });
});

test('shot --element refuses an element it can not show, before it takes a picture', async () => {
  await start();
  fx.screenshot = SHOT2X;
  const rect = (x, y, width, height) => { fx.geometry = { ...fx.geometry, covered: null, hidden: null, rect: { x, y, width, height } }; };
  const refused = async (re) => {
    const e = await failing(safari.shot(['--element', 'input']));
    assert.match(e.message, re);
    assert.equal(shotsTaken(log), 0, 'no picture was taken');
    assert.deepEqual(pngsInRun(), [], 'and nothing was written');
    probesGone();
  };
  fx.geometry = { ...fx.geometry, hidden: 'hidden (display none, 0x0 px)' };
  await refused(/input is hidden \(display none, 0x0 px\), so there is nothing to show/);
  fx.geometry = { ...fx.geometry, hidden: 'hidden (<script>)' }; // a page that makes up a reason is not quoted
  await refused(/input is hidden, so there is nothing to show/);
  rect(80, 740, 40, 20); // 788..808 pt: below the page area (48..798)
  await refused(/not wholly inside the page area/);
  rect(-30, 100, 40, 20);
  await refused(/not wholly inside the page area/);
  rect(80, 695, 40, 20); // 743..763 pt: inside the area, across the toolbar that starts at 750
  await refused(/runs under Safari's toolbar or address bar/);
  fx.geometry = { ...fx.geometry, rect: undefined };
  await refused(/couldn't measure input in the page/);
  fx.resolveNone = false;
});

test('shot --element warns when something covers the element, and quotes only a tag name', async () => {
  await start();
  fx.screenshot = SHOT2X;
  fx.geometry = { ...fx.geometry, covered: 'div' };
  assert.equal((await safari.shot(['--element', 'input'])).warning, 'input is covered by <div>; the picture shows that over it');
  fx.geometry = { ...fx.geometry, covered: '<b onclick="SECRET">' };
  assert.equal((await safari.shot(['--element', 'input'])).warning, 'input is covered by something else; the picture shows that over it');
});

test('shot waits out a page that moves while the picture is taken: tried again, then refused with nothing written', async () => {
  await start();
  fx.screenshot = SHOT2X;
  // Element: the rectangle read after the picture differs from the one read with it, once.
  const rectAt = n => ({ cx: 100, cy: 200, rect: { x: 80, y: 190 + (n === 2 ? 5 : 0), width: 40, height: 20 }, covered: null });
  fx.geometryFor = rectAt;
  const out = await safari.shot(['--element', 'input']);
  assert.deepEqual(out.points.crop, { x: 80, y: 238, width: 40, height: 20 });
  assert.equal(shotsTaken(log), 2, 'the first picture was thrown away');
  assert.equal(pngsInRun().length, 1);
  // Forever: three tries, no file.
  fx.measures = 0;
  fx.geometryFor = n => ({ cx: 100, cy: 200, rect: { x: 80, y: 190 + n * 5, width: 40, height: 20 }, covered: null });
  log.length = 0;
  const e = await failing(safari.shot(['--element', 'input']));
  assert.match(e.message, /input kept moving or resizing .* so nothing was written/);
  assert.equal(shotsTaken(log), WAIT.stableTries);
  assert.equal(pngsInRun().length, 1, 'still just the first file');
  probesGone();
  // The page area: a control that appears (or goes) after the picture.
  fx.geometryFor = null;
  let n = 0;
  fx.onScreenshot = () => { if (++n === 1) fx.rects.C1 = { x: 0, y: 700, width: 400, height: 50 }; };
  const page = await safari.shot(['--page']);
  assert.equal(n, 2);
  assert.deepEqual(page.points.crop, { x: 0, y: 48, width: 414, height: 652 }, 'the picture that stood is the second');
  let flip = 0;
  fx.onScreenshot = () => { fx.rects.C1 = { x: 0, y: 700 + 5 * ++flip, width: 400, height: 50 }; };
  const before = pngsInRun().length;
  await assert.rejects(safari.shot(['--page']), /the page kept moving or resizing/);
  assert.equal(pngsInRun().length, before);
  probesGone();
});

test('shot --page refuses a screenshot it can not cut, and writes nothing', async () => {
  await start();
  // The default stand-in answer is only the PNG signature.
  const bad = async (png, re) => {
    fx.screenshot = png;
    const e = await failing(safari.shot(['--page']));
    assert.match(e.message, re);
    assert.deepEqual(pngsInRun(), []);
    probesGone();
  };
  await bad(null, /cut short/);
  await bad('bm90IGEgcG5n', /not a PNG/);
  await bad(gradientPng(828, 1000), /not the shape of the 414x896 pt screen/);
  fx.screenshot = null;
  const e = await failing(safari.shot(['--scale', '0.5'])); // the same for an uncut screen
  assert.match(e.message, /cut short/);
  assert.deepEqual(pngsInRun(), []);
});

test('shot --page keeps the screenshot\'s colour profile chunks', async () => {
  await start();
  fx.screenshot = gradientPng(414, 896, [{ type: 'sRGB', data: Buffer.from([0]) }, { type: 'tEXt', data: Buffer.from('x\0y') }]);
  const out = await safari.shot(['--page']);
  assert.deepEqual(out.crop, { x: 0, y: 48, width: 414, height: 702 });
  const bytes = fs.readFileSync(out.file);
  assert.ok(bytes.includes(Buffer.from('sRGB')) && !bytes.includes(Buffer.from('tEXt')));
});

test('a failed shot --element, --page or --scale on the simulator leaves no fail.png (the full screen), while a plain one still does', async () => {
  await start();
  fx.screenshot = null; // the picture can't be cut
  for (const argv of [['x', '--element', 'input'], ['--page'], ['--scale', '0.5'], ['--page', '--width', '9999'], ['--bogus']]) {
    const r = await cliRun('shot', ...argv);
    assert.equal(r.out.ok, false, JSON.stringify(argv));
    assert.equal(r.out.artifacts, undefined, JSON.stringify(argv));
    assert.deepEqual(failFiles(), [], JSON.stringify(argv));
    assert.deepEqual(pngsInRun(), [], JSON.stringify(argv));
  }
  const plain = await failureArtifacts('eval', new Error('x')); // other commands keep theirs
  assert.ok(plain.artifacts.screenshot);
});

test('shot checks every flag before it asks the session anything', async () => {
  await start();
  fx.screenshot = SHOT2X;
  log.length = 0;
  for (const argv of [['--page', '--element', 'a'], ['--scale', '2'], ['--width', '0'], ['--page', '--scale', '.5', '--width', '9'], ['--text', 'x'], ['--bogus'], ['a', 'b'], ['--page', 'dir/name'], ['--scale', '0.5', 'dir/name']]) {
    await assert.rejects(safari.shot(argv), e => /shot: |is a path/.test(e.message) && (e.skipArtifacts === true || /is a path/.test(e.message)), JSON.stringify(argv));
  }
  assert.equal(log.length, 0);
  assert.deepEqual(pngsInRun(), []);
});

test('on the phone, shot --page cuts the page area and the picture is checked before and after', async () => {
  await startPhone();
  dv.screenshot = SHOT2X;
  dv.labels = [{ label: 'Toolbar', type: 'XCUIElementTypeToolbar', x: 0, y: 740, width: 414, height: 60 }];
  dv.pages[PAGE].inset = 5;
  const out = await safari.shot(['p', '--page', '--scale', '0.5']);
  assert.deepEqual(out.points.crop, { x: 0, y: 53, width: 414, height: 687 });
  assert.deepEqual(out.crop, { x: 0, y: 106, width: 828, height: 1374 });
  assert.deepEqual([out.width, out.height, out.scale, out.mode], [414, 687, 0.5, 'page']);
  assert.deepEqual([shotFile(out).width, shotFile(out).height], [414, 687]);
  const shotAt = dlog.findIndex(([m, u]) => m === 'GET' && u.endsWith('/screenshot'));
  const scripts = dlog.slice(0, shotAt).filter(([m, u]) => m === 'POST' && u.endsWith('/execute/sync'));
  assert.match(scripts.at(-1)[2].script, /visibilityState/, 'the tab is checked right before the picture');
  assert.match(executes().at(-1).script, /visibilityState/, 'and last of all, before the file is written');
  assert.equal(shotsTaken(dlog), 1);
  for (const b of executes()) assert.doesNotMatch(b.script, /hasFocus/);
  neverUnsafe();
});

test('on the phone, shot --element finds the element in the lab\'s own tab and cuts to it', async () => {
  await startPhone();
  dv.screenshot = SHOT2X;
  dv.pages[PAGE].els = { '.card': 2 };
  const out = await safari.shot(['--element', '.card', '--width', '60']);
  assert.deepEqual(out.crop, { x: 160, y: 476, width: 80, height: 40 });
  assert.deepEqual([out.width, out.height, out.matches, out.mode], [60, 30, 2, 'element']);
  assert.equal(dv.pages[PAGE].scrolls, undefined, 'nothing was scrolled');
  assert.equal(dlog.filter(([, , b]) => b?.script === 'mobile: tap').length, 0);
  neverUnsafe();
});

test('on the phone a picture is not kept when the tab left the screen, before or after it was taken', async () => {
  await startPhone();
  dv.screenshot = SHOT2X;
  const visibilityChecks = leaveAt => {
    let n = 0;
    dv.onExecute = page => { if (/visibilityState/.test(dv.executed.at(-1)[1]) && ++n === leaveAt) page.visible = false; };
  };
  for (const [leaveAt, taken] of [[1, 0], [2, 0], [3, 1]]) { // the first check, the one right before the picture, the last one
    dv.pages[PAGE].visible = true;
    dlog.length = 0;
    visibilityChecks(leaveAt);
    const e = await failing(safari.shot(['--page']));
    assert.equal(e.extra.needs, 'tab', `check ${leaveAt}`);
    assert.equal(shotsTaken(dlog), taken, `check ${leaveAt}`);
    assert.deepEqual(pngsInRun(), [], `check ${leaveAt}`);
  }
  neverUnsafe();
});

test('on the phone, a refused crop saves nothing, not even the whole screen', async () => {
  await startPhone();
  dv.pages[PAGE].els = { '.card': 1 };
  dv.screenshot = null; // no usable picture
  for (const argv of [['--page'], ['--element', '.card'], ['--page', '--scale', '0.5'], ['--scale', '0.5']]) {
    const e = await failing(safari.shot(argv));
    assert.match(e.message, /cut short/, JSON.stringify(argv));
    assert.deepEqual(pngsInRun(), []);
  }
  dv.screenshot = SHOT2X;
  dv.pages[PAGE].rectOf = () => ({ left: 80, top: 2000, width: 40, height: 20 }); // far below the screen
  const e = await failing(safari.shot(['--element', '.card']));
  assert.match(e.message, /not wholly inside the page area/);
  assert.deepEqual(pngsInRun(), []);
  let moves = 0;
  dv.pages[PAGE].rectOf = () => ({ left: 80, top: 190 + 5 * ++moves, width: 40, height: 20 });
  const moving = await failing(safari.shot(['--element', '.card']));
  assert.match(moving.message, /kept moving or resizing/);
  assert.deepEqual(pngsInRun(), []);
  neverUnsafe();
});

test('on the phone, shot without flags is the screenshot byte for byte, checked before and after', async () => {
  await startPhone();
  dv.screenshot = SHOT2X;
  const out = await safari.shot(['plain']);
  assert.deepEqual(Object.keys(out), ['file']);
  assert.ok(fs.readFileSync(out.file).equals(Buffer.from(SHOT2X, 'base64')));
  assert.deepEqual(seq().filter(m => m !== 'GET /context' && !/POST \/context/.test(m) && m !== 'GET /contexts'), ['POST /execute/sync', 'GET /screenshot', 'POST /execute/sync']);
  neverUnsafe();
});

// --- the signing lock shared with sideload (#63) ---

const needPerl = { skip: !havePerl && '/usr/bin/perl is not here' };
// A device start against the phone stand-in, ready to be run under withSignLock.
function deviceStart() {
  deviceReset();
  withPhone();
  const calls = phoneIs();
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  return calls;
}
const launched = calls => calls.filter(c => c.includes('launch')).length;
const sessionCreates = () => dlog.filter(([m, u]) => m === 'POST' && u === '/session').length;

test('a device start holds the signing lock from the lab\'s tab to the session create, and lets go once the session exists', needPerl, async () => {
  const dir = tempDir();
  deviceStart();
  let heldAtLaunch = null, heldAtCreate = null;
  onLaunch = url => { heldAtLaunch = !lockIsFree(dir); ps.launch(url); };
  ps.fx.onCreateRequest = () => { heldAtCreate = !lockIsFree(dir); };
  const out = await withSignLock({ home: dir }, () => safari.start(['--device', PU]));
  assert.equal(heldAtLaunch, true);
  assert.equal(heldAtCreate, true);
  assert.equal(lockIsFree(dir), true, 'free once the session exists');
  assert.equal('signLock' in out || 'warning' in out, false);
  neverUnsafe();
});

test('a start while sideload holds the lock stops at once with needs busy: no tab, no create, no state; it works once sideload is done', needPerl, async () => {
  const dir = tempDir();
  const calls = deviceStart();
  const other = await holdLock(dir);
  try {
    const e = await withSignLock({ home: dir }, () => failing(safari.start(['--device', PU])));
    assert.equal(e.extra.needs, 'busy');
    assert.equal(e.extra.then, 'lab up --target device');
    assert.match(e.extra.human.join(' '), /sideload is signing or installing an app with the same Apple team; try again in a minute\./);
    assert.equal(launched(calls), 0, 'the lab\'s tab was not opened');
    assert.equal(sessionCreates(), 0, 'create was never called');
    assert.equal(loadState().session, undefined);
    assert.equal(loadState().keyboardPending, undefined);
  } finally { await other.release(); }
  const out = await withSignLock({ home: dir }, () => safari.start(['--device', PU]));
  assert.equal(out.reused, undefined);
  assert.equal(sessionCreates(), 1);
});

test('the signing lock is let go after a failed create', needPerl, async () => {
  const dir = tempDir();
  deviceStart();
  ps.fx.createErrors = [XCODEBUILD_65];
  const e = await withSignLock({ home: dir }, () => failing(safari.start(['--device', PU])));
  assert.ok(e.extra.needs);
  assert.equal(sessionCreates(), 1);
  assert.equal(lockIsFree(dir), true);
});

test('the signing lock is let go after an interrupt during the create', needPerl, async () => {
  const dir = tempDir();
  deviceStart();
  let heldAtCreate = null;
  ps.fx.onCreateRequest = () => { heldAtCreate = !lockIsFree(dir); process.emit('SIGTERM', 'SIGTERM'); };
  const e = await withSignLock({ home: dir }, () => withInterrupt(() => failing(safari.start(['--device', PU]))));
  assert.ok(e instanceof InterruptError);
  assert.equal(heldAtCreate, true);
  assert.equal(lockIsFree(dir), true);
});

test('MSL_SIGNLOCK=off starts without the lock and says so in the result, also when the start fails', async () => {
  const dir = tempDir();
  deviceStart();
  const out = await withSignLock({ home: dir, off: 'off' }, () => safari.start(['--device', PU]));
  assert.equal(out.signLock, 'disabled');
  assert.equal(out.warning, 'sign lock disabled; sideload may sign at the same time (Xcode may then create a second certificate)');
  assert.equal(out.warning, OFF_WARNING);
  assert.equal(fs.existsSync(path.join(dir, '.op.lock')), false, 'no lock file');
  const again = await withSignLock({ home: dir, off: 'off' }, () => safari.start(['--device', PU]));
  assert.equal(again.reused, true);
  assert.equal('signLock' in again, false, 'a reused session signs nothing');

  deviceStart();
  ps.fx.createErrors = [XCODEBUILD_65];
  const e = await withSignLock({ home: dir, off: 'off' }, () => failing(safari.start(['--device', PU])));
  assert.equal(e.extra.signLock, 'disabled');
  assert.equal(e.extra.warning, OFF_WARNING);
  assert.ok(e.extra.needs, 'the failure keeps its own fields');
});

test('the simulator never takes the signing lock, held or not, and reports nothing about it', needPerl, async () => {
  const dir = tempDir();
  const other = await holdLock(dir);
  try {
    const out = await withSignLock({ home: dir }, () => safari.start(['--target', 'simulator']));
    assert.equal(out.reused, undefined);
    assert.equal('signLock' in out, false);
  } finally { await other.release(); }
  const off = await withSignLock({ home: dir, off: 'off' }, () => safari.start(['--target', 'simulator']));
  assert.equal('signLock' in off || 'warning' in off, false);
});

// --- allowed hosts the lab may follow its phone tab to (#101, docs/adr/0009) ---

const OLD = 'https://old.test';
const guardScripts = () => executes().filter(b => /^if \(window\.name !== /.test(b.script));
const nothingMarked = token => assert.ok(Object.values(dv.pages).every(p => p.win.name !== token), 'the marker is in no page');

test('allowed host: a tab that went to it is marked again and the command runs there; the output says where it followed', async () => {
  await startPhone(false, ['old.test']);
  const { token } = loadState().deviceTab;
  assert.deepEqual(loadState().deviceTab.allowHosts, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/thread?x=1`);
  dlog.length = 0;
  const out = await safari.eval(['location.href']);
  assert.equal(out.value, `${OLD}/thread?x=1`);
  assert.deepEqual(out.followed, [OLD]);
  const tab = loadState().deviceTab;
  assert.equal(dv.pages[PAGE].win.name, token, 'the marker is back, the same one');
  assert.equal(tab.origin, OLD);
  assert.deepEqual(tab.origins, ['https://example.com', OLD]);
  assert.equal(tab.navTo, undefined);
  assert.deepEqual(tab.allowHosts, ['old.test']);
  // Order: the guard's yes/no, the read-only probe, the mark, the collectors, then the command once more behind the strict guard.
  const sent = executes();
  const markAt = sent.findIndex(b => MARK.test(b.script));
  assert.equal(markAt, 2, 'nothing but the guard and the probe touched the page before the mark');
  assert.match(sent[0].script, /__msl: 3/);
  assert.match(sent[1].script, PROBE);
  assert.match(sent.at(-2).script, /__mslConsole/, 'the collectors are installed on the new document');
  assert.doesNotMatch(sent.at(-1).script, /__msl: 3/, 'the second run is behind the strict guard');
  assert.match(sent.at(-1).script, /location\.href/);
  assert.equal(guardScripts().filter(b => /__msl: 3/.test(b.script)).length, 1);
  assert.match(runLog(), /safari follow: page=WEBVIEW_9\.1 to=https:\/\/old\.test\n/);
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal((await safari.eval(['1'])).followed, undefined, 'the next command has nothing to follow');
  neverUnsafe();
});

test('allowed host: the console and network collectors work on the followed document, and network admits only the sites visited', async () => {
  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/`);
  await safari.eval(['1']);
  const page = dv.pages[PAGE];
  assert.ok(page.win.__mslNet, 'the network collector is installed again');
  addResource(page, res(`${OLD}/a`));
  addResource(page, res('https://never-visited.test/b'));
  const out = await safari.network();
  assert.deepEqual(out.requests.map(r => r.url), [`${OLD}/`, `${OLD}/a`]);
  assert.equal(out.outside, 1);
  assert.deepEqual(out.origins, ['https://example.com', OLD]);
  neverUnsafe();
});

test('allowed host: an exact match only, http and https both, a port is part of the host', async () => {
  const cases = [
    [['old.test'], 'https://old.test/', true],
    [['old.test'], 'http://old.test/', true],
    [['old.test'], 'https://www.old.test/', false],
    [['www.old.test'], 'https://old.test/', false],
    [['old.test'], 'https://old.test:8443/', false],
    [['old.test'], 'https://sub.old.test/', false],
    [['localhost:3000'], 'http://localhost:3000/', true],
    [['localhost:3000'], 'http://localhost:4000/', false],
    [['localhost:3000'], 'http://localhost/', false],
    [['192.168.1.5'], 'http://192.168.1.5/', true],
    [['192.168.1.5', 'old.test'], 'https://192.168.1.6/', false],
  ];
  for (const [hosts, url, follows] of cases) {
    await startPhone(false, hosts);
    const { token } = loadState().deviceTab;
    dv.pageNav(PAGE, url);
    dlog.length = 0;
    const label = `${hosts} -> ${url}`;
    if (follows) {
      assert.deepEqual((await safari.eval(['1'])).followed, [new URL(url).origin], label);
      assert.equal(dv.pages[PAGE].win.name, token, label);
    } else {
      const e = await failing(safari.eval(['window.__ran = true']));
      assert.equal(e.extra.needs, 'tab', label);
      assert.equal(executes().length, 1, `${label}: nothing but the guard's yes/no reached the page`);
      assert.equal(dv.pages[PAGE].win.__ran, undefined, label);
      nothingMarked(token);
      assert.deepEqual(loadState().deviceTab, tainted(), label);
    }
    neverUnsafe();
  }
});

test('a site that is not an allowed host taints as before, writes nothing, and the refusal names the session\'s hosts but not the site', async () => {
  await startPhone(false, ['old.test', 'localhost:3000']);
  const { token } = loadState().deviceTab;
  dv.pageNav(PAGE, 'https://private.test/inbox?secret=1');
  dlog.length = 0;
  const e = await failing(safari.eval(['window.__ran = true']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /marker/);
  assert.match(e.message, /is not on one of this session's allowed hosts \(old\.test, localhost:3000\)/);
  assert.match(e.message, /run `safari start` for a new session \(and name the hosts again with `--allow-host`\)/);
  assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /private\.test|secret/);
  assert.equal(executes().length, 1);
  assert.equal(dv.pages[PAGE].win.__ran, undefined);
  nothingMarked(token);
  assert.deepEqual(loadState().deviceTab, tainted(), 'a taint drops the list');
  const again = await failing(safari.eval(['1']));
  assert.match(again.message, /run `safari start`/);
  neverUnsafe();
});

test('the marker gone on the same site: re-marked when that site is allowed, tainted when not', async () => {
  await startPhone(false, ['example.com']);
  dv.pages[PAGE].win.name = '';
  const out = await safari.eval(['1']);
  assert.deepEqual([out.value, out.followed], [1, ['https://example.com']]);
  assert.equal(dv.pages[PAGE].win.name, loadState().deviceTab.token);
  await startPhone(false, ['old.test']);
  dv.pages[PAGE].win.name = '';
  const e = await failing(safari.eval(['1']));
  assert.match(e.message, /no longer carries its marker.*not on one of this session's allowed hosts \(old\.test\)/);
  assert.deepEqual(loadState().deviceTab, tainted());
});

test('a session with no allowed hosts refuses as before and says how to follow a host next time', async () => {
  await startPhone();
  dv.pageNav(PAGE, `${OLD}/`);
  dlog.length = 0;
  const e = await failing(safari.eval(['window.__ran = true']));
  assert.match(e.message, /no longer carries its marker \(it was navigated or replaced\); run `safari start` for a new session\. To let the lab follow its tab to another host, start the session with `--allow-host <host>`$/);
  assert.equal(executes().length, 1);
  assert.deepEqual(loadState().deviceTab, tainted());
  await startPhone();
  dv.pages[PAGE].href = 'https://sub.example.com/page'; // the marker is still there: another site, no marker check
  const e2 = await failing(safari.eval(['1']));
  assert.match(e2.message, /moved to another site on its own; run `safari start` for a new session\. To let the lab follow .* `--allow-host <host>`$/);
  await startPhone();
  dv.pageNav(PAGE, 'about:blank');
  const e3 = await failing(safari.eval(['1']));
  assert.equal(e3.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted());
  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, 'about:blank');
  const e4 = await failing(safari.eval(['1']));
  assert.match(e4.message, /allowed hosts \(old\.test\)/);
  assert.deepEqual(loadState().deviceTab, tainted());
  neverUnsafe();
});

test('the guard script with no allowed hosts is exactly what it was; with hosts only its two answers change', async () => {
  await startPhone();
  await safari.eval(['1']);
  const plain = executes()[0].script;
  const tab = loadState().deviceTab;
  assert.ok(plain.startsWith(`if (window.name !== ${JSON.stringify(tab.token)}) return { __msl: 0 };\nif (location.origin !== ${JSON.stringify(tab.origin)}) return { __msl: 2 };\ntry { return { __msl: 1, v: (function () {\n`));
  assert.doesNotMatch(plain, /includes|__msl: 3/);
  await startPhone(false, ['old.test']);
  await safari.eval(['1']);
  const withHosts = executes()[0].script;
  const t2 = loadState().deviceTab;
  const F = 'location.origin === "https://old.test" || location.origin === "http://old.test"';
  assert.ok(withHosts.startsWith(`if (window.name !== ${JSON.stringify(t2.token)}) return ${F} ? { __msl: 3 } : { __msl: 0 };\nif (location.origin !== ${JSON.stringify(t2.origin)}) return ${F} ? { __msl: 3 } : { __msl: 2 };\ntry {`));
  assert.doesNotMatch(withHosts, /\.includes\(/, 'no method call on a prototype the page can patch');
  assert.equal(withHosts.slice(withHosts.indexOf('try {')), plain.slice(plain.indexOf('try {')), 'the rest of the script is the same');
});

test('allowed host: the host the page went to must stay allowed through the probe and the mark, else the run is tainted and nothing is written', async () => {
  for (const when of [s => /__msl: 3/.test(s), s => PROBE.test(s)]) {
    await startPhone(false, ['old.test']);
    const { token } = loadState().deviceTab;
    dv.pageNav(PAGE, `${OLD}/`);
    dv.afterExecute = (page, s) => { if (when(s)) { dv.afterExecute = null; dv.pageNav(PAGE, 'https://private.test/inbox'); } };
    dlog.length = 0;
    const e = await failing(safari.eval(['window.__ran = true']));
    assert.equal(e.extra.needs, 'tab');
      assert.match(e.message, /not one of this session's allowed hosts \(old\.test\)/);
    assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /private\.test/);
    nothingMarked(token);
    assert.equal(dv.pages[PAGE].win.__ran, undefined);
    assert.deepEqual(loadState().deviceTab, tainted());
    assert.equal(dv.context, 'NATIVE_APP');
    neverUnsafe();
  }
});

test('allowed host: a context that moves is waited out once; the lab\'s page is marked, the other page never selected; a second move taints', async () => {
  await startPhone(STOCK, ['old.test']);
  const { token } = loadState().deviceTab;
  dv.pageNav(PAGE, `${OLD}/`);
  let moved;
  dv.afterExecute = (page, s) => {
    if (!PROBE.test(s)) return;
    dv.afterExecute = null;
    moved = addPage('WEBVIEW_9.4', `${OLD}/inbox`, { win: { name: '' } }); // a page on the allowed site takes the context
  };
  const out = await safari.eval(['1']);
  assert.deepEqual([out.value, out.followed], [1, [OLD]]);
  assert.equal(dv.pages[PAGE].win.name, token);
  assert.equal(moved.win.name, '', 'the page that took the context never carried the marker');
  assert.equal(moved.runs, 0);
  assert.equal(probes().length, 2);
  assert.equal(marks().length, 1);
  assert.match(runLog(), /safari plant: context moved after the probe page=WEBVIEW_9\.1 movedTo=new landed=WEBVIEW_9\.4 retry=true/);
  neverUnsafe();

  await startPhone(STOCK, ['old.test']);
  const t2 = loadState().deviceTab.token;
  dv.pageNav(PAGE, `${OLD}/`);
  let n = 4;
  const extra = [];
  dv.afterExecute = (page, s) => { if (PROBE.test(s)) extra.push(addPage(`WEBVIEW_9.${++n}`, `${OLD}/inbox`, { win: { name: '' } })); };
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.equal(extra.length, 2);
  assert.ok(extra.every(p => p.runs === 0 && p.win.name === ''));
  nothingMarked(t2);
  assert.deepEqual(loadState().deviceTab, tainted());
  neverUnsafe();
});

test('allowed host: a document still loading is waited for; one that never completes is not a taint, and the next command follows', async () => {
  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/`);
  dv.pages[PAGE].loading = 2;
  const out = await safari.eval(['1']);
  assert.deepEqual(out.followed, [OLD]);
  assert.equal(probes().length, 3, 'two probes found the document loading');
  assert.equal(marks().length, 1);

  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/`);
  dv.pages[PAGE].loading = 1e9;
  const e = await failing(safari.eval(['window.__ran = true']));
  assert.equal(e.extra.needs, 'tab');
  assert.match(e.message, /^the lab's tab went to one of its allowed hosts but the page did not finish loading within \d+s, so it was not marked again; run the command again$/);
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.equal(marks().length, 0);
  assert.equal(dv.pages[PAGE].win.__ran, undefined);
  assert.equal(dv.context, 'NATIVE_APP');
  dv.pages[PAGE].loading = 0;
  const next = await safari.eval(['1']);
  assert.deepEqual([next.value, next.followed], [1, [OLD]]);
  neverUnsafe();
});

test('allowed host: a follow that works and then a command that fails still reports where the lab followed', async () => {
  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/`);
  const e = await failing(safari.eval(['(function () { throw new Error("boom"); })()']));
  assert.match(e.message, /the page script threw: boom/);
  assert.deepEqual(e.extra.followed, [OLD]);
  assert.equal(loadState().deviceTab.origin, OLD);
});

test('open and refresh accept a redirect to an allowed host and refuse any other', async () => {
  await startPhone(false, ['b.test']);
  dv.redirect = { 'a.test': 'b.test' };
  const out = await safari.open(['https://a.test/start']);
  assert.equal(out.finalUrl, 'https://b.test/start');
  assert.equal(out.followed, undefined, 'a redirect of the lab\'s own navigation is not a follow');
  const tab = loadState().deviceTab;
  assert.equal(tab.origin, 'https://b.test');
  assert.deepEqual(tab.origins, ['https://example.com', 'https://a.test', 'https://b.test']);
  assert.equal(dv.pages[PAGE].win.name, tab.token);
  assert.match(probes()[0].script, /\(location\.origin === "https:\/\/a\.test" \|\| location\.origin === "https:\/\/www\.a\.test" \|\| location\.origin === "https:\/\/b\.test" \|\| location\.origin === "http:\/\/b\.test"\)/);
  dlog.length = 0;
  await safari.refresh([]);
  assert.match(probes()[0].script, /\(location\.origin === "https:\/\/b\.test" \|\| location\.origin === "http:\/\/b\.test"\)/, 'a reload may end where the tab was, or on an allowed host');

  dv.redirect = { 'c.test': 'private.test' };
  const e = await failing(safari.open(['https://c.test/start']));
  assert.match(e.message, /the tab did not end on https:\/\/c\.test or one of this session's allowed hosts \(b\.test\); run `safari start` for a new session \(and name the hosts again with `--allow-host`\)/);
  assert.doesNotMatch(JSON.stringify([e.message, e.extra]), /private\.test/);
  assert.equal(dv.pages[PAGE].win.name, '');
  assert.deepEqual(loadState().deviceTab, tainted('https://c.test'));
  neverUnsafe();
});

test('open when the tab is on an allowed host without its marker follows first, then navigates once; the destination is recorded only for the navigation', async () => {
  await startPhone(false, ['old.test']);
  const { token } = loadState().deviceTab;
  let navAtFollow;
  // The tab goes to the allowed host between the page read that open starts with and the script that navigates.
  dv.afterExecute = (page, s) => {
    if (/performance\.timeOrigin, document\.readyState/.test(s)) { dv.afterExecute = null; dv.pageNav(PAGE, `${OLD}/`); }
  };
  dv.beforeExecute = s => { if (PROBE.test(s) && navAtFollow === undefined) navAtFollow = loadState().deviceTab.navTo ?? null; }; // the follow's probe is the first
  const out = await safari.open(['https://x.test/page']);
  assert.deepEqual(out.followed, [OLD]);
  assert.equal(navAtFollow, null, 'the navigation that never ran is not recorded while the tab is followed');
  assert.equal(out.url, 'https://x.test/page');
  const tab = loadState().deviceTab;
  assert.equal(tab.origin, 'https://x.test');
  assert.equal(tab.navTo, undefined);
  assert.deepEqual(tab.origins, ['https://example.com', OLD, 'https://x.test']);
  assert.equal(executes().filter(b => /location\.replace/.test(b.script) && !/__msl: 3/.test(b.script)).length, 1, 'the navigation ran once, behind the strict guard');
  assert.equal(dv.pages[PAGE].win.name, token);
  neverUnsafe();
});

test('an interrupt while the lab follows its tab keeps the session, taints only if the park shows a move, and says so', async () => {
  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/`);
  dlog.length = 0;
  const e = await signalAfter((u, o) => u.endsWith('/execute/sync') && /document\.readyState !== \\"complete\\"/.test(o?.body), 'SIGTERM', () => failing(safari.eval(['1'])));
  assert.ok(e instanceof InterruptError);
  assert.equal(e.extra.sessionKept, true);
  assert.equal(e.extra.tainted, false);
  assert.equal(dv.context, 'NATIVE_APP');
  assert.equal(loadState().deviceTab.tainted, undefined);
  assert.match(runLog(), /safari plant: interrupted by SIGTERM, not tainted/);
  assert.equal(marks().length, 0);
  neverUnsafe();
});

test('--allow-host is checked before anything runs: shapes, wildcards, schemes, paths, logins, the cap', async () => {
  const bad = ['*.reddit.com', '*', 'old.test/x', 'https://old.test', 'u@old.test', 'old.test?q=1', 'old.test#f', 'old test', 'old.test\\x', '', 'old.test:abc', 'http://', ':'];
  for (const host of bad) {
    assert.throws(() => parseAllowHosts([host]), /allowed host|wildcards are not taken/, JSON.stringify(host));
    deviceReset();
    dlog.length = 0;
    await assert.rejects(safari.start(['--device', PU, '--allow-host', host]), /allowed host|wildcards are not taken/, JSON.stringify(host));
    assert.equal(dlog.length, 0, `${JSON.stringify(host)}: nothing was contacted`);
  }
  assert.throws(() => parseAllowHosts(['*.old.test']), /wildcards are not taken: name each host \(old\.reddit\.com\)/);
  assert.throws(() => parseAllowHosts(Array.from({ length: 11 }, (_, i) => `h${i}.test`)), /at most 10 allowed hosts/);
  assert.equal(parseAllowHosts(Array.from({ length: 10 }, (_, i) => `h${i}.test`)).length, 10);
  assert.equal(parseAllowHosts([...Array.from({ length: 10 }, (_, i) => `h${i}.test`), 'H0.TEST']).length, 10, 'a duplicate does not count twice');
  await assert.rejects(safari.start(['--allow-host']), /--allow-host needs a value/);
  const nothingEchoed = await failing(safari.start(['--allow-host', 'user:pw@secret.test']));
  assert.doesNotMatch(nothingEchoed.message, /secret|pw/);
});

test('--allow-host takes the lowercase, punycode, bracketed IPv6 and default-port forms the URL gives, and drops duplicates', () => {
  assert.deepEqual(parseAllowHosts(['Old.Reddit.COM', 'old.reddit.com', 'bücher.example', 'localhost:3000', '[::1]:8080', '192.168.1.5', 'old.test:443']), ['old.reddit.com', 'xn--bcher-kva.example', 'localhost:3000', '[::1]:8080', '192.168.1.5', 'old.test']);
  assert.deepEqual(parseAllowHosts(), []);
});

test('start --allow-host on a reused phone session adds hosts and never removes any; more than ten is refused with the record unchanged', async () => {
  await startPhone(false, ['a.test']);
  const first = loadState().deviceTab;
  let out = await safari.start(['--device', PU, '--allow-host', 'b.test', '--allow-host', 'A.test']);
  assert.equal(out.reused, true);
  assert.deepEqual(out.allowHosts, ['a.test', 'b.test']);
  assert.deepEqual(loadState().deviceTab, { ...first, allowHosts: ['a.test', 'b.test'] });
  out = await safari.start(['--device', PU]);
  assert.deepEqual(out.allowHosts, ['a.test', 'b.test'], 'a start that names none keeps them');
  assert.deepEqual(loadState().deviceTab.allowHosts, ['a.test', 'b.test']);
  dlog.length = 0;
  const nine = Array.from({ length: 9 }, (_, i) => ['--allow-host', `n${i}.test`]).flat();
  const e = await failing(safari.start(['--device', PU, ...nine]));
  assert.match(e.message, /at most 10 allowed hosts; this one already has 2 \(a\.test, b\.test\)/);
  assert.deepEqual(loadState().deviceTab.allowHosts, ['a.test', 'b.test']);
  assert.equal(dlog.filter(([m, u]) => m === 'POST' && u === '/session').length, 0, 'no session was created');
  // The hosts it added are followed.
  dv.pageNav(PAGE, 'https://b.test/');
  assert.deepEqual((await safari.eval(['1'])).followed, ['https://b.test']);
  neverUnsafe();
});

test('a replaced session starts with only the hosts named now: a taint dropped the old list', async () => {
  await startPhone(false, ['a.test']);
  dv.pageNav(PAGE, 'https://private.test/');
  await failing(safari.eval(['1']));
  assert.equal(loadState().deviceTab.allowHosts, undefined);
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  const out = await safari.start(['--device', PU, '--allow-host', 'b.test']);
  assert.equal(out.reused, undefined);
  assert.deepEqual(out.allowHosts, ['b.test']);
  assert.deepEqual(loadState().deviceTab.allowHosts, ['b.test']);
});

test('a recorded tab whose allowed hosts are damaged is refused like any damaged tab record; one without them is the legacy shape and works', async () => {
  await startPhone();
  const tab = loadState().deviceTab;
  assert.equal(Object.hasOwn(tab, 'allowHosts'), false);
  assert.equal((await safari.eval(['1'])).value, 1);
  const damaged = [[], 'old.test', ['old.test', 5], ['https://old.test'], ['*.old.test'], ['old.test/x'], ['A.TEST'], Array.from({ length: 11 }, (_, i) => `h${i}.test`), null, {}];
  for (const allowHosts of damaged.slice(1)) {
    saveState({ deviceTab: { ...tab, allowHosts } });
    dlog.length = 0;
    const e = await failing(safari.eval(['1']));
    assert.equal(e.extra.needs, 'tab', JSON.stringify(allowHosts));
    assert.match(e.message, /no recorded lab tab/, JSON.stringify(allowHosts));
    assert.equal(dlog.length, 0, 'nothing is sent to the phone');
  }
  saveState({ deviceTab: { ...tab, allowHosts: [] } });
  assert.equal((await safari.eval(['1'])).value, 1, 'an empty list is no list');
  assert.doesNotMatch(executes().at(-1).script, /__msl: 3/);
});

// A page on another site runs its own script before the lab's: it can patch Array.prototype.includes and answer for the lab's scripts.
// Nothing the lab sends into a page may rely on a method of the page's own prototypes to decide where it is.
const patchIncludes = () => {
  const real = Array.prototype.includes;
  dv.onExecute = page => { if (page.id === PAGE) Array.prototype.includes = () => true; };
  dv.afterExecute = page => { if (page.id === PAGE) Array.prototype.includes = real; };
  return () => { Array.prototype.includes = real; };
};

test('a page on a site that is not allowed cannot answer for the lab by patching Array.prototype.includes: tainted, no probe, no mark, no marker', async () => {
  await startPhone(false, ['old.test']);
  const { token } = loadState().deviceTab;
  dv.pageNav(PAGE, 'https://private.test/inbox');
  dlog.length = 0;
  const unpatch = patchIncludes();
  let e;
  try { e = await failing(safari.eval(['window.__ran = true'])); } finally { unpatch(); }
  assert.equal(e.extra.needs, 'tab');
  assert.equal(executes().length, 1, 'only the guard\'s yes/no reached the page');
  assert.equal(probes().length + marks().length, 0);
  assert.equal(dv.pages[PAGE].win.name, '');
  assert.equal(dv.pages[PAGE].win.__ran, undefined);
  nothingMarked(token);
  assert.deepEqual(loadState().deviceTab, tainted());
  neverUnsafe();
});

test('open: a redirect to a site that is not expected, whose page patches Array.prototype.includes, is tainted and gets no marker', async () => {
  await startPhone(false, ['b.test']);
  const { token } = loadState().deviceTab;
  dv.redirect = { 'a.test': 'private.test' };
  const unpatch = patchIncludes();
  let e;
  try { e = await failing(safari.open(['https://a.test/start'])); } finally { unpatch(); }
  assert.match(e.message, /the tab did not end on https:\/\/a\.test or one of this session's allowed hosts \(b\.test\); run `safari start`/);
  assert.equal(marks().length, 0, 'the mark was never sent');
  nothingMarked(token);
  assert.deepEqual(loadState().deviceTab, tainted('https://a.test'));
  neverUnsafe();
});

test('start: an owner\'s page the driver picked cannot pass for the lab\'s tab by patching String.prototype.indexOf', async () => {
  deviceReset();
  withPhone();
  phoneIs();
  dv.pick = OTHER;
  const real = String.prototype.indexOf;
  dv.onExecute = page => { if (page.id === OTHER) String.prototype.indexOf = () => 0; };
  dv.afterExecute = page => { if (page.id === OTHER) String.prototype.indexOf = real; };
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${ps.port}`;
  let e;
  try { e = await failing(safari.start(['--device', PU])); } finally { String.prototype.indexOf = real; dv.onExecute = dv.afterExecute = null; }
  assert.equal(e.extra.needs, 'tab');
  assert.equal(executes().length, 1, 'the one start script');
  assert.equal(dv.pages[OTHER].win.name, 'owner-state', 'no token was planted in it');
  assert.ok(!loadState().deviceTab, 'no tab was recorded');
});

test('a page that forges the guard\'s and the probe\'s answers for an allowed host is not marked and the run is tainted', async () => {
  for (const forgeMark of [false, true]) {
    await startPhone(false, ['old.test']);
    const { token } = loadState().deviceTab;
    dv.pageNav(PAGE, 'https://private.test/inbox');
    dv.mapResult = (value, s) => {
      if (/^if \(window\.name !== /.test(s) && /__msl: 3/.test(s)) return { __msl: 3 };
      if (PROBE.test(s)) return [dv.pages[PAGE].origin, OLD, false];
      if (forgeMark && MARK.test(s)) return OLD;
      return value;
    };
    const e = await failing(safari.eval(['window.__ran = true']));
    assert.equal(e.extra.needs, 'tab', String(forgeMark));
    assert.equal(dv.pages[PAGE].win.name, '', `${forgeMark}: the page was not marked`);
    assert.equal(dv.pages[PAGE].win.__ran, undefined);
    nothingMarked(token);
    // A forged mark answer is recorded as the origin (it can only be an allowed one: Node checks it), then the strict guard taints.
    assert.deepEqual(loadState().deviceTab, tainted(forgeMark ? OLD : 'https://example.com'), String(forgeMark));
    neverUnsafe();
  }
});

test('a guard answer of 3 that the guard could not have given (no list, or after a follow) taints', async () => {
  await startPhone();
  dv.mapResult = (value, s) => (/^if \(window\.name !== /.test(s) ? { __msl: 3 } : value);
  const e = await failing(safari.eval(['1']));
  assert.equal(e.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted());
  await startPhone(false, ['old.test']);
  dv.pageNav(PAGE, `${OLD}/`);
  dv.mapResult = (value, s) => (/^if \(window\.name !== /.test(s) && !/__msl: 3/.test(s) && !MARK.test(s) ? { __msl: 3 } : value);
  const e2 = await failing(safari.eval(['1']));
  assert.equal(e2.extra.needs, 'tab');
  assert.deepEqual(loadState().deviceTab, tainted(OLD), 'the follow itself worked: the tab was on the allowed host');
});
