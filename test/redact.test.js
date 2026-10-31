import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConsole, redactUrl } from '../lib/appium.js';

const entry = (text, url) => ({ message: JSON.stringify({ level: 'log', text, url }) });

test('redactUrl masks the k parameter after any delimiter, any case', () => {
  assert.equal(redactUrl('https://h/a?k=client-abc'), 'https://h/a?k=[redacted]');
  assert.equal(redactUrl('https://h/a?x=1&k=client-abc&y=2'), 'https://h/a?x=1&k=[redacted]&y=2');
  assert.equal(redactUrl('https://h/a#k=client-abc'), 'https://h/a#k=[redacted]');
  assert.equal(redactUrl('https://h/a?K=client-abc'), 'https://h/a?K=[redacted]');
});

test('redactUrl leaves names that merely contain k alone', () => {
  for (const u of ['https://h/a?kind=1', 'https://h/a?mk=1', 'https://h/a?lock=1', 'https://h/a?x=1&kind=k']) {
    assert.equal(redactUrl(u), u);
  }
  assert.equal(redactUrl('https://h/a?key=abc'), 'https://h/a?key=[redacted]');
});

test('parseConsole masks k= in url and text', () => {
  const { entries } = parseConsole([entry('GET https://s.example/v1/initialize?k=client-abc&kind=1 failed', 'https://s.example/p?a=1&k=client-abc')]);
  assert.equal(entries[0].text, 'GET https://s.example/v1/initialize?k=[redacted]&kind=1 failed');
  assert.equal(entries[0].url, 'https://s.example/p?a=1&k=[redacted]');
});
