import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { sandbox, fakeRunner } from './helpers.js';
import { setRunner } from '../lib/core.js';
import { PMD3_FLOOR, PMD3_HINT, PMD3_SLOW_HINT, PMD3_VERSION_MS, atLeast, checkPmd3, pmd3Hint, pmd3Path, pmd3Version } from '../lib/pmd3.js';
import { TUNNEL_WAIT } from '../lib/tunnel.js';

const TOOL = '/opt/tools/bin/pymobiledevice3';

beforeEach(() => { sandbox(); delete process.env.MSL_PMD3; });
afterEach(() => { delete process.env.MSL_PMD3; });

test('MSL_PMD3 names the tool, and must be absolute', () => {
  process.env.MSL_PMD3 = TOOL;
  const calls = fakeRunner();
  assert.equal(pmd3Path(), TOOL);
  assert.deepEqual(calls, [], 'no uv lookup when the path is given');
  process.env.MSL_PMD3 = 'pymobiledevice3';
  assert.throws(() => pmd3Path(), /MSL_PMD3 must be an absolute path/);
  const out = checkPmd3();
  assert.equal(out.ok, false);
  assert.match(out.error, /absolute/);
});

test('the tool is found in the folder uv installs commands into, by an argument list', () => {
  const calls = fakeRunner((cmd, args) => (cmd === 'uv' ? { stdout: '/Users/x/.local/bin\n' } : undefined));
  assert.equal(pmd3Path(), '/Users/x/.local/bin/pymobiledevice3');
  assert.deepEqual(calls, [['uv', 'tool', 'dir', '--bin']]);
});

test('without uv, or with an answer that is not a folder, ~/.local/bin is used, never a PATH lookup', () => {
  const home = path.join(os.homedir(), '.local', 'bin', 'pymobiledevice3');
  fakeRunner(cmd => (cmd === 'uv' ? { code: 127, stderr: 'not found' } : undefined));
  assert.equal(pmd3Path(), home);
  fakeRunner(cmd => (cmd === 'uv' ? { stdout: 'bin\n' } : undefined));
  assert.equal(pmd3Path(), home);
  fakeRunner(cmd => (cmd === 'uv' ? { stdout: '' } : undefined));
  assert.equal(pmd3Path(), home);
});

test('versions compare by number, not by text', () => {
  assert.equal(PMD3_FLOOR, '11.40.2');
  assert.equal(atLeast('11.40.2', PMD3_FLOOR), true);
  assert.equal(atLeast('11.41.0', PMD3_FLOOR), true);
  assert.equal(atLeast('12.0.0', PMD3_FLOOR), true);
  assert.equal(atLeast('11.40.1', PMD3_FLOOR), false);
  assert.equal(atLeast('11.9.0', PMD3_FLOOR), false);
  assert.equal(atLeast('10.99.99', PMD3_FLOOR), false);
});

test('checkPmd3 accepts the floor and newer, and rejects older with the version it found', () => {
  process.env.MSL_PMD3 = TOOL;
  for (const v of ['11.40.2', '11.41.0', '12.0.0']) {
    const calls = fakeRunner(() => ({ stdout: `${v}\n` }));
    assert.deepEqual(checkPmd3(), { ok: true, path: TOOL, version: v });
    assert.deepEqual(calls, [[TOOL, 'version']]);
  }
  fakeRunner(() => ({ stdout: '11.40.1\n' }));
  const old = checkPmd3();
  assert.deepEqual([old.ok, old.path, old.version], [false, TOOL, '11.40.1']);
  assert.match(old.error, /11\.40\.1 is older than 11\.40\.2/);
});

test('a missing, failing, garbled or slow tool is not ok, with a reason', () => {
  process.env.MSL_PMD3 = TOOL;
  fakeRunner(() => ({ code: 127, stderr: 'spawn ENOENT' }));
  assert.match(checkPmd3().error, /not installed at \/opt\/tools\/bin\/pymobiledevice3/);
  fakeRunner(() => ({ code: 1, stderr: 'Traceback' }));
  assert.match(checkPmd3().error, /failed \(exit 1\)/);
  fakeRunner(() => ({ stdout: 'pymobiledevice3 v11.40.2\n' }));
  assert.match(checkPmd3().error, /not a version/);
  fakeRunner(() => ({ stdout: '' }));
  assert.equal(checkPmd3().version, null);
  const calls = fakeRunner(() => ({ code: 124, stdout: '', stderr: 'timed out after 10s' }));
  const slow = checkPmd3();
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out twice/);
  assert.deepEqual(calls, [[TOOL, 'version'], [TOOL, 'version']], 'one retry, no more');
});

test('a version check that times out once is tried again; twice is slow, never missing (#60)', () => {
  process.env.MSL_PMD3 = TOOL;
  let n = 0;
  let calls = fakeRunner(() => (++n === 1 ? { code: 124 } : { stdout: '11.41.0\n' }));
  assert.deepEqual(checkPmd3(), { ok: true, path: TOOL, version: '11.41.0' });
  assert.equal(calls.length, 2);

  calls = fakeRunner(() => ({ code: 124 }));
  const slow = checkPmd3();
  assert.deepEqual([slow.ok, slow.kind, slow.slow, slow.version, calls.length], [false, 'timeout', true, null, 2]);

  // Missing, old and failing tools are not slow, and only a timeout is retried.
  calls = fakeRunner(() => ({ code: 127 }));
  let out = checkPmd3();
  assert.deepEqual([out.kind, out.slow, calls.length], ['missing', undefined, 1]);
  fakeRunner(() => ({ stdout: '11.40.1\n' }));
  out = checkPmd3();
  assert.deepEqual([out.kind, out.slow, out.version], ['old', undefined, '11.40.1']);
  calls = fakeRunner(() => ({ code: 1 }));
  out = checkPmd3();
  assert.deepEqual([out.kind, out.slow, calls.length], ['failed', undefined, 1]);
  fakeRunner(() => ({ stdout: 'garbled' }));
  assert.equal(checkPmd3().kind, 'failed');
});

test('the version call is bounded to 10 s, each time', () => {
  const seen = [];
  setRunner((_cmd, _args, opts) => { seen.push(opts.timeoutMs); return { code: 0, stdout: '11.40.2\n', stderr: '' }; });
  assert.deepEqual(pmd3Version(TOOL), { version: '11.40.2' });
  assert.deepEqual(seen, [10e3]);
  seen.length = 0;
  setRunner((_cmd, _args, opts) => { seen.push(opts.timeoutMs); return { code: 124, stdout: '', stderr: '' }; });
  assert.equal(pmd3Version(TOOL).kind, 'timeout');
  assert.deepEqual(seen, [10e3, 10e3]);
});

test('the lab-side check looks once, and both checks fit in the tunnel wait with a clear margin (#60)', () => {
  process.env.MSL_PMD3 = TOOL;
  const calls = fakeRunner(() => ({ code: 124 }));
  const once = checkPmd3({ retry: false });
  assert.deepEqual([once.slow, calls.length], [true, 1]);
  assert.match(once.error, /timed out after 10s/);
  // ensureTunnel's single look runs before the wait; the host's, with its retry, runs inside it.
  const host = 2 * PMD3_VERSION_MS;
  assert.ok(host + 20e3 <= TUNNEL_WAIT.upMs, `the host's check (${host} ms) leaves 20 s or more of ${TUNNEL_WAIT.upMs} ms`);
  assert.ok(PMD3_VERSION_MS + host <= 30e3);
});

test('pmd3Hint: install steps, or try again for a slow check', () => {
  assert.equal(pmd3Hint({ slow: true }), PMD3_SLOW_HINT);
  assert.equal(pmd3Hint({ kind: 'missing' }), PMD3_HINT);
});

test('the hint names the install command and the floor', () => {
  assert.match(PMD3_HINT, /brew install uv/);
  assert.match(PMD3_HINT, /uv tool install --python 3\.14 pymobiledevice3/);
  assert.match(PMD3_HINT, /11\.40\.2 or newer/);
});

test('the install hint reads the same word for word, with the floor in it', () => {
  assert.equal(PMD3_HINT, 'Run `brew install uv`, then `uv tool install --python 3.14 pymobiledevice3` (upgrade: `uv tool upgrade pymobiledevice3`). Version 11.40.2 or newer is needed for Wi-Fi.');
});
