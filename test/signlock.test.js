import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, havePerl, holdLock, lockIsFree, withSignLock } from './helpers.js';
import { acquire, probe, lockDir, lockFile, helper, WAIT, OFF_WARNING, LOCK_NAME, PERL } from '../lib/signlock.js';
import { withInterrupt, InterruptError } from '../lib/interrupt.js';

const needPerl = { skip: !havePerl && `${PERL} is not here` };
const failing = async p => { try { await p; } catch (e) { return e; } assert.fail('expected a rejection'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Whether a plain file can be flocked right now (a link's target must never be locked).
const fileIsFree = file => spawnSync(PERL, ['-e', 'use Fcntl qw(:flock); open(F, "<", $ARGV[0]) or exit 3; flock(F, LOCK_EX|LOCK_NB) or exit 75;', file]).status === 0;

test('SIDELOAD_HOME is honoured, and ~/.sideload is the default', async () => {
  const dir = tempDir();
  await withSignLock({ home: dir }, async () => {
    assert.equal(lockDir(), path.resolve(dir));
    assert.equal(lockFile(), path.join(path.resolve(dir), LOCK_NAME));
    delete process.env.SIDELOAD_HOME;
    assert.equal(lockDir(), path.join(os.homedir(), '.sideload'));
  });
});

test('no sideload folder: the lock is skipped, nothing is spawned and no folder or file is made', async () => {
  const dir = path.join(tempDir(), 'missing');
  await withSignLock({ home: dir }, async () => {
    const lock = await acquire();
    assert.equal(lock.skipped, true);
    assert.equal(lock.disabled, undefined, 'a missing folder is not a disabled lock');
    await lock.release();
    assert.equal(fs.existsSync(dir), false);
  });
});

test('MSL_SIGNLOCK=off skips the lock and says it was turned off', async () => {
  const dir = tempDir();
  await withSignLock({ home: dir, off: 'off' }, async () => {
    const lock = await acquire();
    assert.equal(lock.skipped, true);
    assert.equal(lock.disabled, true);
    assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
  });
  assert.match(OFF_WARNING, /sign lock disabled; sideload may sign at the same time \(Xcode may then create a second certificate\)/);
});

test('acquire holds the flock until release, which is idempotent and ends the helper', needPerl, async () => {
  const dir = tempDir();
  await withSignLock({ home: dir }, async () => {
    const lock = await acquire();
    assert.equal(lock.skipped, undefined);
    assert.equal(fs.statSync(path.join(dir, LOCK_NAME)).mode & 0o777, 0o600 & ~process.umask());
    assert.equal(lockIsFree(dir), false, 'held');
    assert.equal(alive(lock.pid), true);
    await Promise.all([lock.release(), lock.release()]);
    await lock.release();
    assert.equal(lockIsFree(dir), true, 'free after release');
    assert.equal(alive(lock.pid), false, 'the helper is gone');
  });
});

test('a lock sideload holds is busy: needs busy at once, no wait', needPerl, async () => {
  const dir = tempDir();
  const other = await holdLock(dir);
  try {
    await withSignLock({ home: dir }, async () => {
      const started = Date.now();
      const e = await failing(acquire());
      assert.ok(Date.now() - started < WAIT.acquireMs, 'did not wait');
      assert.equal(e.extra.needs, 'busy');
      assert.deepEqual(e.extra.human, ['sideload is signing or installing an app with the same Apple team; try again in a minute.']);
      assert.equal(e.extra.then, 'lab up --target device');
      assert.equal(e.extra.or, 'lab up --target simulator');
    });
  } finally { await other.release(); }
  await withSignLock({ home: dir }, async () => { await (await acquire()).release(); }); // free again
});

test('a symlinked lock file is not followed: a clear error, not busy, and the target is untouched', needPerl, async () => {
  const dir = tempDir();
  const target = path.join(tempDir(), 'elsewhere');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(dir, LOCK_NAME));
  await withSignLock({ home: dir }, async () => {
    const e = await failing(acquire());
    assert.equal(e.extra, undefined, 'not a needs error');
    assert.match(e.message, /couldn't open the signing lock file .*\.op\.lock/);
    assert.doesNotMatch(e.message, /busy|holds/);
    assert.match(e.message, /symlink.*ls -l .*\.op\.lock.*MSL_SIGNLOCK=off/s, 'says what a person can do');
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fileIsFree(target), true, 'the target was never locked');
});

test('a helper that never answers fails within the bound', async () => {
  const dir = tempDir();
  const was = { ...helper }, wait = WAIT.acquireMs;
  helper.script = '<STDIN>;'; // takes no lock and says nothing
  WAIT.acquireMs = 150;
  try {
    await withSignLock({ home: dir }, async () => {
      const e = await failing(acquire());
      assert.match(e.message, /did not answer within \d+s, so the lock on .* was not taken/);
      assert.equal(e.extra, undefined);
    });
  } finally { Object.assign(helper, was); WAIT.acquireMs = wait; }
});

test('a helper that fails some other way, or cannot start, is a failure and not busy', needPerl, async () => {
  const dir = tempDir();
  const was = { ...helper };
  try {
    helper.script = 'print STDERR "boom\\n"; exit 9;';
    await withSignLock({ home: dir }, async () => {
      const e = await failing(acquire());
      assert.match(e.message, /signing lock helper failed \(exit 9\): boom/);
      assert.equal(e.extra, undefined);
    });
    Object.assign(helper, was, { cmd: '/nonexistent/perl' });
    await withSignLock({ home: dir }, async () => {
      assert.match((await failing(acquire())).message, /couldn't run \/nonexistent\/perl to take the signing lock/);
    });
  } finally { Object.assign(helper, was); }
});

test('an interrupted command does not take the lock', needPerl, async () => {
  const dir = tempDir();
  await withSignLock({ home: dir }, async () => {
    const e = await withInterrupt(async () => {
      process.emit('SIGTERM', 'SIGTERM');
      return failing(acquire());
    });
    assert.ok(e instanceof InterruptError);
  });
  assert.equal(lockIsFree(dir), true);
});

test('the helper does not outlive the lab: a lab that exits holding the lock frees it', needPerl, async () => {
  const dir = tempDir();
  const mod = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'signlock.js');
  const code = `import(${JSON.stringify(mod)}).then(async m => { const l = await m.acquire(); console.log(l.pid); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, SIDELOAD_HOME: dir, MSL_SIGNLOCK: '' }, encoding: 'utf8', timeout: 20e3 });
  assert.equal(r.status, 0, r.stderr);
  const pid = Number(r.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  // The kill is sent on exit and the kernel drops the flock with the helper: poll for that event, bounded.
  for (let i = 0; i < 200 && !lockIsFree(dir); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(lockIsFree(dir), true);
  assert.equal(alive(pid), false);
});

test('probe: free is let go at once, busy is reported without waiting, skipped says why, and nothing is left holding', needPerl, async () => {
  const dir = tempDir();
  await withSignLock({ home: dir }, async () => {
    assert.deepEqual(await probe(), { free: true });
    assert.equal(lockIsFree(dir), true, 'the probe holds nothing');
  });
  const other = await holdLock(dir);
  try {
    await withSignLock({ home: dir }, async () => {
      const started = Date.now();
      const r = await probe();
      assert.ok(Date.now() - started < WAIT.acquireMs, 'did not wait');
      assert.equal(r.busy, true);
      assert.equal(r.error.extra.needs, 'busy');
    });
  } finally { await other.release(); }
  assert.equal(lockIsFree(dir), true);
  await withSignLock({ home: path.join(dir, 'missing') }, async () => assert.deepEqual(await probe(), { skipped: true }));
  await withSignLock({ home: dir, off: 'off' }, async () => assert.deepEqual(await probe(), { skipped: true, disabled: true }));
});

test('probe throws what acquire throws for anything but busy: a symlinked lock file, a helper that fails, an interrupt', needPerl, async () => {
  const dir = tempDir();
  const was = { ...helper };
  fs.symlinkSync(path.join(tempDir(), 'elsewhere'), path.join(dir, LOCK_NAME));
  await withSignLock({ home: dir }, async () => {
    assert.match((await failing(probe())).message, /couldn't open the signing lock file/);
  });
  fs.rmSync(path.join(dir, LOCK_NAME));
  try {
    helper.script = 'print STDERR "boom\\n"; exit 9;';
    await withSignLock({ home: dir }, async () => assert.match((await failing(probe())).message, /signing lock helper failed \(exit 9\)/));
  } finally { Object.assign(helper, was); }
  await withSignLock({ home: dir }, async () => {
    const e = await withInterrupt(async () => { process.emit('SIGTERM', 'SIGTERM'); return failing(probe()); });
    assert.ok(e instanceof InterruptError);
  });
  assert.equal(lockIsFree(dir), true);
});
