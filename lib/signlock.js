// The signing lock shared with sideload (issue 63): both tools sign and install apps with the same Apple
// team, and a free account allows few app IDs, so only one of them may do it at a time. The lock is
// BSD flock(2) on `$SIDELOAD_HOME/.op.lock` (SIDELOAD_HOME defaults to ~/.sideload), taken
// exclusive and non-blocking, as sideload takes it. Node has no flock, so a small perl helper holds it:
// it prints `locked`, then waits on its stdin; closing the pipe, or the process dying, releases the
// lock (the kernel drops a flock when the holder dies, whatever the lab was doing).
// Held while a device session is created (the WebDriverAgent build and launch, the re-sign and the
// Appium create are inside it), never for page commands or on the simulator. `lab up` also probes it early
// (see probe) for a new phone session, so a busy lock is found before Appium, the tunnel or Lab Focus. A busy lock stops the
// command at once (`needs: busy`); the lab never waits for it, never creates sideload's folder and never
// deletes the lock file. The helper opens the file with O_CREAT (as sideload does), so inside an existing
// folder the lab may create it (0600). MSL_SIGNLOCK=off turns the lock off.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsError } from './phone.js';
import { InterruptError, interrupted, requestSignal } from './interrupt.js';

export const PERL = '/usr/bin/perl';
export const LOCK_NAME = '.op.lock';
// Exit codes of the helper: 75 (EX_TEMPFAIL) is a lock someone else holds, 3 a lock file that can't be opened.
export const BUSY_EXIT = 75;
export const OPEN_EXIT = 3;
// `helper` is what runs (tests replace the script to play a helper that never answers or fails).
export const HELPER = 'use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW); sysopen(F, $ARGV[0], O_RDWR|O_CREAT|O_NOFOLLOW, 0600) or exit 3; flock(F, LOCK_EX|LOCK_NB) or exit 75; $|=1; print "locked\\n"; <STDIN>;';

export const helper = { cmd: PERL, script: HELPER };

// Waits, in ms (tests shorten them): the helper saying `locked` or ending, and its exit after release.
export const WAIT = { acquireMs: 5e3, releaseMs: 3e3 };

export const lockDir = () => path.resolve(process.env.SIDELOAD_HOME || path.join(os.homedir(), '.sideload'));
export const lockFile = () => path.join(lockDir(), LOCK_NAME);

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const skipped = extra => ({ skipped: true, ...extra, release: async () => {} });
// What a start reports (`signLock: "disabled"`, `warning`) when MSL_SIGNLOCK=off skipped a lock it would have taken.
export const OFF_WARNING = 'sign lock disabled; sideload may sign at the same time (Xcode may then create a second certificate)';
// The fields a start adds to its JSON: none unless the lock was turned off. `from` is what acquire returned, or
// a result that already carries the report (so `lab up` and `safari start` pass it on with the same call).
export const lockReport = from => (from?.disabled || from?.signLock === 'disabled' ? { signLock: 'disabled', warning: OFF_WARNING } : {});
const OFF_HINT = 'To go on without the lock for one run, set MSL_SIGNLOCK=off (the owner only: sideload could then sign at the same time).';

// Helpers that are alive: killed when the lab exits (also through the interrupt module's
// process.exit), so none outlives it. A lab killed outright closes the helper's stdin, which ends it too.
const live = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => { for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
}

// Takes the lock. Returns { release() } (idempotent), or { skipped: true, release() } when there is
// nothing to lock against (no sideload folder; `disabled: true` too when MSL_SIGNLOCK=off turned it off). Throws `needs: busy` when sideload
// holds it, an InterruptError when the command is interrupted, and an Error for anything else.
export async function acquire() {
  if (process.env.MSL_SIGNLOCK === 'off') return skipped({ disabled: true });
  if (!isDir(lockDir())) return skipped();
  if (interrupted()) throw new InterruptError(interrupted());
  const file = lockFile();
  const child = spawn(helper.cmd, ['-e', helper.script, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(child);
  hookExit();
  child.stdin.on('error', () => { /* the helper ended: nothing to close */ });
  let out = '', err = '', exit = null;
  const closed = new Promise(resolve => {
    child.once('error', e => { exit = { error: e }; resolve(); });
    child.once('close', (code, signal) => { exit ??= { code, signal }; resolve(); });
  });
  closed.then(() => live.delete(child));
  child.stderr.on('data', c => { err = (err + c).slice(-2048); });
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };

  const signal = requestSignal();
  let onAbort, timer;
  const settled = await new Promise(resolve => {
    child.stdout.on('data', c => {
      out += c;
      if (out.includes('locked\n')) resolve('locked');
    });
    closed.then(() => resolve('ended'));
    timer = setTimeout(() => resolve('timeout'), WAIT.acquireMs);
    onAbort = () => resolve('interrupted');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  clearTimeout(timer);
  signal.removeEventListener('abort', onAbort);

  if (settled === 'locked') {
    let released = null;
    return {
      pid: child.pid,
      release: () => released ??= (async () => {
        try { child.stdin.end(); } catch { /* gone */ }
        const t = setTimeout(kill, WAIT.releaseMs);
        await Promise.race([closed, new Promise(r => setTimeout(r, WAIT.releaseMs + 1e3).unref())]);
        clearTimeout(t);
        live.delete(child);
      })(),
    };
  }

  kill();
  await Promise.race([closed, new Promise(r => setTimeout(r, 1e3).unref())]);
  if (settled === 'interrupted') throw new InterruptError(interrupted() ?? 'SIGTERM');
  if (settled === 'timeout') throw new Error(`the signing lock helper did not answer within ${Math.round(WAIT.acquireMs / 1000)}s, so the lock on ${file} was not taken and nothing was started. Run the command again; if it keeps happening, check that ${helper.cmd} works (try \`${helper.cmd} -e 'print 1'\`). ${OFF_HINT}`);
  if (exit?.error) throw new Error(`couldn't run ${helper.cmd} to take the signing lock on ${file}: ${exit.error.message}. The lock needs ${helper.cmd}, which ships with macOS; restore it. ${OFF_HINT}`);
  if (exit?.code === BUSY_EXIT) {
    throw needsError('busy', `sideload holds the signing lock (${file}), so the lab did not sign or install anything`);
  }
  if (exit?.code === OPEN_EXIT) {
    throw new Error(`couldn't open the signing lock file ${file} (it may be a symlink, which the lab does not follow, or a file you can't read and write). Nothing was started. Stop sideload, then check the file with \`ls -l ${file}\` and remove it if it is a link or has the wrong owner (sideload makes it again). ${OFF_HINT}`);
  }
  const why = err.trim().split('\n').slice(-2).join(' ');
  throw new Error(`the signing lock helper failed (${exit?.signal ? `signal ${exit.signal}` : `exit ${exit?.code}`})${why ? `: ${why}` : ''}. Nothing was started; run the command again. ${OFF_HINT}`);
}

// An early look at the lock (`lab up` runs it before it starts anything on a new phone session): the same non-blocking
// take as acquire, let go at once. Resolves { free: true }, { busy: true, error } (error is acquire's `needs: busy`), or
// { skipped: true } (`disabled: true` too when MSL_SIGNLOCK=off); anything else acquire throws (an interrupt, a failed helper) is thrown.
// It holds nothing afterwards: sideload may take the lock before the real acquire, which still decides.
export async function probe() {
  let lock;
  try { lock = await acquire(); } catch (e) {
    if (e?.extra?.needs === 'busy') return { busy: true, error: e };
    throw e;
  }
  await lock.release();
  return lock.skipped ? { skipped: true, ...(lock.disabled ? { disabled: true } : {}) } : { free: true };
}
