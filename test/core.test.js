import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import path from 'node:path';
import { cli, run, setRunner, setUid, saveState, loadState, stateDir, sleep, currentRun, runsRoot, maskDevices, logRun, newRun, artifact, runForSession, markSessionRun } from '../lib/core.js';

beforeEach(() => { sandbox(); });

// Runs cli with console.log captured; returns { code, out }.
async function capture(handlers, argv, opts) {
  const printed = [];
  const orig = console.log;
  console.log = l => printed.push(l);
  try {
    const code = await cli(handlers, argv, opts);
    return { code, out: JSON.parse(printed[0]) };
  } finally { console.log = orig; }
}

test('the default runner kills a command that outlives its timeout and reports exit 124', async () => {
  // A separate module instance keeps the real runner (the shared one is replaced below).
  const real = await import('../lib/core.js?real');
  const t = Date.now();
  const r = real.run('sleep', ['30'], { allowFail: true, timeoutMs: 150 });
  assert.equal(r.code, 124);
  assert.match(r.stderr, /timed out after/);
  assert.ok(Date.now() - t < 15e3, 'killed at the limit, not left to sleep 30 s');
  assert.throws(() => real.run('sleep', ['5'], { timeoutMs: 100 }), /failed \(exit 124\)/);
});

test('run hands its timeout to the runner', () => {
  const seen = [];
  setRunner((_cmd, _args, opts) => { seen.push(opts); return { code: 0, stdout: '', stderr: '' }; });
  run('x', [], { timeoutMs: 5000 });
  assert.deepEqual(seen, [{ timeoutMs: 5000 }]);
});

test('saveState writes atomically: no temp file is left and readers see whole files', () => {
  for (let i = 0; i < 20; i++) saveState({ n: i, big: 'x'.repeat(5000) });
  assert.deepEqual(fs.readdirSync(stateDir()), ['state.json']);
  assert.equal(loadState().n, 19);
});

test('cli runs before, the handler, then after, and prints a before-note as `lease`', async () => {
  const order = [];
  const handlers = { go: async argv => { order.push(['go', argv]); return { x: 1 }; } };
  const { code, out } = await capture(handlers, ['go', 'a'], {
    before: async (name, args) => { order.push(['before', name, args]); return { note: { tookOver: 'z' } }; },
    after: async (name, res) => { order.push(['after', name, res]); },
  });
  assert.equal(code, 0);
  assert.deepEqual(out, { ok: true, x: 1, lease: { tookOver: 'z' } });
  assert.deepEqual(order, [['before', 'go', ['a']], ['go', ['a']], ['after', 'go', { x: 1 }]]);
});

test('a refusal from before stops the handler, merges `extra`, and skips the artifacts hook', async () => {
  let ran = false, artifacts = 0;
  const handlers = { go: () => { ran = true; return {}; } };
  const refuse = () => { throw Object.assign(new Error('nope'), { extra: { lease: { owner: 'a' } }, skipArtifacts: true }); };
  const { code, out } = await capture(handlers, ['go'], { before: refuse, onError: async () => { artifacts++; return { artifacts: 1 }; } });
  assert.equal(code, 1);
  assert.deepEqual(out, { ok: false, error: 'nope', lease: { owner: 'a' } });
  assert.equal(ran, false);
  assert.equal(artifacts, 0);

  // An ordinary failure still gets its artifacts, and after is not called.
  let afterCalls = 0;
  const boom = { go: () => { throw new Error('boom'); } };
  const r = await capture(boom, ['go'], { onError: async () => ({ artifacts: 1 }), after: () => { afterCalls++; } });
  assert.deepEqual(r.out, { ok: false, error: 'boom', artifacts: 1 });
  assert.equal(afterCalls, 0);
});

test('cli without hooks behaves as before', async () => {
  const { code, out } = await capture({ go: () => ({ ok: false, error: 'soft' }) }, ['go']);
  assert.equal(code, 1);
  assert.deepEqual(out, { ok: false, error: 'soft' });
  assert.equal((await capture({}, ['nope'])).code, 2);
});

test('cli: help words answer before the hooks and handlers; `--` ends the scan', async () => {
  const calls = [];
  const handlers = { go: a => { calls.push(['go', a]); return { ran: true }; }, keys: a => { calls.push(['keys', a]); return {}; } };
  const hooks = { before: n => { calls.push(['before', n]); }, after: n => { calls.push(['after', n]); }, onError: () => { calls.push(['onError']); return {}; } };
  const usage = { overview: 'tool <command>', commands: { go: 'tool go [x]', keys: 'tool keys [--] <text>' } };
  for (const argv of [['help'], ['--help'], ['-h'], ['go', '--help'], ['go', 'x', '-h'], ['help', 'go'], ['--help', 'go'], ['go', '-h', '--', 'y']]) {
    const { code, out } = await capture(handlers, argv, { ...hooks, usage });
    assert.equal(code, 0, argv.join(' '));
    assert.equal(out.ok, true);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual((await capture(handlers, ['go', '--help'], { usage })).out, { ok: true, usage: 'tool go [x]', commands: { go: 'tool go [x]' } });
  assert.deepEqual((await capture(handlers, ['help', 'go'], { usage })).out.commands, { go: 'tool go [x]' });
  const all = (await capture(handlers, ['help'], { usage })).out;
  assert.equal(all.usage, 'tool <command>');
  assert.deepEqual(all.commands, usage.commands);
  // Without a usage option the command names still show.
  assert.deepEqual(Object.keys((await capture(handlers, ['-h'])).out.commands), ['go', 'keys']);

  // After a bare `--` the words are arguments, so the handler and the hooks run.
  const r = await capture(handlers, ['keys', '--', '--help'], { ...hooks, usage });
  assert.equal(r.code, 0);
  assert.deepEqual(calls, [['before', 'keys'], ['keys', ['--', '--help']], ['after', 'keys']]);
});

const PHONE = '00008000-000A1B2C3D4E5F60';
const HEX40 = '0123456789abcdef0123456789ABCDEF01234567';
const SIM = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';

test('maskDevices shows device ids as an ellipsis and the last four characters, and leaves simulator UUIDs', () => {
  assert.equal(maskDevices(`phone ${PHONE}.`), 'phone …5F60.');
  assert.equal(maskDevices(`id=${HEX40}`), 'id=…4567');
  assert.equal(maskDevices(`${PHONE} and ${PHONE.toLowerCase()}`), '…5F60 and …5f60');
  assert.equal(maskDevices(`sim ${SIM}`), `sim ${SIM}`);
  assert.equal(maskDevices('00008000-000A1B2C3D4E5F6 short, 0123456789abcdef not an id'), '00008000-000A1B2C3D4E5F6 short, 0123456789abcdef not an id');
});

test('cli masks device ids in ok and error output, but not simulator UUIDs', async () => {
  const handlers = {
    status: () => ({ udid: SIM, phone: { udid: PHONE }, target: { device: PHONE }, id: HEX40 }),
    boom: () => { throw new Error(`could not reach ${PHONE}`); },
    soft: () => ({ ok: false, error: `${PHONE} is busy` }),
  };
  const ok = await capture(handlers, ['status']);
  assert.deepEqual(ok.out, { ok: true, udid: SIM, phone: { udid: '…5F60' }, target: { device: '…5F60' }, id: '…4567' });
  const bad = await capture(handlers, ['boom']);
  assert.deepEqual(bad.out, { ok: false, error: 'could not reach …5F60' });
  assert.equal((await capture(handlers, ['soft'])).out.error, '…5F60 is busy');
});

test('cli keeps the whole id when unmask says so; handler return values stay whole', async () => {
  let returned;
  const handlers = { phone: ([sub]) => (returned = { sub, phone: { udid: PHONE } }) };
  const unmask = (name, args) => name === 'phone' && ['status', 'setup'].includes(args[0]);
  assert.equal((await capture(handlers, ['phone', 'status'], { unmask })).out.phone.udid, PHONE);
  assert.equal((await capture(handlers, ['phone', 'setup'], { unmask })).out.phone.udid, PHONE);
  assert.equal((await capture(handlers, ['phone', 'forget'], { unmask })).out.phone.udid, '…5F60');
  assert.equal(returned.phone.udid, PHONE);
  assert.equal((await capture(handlers, ['phone', 'status'])).out.phone.udid, '…5F60');
});

test('logRun masks device ids in run.log', () => {
  logRun(`safari start --device ${PHONE} ${SIM} https://example.com/?token=abc`);
  const line = fs.readFileSync(path.join(currentRun(), 'run.log'), 'utf8');
  assert.ok(!line.includes(PHONE));
  assert.match(line, /safari start --device …5F60 6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D /);
  assert.ok(!line.includes('token=abc'));
});

test('cli: an unknown command exits 2 and carries the usage', async () => {
  const { code, out } = await capture({ go: () => ({}) }, ['toString'], { usage: { overview: 'tool <command>', commands: {} } });
  assert.equal(code, 2);
  assert.equal(out.usage, 'tool <command>');
  assert.deepEqual(out.commands, ['go']);
});

test('sleep resolves after the given delay', async () => {
  const t = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t >= 15);
});

test('currentRun reuses a run folder under the runs root, and starts a new one for any other path', () => {
  const mine = path.join(runsRoot(), '20261016-100000-session');
  fs.mkdirSync(mine, { recursive: true });
  saveState({ run: mine });
  assert.equal(currentRun(), mine);
  // An existing folder elsewhere (an old scratch folder) is not a run folder.
  const elsewhere = path.join(stateDir(), 'scratch');
  fs.mkdirSync(elsewhere, { recursive: true });
  for (const bad of [elsewhere, path.join(mine, 'nested'), path.join(runsRoot(), 'gone-20261016')]) {
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    if (bad !== path.join(runsRoot(), 'gone-20261016')) fs.mkdirSync(bad, { recursive: true });
    saveState({ run: bad });
    const got = currentRun();
    assert.notEqual(got, bad);
    assert.equal(path.dirname(got), runsRoot());
    assert.match(path.basename(got), /^\d{8}-\d{6}-adhoc$/);
    assert.equal(loadState().run, got);
  }
});

test('currentRun refuses the runs root\'s `..` and `.`, a link under it, and a folder not named like a run', () => {
  const elsewhere = path.join(stateDir(), 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(runsRoot(), { recursive: true });
  const link = path.join(runsRoot(), '20261016-110000-link');
  fs.symlinkSync(elsewhere, link);
  const plain = path.join(runsRoot(), 'notes');
  fs.mkdirSync(plain);
  for (const bad of [path.join(runsRoot(), '..'), path.join(runsRoot(), '.'), link, plain]) {
    saveState({ run: bad });
    const got = currentRun();
    assert.notEqual(got, bad);
    assert.equal(path.dirname(got), runsRoot());
    assert.match(path.basename(got), /^\d{8}-\d{6}-adhoc$/);
    assert.equal(fs.lstatSync(got).isSymbolicLink(), false);
  }
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link');
});

test('artifact names: a plain name goes into the run folder, a trailing extension is not doubled, a path is refused', () => {
  const dir = currentRun();
  assert.equal(artifact('home', 'png'), path.join(dir, 'home.png'));
  assert.equal(artifact('home.png', 'png'), path.join(dir, 'home.png'));
  assert.equal(artifact('Home.PNG', 'png'), path.join(dir, 'Home.png'));
  assert.equal(artifact('my shot', 'png'), path.join(dir, 'my-shot.png'));
  assert.equal(artifact('page.png', 'html'), path.join(dir, 'page.png.html'), 'only its own extension is dropped');
  fs.writeFileSync(path.join(dir, 'home.png'), '');
  assert.equal(artifact('home.png', 'png'), path.join(dir, 'home-2.png'));
  for (const p of ['/Users/me/runs/X/mc.png', 'sub/mc.png', '../mc.png', 'C:\\tmp\\mc.png']) {
    assert.throws(() => artifact(p, 'png'), /is a path: the name is a file name only.*Pass just the name/, p);
  }
});

test('a refused artifact name makes no run folder', () => {
  assert.throws(() => artifact('/x/y.png', 'png'), /is a path/);
  assert.equal(fs.existsSync(runsRoot()), false);
});

test('a session uses the run `sim run` just made, and rotates once that run has hosted one', () => {
  const labelled = newRun('iphone-recheck');
  assert.equal(runForSession(), labelled, 'the labelled run is used');
  assert.equal(loadState().run, labelled);
  assert.deepEqual(fs.readdirSync(runsRoot()), [path.basename(labelled)], 'no second folder');
  assert.equal(runForSession(), labelled, 'a start that failed and is retried keeps it');
  markSessionRun();
  const next = runForSession();
  assert.notEqual(next, labelled);
  assert.match(path.basename(next), /^\d{8}-\d{6}-session$/);
  // A newer `sim run` after that session is used by the next one.
  const later = newRun('second-check', new Date(Date.now() + 5000));
  assert.equal(runForSession(), later);
});

test('with no run, or only the catch-all adhoc one, a session starts a fresh run', () => {
  const first = runForSession();
  assert.match(path.basename(first), /^\d{8}-\d{6}-session$/);
  const adhoc = newRun('adhoc', new Date(Date.now() + 5000));
  const got = runForSession();
  assert.notEqual(got, adhoc);
  assert.match(path.basename(got), /-session$/);
});

test('cli: an unknown command word is printed only if it looks like a command name', async () => {
  const C = 'CANARY-zq7k';
  for (const word of [`--storage=tok=${C}`, `tok=${C}`, `Open${C}`, '', 'a'.repeat(40)]) {
    const { code, out } = await capture({ go: () => ({}) }, [word, 'open', 'https://o.test/']);
    assert.equal(code, 2);
    assert.equal(out.error, 'unknown command (argument #1)', word);
  }
  assert.equal((await capture({ go: () => ({}) }, ['gone'])).out.error, 'unknown command "gone"');
  assert.equal((await capture({ go: () => ({}) }, [])).out.error, 'unknown command ""');
});

// --- refusing root ---

// Runs `fn` as uid 0 with MSL_ALLOW_ROOT set to `allow` (undefined = unset), then restores both.
async function asRoot(allow, fn) {
  const was = process.env.MSL_ALLOW_ROOT;
  if (allow === undefined) delete process.env.MSL_ALLOW_ROOT; else process.env.MSL_ALLOW_ROOT = allow;
  setUid(() => 0);
  try { return await fn(); } finally {
    setUid(() => process.getuid?.());
    if (was === undefined) delete process.env.MSL_ALLOW_ROOT; else process.env.MSL_ALLOW_ROOT = was;
  }
}

test('as root a command is refused with one JSON object, exit 1, and nothing runs', async () => {
  let ran = 0;
  const handlers = { go: () => { ran++; return {}; } };
  const hooks = { before: () => { ran++; }, after: () => { ran++; } };
  const { code, out } = await asRoot(undefined, () => capture(handlers, ['go'], hooks));
  assert.equal(code, 1);
  assert.deepEqual(out, { ok: false, error: 'refusing to run as root: run it as your own user, without sudo' });
  assert.equal(ran, 0);
  assert.equal((await asRoot('0', () => capture(handlers, ['go']))).code, 1, 'only MSL_ALLOW_ROOT=1 lifts it');
  assert.match((await asRoot(undefined, () => capture(handlers, ['nope']))).out.error, /^refusing to run as root/, 'an unknown command is refused first');
});

test('as root, help still answers', async () => {
  const handlers = { go: () => ({}) };
  for (const argv of [['help'], ['--help'], ['go', '-h']]) {
    const { code, out } = await asRoot(undefined, () => capture(handlers, argv));
    assert.equal(code, 0, argv.join(' '));
    assert.equal(out.ok, true);
  }
});

test('MSL_ALLOW_ROOT=1 lets root run (the tests do), and a normal user is never refused', async () => {
  const handlers = { go: () => ({ x: 1 }) };
  const { code, out } = await asRoot('1', () => capture(handlers, ['go']));
  assert.deepEqual([code, out], [0, { ok: true, x: 1 }]);
  const was = process.env.MSL_ALLOW_ROOT;
  delete process.env.MSL_ALLOW_ROOT;
  setUid(() => 501);
  try { assert.equal((await capture(handlers, ['go'])).code, 0); } finally {
    setUid(() => process.getuid?.());
    process.env.MSL_ALLOW_ROOT = was;
  }
});
