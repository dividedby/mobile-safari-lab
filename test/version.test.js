import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.js';
import { setRunner, loadState, saveState, REPO } from '../lib/core.js';
import { labVersion, humanFor, WAIT } from '../lib/version.js';

const ROOT = '/fake/lab';
const LOCAL = 'abc1234';
const REMOTE = 'f'.repeat(40);
const T0 = Date.parse('2026-10-18T12:00:00Z');

let calls, git;

// A scripted git: `git.<field>` decides each answer; no real git or network is ever touched.
beforeEach(() => {
  sandbox();
  WAIT.cacheMs = 6 * 3600e3;
  git = { head: { stdout: LOCAL + '\n' }, branch: 'main', dirty: '', remote: { stdout: `${REMOTE}\tHEAD\n` }, ancestor: { code: 0 } };
  calls = [];
  setRunner((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const reply = r => ({ code: 0, stdout: '', stderr: '', ...r });
    if (cmd !== 'git') return reply({ code: 127, stderr: 'unexpected command' });
    switch (args[2]) {
      case 'rev-parse': return reply(git.head);
      case 'branch': return reply({ stdout: (git.branch ?? '') + '\n' });
      case 'status': return reply({ stdout: git.dirty });
      case 'ls-remote': return reply(git.remote);
      case 'merge-base': return reply(git.ancestor);
      default: return reply({ code: 1, stderr: 'unexpected git command' });
    }
  });
});

const sub = name => calls.filter(c => c.args[2] === name);
const check = (opts = {}) => labVersion({ root: ROOT, now: T0, ...opts });

test('up to date: the remote commit is an ancestor of HEAD', () => {
  const v = check();
  assert.deepEqual(v, { checked: '2026-10-18T12:00:00.000Z', path: ROOT, local: LOCAL, branch: 'main', dirty: false, remote: 'fffffff', behind: false });
  assert.equal(v.human, undefined);
});

test('git runs with argument lists against the lab root, with timeouts and no password prompt', () => {
  check();
  assert.ok(calls.every(c => c.cmd === 'git' && c.args[0] === '-C' && c.args[1] === ROOT));
  assert.deepEqual(sub('rev-parse')[0].args, ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
  assert.deepEqual(sub('status')[0].args, ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']);
  assert.deepEqual(sub('ls-remote')[0].args, ['-C', ROOT, 'ls-remote', 'origin', 'HEAD']);
  assert.deepEqual(sub('merge-base')[0].args, ['-C', ROOT, 'merge-base', '--is-ancestor', REMOTE, 'HEAD']);
  assert.equal(sub('ls-remote')[0].opts.timeoutMs, 5000);
  assert.ok(calls.every(c => Number.isInteger(c.opts.timeoutMs) && c.opts.env.GIT_TERMINAL_PROMPT === '0'));
});

test('it only looks: no pull, fetch, checkout or any other write', () => {
  git.ancestor = { code: 1 };
  check();
  const verbs = new Set(calls.map(c => c.args[2]));
  assert.deepEqual([...verbs].sort(), ['branch', 'ls-remote', 'merge-base', 'rev-parse', 'status']);
});

test('the lab root comes from the module location, not the working directory', () => {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(REPO, here);
  const cwd = process.cwd();
  process.chdir(path.sep);
  try { labVersion({ now: T0 }); } finally { process.chdir(cwd); }
  assert.ok(calls.length > 0 && calls.every(c => c.args[1] === here));
});

test('behind: says so with the pull command and the new-session step', () => {
  git.ancestor = { code: 1 };
  const v = check();
  assert.equal(v.behind, true);
  assert.deepEqual(v.human, [
    `The lab at ${ROOT} is out of date (${LOCAL} vs fffffff on GitHub). Run: git -C ${ROOT} pull --ff-only`,
    'Then start a new agent session so the skill reloads.',
  ]);
});

test('a remote commit the checkout does not have is behind', () => {
  git.ancestor = { code: 128, stderr: 'fatal: Not a valid commit name' };
  assert.equal(check().behind, true);
});

test('a merge-base that fails another way (a timeout) is no answer, not a false warning', () => {
  git.ancestor = { code: 124 };
  const v = check();
  assert.equal(v.checked, false);
  assert.equal('behind' in v, false);
  assert.equal('human' in v, false);
});

test('a path with spaces is quoted in the command', () => {
  assert.match(humanFor({ root: '/My Labs/lab', local: LOCAL, remote: 'fffffff', branch: 'main', dirty: false, behind: true })[0], /Run: git -C '\/My Labs\/lab' pull --ff-only$/);
});

test('behind with uncommitted tracked changes says the pull may stop', () => {
  git.ancestor = { code: 1 };
  git.dirty = ' M lib/core.js\n';
  const v = check();
  assert.equal(v.dirty, true);
  assert.equal(v.human.length, 3);
  assert.match(v.human[1], /uncommitted changes/);
});

test('dirty alone is reported but is not a warning', () => {
  git.dirty = ' M README.md\n';
  const v = check();
  assert.equal(v.dirty, true);
  assert.equal(v.human, undefined);
});

test('not on main: a note, even when up to date', () => {
  git.branch = 'feat/x';
  const v = check();
  assert.equal(v.behind, false);
  assert.equal(v.branch, 'feat/x');
  assert.equal(v.human.length, 1);
  assert.match(v.human[0], /is on branch feat\/x, not main/);
  assert.match(v.human[0], /git -C \/fake\/lab switch main/);
});

test('a detached HEAD is not main either', () => {
  git.branch = '';
  const v = check();
  assert.equal(v.branch, null);
  assert.match(v.human[0], /a detached HEAD, not main/);
});

test('behind and not on main: switch back to main, then pull', () => {
  git.branch = 'feat/x';
  git.ancestor = { code: 1 };
  const v = check();
  assert.match(v.human[0], /not main, and is out of date \(abc1234 vs fffffff on GitHub\)\. Run: git -C \/fake\/lab switch main && git -C \/fake\/lab pull --ff-only$/);
  assert.equal(v.human[1], 'Then start a new agent session so the skill reloads.');
});

test('offline: checked is false with a reason, nothing else fails', () => {
  git.remote = { code: 128, stderr: 'fatal: unable to access' };
  const v = check();
  assert.equal(v.checked, false);
  assert.match(v.reason, /offline/);
  assert.equal(v.needs, undefined);
  assert.equal(v.human, undefined);
  assert.equal(v.behind, undefined);
  assert.deepEqual([v.local, v.branch, v.dirty], [LOCAL, 'main', false]);
  assert.equal(sub('merge-base').length, 0);
});

test('a timeout is the same quiet failure', () => {
  git.remote = { code: 124, stderr: 'timed out after 5s' };
  const v = check();
  assert.equal(v.checked, false);
  assert.equal(v.reason, 'origin did not answer within 5s');
});

test('no git at all, or not a git checkout, is a quiet failure', () => {
  git.head = { code: 127, stderr: 'spawn git ENOENT' };
  assert.deepEqual(check(), { checked: false, reason: 'git is not available' });
  git.head = { code: 128, stderr: 'fatal: not a git repository' };
  assert.deepEqual(check(), { checked: false, reason: `${ROOT} is not a git checkout` });
  assert.equal(sub('ls-remote').length, 0);
});

test('an origin with no HEAD line is a quiet failure', () => {
  git.remote = { stdout: '' };
  assert.equal(check().reason, 'origin returned no HEAD');
});

test('a runner that throws never fails the check', () => {
  setRunner(() => { throw new Error('boom'); });
  assert.deepEqual(check(), { checked: false, reason: 'the version check failed: boom' });
});

test('cache hit: the second check does not ask origin again', () => {
  check();
  assert.equal(sub('ls-remote').length, 1);
  const again = check({ now: T0 + 3600e3 });
  assert.equal(sub('ls-remote').length, 1);
  assert.equal(again.cached, true);
  assert.equal(again.checked, '2026-10-18T12:00:00.000Z'); // the time of the real check
  assert.equal(again.remote, 'fffffff');
});

test('a cached remote still gives the right answer after a pull (local facts are fresh)', () => {
  git.ancestor = { code: 1 };
  assert.equal(check().behind, true);
  git.ancestor = { code: 0 };
  git.head = { stdout: 'fffffff\n' };
  const v = check({ now: T0 + 60e3 });
  assert.equal(v.cached, true);
  assert.equal(v.behind, false);
  assert.equal(v.human, undefined);
});

test('the cache expires after 6 hours, and --check-update (force) skips it', () => {
  check();
  check({ now: T0 + 6 * 3600e3 - 1 });
  assert.equal(sub('ls-remote').length, 1);
  check({ now: T0 + 6 * 3600e3 });
  assert.equal(sub('ls-remote').length, 2);
  check({ now: T0 + 6 * 3600e3 + 1000, force: true });
  assert.equal(sub('ls-remote').length, 3);
});

test('a failed check is cached briefly so an offline Mac is not slowed on every call', () => {
  git.remote = { code: 124 };
  check();
  const again = check({ now: T0 + 60e3 });
  assert.equal(sub('ls-remote').length, 1);
  assert.equal(again.checked, false);
  assert.equal(again.cached, true);
  check({ now: T0 + 16 * 60e3 });
  assert.equal(sub('ls-remote').length, 2);
  git.remote = { stdout: `${REMOTE}\tHEAD\n` };
  assert.equal(check({ now: T0 + 60e3, force: true }).behind, false); // forced: asks again
});

test('a cache for another checkout, a damaged one or one dated in the future is ignored', () => {
  saveState({ labVersionCache: { root: '/other/lab', at: new Date(T0).toISOString(), remote: REMOTE } });
  check();
  assert.equal(sub('ls-remote').length, 1);
  for (const bad of ['junk', 42, { root: ROOT, at: 'yesterday', remote: REMOTE }, { root: ROOT, at: new Date(T0 + 1e6).toISOString(), remote: REMOTE }, { root: ROOT, at: new Date(T0).toISOString(), remote: 'not-a-sha' }]) {
    saveState({ labVersionCache: bad });
    calls.length = 0;
    check();
    assert.equal(sub('ls-remote').length, 1, JSON.stringify(bad));
  }
});

test('the cache holds the full remote SHA and the time, in the state', () => {
  check();
  assert.deepEqual(loadState().labVersionCache, { root: ROOT, at: '2026-10-18T12:00:00.000Z', remote: REMOTE });
});
