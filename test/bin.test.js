// The real entry points, run as processes against a temp state dir. Only refusals and
// read-only commands are exercised, so nothing here reaches simctl, Appium or launchd.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.js';
import { stateDir } from '../lib/core.js';

const bin = name => path.resolve(import.meta.dirname, '..', 'bin', name);
let dir;

beforeEach(() => {
  dir = sandbox();
  fs.mkdirSync(stateDir(), { recursive: true });
  const t = Date.now();
  fs.writeFileSync(path.join(stateDir(), 'lease.json'), JSON.stringify({ owner: 'agent-a', since: new Date(t).toISOString(), expires: new Date(t + 600e3).toISOString() }));
});

const call = (name, args, owner = 'agent-b') => {
  const r = spawnSync(process.execPath, [bin(name), ...args], { encoding: 'utf8', env: { ...process.env, MSL_OWNER: owner } });
  return { code: r.status, out: JSON.parse(r.stdout) };
};

test('sim: phone-changing commands are refused while another agent holds the lease', () => {
  for (const args of [['open', 'http://127.0.0.1/'], ['tap', '1', '1'], ['type', 'x'], ['scroll', 'down'], ['swipe', '1', '2', '3', '4'], ['appearance', 'dark'], ['statusbar', 'clear'], ['create'], ['boot'], ['shutdown'], ['reset']]) {
    const { code, out } = call('sim', args);
    assert.equal(code, 1, args[0]);
    assert.equal(out.ok, false, args[0]);
    assert.match(out.error, /leased by "agent-a"/, args[0]);
    assert.equal(out.lease.owner, 'agent-a');
  }
});

test('sim: an unknown --profile is refused before the lease is looked at or taken', () => {
  for (const args of [['boot', '--profile', 'bogus'], ['shutdown', '--profile', 'x'], ['reset', '--profile', 'x', '--yes'], ['create', '--profile', 'work']]) {
    const { code, out } = call('sim', args); // agent-a holds the lease: a lease refusal would show instead
    assert.equal(code, 1, args[0]);
    assert.match(out.error, /--profile must be one of clean, configured/, args[0]);
    assert.equal(out.lease, undefined, args[0]);
  }
  fs.rmSync(path.join(stateDir(), 'lease.json'));
  assert.match(call('sim', ['boot', '--profile', 'bogus']).out.error, /--profile must be one of/);
  assert.ok(!fs.existsSync(path.join(stateDir(), 'lease.json')), 'no lease was taken');
});

test('sim: read-only commands do not need the lease', () => {
  for (const args of [['udid'], ['shot', 'x'], ['ui']]) {
    const { out } = call('sim', args);
    assert.match(out.error, /No simulator yet/, args[0]); // got past the lease, to the missing simulator
  }
});

const activityPath = () => path.join(stateDir(), 'activity.json');

test('sim: shot and ui count as activity for the idle stop, and take no lease', () => {
  fs.rmSync(path.join(stateDir(), 'lease.json'));
  for (const args of [['shot', 'x'], ['ui']]) {
    fs.rmSync(activityPath(), { force: true });
    const before = Date.now();
    const { out } = call('sim', args);
    assert.match(out.error, /No simulator yet/, args[0]); // the command ran (and failed on the missing simulator)
    const at = Date.parse(JSON.parse(fs.readFileSync(activityPath(), 'utf8')).at);
    assert.ok(at >= before - 1000 && at <= Date.now(), `${args[0]} wrote the activity time`);
    assert.ok(!fs.existsSync(path.join(stateDir(), 'lease.json')), `${args[0]} took a lease`);
  }
  fs.rmSync(activityPath());
  call('sim', ['udid']);
  assert.ok(!fs.existsSync(activityPath()), 'udid is not activity');
});

test('sim: a shot refused for the phone session records no activity', () => {
  record({ udid: SIM, session: 'abc', backend: 'appium', port: 4723, target: { device: PHONE } });
  for (const args of [['shot', 'x'], ['ui']]) {
    assert.match(call('sim', args).out.error, /is refused/, args[0]);
    assert.ok(!fs.existsSync(activityPath()), `${args[0]} recorded activity`);
  }
});

test('sim: a busy lease mutex does not fail a shot', () => {
  fs.rmSync(path.join(stateDir(), 'lease.json'));
  fs.mkdirSync(path.join(stateDir(), 'lease.lock')); // a holder that is alive: waits out the 3 s, then goes on
  const r = spawnSync(process.execPath, [bin('sim'), 'shot', 'x'], { encoding: 'utf8', env: { ...process.env, MSL_OWNER: 'agent-b' } });
  assert.match(r.stderr, /couldn't record the activity: the lease is busy/);
  assert.match(JSON.parse(r.stdout).error, /No simulator yet/);
  assert.ok(!fs.existsSync(activityPath()));
});

test('safari: every command needs the lease, and a refusal leaves no artifacts', () => {
  for (const args of [['url'], ['eval', '1'], ['source'], ['console'], ['start'], ['stop']]) {
    const { code, out } = call('safari', args);
    assert.equal(code, 1, args[0]);
    assert.match(out.error, /leased by "agent-a"/, args[0]);
    assert.equal(out.artifacts, undefined);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'runs')));
});

test('the owner itself gets through, and lab release names the way to force', () => {
  const mine = call('safari', ['url'], 'agent-a');
  assert.match(mine.out.error, /No Safari session/);
  const rel = call('lab', ['release']);
  assert.equal(rel.code, 1);
  assert.match(rel.out.error, /lab release --force/);
  assert.equal(call('lab', ['nope']).code, 2);
});

const PHONE = '00008000-000A1B2C3D4E5F60';
const SIM = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
const record = state => fs.writeFileSync(path.join(stateDir(), 'state.json'), JSON.stringify(state));
const SIM_COMMANDS = [['boot'], ['open', 'http://127.0.0.1/'], ['tap', '1', '1'], ['type', 'x'], ['scroll', 'down'], ['swipe', '1', '2', '3', '4'],
  ['appearance', 'dark'], ['statusbar', 'clear'], ['shutdown'], ['reset'], ['shot', 'x'], ['ui']];

test('sim: while the session is on the iPhone, simulator commands refuse before taking the lease', () => {
  fs.rmSync(path.join(stateDir(), 'lease.json'));
  record({ udid: SIM, session: 'abc', backend: 'appium', port: 4723, target: { device: PHONE } });
  for (const args of SIM_COMMANDS) {
    const { code, out } = call('sim', args);
    assert.equal(code, 1, args[0]);
    assert.equal(out.ok, false, args[0]);
    assert.match(out.error, new RegExp(`sim ${args[0]} is refused`), args[0]);
    assert.match(out.error, /safari shot\|tap\|keys\|swipe/, args[0]);
    assert.match(out.error, /safari stop/, args[0]);
    assert.ok(!out.error.includes(PHONE), 'the phone UDID is not echoed');
    assert.ok(!fs.existsSync(path.join(stateDir(), 'lease.json')), `${args[0]} took the lease`);
  }
});

test('sim: the device refusal wins over another agent\'s lease, and read-only helpers still work', () => {
  record({ session: 'abc', backend: 'appium', port: 4723, target: { device: PHONE } });
  assert.match(call('sim', ['tap', '1', '1']).out.error, /sim tap is refused/);
  for (const args of [['udid'], ['run', 'x']]) {
    const { out } = call('sim', args);
    assert.doesNotMatch(out.error ?? '', /refused/, args[0]);
  }
});

test('sim: a simulator session or no session is not refused', () => {
  for (const state of [{ session: 'abc', backend: 'appium', port: 4723, target: { simulator: SIM } }, {}, { session: 'abc', target: { device: 'nope' } }]) {
    record(state);
    const { out } = call('sim', ['shot', 'x']);
    assert.match(out.error, /No simulator yet/); // got past the device check
  }
});

// --help / -h / help never reach a handler or a hook: no lease, no run folder, no phone.
const HELP_CALLS = [['sim', ['statusbar', '--help']], ['sim', ['help']], ['safari', ['tap', '--help']], ['safari', ['wait', '--help']], ['safari', ['help']], ['safari', ['help', 'tap']],
  ['safari', ['-h']], ['lab', ['phone', '--help']], ['lab', ['up', '-h']], ['lab', ['help', 'down']]];

test('help: --help, -h and help answer without a lease, a run folder or any state', () => {
  fs.rmSync(path.join(stateDir(), 'lease.json'));
  for (const [name, args] of HELP_CALLS) {
    const { code, out } = call(name, args);
    assert.equal(code, 0, `${name} ${args}`);
    assert.equal(out.ok, true, `${name} ${args}`);
    assert.equal(typeof out.usage, 'string', `${name} ${args}`);
    assert.ok(out.commands && typeof out.commands === 'object', `${name} ${args}`);
    assert.ok(!fs.existsSync(path.join(stateDir(), 'lease.json')), `${name} ${args} took the lease`);
    assert.ok(!fs.existsSync(path.join(dir, 'runs')), `${name} ${args} made a run folder`);
  }
  assert.match(call('safari', ['tap', '--help']).out.usage, /safari tap \[css\] .*--label/);
  const waitHelp = call('safari', ['wait', '--help']).out.usage;
  assert.match(waitHelp, /safari wait \[css\] .*--visible\|--gone.*--timeout.*safari wait --settled \[--quiet/);
  for (const args of [['inject', '--help'], ['help', 'inject']]) {
    assert.match(call('safari', args).out.usage, /safari inject --forget <file\.user\.js>  or  safari inject --clear  \(.*--forget drops one recorded file, --clear all of them/);
  }
  for (const name of ['open', 'refresh']) assert.match(call('safari', ['help', name]).out.usage, /--wait-for <css>\] \[--settle\] \[--timeout <ms>\]/);
  const names = Object.keys(call('safari', ['help']).out.commands);
  assert.equal(names[names.indexOf('tap') + 1], 'wait');
  assert.match(call('lab', ['up', '-h']).out.usage, /lab up /);
  assert.match(call('sim', ['statusbar', '--help']).out.usage, /sim statusbar/);
  assert.deepEqual(Object.keys(call('safari', ['help']).out.commands).slice(0, 3), ['start', 'open', 'refresh']);
});

test('help works while another agent holds the lease, and during a phone session', () => {
  record({ session: 'abc', backend: 'appium', port: 4723, target: { device: PHONE } });
  for (const [name, args] of [['sim', ['tap', '--help']], ['safari', ['url', '--help']], ['lab', ['release', '-h']]]) {
    const { code, out } = call(name, args);
    assert.equal(code, 0, `${name} ${args}`);
    assert.equal(out.ok, true);
    assert.equal(out.lease, undefined);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir(), 'lease.json'), 'utf8')).owner, 'agent-a');
});

test('help: an unknown command is still exit 2, now with the usage', () => {
  const { code, out } = call('lab', ['nope']);
  assert.equal(code, 2);
  assert.equal(out.ok, false);
  assert.match(out.usage, /lab help <command>/);
  assert.ok(out.commands.includes('up'));
});
