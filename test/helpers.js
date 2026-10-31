// Temp state and run folders per test, and a recording stand-in for command execution.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { PERL, HELPER, LOCK_NAME } from '../lib/signlock.js';
import { setRunner } from '../lib/core.js';
import { CLOCK } from '../lib/safari.js';
import { LOG_FILTERS, PLUGIN, pluginDir } from '../lib/appium.js';
import { encodePng } from '../lib/png.js';

// The lab's deadlines (CLOCK in lib/safari.js) as a step clock: time passes only in the waits between polls (still really slept, the
// stand-in's close timer is real), not while a request is in flight. A slow runner, or a slow request, then never eats a budget or makes
// `stop` read its own arm reply as slower than the close timer; a test that wants the race puts REAL_CLOCK back and delays the reply.
export const REAL_CLOCK = { ...CLOCK }; // CLOCK as shipped, before any test replaces it
export function stepClock() {
  let t = 0;
  Object.assign(CLOCK, { now: () => t, sleep: ms => { t += ms; return REAL_CLOCK.sleep(ms); } });
}

// The rules file as `lab service install` writes it; a file with anything else is stale.
export const CURRENT_RULES = `${JSON.stringify(LOG_FILTERS, null, 2)}\n`;

// Tests only: cloud sessions run as root, which the lab refuses. Set here so child processes inherit it.
process.env.MSL_ALLOW_ROOT = '1';

// Tests only: the lease owner is otherwise read with `ps` when neither MSL_OWNER nor CLAUDE_CODE_SESSION_ID is set
// (as in CI), and a recorded runner would count that call. Tests that look at the owner set their own.
process.env.MSL_OWNER ??= 'msl-test';

// Tests only: the signing lock (lib/signlock.js) must never touch the owner's ~/.sideload. A folder that does not exist
// skips it; tests of the lock itself point SIDELOAD_HOME at a temporary folder they make.
delete process.env.MSL_SIGNLOCK;
process.env.SIDELOAD_HOME = path.join(os.tmpdir(), `msl-no-sideload-${process.pid}`);

// Every folder this process made; removed when it exits (each test file runs in its own process).
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

export function tempDir(prefix = 'msl-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// The page pin plugin as `pnpm add link:` leaves it in an Appium home: node_modules/msl-page-pin, a link to this repo's appium-plugin.
export function linkPlugin(home) {
  const link = path.join(home, 'node_modules', PLUGIN);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(pluginDir(), link);
  return home;
}

export function sandbox() {
  const dir = tempDir();
  process.env.MSL_STATE = path.join(dir, 'state');
  process.env.MSL_RUNS = path.join(dir, 'runs');
  process.env.MSL_LAUNCH_AGENTS = path.join(dir, 'LaunchAgents'); // never the real ones
  process.env.MSL_LOGS = path.join(dir, 'Logs');
  return dir;
}

// Records every command; `reply(cmd, args)` returns { code, stdout, stderr } or undefined (= ok).
// `calls.opts` (not enumerable, so it never shows in a deepEqual of `calls`) holds each call's options, in step with `calls`.
export function fakeRunner(reply = () => undefined) {
  const calls = [];
  Object.defineProperty(calls, 'opts', { value: [] });
  setRunner((cmd, args, opts) => {
    calls.push([cmd, ...args]);
    calls.opts.push(opts);
    const said = reply(cmd, args);
    // A service that started just now: the rules it was given are the ones on disk (see rulesLoadedBy).
    if (!said && cmd === 'ps' && args.includes('etime=')) return { code: 0, stdout: '00:00\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '', ...(said || {}) };
  });
  return calls;
}

// A 1x1-header PNG of the given size (only the header is read).
export function fakePng(file, width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  fs.writeFileSync(file, b);
}

// A real PNG (base64, as the screenshot route answers) of width x height whose pixel (x, y) is
// [x & 255, y & 255, (x + y) & 255], so a crop can be checked by where its corner came from.
export const gradientPng = (width, height, extraChunks = []) => {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x & 255, y & 255, (x + y) & 255], (y * width + x) * 3);
  return encodePng({ width, height, channels: 3, data, chunks: extraChunks }).toString('base64');
};

export const PAGE = 'WEBVIEW_9.1'; // the lab's tab on the phone
export const OTHER = 'WEBVIEW_9.2'; // the owner's tab, which must never be touched
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

// A stand-in for the WebDriver server (Appium) with just what `safari start`, the liveness
// probe, `open` and `lab` use. `fx` is what tests poke: `up` (false = /status answers 503),
// `sessions` (ids it knows), `webviews` (pages Safari has; a new session brings one back),
// `createFails`, `createErrors` (messages the next session creates fail with, 500, one each),
// `createDelayMs` (how long a create waits before answering), `onCreate` (called when a create arrives, before any delay), `settings` (what the last Appium settings call set). `log` records every
// request as [method, url, body].
//
// On the phone, the keyboard settings behave like WebDriverAgent's: a new session turns Auto-Correction
// and Predictive off (`fx.keyboard`, the phone's live values; `GET /appium/settings` reports them and
// a settings call that sets `keyboardAutocorrection` / `keyboardPrediction` changes them).
// `fx.keyboardFail` (true, or an error message) makes that call answer 500, `fx.keyboardDelayMs` makes it late,
// and `fx.keyboardIgnored` has it accepted but change nothing.
//
// `fx.phone` (or `standin({ phone: true })`) makes it the owner's iPhone instead: a Safari with
// the lab's tab (PAGE, opened by `launch(url)`, which stands for `devicectl ... process launch`)
// and the owner's tab (OTHER), behaving like the real driver where it matters: a new page that
// appears while the session is in a web view becomes the current context, and a page that goes
// away while it is the current context moves the session to OTHER and makes the driver run
// something there (`dv.pages[OTHER].driverRuns`). That is the stock driver (`dv.pinned = false`).
// By default the phone has the lab's page pin plugin (`dv.pinned`, and the session create answers
// `msl:pagePin: 1`; `fx.pin = false` is an Appium without the plugin): a new page is only listed, a
// page that goes takes the session to NATIVE_APP, and a script is refused (500, `msl-page-pin:`) when
// the session is not on the page the client last selected. `dv` is the phone's state (see
// deviceFresh); `reset()` starts it over together with the generic fields.
const newPage = (dv, id, href, extra = {}) => {
  const page = { id, href, hist: 1, visible: true, origin: 1000, runs: 0, driverRuns: 0, els: {}, win: { name: '' }, resources: [], observers: [], mutationObservers: [], ...extra };
  page.win.close = () => { if (dv.closeWorks) removePage(dv, id); };
  return page;
};
const removePage = (dv, id) => {
  dv.closedWhile = dv.context; // what the session was in when the page went (NATIVE_APP: nothing followed it)
  delete dv.pages[id];
  if (dv.context === id && dv.pinned) dv.context = 'NATIVE_APP'; // the pinned handler: nothing is followed
  else if (dv.context === id && dv.pages[OTHER]) { dv.context = OTHER; dv.pages[OTHER].driverRuns++; }
};
const deviceFresh = () => {
  const dv = {
    pick: PAGE, // the page the driver selects when the session starts
    pinned: true, // the page pin plugin is armed (false: the stock driver follows new pages and the key tab)
    selected: null, // the page the client last selected (what the plugin's execute guard compares with)
    refuseSelect: false, // selecting a page is refused by the plugin's selectPage guard (500, `msl-page-pin:`)
    context: 'NATIVE_APP',
    pages: {}, // PAGE appears when Safari is launched on the tag URL
    closeWorks: true, // window.close() closes the tab
    redirect: {}, // host -> host the server sends the browser to instead
    hang: false, // scripts in the lab's tab are never answered (it is not showing); 'queue': Appium's serial queue (the stand-in's switchBack() clears it)
    queue: null, // the requests held behind a script that hangs in 'queue' mode, in the order they came
    hangOnSelect: false, // the next select of a page waits for the tab like a script does (everything behind it waits too); 'late': only that select is answered late, later requests are answered at once
    executeFails: null, // an error code: scripts in the lab's tab are answered with it (500)
    hangOnThrow: false, // a script in the lab's tab that throws is never answered, as the real driver does
    delay: null, // (script) => ms a script in the lab's tab is answered late
    contextFails: false, // GET /context answers 500
    contextReads: [], // the next answers to GET /context, in order, whatever the context is
    webViews: 1, // web views in the native tree
    labels: [], // labelled native nodes inside the web view (see deviceTree)
    onExecute: null, // called with the page before a script runs
    executed: [], // [page id, script]
    results: [], // [script, what it returned] for the scripts that ran in the lab's tab
    beforeExecute: null, // called before the stand-in looks up the page a script lands in
    afterExecute: null, // called with (page, script) after a script ran, before it is answered
    onSelect: null, // called after the session switched to a page
    onContexts: null, // called on every GET /contexts, before it is answered
    onContextRead: null, // called on every GET /context, before it is answered
    onPark: null, // called when a request is parked (held in the queue, or answered after 300 ms): the tab is not showing, nothing will answer it in time
    contextsFail: false, // GET /contexts answers 500
    mapResult: null, // (value, script) => the value a script in the lab's tab is answered with (what a hostile page could return)
    onNative: null, // called with the script of a `mobile:` call before it is answered
    screenshot: null, // the base64 PNG the screenshot route answers (default: just the PNG signature)
    onScreenshot: null, // called when the screenshot is taken
    upgradeHttps: false, // http addresses load as https
    closedWhile: undefined, // the context when a page last went away
    keys: 0, // `mobile: keys` calls
    afterReplace: false,
    storage: {}, // origin -> Map: the phone's localStorage, one per origin, kept across navigations
    storageThrow: null, // a message: the page's location.origin throws it the second time a script reads it (after the guard's own read), outside the storage script's try
    storageFail: null, // { at, name }: setItem number `at` (0-based, over the run) throws an error of that name whose message holds the value
    storageSets: 0,
    nextOrigin: 2000,
    tag: null,
  };
  dv.pages[OTHER] = newPage(dv, OTHER, 'https://private.test/inbox?id=7', { win: { name: 'owner-state' } });
  dv.pageNav = (id, url) => navigate(dv, dv.pages[id], url); // the page goes to `url` by itself (a link, the owner's hand): a new document, and Safari clears window.name when the site changes
  return dv;
};

// A new document: what the old one's scripts left behind is gone with it.
const freshDocument = page => {
  page.resources = [];
  page.observers = [];
  page.mutationObservers = [];
  page.listeners = {};
  for (const k of ['__mslKeysEv', '__mslKeysOn', '__mslSettle']) delete page.win[k];
  delete page.win.__mslConsole;
  delete page.win.__mslNet;
};

// The page fetched something: Resource Timing has the entry, and an observer following it is told.
export function addResource(page, entry) {
  page.resources.push(entry);
  for (const cb of page.observers) cb({ getEntries: () => [entry] });
  return entry;
}

// The page's DOM changed: the MutationObservers a script installed are told.
export function addMutation(page, n = 1) {
  for (const cb of page.mutationObservers) for (let i = 0; i < n; i++) cb([{}]);
}

function navigate(dv, page, to) {
  let target = new URL(to);
  if (dv.upgradeHttps && target.protocol === 'http:') target.protocol = 'https:';
  if (dv.redirect[target.host]) target = new URL(target.href.replace(target.host, dv.redirect[target.host]));
  if (target.host !== new URL(page.href).host) page.win.name = ''; // Safari clears it across sites
  page.href = target.href;
  page.origin = dv.nextOrigin++;
  freshDocument(page);
}

// A page field that holds text: `page.field = { value, type, keyboard, resetTo, fireEvents }`. `keyboard(ch, value)` is
// the field's new text after a key press (default: the character appended). `fireEvents`: a key
// press (or the delete key) tells the page's document listeners about keydown, beforeinput and input
// (`true`, or `{ types, target }`), as a field that rewrites its own text does. A page script's
// results are recorded in `dv.results` as [script, result].
function fieldElement(page) {
  return page.fieldEl ??= {
    tagName: 'INPUT', isContentEditable: !!page.field.editable,
    get type() { return page.field.type ?? 'text'; },
    get value() { return page.field.value; },
    get textContent() { return page.field.value; },
    get maxLength() { return page.field.max ?? -1; },
    get selectionStart() { return page.field.sel?.[0] ?? page.field.value.length; }, // sel: [start, end]; default a caret at the end
    get selectionEnd() { return page.field.sel?.[1] ?? page.field.value.length; },
  };
}

// The events a key press on the page's field fires, to the listeners its scripts registered.
function fireFieldEvents(page) {
  const o = page?.field?.fireEvents;
  if (!o) return;
  const { types = ['keydown', 'beforeinput', 'input'], target = fieldElement(page) } = o === true ? {} : o;
  for (const type of types) for (const fn of page.listeners?.[type] ?? []) fn({ type, target });
}

// Runs a page script as the page would, against a fake window/location/document (so the real
// guard scripts are what is tested).
function runPage(dv, page, script, args) {
  let originReads = 0;
  const location = {
    get search() { return new URL(page.href).search; },
    get host() { return new URL(page.href).host; },
    get href() { return page.href; },
    get origin() {
      if (dv.storageThrow && script.includes('localStorage.setItem') && ++originReads === 2) throw new Error(dv.storageThrow);
      return new URL(page.href).origin;
    },
    replace: to => { dv.afterReplace = true; navigate(dv, page, to); },
    reload: () => { page.origin = dv.nextOrigin++; freshDocument(page); },
  };
  // localStorage is the origin's own: what one site stored, another never sees.
  const stored = () => (dv.storage[location.origin] ??= new Map());
  const localStorage = {
    setItem: (k, v) => {
      if (dv.storageFail && dv.storageSets++ === dv.storageFail.at) throw Object.assign(new Error(`cannot store ${k}=${v}`), { name: dv.storageFail.name });
      stored().set(String(k), String(v));
    },
    getItem: k => stored().get(String(k)) ?? null,
  };
  class Input { get value() { return this.v ?? ''; } set value(v) { this.v = v; } }
  class Textarea extends Input {}
  page.elCache ??= {};
  const el = css => {
    page.lastEl = page.elCache[css] ??= Object.assign(new Input(), {
      css, tagName: page.tags?.[css] ?? page.tags?.[css.replace(/\[\d+\]$/, '')] ?? 'DIV', type: 'text',
      click: () => { page.clicked = css; }, focus() {}, dispatchEvent() {}, contains: () => false,
      scrollIntoView: o => { (page.scrolls ??= []).push([css, o]); page.onScroll?.(css, o); },
      // `rectOf(css)` lets a test move the element between reads.
      getBoundingClientRect() {
        page.lastEl = this; // the element being measured is what a tap there would hit (a text search creates every candidate first)
        const r = page.rectOf?.(css) ?? { left: 80, top: 190, width: 40, height: 20 };
        return { ...r, right: r.left + r.width, bottom: r.top + r.height };
      },
    });
    return page.lastEl;
  };
  const textEl = (css, i, text, map) => {
    const e = el(`${css}[${i}]`);
    e.innerText = text;
    const root = page.roots?.[css];
    if (root) e.shadowRoot = { querySelectorAll: c => (root[c] ?? []).map((t, j) => textEl(c, j, t, root)) };
    return e;
  };
  // `page.styleOf(css)` gives an element's computed style (default: plain, visible).
  Object.assign(page.win, { innerWidth: 414, innerHeight: 750, visualViewport: null, getComputedStyle: e => page.styleOf?.(e.css) ?? { display: 'block', visibility: 'visible', opacity: '1', paddingTop: `${page.inset ?? 0}px` } }); // page.inset: env(safe-area-inset-top) in px
  const probe = { setAttribute: (k, v) => { if (k === 'aria-label') page.probeLabel = v; }, style: {}, remove() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const document = {
    get readyState() { return page.loading > 0 ? (page.loading--, 'loading') : 'complete'; }, // page.loading: how many reads still find the document loading
    get visibilityState() { return page.visible ? 'visible' : 'hidden'; },
    hasFocus: () => false,
    title: 'Example',
    documentElement: { outerHTML: '<html></html>', appendChild() {} },
    addEventListener: (type, fn) => { ((page.listeners ??= {})[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { const l = page.listeners?.[type]; if (l) page.listeners[type] = l.filter(x => x !== fn); },
    activeElement: page.activeCss ? page.elCache[page.activeCss] ?? null : !page.field ? null : page.field === true ? { tagName: 'INPUT', isContentEditable: false } : fieldElement(page),
    createElement: () => probe,
    // For `wait --settled`: `page.images` ({ complete, loading?, rect? }), `page.fonts` ({ status }) and `page.scroll` ({ w, h }, the scroll size).
    get images() { return page.images ?? []; },
    get fonts() { return page.fonts; },
    scrollingElement: { get scrollWidth() { return page.scroll?.w ?? 414; }, get scrollHeight() { return page.scroll?.h ?? 900; } },
    elementFromPoint: () => page.lastEl,
    // `page.texts[css]`: texts, one element each (innerText, in order), for text searches; `page.roots[host css][css]`: the same inside that host's open shadow root; `page.invalid`: selectors the page refuses (a SyntaxError).
    querySelectorAll: css => (css.startsWith('[aria-label^=') ? (page.probeLabel ? [{ remove: () => { page.probeLabel = null; page.probesCleared = (page.probesCleared ?? 0) + 1; } }] : []) : page.invalid?.includes(css) ? (() => { throw new SyntaxError('not a valid selector'); })() : page.texts?.[css] ? page.texts[css].map((text, i) => textEl(css, i, text, page.texts)) : Array.from({ length: page.els[css] ?? 0 }, (_, i) => el(i ? `${css}[${i}]` : css))),
    querySelector: css => (css.startsWith('[aria-label=') ? { remove: () => { page.probeLabel = null; } } : page.els[css] ? el(css) : null),
  };
  const history = { get length() { return page.hist; } };
  const fakeConsole = { error() {}, warn() {}, log() {} };
  // Resource Timing: `page.resources` are the browser's entries; an observer with `buffered` is handed them at once and told of later ones.
  const navEntry = { name: page.href, entryType: 'navigation', initiatorType: 'navigation', startTime: 0, duration: 85, transferSize: 4000, encodedBodySize: 3500, decodedBodySize: 9000, responseStatus: 200, nextHopProtocol: 'h2', serverTiming: [] };
  const fakePerformance = {
    timeOrigin: page.origin,
    now: () => page.clock?.() ?? performance.now(), // page.clock: a test's own time, in ms
    getEntriesByType: type => (type === 'resource' ? page.resources.slice() : type === 'navigation' ? [navEntry] : []),
  };
  class FakeObserver {
    constructor(cb) { this.cb = cb; }
    observe(o) {
      if (page.noObserver || o.type !== 'resource') throw new TypeError('unsupported entry type');
      page.observers.push(this.cb);
      if (o.buffered) this.cb({ getEntries: () => page.resources.slice() });
    }
  }
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() {
      if (page.noMutationObserver) throw new TypeError('unsupported');
      page.mutationObservers.push(this.cb);
    }
  }
  return new Function('window', 'location', 'document', 'history', 'performance', 'console', 'addEventListener', 'Event', 'HTMLTextAreaElement', 'HTMLInputElement', 'setTimeout', 'PerformanceObserver', 'MutationObserver', 'localStorage', 'args',
    `return (function () {${script}}).apply(null, args);`)(page.win, location, document, history, fakePerformance, fakeConsole, () => {}, class {}, Textarea, Input, setTimeout, FakeObserver, FakeMutationObserver, localStorage, args);
}

// `mobile: source`: the screen, Safari's tab bar (with the owner's tab title, outside the web
// view), the web view with the page's text and the calibration probe while one is in the page.
// `dv.labels`: labelled nodes inside the web view, { label, x, y, width, height, type? }.
function deviceTree(dv) {
  const probe = dv.pages[PAGE]?.probeLabel;
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const labelled = (dv.labels ?? []).map(l => `<${l.type ?? 'XCUIElementTypeButton'} label="${esc(l.label)}" x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}"/>`).join('');
  const view = `<XCUIElementTypeWebView x="0" y="0" width="414" height="896">${probe ? `<XCUIElementTypeImage label="${probe}" x="0" y="48" width="100" height="100"/>` : ''}<XCUIElementTypeStaticText label="Example Domain"/>${labelled}</XCUIElementTypeWebView>`;
  const extra = Array.from({ length: Math.max(0, dv.webViews - 1) }, () => '<XCUIElementTypeWebView x="0" y="0" width="10" height="10"/>').join('');
  return `<XCUIElementTypeApplication label="Safari" x="0" y="0" width="414" height="896">${view}${extra}`
    + '<XCUIElementTypeKey label="delete" x="340" y="790" width="60" height="40"/><XCUIElementTypeTabBar x="0" y="800" width="414" height="96"><XCUIElementTypeButton label="TabBarItemTitle" value="Inbox - private.test" x="10" y="810" width="100" height="40"/><XCUIElementTypeStaticText label="Inbox - private.test" x="10" y="850" width="100" height="20"/></XCUIElementTypeTabBar></XCUIElementTypeApplication>';
}

export function standin({ phone = false } = {}) {
  const fx = { up: true, sessions: new Set(), webviews: ['WEBVIEW_1'], created: 0, createFails: false, createErrors: [], createDelayMs: 0, origin: 1000, href: 'about:blank', phone, pin: true };
  const log = [];
  const ctx = new Map();
  let dv = deviceFresh();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : undefined;
      log.push([req.method, req.url, json]);
      const send = (value, status = 200) => { if (res.destroyed) return true; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value })); return true; };
      const fail = (error, status = 404, message = error) => send({ error, message }, status);
      if (req.url === '/status') return fx.up ? send({ ready: true }) : fail('unavailable', 503);
      if (req.method === 'POST' && req.url === '/session') {
        fx.onCreateRequest?.(); // like onCreate, but also when the create is about to fail (Appium's log gets the reason)
        if (fx.createFails) return fail('session not created', 500);
        if (fx.createErrors.length) return fail('session not created', 500, fx.createErrors.shift());
        fx.onCreate?.(); // a test's hook: what happens on the machine as the session is being created (Xcode writing the build)
        const create = () => {
          const id = `S${++fx.created}`;
          fx.sessions.add(id);
          ctx.set(id, 'WEBVIEW_1');
          fx.webviews = ['WEBVIEW_1'];
          if (fx.phone) { dv.context = dv.selected = dv.pick; fx.keyboard = { keyboardAutocorrection: false, keyboardPrediction: false }; }
          send({ sessionId: id, capabilities: fx.phone && fx.pin ? { 'msl:pagePin': 1 } : {} });
        };
        if (fx.createDelayMs) setTimeout(create, fx.createDelayMs);
        else create();
        return undefined;
      }
      const m = req.url.match(/^\/session\/([^/]+)(.*)$/);
      if (!m || !fx.sessions.has(m[1])) return fail('invalid session id');
      const [, id, p] = m;
      if (req.method === 'DELETE' && p === '') { fx.sessions.delete(id); return send(null); }
      if (req.method === 'GET' && p === '/appium/settings') return send({ waitForIdleTimeout: 0, ...fx.keyboard });
      if (req.method === 'POST' && p === '/appium/settings') {
        const keyboardCall = Object.keys(json.settings).some(k => k.startsWith('keyboard'));
        const apply = () => {
          if (keyboardCall && fx.keyboardFail) return fail('unknown error', 500, typeof fx.keyboardFail === 'string' ? fx.keyboardFail : 'settings refused');
          fx.settings = json.settings;
          if (keyboardCall && !fx.keyboardIgnored) fx.keyboard = { ...fx.keyboard, ...json.settings };
          return send(null);
        };
        if (keyboardCall && fx.keyboardDelayMs) return void setTimeout(apply, fx.keyboardDelayMs);
        return apply();
      }
      if (fx.phone) return phoneRequest(req, p, json, send, fail);
      if (p === '/context' && req.method === 'GET') return send(ctx.get(id));
      if (p === '/context') { ctx.set(id, json.name); return send(null); }
      if (p === '/contexts') return send(['NATIVE_APP', ...fx.webviews]);
      if (ctx.get(id) === 'NATIVE_APP') return fail('invalid context', 400);
      if (!fx.webviews.includes(ctx.get(id))) return fail('no such window');
      if (p === '/url' && req.method === 'POST') { fx.href = json.url; fx.origin++; return send(null); }
      if (p === '/url') return send(fx.href);
      if (p === '/title') return send('Example');
      if (p === '/execute/sync') return send([fx.origin, 'complete', fx.href]);
      fail('unknown command');
    });
  });
  // The phone's Safari behind the session: everything after the generic session routes.
  function phoneRequest(req, p, json, send, fail, resumed = false, at = null) {
    const failure = (error, message = error, status = 404) => send({ error, message }, status);
    const park = () => dv.onPark?.(); // every way a request goes unanswered (queued, held, or answered late) passes here
    // Appium runs one session's commands one after another: while a script waits for a tab that is
    // not showing, every later request waits behind it. They are all answered, in order, by switchBack().
    if (dv.queue) { park(); dv.queue.push(() => phoneRequest(req, p, json, send, fail)); return undefined; }
    if (p === '/contexts') { dv.onContexts?.(); return dv.contextsFail ? failure('unknown error', 'no list', 500) : send(['NATIVE_APP', ...Object.keys(dv.pages)]); }
    if (p === '/context' && req.method === 'GET') dv.onContextRead?.();
    if (p === '/context' && req.method === 'GET' && dv.contextReads.length) return send(dv.contextReads.shift());
    if (p === '/context' && req.method === 'GET') return dv.contextFails ? failure('unknown error', 'no context', 500) : send(dv.context);
    if (p === '/context') {
      if (json.name !== 'NATIVE_APP' && !dv.pages[json.name]) return failure('invalid context', json.name, 400);
      if (dv.refuseSelect && json.name !== 'NATIVE_APP') return failure('unknown error', 'msl-page-pin: Appium tried to select a page the lab did not ask for', 500); // the plugin's selectPage guard
      if (dv.hangOnSelect === 'late' && json.name !== 'NATIVE_APP') { dv.hangOnSelect = false; park(); return void setTimeout(() => send(null), 300); }
      if (dv.hangOnSelect && json.name !== 'NATIVE_APP' && !resumed) { dv.hangOnSelect = false; park(); dv.queue = [() => phoneRequest(req, p, json, send, fail, true)]; return undefined; }
      dv.context = json.name;
      dv.selected = json.name === 'NATIVE_APP' ? null : json.name;
      dv.onSelect?.(json.name);
      return send(null);
    }
    if (p === '/screenshot') { dv.onScreenshot?.(); return send(dv.screenshot ?? PNG); }
    if (p === '/actions') return send(null);
    if (p === '/execute/sync') {
      const s = json.script;
      if (s.startsWith('mobile:')) {
        if (s === 'mobile: keys') {
          dv.keys++;
          const f = dv.pages[PAGE]?.field;
          if (f && f !== true) f.value = f.keyboard ? f.keyboard(json.args[0].keys[0], f.value) : f.value + json.args[0].keys[0];
          if (f && f !== true) fireFieldEvents(dv.pages[PAGE]);
        }
        if (s === 'mobile: tap') { // the keyboard's delete key (see deviceTree) takes the last character of a text field
          const f = dv.pages[PAGE]?.field;
          const at = json.args[0];
          if (f && f !== true && at?.x === 370 && at?.y === 810) {
            f.value = f.resetTo ?? Array.from(f.value).slice(0, -1).join(''); // resetTo: a field that rewrites itself after every key
            fireFieldEvents(dv.pages[PAGE]);
          }
        }
        dv.onNative?.(s);
        return send(s === 'mobile: source' ? deviceTree(dv) : s === 'mobile: isKeyboardShown' ? true : null);
      }
      if (!resumed) dv.beforeExecute?.(s);
      // A script held in the queue runs in the page it was sent to, wherever the context is when it is let go (the driver fixes the page at the start of the command).
      if (!resumed && dv.context === 'NATIVE_APP') return failure('invalid context', 'not in a web context', 400);
      // The plugin's execute guard: the page the driver holds is the one the client selected, or nothing runs.
      if (!resumed && dv.pinned && dv.context !== dv.selected) return failure('unknown error', 'msl-page-pin: the session is not on the selected page', 500);
      const page = dv.pages[resumed ? at : dv.context];
      if (!page) return failure('no such window', 'window gone');
      if (dv.hang === 'queue' && page.id === PAGE && !resumed) { park(); dv.queue = [() => phoneRequest(req, p, json, send, fail, true, page.id)]; return undefined; }
      page.runs++;
      dv.executed.push([page.id, s]);
      dv.onExecute?.(page);
      if (dv.hang && page.id === PAGE) { park(); return void setTimeout(() => send(null), 300); }
      if (dv.executeFails && page.id === PAGE) return failure(dv.executeFails, 'the script was refused', 500);
      let value;
      try { value = runPage(dv, page, s, json.args ?? []); } catch (e) {
        if (dv.hangOnThrow && page.id === PAGE) { park(); return void setTimeout(() => send(null), 300); }
        return failure('javascript error', e.message, 500);
      }
      if (dv.mapResult && page.id === PAGE) value = dv.mapResult(value, s);
      dv.results.push([s, value]);
      dv.afterExecute?.(page, s);
      const late = page.id === PAGE ? dv.delay?.(s) : 0;
      return late ? void setTimeout(() => send(value), late) : send(value);
    }
    return failure('unknown command', p);
  }
  const api = {
    fx,
    log,
    server,
    get dv() { return dv; },
    get port() { return server.address()?.port; },
    newPage: (id, href, extra) => newPage(dv, id, href, extra),
    // A page that appears: while the session is in a web view it becomes the current context (as the stock driver does; the pinned one only lists it).
    addPage: (id, href, extra) => {
      dv.pages[id] = newPage(dv, id, href, extra);
      if (!dv.pinned && dv.context.startsWith('WEBVIEW')) dv.context = id; // the pinned handler only lists it
      return dv.pages[id];
    },
    // `devicectl device process launch --payload-url <url>`: Safari opens the lab's tab on it.
    launch: url => {
      dv.tag = new URL(url).search.slice(1);
      dv.pages[PAGE] = newPage(dv, PAGE, url);
    },
    // The lab's tab shows again: the script that waited for it runs (nobody is listening for its answer any more)
    // and every request queued behind it is answered, in order.
    switchBack: () => {
      const held = dv.queue ?? [];
      dv.queue = null;
      dv.hang = false;
      for (const run of held) run();
    },
    // Starts over: the generic fields, the log and the phone.
    reset: () => {
      Object.assign(fx, { pin: true, up: true, webviews: ['WEBVIEW_1'], created: 0, createFails: false, createErrors: [], createDelayMs: 0, onCreate: undefined, onCreateRequest: undefined, settings: undefined, keyboard: undefined, keyboardFail: false, keyboardDelayMs: 0, keyboardIgnored: false });
      fx.sessions.clear();
      ctx.clear();
      log.length = 0;
      dv = deviceFresh();
    },
    listen: port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port ?? 0, '127.0.0.1', resolve); }),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
  return api;
}

// What may never happen on the phone, whatever the test did. `ps` is a phone-mode standin.
export function neverUnsafe(ps) {
  const { log, dv } = ps;
  assert.deepEqual(log.filter(([m, u]) => m === 'DELETE' && u.endsWith('/window')), [], 'DELETE /window');
  assert.deepEqual(log.filter(([m, u]) => m === 'POST' && /\/url$/.test(u)), [], 'POST /url');
  assert.deepEqual(log.filter(([m, u, b]) => m === 'POST' && u.endsWith('/context') && b.name === OTHER), [], 'the owner\'s tab was selected');
  assert.deepEqual(log.filter(([, u]) => u.endsWith('/se/log')), [], 'one of Safari\'s logs (every tab\'s) was read');
  assert.equal(dv.pages[OTHER].runs, 0, 'a script ran in the owner\'s tab');
  assert.equal(dv.pages[OTHER].driverRuns, 0, 'the driver ran something in the owner\'s tab');
  assert.equal(dv.pages[OTHER].win.name, 'owner-state');
}

// --- the signing lock (lib/signlock.js): a stand-in for sideload, holding the same flock ---

export const havePerl = fs.existsSync(PERL);

// Holds the lock in `dir` as sideload would, until `release()`. Resolves once it is held.
export function holdLock(dir) {
  const child = spawn(PERL, ['-e', HELPER, path.join(dir, LOCK_NAME)], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', c => { out += c; if (out.includes('locked\n')) resolve({ release: () => { child.stdin.end(); return closed; } }); });
    closed.then(code => reject(new Error(`the stand-in could not take the lock (exit ${code})`)));
  });
}

// holdLock for a place that can't wait (a runner reply, a hook): returns once the lock is held, polling for a file the stand-in
// makes after it has locked (a condition, never a fixed sleep). `release()` lets go and resolves when the stand-in has ended.
const HOLD_NOW = 'use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW); sysopen(F, $ARGV[0], O_RDWR|O_CREAT|O_NOFOLLOW, 0600) or exit 3; flock(F, LOCK_EX|LOCK_NB) or exit 75; open(R, ">", $ARGV[1]) or exit 4; close R; <STDIN>;';
export function holdLockNow(dir) {
  const ready = path.join(tempDir('msl-hold-'), 'ready');
  const child = spawn(PERL, ['-e', HOLD_NOW, path.join(dir, LOCK_NAME), ready], { stdio: ['pipe', 'ignore', 'inherit'] });
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  const end = Date.now() + 10e3;
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > end) throw new Error('the stand-in could not take the lock');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return { release: () => { child.stdin.end(); return closed; } };
}

// Whether the lock in `dir` is free right now: tries to take it, with stdin already closed so it lets go at once.
export const lockIsFree = dir => spawnSync(PERL, ['-e', HELPER, path.join(dir, LOCK_NAME)], { input: '', timeout: 10e3 }).status === 0;

// Runs `fn` with SIDELOAD_HOME (and MSL_SIGNLOCK) set, and puts both back.
export async function withSignLock({ home, off }, fn) {
  const was = { SIDELOAD_HOME: process.env.SIDELOAD_HOME, MSL_SIGNLOCK: process.env.MSL_SIGNLOCK };
  process.env.SIDELOAD_HOME = home;
  if (off) process.env.MSL_SIGNLOCK = off; else delete process.env.MSL_SIGNLOCK;
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// --- the phone's appearance and orientation: a stand-in for `devicectl device info appearance`, `settings appearance`,
// `orientation get` and `orientation set`, answering with the recorded shapes in test/fixtures/phone ---

export const PHONE = '00008000-000A1B2C3D4E5F60'; // the fake phone in the fixtures
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'phone');

// `ph.handle(cmd, args)` is a runner reply (undefined for anything else). `ph.style`, `ph.orientation` and `ph.nonFlat` are
// what the phone shows; `ph.rotationLock` makes `orientation set` succeed and change nothing (with the lock flag still false, as
// the phone does); `ph.error` ({ code, stderr }) fails every call (a locked or unreachable phone); `ph.ignoreSet` makes
// `settings appearance` succeed and change nothing. `ph.calls` has every devicectl argv; `ph.onSet(kind, value)` runs before a change is applied.
// Lab Focus (#16): `device process launch ... com.apple.shortcuts` is answered too: `ph.shortcuts` has the decoded name of each
// shortcut run (in order), `ph.focus` is 'on' or 'off' after the shortcut whose name ends "On" / "Off" (the phone's Focus), and
// `ph.launchError` ({ code, stderr }) fails the launch. `ph.locked` (true or false; left undefined the world answers lockState)
// answers `device info lockState`, and a shortcut launched while it is true is NOT run (iOS asks for the passcode) yet reports success.
export function displayPhone(init = {}) {
  const ph = { style: 'light', orientation: 'portrait', nonFlat: 'portrait', rotationLock: false, error: null, ignoreSet: false, calls: [], sets: [], onSet: null, shortcuts: [], focus: 'off', launchError: null, locked: undefined, ...init };
  const fixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  const UPRIGHT = ['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight'];
  ph.handle = (cmd, args) => {
    if (cmd !== 'xcrun' || args[0] !== 'devicectl') return undefined;
    const verb = args.slice(1, 4).join(' ');
    if (verb === 'device info lockState' && ph.locked !== undefined) {
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify(fixture(ph.locked ? 'lock-locked.json' : 'lock-unlocked.json')));
      ph.calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'device process launch' && args.includes('com.apple.shortcuts')) {
      ph.calls.push(args);
      if (args[args.indexOf('--device') + 1] !== PHONE) return { code: 1, stderr: 'no --device for the saved phone' };
      if (ph.launchError) return ph.launchError;
      if (ph.error) return ph.error;
      const url = new URL(args[args.indexOf('--payload-url') + 1]);
      const name = url.searchParams.get('name');
      ph.shortcuts.push(name);
      ph.onSet?.('focus', name);
      if (!ph.locked) ph.focus = /On$/.test(name) ? 'on' : 'off';
      return { code: 0, stdout: '', stderr: '' };
    }
    if (!['device info appearance', 'device settings appearance', 'device orientation get', 'device orientation set'].includes(verb)) return undefined;
    ph.calls.push(args);
    const out = args[args.indexOf('--json-output') + 1];
    if (args[args.indexOf('--device') + 1] !== PHONE) return { code: 1, stderr: 'no --device for the saved phone' };
    if (ph.error) return ph.error;
    if (verb === 'device info appearance') fs.writeFileSync(out, JSON.stringify(fixture(`appearance-info-${ph.style}.json`)));
    else if (verb === 'device settings appearance') {
      const mode = args[args.indexOf('--mode') + 1];
      ph.sets.push(['appearance', mode]);
      ph.onSet?.('appearance', mode);
      if (!ph.ignoreSet) ph.style = mode;
      fs.writeFileSync(out, JSON.stringify(fixture(`appearance-set-${ph.style}.json`)));
    } else if (verb === 'device orientation get') {
      const j = fixture('orientation-get-portrait.json');
      Object.assign(j.result, { deviceOrientation: ph.orientation, deviceOrientationNonFlat: ph.nonFlat });
      fs.writeFileSync(out, JSON.stringify(j));
    } else {
      const value = args[4];
      ph.sets.push(['orientation', value]);
      ph.onSet?.('orientation', value);
      if (!ph.rotationLock) { ph.orientation = value; if (UPRIGHT.includes(value)) ph.nonFlat = value; }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return ph;
}
