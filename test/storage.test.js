import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenArgs, parseSelectorArgs, STORAGE_LIMITS, STORAGE_WRITE } from '../lib/safari.js';
import { parseArgs } from '../lib/core.js';

// --- parseOpenArgs: every word of open's and refresh's argv is read here, and an error names a place, never a word ---

const CANARY = 'CANARY-zq7k';
const U = 'https://a.test/';
const take = (...argv) => parseOpenArgs([U, ...argv], 'open');

test('parseOpenArgs gives the URL, the flags and every --storage pair in order', () => {
  assert.deepEqual(take('--storage', 'a=1', '--reinject', '--storage', 'b=2'), { url: U, flags: { reinject: true }, pairs: [['a', '1'], ['b', '2']] });
  assert.deepEqual(parseOpenArgs([U], 'open'), { url: U, flags: {}, pairs: [] });
  assert.deepEqual(parseOpenArgs(['--wait-for', '.card', '--settle', U, '--timeout', '900'], 'open'), { url: U, flags: { 'wait-for': '.card', settle: true, timeout: '900' }, pairs: [] });
  assert.deepEqual(parseOpenArgs(['--reinject', '--wait-for', '#a=b'], 'refresh'), { url: undefined, flags: { reinject: true, 'wait-for': '#a=b' }, pairs: [] }, 'a value may hold =');
});

test('parseOpenArgs splits a pair at the first = and allows an empty value, = and spaces in a value', () => {
  assert.deepEqual(take('--storage', 'k=a=b=c').pairs, [['k', 'a=b=c']]);
  assert.deepEqual(take('--storage', 'k=').pairs, [['k', '']]);
  assert.deepEqual(take('--storage', 'k= two words\n').pairs, [['k', ' two words\n']]);
  assert.deepEqual(take('--storage', 'k==').pairs, [['k', '=']]);
  assert.deepEqual(take('--storage', 'ключ=значение').pairs, [['ключ', 'значение']]);
});

test('parseOpenArgs refuses what is wrong with a pair by place and rule, and never echoes a key or a value', () => {
  const k = n => 'k'.repeat(n);
  const cases = [
    [['--storage'], /^open: --storage #1 needs key=value$/],
    [['--storage', 'a=1', '--storage'], /^open: --storage #2 needs key=value$/],
    [['--storage', 'a=1', '--storage', `no-equals-${CANARY}`], /^open: --storage #2 needs key=value$/],
    [['--storage', `=${CANARY}`], /^open: --storage #1: the key must be 1 to 256 characters with no control characters$/],
    [['--storage', `${k(257)}=${CANARY}`], /#1: the key must be 1 to 256 characters/],
    [['--storage', `a\u0000b=${CANARY}`], /#1: the key must be 1 to 256 characters with no control characters/],
    [['--storage', `a\tb=${CANARY}`], /#1: the key must be 1 to 256 characters with no control characters/],
    [['--storage', `a\u007fb=${CANARY}`], /#1: the key must be/],
    [['--storage', `a=${'v'.repeat(4097)}${CANARY}`], /^open: --storage #1: the value must be at most 4096 characters$/],
    [['--storage', `a=${CANARY}`, '--storage', `b=1`, '--storage', `a=${CANARY}`], /^open: --storage #3 repeats the key of #1$/],
  ];
  for (const [argv, re] of cases) {
    assert.throws(() => take(...argv), e => { assert.match(e.message, re); assert.ok(!/CANARY|zq7k|no-equals/.test(e.message), 'a value is echoed'); assert.equal(e.skipArtifacts, true); return true; }, JSON.stringify(argv).slice(0, 80));
  }
});

test('parseOpenArgs limits: 256-character keys, 4096-character values, 20 pairs, 16 KiB in all', () => {
  assert.deepEqual(STORAGE_LIMITS, { keyMax: 256, valueMax: 4096, pairs: 20, totalBytes: 16384 });
  assert.equal(take('--storage', `${'k'.repeat(256)}=1`).pairs.length, 1);
  assert.equal(take('--storage', `k=${'v'.repeat(4096)}`).pairs.length, 1);
  const pairs = n => Array.from({ length: n }, (_, i) => ['--storage', `k${i}=v`]).flat();
  assert.equal(take(...pairs(20)).pairs.length, 20);
  assert.throws(() => take(...pairs(21)), /open: --storage takes at most 20 pairs$/);
  // 16384 bytes of keys and values: four values of 4096 characters with 1-character keys leave 8 bytes over.
  const big = [...'abcd'].flatMap(c => ['--storage', `${c}=${'v'.repeat(4095)}`]); // 4 x (1 + 4095) = 16384
  assert.equal(take(...big).pairs.length, 4);
  assert.throws(() => take(...big, '--storage', 'e='), /open: --storage pairs add up to more than 16 KiB$/);
  // Bytes, not characters: 2-byte letters count twice.
  const wide = [...'abcd'].flatMap(c => ['--storage', `${c}=${'é'.repeat(2048)}`]); // 4 x (1 + 4096) bytes
  assert.throws(() => take(...wide), /more than 16 KiB/);
});

// Every way a value can sit in a word the parser does not take as a pair. The error names the place, ends with
// the usage, skips the failure artifacts and holds nothing of the argument.
const STRAY = [
  [[`--storage=tok=${CANARY}`], /^open: --storage takes its pair as the next word \(--storage key=value\), not after =; usage: safari open <http\(s\) URL> /],
  [[`--STORAGE=tok=${CANARY}`], /^open: --storage takes its pair as the next word/],
  [[`--storage=tok=${CANARY}`, '--settle'], /^open: --storage takes its pair as the next word/],
  [['--settle', `--storage=tok=${CANARY}`], /^open: --storage takes its pair as the next word/],
  [[`--x=${CANARY}`], /^open: argument #2: give a flag's value as the next word, not after =; usage: safari open /],
  [[`--wait-for=${CANARY}`], /^open: argument #2: give a flag's value as the next word, not after =/],
  [[`--timeout=${CANARY}`], /^open: argument #2: give a flag's value as the next word/],
  [['--settle', `--reinject=${CANARY}`], /^open: argument #3: give a flag's value as the next word/],
  [['--Storage', `tok=${CANARY}`], /^open: argument #2 is not a flag open knows; usage: safari open /],
  [['--stor', `tok=${CANARY}`], /^open: argument #2 is not a flag open knows/],
  [['--', '--storage', `tok=${CANARY}`], /^open: argument #2 is not a flag open knows/],
  [['-storage', `tok=${CANARY}`], /^open: argument #2 is extra \(open takes one URL\); usage: safari open /],
  [['\u2014storage', `tok=${CANARY}`], /^open: argument #2 is extra \(open takes one URL\)/],
  [['--wait-for', '--storage', `tok=${CANARY}`], /^open: --wait-for needs a value; usage: safari open /],
  [['--wait-for', `--storage=tok=${CANARY}`], /^open: --wait-for needs a value/],
  [['--wait-for', '-storage', `tok=${CANARY}`], /^open: --wait-for needs a value/],
  [['--timeout', '--Storage'], /^open: --timeout needs a value/],
  [['--wait-for'], /^open: --wait-for needs a value/],
  [['--wait-for', '.a', '--wait-for', '.b'], /^open: --wait-for was given twice/],
  [['--timeout', '1000', '--timeout', '2000'], /^open: --timeout was given twice/],
];

test('parseOpenArgs refuses a stray word by its position and the rule, never by echoing it', () => {
  for (const [argv, re] of STRAY) {
    assert.throws(() => take(...argv), e => {
      assert.match(e.message, re, JSON.stringify(argv));
      assert.ok(!/CANARY|zq7k|tok=/.test(e.message), `a word is echoed: ${e.message}`);
      assert.equal(e.skipArtifacts, true);
      return true;
    }, JSON.stringify(argv));
  }
  // The same words with nothing before them still land on a position.
  assert.throws(() => parseOpenArgs([`--storage=tok=${CANARY}`], 'open'), /^Error: open: --storage takes its pair as the next word/);
  assert.throws(() => parseOpenArgs(['-storage', `tok=${CANARY}`, U], 'open'), /^Error: open: argument #2 is extra/);
});

test('refresh takes no URL and no --storage, in any spelling, whatever the words around it', () => {
  const words = [['--storage', `tok=${CANARY}`], [`--storage=tok=${CANARY}`], ['--Storage', `tok=${CANARY}`], ['-storage', `tok=${CANARY}`], ['\u2014storage', `tok=${CANARY}`], ['--settle', '--storage', `tok=${CANARY}`], ['--wait-for', '--storage', `tok=${CANARY}`]];
  for (const argv of words) {
    assert.throws(() => parseOpenArgs(argv, 'refresh'), e => {
      assert.equal(e.message, 'refresh: --storage is for open only');
      assert.equal(e.skipArtifacts, true);
      return true;
    }, JSON.stringify(argv));
  }
  assert.throws(() => parseOpenArgs([`--x=${CANARY}`], 'refresh'), /^Error: refresh: argument #1: give a flag's value as the next word, not after =; usage: safari refresh /);
  assert.throws(() => parseOpenArgs([U], 'refresh'), /^Error: refresh: argument #1 is extra \(refresh takes no URL\); usage: safari refresh /);
});

test('the generic flag parser never echoes a word: a flag is named only when it looks like a name', () => {
  assert.throws(() => parseArgs([`--x=${CANARY}`]), e => { assert.equal(e.message, '--x=… is not supported: give the value as the next word'); return true; });
  assert.throws(() => parseArgs([`--tok=${CANARY}`], ['force']), /^Error: --tok=… is not supported: give the value as the next word$/);
  assert.throws(() => parseArgs([`--tok_${CANARY}`]), e => { assert.equal(e.message, 'a flag needs a value'); return true; }, 'a word that is not shaped like a name');
  assert.throws(() => parseArgs([`--${'n'.repeat(40)}`]), /^Error: a flag needs a value$/);
  assert.throws(() => parseArgs([`--tok_${CANARY}=1`]), e => { assert.ok(!/CANARY|zq7k/.test(e.message)); assert.match(e.message, /is not supported: give the value as the next word$/); return true; });
  assert.throws(() => parseArgs(['--port']), /^Error: --port needs a value$/);
  assert.throws(() => parseArgs(['x', '--device-name']), /^Error: --device-name needs a value$/);
  assert.deepEqual(parseArgs(['a', '--port', '1', '--force'], ['force']), { pos: ['a'], flags: { port: '1', force: true } });
  assert.deepEqual(parseArgs(['--port', 'a=b']), { pos: [], flags: { port: 'a=b' } }, 'a value may hold =');
});

test('the generic flag parser gives a repeatable flag as an array, in order, and keeps the last value of the others', () => {
  assert.deepEqual(parseArgs(['--allow-host', 'a.test', 'x', '--port', '1', '--allow-host', 'b.test'], [], ['allow-host']), { pos: ['x'], flags: { 'allow-host': ['a.test', 'b.test'], port: '1' } });
  assert.deepEqual(parseArgs(['--port', '1'], [], ['allow-host']), { pos: [], flags: { port: '1' } }, 'a repeatable flag not given is absent');
  assert.deepEqual(parseArgs(['--port', '1', '--port', '2']), { pos: [], flags: { port: '2' } }, 'a flag that is not repeatable keeps the last');
  assert.throws(() => parseArgs(['--allow-host'], [], ['allow-host']), /^Error: --allow-host needs a value$/);
  assert.throws(() => parseArgs(['--allow-host=a.test'], [], ['allow-host']), /^Error: --allow-host=… is not supported/);
});

test('the selector parser names a word that is not shaped like a flag by its position only', () => {
  for (const name of ['click', 'tap']) {
    assert.throws(() => parseSelectorArgs(['a', `--x=${CANARY}`], { name }), e => { assert.match(e.message, new RegExp(`^${name}: argument #2 is not a flag ${name} knows`)); assert.ok(!/CANARY|zq7k/.test(e.message)); return true; });
  }
  assert.throws(() => parseSelectorArgs(['--bogus'], { name: 'click' }), /unknown flag --bogus/);
});

// --- STORAGE_WRITE: the script that runs in the page ---

const run = (pairs, origin, { page = 'https://a.test', fail } = {}) => {
  const set = [];
  const localStorage = { setItem: (k, v) => { if (fail?.(set.length)) throw fail(set.length); set.push([k, v]); } };
  const result = new Function('location', 'localStorage', 'args', `return (function () {${STORAGE_WRITE}}).apply(null, args);`)({ origin: page }, localStorage, [pairs, origin]);
  return { result, set };
};

test('the storage script writes the pairs on the origin asked for, and says -1 on any other', () => {
  const pairs = [['a', '1'], ['b', CANARY]];
  assert.deepEqual(run(pairs, 'https://a.test'), { result: 2, set: pairs });
  assert.deepEqual(run(pairs, 'https://a.test', { page: 'https://www.a.test' }), { result: -1, set: [] });
  assert.deepEqual(run([], 'https://a.test').result, 0);
});

test('the storage script catches its own errors and gives back the index and the error name, never the page\'s message', () => {
  const boom = () => Object.assign(new Error(`cannot store ${CANARY}`), { name: 'QuotaExceededError' });
  const r = run([['a', '1'], ['b', CANARY], ['c', '3']], 'https://a.test', { fail: n => (n === 1 ? boom() : undefined) });
  assert.deepEqual(r.result, { failed: 1, name: 'QuotaExceededError' });
  assert.deepEqual(r.set, [['a', '1']]);
  assert.ok(!JSON.stringify(r.result).includes('CANARY'));
  // A name that is not a string is "Error". The page's name is not cut or judged here: Node maps it to a name it knows.
  assert.equal(run([['a', '1']], 'https://a.test', { fail: () => Object.assign(new Error('x'), { name: { toString() { throw new Error('no'); } } }) }).result.name, 'Error');
  assert.equal(run([['a', '1']], 'https://a.test', { fail: () => Object.assign(new Error('x'), { name: 'N'.repeat(200) }) }).result.name.length, 200);
  assert.doesNotMatch(STORAGE_WRITE, /\.slice\(/, 'nothing the page can patch cuts or checks the name');
});

test('the storage script holds no pair: they travel as arguments, not in the source', () => {
  assert.ok(!STORAGE_WRITE.includes(CANARY));
  assert.match(STORAGE_WRITE, /arguments\[0\]/);
  assert.match(STORAGE_WRITE, /arguments\[1\]/);
});
