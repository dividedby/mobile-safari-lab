import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandbox } from './helpers.js';
import { loadState, saveState } from '../lib/core.js';
import { handlers as safari, failureArtifacts, asScript, userscriptMeta, classifyKey, parseSelectorArgs, describeSel } from '../lib/safari.js';

const U = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
const D = '00008110-001A2B3C4D5E801E';

// The safaridriver backend is gone (the simulator goes through Appium: appium.test.js). What
// is left is the cleanup of a session an older version recorded, so this stand-in only
// records requests and accepts a session delete.
let server, log, dir;
before(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      log.push([req.method, req.url]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.MSL_SAFARIDRIVER_URL = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); delete process.env.MSL_SAFARIDRIVER_URL; });
beforeEach(() => {
  dir = sandbox(); log = [];
  saveState({ udid: U, session: 'S1', backend: 'safaridriver', port: server.address().port, target: { device: D } });
});

const LEGACY = /legacy safaridriver session: run `safari stop`/;

test('start --device with no saved phone needs setup, before anything is contacted', async () => {
  saveState({ session: null, backend: null, target: null });
  await assert.rejects(safari.start(['--device', D]), err => {
    assert.match(err.message, /--device needs a saved phone/);
    assert.equal(err.extra.needs, 'setup');
    assert.match(err.extra.then, /^lab phone setup /);
    return true;
  });
  assert.equal(log.length, 0);
});

test('every command but stop refuses a legacy safaridriver session and sends nothing', async () => {
  const file = path.join(dir, 'x.user.js');
  fs.writeFileSync(file, '(() => {})();\n');
  const calls = {
    start: [], open: ['https://example.com/'], refresh: [], eval: ['1'], inject: [file], click: ['a'], type: ['a', 'b'],
    tap: ['a'], wait: ['a'], keys: ['x'], swipe: ['up'], ui: [], source: [], shot: [], console: [], network: [], url: [],
  };
  for (const [name, args] of Object.entries(calls)) {
    await assert.rejects(safari[name](args), LEGACY, name);
  }
  assert.equal(log.length, 0);
  assert.equal(loadState().session, 'S1'); // nothing was touched
});

test('a failed command on a legacy session leaves no artifacts request either', async () => {
  assert.deepEqual(await failureArtifacts('eval', new Error('x')), {});
  assert.equal(log.length, 0);
});

test('stop ends a legacy safaridriver session and clears it', async () => {
  assert.deepEqual(await safari.stop(), { stopped: true });
  assert.deepEqual(log, [['DELETE', '/session/S1']]);
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().backend, undefined);
  assert.equal(loadState().udid, U);
});

test('asScript returns bare expressions and passes statements through', () => {
  assert.equal(asScript('document.title'), 'return (document.title\n);');
  assert.equal(asScript('return 5'), 'return 5');
  assert.equal(asScript('const a = 1; a'), 'const a = 1; a');
  assert.equal(asScript('x // note'), 'return (x // note\n);');
  // An expression that itself contains `return` (an IIFE) is still an expression.
  assert.equal(asScript('(()=>{const x=1;return x})()'), 'return ((()=>{const x=1;return x})()\n);');
  assert.equal(asScript('(function () { return 7; })()'), 'return ((function () { return 7; })()\n);');
  assert.equal(asScript('return 5;'), 'return 5;');
  assert.equal(asScript('if (a) { return 1 } return 2'), 'if (a) { return 1 } return 2');
  assert.equal(new Function(asScript('(()=>{const x=1;return x})()'))(), 1);
});

test('userscriptMeta reads the header and tolerates its absence', () => {
  assert.deepEqual(userscriptMeta('// ==UserScript==\n// @name        Demo Script\n// @version     1.2.3\n// ==/UserScript==\n'), { name: 'Demo Script', version: '1.2.3' });
  assert.deepEqual(userscriptMeta('no header'), { name: '', version: '' });
});

test('classifyKey sorts a character by what the field looked like before it', () => {
  const f = over => ({ len: 3, max: -1, collapsed: true, pos: 3, same: true, ...over });
  const cases = [
    ['\n', null, 'return'],
    ['a', null, 'unusable'],
    ['a', f({ same: false }), 'unusable'],
    ['a', f({ max: 3 }), 'inert'],
    ['\b', f({ len: 0, pos: 0 }), 'inert'],
    ['\b', f({ pos: 0 }), 'inert'],
    ['a', f({ collapsed: false }), 'selection'],
    ['a', f(), 'normal'],
    ['\b', f(), 'normal'],
    ['\b', f({ max: 3, collapsed: false }), 'normal'],
  ];
  for (const [ch, before, want] of cases) assert.equal(classifyKey(ch, before), want, `${JSON.stringify(ch)} over ${JSON.stringify(before)}`);
});

test('parseSelectorArgs: plain CSS stays a bare string; anything else is a descriptor', () => {
  const p = (argv, opts = {}) => parseSelectorArgs(argv, { name: 'click', ...opts });
  assert.deepEqual(p(['button.go']), { sel: 'button.go' });
  assert.deepEqual(p(['button', '--text', '  Continue \n now ']), { sel: { css: 'button', text: 'Continue now' } });
  assert.deepEqual(p(['--text', 'OK', '--contains']), { sel: { text: 'OK', contains: true } });
  assert.deepEqual(p(['li', '--nth', '3']), { sel: { css: 'li', nth: 3 } });
  assert.deepEqual(p(['--nth', '10000', 'li']), { sel: { css: 'li', nth: 10000 } }, 'flags may come before or after');
  assert.deepEqual(p(['x-app', 'x-card', 'button', '--shadow']), { sel: { css: 'button', shadow: ['x-app', 'x-card'] } });
  assert.deepEqual(p(['--shadow', 'host', '*', '--text', 'Go', '--nth', '2']), { sel: { css: '*', text: 'Go', nth: 2, shadow: ['host'] } });
  assert.deepEqual(p(['--', '--odd', '--text', 'x'].slice(0, 2)), { sel: '--odd' }, 'after -- everything is a selector');
  assert.deepEqual(p(['--text', '--odd', '--', '--css']), { sel: { css: '--css', text: '--odd' } }, 'a flag\'s value is taken as it is');
  assert.deepEqual(p(['a', '--contains', '--text', 'x', '--contains']), { sel: { css: 'a', text: 'x', contains: true } });
});

test('parseSelectorArgs: every rule that refuses, before anything is sent', () => {
  const bad = (argv, re, opts = {}) => assert.throws(() => parseSelectorArgs(argv, { name: 'click', ...opts }), re, JSON.stringify(argv));
  bad([], /needs a css selector or --text.*usage: safari click/);
  bad(['--contains'], /--contains needs --text/);
  bad(['a', '--contains'], /--contains needs --text/);
  bad(['--nth', '2'], /--nth needs a css selector or --text/);
  for (const n of ['0', '-1', '1.5', 'x', '10001', '', '1e3', ' 2']) bad(['a', '--nth', n], /--nth must be a whole number from 1 to 10000/);
  bad(['a', '--nth'], /--nth needs a value/);
  bad(['a', '--text'], /--text needs a value/);
  bad(['a', '--text', ' \n '], /--text is empty/);
  bad(['a', '--text', 'x', '--text', 'y'], /--text was given twice/);
  bad(['a', '--nth', '1', '--nth', '2'], /--nth was given twice/);
  bad(['a', 'b'], /one selector only/);
  bad(['a', '--shadow'], /--shadow needs the host selector/);
  bad(['--shadow'], /--shadow needs the host selector/);
  bad(['a', '--bogus'], /unknown flag --bogus/);
  bad(['a', '--label', 'x'], /unknown flag --label/, {});
  bad([''], /a selector is empty/);
  bad(['--shadow', 'a', ''], /a selector is empty/);
  // tap --label stands alone.
  const tap = (argv, re) => assert.throws(() => parseSelectorArgs(argv, { name: 'tap', label: true }), re, JSON.stringify(argv));
  assert.deepEqual(parseSelectorArgs(['--label', 'Share'], { name: 'tap', label: true }), { label: 'Share' });
  tap(['--label', 'x', 'button'], /--label stands alone/);
  tap(['button', '--label', 'x'], /--label stands alone/);
  tap(['--label', 'x', '--text', 'y'], /--label stands alone/);
  tap(['--label', 'x', '--contains'], /--label stands alone/);
  tap(['--label', 'x', '--nth', '2'], /--label stands alone/);
  tap(['--label', 'x', '--shadow'], /--label stands alone/);
  tap(['--label'], /--label needs a value/);
  tap(['--label', ''], /--label needs the accessibility label/);
  tap(['--contains'], /usage: safari tap .*--label/);
});

test('parseSelectorArgs for type: the last argument is the text, and it may look like a flag', () => {
  const t = argv => parseSelectorArgs(argv, { name: 'type', textLast: true });
  assert.deepEqual(t(['input', 'cats']), { sel: 'input', typed: 'cats' });
  assert.deepEqual(t(['input', '']), { sel: 'input', typed: '' });
  assert.deepEqual(t(['input', '--x']), { sel: 'input', typed: '--x' }, 'an unknown --word is the text');
  assert.deepEqual(t(['input', '--', '--text']), { sel: 'input', typed: '--text' });
  assert.deepEqual(t(['--text', 'Email', 'me@x.test']), { sel: { text: 'Email' }, typed: 'me@x.test' }, 'with --text and no css the only argument is the text');
  assert.deepEqual(t(['input', '--text', 'Email', '--nth', '2', 'hi']), { sel: { css: 'input', text: 'Email', nth: 2 }, typed: 'hi' });
  assert.deepEqual(t(['--shadow', 'x-form', 'input', 'hi']), { sel: { css: 'input', shadow: ['x-form'] }, typed: 'hi' });
  assert.deepEqual(t(['--shadow', 'x-form', '*', '--text', 'Name', 'hi']), { sel: { css: '*', text: 'Name', shadow: ['x-form'] }, typed: 'hi' });
  assert.throws(() => t([]), /the text to type is missing.*usage: safari type/);
  assert.throws(() => t(['--text', 'x']), /the text to type is missing/);
  assert.throws(() => t(['input']), /needs a css selector or --text/);
  assert.throws(() => t(['input', 'hello', 'world']), /one selector only/);
  assert.throws(() => t(['--shadow', 'input', 'hi']), /--shadow needs the host selector/);
  assert.throws(() => t(['input', '--contains', 'hi']), /--contains needs --text/);
  assert.throws(() => t(['--label', 'x', 'hi']), /one selector only/, 'type has no --label: it is a word like any other');
});

test('describeSel says only what the agent typed', () => {
  assert.equal(describeSel('a.b'), 'a.b');
  assert.equal(describeSel({ css: 'button', text: 'Continue', nth: 2 }), 'button text="Continue" #2');
  assert.equal(describeSel({ text: 'OK', contains: true }), 'text*="OK"');
  assert.equal(describeSel({ shadow: ['host'], css: 'inner' }), 'host >> inner');
  assert.equal(describeSel({ shadow: ['a', 'b'], css: '*', text: 'Go' }), 'a >> b >> * text="Go"');
  assert.equal(describeSel({ css: 'li', nth: 3 }), 'li #3');
});
