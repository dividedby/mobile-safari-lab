import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT_SELECT, SETTLE_READ, MEASURE, WAIT_LIMITS, WAIT, parseWaitArgs, pollUntil } from '../lib/safari.js';

// --- parseWaitArgs: everything is refused before a session is asked anything ---

test('parseWaitArgs: the selector forms of click and tap, and the mode', () => {
  const p = argv => parseWaitArgs(argv);
  const d = { timeoutMs: 10000, quietMs: 500 };
  assert.deepEqual(p(['#cta']), { mode: 'present', sel: '#cta', ...d });
  assert.deepEqual(p(['#cta', '--visible']), { mode: 'visible', sel: '#cta', ...d });
  assert.deepEqual(p(['--gone', '.spinner']), { mode: 'gone', sel: '.spinner', ...d });
  assert.deepEqual(p(['button', '--text', 'Go', '--contains', '--nth', '2', '--visible', '--timeout', '2500']), { mode: 'visible', sel: { css: 'button', text: 'Go', contains: true, nth: 2 }, timeoutMs: 2500, quietMs: 500 });
  assert.deepEqual(p(['--text', 'Done']), { mode: 'present', sel: { text: 'Done' }, ...d });
  assert.deepEqual(p(['--shadow', 'x-app', 'button', '--gone']).sel, { css: 'button', shadow: ['x-app'] });
  assert.deepEqual(p(['--', '--odd']).sel, '--odd', 'after -- everything is a selector');
  assert.deepEqual(p(['--settled']), { mode: 'settled', sel: undefined, ...d });
  assert.deepEqual(p(['--settled', '--quiet', '100', '--timeout', '101']), { mode: 'settled', sel: undefined, timeoutMs: 101, quietMs: 100 });
  assert.deepEqual(p(['a', '--timeout', '100']).timeoutMs, 100);
  assert.deepEqual(p(['a', '--timeout', '60000']).timeoutMs, 60000);
  assert.deepEqual(p(['--settled', '--quiet', '10000', '--timeout', '60000']).quietMs, 10000);
});

test('parseWaitArgs: every rule that refuses', () => {
  const bad = (argv, re) => assert.throws(() => parseWaitArgs(argv), e => re.test(e.message) && /usage: safari wait/.test(e.message), JSON.stringify(argv));
  bad([], /needs a css selector, --text or --settled/);
  bad(['--visible'], /needs a css selector, --text or --settled/);
  bad(['--timeout', '500'], /needs a css selector, --text or --settled/);
  bad(['a', '--visible', '--gone'], /--visible and --gone exclude each other/);
  bad(['--settled', 'a'], /--settled stands alone/);
  bad(['--settled', '--text', 'x'], /--settled stands alone/);
  bad(['--settled', '--visible'], /--settled stands alone/);
  bad(['--settled', '--gone'], /--settled stands alone/);
  bad(['a', '--quiet', '200'], /--quiet goes with --settled/);
  bad(['a', '--label', 'Share'], /--label is not supported/);
  bad(['--label', 'Share', '--settled'], /--label is not supported/);
  bad(['--nth', '2'], /--nth needs a css selector or --text/);
  for (const t of ['99', '60001', '1.5', 'x', '', '-1', '1e3', ' 200']) bad(['a', '--timeout', t], /--timeout must be a whole number of milliseconds from 100 to 60000/);
  for (const q of ['99', '10001', 'x', '']) bad(['--settled', '--quiet', q], /--quiet must be a whole number of milliseconds from 100 to 10000/);
  bad(['a', '--timeout'], /--timeout needs a value/);
  bad(['a', '--timeout', '200', '--timeout', '300'], /--timeout was given twice/);
  bad(['--settled', '--quiet', '500', '--timeout', '500'], /--quiet \(500 ms\) must be less than --timeout \(500 ms\)/);
  bad(['--settled', '--quiet', '10000'], /--quiet \(10000 ms\) must be less than --timeout \(10000 ms\)/);
  bad(['a', 'b'], /one selector only/);
  bad(['a', '--bogus'], /unknown flag --bogus/);
  // A --label that is a flag's value, or after --, is not the flag.
  assert.equal(parseWaitArgs(['--text', '--label']).sel.text, '--label');
  assert.equal(parseWaitArgs(['--', '--label']).sel, '--label');
});

// --- WAIT_SELECT on hand-made DOMs ---

const node = (tag, { text = '', id, kids = [], style = {}, rect = { left: 10, top: 20, width: 40, height: 20 } } = {}) => {
  const n = {
    tagName: tag.toUpperCase(), id, kids, parent: null, shadowRoot: null, style, rect,
    get parentNode() { return n.parent; },
    get innerText() { return [text, ...n.kids.map(k => k.innerText)].filter(t => t !== '').join('\n'); },
    contains(o) { for (let c = o; c; c = c.parent) if (c === n) return true; return false; },
    getBoundingClientRect: () => n.rect,
  };
  for (const k of kids) k.parent = n;
  return n;
};
const below = list => list.flatMap(n => [n, ...below(n.kids)]);
const matches = (css, n) => css === '*' || css === n.tagName.toLowerCase() || css === `#${n.id}`;
const scope = kids => ({
  kids,
  querySelectorAll(css) {
    if (css === 'body *') return below(kids.filter(k => k.tagName === 'BODY').flatMap(b => b.kids));
    return below(kids).filter(n => matches(css, n));
  },
});
const page = (...kids) => {
  const doc = scope([node('body', { kids })]);
  doc.elementFromPoint = (x, y) => below(doc.kids).find(n => n.rect && x >= n.rect.left && x <= n.rect.left + n.rect.width && y >= n.rect.top && y <= n.rect.top + n.rect.height && n.tagName !== 'BODY') ?? null;
  return doc;
};
const shadowOf = (host, ...kids) => {
  host.shadowRoot = scope(kids);
  for (const k of kids) k.parent = host.shadowRoot;
  return host;
};
const win = { getComputedStyle: e => ({ display: 'block', visibility: 'visible', opacity: '1', ...e.style }) };
const select = (doc, sel) => new Function('document', 'window', 'args', `return (function () {${WAIT_SELECT}}).apply(null, args);`)(doc, win, [sel]);
const li = (n, opts) => node('li', { id: `li${n}`, text: 'Item', ...opts });

test('WAIT_SELECT counts the matches and the ones that are rendered, as numbers', () => {
  const doc = page(li(1), li(2, { style: { display: 'none' } }), li(3));
  assert.deepEqual(select(doc, 'li'), { count: 3, present: 3, visible: 2, hosts: 0, rooted: 0, step: -1, over: 0 });
  assert.deepEqual(select(doc, 'nothing'), { count: 0, present: 0, visible: 0, hosts: 0, rooted: 0, step: -1, over: 0 });
  assert.deepEqual(select(doc, { css: 'li', text: 'Item' }), { count: 3, present: 3, visible: 2, hosts: 0, rooted: 0, step: -1, over: 0 });
  for (const v of Object.values(select(doc, 'li'))) assert.ok(Number.isInteger(v));
});

test('WAIT_SELECT with --nth looks at that element only', () => {
  const doc = page(li(1), li(2, { style: { visibility: 'hidden' } }), li(3));
  assert.deepEqual(select(doc, { css: 'li', nth: 1 }), { count: 3, present: 1, visible: 1, hosts: 0, rooted: 0, step: -1, over: 0 });
  assert.deepEqual([select(doc, { css: 'li', nth: 2 }).present, select(doc, { css: 'li', nth: 2 }).visible], [1, 0]);
  const past = select(doc, { css: 'li', nth: 4 });
  assert.deepEqual([past.count, past.present, past.visible], [3, 0, 0], 'there is no fourth: nothing to see');
});

test('WAIT_SELECT is hidden for the same four reasons MEASURE gives, and for no other', () => {
  const cases = {
    'display none': { style: { display: 'none' } },
    'visibility hidden': { style: { visibility: 'hidden' } },
    'opacity 0': { style: { opacity: '0' } },
    '1x1 px': { rect: { left: 0, top: 0, width: 1, height: 1 } },
  };
  const measure = (el, doc) => new Function('document', 'window', 'el', MEASURE)(doc, win, el);
  for (const [why, opts] of Object.entries(cases)) {
    const el = node('div', { id: 'x', ...opts });
    const doc = page(el);
    assert.match(measure(el, doc).hidden, /^hidden \(/, why);
    assert.equal(select(doc, '#x').visible, 0, why);
  }
  // Covered and off screen are rendered; so is an ancestor's opacity 0, which MEASURE does not see either.
  const off = node('div', { id: 'x', rect: { left: -500, top: -500, width: 40, height: 20 } });
  assert.equal(measure(off, page(off)).hidden, null);
  assert.equal(select(page(off), '#x').visible, 1);
  const inner = node('span', { id: 'x' });
  const doc = page(node('div', { style: { opacity: '0' }, kids: [inner] }));
  assert.equal(measure(inner, doc).hidden, null);
  assert.equal(select(doc, '#x').visible, 1);
  assert.equal(select(page(node('div', { id: 'x', rect: { left: 0, top: 0, width: 2, height: 2 } })), '#x').visible, 1, '2x2 px is rendered');
});

test('WAIT_SELECT measures at most the first 50 matches', () => {
  const hiddenFirst = Array.from({ length: 60 }, (_, i) => li(i, i < 50 ? { style: { display: 'none' } } : {}));
  const r = select(page(...hiddenFirst), 'li');
  assert.deepEqual([r.count, r.present, r.visible], [60, 50, 0]);
  assert.equal(WAIT_LIMITS.measureCap, 50);
});

test('WAIT_SELECT with 51 matches measures 50, so the count tells --gone it did not see them all', () => {
  const doc = page(...Array.from({ length: 51 }, (_, i) => li(i, i < 50 ? { style: { display: 'none' } } : {})));
  const r = select(doc, 'li');
  assert.deepEqual([r.count, r.present, r.visible], [51, 50, 0], 'the 51st, visible, is past the cap');
  assert.deepEqual(select(doc, { css: 'li', nth: 51 }).visible, 1, 'with --nth that element is the one measured');
});

test('WAIT_SELECT reports a shadow chain that ends early, and a search that is too large', () => {
  const doc = page(node('x-app'), shadowOf(node('x-ok'), node('button', { id: 'b' })));
  let r = select(doc, { shadow: ['x-app'], css: 'button' });
  assert.deepEqual([r.count, r.present, r.visible, r.step, r.hosts, r.rooted], [0, 0, 0, 0, 1, 0], 'a host with no open root');
  r = select(doc, { shadow: ['x-ok', 'x-missing'], css: 'button' });
  assert.deepEqual([r.step, r.hosts], [1, 0], 'no such host');
  r = select(doc, { shadow: ['x-ok'], css: 'button' });
  assert.deepEqual([r.count, r.visible, r.step], [1, 1, -1]);
  const many = page(...Array.from({ length: 5001 }, (_, i) => node('span', { text: i ? 'hay' : 'needle' })));
  r = select(many, { text: 'needle' });
  assert.deepEqual([r.over, r.count, r.present], [1, 0, 0]);
});

test('WAIT_SELECT returns nothing the page holds', () => {
  const doc = page(node('p', { id: 'secret-id', text: 'secret text' }));
  assert.deepEqual(select(doc, { text: 'secret text' }), { count: 1, present: 1, visible: 1, hosts: 0, rooted: 0, step: -1, over: 0 });
});

// --- SETTLE_READ on a fake window ---

function fakePage({ images = [], fonts, scroll = { w: 414, h: 900 }, noMutation = false, noResources = false } = {}) {
  const st = { t: 1000, mutation: [], resource: [], scroll: { ...scroll }, images, fonts };
  const doc = {
    readyState: 'complete', documentElement: {}, get images() { return st.images; }, get fonts() { return st.fonts; },
    scrollingElement: { get scrollWidth() { return st.scroll.w; }, get scrollHeight() { return st.scroll.h; } },
  };
  const window = { innerWidth: 414, innerHeight: 750 };
  class MO { constructor(cb) { this.cb = cb; } observe() { if (noMutation) throw new TypeError('x'); st.mutation.push(this.cb); } }
  class PO { constructor(cb) { this.cb = cb; } observe(o) { if (noResources || o.type !== 'resource' || o.buffered) throw new TypeError('x'); st.resource.push(this.cb); } }
  const performance = { now: () => st.t };
  const read = () => new Function('window', 'document', 'performance', 'MutationObserver', 'PerformanceObserver', `return (function () {${SETTLE_READ}})();`)(window, doc, performance, MO, PO);
  return { st, doc, window, read };
}

test('SETTLE_READ installs on the first call and counts what happens after it', () => {
  const p = fakePage();
  const first = p.read();
  assert.deepEqual(first, { complete: true, pendingImages: 0, skippedImages: 0, fontsLoading: false, idleMs: 0, watchedMs: 0, resources: 0, mutations: 0, sizeChanges: 0, observing: true, resourcesWatched: true });
  p.st.t += 300;
  assert.deepEqual([p.read().idleMs, p.read().watchedMs], [300, 300]);
  p.st.t += 100;
  for (const cb of p.st.mutation) { cb([{}]); cb([{}]); } // two DOM changes at t=1400
  p.st.t += 50;
  for (const cb of p.st.resource) cb({ getEntries: () => [{}, {}, {}] });
  p.st.t += 70;
  const r = p.read();
  assert.deepEqual([r.mutations, r.resources, r.idleMs, r.watchedMs], [2, 3, 70, 520]);
  assert.equal(p.window.__mslSettle.start, 1000, 'the state is kept on the window; a new document would drop it');
});

test('SETTLE_READ counts a change of the scroll size at the read that sees it', () => {
  const p = fakePage();
  p.read();
  p.st.t += 400;
  p.st.scroll.h = 1500;
  let r = p.read();
  assert.deepEqual([r.sizeChanges, r.idleMs], [1, 0]);
  p.st.t += 200;
  r = p.read();
  assert.deepEqual([r.sizeChanges, r.idleMs], [1, 200], 'the same size is no change');
});

test('SETTLE_READ reports unfinished images, fonts and the document, and every value is a number or a boolean', () => {
  const lazyFar = { complete: false, loading: 'lazy', getBoundingClientRect: () => ({ top: 4000, bottom: 4100, left: 0, right: 100 }) };
  const lazyNear = { complete: false, loading: 'lazy', getBoundingClientRect: () => ({ top: 100, bottom: 200, left: 0, right: 100 }) };
  const p = fakePage({ images: [{ complete: true }, { complete: false }, lazyFar, lazyNear], fonts: { status: 'loading' } });
  p.doc.readyState = 'interactive';
  const r = p.read();
  assert.deepEqual([r.complete, r.pendingImages, r.fontsLoading], [false, 2, true], 'a lazy image far from the screen is not waited for');
  for (const [k, v] of Object.entries(r)) assert.ok(typeof v === 'boolean' || Number.isInteger(v), `${k}: ${v}`);
  p.st.images = [];
  p.st.fonts = { status: 'loaded' };
  p.doc.readyState = 'complete';
  assert.deepEqual([p.read().pendingImages, p.read().fontsLoading], [0, false]);
});

test('SETTLE_READ does not wait for images that have no box or are far off screen, and counts them apart', () => {
  const box = (top, bottom, left = 0, right = 100) => ({ top, bottom, left, right });
  const img = (extra, rect) => ({ complete: false, getBoundingClientRect: () => rect, getClientRects: () => [rect], ...extra });
  const shown = img({}, box(100, 200));
  const hiddenLazy = img({ loading: 'lazy' }, box(0, 0, 0, 0)); // display: none measures 0 x 0 at (0, 0): not far from the screen, but not rendered
  const hiddenEager = img({ getClientRects: () => [] }, box(0, 0, 0, 0));
  const zeroEager = img({}, box(100, 100, 0, 0)); // 0 x 0 with a rect, as a picture without width and height until its headers arrive: still loading
  const zeroLazy = img({ loading: 'lazy' }, box(100, 100, 0, 0)); // a lazy one with no size has not started
  const invisible = img({ checkVisibility: () => false }, box(100, 200)); // content-visibility or a hidden ancestor
  const lazyFar = img({ loading: 'lazy' }, box(4000, 4100));
  const lazyBelow = img({ loading: 'lazy' }, box(751, 851));
  const lazyNear = img({ loading: 'lazy' }, box(100, 200));
  const eagerFar = img({}, box(4000, 4100)); // not lazy: it is loading anyway
  const oldSafari = img({ checkVisibility: undefined }, box(100, 200));
  const p = fakePage({ images: [{ complete: true }, shown, hiddenLazy, hiddenEager, zeroEager, zeroLazy, invisible, lazyFar, lazyBelow, lazyNear, eagerFar, oldSafari] });
  const r = p.read();
  assert.deepEqual([r.pendingImages, r.skippedImages], [5, 6]);
  for (const [k, v] of Object.entries(r)) assert.ok(typeof v === 'boolean' || Number.isInteger(v), `${k}: ${v}`);
  p.st.images = [hiddenLazy, lazyFar];
  assert.deepEqual([p.read().pendingImages, p.read().skippedImages], [0, 2], 'a page of only skipped images can settle');
  p.st.images = [{ complete: false }, { complete: false, loading: 'lazy' }];
  assert.deepEqual([p.read().pendingImages, p.read().skippedImages], [1, 1], 'an image that cannot be measured is waited for unless it is lazy');
});

test('SETTLE_READ without an observer still watches the rest, and says what it could not', () => {
  const p = fakePage({ noResources: true });
  const r = p.read();
  assert.deepEqual([r.resourcesWatched, r.observing], [false, true]);
  const q = fakePage({ noMutation: true, noResources: true }).read();
  assert.deepEqual([q.resourcesWatched, q.observing], [false, false]);
});

// --- pollUntil ---

test('pollUntil asks until the answer holds, with a bounded number of asks, and reports the last', async () => {
  const saved = WAIT.waitPollMs;
  let n = 0;
  const hit = await pollUntil(async () => ++n, x => x >= 3, { timeoutMs: 1000, pollMs: 2 });
  assert.deepEqual([hit.done, hit.polls, hit.last], [true, 3, 3]);
  assert.ok(hit.elapsedMs >= 3 && hit.elapsedMs < 1000);
  n = 0;
  const t = Date.now();
  const miss = await pollUntil(async () => ++n, () => false, { timeoutMs: 40, pollMs: 10 });
  assert.equal(miss.done, false);
  assert.equal(miss.last, miss.polls);
  assert.ok(miss.polls >= 2 && miss.polls <= 6, `polls ${miss.polls}`);
  assert.ok(miss.elapsedMs >= 40 && Date.now() - t < 500);
  const first = await pollUntil(async () => 'yes', () => true, { timeoutMs: 1, pollMs: 1000 });
  assert.deepEqual([first.done, first.polls], [true, 1], 'an answer that already holds does not wait');
  await assert.rejects(pollUntil(async () => { throw new Error('tab'); }, () => true, { timeoutMs: 100, pollMs: 1 }), /tab/);
  assert.equal(WAIT.waitPollMs, saved);
});

test('the poll intervals and limits are what the lab promises', () => {
  assert.deepEqual([WAIT.waitPollMs, WAIT.waitPollDeviceMs], [250, 500]);
  assert.deepEqual(WAIT_LIMITS, { timeoutDefault: 10000, timeoutMin: 100, timeoutMax: 60000, quietDefault: 500, quietMin: 100, quietMax: 10000, measureCap: 50 });
});
