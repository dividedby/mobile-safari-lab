// SIGINT, SIGTERM and SIGHUP while a command runs: one JSON object, the exit code of the signal,
// no listener left behind, and the cleanup of the command still runs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox, tempDir } from './helpers.js';
import { cli, run, setRunner, setAsyncRunner, runAsync, sleep, saveState, stateDir, DEFAULT_TIMEOUT_MS } from '../lib/core.js';
import { GRACE_MS, InterruptError, SIGNALS, duringCleanup, exitCodeFor, interrupted, requestSignal, withInterrupt } from '../lib/interrupt.js';
import { wd } from '../lib/safari.js';

beforeEach(() => { sandbox(); });

const listeners = () => SIGNALS.map(s => process.listenerCount(s));

async function capture(handlers, argv, opts) {
  const printed = [];
  const orig = console.log;
  console.log = l => printed.push(l);
  try {
    const code = await cli(handlers, argv, opts);
    return { code, printed, out: JSON.parse(printed[0]) };
  } finally { console.log = orig; }
}

const later = (ms, fn) => setTimeout(fn, ms);

test('exit codes are 128 plus the signal number', () => {
  assert.deepEqual(SIGNALS.map(exitCodeFor), [129, 130, 143]);
});

test('sleep rejects at once when the signal arrives mid-wait, and stays rejected afterwards', async () => {
  await withInterrupt(async () => {
    later(20, () => process.emit('SIGTERM', 'SIGTERM'));
    const t = Date.now();
    await assert.rejects(sleep(5000), e => e instanceof InterruptError && e.signal === 'SIGTERM');
    assert.ok(Date.now() - t < 1000);
    assert.equal(interrupted(), 'SIGTERM');
    await assert.rejects(sleep(1), InterruptError); // sticky: a swallowed error does not let the command carry on
  });
  assert.equal(interrupted(), null, 'a new command starts clean');
  await sleep(1);
});

test('a wait during cleanup (duringCleanup) still runs after the signal', async () => {
  await withInterrupt(async () => {
    process.emit('SIGTERM', 'SIGTERM');
    await assert.rejects(sleep(1), InterruptError);
    const t = Date.now();
    await duringCleanup(() => sleep(20));
    assert.ok(Date.now() - t >= 15, 'the cleanup wait ran its course');
  });
});

test('cli: a signal prints one JSON object, skips onError and exits 128 + the signal number', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    let onErrorCalled = false;
    const handlers = { wait: async () => { later(10, () => process.emit(signal, signal)); await sleep(5000); return {}; } };
    const r = await capture(handlers, ['wait'], { onError: async () => { onErrorCalled = true; return { artifacts: 1 }; } });
    assert.equal(r.code, code, signal);
    assert.equal(r.printed.length, 1, 'one JSON object');
    assert.equal(r.out.ok, false);
    assert.equal(r.out.interrupted, signal);
    assert.match(r.out.error, new RegExp(`interrupted by ${signal}`));
    assert.equal(r.out.artifacts, undefined);
    assert.equal(onErrorCalled, false);
    assert.deepEqual(listeners(), [0, 0, 0], 'the handlers are removed');
  }
});

test('cli: an error that is not the interrupt, raised while interrupted, still reports the signal', async () => {
  const handlers = { wait: async () => { process.emit('SIGINT', 'SIGINT'); throw new Error('server not reachable'); } };
  const r = await capture(handlers, ['wait'], { onError: async () => { throw new Error('must not run'); } });
  assert.equal(r.code, 130);
  assert.equal(r.out.interrupted, 'SIGINT');
  assert.equal(r.out.error, 'server not reachable');
});

test('cli: a signal that lands while onError gathers artifacts still marks the result interrupted', async () => {
  const handlers = { go: async () => { throw new Error('server not reachable'); } };
  const r = await capture(handlers, ['go'], { onError: async () => { process.emit('SIGTERM', 'SIGTERM'); return {}; } });
  assert.equal(r.code, 143);
  assert.equal(r.out.interrupted, 'SIGTERM');
  assert.equal(r.out.error, 'server not reachable');
  assert.deepEqual(listeners(), [0, 0, 0]);
});

test('cli: a handler that finishes after the signal keeps its result', async () => {
  const handlers = { go: async () => { process.emit('SIGTERM', 'SIGTERM'); return { value: 7 }; }, bad: async () => { process.emit('SIGTERM', 'SIGTERM'); return { ok: false, error: 'no' }; } };
  const good = await capture(handlers, ['go']);
  assert.equal(good.code, 0);
  assert.deepEqual(good.out, { ok: true, value: 7, interrupted: 'SIGTERM' });
  const bad = await capture(handlers, ['bad']);
  assert.equal(bad.code, 143);
  assert.equal(bad.out.error, 'no');
  assert.equal(bad.out.interrupted, 'SIGTERM');
});

test('cli: help and unknown commands install no handler; an ordinary failure is still exit 1', async () => {
  const before = listeners();
  assert.equal((await capture({ a: () => ({}) }, ['help'])).code, 0);
  assert.equal((await capture({ a: () => ({}) }, ['nope'])).code, 2);
  const r = await capture({ a: () => { throw new Error('plain'); } }, ['a']);
  assert.equal(r.code, 1);
  assert.equal(r.out.interrupted, undefined);
  assert.deepEqual(listeners(), before);
});

test('cli: a finally block of the handler runs when the signal ends its wait', async () => {
  let cleaned = false;
  const handlers = { go: async () => { try { later(10, () => process.emit('SIGTERM', 'SIGTERM')); await sleep(5000); } finally { cleaned = true; } } };
  const r = await capture(handlers, ['go']);
  assert.equal(r.code, 143);
  assert.equal(cleaned, true);
});

test('a child killed by a signal while the lab got none is a failed child: exit 1, named, artifacts kept', async () => {
  setRunner(() => ({ code: 1, stdout: '', stderr: '', signal: 'SIGTERM' }));
  let onErrorCalled = false;
  const r = await capture({ shot: () => run('xcrun', ['simctl', 'io']) }, ['shot'], { onError: async () => { onErrorCalled = true; return { artifacts: 1 }; } });
  assert.equal(r.code, 1);
  assert.equal(r.out.interrupted, undefined);
  assert.equal(r.out.error, 'xcrun simctl was killed by SIGTERM');
  assert.equal(r.out.artifacts, 1);
  assert.equal(onErrorCalled, true);
});

test('a child ended by the signal that also reached the lab is an interrupt (the handler runs after the child returns)', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGHUP', 129]]) {
    setRunner(() => {
      setImmediate(() => process.emit(signal, signal)); // delivered once spawnSync has returned
      return { code: 1, stdout: '', stderr: '', signal };
    });
    const r = await capture({ go: () => run('xcrun', ['simctl', 'io']) }, ['go'], { onError: async () => { throw new Error('must not run'); } });
    assert.equal(r.code, code);
    assert.equal(r.printed.length, 1);
    assert.equal(r.out.interrupted, signal);
  }
});

test('allowFail still tolerates a child killed by a signal', async () => {
  setRunner(() => ({ code: 1, stdout: '', stderr: '', signal: 'SIGTERM' }));
  assert.equal(run('ps', [], { allowFail: true }).code, 1);
  const r = await capture({ go: () => ({ pid: run('ps', [], { allowFail: true }).code }) }, ['go']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { ok: true, pid: 1 });
});

test('a signal that reaches the lab and its sync child after the handler awaited real I/O is still an interrupt', async () => {
  const srv = await hangingServer();
  const code = `
import { cli, run } from ${JSON.stringify(CORE)};
const handlers = {
  async go() {
    const res = await fetch(process.argv[1] + '/ok'); await res.text(); // real I/O: the continuation runs in the poll phase
    run('sh', ['-c', 'kill -INT $PPID; sleep 0.3; kill -INT $$']); // the signal goes to the lab and to the child
    return {};
  },
};
process.exitCode = await cli(handlers, ['go']);
`;
  try {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, srv.url], { env: { ...process.env, MSL_STATE: process.env.MSL_STATE, MSL_RUNS: process.env.MSL_RUNS } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    const exit = await new Promise(r => p.on('close', c => r(c)));
    assert.equal(exit, 130, err + out);
    const json = JSON.parse(out);
    assert.equal(json.interrupted, 'SIGINT');
    assert.equal(json.ok, false);
    assert.equal(json.artifacts, undefined);
  } finally { srv.close(); }
});

test('a command that names no timeout gets the default; one that names its own keeps it', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120e3);
  const real = await import('../lib/core.js?default-timeout');
  assert.equal(real.run('true', []).code, 0); // the real runner, no timeout given
  const t = Date.now();
  assert.equal(real.run('sleep', ['5'], { allowFail: true, timeoutMs: 100 }).code, 124);
  assert.ok(Date.now() - t < 3000);
});

// A server that takes a request and never answers, except /ok.
async function hangingServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/ok') { res.setHeader('content-type', 'application/json'); res.end('{"value":{"ready":true}}'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

test('wd: an interrupt ends a request that gets no answer, and only cleanup may send another', async () => {
  const srv = await hangingServer();
  try {
    await withInterrupt(async () => {
      later(30, () => process.emit('SIGTERM', 'SIGTERM'));
      const t = Date.now();
      await assert.rejects(wd(srv.url, 'GET', '/hang', undefined, 30e3), e => e instanceof InterruptError && e.signal === 'SIGTERM');
      assert.ok(Date.now() - t < 2000);
      // A request made after the signal is refused (a swallowed interrupt must not carry the command on), except cleanup,
      // which is not aborted by the signal that caused it.
      assert.equal(requestSignal().aborted, false);
      await assert.rejects(wd(srv.url, 'GET', '/ok'), InterruptError);
      assert.deepEqual((await duringCleanup(() => wd(srv.url, 'GET', '/ok'))).ready, true);
    });
  } finally { srv.close(); }
});

test('wd: a long wait (over node:http) is interrupted too', async () => {
  const srv = await hangingServer();
  try {
    await withInterrupt(async () => {
      later(30, () => process.emit('SIGHUP', 'SIGHUP'));
      await assert.rejects(wd(srv.url, 'GET', '/hang', undefined, 600e3), e => e instanceof InterruptError && e.signal === 'SIGHUP');
    });
  } finally { srv.close(); }
});

// --- runAsync: a long child that does not block the loop ---

const pidFile = () => path.join(tempDir(), 'child.pid');
// Runs `fn` once the child has written its pid (it is running, with its handlers if any). Polling is bounded:
// if the child never starts, `abort` ends the run (a signal) so it fails now rather than after its own limit,
// and `assertStarted` then reports why. Returns a cancel to call in a `finally` so no interval outlives its test.
const START_WAIT_MS = 10e3;
const whenStarted = (pf, fn, abort) => {
  const deadline = Date.now() + START_WAIT_MS;
  const cancel = () => clearInterval(iv);
  const iv = setInterval(() => {
    if (Date.now() > deadline) { cancel(); cancel.neverStarted = true; abort(); }
    else if (fs.existsSync(pf) && fs.readFileSync(pf, 'utf8')) { cancel(); fn(); }
  }, 20);
  return cancel;
};
const assertStarted = guard => assert.ok(!guard.neverStarted, `the child did not write its pid file within ${START_WAIT_MS / 1000} s`);
const signalWhenStarted = (pf, signal) => whenStarted(pf, () => process.emit(signal, signal), () => process.emit(signal, signal));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('runAsync: output and exit code like run; a timeout ends the child with code 124; the lease tick runs while it works', async () => {
  setAsyncRunner();
  const ok = await runAsync(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
  assert.deepEqual([ok.code, ok.stdout.trim(), ok.stderr.trim()], [3, 'out', 'err']);
  assert.equal((await runAsync('/nonexistent/tool', [])).code, 127);

  let ticks = 0;
  const pf = pidFile();
  const t = Date.now();
  const slow = await runAsync('sh', ['-c', `echo $$ > ${pf}; exec sleep 30`], { timeoutMs: 400, onTick: () => { ticks++; }, tickMs: 50 });
  assert.equal(slow.code, 124);
  assert.match(slow.stderr, /timed out after/);
  assert.ok(Date.now() - t < 5000, 'ended by the limit');
  assert.ok(ticks >= 3, `renewed while it ran (${ticks})`);
  assert.equal(isAlive(Number(fs.readFileSync(pf, 'utf8'))), false, 'the child is gone');
});

test('runAsync: an interrupt ends the child and rejects with the InterruptError within the kill limit; one that comes first is not started', async () => {
  setAsyncRunner();
  const pf = pidFile();
  await withInterrupt(async () => {
    const cancel = signalWhenStarted(pf, 'SIGTERM');
    try {
      const t = Date.now();
      await assert.rejects(runAsync('sh', ['-c', `echo $$ > ${pf}; exec sleep 30`], { timeoutMs: 20e3 }), e => e instanceof InterruptError && e.signal === 'SIGTERM');
      assertStarted(cancel);
      assert.ok(Date.now() - t < 4000, 'bounded');
      assert.equal(isAlive(Number(fs.readFileSync(pf, 'utf8'))), false, 'the build child is killed');
      const pf2 = pidFile();
      await assert.rejects(runAsync('sh', ['-c', `echo $$ > ${pf2}`]), InterruptError);
      assert.equal(fs.existsSync(pf2), false, 'not started after the interrupt');
    } finally { cancel(); }
  });
});

test('runAsync: a timeout and an interrupt both stopping the child send one SIGTERM and one SIGKILL (no kill timer is leaked)', async () => {
  setAsyncRunner();
  const { ChildProcess } = await import('node:child_process');
  const real = ChildProcess.prototype.kill;
  const realSetTimeout = globalThis.setTimeout;
  const sent = [];
  // The limit's timer is captured and run by hand once the child is ready, so the order (the limit asks, then the
  // interrupt asks) cannot depend on how long node takes to start.
  const LIMIT_MS = 123456;
  let fireLimit = null;
  ChildProcess.prototype.kill = function kill(sig) { sent.push(sig); return real.call(this, sig); };
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms === LIMIT_MS) fireLimit = fn; return realSetTimeout(fn, ms, ...rest); };
  const pf = pidFile();
  const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pf)}, String(process.pid)); setInterval(() => {}, 1000);`;
  let cancel = () => {};
  try {
    await withInterrupt(async () => {
      const run = runAsync(process.execPath, ['-e', script], { timeoutMs: LIMIT_MS });
      globalThis.setTimeout = realSetTimeout;
      assert.equal(typeof fireLimit, 'function', 'the limit timer was set');
      cancel = whenStarted(pf, () => { fireLimit(); process.emit('SIGTERM', 'SIGTERM'); }, () => process.emit('SIGTERM', 'SIGTERM'));
      await assert.rejects(run, InterruptError);
      assertStarted(cancel);
    });
  } finally { cancel(); ChildProcess.prototype.kill = real; globalThis.setTimeout = realSetTimeout; }
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
});

test('runAsync: a child that ignores SIGTERM is killed (SIGKILL) and the call still ends', async () => {
  setAsyncRunner();
  const pf = pidFile();
  const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pf)}, String(process.pid)); setInterval(() => {}, 1000);`;
  await withInterrupt(async () => {
    const cancel = signalWhenStarted(pf, 'SIGINT');
    try {
      const t = Date.now();
      await assert.rejects(runAsync(process.execPath, ['-e', script], { timeoutMs: 20e3 }), InterruptError);
      assertStarted(cancel);
      assert.ok(Date.now() - t < 6000, 'bounded by the SIGKILL delay');
      assert.equal(isAlive(Number(fs.readFileSync(pf, 'utf8'))), false);
    } finally { cancel(); }
  });
});

// --- real processes ---

// A command in a real process (node --test would run a script file under test/, so it is given with -e).
// `sync`: a synchronous child (`sleep 2`), then a wait; a signal during the child is handled once it
// returns, and the wait then ends the command. `stuck`: never finishes and waits on nothing the lab can abort.
// Both write `ready` to stderr once the command runs, which is after the lab's signal handlers are installed.
const CORE = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'core.js')).href;
const FIXTURE = `
import { cli, run, sleep } from ${JSON.stringify(CORE)};
const handlers = {
  sync() { process.stderr.write('ready\\n'); run('sleep', ['2']); return sleep(5000).then(() => ({ finished: true })); },
  stuck() { setInterval(() => {}, 1000); process.stderr.write('ready\\n'); return new Promise(() => {}); },
};
process.exitCode = await cli(handlers, process.argv.slice(1));
`;
const BIN = name => path.resolve(import.meta.dirname, '..', 'bin', name);

// Runs a script with the lab's state in the sandbox; `ready` resolves when the fixture says `ready` (bounded, so a child that never starts fails the test).
function child(script, env) {
  const argv = script === FIXTURE ? ['--input-type=module', '-e', FIXTURE, ...(env.args ?? [])] : [script, ...(env.args ?? [])];
  const p = spawn(process.execPath, argv, { env: { ...process.env, ...env.vars }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { err += d; });
  const done = new Promise(r => p.on('close', (code, signal) => r({ code, signal, out, err })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child was not ready after 20 s: ${err}`)), 20e3);
    const check = () => { if (err.includes('ready\n')) { clearTimeout(timer); resolve(); } };
    p.stderr.on('data', check);
    p.on('close', () => { clearTimeout(timer); reject(new Error(`the child ended before it was ready: ${err}`)); });
  });
  ready.catch(() => {}); // a test that never awaits it must not fail on an unhandled rejection
  return { p, done, ready };
}

test('bin/safari: SIGTERM while a request gets no answer exits 143 with one JSON object, leaves no temp file, and keeps the session', async () => {
  const srv = await hangingServer();
  try {
    saveState({ session: 'S1', backend: 'appium', port: 4723, target: { simulator: '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D' } });
    const t = Date.now();
    const { p, done } = child(BIN('safari'), { args: ['url'], vars: { MSL_STATE: process.env.MSL_STATE, MSL_RUNS: process.env.MSL_RUNS, MSL_OWNER: 'me', MSL_APPIUM_URL: srv.url } });
    for (let i = 0; i < 100 && !srv.seen.length; i++) await new Promise(r => setTimeout(r, 50)); // a request is waiting
    assert.ok(srv.seen.length > 0, `the command reached the server (${srv.seen})`);
    p.kill('SIGTERM');
    const r = await done;
    assert.equal(r.code, 143, r.err);
    assert.ok(Date.now() - t < 3000, 'ended by the signal, not by the grace timer');
    const out = JSON.parse(r.out); // exactly one object, nothing else on stdout
    assert.equal(out.ok, false);
    assert.equal(out.interrupted, 'SIGTERM');
    assert.match(out.error, /interrupted by SIGTERM/);
    assert.deepEqual(fs.readdirSync(stateDir()).filter(f => f.endsWith('.tmp')), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir(), 'state.json'), 'utf8')).session, 'S1', 'the session record is kept');
  } finally { srv.close(); }
});

test('a signal during a synchronous child is handled when the child returns (documented limit)', async () => {
  const { p, done, ready } = child(FIXTURE, { args: ['sync'], vars: { MSL_STATE: process.env.MSL_STATE, MSL_RUNS: process.env.MSL_RUNS } });
  await ready;
  const t = Date.now();
  p.kill('SIGTERM');
  const r = await done;
  const took = Date.now() - t;
  assert.equal(r.code, 143, r.err);
  assert.ok(took >= 1500 && took < 6000, `ended after the child, not at once and not after the 5 s wait (${took} ms)`);
  const out = JSON.parse(r.out);
  assert.equal(out.interrupted, 'SIGTERM');
  assert.equal(out.ok, false);
});

test('a second signal ends a command that does not stop at once, with a short JSON object', async () => {
  const { p, done, ready } = child(FIXTURE, { args: ['stuck'], vars: { MSL_STATE: process.env.MSL_STATE, MSL_RUNS: process.env.MSL_RUNS } });
  await ready;
  const t = Date.now();
  p.kill('SIGINT');
  await sleep(100);
  p.kill('SIGINT');
  const r = await done;
  assert.equal(r.code, 130);
  assert.ok(Date.now() - t < 3000);
  assert.equal(JSON.parse(r.out).interrupted, 'SIGINT');
});

test('a command that does not stop within the grace time is ended with a short JSON object', async () => {
  const { p, done, ready } = child(FIXTURE, { args: ['stuck'], vars: { MSL_STATE: process.env.MSL_STATE, MSL_RUNS: process.env.MSL_RUNS } });
  await ready;
  const t = Date.now();
  p.kill('SIGHUP');
  const r = await done;
  assert.equal(r.code, 129);
  const took = Date.now() - t;
  assert.ok(took >= GRACE_MS - 500 && took < GRACE_MS + 3000, `${took} ms`);
  const out = JSON.parse(r.out);
  assert.equal(out.interrupted, 'SIGHUP');
  assert.match(out.error, /did not stop within 8s/);
});
