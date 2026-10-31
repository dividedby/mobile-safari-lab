import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNodes, xmlText, isChrome, isProbe, isDeleteKey, isApplication, webViewSubtree } from '../lib/ui-tree.js';

const node = (type, label, x, y, width, height) => ({ type, label, x, y, width, height });

test('parseNodes reads type, label and rectangle whatever the attribute order', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<XCUIElementTypeApplication type="XCUIElementTypeApplication" label="Safari" x="0" y="0" width="440" height="956" visible="true">'
    + '<XCUIElementTypeButton height="44" width="60.5" y="12" x="8" label="Reload"/></XCUIElementTypeApplication>';
  assert.deepEqual(parseNodes(xml), [
    node('XCUIElementTypeApplication', 'Safari', 0, 0, 440, 956),
    node('XCUIElementTypeButton', 'Reload', 8, 12, 60.5, 44),
  ]);
});

test('parseNodes handles nesting, self-closing tags and closing tags', () => {
  const xml = '<A x="1" y="2" width="3" height="4"><B label="b" x="1" y="1" width="1" height="1"></B><C x="5" y="6" width="7" height="8" /></A>';
  assert.deepEqual(parseNodes(xml).map(n => n.type), ['A', 'B', 'C']);
  assert.deepEqual(parseNodes(xml)[2], node('C', '', 5, 6, 7, 8));
});

test('parseNodes decodes entities in labels, in one pass', () => {
  const [n] = parseNodes('<T label="Reload &amp; stop &lt;3 &quot;q&quot; &apos;a&apos; &#65;&#x42; &amp;lt; &gt;" x="0" y="0" width="1" height="1"/>');
  assert.equal(n.label, 'Reload & stop <3 "q" \'a\' AB &lt; >');
});

test('parseNodes does not end a tag at a > inside an attribute value', () => {
  const nodes = parseNodes('<T label="a > b" x="1" y="2" width="3" height="4"/><U label="after" x="5" y="6" width="7" height="8"/>');
  assert.deepEqual(nodes.map(n => [n.type, n.label]), [['T', 'a > b'], ['U', 'after']]);
  assert.equal(nodes[0].width, 3);
});

test('parseNodes gives NaN for a missing or unparseable number, never 0', () => {
  const [a, b] = parseNodes('<T label="a" x="oops" y="" width="3"/><U x="1" y="2" width="3" height="4"/>');
  assert.ok([a.x, a.y, a.height].every(Number.isNaN));
  assert.equal(a.width, 3);
  assert.deepEqual(b, node('U', '', 1, 2, 3, 4));
});

test('parseNodes finds nothing in text without elements, and tolerates an unterminated tag', () => {
  assert.deepEqual(parseNodes(''), []);
  assert.deepEqual(parseNodes('no tags here'), []);
  assert.deepEqual(parseNodes('<T label="open'), []);
});

test('xmlText leaves a reference that is not a code point as written', () => {
  assert.equal(xmlText('&#99999999;&#xZZ;&amp;'), '&#99999999;&#xZZ;&');
});

test('the application node is found by type, and a tree without one has none', () => {
  const nodes = parseNodes('<XCUIElementTypeApplication x="0" y="0" width="440" height="956"><XCUIElementTypeWindow x="0" y="0" width="440" height="956"/></XCUIElementTypeApplication>');
  assert.deepEqual(nodes.filter(isApplication).map(n => n.width), [440]);
  assert.deepEqual(parseNodes('<XCUIElementTypeWindow/>').filter(isApplication), []);
});

test('chrome is Safari\'s toolbars, bars and address field, not a page field', () => {
  const yes = [node('XCUIElementTypeToolbar', ''), node('XCUIElementTypeNavigationBar', ''), node('XCUIElementTypeTabBar', ''),
    node('XCUIElementTypeStaticText', 'TabBarItemTitle'), node('XCUIElementTypeTextField', 'Address')];
  const no = [node('XCUIElementTypeTextField', ''), node('XCUIElementTypeTextField', 'Email'), node('XCUIElementTypeButton', 'Reload'), node('XCUIElementTypeKey', 'delete')];
  assert.ok(yes.every(isChrome));
  assert.ok(!no.some(isChrome));
});

test('the probe is the node with its label, and the delete key is the key labelled delete in any case', () => {
  assert.ok(isProbe(node('XCUIElementTypeImage', 'msl-probe-ab'), 'msl-probe-ab'));
  assert.ok(!isProbe(node('XCUIElementTypeImage', 'msl-probe-abc'), 'msl-probe-ab'));
  assert.ok(isDeleteKey(node('XCUIElementTypeKey', 'delete')));
  assert.ok(isDeleteKey(node('XCUIElementTypeKey', 'Delete')));
  assert.ok(!isDeleteKey(node('XCUIElementTypeButton', 'delete')));
  assert.ok(!isDeleteKey(node('XCUIElementTypeKey', 'return')));
});

test('parseNodes refuses a Safari element it cannot read instead of dropping it', () => {
  const bad = [
    '<XCUIElementTypeToolbar label=\'q\' x="0" y="0" width="1" height="1"/>', // single quotes
    '<XCUIElementTypeTextField label="Address" x="0" y=0 width="1" height="1"/>', // an unquoted value
    '<XCUIElementTypeTabBar label="a" x="0"', // cut off
  ];
  for (const xml of bad) {
    assert.throws(() => parseNodes(`<XCUIElementTypeApplication x="0" y="0" width="1" height="1">${xml}</XCUIElementTypeApplication>`),
      /^Error: couldn't read Safari's native tree \(malformed element near "<XCUIElementType/);
  }
});

test('the malformed-element error is short and carries no attribute values', () => {
  const xml = '<XCUIElementTypeStaticText label=\'my secret text\' name="also secret" value=hidden x="0" y="0" width="1" height="1"/>';
  assert.throws(() => parseNodes(xml), err => {
    assert.ok(!/secret|hidden|my /.test(err.message), err.message);
    assert.ok(err.message.length < 140, err.message);
    return true;
  });
  assert.throws(() => parseNodes(`<XCUIElementTypeStaticText label='${'x'.repeat(500)}'/>`), err => err.message.length < 140);
});

test('parseNodes takes an element-looking string inside a value as text, and ignores other malformed tags', () => {
  const nodes = parseNodes('<XCUIElementTypeStaticText label="see &lt;XCUIElementTypeToolbar&gt; and <XCUIElementTypeX y=0>" x="0" y="0" width="1" height="1"/><Other a=1>');
  assert.deepEqual(nodes.map(n => n.type), ['XCUIElementTypeStaticText']);
});

test('webViewSubtree cuts out the one web view with everything under it, and nothing around it', () => {
  const xml = '<?xml version="1.0"?>\n<XCUIElementTypeApplication label="Safari" x="0" y="0" width="1" height="1">'
    + '<XCUIElementTypeWebView x="0" y="0" width="1" height="1"><XCUIElementTypeOther label="a > b"><XCUIElementTypeStaticText label="Page text"/></XCUIElementTypeOther><XCUIElementTypeImage label="p"/></XCUIElementTypeWebView>'
    + '<XCUIElementTypeTabBar><XCUIElementTypeButton label="TabBarItemTitle" value="Owner\'s other tab"/></XCUIElementTypeTabBar></XCUIElementTypeApplication>';
  assert.equal(webViewSubtree(xml), '<XCUIElementTypeWebView x="0" y="0" width="1" height="1"><XCUIElementTypeOther label="a > b"><XCUIElementTypeStaticText label="Page text"/></XCUIElementTypeOther><XCUIElementTypeImage label="p"/></XCUIElementTypeWebView>');
  assert.equal(webViewSubtree('<A><XCUIElementTypeWebView label="x"/><B/></A>'), '<XCUIElementTypeWebView label="x"/>');
});

test('webViewSubtree refuses a tree with no web view, several, or one it cannot cut out whole, without quoting the tree', () => {
  const secret = 'Owner inbox';
  for (const xml of [
    `<A><B label="${secret}"/></A>`,
    `<A><XCUIElementTypeWebView/><XCUIElementTypeWebView label="${secret}"></XCUIElementTypeWebView></A>`, // two siblings
    `<A><XCUIElementTypeWebView label="${secret}"><B/></XCUIElementTypeWebView><C><XCUIElementTypeWebView/></C></A>`, // disjoint
    `<A><XCUIElementTypeWebView label='${secret}'></A>`, // single-quoted attribute: not readable
    `<A><XCUIElementTypeWebView label="${secret}"><B></A>`, // never closed
  ]) {
    assert.throws(() => webViewSubtree(xml), e => { assert.match(e.message, /web views?/); assert.doesNotMatch(e.message, new RegExp(secret)); return true; });
  }
});

test('webViewSubtree takes the outermost of nested web views, with the tab bar left out', () => {
  const inner = '<XCUIElementTypeWebView x="0" y="0" width="1" height="1"><XCUIElementTypeWebView x="0" y="0" width="1" height="1"><XCUIElementTypeWebView x="0" y="0" width="1" height="1"><XCUIElementTypeStaticText label="Page text"/></XCUIElementTypeWebView></XCUIElementTypeWebView></XCUIElementTypeWebView>';
  const xml = `<XCUIElementTypeApplication><XCUIElementTypeOther>${inner}</XCUIElementTypeOther><XCUIElementTypeButton label="TabBarItemTitle" value="Owner's other tab"/></XCUIElementTypeApplication>`;
  const out = webViewSubtree(xml);
  assert.equal(out, inner);
  assert.doesNotMatch(out, /TabBarItemTitle|other tab/);
  assert.equal(webViewSubtree('<A><XCUIElementTypeWebView><XCUIElementTypeWebView/></XCUIElementTypeWebView></A>'), '<XCUIElementTypeWebView><XCUIElementTypeWebView/></XCUIElementTypeWebView>');
});
