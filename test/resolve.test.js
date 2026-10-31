import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESOLVE, SELECT_COUNT, MEASURE, focusScript } from '../lib/safari.js';

// A hand-made DOM: just what RESOLVE, MEASURE and the focus script touch. Elements keep their
// own text; `innerText` is that plus the children's, as a browser lays it out.
const node = (tag, { text = '', id, kids = [] } = {}) => {
  const n = {
    tagName: tag.toUpperCase(), id, kids, parent: null, shadowRoot: null,
    get parentNode() { return n.parent; },
    get innerText() { return [text, ...n.kids.map(k => k.innerText)].filter(t => t !== '').join('\n'); },
    contains(o) { for (let c = o; c; c = c.parent) if (c === n) return true; return false; },
  };
  for (const k of kids) k.parent = n;
  return n;
};
const below = list => list.flatMap(n => [n, ...below(n.kids)]); // document order, light DOM only
const matches = (css, n) => css === '*' || css === n.tagName.toLowerCase() || css === `#${n.id}`;
// A document or a shadow root: querySelectorAll over its descendants (`body *`: under the body).
const scope = kids => ({
  kids,
  querySelectorAll(css) {
    if (css === 'body *') return below(kids.filter(k => k.tagName === 'BODY').flatMap(b => b.kids));
    return below(kids).filter(n => matches(css, n));
  },
  querySelector(css) { return this.querySelectorAll(css)[0] ?? null; },
});
const page = (...kids) => scope([node('body', { kids })]);
const shadowOf = (host, ...kids) => {
  const root = host.shadowRoot = scope(kids);
  root.host = host;
  for (const k of kids) k.parent = root; // a root has a host, not a parentNode
  return host;
};

const run = (doc, sel, expr = 'scanSel(arguments[1])') => new Function('document', 'sel', `${RESOLVE}\nreturn ${expr};`)(doc, sel);
const ids = (doc, sel) => run(doc, sel, 'all(arguments[1])').map(e => e.id);

test('a bare string is plain CSS, exactly as querySelector and querySelectorAll', () => {
  const doc = page(node('button', { id: 'a', text: 'x' }), node('button', { id: 'b', text: 'y' }));
  assert.deepEqual(ids(doc, 'button'), ['a', 'b']);
  assert.equal(run(doc, 'button', 'pick(arguments[1])').id, 'a');
  assert.equal(run(doc, 'nothing', 'pick(arguments[1])'), null);
});

test('text is innerText with whitespace collapsed and trimmed, exact unless contains', () => {
  const doc = page(node('button', { id: 'a', text: '  Continue \n\t now  ' }), node('button', { id: 'b', text: 'Continue' }));
  assert.deepEqual(ids(doc, { css: 'button', text: 'Continue now' }), ['a']);
  assert.deepEqual(ids(doc, { css: 'button', text: 'Continue' }), ['b']);
  assert.deepEqual(ids(doc, { css: 'button', text: 'Contin' }), []);
  assert.deepEqual(ids(doc, { css: 'button', text: 'Contin', contains: true }), ['a', 'b']);
  assert.deepEqual(ids(doc, { css: 'button', text: 'continue' }), [], 'case matters');
  const empty = page(node('button', { id: 'a' }));
  assert.deepEqual(ids(empty, { css: 'button', text: 'x', contains: true }), []);
});

test('the innermost element whose text matches is kept, not the ones around it', () => {
  const doc = page(node('div', { id: 'outer', kids: [node('section', { id: 'mid', kids: [node('span', { id: 'inner', text: 'OK' })] })] }), node('p', { id: 'sibling', text: 'OK' }));
  assert.deepEqual(ids(doc, { text: 'OK' }), ['inner', 'sibling']);
  // With CSS the candidates are only its matches, so a div that matches is not hidden by a span.
  assert.deepEqual(ids(doc, { css: 'div', text: 'OK' }), ['outer']);
  // A contains search keeps the innermost too.
  const two = page(node('div', { id: 'o', kids: [node('b', { id: 'i', text: 'Buy now' }), node('i', { id: 'j', text: 'later' })] }));
  assert.deepEqual(ids(two, { text: 'Buy', contains: true }), ['i']);
  assert.deepEqual(ids(two, { css: 'div', text: 'Buy now later' }), ['o'], 'the parent\'s own text is what it lays out');
});

test('without css the search covers body *; with css only that css', () => {
  const doc = page(node('a', { id: 'link', text: 'Go' }), node('button', { id: 'btn', text: 'Go' }));
  assert.deepEqual(ids(doc, { text: 'Go' }), ['link', 'btn']);
  assert.deepEqual(ids(doc, { css: 'button', text: 'Go' }), ['btn']);
  const head = scope([node('head', { kids: [node('title', { id: 'title', text: 'Go' })] }), node('body', { kids: [node('a', { id: 'link', text: 'Go' })] })]);
  assert.deepEqual(ids(head, { text: 'Go' }), ['link'], 'only what is under the body');
});

test('script, style, noscript and template are never matched', () => {
  const doc = page(...['script', 'style', 'noscript', 'template'].map(t => node(t, { id: t, text: 'OK' })), node('span', { id: 'real', text: 'OK' }));
  assert.deepEqual(ids(doc, { text: 'OK' }), ['real']);
  assert.deepEqual(ids(doc, { css: 'script', text: 'OK' }), []);
});

test('nth picks the 1-based match, and pick is null past the end', () => {
  const doc = page(...[1, 2, 3].map(n => node('li', { id: `li${n}`, text: 'Item' })));
  const at = nth => run(doc, { css: 'li', text: 'Item', nth }, 'pick(arguments[1])')?.id;
  assert.deepEqual([at(undefined), at(1), at(2), at(3), at(4)], ['li1', 'li1', 'li2', 'li3', undefined]);
  assert.equal(run(doc, { css: 'li', nth: 2 }, 'pick(arguments[1])').id, 'li2'); // nth without text: the CSS matches
});

test('more than 5000 candidates are not searched for text, and the count says so', () => {
  const many = n => page(...Array.from({ length: n }, (_, i) => node('span', { id: `s${i}`, text: i === 0 ? 'needle' : 'hay' })));
  const ok = run(many(5000), { text: 'needle' });
  assert.deepEqual([ok.over, ok.list.length], [0, 1]);
  const over = run(many(5001), { text: 'needle' });
  assert.deepEqual([over.over, over.list.length], [1, 0]);
  // CSS alone is not capped: nothing reads any text.
  assert.equal(run(many(6000), { css: 'span', nth: 2 }).list.length, 6000);
});

test('shadow: each host is searched in the roots of the one before, to any depth', () => {
  const deep = node('button', { id: 'deep', text: 'Go' });
  const inner = shadowOf(node('x-b', { id: 'hb' }), node('i', { text: 'noise' }), deep);
  const outer = shadowOf(node('x-a', { id: 'ha' }), inner);
  const doc = page(outer, node('button', { id: 'light', text: 'Go' }));
  assert.deepEqual(ids(doc, { shadow: ['x-a', 'x-b'], css: 'button' }), ['deep']);
  assert.deepEqual(ids(doc, { shadow: ['x-a', 'x-b'], css: '*', text: 'Go' }), ['deep'], '* inside a root, with text');
  assert.deepEqual(ids(doc, { shadow: ['x-a', 'x-b'], text: 'Go' }), ['deep'], 'no css: every element of the root');
  assert.deepEqual(ids(doc, { css: 'button', text: 'Go' }), ['light'], 'the light DOM does not see into roots');
  assert.deepEqual(ids(doc, { shadow: ['x-b'], css: 'button' }), [], 'x-b is not in the document, only in x-a\'s root');
  // Roots of several hosts are searched in the order the hosts come.
  const h1 = shadowOf(node('x-item'), node('button', { id: 'first' }));
  const h2 = shadowOf(node('x-item'), node('button', { id: 'second' }));
  assert.deepEqual(ids(page(h1, h2), { shadow: ['x-item'], css: 'button' }), ['first', 'second']);
  assert.equal(run(page(h1, h2), { shadow: ['x-item'], css: 'button', nth: 2 }, 'pick(arguments[1])').id, 'second');
});

test('shadow: a host with no open root, or no host at all, ends the chain and says where', () => {
  const doc = page(node('x-app'), shadowOf(node('x-ok'), node('button')));
  let r = run(doc, { shadow: ['x-app'], css: 'button' });
  assert.deepEqual([r.step, r.hosts, r.rooted, r.list.length], [0, 1, 0, 0]);
  r = run(doc, { shadow: ['x-ok', 'x-missing'], css: 'button' });
  assert.deepEqual([r.step, r.hosts, r.rooted], [1, 0, 0]);
  const mixed = page(node('x-item'), shadowOf(node('x-item'), node('button')));
  r = run(mixed, { shadow: ['x-item'], css: 'button' });
  assert.deepEqual([r.step, r.hosts, r.rooted], [0, 2, 1], 'one host without a root refuses the lot');
  assert.equal(run(doc, { shadow: ['x-ok'], css: 'button' }).step, -1);
});

test('the count script gives numbers and nothing the page holds', () => {
  const doc = page(shadowOf(node('x-a'), node('button', { id: 'secret-id', text: 'secret text' })));
  const r = new Function('document', 'args', `return (function () {${SELECT_COUNT}}).apply(null, args);`)(doc, [{ shadow: ['x-a'], css: 'button', text: 'secret text' }]);
  assert.deepEqual(r, { count: 1, hosts: 0, rooted: 0, step: -1, over: 0 });
});

// --- MEASURE: what a tap would hit ---

const measureOf = (el, doc) => new Function('document', 'window', 'el', MEASURE)(doc, { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }, el);
const withRect = n => Object.assign(n, { getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 20 }) });

test('a point inside a shadow root is not "covered" by its host, and a real cover is still caught', () => {
  const button = withRect(node('button'));
  const host = shadowOf(withRect(node('x-card')), button);
  host.shadowRoot.elementFromPoint = () => button;
  const doc = { elementFromPoint: () => host }; // the document sees only the host
  assert.equal(measureOf(button, doc).covered, null);
  // Something in the same root over the button.
  const overlay = node('div');
  host.shadowRoot.elementFromPoint = () => overlay;
  assert.equal(measureOf(button, doc).covered, 'div');
  // A light-DOM element over the host.
  assert.equal(measureOf(button, { elementFromPoint: () => overlay }).covered, 'div');
  assert.equal(measureOf(button, { elementFromPoint: () => null }).covered, '(nothing: off screen)');
  // The target is itself a host: the point lands on a node in its own root, which is not a cover.
  const inside = withRect(node('button'));
  const self = shadowOf(withRect(node('my-button')), inside);
  self.shadowRoot.elementFromPoint = () => inside;
  assert.equal(measureOf(self, { elementFromPoint: () => self }).covered, null);
  const deeper = shadowOf(node('x-inner'), withRect(node('span')));
  deeper.shadowRoot.elementFromPoint = () => deeper.shadowRoot.kids[0];
  const outerHost = shadowOf(withRect(node('x-outer')), deeper);
  outerHost.shadowRoot.elementFromPoint = () => deeper;
  assert.equal(measureOf(outerHost, { elementFromPoint: () => outerHost }).covered, null, 'any depth inside the target');
  const stranger = node('div');
  self.shadowRoot.elementFromPoint = () => stranger;
  assert.equal(measureOf(self, { elementFromPoint: () => self }).covered, 'div', 'a node outside the target is still a cover');
  // A root whose point lookup gives the host back does not loop.
  host.shadowRoot.elementFromPoint = () => host;
  assert.equal(measureOf(host, doc).covered, null);
  // Nested roots: the lookup goes down one root at a time.
  const target = withRect(node('button'));
  const mid = shadowOf(node('x-mid'), target);
  mid.shadowRoot.elementFromPoint = () => target;
  const top = shadowOf(node('x-top'), mid);
  top.shadowRoot.elementFromPoint = () => mid;
  assert.equal(measureOf(target, { elementFromPoint: () => top }).covered, null);
});

// --- the focus check ---

test('a field inside a shadow root has the focus when the active element is found through its host', () => {
  const field = Object.assign(node('input'), { type: 'text' });
  const host = shadowOf(node('x-field'), field);
  const doc = page(host);
  const check = active => new Function('document', 'args', `return (function () {${focusScript}}).apply(null, args);`)(Object.assign(doc, { activeElement: active }), [{ shadow: ['x-field'], css: 'input' }]);
  host.shadowRoot.activeElement = null;
  assert.equal(check(host), false, 'only the host is active: the field is not');
  host.shadowRoot.activeElement = field;
  assert.equal(check(host), true);
  assert.equal(check(null), false);
  // A host that is itself the field (contenteditable) has the focus when something in its root is active.
  const editable = shadowOf(Object.assign(node('x-editor'), { isContentEditable: true }), node('p'));
  editable.shadowRoot.activeElement = editable.shadowRoot.kids[0];
  const doc2 = page(editable);
  const focusOf = new Function('document', 'args', `return (function () {${focusScript}}).apply(null, args);`);
  assert.equal(focusOf(Object.assign(doc2, { activeElement: editable }), [{ css: 'x-editor', nth: 1 }]), true);
});
