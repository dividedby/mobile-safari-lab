import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, fakeRunner } from './helpers.js';
import { stateDir } from '../lib/core.js';
import * as lease from '../lib/lease.js';

const T0 = Date.parse('2026-10-15T12:00:00Z');
let clock;
const advance = s => { clock += s * 1000; };
const SAVED = {};
const ENV = ['MSL_OWNER', 'CLAUDE_CODE_SESSION_ID', 'MSL_LEASE_TTL'];

beforeEach(() => {
  sandbox();
  for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; }
  clock = T0;
  lease.setClock(() => clock);
  Object.assign(lease.MUTEX, { retryMs: 5, waitMs: 3000, staleMs: 10e3 });
});
afterEach(() => {
  for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  lease.setClock(() => Date.now());
});

const file = () => path.join(stateDir(), 'lease.json');
const onDisk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

// --- who is asking ---

test('owner is MSL_OWNER, else the Claude session id, else user@host:tty', () => {
  const calls = fakeRunner((_c, a) => a[0] === '-o' ? { stdout: 'ttys004\n' } : undefined);
  assert.match(lease.owner(), /^.+@.+:ttys004$/);
  assert.deepEqual(calls[0], ['ps', '-o', 'tty=', '-p', String(process.ppid)]);
  process.env.CLAUDE_CODE_SESSION_ID = ' sess-123 ';
  assert.equal(lease.owner(), 'sess-123');
  process.env.MSL_OWNER = 'agent-a';
  assert.equal(lease.owner(), 'agent-a');
});

test('a shell without a terminal is "notty"', () => {
  fakeRunner(() => ({ stdout: '??\n' }));
  assert.match(lease.owner(), /:notty$/);
  fakeRunner(() => ({ code: 1 }));
  assert.match(lease.owner(), /:notty$/);
});

test('an owner that is blank, too long or has control characters is refused', () => {
  for (const bad of ['   ', 'x'.repeat(201), 'a\nb', 'a\u0007b']) {
    process.env.MSL_OWNER = bad;
    assert.throws(() => lease.owner(), /1 to 200 characters/, JSON.stringify(bad));
  }
  process.env.MSL_OWNER = 'x'.repeat(200);
  assert.equal(lease.owner().length, 200);
});

test('the TTL is 15 minutes unless MSL_LEASE_TTL says 1 to 86400 seconds', () => {
  assert.equal(lease.ttlMs(), 900e3);
  process.env.MSL_LEASE_TTL = '30';
  assert.equal(lease.ttlMs(), 30e3);
  for (const bad of ['0', '86401', '1.5', 'abc', '-3']) {
    process.env.MSL_LEASE_TTL = bad;
    assert.throws(() => lease.ttlMs(), /MSL_LEASE_TTL/, bad);
  }
});

// --- acquire, renew, refuse, take over ---

test('acquire creates the lease, then renews it and keeps `since`', async () => {
  assert.equal(lease.read(), null);
  const a = await lease.acquire({ owner: 'a' });
  assert.equal(a.action, 'created');
  assert.deepEqual(onDisk(), { owner: 'a', since: '2026-10-15T12:00:00.000Z', expires: '2026-10-15T12:15:00.000Z' });
  advance(300);
  assert.equal((await lease.acquire({ owner: 'a' })).action, 'renewed');
  assert.deepEqual(onDisk(), { owner: 'a', since: '2026-10-15T12:00:00.000Z', expires: '2026-10-15T12:20:00.000Z' });
  assert.deepEqual(fs.readdirSync(stateDir()).sort(), ['activity.json', 'lease.json']); // no lock dir, no temp file
});

test('another owner is refused with who, until when and how to take over', async () => {
  await lease.acquire({ owner: 'agent-a' });
  advance(60);
  const err = await lease.acquire({ owner: 'agent-b' }).catch(e => e);
  assert.match(err.message, /^Simulator is leased by "agent-a" until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d \(taken \d{4}-/);
  assert.match(err.message, /`lab release --force` or `lab up --force`/);
  assert.equal(new Date(err.message.match(/until (\S+)/)[1]).toISOString(), '2026-10-15T12:15:00.000Z');
  assert.deepEqual(err.extra, { lease: { owner: 'agent-a', since: '2026-10-15T12:00:00.000Z', expires: '2026-10-15T12:15:00.000Z' } });
  assert.equal(err.skipArtifacts, true);
  assert.equal(onDisk().owner, 'agent-a'); // untouched
});

test('an expired lease is taken over and the takeover is reported', async () => {
  await lease.acquire({ owner: 'agent-a' });
  advance(900); // exactly at expiry counts as expired
  const r = await lease.acquire({ owner: 'agent-b' });
  assert.equal(r.action, 'took over expired lease of agent-a');
  assert.equal(r.previous.owner, 'agent-a');
  assert.equal(onDisk().owner, 'agent-b');
  assert.equal(onDisk().since, '2026-10-15T12:15:00.000Z');
});

test('a corrupt lease file counts as expired', async () => {
  fs.mkdirSync(stateDir(), { recursive: true });
  for (const junk of ['not json', '[]', '{"owner":"a"}', '{"owner":"a","since":"x","expires":"y"}', '{"owner":"","since":"2026-10-15T12:00:00Z","expires":"2026-10-15T13:00:00Z"}']) {
    fs.writeFileSync(file(), junk);
    assert.deepEqual(lease.read(), { corrupt: true }, junk);
    const r = await lease.acquire({ owner: 'b' });
    assert.match(r.action, /^took over expired lease of an unreadable lease file/);
    fs.rmSync(file());
  }
});

test('--force takes a live lease and says from whom', async () => {
  await lease.acquire({ owner: 'agent-a' });
  const r = await lease.acquire({ owner: 'agent-b', force: true });
  assert.equal(r.action, 'forced lease from agent-a');
  assert.equal(onDisk().owner, 'agent-b');
});

test('touch renews only the owner\'s own lease and never creates one', async () => {
  assert.equal(await lease.touch({ owner: 'a' }), false);
  assert.equal(lease.read(), null);
  await lease.acquire({ owner: 'a' });
  advance(600);
  assert.equal(await lease.touch({ owner: 'b' }), false);
  assert.equal(onDisk().expires, '2026-10-15T12:15:00.000Z');
  assert.equal(await lease.touch({ owner: 'a' }), true);
  assert.equal(onDisk().expires, '2026-10-15T12:25:00.000Z');
  assert.equal(onDisk().since, '2026-10-15T12:00:00.000Z');
});

test('release: own lease goes, none is fine, another\'s needs --force unless it expired', async () => {
  assert.deepEqual(await lease.release({ owner: 'a' }), { released: false });
  await lease.acquire({ owner: 'a' });
  assert.deepEqual(await lease.release({ owner: 'a' }), { released: true });
  assert.equal(lease.read(), null);

  await lease.acquire({ owner: 'a' });
  const err = await lease.release({ owner: 'b' }).catch(e => e);
  assert.match(err.message, /leased by "a"/);
  assert.equal(err.skipArtifacts, true);
  assert.equal(onDisk().owner, 'a');
  assert.deepEqual(await lease.release({ owner: 'b', force: true }), { released: true, was: 'a' });
  assert.equal(lease.read(), null);

  await lease.acquire({ owner: 'a' });
  advance(901);
  assert.equal((await lease.release({ owner: 'b' })).released, true);
});

// --- hooks ---

test('guard takes the lease for named commands, renews after, releases on stop, and notes a takeover', async () => {
  process.env.MSL_OWNER = 'me';
  const g = lease.guard(new Set(['tap', 'stop']));
  assert.equal(await g.before('shot'), undefined);
  assert.equal(lease.read(), null); // not a leased command

  assert.equal(await g.before('tap'), undefined);
  assert.equal(onDisk().owner, 'me');
  advance(100);
  await g.after('tap');
  assert.equal(onDisk().expires, '2026-10-15T12:16:40.000Z');
  await g.after('shot');
  assert.equal(onDisk().expires, '2026-10-15T12:16:40.000Z');
  await g.after('stop');
  assert.equal(lease.read(), null);

  await lease.acquire({ owner: 'other' });
  await assert.rejects(g.before('tap'), /leased by "other"/);
  advance(901);
  assert.deepEqual(await g.before('tap'), { note: { tookOver: 'other' } });
});

test('guard\'s stderr warning masks a device id in the message', async () => {
  process.env.MSL_OWNER = 'me';
  await lease.acquire({ owner: 'agent-00008000-000A1B2C3D4E5F60' });
  const g = lease.guard(new Set(['stop']));
  const err = console.error;
  const notes = [];
  console.error = m => notes.push(m);
  try { await g.after('stop'); } finally { console.error = err; } // releasing another owner's lease is refused
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^\[lease\] couldn't update the lease: /);
  assert.doesNotMatch(notes[0], /00008000-000A1B2C3D4E5F60/);
  assert.match(notes[0], /…5F60/);
});

// --- concurrency ---

test('eight owners racing for a free lease: exactly one wins', async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => lease.acquire({ owner: `agent-${i}` })));
  const won = results.filter(r => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && /leased by/.test(r.reason.message)).length, 7);
  assert.equal(onDisk().owner, `agent-${results.findIndex(r => r.status === 'fulfilled')}`);
});

test('four processes racing for a free lease: exactly one wins', async () => {
  const lib = path.resolve(import.meta.dirname, '../lib/lease.js');
  const code = `import(${JSON.stringify(lib)}).then(async m => { try { await m.acquire(); console.log('won'); } catch (e) { console.log(/leased by/.test(e.message) ? 'refused' : 'error ' + e.message); } });`;
  const outs = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, MSL_OWNER: `proc-${i}` } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  })));
  assert.equal(outs.filter(o => o === 'won').length, 1, outs.join(','));
  assert.equal(outs.filter(o => o === 'refused').length, 3, outs.join(','));
});

test('a lock left by a crashed process is cleared once it is stale; a fresh one makes acquire give up', async () => {
  const lock = path.join(stateDir(), 'lease.lock');
  fs.mkdirSync(lock, { recursive: true });
  lease.MUTEX.waitMs = 80;
  await assert.rejects(lease.acquire({ owner: 'a' }), /lease is busy, retry/);
  assert.ok(fs.existsSync(lock)); // a live holder's lock is left alone

  const old = new Date(Date.now() - 60e3);
  fs.utimesSync(lock, old, old);
  assert.equal((await lease.acquire({ owner: 'a' })).action, 'created');
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(stateDir()).sort(), ['activity.json', 'lease.json']);
});

test('takeoverNote names who was displaced, and is undefined when nobody was', () => {
  assert.equal(lease.takeoverNote({ action: 'created', found: 'no lease' }), undefined);
  assert.deepEqual(lease.takeoverNote({ action: 'took over expired lease of x', previous: { owner: 'x' } }), { tookOver: 'x' });
  assert.deepEqual(lease.takeoverNote({ action: 'took over expired lease of an unreadable lease file', previous: { corrupt: true } }), { tookOver: 'an unreadable lease file' });
  assert.deepEqual(lease.takeoverNote({ action: 'forced lease from y', previous: { owner: 'y' } }), { forced: 'y' });
});

// --- check (lab down) ---

test('check lets the owner, an expired lease and no lease through, and writes nothing', async () => {
  assert.deepEqual(await lease.check({ owner: 'a' }), { found: 'no lease' });
  assert.ok(!fs.existsSync(file()));
  await lease.acquire({ owner: 'a' });
  const text = fs.readFileSync(file(), 'utf8');
  advance(60);
  assert.deepEqual(await lease.check({ owner: 'a' }), { found: 'leased by this owner' });
  advance(1000);
  assert.deepEqual(await lease.check({ owner: 'b' }), { found: 'expired lease of a' });
  assert.equal(fs.readFileSync(file(), 'utf8'), text);
  fs.writeFileSync(file(), 'junk');
  assert.match((await lease.check({ owner: 'b' })).found, /unreadable/);
});

test('check refuses a live lease of another owner with the usual wording, unless forced', async () => {
  await lease.acquire({ owner: 'a' });
  const text = fs.readFileSync(file(), 'utf8');
  await assert.rejects(lease.check({ owner: 'b' }), /leased by "a" until .*`lab release --force` or `lab up --force`/);
  assert.match((await lease.check({ owner: 'b', force: true })).found, /^leased by "a" until /);
  assert.equal(fs.readFileSync(file(), 'utf8'), text); // forced or not, check changes nothing
});

// --- the last command (activity.json) and the idle stop ---

const activityFile = () => path.join(stateDir(), 'activity.json');
const activityOnDisk = () => JSON.parse(fs.readFileSync(activityFile(), 'utf8')).at;
const iso = ms => new Date(ms).toISOString();
const setActivity = text => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(activityFile(), text); };
const MIN = 60e3;
const THRESHOLD = 15 * MIN;

test('acquire, touch and release record the time of the last command; a refused one and another owner\'s touch do not', async () => {
  assert.equal(lease.lastActive(), null);
  await lease.acquire({ owner: 'a' });
  assert.equal(activityOnDisk(), iso(T0));
  advance(60);
  assert.equal(await lease.touch({ owner: 'a' }), true);
  assert.equal(activityOnDisk(), iso(T0 + 60e3));
  advance(60);
  await assert.rejects(lease.acquire({ owner: 'b' }), /leased by "a"/);
  assert.equal(await lease.touch({ owner: 'b' }), false);
  assert.equal(activityOnDisk(), iso(T0 + 60e3), 'nothing happened, so nothing is recorded');
  advance(60);
  await lease.release({ owner: 'a' });
  assert.equal(activityOnDisk(), iso(T0 + 180e3));
  assert.equal(lease.lastActive(), T0 + 180e3);
  assert.equal(lease.read(), null);
});

test('acquireIdle refuses a live lease, and a recent command, and starts the clock when there is no record', async () => {
  // No record at all: the clock starts now and nothing is taken.
  const first = await lease.acquireIdle({ thresholdMs: THRESHOLD });
  assert.equal(first.idle, false);
  assert.match(first.reason, /idle clock starts now/);
  assert.equal(activityOnDisk(), iso(T0));
  assert.equal(lease.read(), null);

  // A command 5 minutes ago.
  advance(300);
  const recent = await lease.acquireIdle({ thresholdMs: THRESHOLD });
  assert.deepEqual([recent.idle, recent.lastActive], [false, T0]);
  assert.match(recent.reason, /last command 5 min ago, under the 15 min threshold/);
  assert.equal(lease.read(), null);

  // A live lease, however old the last command.
  fs.writeFileSync(file(), JSON.stringify({ owner: 'a', since: iso(T0), expires: iso(T0 + 3600e3) }));
  advance(1800);
  const live = await lease.acquireIdle({ thresholdMs: THRESHOLD });
  assert.equal(live.idle, false);
  assert.match(live.reason, /in use: leased by "a"/);
  assert.equal(onDisk().owner, 'a');
});

test('acquireIdle takes the lease when it is absent, expired or unreadable and the last command is old; the idle lease is not activity', async () => {
  await lease.acquire({ owner: 'a' });
  await lease.release({ owner: 'a' });
  advance(16 * 60);
  const got = await lease.acquireIdle({ thresholdMs: THRESHOLD });
  assert.deepEqual([got.idle, got.lastActive], [true, T0]);
  assert.deepEqual(onDisk(), { owner: 'msl-idle', since: iso(T0 + 960e3), expires: iso(T0 + 960e3 + 600e3) });
  assert.equal(activityOnDisk(), iso(T0), 'the stop itself is not a command');

  // Expired (an old lease nobody released) and unreadable ones count as no lease.
  fs.writeFileSync(file(), JSON.stringify({ owner: 'a', since: iso(T0), expires: iso(T0 + 900e3) }));
  assert.equal((await lease.acquireIdle({ thresholdMs: THRESHOLD })).idle, true);
  assert.equal(onDisk().owner, 'msl-idle');
  fs.writeFileSync(file(), 'not json');
  assert.equal((await lease.acquireIdle({ thresholdMs: THRESHOLD })).idle, true);
  assert.equal(onDisk().owner, 'msl-idle');
});

test('idleState looks and takes nothing; an activity time in the future starts the clock again', async () => {
  setActivity(JSON.stringify({ at: iso(T0 - 3600e3) }));
  assert.deepEqual(await lease.idleState({ thresholdMs: THRESHOLD }), { idle: true, lastActive: T0 - 3600e3 });
  assert.equal(lease.read(), null);
  setActivity(JSON.stringify({ at: iso(T0 + 3600e3) }));
  const r = await lease.idleState({ thresholdMs: THRESHOLD });
  assert.equal(r.idle, false);
  assert.equal(activityOnDisk(), iso(T0));
  setActivity('garbage');
  assert.equal(lease.lastActive(), null);
  assert.equal((await lease.idleState({ thresholdMs: THRESHOLD })).idle, false);
  assert.equal(activityOnDisk(), iso(T0));
});

test('the race with `lab up`: whoever takes the lease first wins, and the other is told', async () => {
  setActivity(JSON.stringify({ at: iso(T0 - 3600e3) }));
  // The idle stop first: `up` is refused with a message that says why and how long.
  assert.equal((await lease.acquireIdle({ thresholdMs: THRESHOLD })).idle, true);
  await assert.rejects(lease.acquire({ owner: 'agent' }), e => {
    assert.match(e.message, /The idle stop is shutting the lab down.*Retry in a minute/);
    assert.match(e.message, /no idle stop is running.*a crashed one left its lease: `lab release --force` clears it\. Never use --force while a stop is running/);
    assert.equal(e.skipArtifacts, true);
    return true;
  });
  assert.equal((await lease.acquireIdle({ thresholdMs: THRESHOLD })).reason, 'another idle stop is running');
  // `up --force` still wins; the idle stop's next renewal says it lost.
  assert.equal((await lease.acquire({ owner: 'agent', force: true })).action, 'forced lease from msl-idle');
  assert.equal(await lease.touch({ owner: lease.IDLE_OWNER }), false);
  // It must not delete the agent's lease when it hands its own back.
  await assert.rejects(lease.release({ owner: lease.IDLE_OWNER }), /leased by "agent"/);
  assert.equal(onDisk().owner, 'agent');

  // `up` first: the idle stop finds a live lease and takes nothing.
  assert.equal((await lease.acquireIdle({ thresholdMs: THRESHOLD })).idle, false);
});

test('the idle lease renews for 10 minutes whatever MSL_LEASE_TTL says, lapses by itself, and its release is not activity', async () => {
  process.env.MSL_LEASE_TTL = '30';
  setActivity(JSON.stringify({ at: iso(T0 - 3600e3) }));
  await lease.acquireIdle({ thresholdMs: THRESHOLD });
  advance(120);
  assert.equal(await lease.touch({ owner: lease.IDLE_OWNER }), true);
  assert.equal(onDisk().expires, iso(T0 + 120e3 + 600e3));
  assert.deepEqual(await lease.release({ owner: lease.IDLE_OWNER }), { released: true });
  assert.equal(activityOnDisk(), iso(T0 - 3600e3));

  // A reaper that died: the lease expires and the next agent takes over.
  await lease.acquireIdle({ thresholdMs: THRESHOLD });
  advance(601);
  assert.equal((await lease.acquire({ owner: 'agent' })).action, 'took over expired lease of msl-idle');
});

// --- recordActivity and the hold ---

const holdFile = () => path.join(stateDir(), 'hold.json');

test('recordActivity writes the activity time and never takes or renews a lease', async () => {
  assert.equal(await lease.recordActivity(), true);
  assert.equal(activityOnDisk(), iso(T0));
  assert.equal(lease.read(), null);
  await lease.acquire({ owner: 'a' });
  const before = onDisk();
  advance(120);
  await lease.recordActivity();
  assert.equal(activityOnDisk(), iso(T0 + 120e3));
  assert.deepEqual(onDisk(), before, 'the lease is as it was');
  assert.ok(!fs.existsSync(path.join(stateDir(), 'lease.lock')));
});

test('recordActivity is best effort: a busy mutex is a note on stderr, not a failure', async () => {
  Object.assign(lease.MUTEX, { waitMs: 60 });
  fs.mkdirSync(path.join(stateDir(), 'lease.lock'), { recursive: true });
  const lines = [];
  const real = console.error;
  console.error = m => lines.push(String(m));
  try { assert.equal(await lease.recordActivity(), false); } finally { console.error = real; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /couldn't record the activity: the lease is busy/);
  assert.ok(!fs.existsSync(path.join(stateDir(), 'activity.json')));
});

test('setHold takes whole minutes from 1 to 120 and nothing else', async () => {
  for (const bad of [0, 121, 1.5, -1, 'abc', '60', NaN, undefined, null]) {
    assert.throws(() => lease.setHold({ minutes: bad }), /whole number of minutes from 1 to 120/, String(bad));
  }
  assert.ok(!fs.existsSync(holdFile()));
  assert.equal(await lease.setHold({ minutes: 1 }), T0 + 60e3);
  assert.equal(await lease.setHold({ minutes: 120 }), T0 + 7200e3);
});

test('setHold records the end, counts as activity and takes no lease', async () => {
  const until = await lease.setHold({ minutes: 60 });
  assert.equal(until, T0 + 3600e3);
  assert.deepEqual(JSON.parse(fs.readFileSync(holdFile(), 'utf8')), { until: iso(T0 + 3600e3) });
  assert.equal(activityOnDisk(), iso(T0));
  assert.equal(lease.read(), null);
  assert.equal(lease.holdUntil(), T0 + 3600e3);
  advance(3600);
  assert.equal(lease.holdUntil(), null, 'ended');
});

test('a hold file that is damaged, malformed or further out than 120 minutes is ignored', () => {
  fs.mkdirSync(stateDir(), { recursive: true });
  for (const text of ['not json', '{}', '[]', 'null', JSON.stringify({ until: 'tomorrow' }), JSON.stringify({ until: 5 }),
    JSON.stringify({ until: iso(T0 + 121 * 60e3) }), JSON.stringify({ until: iso(T0 + 86400e3) })]) {
    fs.writeFileSync(holdFile(), text);
    assert.equal(lease.holdUntil(), null, text);
  }
  fs.writeFileSync(holdFile(), JSON.stringify({ until: iso(T0 + 120 * 60e3) }));
  assert.equal(lease.holdUntil(), T0 + 7200e3);
});

test('acquireIdle and idleState are refused during a hold, and succeed once the clock passes it', async () => {
  await lease.setHold({ minutes: 60 });
  setActivity(JSON.stringify({ at: iso(T0 - 3600e3) })); // an hour idle, so that only the hold is in the way
  advance(1800);
  const during = await lease.acquireIdle({ thresholdMs: THRESHOLD });
  assert.equal(during.idle, false);
  assert.equal(during.reason, `held until ${lease.localIso(T0 + 3600e3)}`);
  assert.equal(lease.read(), null, 'nothing was taken');
  assert.equal((await lease.idleState({ thresholdMs: THRESHOLD })).idle, false);

  advance(1801); // past the hold
  assert.equal((await lease.acquireIdle({ thresholdMs: THRESHOLD })).idle, true);
  assert.equal(onDisk().owner, 'msl-idle');
});

test('a live lease is reported before a hold; after the hold the normal threshold applies', async () => {
  await lease.setHold({ minutes: 10 });
  await lease.acquire({ owner: 'a' });
  assert.match((await lease.idleState({ thresholdMs: THRESHOLD })).reason, /in use: leased by "a"/);
  await lease.release({ owner: 'a' });
  advance(11 * 60);
  const r = await lease.idleState({ thresholdMs: THRESHOLD });
  assert.equal(r.idle, false);
  assert.match(r.reason, /last command 11 min ago, under the 15 min threshold/);
  advance(5 * 60);
  assert.equal((await lease.idleState({ thresholdMs: THRESHOLD })).idle, true);
});

test('clearHold ends a hold, and is quiet without one', async () => {
  lease.clearHold();
  await lease.setHold({ minutes: 30 });
  lease.clearHold();
  assert.equal(lease.holdUntil(), null);
  assert.ok(!fs.existsSync(holdFile()));
});
