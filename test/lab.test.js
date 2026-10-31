import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, stepClock, fakeRunner, standin, tempDir, linkPlugin, neverUnsafe, CURRENT_RULES, displayPhone, havePerl, holdLock, holdLockNow, lockIsFree, withSignLock } from './helpers.js';
import { spawnSync } from 'node:child_process';
import { cli, loadState, saveState, stateDir, setRunner, setSpawner } from '../lib/core.js';
import { handlers as lab } from '../lib/lab.js';
import { udid as simUdid } from '../lib/sim.js';
import * as phone from '../lib/phone.js';
import * as ledger from '../lib/phone-restore.js';
import * as lease from '../lib/lease.js';
import * as svc from '../lib/service.js';
import * as tunnel from '../lib/tunnel.js';
import http from 'node:http';
import { WAIT as SAFARI_WAIT, wd, handlers as safari, hooks as safariHooks, failureArtifacts } from '../lib/safari.js';
import { withInterrupt } from '../lib/interrupt.js';
import { isDeviceWda, deviceWdaTargets, STOP_WAIT } from '../lib/wda.js';
import { REPO } from '../lib/core.js';

const U = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';

let app, sim, calls, dir, baseReply;

before(async () => {
  app = standin();
  await app.listen();
  svc.SERVICE.port = app.port; // the stand-in plays the Appium service
  svc.setPlatform('darwin');
});
after(async () => { await app.close(); });

beforeEach(() => {
  dir = sandbox();
  delete process.env.MSL_APPIUM_URL;
  process.env.MSL_APPIUM_HOME = linkPlugin(tempDir('msl-appium-'));
  phone.setUsbmux();
  setSpawner(() => { throw new Error('unexpected spawnDetached'); }); // only a Wi-Fi test starts WebDriverAgent, with its own
  process.env.MSL_OWNER = 'me';
  delete process.env.MSL_LEASE_TTL;
  Object.assign(svc.WAIT, { statusMs: 300, pollMs: 10, serviceMs: 2000, kickMs: 1000, portFreeMs: 300 });
  Object.assign(SAFARI_WAIT, { usableMs: 800, callMs: 300, staleMs: 300, pollMs: 5, timeoutMs: 400, tabSettleMs: 0, tabMs: 300, closeDelayMs: 250, closeMs: 400, closePollMs: 5 });
  Object.assign(lease.MUTEX, { retryMs: 5, waitMs: 3000, staleMs: 10e3 });
  SAFARI_WAIT.deadDeleteMs = 300;
  stepClock(); // the close race is not read off a slow request
  tunnel.hooks.probe = async () => true; // no test reaches a tunnel; one that asks what a dead tunnel does swaps it
  app.reset();
  app.fx.phone = false;
  app.fx.up = true;
  app.fx.sessions.clear();
  app.fx.created = 0;
  app.fx.createFails = false;
  app.fx.createErrors = [];
  app.fx.createDelayMs = 0;
  app.fx.webviews = ['WEBVIEW_1'];
  app.log.length = 0;

  // The service is installed (its plist exists); simctl, launchctl and Xcode are fakes.
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  const filters = path.join(dir, 'filters.json');
  fs.writeFileSync(filters, CURRENT_RULES);
  const node = path.join(dir, 'bin', 'node'); // a real file: status() checks the plist's node exists
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, '');
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ node, main: '/x/appium/main.js', home: '/x', port: svc.SERVICE.port, log: '/x/log', filters, developerDir: '/x/dev', path: '/usr/bin' }));
  const xcode = path.join(dir, 'Xcode', 'Contents', 'Developer');
  fs.mkdirSync(path.join(xcode, 'Applications', 'Simulator.app'), { recursive: true });
  sim = { state: 'Booted' };
  baseReply = (cmd, args) => {
    if (cmd === 'xcode-select') return { stdout: xcode + '\n' };
    if (cmd === 'xcrun' && args[1] === 'list') {
      const devices = sim.state === null ? [] : [{ udid: U, name: 'Claude iPhone', state: sim.state, isAvailable: true }];
      return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': devices } }) };
    }
    if (cmd === 'xcrun' && args[1] === 'boot') { sim.state = 'Booted'; return undefined; }
    return undefined;
  };
  calls = fakeRunner((cmd, args) => baseReply(cmd, args));
  saveState({ udid: U });
});

const simctl = (...verb) => calls.filter(c => c[0] === 'xcrun' && verb.every((v, i) => c[2 + i] === v));
const requests = (method, suffix = '') => app.log.filter(([m, u]) => m === method && u.endsWith(suffix));
const stepOf = (out, name) => out.steps.find(s => s.step === name);
const didOf = out => Object.fromEntries(out.steps.map(s => [s.step, s.did]));


// --- up: healthy and idempotent ---

test('up on a fresh Mac creates the session; the second run finds everything healthy and does nothing', async () => {
  const first = await lab.up([]);
  assert.equal(first.ok, undefined); // success has no ok field here: cli adds ok: true
  assert.deepEqual(first.steps.map(s => s.step), ['lease', 'prerequisites', 'appium', 'simulator', 'session']);
  assert.equal(first.owner, 'me');
  assert.equal(first.session, 'S1');
  assert.equal(first.backend, 'appium');
  assert.deepEqual(first.target, { simulator: U });
  assert.equal(first.targetType, 'simulator');
  assert.equal(first.reused, false);
  assert.deepEqual(didOf(first), { lease: 'created', prerequisites: null, appium: null, simulator: null, session: 'created a new session' });
  assert.equal(stepOf(first, 'appium').found, 'reachable');
  assert.equal(stepOf(first, 'simulator').found, 'booted');
  assert.ok(first.steps.every(s => Number.isInteger(s.ms)));
  assert.equal(loadState().session, 'S1');

  const creates = requests('POST', '/session').length;
  const second = await lab.up([]);
  assert.deepEqual(didOf(second), { lease: null, prerequisites: null, appium: null, simulator: null, session: null });
  assert.equal(second.reused, true);
  assert.equal(second.session, 'S1');
  assert.equal(stepOf(second, 'session').found, 'session alive');
  assert.equal(requests('POST', '/session').length, creates); // nothing new
  assert.equal(requests('POST', '/context').length, 0); // neither run moved the session between contexts
  assert.equal(simctl('boot').length, 0);
  assert.equal(second.lease.owner, 'me');
});

test('up --url opens the page after the session is ready', async () => {
  const out = await lab.up(['--url', 'http://127.0.0.1:3000/page']);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'prerequisites', 'appium', 'simulator', 'session', 'open']);
  assert.equal(out.url, 'http://127.0.0.1:3000/page');
  assert.equal(out.title, 'Example');
  assert.match(stepOf(out, 'open').did, /^opened http:\/\/127\.0\.0\.1:3000\/page/);
});

test('up checks --url before it looks at anything', async () => {
  for (const bad of ['ftp://x', 'javascript:alert(1)', 'example.com']) {
    await assert.rejects(lab.up(['--url', bad]), /usage: lab up/, bad);
  }
  await assert.rejects(lab.up(['--url']), /--url needs a value/);
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(lease.read(), null);
});

// --- up: recovery ---

test('Appium killed: up waits for launchd to bring it back, finds the session gone, and makes a new one', async () => {
  await lab.up([]);
  assert.equal(loadState().session, 'S1');
  // Appium dies and restarts empty: the port is closed, then listening again with no sessions.
  const port = app.port;
  const seen = calls.length;
  await app.close();
  const restarted = (async () => {
    // Back only once up has found the port closed (it then asks launchctl), however long that took to reach.
    for (let i = 0; i < 1000 && !calls.slice(seen).some(c => c[0] === 'launchctl'); i++) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 50));
    app.fx.sessions.clear();
    await app.listen(port);
  })();
  const out = await lab.up([]);
  await restarted;
  assert.match(stepOf(out, 'appium').did, /waited for launchd/);
  assert.match(stepOf(out, 'session').found, /^session dead: /);
  assert.equal(stepOf(out, 'session').did, 'deleted the stale session and created a new one');
  assert.equal(out.session, 'S2');
  assert.equal(out.reused, false);
  assert.equal(loadState().session, 'S2');
});

test('Safari killed in the simulator: the session probe fails, the stale session is deleted, a new one starts', async () => {
  await lab.up([]);
  app.fx.webviews = []; // Safari has no page
  const out = await lab.up([]);
  assert.match(stepOf(out, 'session').found, /^session dead: no such window/);
  assert.equal(out.session, 'S2');
  assert.ok(requests('DELETE', '/session/S1').length >= 1, 'the stale session was ended');
  assert.equal(stepOf(out, 'simulator').did, null);
});

test('simulator shut down: up boots it by its saved UDID, never "booted", then makes a session', async () => {
  await lab.up([]);
  sim.state = 'Shutdown';
  app.fx.sessions.clear();
  const out = await lab.up([]);
  assert.equal(stepOf(out, 'simulator').found, 'shutdown');
  assert.equal(stepOf(out, 'simulator').did, 'booted (was Shutdown)');
  assert.deepEqual(simctl('boot')[0], ['xcrun', 'simctl', 'boot', U]);
  assert.deepEqual(simctl('bootstatus')[0], ['xcrun', 'simctl', 'bootstatus', U, '-b']);
  assert.ok(!calls.flat().includes('booted'));
  assert.equal(out.session, 'S2');
  assert.equal(sim.state, 'Booted');
});

// `up` on a Shutdown simulator whose bootstatus runs out of time `outs` times (exit 124) before it finishes;
// gives each bootstatus call's timeout and the lease expiry as that call started (the clock moves 10 s per call).
async function bootWaits(outs) {
  await lab.up([]);
  sim.state = 'Shutdown';
  app.fx.sessions.clear();
  const seen = [], expiries = [];
  let t = Date.now();
  lease.setClock(() => t);
  setRunner((cmd, args, opts) => { // fakeRunner's answers, with the timeout each call was given
    const said = baseReply(cmd, args);
    if (!said && cmd === 'ps' && args.includes('etime=')) return { code: 0, stdout: '00:00\n', stderr: '' };
    if (cmd === 'xcrun' && args[1] === 'bootstatus') {
      seen.push(opts?.timeoutMs);
      expiries.push(lease.read().expires);
      t += 10e3;
      return seen.length <= outs ? { code: 124, stdout: '', stderr: 'timed out after 150s' } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '', ...(said || {}) };
  });
  try {
    const out = await lab.up([]);
    assert.equal(out.ok, undefined, out.error);
    return { seen, out, renewed: expiries.every((e, i) => i === 0 || e > expiries[i - 1]) };
  } finally { lease.setClock(() => Date.now()); }
}

test('up on a warmed simulator bounds the boot wait at 600 s: four pieces of 150 s, the lease renewed between them', async () => {
  const { seen, renewed } = await bootWaits(3);
  assert.deepEqual(seen, [150e3, 150e3, 150e3, 150e3]);
  assert.ok(renewed);
});

test('up on an unwarmed simulator (new or erased) gives its first boot 1500 s, then marks it warmed', async () => {
  saveState({ unwarmed: [U] });
  const { seen } = await bootWaits(9);
  assert.deepEqual(seen, Array(10).fill(150e3));
  assert.equal(loadState().unwarmed, undefined);
});

test('up on a booted simulator raises the window only if the lab opened it and it still runs', async () => {
  const xcode = path.join(dir, 'Xcode', 'Contents', 'Developer');
  const withApp = running => {
    calls = fakeRunner((cmd, args) => {
      if (cmd === 'xcode-select') return { stdout: xcode + '\n' };
      if (cmd === 'xcrun' && args[1] === 'list') return { stdout: JSON.stringify({ devices: { r: [{ udid: U, name: 'Claude iPhone', state: 'Booted', isAvailable: true }] } }) };
      if (cmd === 'osascript') return { stdout: `${running}\n` };
      return undefined;
    });
  };
  const opens = () => calls.filter(c => c[0] === 'open');

  // The lab opened it and it runs: brought to the front, by the saved UDID.
  withApp(true);
  saveState({ windowApp: 'Simulator' });
  const raised = await lab.up([]);
  assert.deepEqual(opens(), [['open', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', U]]);
  assert.deepEqual([stepOf(raised, 'simulator').found, stepOf(raised, 'simulator').did], ['booted', 'brought Simulator to the front']);

  // A window the lab didn't open (no record) is left where it is.
  calls.length = 0;
  saveState({ windowApp: null });
  assert.equal(stepOf(await lab.up([]), 'simulator').did, null);
  assert.deepEqual(opens(), []);

  // One a person quit (recorded, not running) is not opened again; neither is one we can't tell about.
  for (const running of [false, '']) {
    withApp(running);
    saveState({ windowApp: 'Simulator' });
    assert.equal(stepOf(await lab.up([]), 'simulator').did, null, String(running));
    assert.deepEqual(opens(), []);
  }
  assert.equal(simctl('boot').length, 0);
});

test('session deleted out from under us: up finds it dead and starts a new one', async () => {
  await lab.up([]);
  app.fx.sessions.delete('S1');
  const out = await lab.up([]);
  assert.match(stepOf(out, 'session').found, /session dead: invalid session id/);
  assert.equal(out.session, 'S2');
  assert.equal(loadState().session, 'S2');
});

test('a simulator simctl does not know is an error that names the UDID', async () => {
  sim.state = null;
  const out = await lab.up([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'simulator');
  assert.ok(out.error.includes(U));
  assert.equal(simctl('boot').length, 0);
});

// --- up: failures and the lease ---

test('a failing step stops `up` and names it, keeping the steps so far', async () => {
  app.fx.createFails = true;
  const out = await lab.up([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'session');
  assert.match(out.error, /session not created/);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'prerequisites', 'appium', 'simulator', 'session']);
  assert.match(out.steps.at(-1).error, /session not created/);
  assert.equal(stepOf(out, 'simulator').found, 'booted');

  // And through the CLI that is exit 1 with the same JSON.
  const printed = [];
  const orig = console.log;
  console.log = l => printed.push(l);
  try { assert.equal(await cli(lab, ['up']), 1); } finally { console.log = orig; }
  assert.equal(JSON.parse(printed[0]).failedStep, 'session');
});

test('Appium missing altogether: prerequisites fails with the install command', async () => {
  fs.rmSync(svc.plistPath());
  process.env.MSL_APPIUM_HOME = path.join(dir, 'nothing');
  const out = await lab.up([]);
  assert.equal(out.failedStep, 'prerequisites');
  assert.match(out.error, /pnpm add appium@3\.8\.0/);
});

test('another agent\'s lease stops `up` before any simulator or Appium call', async () => {
  await lease.acquire({ owner: 'agent-a' });
  const out = await lab.up([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'lease');
  assert.match(out.error, /leased by "agent-a" until .*lab release --force.*lab up --force/);
  assert.equal(out.lease.owner, 'agent-a');
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(lease.read().owner, 'agent-a');
});

test('up --force takes a live lease and says so', async () => {
  await lease.acquire({ owner: 'agent-a' });
  const out = await lab.up(['--force']);
  assert.equal(out.ok, undefined);
  assert.equal(stepOf(out, 'lease').did, 'forced lease from agent-a');
  assert.equal(out.lease.owner, 'me');
  assert.equal(out.lease.forced, 'agent-a');
  assert.equal(lease.read().owner, 'me');
});

test('up takes over an expired lease and reports it', async () => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 'lease.json'), JSON.stringify({ owner: 'agent-a', since: '2020-01-01T00:00:00Z', expires: '2020-01-01T00:15:00Z' }));
  const out = await lab.up([]);
  assert.equal(stepOf(out, 'lease').did, 'took over expired lease of agent-a');
  assert.equal(out.lease.tookOver, 'agent-a');
});

test('up keeps the lease alive between steps', async () => {
  process.env.MSL_LEASE_TTL = '60';
  const out = await lab.up([]);
  assert.ok(Date.parse(out.lease.expires) - Date.now() > 55e3);
});

// --- status ---

test('status looks at everything and changes nothing', async () => {
  const before = await lab.status();
  assert.equal(before.owner, 'me');
  assert.equal(before.lease, null);
  assert.equal(before.session, null);
  assert.deepEqual(before.simulator, { udid: U, state: 'Booted', runtime: 'iOS 27.0' });
  assert.equal(before.appium.reachable, true);
  assert.equal(before.service.installed, true);

  await lab.up([]);
  app.log.length = 0;
  calls.length = 0;
  const s = await lab.status();
  assert.equal(s.lease.owner, 'me');
  assert.equal(s.lease.mine, true);
  assert.equal(s.lease.expired, false);
  assert.deepEqual(s.session, { id: 'S1', backend: 'appium', usable: true, target: { simulator: U }, targetType: 'simulator' });
  assert.ok(app.log.every(([m]) => m === 'GET'), JSON.stringify(app.log));
  assert.ok(!app.log.some(([, u]) => u.endsWith('/context') && !u.endsWith('/contexts')), 'no context switching');
  assert.ok(calls.every(c => c[1] !== 'boot'));
  assert.equal(lease.read().owner, 'me');

  saveState({ deviceTab: { waitingSince: '2026-10-30T14:00:00.000Z' } });
  assert.equal((await lab.status()).session.waitingSince, undefined, 'a session that answers is not waiting (#104)');
  app.fx.webviews = [];
  const stuck = (await lab.status()).session;
  assert.equal(stuck.usable, false);
  assert.equal(stuck.waitingSince, '2026-10-30T14:00:00.000Z', 'a script that got no answer is named when the session does not answer (#104)');
  saveState({ deviceTab: undefined });
  assert.equal((await lab.status()).session.waitingSince, undefined);
  app.fx.up = false;
  const down = await lab.status();
  assert.equal(down.appium.reachable, false);
  assert.equal(down.session.usable, false);
  sim.state = 'Shutdown';
  assert.equal((await lab.status()).simulator.state, 'Shutdown');
});

test('status reports the Wi-Fi tunnel tool from a local version call, and a missing one is only a hint', async () => {
  const tool = '/opt/tools/bin/pymobiledevice3';
  process.env.MSL_PMD3 = tool;
  try {
    let version = { stdout: '11.41.0\n' };
    calls = fakeRunner((cmd, args) => (cmd === tool ? version : baseReply(cmd, args)));
    let s = await lab.status();
    assert.deepEqual(s.tunnelTool, { ok: true, path: tool, version: '11.41.0' });
    assert.deepEqual(calls.filter(c => c[0] === tool), [[tool, 'version']]);

    version = { code: 127, stderr: 'not found' };
    s = await lab.status();
    assert.equal(s.tunnelTool.ok, false);
    assert.equal(s.tunnelTool.version, null);
    assert.match(s.tunnelTool.hint, /brew install uv/);
    assert.match(s.tunnelTool.error, /not installed/);

    version = { code: 124 };
    s = await lab.status();
    assert.deepEqual([s.tunnelTool.ok, s.tunnelTool.slow], [false, true]);
    assert.match(s.tunnelTool.error, /timed out twice/);
    assert.match(s.tunnelTool.hint, /try again/);
    assert.ok(!/brew install/.test(s.tunnelTool.hint), 'a slow check is not an install hint');

    version = { stdout: '11.40.1\n' };
    s = await lab.status();
    assert.deepEqual([s.tunnelTool.ok, s.tunnelTool.version, s.tunnelTool.slow], [false, '11.40.1', undefined]);
    assert.ok(!calls.some(c => c[0] === 'xcrun' && c[1] === 'devicectl'), 'no device calls');
  } finally { delete process.env.MSL_PMD3; }
});

test('status shows another owner\'s lease and an expired one', async () => {
  await lease.acquire({ owner: 'agent-a' });
  let s = await lab.status();
  assert.equal(s.lease.owner, 'agent-a');
  assert.equal(s.lease.mine, false);
  fs.writeFileSync(path.join(stateDir(), 'lease.json'), JSON.stringify({ owner: 'agent-a', since: '2020-01-01T00:00:00Z', expires: '2020-01-01T00:15:00Z' }));
  s = await lab.status();
  assert.equal(s.lease.expired, true);
  fs.writeFileSync(path.join(stateDir(), 'lease.json'), 'junk');
  assert.deepEqual((await lab.status()).lease, { corrupt: true, expired: true, mine: false });
});

// --- the lab's own version ---

const REMOTE = 'e'.repeat(40);
// git answers from the fields given; every other command goes to the usual fakes.
function fakeGit(g = {}) {
  const answers = { head: 'abc1234', branch: 'main', dirty: '', remote: { stdout: `${REMOTE}\tHEAD\n` }, behind: false, ...g };
  calls = fakeRunner((cmd, args) => {
    if (cmd !== 'git') return baseReply(cmd, args);
    switch (args[2]) {
      case 'rev-parse': return { stdout: answers.head + '\n' };
      case 'branch': return { stdout: answers.branch + '\n' };
      case 'status': return { stdout: answers.dirty };
      case 'ls-remote': return answers.remote;
      case 'merge-base': return { code: answers.behind ? 1 : 0 };
      default: return { code: 1 };
    }
  });
}
const lsRemotes = () => calls.filter(c => c[0] === 'git' && c[3] === 'ls-remote').length;

test('up and status report labVersion; behind carries the human text; nothing else changes', async () => {
  fakeGit({ behind: true });
  const out = await lab.up([]);
  assert.equal(out.labVersion.behind, true);
  assert.equal(out.labVersion.human.length, 2);
  assert.match(out.labVersion.human[0], /is out of date \(abc1234 vs eeeeeee on GitHub\)\. Run: git -C .+ pull --ff-only$/);
  assert.equal(out.needs, undefined);
  assert.equal(out.session, 'S1');
  assert.equal(lsRemotes(), 1);

  const s = await lab.status(); // cached: no second round trip
  assert.equal(s.labVersion.behind, true);
  assert.equal(s.labVersion.cached, true);
  assert.equal(lsRemotes(), 1);
});

test('status --check-update asks origin again; other arguments are refused', async () => {
  fakeGit();
  await lab.status([]);
  await lab.status([]);
  assert.equal(lsRemotes(), 1);
  const s = await lab.status(['--check-update']);
  assert.equal(lsRemotes(), 2);
  assert.equal(s.labVersion.cached, undefined);
  assert.equal(s.labVersion.behind, false);
  await assert.rejects(lab.status(['--force']), /usage: lab status \[--check-update\]/);
  await assert.rejects(lab.status(['extra']), /usage: lab status/);
});

test('offline: up still works and labVersion says it could not check', async () => {
  fakeGit({ remote: { code: 128, stderr: 'fatal: unable to access' } });
  const out = await lab.up([]);
  assert.equal(out.session, 'S1');
  assert.equal(out.labVersion.checked, false);
  assert.match(out.labVersion.reason, /offline/);
  assert.equal(out.needs, undefined);
  assert.equal(out.ok, undefined);
});

test('a failed up still carries labVersion once the lease was taken; a refused one runs no command', async () => {
  fakeGit();
  fs.rmSync(svc.plistPath());
  process.env.MSL_APPIUM_HOME = path.join(dir, 'nothing');
  const failed = await lab.up([]);
  assert.equal(failed.failedStep, 'prerequisites');
  assert.equal(typeof failed.labVersion.checked, 'string');
  await lease.release();
  await lease.acquire({ owner: 'agent-a' });
  calls.length = 0;
  const refused = await lab.up([]);
  assert.equal(refused.failedStep, 'lease');
  assert.equal(refused.labVersion, undefined);
  assert.equal(calls.length, 0);
});

// --- release and service ---

test('release gives back your lease, refuses another\'s without --force, and is fine with none', async () => {
  assert.deepEqual(await lab.release([]), { released: false });
  await lease.acquire({ owner: 'me' });
  assert.deepEqual(await lab.release([]), { released: true });
  await lease.acquire({ owner: 'agent-a' });
  await assert.rejects(lab.release([]), /leased by "agent-a"/);
  assert.deepEqual(await lab.release(['--force']), { released: true, was: 'agent-a' });
  assert.equal(lease.read(), null);
});

test('service install checks --log-level before the lease, and uninstall takes none', async () => {
  await assert.rejects(lab.service(['install', '--log-level', 'trace']), /--log-level must be info or debug, not "trace"/);
  await assert.rejects(lab.service(['install', '--log-level']), /--log-level needs a value/);
  await assert.rejects(lab.service(['uninstall', '--log-level', 'debug']), /--log-level goes with lab service install/);
  assert.equal(lease.read(), null);
});

test('service takes the lease first, rejects unknown subcommands, and status needs none', async () => {
  await assert.rejects(lab.service([]), /usage: lab service install \[--replace\] \[--log-level info\|debug\] \[--no-idle-stop\] \| uninstall \| status/);
  await assert.rejects(lab.service(['restart']), /usage: lab service/);
  assert.equal(lease.read(), null);

  assert.equal((await lab.service(['status'])).installed, true);
  assert.equal(lease.read(), null);

  await lease.acquire({ owner: 'agent-a' });
  await assert.rejects(lab.service(['uninstall']), /leased by "agent-a"/);
  assert.ok(fs.existsSync(svc.plistPath())); // refused before touching anything
  await assert.rejects(lab.service(['install']), /leased by "agent-a"/);
  await lab.release(['--force']);

  const out = await lab.service(['uninstall']);
  assert.equal(out.uninstalled, true);
  assert.ok(!fs.existsSync(svc.plistPath()));
  assert.equal(lease.read(), null, 'the command took the lease for itself and handed it back');
  assert.equal(out.lease, undefined);
});

test('service keeps a lease the caller already held, renewed, and does not release it', async () => {
  await lease.acquire({ owner: 'me' });
  const since = lease.read().since;
  const out = await lab.service(['uninstall']);
  assert.equal(out.uninstalled, true);
  assert.equal(lease.read().owner, 'me');
  assert.equal(lease.read().since, since);
  assert.equal(out.lease, undefined);
});

test('service hands the lease back when the command fails, and shows the command\'s own error', async () => {
  svc.setPlatform('linux'); // install refuses: it needs launchd
  try {
    await assert.rejects(lab.service(['install']), /the Appium LaunchAgent needs macOS/);
  } finally { svc.setPlatform('darwin'); }
  assert.equal(lease.read(), null);
  // A lease the caller held before stays held after a failure.
  await lease.acquire({ owner: 'me' });
  svc.setPlatform('linux');
  try {
    await assert.rejects(lab.service(['install']), /the Appium LaunchAgent needs macOS/);
  } finally { svc.setPlatform('darwin'); }
  assert.equal(lease.read().owner, 'me');
});

test('service interrupted while it waits for Appium hands back the lease it took, and keeps one the caller held', async () => {
  app.fx.up = false; // Appium never answers, so the install waits
  const pkg = path.join(process.env.MSL_APPIUM_HOME, 'node_modules', 'appium');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { appium: 'index.js' } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), '');
  const before = baseReply;
  baseReply = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 113, stderr: 'Could not find service' }; // not loaded yet
    if (cmd === 'launchctl' && args[0] === 'bootstrap') process.emit('SIGTERM', 'SIGTERM');
    return before(cmd, args);
  };
  try {
    await assert.rejects(withInterrupt(() => lab.service(['install'])), e => e.interrupted === true && e.signal === 'SIGTERM');
    assert.equal(lease.read(), null, 'a lease this command took is handed back');
    await lease.acquire({ owner: 'me' });
    await assert.rejects(withInterrupt(() => lab.service(['install'])), e => e.interrupted === true);
    assert.equal(lease.read().owner, 'me', 'a lease the caller held stays');
  } finally { baseReply = before; }
});

test('service that took over an expired lease still says so, and leaves no lease behind', async () => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 'lease.json'), JSON.stringify({ owner: 'agent-a', since: '2020-01-01T00:00:00.000Z', expires: '2020-01-01T00:15:00.000Z' }));
  const out = await lab.service(['uninstall']);
  assert.equal(out.uninstalled, true);
  assert.deepEqual(out.lease, { tookOver: 'agent-a' });
  assert.equal(lease.read(), null);
});

test('a lease release that fails after the service command does not hide the command\'s own error', async () => {
  const base = baseReply;
  const lock = path.join(stateDir(), 'lease.lock');
  // The command fails while someone else holds the lease lock, so the release gives up.
  baseReply = (cmd, args) => {
    if (cmd === 'launchctl') { fs.mkdirSync(lock); throw new Error('launchctl blew up'); }
    return base(cmd, args);
  };
  lease.MUTEX.waitMs = 60;
  const shown = [];
  const realError = console.error;
  console.error = m => shown.push(String(m));
  try {
    await assert.rejects(lab.service(['uninstall']), /launchctl blew up/);
  } finally {
    console.error = realError;
    baseReply = base;
    fs.rmSync(lock, { recursive: true, force: true });
  }
  assert.ok(shown.some(m => /\[lease\] couldn't update the lease: the lease is busy/.test(m)));
});

test('safari start also replaces a dead session and says it recovered', async () => {
  const { handlers: safari } = await import('../lib/safari.js');
  await lab.up([]);
  assert.deepEqual(await safari.start([]), { session: 'S1', backend: 'appium', reused: true, target: { simulator: U }, targetType: 'simulator' });
  app.fx.webviews = []; // Safari killed
  assert.deepEqual(await safari.start([]), { session: 'S2', backend: 'appium', target: { simulator: U }, targetType: 'simulator', recovered: true });
  assert.ok(requests('DELETE', '/session/S1').length >= 1);
});

// --- down ---

const TARGET = `gui/${process.getuid()}/com.dividedby.msl-appium`;
const DEVICE = '00008110-001A2B3C4D5E6F78';
const OTHER = 'AAAAAAAA-0000-4000-8000-000000000000';

// Replaces the beforeEach runner with one that also plays launchd (`loaded`), the window app
// (`windowRunning`), other simulators (`others`) and ps (`ps(pid)`, empty once SIGTERMed).
// `shutdownWorks: false` leaves the simulator booted. `onCommand(cmd, args)` sees every command first.
// `disableFails` / `bootoutFails` make that launchctl verb fail (a failed bootout leaves the
// service loaded); `badListAfterWindowCheck` makes `simctl list` print junk once the window
// step has looked at the app.
// `procs` ([{ pid, ppid, command, now? }]) is the process table `ps` lists; `now` is what the
// pid runs by the time it is checked (it was reused).
function world({ loaded = true, windowRunning = true, others = [], ps = () => '', procs = [], shutdownWorks = true, disableFails = false, bootoutFails = false, badListAfterWindowCheck = false, onShutdown = null, onCommand = null } = {}) {
  const w = { loaded, windowRunning, kills: [], gone: new Set(), badList: false, idleLoaded: false };
  calls = fakeRunner((cmd, args) => {
    onCommand?.(cmd, args);
    if (cmd === 'xcode-select') return { stdout: path.join(dir, 'Xcode', 'Contents', 'Developer') + '\n' };
    if (cmd === 'xcrun' && args[1] === 'list' && w.badList) return { stdout: 'Segmentation fault' };
    if (cmd === 'xcrun' && args[1] === 'list') {
      const own = sim.state === null ? [] : [{ udid: U, name: 'Claude iPhone', state: sim.state, isAvailable: true }];
      return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [...own, ...others] } }) };
    }
    if (cmd === 'xcrun' && args[1] === 'boot') { sim.state = 'Booted'; return undefined; }
    if (cmd === 'xcrun' && args[1] === 'shutdown') { if (shutdownWorks) sim.state = 'Shutdown'; onShutdown?.(); return undefined; }
    if (cmd === 'osascript') {
      if (args[1].includes('is running')) { w.badList = badListAfterWindowCheck; return { stdout: `${w.windowRunning}\n` }; }
      if (args[1].includes('to quit')) w.windowRunning = false;
      return undefined;
    }
    if (cmd === 'ps' && args[0] === '-ax') {
      return { stdout: procs.filter(p => !w.gone.has(String(p.pid))).map(p => `  ${p.pid}  ${p.ppid} ${p.command}`).join('\n') };
    }
    if (cmd === 'ps' && !args.includes('etime=')) {
      const proc = procs.find(p => String(p.pid) === args[3]);
      return { stdout: w.gone.has(args[3]) ? '' : proc ? proc.now ?? proc.command : ps(args[3]) };
    }
    if (cmd === 'launchctl' && args.at(-1).includes('msl-idle')) { // the idle stop agent has its own state
      if (args[0] === 'print') return w.idleLoaded ? { stdout: 'state = not running\n' } : { code: 113, stderr: 'Could not find service' };
      if (args[0] === 'bootout') w.idleLoaded = false;
      if (args[0] === 'bootstrap') w.idleLoaded = true;
      return undefined;
    }
    if (cmd === 'launchctl') {
      if (args[0] === 'print') return w.loaded ? { stdout: 'state = running\n\tpid = 4242\n' } : { code: 113, stderr: 'Could not find service' };
      if (args[0] === 'disable' && disableFails) return { code: 1, stderr: 'Operation not permitted\n' };
      if (args[0] === 'bootout' && bootoutFails) return { code: 5, stderr: 'Boot-out failed: 5: Input/output error\n' };
      if (args[0] === 'bootout') { w.loaded = false; app.fx.up = false; }
      if (args[0] === 'bootstrap') { w.loaded = true; app.fx.up = true; }
    }
    return undefined;
  });
  svc.setKill((pid, sig) => { w.kills.push([pid, sig]); w.gone.add(String(pid)); });
  return w;
}
const launchctl = () => calls.filter(c => c[0] === 'launchctl').map(c => c.slice(1).join(' '));
const quits = () => calls.filter(c => c[0] === 'osascript' && c[2].includes('to quit'));

test('down ends the session, shuts the simulator down by its UDID, quits the window the lab opened, stops Appium, and releases the lease', async () => {
  const w = world();
  saveState({ windowApp: 'Simulator' });
  await lab.up([]);
  calls.length = 0;
  app.log.length = 0;

  const out = await lab.down([]);
  assert.equal(out.ok, undefined);
  assert.equal(out.owner, 'me');
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'session', 'wda', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium', 'release']);
  assert.ok(out.steps.every(s => Number.isInteger(s.ms)));
  assert.equal(didOf(out).lease, null);
  assert.equal(didOf(out).session, 'ended it');
  assert.equal(didOf(out).simulator, 'shut down');
  assert.equal(didOf(out).window, 'asked Simulator to quit');
  assert.equal(didOf(out).safaridriver, null);
  assert.match(didOf(out).appium, /^stopped it and disabled it at login/);
  assert.equal(didOf(out).release, 'released');

  assert.equal(requests('DELETE', '/session/S1').length, 1);
  assert.deepEqual(simctl('shutdown'), [['xcrun', 'simctl', 'shutdown', U]]);
  assert.deepEqual(quits(), [['osascript', '-e', 'tell application id "com.apple.iphonesimulator" to quit']]);
  assert.deepEqual(launchctl().filter(c => !c.startsWith('print')), [`disable ${TARGET}`, `bootout ${TARGET}`]);
  assert.ok(fs.existsSync(svc.plistPath()), 'the plist stays');
  assert.equal(w.kills.length, 0);
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().windowApp, undefined);
  assert.equal(lease.read(), null);

  // Argument lists only, and never "booted" or the process killers.
  assert.ok(calls.every(c => c.every(a => typeof a === 'string') && !/\s/.test(c[0])));
  assert.ok(!calls.flat().includes('booted'));
  assert.ok(!calls.some(c => ['kill', 'pkill', 'killall'].includes(c[0])));

  const s = await lab.status();
  assert.equal(s.service.loaded, false);
  assert.equal(s.service.installed, true);
  assert.equal(s.appium.reachable, false);
  assert.equal(s.simulator.state, 'Shutdown');
  assert.equal(s.session, null);
  assert.equal(s.lease, null);
  assert.ok(s.service.issues.every(i => /normal after `lab down`/.test(i)));
});

test('a second down finds nothing to do and succeeds', async () => {
  world();
  saveState({ windowApp: 'Simulator' });
  await lab.up([]);
  await lab.down([]);
  calls.length = 0;
  app.log.length = 0;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined);
  assert.ok(out.steps.every(s => s.did === null), JSON.stringify(didOf(out)));
  assert.equal(app.log.length, 0);
  assert.equal(simctl('shutdown').length, 0);
  assert.equal(quits().length, 0);
  assert.ok(!launchctl().some(c => c.startsWith('bootout')));
});

test('down quits the window only if the lab opened it and no simulator is booted', async () => {
  // Opened by a person: the state has no windowApp.
  world();
  let out = await lab.down([]);
  assert.equal(stepOf(out, 'window').found, 'no window opened by the lab');
  assert.equal(quits().length, 0);

  // Opened by the lab, but another simulator is booted.
  saveState({ windowApp: 'Simulator' });
  sim.state = 'Booted';
  world({ others: [{ udid: OTHER, name: 'iPhone 17', state: 'Booted', isAvailable: true }] });
  out = await lab.down([]);
  assert.match(stepOf(out, 'window').found, /1 simulator still booted: left open/);
  assert.equal(stepOf(out, 'window').did, null);
  assert.equal(quits().length, 0);
  assert.equal(loadState().windowApp, 'Simulator');
  assert.deepEqual(simctl('shutdown'), [['xcrun', 'simctl', 'shutdown', U]]); // only the Claude iPhone

  // Opened by the lab, nothing else booted, Device Hub: its own bundle id.
  saveState({ windowApp: 'Device Hub' });
  sim.state = 'Booted';
  world({ others: [{ udid: OTHER, name: 'iPhone 17', state: 'Shutdown', isAvailable: true }] });
  out = await lab.down([]);
  assert.equal(stepOf(out, 'window').did, 'asked Device Hub to quit');
  assert.deepEqual(quits(), [['osascript', '-e', 'tell application id "com.apple.dt.Devices" to quit']]);

  // Recorded, but already closed: nothing to quit, record dropped.
  saveState({ windowApp: 'Simulator' });
  world({ windowRunning: false });
  out = await lab.down([]);
  assert.equal(stepOf(out, 'window').found, 'Simulator already closed');
  assert.equal(quits().length, 0);
  assert.equal(loadState().windowApp, undefined);
});

test('down refuses another owner\'s live lease before touching anything, and --force goes ahead', async () => {
  world();
  await lease.acquire({ owner: 'agent-a' });
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'lease');
  assert.match(out.error, /leased by "agent-a" until .*lab release --force.*lab up --force/);
  assert.equal(out.lease.owner, 'agent-a');
  assert.deepEqual(out.steps.map(s => s.step), ['lease']);
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(lease.read().owner, 'agent-a');

  const forced = await lab.down(['--force']);
  assert.equal(forced.ok, undefined);
  assert.match(stepOf(forced, 'lease').found, /^leased by "agent-a" until /);
  assert.deepEqual(stepOf(forced, 'release'), { ...stepOf(forced, 'release'), found: 'lease of agent-a', did: 'released' });
  assert.equal(lease.read(), null);
  assert.equal(simctl('shutdown').length, 1);
});

test('down --keep-service leaves the Appium service running', async () => {
  const w = world();
  await lab.up([]);
  calls.length = 0;
  const out = await lab.down(['--keep-service']);
  assert.equal(out.ok, undefined);
  assert.equal(stepOf(out, 'appium').found, 'kept (--keep-service)');
  assert.equal(stepOf(out, 'appium').did, null);
  assert.deepEqual(launchctl().filter(c => !c.startsWith('print')), []);
  assert.equal(w.loaded, true);
  assert.equal(simctl('shutdown').length, 1); // the rest still happens
  assert.equal(lease.read(), null);
});

test('without the service, down stops a manual Appium by its recorded pid after checking what the pid runs', async () => {
  fs.rmSync(svc.plistPath());
  const w = world({ ps: () => 'node /h/node_modules/.bin/appium --address 127.0.0.1 --port 4723\n' });
  await lab.up([]);
  saveState({ driverPid: 5555 });
  calls.length = 0;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined);
  assert.equal(stepOf(out, 'appium').did, 'stopped it (pid 5555)');
  assert.deepEqual(w.kills, [[5555, 'SIGTERM']]);
  assert.deepEqual(calls.find(c => c[0] === 'ps' && c[1] === '-o'), ['ps', '-o', 'command=', '-p', '5555']);
  assert.equal(loadState().driverPid, undefined);
  assert.deepEqual(launchctl(), []);
});

test('down will not kill a recorded pid that is not Appium any more', async () => {
  fs.rmSync(svc.plistPath());
  const w = world({ ps: () => 'vim notes.txt\n' });
  await lab.up([]);
  saveState({ driverPid: 5555 });
  const out = await lab.down([]);
  assert.equal(out.ok, undefined); // the lab's Appium is gone; the pid is someone else's
  assert.match(stepOf(out, 'appium').found, /pid 5555 now runs something else \(vim notes\.txt\): left alone/);
  assert.equal(stepOf(out, 'appium').did, null);
  assert.deepEqual(w.kills, []);
  assert.equal(loadState().driverPid, undefined);
});

test('with the service installed a recorded Appium pid is cleared and never killed', async () => {
  const w = world({ ps: () => 'node appium\n' });
  await lab.up([]);
  saveState({ driverPid: 5555 });
  await lab.down([]);
  assert.deepEqual(w.kills, []);
  assert.equal(loadState().driverPid, undefined);
});

test('down ends a --device session and stops the safaridriver the lab started, even with --keep-service', async () => {
  const w = world({ ps: () => 'safaridriver -p 4444\n' });
  saveState({ session: 'SD1', backend: 'safaridriver', port: app.port, target: { device: DEVICE }, driverPid: 6666 });
  app.fx.sessions.add('SD1');
  const out = await lab.down(['--keep-service']);
  assert.equal(out.ok, undefined);
  assert.equal(requests('DELETE', '/session/SD1').length, 1);
  assert.equal(stepOf(out, 'safaridriver').did, 'stopped it (pid 6666)');
  assert.deepEqual(w.kills, [[6666, 'SIGTERM']]);
  assert.equal(stepOf(out, 'appium').found, 'kept (--keep-service)');
  assert.equal(loadState().driverPid, undefined);
  assert.equal(loadState().session, undefined);
});

test('a step that fails does not stop the later ones, and keeps the lease', async () => {
  const w = world({ shutdownWorks: false });
  await lab.up([]);
  calls.length = 0;
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'simulator');
  assert.match(out.error, /simulator: simulator .* is still Booted .*lease is kept, run `lab down` again/);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'session', 'wda', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium']);
  assert.match(stepOf(out, 'simulator').error, /still Booted/);
  assert.equal(stepOf(out, 'session').did, 'ended it');
  assert.equal(w.loaded, false); // Appium was still stopped
  assert.equal(lease.read().owner, 'me'); // so a retry stays ours

  const retry = world({ loaded: false });
  const again = await lab.down([]);
  assert.equal(again.ok, undefined);
  assert.equal(stepOf(again, 'simulator').did, 'shut down');
  assert.equal(lease.read(), null);
  assert.equal(retry.kills.length, 0);

  // Through the CLI a failed down is exit 1.
  world({ shutdownWorks: false });
  sim.state = 'Booted';
  const printed = [];
  const orig = console.log;
  console.log = l => printed.push(l);
  try { assert.equal(await cli(lab, ['down']), 1); } finally { console.log = orig; }
  assert.equal(JSON.parse(printed[0]).failedStep, 'simulator');
});

test('down clears a damaged session record, and a session its server can no longer answer for', async () => {
  world();
  saveState({ session: 'S9' }); // no port, no target: damaged
  let out = await lab.down([]);
  assert.deepEqual([stepOf(out, 'session').found, stepOf(out, 'session').did], ['damaged session record', 'cleared it']);
  assert.equal(loadState().session, undefined);

  await lab.up([]);
  app.fx.up = false; // Appium is dead
  app.log.length = 0;
  out = await lab.down([]);
  assert.match(stepOf(out, 'session').did, /server isn't answering/);
  assert.equal(requests('DELETE', '/session/S1').length, 0);
  assert.equal(loadState().session, undefined);

  await lab.up([]);
  app.fx.sessions.clear(); // the server forgot it
  out = await lab.down([]);
  assert.match(stepOf(out, 'session').did, /already dropped it/);
  assert.equal(out.ok, undefined);
});

test('down takes only --force and --keep-service', async () => {
  world();
  await assert.rejects(lab.down(['--bogus', 'x']), /usage: lab down \[--force\] \[--keep-service\]/);
  await assert.rejects(lab.down(['now']), /usage: lab down/);
  assert.equal(calls.length, 0);
});

test('down does not claim the service is disabled when launchctl disable failed', async () => {
  const w = world({ disableFails: true });
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'appium');
  assert.match(out.error, new RegExp(`couldn't disable the service \\(Operation not permitted\\), so it may start again at the next login: run \`launchctl disable ${TARGET.replaceAll('.', '\\.')}\``));
  assert.match(out.error, /the lease is kept/);
  assert.equal(stepOf(out, 'appium').did, null);
  assert.ok(!out.steps.some(s => s.step === 'release'));
  assert.equal(w.loaded, false); // it was still booted out
  assert.equal(lease.read().owner, 'me');
});

test('down says why launchd still has the service when bootout fails', async () => {
  const w = world({ bootoutFails: true });
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'appium');
  assert.match(out.error, /launchd still has the Appium service .* after bootout \(Boot-out failed: 5: Input\/output error\)/);
  assert.equal(w.loaded, true);
  assert.equal(stepOf(out, 'appium').did, null);
  assert.equal(lease.read().owner, 'me');
  assert.equal(simctl('shutdown').length, 1); // the other steps still ran
});

test('the pid guard wants the executable or script, not any command line that mentions it', async () => {
  fs.rmSync(svc.plistPath());
  let w = world({ ps: () => 'vim appium.md\n' });
  await lab.up([]);
  saveState({ driverPid: 5555 });
  let out = await lab.down([]);
  assert.equal(out.ok, undefined);
  assert.match(stepOf(out, 'appium').found, /now runs something else \(vim appium\.md\)/);
  assert.deepEqual(w.kills, []);

  sim.state = 'Booted';
  w = world({ ps: () => 'node /h/notes/appium.md\n' });
  saveState({ driverPid: 5555 });
  await lab.down([]);
  assert.deepEqual(w.kills, []);

  sim.state = 'Booted';
  w = world({ ps: () => 'vim safaridriver.txt\n' });
  saveState({ session: 'SD1', backend: 'safaridriver', port: app.port, target: { device: DEVICE }, driverPid: 6666 });
  app.fx.sessions.add('SD1');
  out = await lab.down([]);
  assert.match(stepOf(out, 'safaridriver').found, /now runs something else \(vim safaridriver\.txt\)/);
  assert.deepEqual(w.kills, []);

  // The real commands are stopped.
  for (const command of ['/h/node_modules/.bin/appium --port 4723', 'node /h/node_modules/appium/index.js --port 4723', 'node /h/node_modules/.bin/appium']) {
    sim.state = 'Booted';
    w = world({ ps: () => `${command}\n` });
    saveState({ driverPid: 5555 });
    await lab.down([]);
    assert.deepEqual(w.kills, [[5555, 'SIGTERM']], command);
  }
});

test('down says so when simctl list is unreadable, and leaves the window open', async () => {
  world({ badListAfterWindowCheck: true });
  saveState({ windowApp: 'Simulator' });
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'window');
  assert.match(out.error, /couldn't read the output of `simctl list`.*Simulator was left open/);
  assert.equal(quits().length, 0);
});

const MSL = '/Users/x/.local/share/msl-appium';
const XCODEBUILD = `/usr/bin/xcodebuild build-for-testing test-without-building -project ${MSL}/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=${U} -derivedDataPath ${MSL}/dd`;
const DIAGNOSE = `xcrun simctl diagnose -b --no-archive --output=${MSL}/diag ${U}`;

test('down stops the WebDriverAgent xcodebuild Appium started and a simctl diagnose, before shutting the simulator down', async () => {
  const w = world({ procs: [
    { pid: 7001, ppid: 4242, command: XCODEBUILD }, // child of the service's Appium (pid 4242)
    { pid: 7002, ppid: 1, command: DIAGNOSE },
  ] });
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, undefined);
  assert.deepEqual(out.steps.map(s => s.step).slice(1, 5), ['session', 'wda', 'tunnel', 'simulator']);
  assert.equal(stepOf(out, 'wda').found, 'xcodebuild (pid 7001), simctl diagnose (pid 7002)');
  assert.equal(stepOf(out, 'wda').did, 'stopped xcodebuild (pid 7001), simctl diagnose (pid 7002)');
  assert.deepEqual(w.kills, [[7001, 'SIGTERM'], [7002, 'SIGTERM']]);
  assert.ok(!calls.some(c => ['kill', 'pkill', 'killall'].includes(c[0])));

  assert.equal(stepOf(await lab.down([]), 'wda').found, 'none running');
});

test('down leaves xcodebuild and diagnose processes that are not the lab\'s alone', async () => {
  const w = world({ procs: [
    { pid: 7101, ppid: 999, command: XCODEBUILD }, // not Appium's child
    { pid: 7102, ppid: 4242, command: XCODEBUILD.replace(U, OTHER) }, // another simulator
    { pid: 7103, ppid: 4242, command: XCODEBUILD.replaceAll(MSL, '/Users/x/work') }, // another project
    { pid: 7104, ppid: 4242, command: `vim ${MSL}/WebDriverAgent ${U}` }, // not xcodebuild
    { pid: 7105, ppid: 1, command: DIAGNOSE.replace(U, OTHER) },
    { pid: 7106, ppid: 1, command: DIAGNOSE.replaceAll(MSL, '/tmp') },
    { pid: 7107, ppid: 4242, command: XCODEBUILD, now: `vim notes ${U}` }, // pid reused since the listing
  ] });
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, undefined);
  assert.deepEqual(w.kills, []);
  assert.equal(stepOf(out, 'wda').found, 'xcodebuild (pid 7107); xcodebuild (pid 7107) is now something else: left alone');
  assert.equal(stepOf(out, 'wda').did, null);
});

test('down reports an xcodebuild that will not exit and still runs the later steps', async () => {
  const w = world({ procs: [{ pid: 7001, ppid: 4242, command: XCODEBUILD }] });
  svc.setKill((pid, sig) => { w.kills.push([pid, sig]); }); // ignores SIGTERM
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'wda');
  assert.match(stepOf(out, 'wda').error, /xcodebuild \(pid 7001\) didn't exit/);
  assert.equal(simctl('shutdown').length, 1);
  assert.equal(lease.read().owner, 'me');
});

test('up retries a session create once when Web Inspector listed no pages, and says so', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  try {
    app.fx.createErrors = ['An unknown server-side error occurred while processing the command. Original error: remote debugger did not return any connected web applications after ~32000ms'];
    const out = await lab.up([]);
    assert.equal(out.ok, undefined);
    assert.equal(stepOf(out, 'session').did, 'created a new session (retried after Web Inspector listed no pages)');
    assert.equal(out.session, 'S1');
    assert.equal(requests('POST', '/session').length, 2);

    // Only once: a second failure is the failure.
    await lab.down([]);
    app.log.length = 0;
    app.fx.createErrors = Array(2).fill('remote debugger did not return any connected web applications after ~32000ms');
    const failed = await lab.up([]);
    assert.equal(failed.ok, false);
    assert.equal(failed.failedStep, 'session');
    assert.match(failed.error, /did not return any connected web applications/);
    assert.equal(requests('POST', '/session').length, 2);

    // Other create failures are not retried.
    app.log.length = 0;
    app.fx.createFails = true;
    assert.equal((await lab.up([])).ok, false);
    assert.equal(requests('POST', '/session').length, 1);
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('up retries a session create once when Web Inspector listed applications with no pages, and says so', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  const noPages = 'An unknown server-side error occurred while processing the command. Original error: The remote debugger returned 4 web applications, but none of them had pages after 31022ms. Make sure your web application is debuggable and could be inspected in Safari Web Inspector.';
  try {
    app.fx.createErrors = [noPages];
    const out = await lab.up([]);
    assert.equal(out.ok, undefined);
    assert.equal(stepOf(out, 'session').did, 'created a new session (retried after Web Inspector listed no pages)');
    assert.equal(requests('POST', '/session').length, 2);

    // One retry in all, and not for pages that exist but did not match.
    await lab.down([]);
    app.log.length = 0;
    app.fx.createErrors = [noPages, noPages];
    assert.equal((await lab.up([])).failedStep, 'session');
    assert.equal(requests('POST', '/session').length, 2);
    app.log.length = 0;
    app.fx.createErrors = ['The remote debugger returned 1 web application with pages after 31022ms, although none of them matched our page search criteria.'];
    assert.equal((await lab.up([])).ok, false);
    assert.equal(requests('POST', '/session').length, 1);
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('up retries a simulator session create once when WebDriverAgent failed to start, and says so; never twice, never on the lab\'s own timeout', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  const wda = 'An unknown server-side error occurred while processing the command. Original error: Unable to launch WebDriverAgent because of xcodebuild failure: Failed to initialize for UI testing: Timed out waiting for AX loaded notification';
  try {
    app.fx.createErrors = [wda];
    const out = await lab.up([]);
    assert.equal(out.ok, undefined);
    assert.equal(stepOf(out, 'session').did, 'created a new session (retried after WebDriverAgent failed to start)');
    assert.equal(requests('POST', '/session').length, 2);

    // Only once, and one retry in all: a Web Inspector failure then a WebDriverAgent one is the failure.
    await lab.down([]);
    app.log.length = 0;
    app.fx.createErrors = [wda, wda];
    const failed = await lab.up([]);
    assert.equal(failed.failedStep, 'session');
    assert.match(failed.error, /WebDriverAgent/);
    assert.equal(requests('POST', '/session').length, 2);
    app.log.length = 0;
    app.fx.createErrors = ['remote debugger did not return any connected web applications after ~32000ms', wda];
    assert.equal((await lab.up([])).ok, false);
    assert.equal(requests('POST', '/session').length, 2);

    // The lab\'s own timeout is not a reply from Appium: a create still going is not sent again.
    app.log.length = 0;
    app.fx.createErrors = [];
    const realFetch = globalThis.fetch;
    SAFARI_WAIT.fetchLimitMs = 500e3; // so the 420 s create goes through fetch, which the stand-in below can time out
    let posts = 0;
    globalThis.fetch = (u, o) => {
      if (o?.method === 'POST' && String(u).endsWith('/session')) { posts++; return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })); }
      return realFetch(u, o);
    };
    try {
      const timedOut = await lab.up([]);
      assert.equal(timedOut.failedStep, 'session');
      assert.match(timedOut.error, /got no answer in 420s/);
      assert.equal(posts, 1);
    } finally { globalThis.fetch = realFetch; SAFARI_WAIT.fetchLimitMs = 280e3; }
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

// --- #46: a cold simulator `up` that fails at the session step says a rerun is the fix ---

const COLD_THEN = 'lab up --target simulator';
const WEB_INSPECTOR_TWICE = 'An unknown server-side error occurred while processing the command. Original error: remote debugger did not return any connected web applications after ~32000ms';
const WDA_TEXT = 'An unknown server-side error occurred while processing the command. Original error: Unable to launch WebDriverAgent because of xcodebuild failure: Failed to initialize for UI testing: Timed out waiting for AX loaded notification';

// The hint is `human` lines and `then`, as a device `needs` failure has, on the failed step and at the top level.
function assertColdHint(out, pattern, label) {
  const step = stepOf(out, 'session');
  for (const [where, o] of [['top level', out], ['the step', step]]) {
    assert.ok(Array.isArray(o.human) && o.human.length >= 2, `${label}: human on ${where}`);
    assert.match(o.human.join(' '), pattern, `${label}: ${where}`);
    assert.match(o.human.join(' '), /run the command below again/i, `${label}: ${where}`);
    assert.equal(o.then, COLD_THEN, `${label}: then on ${where}`);
  }
  assert.equal(out.failedStep, 'session', label);
  assert.ok(step.error.length > 0, label);
}

test('a cold simulator create that fails twice on Web Inspector carries a rerun hint on the step and at the top level', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  try {
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WEB_INSPECTOR_TWICE];
    const failed = await lab.up(['--target', 'simulator']);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /did not return any connected web applications/);
    assertColdHint(failed, /Web Inspector listed no pages/, 'web inspector');
    assert.equal(requests('POST', '/session').length, 2);

    // The other Web Inspector wording (applications with no pages) is the same class.
    await lab.down([]);
    const noPages = 'The remote debugger returned 4 web applications, but none of them had pages after 31022ms.';
    app.fx.createErrors = [noPages, noPages];
    assertColdHint(await lab.up(['--target', 'simulator']), /Web Inspector listed no pages/, 'no pages');
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('a cold simulator create that fails twice on WebDriverAgent carries a rerun hint', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  try {
    app.fx.createErrors = [WDA_TEXT, WDA_TEXT];
    const failed = await lab.up(['--target', 'simulator']);
    assert.match(failed.error, /WebDriverAgent/);
    assertColdHint(failed, /WebDriverAgent/, 'wda');
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('the lab\'s own 420 s create timeout on the simulator carries a rerun hint', async () => {
  const realFetch = globalThis.fetch;
  SAFARI_WAIT.fetchLimitMs = 500e3;
  globalThis.fetch = (u, o) => {
    if (o?.method === 'POST' && String(u).endsWith('/session')) return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    return realFetch(u, o);
  };
  try {
    const out = await lab.up(['--target', 'simulator']);
    assert.match(out.error, /got no answer in 420s/);
    assertColdHint(out, /420 s/, 'timeout');
  } finally { globalThis.fetch = realFetch; SAFARI_WAIT.fetchLimitMs = 280e3; }
});

test('a needs failure\'s then repeats the flags the run was given, quoted and in a stable order, and never --force (#106)', async () => {
  deviceWorld({ ...SILENT });
  savePhone({ seen: seenVia('tunnel') });
  const url = 'https://old.test/?a=1&b=2 x\'y';
  const out = await lab.up(['--target', 'device', '--allow-host', 'a.test', '--allow-host', 'B.test', '--url', url, '--no-focus', '--appearance', 'dark', '--orientation', 'landscape', '--force']);
  assert.deepEqual([out.ok, out.failedStep, out.needs], [false, 'phone', 'tunnel']);
  assert.equal(out.then, `lab up --target device --allow-host a.test --allow-host b.test --url 'https://old.test/?a=1&b=2 x'\\''y' --appearance dark --orientation landscape --no-focus`);
  assert.ok(!out.then.includes('--force'));
  assert.equal(out.or, 'lab up --target simulator', '`or` is left alone');

  // With no extra flags `then` is the table's own.
  assert.equal((await lab.up(['--target', 'device'])).then, 'lab up --target device');
  // --profile picks a simulator, which a device `then` refuses: it is left off.
  const auto = await lab.up(['--profile', 'configured', '--url', 'https://a.test/']);
  assert.deepEqual([auto.needs, auto.then], ['tunnel', 'lab up --target device --url https://a.test/']);
  // A `then` that is not a `lab up` is left as it is.
  saveState({ phone: null });
  const setup = await lab.up(['--target', 'device', '--allow-host', 'a.test']);
  assert.equal(setup.then, 'lab phone setup --udid <UDID> --team <TEAM>');
});

test('a --resign then keeps it and gets the run\'s flags after it (#106)', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(5) });
  savePhone({ wdaExpires: inHours(5) });
  app.fx.createDelayMs = 100;
  app.fx.onCreate = () => w.build(inHours(5));
  const out = await lab.up(['--allow-host', 'a.test', '--url', 'https://a.test/']);
  assert.equal(out.needs, 'resign');
  assert.equal(out.then, 'lab up --target device --resign --allow-host a.test --url https://a.test/');
});

test('a simulator then drops the phone-only flags and keeps --url and --profile, on the failed step too (#106)', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  try {
    app.fx.createErrors = [WDA_TEXT, WDA_TEXT];
    const out = await lab.up(['--target', 'simulator', '--profile', 'clean', '--allow-host', 'a.test', '--url', 'https://a.test/?x=1&y=2', '--no-focus', '--force']);
    const want = `lab up --target simulator --url 'https://a.test/?x=1&y=2' --profile clean`;
    assert.equal(out.then, want);
    assert.equal(stepOf(out, 'session').then, want);
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('the rerun hint says what happened: a mixed pair, or one failure that was not retried', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  const said = o => stepOf(o, 'session').human[0];
  const realFetch = globalThis.fetch;
  try {
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WDA_TEXT];
    const mixed = await lab.up(['--target', 'simulator']);
    assertColdHint(mixed, /first Web Inspector listed no pages, then WebDriverAgent failed to start/, 'mixed');
    assert.equal(requests('POST', '/session').length, 2);

    await lab.down([]);
    app.fx.createErrors = [WDA_TEXT, WEB_INSPECTOR_TWICE];
    assertColdHint(await lab.up(['--target', 'simulator']), /first WebDriverAgent failed to start, then Web Inspector listed no pages/, 'mixed the other way');

    // The retry then hit the lab's own limit: the hint names both.
    await lab.down([]);
    app.fx.createErrors = [WEB_INSPECTOR_TWICE];
    SAFARI_WAIT.fetchLimitMs = 500e3;
    let posts = 0;
    globalThis.fetch = (u, o) => {
      if (o?.method === 'POST' && String(u).endsWith('/session') && ++posts === 2) return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      return realFetch(u, o);
    };
    try {
      const out = await lab.up(['--target', 'simulator']);
      assert.match(said(out), /first Web Inspector listed no pages, then Appium gave no answer within 420 s/);
    } finally { globalThis.fetch = realFetch; SAFARI_WAIT.fetchLimitMs = 280e3; }

    // A first attempt that was not retried is not "twice".
    await lab.down([]);
    app.fx.createErrors = [];
    globalThis.fetch = (u, o) => (o?.method === 'POST' && String(u).endsWith('/session') ? Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) : realFetch(u, o));
    SAFARI_WAIT.fetchLimitMs = 500e3;
    try {
      const once = await lab.up(['--target', 'simulator']);
      assert.doesNotMatch(said(once), /twice|first/);
      assert.match(said(once), /Appium gave no answer within 420 s/);
    } finally { globalThis.fetch = realFetch; SAFARI_WAIT.fetchLimitMs = 280e3; }
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('a "no answer" that is not the lab\'s create limit (fetch\'s header timeout, a few seconds in) carries no 420 s hint', async () => {
  const realFetch = globalThis.fetch;
  SAFARI_WAIT.fetchLimitMs = 500e3;
  globalThis.fetch = (u, o) => {
    if (o?.method === 'POST' && String(u).endsWith('/session')) return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }));
    return realFetch(u, o);
  };
  try {
    const out = await lab.up(['--target', 'simulator']);
    assert.match(out.error, /got no answer in \d/);
    assert.doesNotMatch(out.error, /420s/);
    for (const x of [out, stepOf(out, 'session')]) assert.deepEqual([x.human, x.then], [undefined, undefined]);
  } finally { globalThis.fetch = realFetch; SAFARI_WAIT.fetchLimitMs = 280e3; }
});

test('no rerun hint for other session failures, nor after a retry that worked', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  const bare = o => { for (const x of [o, stepOf(o, 'session')]) assert.deepEqual([x.human, x.then, x.needs], [undefined, undefined, undefined]); };
  try {
    app.fx.createFails = true; // "session not created"
    const refused = await lab.up(['--target', 'simulator']);
    assert.equal(refused.failedStep, 'session');
    bare(refused);

    app.fx.createFails = false;
    app.fx.createErrors = ['The remote debugger returned 1 web application with pages after 31022ms, although none of them matched our page search criteria.'];
    bare(await lab.up(['--target', 'simulator']));

    // A WebDriverAgent text that is not Appium's reply (the lab's own failure) is not a cold-start class.
    app.fx.createErrors = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (u, o) => (o?.method === 'POST' && String(u).endsWith('/session') ? Promise.reject(new Error('connect to WebDriverAgent refused')) : realFetch(u, o));
    try { bare(await lab.up(['--target', 'simulator'])); } finally { globalThis.fetch = realFetch; }

    // A retry that worked has no failure to hint at.
    await lab.down([]);
    app.fx.createErrors = [WEB_INSPECTOR_TWICE];
    const ok = await lab.up(['--target', 'simulator']);
    assert.equal(ok.ok, undefined);
    assert.equal(ok.human, undefined);
    assert.equal(ok.then, undefined);
    assert.equal(stepOf(ok, 'session').human, undefined);
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('the rerun hint is printed by the CLI, for lab up and for safari start', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  const print = async (handlers, argv) => {
    const printed = [];
    const orig = console.log;
    console.log = l => printed.push(l);
    try { assert.equal(await cli(handlers, argv), 1); } finally { console.log = orig; }
    return JSON.parse(printed[0]);
  };
  try {
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WEB_INSPECTOR_TWICE];
    const up = await print(lab, ['up', '--target', 'simulator']);
    assert.equal(up.then, COLD_THEN);
    assert.match(up.human.join(' '), /Web Inspector/);
    assert.deepEqual(up.steps.at(-1).human, up.human);
    assert.equal(up.steps.at(-1).then, COLD_THEN);

    await lab.down([]);
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WEB_INSPECTOR_TWICE];
    const start = await print(safari, ['start', '--target', 'simulator']);
    assert.equal(start.then, COLD_THEN);
    assert.match(start.error, /did not return any connected web applications/);
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

// A failed step always carries an `error` a person can read, whatever was thrown.
test('the cold-boot wording is used only when this run booted the simulator', async () => {
  const keep = SAFARI_WAIT.createRetryMs;
  SAFARI_WAIT.createRetryMs = 10;
  try {
    // The simulator was already running: no claim of a cold boot, and no "usually works".
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WEB_INSPECTOR_TWICE];
    const warm = await lab.up(['--target', 'simulator']);
    assert.equal(stepOf(warm, 'simulator').found, 'booted');
    assertColdHint(warm, /failed twice on the simulator: first Web Inspector listed no pages, then Web Inspector listed no pages/, 'warm');
    for (const x of [warm, stepOf(warm, 'session')]) assert.doesNotMatch(x.human.join(' '), /cold boot|usually works/i);

    // This run booted it: the cold wording.
    await lab.down([]);
    sim.state = 'Shutdown';
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WEB_INSPECTOR_TWICE];
    const cold = await lab.up(['--target', 'simulator']);
    assert.match(stepOf(cold, 'simulator').did, /booted \(was shutdown\)/i);
    assertColdHint(cold, /failed twice on the simulator's cold boot/, 'cold');
    assert.match(cold.human.join(' '), /usually works the second time/);

    // `safari start` alone does not know how the simulator came up: the plain wording.
    await lab.down([]);
    app.fx.createErrors = [WEB_INSPECTOR_TWICE, WEB_INSPECTOR_TWICE];
    const printed = [];
    const orig = console.log;
    console.log = l => printed.push(l);
    try { await cli(safari, ['start', '--target', 'simulator']); } finally { console.log = orig; }
    assert.doesNotMatch(JSON.parse(printed[0]).human.join(' '), /cold boot/);
  } finally { SAFARI_WAIT.createRetryMs = keep; }
});

test('the empty-error routes of the failure artifacts and the tunnel host report text', async () => {
  // failureArtifacts: the screenshot and the page source are fetched, then writing them fails with an empty message.
  await lab.up(['--target', 'simulator']);
  const realFetch = globalThis.fetch;
  const realWrite = fs.writeFileSync;
  globalThis.fetch = (u, o) => (String(u).endsWith('/screenshot') || String(u).endsWith('/source')
    ? Promise.resolve(new Response(JSON.stringify({ value: 'aGk=' }), { headers: { 'content-type': 'application/json' } }))
    : realFetch(u, o));
  fs.writeFileSync = (f, ...rest) => {
    if (/\.(png|html)$/.test(String(f))) throw new Error('');
    return realWrite(f, ...rest);
  };
  try {
    const { artifacts } = await failureArtifacts('url', new Error('boom'));
    assert.ok(artifacts.screenshotError.trim().length > 0);
    assert.ok(artifacts.sourceError.trim().length > 0);
  } finally { fs.writeFileSync = realWrite; globalThis.fetch = realFetch; }
});

test('a session step that throws something odd still prints a non-empty error, on the step and at the top level', async () => {
  const real = safariHooks.touch;
  const cases = [
    ['a string', 'it broke', /it broke/],
    ['undefined', undefined, /^failed without a message$/],
    ['null', null, /^failed without a message$/],
    ['an empty string', '', /^failed without a message$/],
    ['an error with an empty message', new Error('')],
    ['an error with a blank message', new Error('  \n ')],
    ['an error with only a cause', new Error('', { cause: new Error('the inner reason') }), /the inner reason/],
    ['an abort error', Object.assign(new Error(''), { name: 'AbortError' }), /AbortError/],
    ['a plain object', { message: 'plain object message' }, /plain object message/],
    ['a number', 7, /7/],
  ];
  try {
    for (const [label, thrown, pattern] of cases) {
      await lab.down([]);
      safariHooks.touch = () => { throw thrown; };
      const out = await lab.up(['--target', 'simulator']);
      assert.equal(out.ok, false, label);
      assert.equal(out.failedStep, 'session', label);
      assert.equal(typeof out.error, 'string', label);
      assert.ok(out.error.trim().length > 0, `${label}: top-level error`);
      const step = stepOf(out, 'session');
      assert.ok(step, label);
      assert.equal(typeof step.error, 'string', label);
      assert.ok(step.error.trim().length > 0, `${label}: step error`);
      assert.equal(step.error, out.error, label);
      if (pattern) assert.match(out.error, pattern, label);
    }
  } finally { safariHooks.touch = real; }
});

test('the CLI prints a non-empty error for anything thrown, including a primitive', async () => {
  for (const thrown of ['it broke', undefined, null, new Error('')]) {
    const printed = [];
    const orig = console.log;
    console.log = l => printed.push(l);
    try { assert.equal(await cli({ boom: async () => { throw thrown; } }, ['boom']), 1); } finally { console.log = orig; }
    const out = JSON.parse(printed[0]);
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === 'string' && out.error.trim().length > 0, String(thrown));
  }
});

test('a session create slower than fetch\'s limit goes over node:http and succeeds; slower than its own timeout it is "no answer", never "not reachable"', async () => {
  const keep = SAFARI_WAIT.fetchLimitMs;
  const request = http.request;
  let viaHttp = 0;
  http.request = (...a) => { viaHttp++; return request(...a); };
  SAFARI_WAIT.fetchLimitMs = 100e3; // only the 420 s session create is over it
  try {
    app.fx.createDelayMs = 300;
    const out = await lab.up([]);
    assert.equal(out.ok, undefined);
    assert.equal(out.session, 'S1');
    assert.equal(viaHttp, 1); // the session POST only; everything else is fetch

    SAFARI_WAIT.fetchLimitMs = 100;
    const slow = wd(`http://127.0.0.1:${app.port}`, 'POST', '/session', { capabilities: {} }, 150);
    await assert.rejects(slow, /^Error: WebDriver POST \/session got no answer in 0\.2s \(Appium at http:\/\/127\.0\.0\.1:\d+ may be busy or stuck; check `lab status`\)$/);
    // A refused connection on that path is still "not reachable".
    await assert.rejects(wd('http://127.0.0.1:1', 'POST', '/session', {}, 150), /server not reachable at http:\/\/127\.0\.0\.1:1/);
  } finally {
    SAFARI_WAIT.fetchLimitMs = keep;
    http.request = request;
  }
});

test('fetch\'s own headers and body timeouts read as "no answer" (the server is there), not "not reachable"', async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('timeout'), { code }) }); };
      await assert.rejects(wd('http://127.0.0.1:4723', 'POST', '/session', {}, 60e3), /^Error: WebDriver POST \/session got no answer in 0s \(Appium at http:\/\/127\.0\.0\.1:4723 may be busy or stuck; check `lab status`\)$/, code);
    }
    globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); };
    await assert.rejects(wd('http://127.0.0.1:4723', 'GET', '/status', undefined, 60e3), /not reachable/);
  } finally { globalThis.fetch = realFetch; }
});

test('up after down loads the service again: enable, then bootstrap', async () => {
  const w = world();
  await lab.up([]);
  await lab.down([]);
  w.windowRunning = false; // the window we quit
  calls.length = 0;
  const out = await lab.up([]);
  assert.equal(out.ok, undefined);
  assert.match(stepOf(out, 'appium').did, /loaded the LaunchAgent/);
  assert.deepEqual(launchctl().filter(c => !c.startsWith('print')), [`enable ${TARGET}`, `bootstrap gui/${process.getuid()} ${svc.plistPath()}`]);
  assert.equal(stepOf(out, 'simulator').did, 'booted (was Shutdown)');
  assert.equal(loadState().windowApp, 'Simulator'); // not running before, so the lab opened it
  assert.equal((await lab.status()).service.loaded, true);
});

// --- phone: setup, status, forget ---

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phone');
const PHONE = '00008000-000A1B2C3D4E5F60'; // the fake phone in the fixtures
const TEAM = 'ABCDE12345';
const BUNDLE = 'com.dividedby.msl-wda-abcd';

// devicectl and security stand-ins on top of the simulator fakes; `files` maps a subcommand
// ('list devices', 'lockState') to { json: fixture name, code, stdout, stderr }.
function phoneWorld(files, { usbmux = true, expires } = {}) {
  process.env.MSL_APPIUM_HOME = linkPlugin(tempDir('msl-appium-'));
  phone.setUsbmux(() => usbmux);
  if (expires) {
    const app = path.join(process.env.MSL_APPIUM_HOME, 'wda-device', 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'embedded.mobileprovision'), 'x');
  }
  calls = fakeRunner((cmd, args) => {
    if (cmd === 'security') return { stdout: `<plist><dict><key>ExpirationDate</key><date>${expires}</date></dict></plist>` };
    if (cmd === 'xcrun' && args[0] === 'devicectl') {
      const sub = args.includes('lockState') ? 'lockState' : 'list devices';
      const f = files[sub];
      if (!f) return { code: 1, stderr: `unexpected devicectl ${sub}` };
      if (f.json) fs.writeFileSync(args[args.indexOf('--json-output') + 1], fs.readFileSync(path.join(FIX, f.json), 'utf8'));
      return { code: f.code ?? 0, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
    return undefined;
  });
  return calls;
}
const CABLE = { 'list devices': { json: 'devices-cable.json' }, lockState: { json: 'lock-unlocked.json' } };
const WIFI = { 'list devices': { json: 'devices-wifi.json' }, lockState: { json: 'lock-unlocked.json' } };
const ABSENT = { 'list devices': { json: 'devices-absent.json' } };
const devicectlCalls = c => c.filter(x => x[0] === 'xcrun' && x[1] === 'devicectl');

test('phone setup validates its input before running anything', async () => {
  const c = phoneWorld(CABLE);
  await assert.rejects(lab.phone([]), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['nope']), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['setup']), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['setup', '--udid', PHONE]), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--extra', 'x']), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['setup', 'x', '--udid', PHONE, '--team', TEAM]), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['setup', '--udid', 'nope', '--team', TEAM]), /--udid "nope" is not a device UDID/);
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', 'abcde12345']), /--team "abcde12345" is not a team id/);
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--bundle-id', 'nodots']), /--bundle-id "nodots" is not a bundle id/);
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--bundle-id', 'a b.c']), /not a bundle id/);
  assert.deepEqual(c, []);
  assert.equal(loadState().phone, undefined);
});

test('phone setup saves the phone with the default bundle id and reports transport and reachability', async () => {
  const c = phoneWorld(CABLE);
  const out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  const seen = { osVersion: '27.0.1', buildVersion: '24A446', at: loadState().phone.seen.at, via: 'usbmux' }; // how it was reached
  assert.ok(Math.abs(Date.now() - Date.parse(seen.at)) < 5000, 'seen is stamped now');
  assert.deepEqual(out.phone, { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, keyboard: { autocorrection: true, prediction: true }, seen });
  assert.deepEqual([out.status.osVersion, out.status.buildVersion], ['27.0.1', '24A446']);
  assert.equal(out.saved, true);
  assert.deepEqual([out.status.found, out.status.reachable, out.status.transport, out.status.locked, out.status.developerMode], [true, true, 'cable', false, true]);
  assert.equal(out.status.needs, undefined);
  assert.equal('name' in out.status, false);
  assert.deepEqual(loadState().phone, out.phone);
  assert.equal(loadState().udid, U, 'the simulator record is untouched');
  assert.ok(devicectlCalls(c).every(x => x.includes('list') || x.includes('lockState')), 'read-only devicectl calls');
});

test('phone setup over Wi-Fi, with a custom bundle id', async () => {
  phoneWorld(WIFI);
  const out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--bundle-id', 'com.example.wda']);
  assert.equal(out.status.transport, 'wifi');
  assert.equal(loadState().phone.bundleId, 'com.example.wda');
});

test('phone setup requires the phone to be found, and saves a found phone that is not reachable', async () => {
  phoneWorld(ABSENT);
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM]), e => {
    assert.match(e.message, /not in `devicectl list devices`/);
    assert.equal(e.extra.needs, 'cable');
    assert.ok(e.extra.human.length && e.extra.then);
    return true;
  });
  assert.equal(loadState().phone, undefined);

  // Listed but usbmux has lost it: found, not reachable, still saved, with needs in the status.
  phoneWorld(CABLE, { usbmux: false });
  const out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  assert.equal(out.saved, true);
  assert.deepEqual([out.status.found, out.status.reachable, out.status.transport, out.status.needs], [true, false, null, 'cable']);
  assert.ok(out.status.human.length && out.status.then);
});

test('phone setup merges: other fields stay, and the signing expiry only while phone, team and bundle are unchanged', async () => {
  phoneWorld(CABLE);
  const expires = '2026-10-23T12:00:00.000Z';
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, wdaExpires: expires, extra: 1 } });
  await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  const { seen, ...rest } = loadState().phone;
  assert.deepEqual(rest, { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, wdaExpires: expires, extra: 1, keyboard: { autocorrection: true, prediction: true } });
  assert.equal(seen.osVersion, '27.0.1');
  await lab.phone(['setup', '--udid', PHONE, '--team', 'ZZZZZ99999']);
  assert.deepEqual(loadState().phone, { udid: PHONE, teamId: 'ZZZZZ99999', bundleId: 'com.dividedby.msl-wda-zzzz', extra: 1, keyboard: { autocorrection: true, prediction: true }, seen: loadState().phone.seen });
  assert.equal(loadState().udid, U);
});

test('phone setup replaces a damaged phone record', async () => {
  phoneWorld(CABLE);
  saveState({ phone: 'junk' });
  await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  assert.deepEqual(loadState().phone, { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, keyboard: { autocorrection: true, prediction: true }, seen: loadState().phone.seen });
});

test('phone setup keeps the last seen version when the phone gave none, and drops it when the record is for a different phone', async () => {
  const noVersion = variant('devices-cable.json', j => { delete physical(j).deviceProperties.osVersionNumber; });
  deviceWorld({ ...CABLE, 'list devices': { raw: noVersion } });
  const seen = { osVersion: '26.4', buildVersion: '23E1', at: '2026-10-01T12:00:00.000Z' };
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, seen } });
  const out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  assert.equal(out.status.osVersion, null);
  assert.deepEqual(loadState().phone.seen, seen, 'same phone: the last version stays');

  // A different saved phone: its version says nothing about this one.
  saveState({ phone: { udid: 'FFFFFFFF-FFFFFFFFFFFFFFFF', teamId: TEAM, bundleId: BUNDLE, seen } });
  await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  assert.equal(loadState().phone.udid, PHONE);
  assert.equal('seen' in loadState().phone, false);
});

test('phone setup saves the keyboard restore target: each flag optional, an omitted one keeps the saved value or on, and bad values are refused before anything runs', async () => {
  const c = phoneWorld(CABLE);
  for (const bad of [['--autocorrection', 'maybe'], ['--prediction', 'ON'], ['--autocorrection', ''], ['--prediction', 'true']]) {
    await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM, ...bad]), new RegExp(`--${bad[0].slice(2)} "${bad[1]}" must be on or off`), bad.join(' '));
  }
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--autocorrection']), /--autocorrection needs a value/);
  assert.deepEqual(c, [], 'no command ran');
  assert.equal(loadState().phone, undefined);

  let out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--autocorrection', 'off']);
  assert.deepEqual(out.phone.keyboard, { autocorrection: false, prediction: true });
  out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--prediction', 'off']);
  assert.deepEqual(loadState().phone.keyboard, { autocorrection: false, prediction: false }, 'the saved autocorrection stays');
  out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM]);
  assert.deepEqual(out.phone.keyboard, { autocorrection: false, prediction: false }, 'a setup with no flags keeps both');
  out = await lab.phone(['setup', '--udid', PHONE, '--team', TEAM, '--autocorrection', 'on', '--prediction', 'on']);
  assert.deepEqual(loadState().phone.keyboard, { autocorrection: true, prediction: true });
});

test('phone status and lab status show the restore target; a record with no keyboard field means on, and a malformed one is a damaged record', async () => {
  phoneWorld(CABLE);
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, keyboard: { autocorrection: false, prediction: true } } });
  assert.deepEqual((await lab.phone(['status'])).phone.keyboard, { autocorrection: false, prediction: true });
  assert.deepEqual((await lab.status()).phone.keyboard, { autocorrection: false, prediction: true });
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  assert.deepEqual((await lab.phone(['status'])).phone.keyboard, { autocorrection: true, prediction: true });
  assert.deepEqual(phone.keyboardTarget(loadState()), { autocorrection: true, prediction: true });
  for (const keyboard of ['off', null, [], {}, { autocorrection: true }, { autocorrection: 'off', prediction: true }, { autocorrection: true, prediction: true, extra: 1 }]) {
    saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, keyboard } });
    assert.throws(() => phone.readPhone(loadState()), /damaged/, JSON.stringify(keyboard));
    assert.deepEqual(phone.keyboardTarget(loadState()), { autocorrection: true, prediction: true }, 'the restore itself never depends on it');
  }
});

test('phone status without a saved phone needs setup', async () => {
  const c = phoneWorld(CABLE);
  await assert.rejects(lab.phone(['status']), e => e.extra.needs === 'setup' && /no phone is saved/.test(e.message));
  assert.deepEqual(c, []);
  saveState({ phone: { udid: PHONE } });
  await assert.rejects(lab.phone(['status']), /damaged/);
  await assert.rejects(lab.phone(['status', 'x']), /usage: lab phone/);
});

test('phone status on a cable: transport, lock, developer mode, signing expiry and hours left; changes nothing', async () => {
  const exp = new Date(Date.now() + 36 * 3600e3).toISOString();
  const c = phoneWorld(CABLE, { expires: exp });
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  const before = JSON.stringify(loadState());
  const out = await lab.phone(['status']);
  assert.deepEqual([out.found, out.reachable, out.transport, out.locked, out.developerMode], [true, true, 'cable', false, true]);
  assert.equal(out.via, 'usbmux');
  assert.equal(out.needs, undefined);
  assert.deepEqual([out.osVersion, out.buildVersion], ['27.0.1', '24A446'], 'the live version, not saved');
  assert.equal(out.wdaExpires, exp);
  assert.ok(Math.abs(out.wdaHoursLeft - 36) < 0.2, String(out.wdaHoursLeft));
  assert.deepEqual(out.phone, { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, keyboard: { autocorrection: true, prediction: true }, focus: { enabled: true, onShortcut: 'Lab Focus On', offShortcut: 'Lab Focus Off' } }, 'the restore target and Lab Focus are shown, the defaults when none is saved');
  assert.equal(JSON.stringify(loadState()), before, 'read-only');
  assert.ok(c.every(x => ['xcrun', 'security'].includes(x[0])));
  assert.ok(c.filter(x => x[0] === 'xcrun').every(x => x[1] === 'devicectl' && (x.includes('list') || x.includes('lockState'))));
});

test('phone status says the route: usbmux over the cable, the tunnel over Wi-Fi, none when the phone is not reachable', async () => {
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  phoneWorld(WIFI);
  const wifi = await lab.phone(['status']);
  assert.deepEqual([wifi.reachable, wifi.transport, wifi.via], [true, 'wifi', 'tunnel']);
  phoneWorld(ABSENT);
  const gone = await lab.phone(['status']);
  assert.deepEqual([gone.reachable, gone.transport, gone.via], [false, null, null]);
});

test('phone status falls back to the recorded expiry, and reports none when unknown', async () => {
  phoneWorld(WIFI);
  const exp = new Date(Date.now() + 10 * 3600e3).toISOString();
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, wdaExpires: exp } });
  const out = await lab.phone(['status']);
  assert.equal(out.transport, 'wifi');
  assert.equal(out.wdaExpires, exp);
  assert.ok(out.wdaHoursLeft > 9 && out.wdaHoursLeft < 10.1);
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  const none = await lab.phone(['status']);
  assert.deepEqual([none.wdaExpires, none.wdaHoursLeft], [null, null]);
});

test('phone status when absent, locked, or unreachable carries needs and steps', async () => {
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  phoneWorld(ABSENT);
  let out = await lab.phone(['status']);
  assert.deepEqual([out.found, out.reachable, out.transport, out.needs], [false, false, null, 'cable']);
  assert.ok(out.human.length && out.then && out.or);

  phoneWorld({ ...CABLE, lockState: { json: 'lock-locked.json' } });
  out = await lab.phone(['status']);
  assert.deepEqual([out.reachable, out.locked, out.needs], [true, true, 'unlock']);

  phoneWorld({ 'list devices': { json: 'devices-offline-stale.json' }, lockState: { json: 'lock-offline.json', code: 1 } });
  out = await lab.phone(['status']);
  assert.deepEqual([out.found, out.reachable, out.transport, out.needs], [true, false, null, 'cable']);
});

const SILENT = { 'list devices': { json: 'devices-offline-stale.json' }, lockState: { json: 'lock-offline.json', code: 1 } };
const seenVia = via => ({ osVersion: '27.0.1', buildVersion: '24A446', at: new Date().toISOString(), ...(via ? { via } : {}) });

test('a phone that went silent is needs tunnel when it was last reached over Wi-Fi, needs cable when it was on the cable or never said (#59)', async () => {
  for (const [via, needs] of [['tunnel', 'tunnel'], ['usbmux', 'cable'], [undefined, 'cable']]) {
    saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, seen: seenVia(via) } });
    phoneWorld(SILENT);
    const out = await lab.phone(['status']);
    assert.deepEqual([out.reachable, out.needs], [false, needs], String(via));
    assert.equal(/last reached over Wi-Fi/.test(out.error), via === 'tunnel', String(via));
    assert.ok(out.human.length && out.then === 'lab up --target device');
  }
  // The phone absent from the device list altogether: the same words by how it was last reached.
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, seen: seenVia('tunnel') } });
  phoneWorld(ABSENT);
  assert.equal((await lab.phone(['status'])).needs, 'tunnel');
});

test('lab up with a phone last reached over Wi-Fi that is now silent stops at the phone step with needs tunnel, and keeps what it knew', async () => {
  const files = { ...SILENT };
  deviceWorld(files);
  savePhone({ seen: seenVia('tunnel') });
  const out = await lab.up(['--target', 'device']);
  assert.deepEqual([out.ok, out.failedStep, out.needs, out.then], [false, 'phone', 'tunnel', 'lab up --target device']);
  assert.equal(out.or, 'lab up --target simulator');
  assert.equal(loadState().phone.seen.via, 'tunnel', 'listed but not reached: it was last reached over Wi-Fi still');
  assert.equal(createdSessions(), 0);
  savePhone({ seen: seenVia('usbmux') });
  assert.equal((await lab.up(['--target', 'device'])).needs, 'cable');
});

test('phone forget removes the record, is idempotent, and leaves the simulator alone', async () => {
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  assert.deepEqual(await lab.phone(['forget']), { forgot: true, found: 'phone record removed' });
  assert.equal(loadState().phone, undefined);
  assert.equal(loadState().udid, U);
  assert.deepEqual(await lab.phone(['forget']), { forgot: false, found: 'no phone saved' });
  await assert.rejects(lab.phone(['forget', 'x']), /usage: lab phone/);
});

test('phone forget refuses while a device session is recorded, pointing to safari stop', async () => {
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE }, session: 'S1', backend: 'appium', port: 4723, target: { device: PHONE } });
  await assert.rejects(lab.phone(['forget']), /device session is open.*`safari stop`/);
  assert.equal(loadState().phone.udid, PHONE);
  saveState({ target: { device: 'nope' } }); // damaged but names a device
  await assert.rejects(lab.phone(['forget']), /`safari stop`/);
  saveState({ target: { simulator: U } }); // a simulator session does not block
  assert.equal((await lab.phone(['forget'])).forgot, true);
});

test('status has phone null with no record and makes no device calls', async () => {
  const c = phoneWorld(CABLE);
  const s = await lab.status();
  assert.equal(s.phone, null);
  assert.deepEqual(devicectlCalls(c), []);
});

test('status shows the saved phone from state only: no device commands, and a hint to check live', async () => {
  const exp = new Date(Date.now() + 48 * 3600e3).toISOString();
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, wdaExpires: exp } });
  for (const files of [CABLE, WIFI, ABSENT]) {
    const c = phoneWorld(files);
    const s = await lab.status();
    assert.deepEqual({ ...s.phone, wdaHoursLeft: undefined }, { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, wdaExpires: exp, keyboard: { autocorrection: true, prediction: true }, wdaHoursLeft: undefined, hint: '`lab phone status` checks the phone live; `seen` is the last time `lab up` or `lab phone setup` read it' });
    assert.ok(s.phone.wdaHoursLeft > 47 && s.phone.wdaHoursLeft < 48.1);
    assert.equal('status' in s.phone, false);
    assert.deepEqual(devicectlCalls(c), []);
    assert.ok(!c.some(x => x[0] === 'security' || x[0] === process.execPath), 'no profile or usbmux reads');
    assert.equal(s.simulator.udid, U);
  }
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE } });
  assert.equal((await lab.status()).phone.wdaHoursLeft, null);
});

test('status shows the cached iOS version as seen, and the session target type, still with no device calls', async () => {
  const seen = { osVersion: '27.0.1', buildVersion: '24A446', at: '2026-10-18T12:00:00.000Z' };
  saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, seen } });
  let c = phoneWorld(CABLE);
  assert.deepEqual((await lab.status()).phone.seen, seen);

  saveState({ session: 'S1', backend: 'appium', port: 4723, target: { simulator: U } });
  c.length = 0;
  const s = await lab.status();
  assert.deepEqual([s.session.targetType, s.session.target], ['simulator', { simulator: U }]);
  assert.deepEqual(devicectlCalls(c), []);

  saveState({ session: 'S1', backend: 'appium', port: 4723, target: { device: PHONE } });
  const d = await lab.status();
  assert.deepEqual([d.session.targetType, d.session.target], ['device', { device: PHONE }]);
  assert.deepEqual(devicectlCalls(c), []);
  assert.deepEqual(loadState().phone.seen, seen, 'status writes nothing');
});

test('status survives a damaged phone record', async () => {
  phoneWorld(CABLE);
  saveState({ phone: 'junk' });
  const s = await lab.status();
  assert.equal(s.phone.damaged, true);
  assert.match(s.phone.error, /lab phone forget/);
});

test('phone goes through cli as one JSON object per command', async () => {
  phoneWorld(CABLE);
  const lines = [];
  const log = console.log;
  console.log = l => lines.push(l);
  try {
    assert.equal(await cli(lab, ['phone', 'setup', '--udid', PHONE, '--team', TEAM]), 0);
    assert.equal(await cli(lab, ['phone', 'forget']), 0);
    assert.equal(await cli(lab, ['phone', 'bogus']), 1);
  } finally { console.log = log; }
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => JSON.parse(l).ok), [true, true, false]);
});

test('phone setup refuses while a device session is recorded, before asking the phone', async () => {
  const c = phoneWorld(CABLE);
  saveState({ session: 'S1', backend: 'appium', port: 4723, target: { device: PHONE } });
  await assert.rejects(lab.phone(['setup', '--udid', PHONE, '--team', TEAM]), /device session is open.*`safari stop`/);
  assert.deepEqual(c, []);
  assert.equal(loadState().phone, undefined);
});

// --- up on the phone ---

const HOUR = 3600e3;
const inHours = h => new Date(Date.now() + h * HOUR).toISOString();
// Lab Focus (#16) is on by default, so the phone these tests save opts out: they are about everything else. The Lab Focus tests turn it back on.
const savePhone = extra => saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, focus: { enabled: false }, ...extra } });

// Fixture JSON changed in place, for the cases the captured fixtures don't cover.
const variant = (name, edit) => { const j = JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); edit(j); return j; };
const physical = j => j.result.devices.find(d => d.hardwareProperties.reality === 'physical');

// The simulator fakes of the suite plus devicectl, security, launchctl and lsof, and a service
// plist that redacts. `w.build(expires)` plays Xcode writing the signed WDA build. The stand-in
// is the owner's phone from here on: `devicectl ... process launch` opens the lab's tab in it.
function deviceWorld(files = CABLE, { expires = null, launchdPid = 4242, listener = `${launchdPid}\n`, plist = true, extra = null } = {}) {
  app.fx.phone = true;
  const w = { expires, home: linkPlugin(tempDir('msl-appium-')) };
  process.env.MSL_APPIUM_HOME = w.home;
  phone.setUsbmux(() => true);
  w.products = path.join(w.home, 'wda-device', 'Build', 'Products');
  w.build = exp => {
    if (exp) w.expires = exp;
    const app = path.join(w.products, 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'embedded.mobileprovision'), 'x');
  };
  if (expires) w.build();
  const filters = path.join(dir, 'filters.json');
  fs.writeFileSync(filters, CURRENT_RULES);
  if (plist) {
    const args = [process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters, '--use-plugins', 'msl-page-pin'];
    fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  }
  const xcode = path.join(dir, 'Xcode', 'Contents', 'Developer');
  calls = fakeRunner((cmd, args) => {
    const mine = extra?.(cmd, args); // a test's own commands (ps, launchctl, osascript) come first
    if (mine) return mine;
    if (cmd === 'xcode-select') return { stdout: xcode + '\n' };
    if (cmd === 'security') return { stdout: `<plist><dict><key>ExpirationDate</key><date>${w.expires}</date></dict></plist>` };
    if (cmd === 'launchctl' && args[0] === 'print') return { stdout: `state = running\n\tpid = ${launchdPid}\n` };
    if (cmd === 'lsof') return { stdout: listener };
    if (cmd === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: U, name: 'Claude iPhone', state: sim.state, isAvailable: true }] } }) };
    if (cmd === 'xcrun' && args[1] === 'boot') { sim.state = 'Booted'; return undefined; }
    if (cmd === 'xcrun' && args[0] === 'devicectl' && args.includes('launch')) {
      app.launch(args[args.indexOf('--payload-url') + 1]);
      return { code: 0 };
    }
    if (cmd === 'xcrun' && args.slice(0, 4).join(' ') === 'devicectl device info apps') { // the `slot` step's listing (#63): the runner is on the phone
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ result: { apps: [{ bundleIdentifier: args[args.indexOf('--bundle-id') + 1] }] } }));
      return { code: 0 };
    }
    if (cmd === 'xcrun' && args[0] === 'devicectl') {
      const f = files[args.includes('lockState') ? 'lockState' : 'list devices'];
      if (!f) return { code: 1, stderr: 'unexpected devicectl call' };
      const out = args[args.indexOf('--json-output') + 1];
      if (f.raw) fs.writeFileSync(out, JSON.stringify(f.raw));
      else if (f.json) fs.writeFileSync(out, fs.readFileSync(path.join(FIX, f.json), 'utf8'));
      return { code: f.code ?? 0, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
    return undefined;
  });
  return w;
}
const createdSessions = () => requests('POST', '/session').length;
const stepNames = out => out.steps.map(s => s.step);

test('up with no phone saved is the simulator run and never calls devicectl', async () => {
  deviceWorld();
  const out = await lab.up([]);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'simulator', 'session']);
  assert.deepEqual(out.target, { simulator: U });
  assert.deepEqual(devicectlCalls(calls), []);
});

test('up --allow-host is checked first, passed to the phone session, and reported; a simulator run says it has no tab guard', async () => {
  for (const bad of ['*.old.test', 'https://old.test', 'old.test/x', 'u@old.test', '']) {
    await assert.rejects(lab.up(['--allow-host', bad]), /allowed host|wildcards are not taken/, JSON.stringify(bad));
  }
  await assert.rejects(lab.up(['--allow-host']), /--allow-host needs a value/);
  assert.equal(calls.length, 0);
  assert.equal(lease.read(), null);
  const sim = await lab.up(['--allow-host', 'Old.Test', '--allow-host', 'old.test']);
  assert.deepEqual(sim.allowHosts, ['old.test']);
  assert.equal(sim.note, 'the simulator has no tab guard; its tab may go to any site');
  assert.equal(loadState().deviceTab, undefined);
  await lab.down([]);

  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  const out = await lab.up(['--target', 'device', '--allow-host', 'old.test', '--allow-host', 'localhost:3000']);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(out.allowHosts, ['old.test', 'localhost:3000']);
  assert.equal(out.note, undefined);
  assert.deepEqual(loadState().deviceTab.allowHosts, ['old.test', 'localhost:3000']);
  const again = await lab.up(['--target', 'device', '--allow-host', 'third.test']);
  assert.equal(again.reused, true);
  assert.deepEqual(again.allowHosts, ['old.test', 'localhost:3000', 'third.test']);
  assert.deepEqual(loadState().deviceTab.allowHosts, ['old.test', 'localhost:3000', 'third.test']);
  assert.equal((await lab.up(['--target', 'device'])).allowHosts.length, 3, 'a later up that names none keeps them');
});

test('up --target auto with a reachable, unlocked phone drives the phone over a cable: no simulator step, no simctl at all', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  sim.state = 'Shutdown';
  const out = await lab.up([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'session']);
  assert.deepEqual(out.target, { device: PHONE });
  assert.equal(out.session, 'S1');
  assert.deepEqual(loadState().target, { device: PHONE });
  assert.match(stepOf(out, 'phone').found, /^iPhone over cable, unlocked, Developer Mode on; signing valid for 7[12](\.\d)? h$/);
  assert.equal(stepOf(out, 'phone').did, null);
  assert.deepEqual([out.phone.transport, out.phone.locked, out.phone.developerMode, out.phone.resigned], ['cable', false, true, false]);
  assert.deepEqual([out.phone.osVersion, out.phone.buildVersion, out.targetType], ['27.0.1', '24A446', 'device']);
  assert.equal(loadState().phone.seen.osVersion, '27.0.1');
  assert.equal(loadState().phone.wdaExpires, out.phone.wdaExpires, 'the signing expiry is cached next to seen');
  assert.ok(Math.abs(out.phone.wdaHoursLeft - 72) < 0.2);
  assert.deepEqual(calls.filter(c => c[0] === 'xcrun' && c[1] === 'simctl'), [], 'the simulator is never asked about, booted or shut down');
  assert.equal(sim.state, 'Shutdown');
  assert.equal(fs.existsSync(w.products), true, 'a build with 72 h left is kept');
  assert.equal(JSON.stringify(out).includes('Claude iPhone'), false);
});

// The Wi-Fi tunnel's world for `lab up`: pymobiledevice3 answers its version, the tunnel agent's plist
// exists, and starting the agent (launchctl kickstart) brings the host up as it does (tunnel.json up, its
// pid running `lab-tunnel-host`). Pass `.extra` to deviceWorld; the WebDriverAgent launch is recorded in
// `.spawned` and answered by the Appium stand-in's /status.
const HOST_PID = 5151;
const TUNNEL_TARGET = `gui/${process.getuid()}/com.dividedby.msl-tunnel`;
const tunnelRecord = (extra = {}) => ({ v: 1, pid: HOST_PID, udid: PHONE, address: 'fd00:1234::1', rsdPort: 54321, registryPort: 42999, startedAt: new Date().toISOString(), state: 'up', strongboxWas: null, strongboxOurs: true, ...extra });
function tunnelWorld({ tool = true, agent = true } = {}) {
  process.env.MSL_PMD3 = path.join(dir, 'bin', 'pymobiledevice3');
  if (agent) fs.writeFileSync(svc.tunnelPlistPath(), 'x');
  const t = { alive: false, kicks: 0, killed: 0, spawned: [] };
  tunnel.WDA.url = () => `http://127.0.0.1:${app.port}`;
  setSpawner((cmd, args, opts) => { t.spawned.push({ cmd, args, ...opts }); return { pid: 9001 }; });
  t.record = {}; // fields the host's record has besides the defaults (osVersion, say)
  t.start = () => { t.alive = true; tunnel.writeTunnel(tunnelRecord(t.record)); };
  t.extra = (cmd, args) => {
    if (args[0] === 'version' && cmd === process.env.MSL_PMD3) return tool ? { stdout: '11.40.2\n' } : { code: 127, stderr: 'no such file' };
    if (cmd === 'launchctl' && args[0] === 'kickstart' && args[1] === TUNNEL_TARGET) { t.kicks++; t.start(); return undefined; }
    if (cmd === 'launchctl' && args[0] === 'kill' && args[2] === TUNNEL_TARGET) { t.killed++; t.alive = false; return undefined; }
    if (cmd === 'launchctl' && args[0] === 'print' && args[1] === TUNNEL_TARGET) return { stdout: 'state = not running\n' };
    if (cmd === 'ps' && args.includes('command=') && args.at(-1) === String(HOST_PID)) return t.alive ? { stdout: `${process.execPath} ${REPO}/bin/lab-tunnel-host\n` } : { code: 1 };
    return undefined;
  };
  return t;
}

test('up over Wi-Fi opens the tunnel, starts WebDriverAgent on its address, and points Appium at it', async () => {
  const t = tunnelWorld();
  deviceWorld(WIFI, { expires: inHours(72), extra: t.extra });
  savePhone();
  const out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'tunnel', 'session']);
  assert.deepEqual([out.phone.transport, out.phone.via], ['wifi', 'tunnel']);
  assert.match(stepOf(out, 'phone').found, /^iPhone over wifi, unlocked/);
  assert.match(stepOf(out, 'tunnel').did, /started the tunnel host \(fd00:1234::1\)/);
  assert.equal(t.kicks, 1);
  assert.equal(t.spawned.length, 1, 'WebDriverAgent is started once');
  assert.equal(t.spawned[0].env.USE_IP, 'fd00:1234::1');
  assert.equal(t.spawned[0].args[t.spawned[0].args.indexOf('-destination') + 1], `id=${PHONE}`);
  const caps = requests('POST', '/session')[0][2].capabilities.alwaysMatch;
  assert.equal(caps['appium:webDriverAgentUrl'], 'http://[fd00:1234::1]:8100');
  assert.equal(caps['appium:wdaBindingIP'], 'fd00:1234::1');
  assert.equal(caps['appium:platformVersion'], '27.0.1');
  assert.ok(!Object.keys(caps).some(k => /xcodeOrgId|xcodeSigningId|updatedWDABundleId|derivedDataPath|useNewWDA/.test(k)));
  assert.deepEqual(loadState().transport, { via: 'tunnel', address: 'fd00:1234::1', startedAt: tunnel.readTunnel().startedAt }, 'the session records which tunnel it ran on');

  // The next `lab up` finds the session alive: no tunnel step, nothing started again.
  const again = await lab.up(['--target', 'device']);
  assert.equal(again.reused, true);
  assert.ok(!stepNames(again).includes('tunnel'));
  assert.equal(t.spawned.length, 1);

  // And `lab down` ends the session and the tunnel, in that order after the WebDriverAgent step.
  t.alive = true; // the stand-in host is still up (the record says so)
  const down = await lab.down([]);
  assert.equal(stepNames(down)[stepNames(down).indexOf('wda') + 1], 'tunnel');
  assert.equal(t.killed, 1);
  assert.equal(loadState().transport, undefined);
});

// --- `lab up` after the Wi-Fi tunnel dropped (#62): the old session is dropped at once ---

// A session over the tunnel (t.record's startedAt is fixed so a later host is told apart), then the drop: the host is gone and
// its record says down. Everything asked of the old session would be held (Appium waits on a dead route); a new create frees it.
async function droppedTunnel(t, { files = WIFI } = {}) {
  t.record = { startedAt: '2026-10-23T18:00:00.000Z' };
  deviceWorld(files, { expires: inHours(72), extra: t.extra });
  savePhone();
  const first = await lab.up(['--target', 'device']);
  assert.equal(first.ok, undefined, first.error);
  assert.equal(loadState().transport.startedAt, '2026-10-23T18:00:00.000Z');
  t.record = { startedAt: '2026-10-23T19:00:00.000Z' }; // the next host
  return first.session;
}
const onSession = (id, suffix) => app.log.filter(([, u]) => u.startsWith(`/session/${id}`) && u.endsWith(suffix));
const errorLines = async fn => { const real = console.error, lines = []; console.error = m => lines.push(String(m)); try { await fn(); } finally { console.error = real; } return lines; };

test('lab up after the tunnel dropped: the dead session gets no probe and no keyboard call, only a short delete; keyboardDeferred, no stderr, the tab is left and said so', async () => {
  const t = tunnelWorld();
  const old = await droppedTunnel(t);
  t.alive = false;
  tunnel.writeTunnel(tunnelRecord({ state: 'down', reason: 'tool-exited', strongboxOurs: false, startedAt: '2026-10-23T18:00:00.000Z' }));
  app.dv.queue = []; // the old session's Appium would not answer any request that reaches it
  app.fx.onCreate = () => { app.dv.queue = null; };
  app.log.length = 0;
  let out;
  const stderr = await errorLines(async () => { out = await lab.up(['--target', 'device']); });
  assert.equal(out.ok, undefined, out.error);
  assert.notEqual(out.session, old);
  assert.deepEqual(onSession(old, '/contexts').concat(onSession(old, '/appium/settings'), onSession(old, '/context')), [], 'nothing was asked of the old session');
  assert.deepEqual(app.log.filter(([m]) => m === 'DELETE').map(([, u]) => u), [`/session/${old}`], 'only a delete');
  assert.equal(createdSessions(), 1);
  assert.equal(stepOf(out, 'tunnel').found, 'tunnel down');
  assert.match(stepOf(out, 'session').found, /^session dead: its route to the phone is gone \(/);
  assert.equal(out.keyboardDeferred, 'the new session puts them back when it ends');
  assert.equal(out.keyboardRestored, undefined);
  assert.equal(out.keyboardNote, undefined);
  assert.deepEqual(out.human, out.previousTab.human, 'no keyboard step for the person: the mark stays and the new session restores; only the old tab\'s (#103)');
  assert.equal(loadState().keyboardPending, true);
  assert.equal(out.previousTab.tabLeft, 'previous');
  assert.match(out.previousTab.human[0], /Its session was on a tunnel that is gone, so the lab could not close it\. Close it by hand\./);
  assert.deepEqual(stderr.filter(l => /keyboard/.test(l)), []);
  assert.equal(stepOf(out, 'session').error, undefined);
});

test('a tunnel that was replaced, or a same tunnel whose phone does not answer, also drops the session without asking it', async () => {
  for (const how of ['replaced', 'silent']) {
    const t = tunnelWorld();
    const old = await droppedTunnel(t);
    if (how === 'replaced') { t.alive = true; tunnel.writeTunnel(tunnelRecord(t.record)); } // a newer host is up already
    else { t.alive = true; tunnel.writeTunnel(tunnelRecord({ startedAt: '2026-10-23T18:00:00.000Z' })); tunnel.hooks.probe = async () => false; }
    app.dv.queue = [];
    app.fx.onCreate = () => { app.dv.queue = null; };
    app.log.length = 0;
    const out = await lab.up(['--target', 'device']);
    assert.equal(out.ok, undefined, `${how}: ${out.error}`);
    assert.notEqual(out.session, old, how);
    assert.deepEqual(onSession(old, '/contexts').concat(onSession(old, '/appium/settings')), [], how);
    assert.match(stepOf(out, 'session').found, how === 'replaced' ? /its tunnel was replaced/ : /does not answer through the tunnel/, how);
    assert.equal(out.keyboardDeferred !== undefined, true, how);
    await lab.down([]);
  }
});

test('the same live tunnel and a session that is dead anyway: the old way (probe, keyboard restore, delete), with the note in the JSON', async () => {
  const t = tunnelWorld();
  const old = await droppedTunnel(t);
  t.alive = true;
  tunnel.writeTunnel(tunnelRecord({ startedAt: '2026-10-23T18:00:00.000Z' })); // the same tunnel, up, and the phone answers (the default probe)
  app.fx.sessions.delete(old); // Appium no longer knows the session
  app.log.length = 0;
  let out;
  const stderr = await errorLines(async () => { out = await lab.up(['--target', 'device']); });
  assert.equal(out.ok, undefined, out.error);
  assert.ok(onSession(old, '/contexts').length >= 1, 'the session was probed');
  assert.ok(onSession(old, '/appium/settings').length >= 1, 'the keyboard restore was tried');
  assert.equal(out.keyboardRestored, false);
  assert.match(out.keyboardNote, /^restoring the keyboard settings: /);
  assert.deepEqual(out.human, [...out.previousTab.human, phone.KEYBOARD_HUMAN]); // the old tab's step first (#103)
  assert.equal(out.keyboardDeferred, undefined);
  assert.doesNotMatch(out.previousTab.human[0], /tunnel that is gone/);
  assert.equal(stepOf(out, 'tunnel').found, 'tunnel up (fd00:1234::1)', 'the tunnel was kept');
  assert.deepEqual(stderr.filter(l => /keyboard/.test(l)), [], 'the note is in the JSON, not on stderr');
});

test('a live tunnel with WebDriverAgent silent and Appium still answering: lab up replaces the session instead of keeping it (no loop)', async () => {
  const t = tunnelWorld();
  const old = await droppedTunnel(t);
  t.alive = true;
  tunnel.writeTunnel(tunnelRecord({ startedAt: '2026-10-23T18:00:00.000Z' })); // the same tunnel, up and reachable
  // WebDriverAgent on the phone is dead; the lab's launch of a new one (the spawn) brings /status back.
  let silent = true;
  tunnel.WDA.url = () => (silent ? 'http://127.0.0.1:1' : `http://127.0.0.1:${app.port}`);
  const spawn = t.spawned;
  setSpawner((cmd, args, opts) => { silent = false; spawn.push({ cmd, args, ...opts }); return { pid: 9001 }; });
  app.dv.queue = []; // anything asked of the old session would be held
  app.fx.onCreate = () => { app.dv.queue = null; };
  app.log.length = 0;
  const out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, undefined, out.error);
  assert.notEqual(out.session, old, 'the dead-runner session was replaced');
  assert.equal(out.reused, false);
  assert.match(stepOf(out, 'session').found, /WebDriverAgent does not answer through the tunnel/);
  assert.deepEqual(onSession(old, '/contexts').concat(onSession(old, '/appium/settings')), []);
  assert.deepEqual(app.log.filter(([m]) => m === 'DELETE').map(([, u]) => u), [`/session/${old}`]);
  assert.equal(out.keyboardDeferred !== undefined, true);

  // With WebDriverAgent answering, the session is kept: one bounded probe, nothing else.
  const again = await lab.up(['--target', 'device']);
  assert.equal(again.reused, true);
  assert.equal(again.session, out.session);
});

test('a cable session is asked about as before, tunnel record or not', async () => {
  const t = tunnelWorld();
  deviceWorld(CABLE, { expires: inHours(72), extra: t.extra });
  savePhone();
  const first = await lab.up(['--target', 'device']);
  assert.deepEqual(loadState().transport, { via: 'usbmux' });
  t.start(); // a record of some other tunnel is there
  app.log.length = 0;
  const again = await lab.up(['--target', 'device']);
  assert.equal(again.reused, true);
  assert.equal(again.session, first.session);
  assert.ok(onSession(first.session, '/contexts').length >= 1, 'asked');
});

test('a Wi-Fi session start renews the lease around the WebDriverAgent build, after the launch and before the create (the tunnel wait renews it too, but a tunnel already up has none)', async () => {
  const t = tunnelWorld();
  const events = [];
  deviceWorld(WIFI, { extra: (cmd, args) => {
    if (cmd === 'xcodebuild') events.push('build');
    return t.extra(cmd, args);
  } }); // no signed build yet: the lab builds one first
  const spawn = t.spawned;
  setSpawner((cmd, args, opts) => { events.push('launch'); spawn.push({ cmd, args, ...opts }); return { pid: 9001 }; });
  savePhone();
  const real = safariHooks.touch;
  safariHooks.touch = () => { events.push(`touch:${requests('POST', '/session').length}`); };
  try {
    const out = await lab.up(['--target', 'device']);
    assert.equal(out.ok, undefined, out.error);
  } finally { safariHooks.touch = real; }
  const at = events.indexOf('build');
  assert.ok(at > 0 && events[at - 1].startsWith('touch') && events[at + 1].startsWith('touch'), `a touch on each side of the build: ${events}`);
  const launch = events.indexOf('launch');
  assert.ok(events.slice(launch).some(e => e === 'touch:0'), `a touch after the launch, before the session create: ${events}`);
});

test('over Wi-Fi the iOS version comes from the phone, else the tunnel\'s handshake, else the last one seen; with none the start stops before anything is sent', async () => {
  const noVersion = variant('devices-wifi.json', j => { delete physical(j).deviceProperties.osVersionNumber; });
  const files = { ...WIFI, 'list devices': { raw: noVersion } };
  const caps = () => requests('POST', '/session').at(-1)[2].capabilities.alwaysMatch;

  // Nowhere: an actionable error, no tab opened, no WebDriverAgent, no session create.
  let t = tunnelWorld();
  deviceWorld(files, { expires: inHours(72), extra: t.extra });
  savePhone();
  let out = await lab.up(['--target', 'device']);
  assert.deepEqual([out.ok, out.failedStep, out.needs, out.then], [false, 'session', 'unknown', 'lab phone status']);
  assert.match(out.human[0], /iOS version/);
  assert.equal(t.spawned.length, 0);
  assert.equal(createdSessions(), 0);
  assert.ok(!calls.some(c => c.includes('launch')), 'the lab\'s tab was not opened');

  // The tunnel's record has it (from rsd-info).
  t = tunnelWorld();
  t.record = { osVersion: '27.0.1' };
  deviceWorld(files, { expires: inHours(72), extra: t.extra });
  fs.rmSync(tunnel.tunnelFile(), { force: true });
  savePhone();
  out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(caps()['appium:platformVersion'], '27.0.1');

  // Only the version seen last time.
  await lab.down([]);
  t = tunnelWorld();
  deviceWorld(files, { expires: inHours(72), extra: t.extra });
  savePhone({ seen: { osVersion: '26.5', buildVersion: null, at: new Date().toISOString() } });
  out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(caps()['appium:platformVersion'], '26.5');
});

test('up over the cable stops a tunnel left up, and the caps are the cable\'s', async () => {
  const t = tunnelWorld();
  deviceWorld(CABLE, { expires: inHours(72), extra: t.extra });
  savePhone();
  t.start(); // a tunnel from an earlier Wi-Fi run
  const out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'tunnel', 'session']);
  assert.equal(stepOf(out, 'tunnel').did, 'stopped it');
  assert.equal(stepOf(out, 'tunnel').why, 'the cable was chosen');
  assert.equal(t.killed, 1);
  assert.equal(t.spawned.length, 0, 'the lab does not start WebDriverAgent itself over the cable');
  const caps = requests('POST', '/session')[0][2].capabilities.alwaysMatch;
  assert.equal(caps['appium:wdaBindingIP'], '127.0.0.1');
  assert.ok(!('appium:webDriverAgentUrl' in caps));
  assert.deepEqual(loadState().transport, { via: 'usbmux' });

  // With no tunnel left running there is no tunnel step at all.
  await lab.down([]);
  t.alive = false;
  const plain = await lab.up(['--target', 'device']);
  assert.ok(!stepNames(plain).includes('tunnel'));
});

test('up over Wi-Fi without the tool, without the agent, or with a phone that is not on the tunnel says what is missing, at the tunnel step', async () => {
  let t = tunnelWorld({ tool: false });
  deviceWorld(WIFI, { expires: inHours(72), extra: t.extra });
  savePhone();
  let out = await lab.up(['--target', 'device']);
  assert.deepEqual([out.ok, out.failedStep, out.needs], [false, 'tunnel', 'tunnel-tool']);
  assert.equal(t.kicks, 0);
  assert.equal(createdSessions(), 0);

  t = tunnelWorld({ agent: false });
  fs.rmSync(svc.tunnelPlistPath(), { force: true });
  deviceWorld(WIFI, { expires: inHours(72), extra: t.extra });
  out = await lab.up(['--target', 'device']);
  assert.deepEqual([out.ok, out.failedStep, out.needs], [false, 'tunnel', 'service']);
});

test('up over Wi-Fi with CoreDevice stuck restarts CoreDeviceService once, says so, and goes on', async () => {
  const t = tunnelWorld();
  let stuck = true;
  const core = `user/${process.getuid()}/com.apple.CoreDevice.CoreDeviceService`;
  let restarts = 0;
  const connecting = variant('devices-wifi.json', j => { physical(j).connectionProperties.tunnelState = 'connecting'; });
  deviceWorld({ ...WIFI, 'list devices': { raw: connecting } }, { expires: inHours(72), extra: (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'kickstart' && args[1] === '-k' && args[2] === core) { restarts++; stuck = false; return undefined; }
    if (stuck && cmd === 'xcrun' && args.includes('lockState')) return { code: 124, stderr: 'timed out after 20s' };
    return t.extra(cmd, args);
  } });
  savePhone();
  tunnel.coreDevice.done = false;
  const out = await lab.up(['--target', 'device']);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(restarts, 1);
  assert.match(stepOf(out, 'phone').did, /^restarted CoreDeviceService \(Xcode and devicectl connections drop briefly\)/);
  assert.equal(stepOf(out, 'phone').coreDeviceRestarted, true);
  assert.equal(out.phone.coreDeviceRestarted, true);
});

test('a device run needs no saved simulator at all', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  saveState({ udid: null });
  const out = await lab.up([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(out.target, { device: PHONE });
  const sim2 = await lab.up(['--target', 'simulator']);
  assert.equal(sim2.failedStep, 'prerequisites');
  assert.match(sim2.error, /sim create/);
});

test('--target simulator with a phone saved never asks the phone', async () => {
  deviceWorld(CABLE);
  savePhone();
  const out = await lab.up(['--target', 'simulator']);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'simulator', 'session']);
  assert.deepEqual(out.target, { simulator: U });
  assert.deepEqual(devicectlCalls(calls), []);
});

test('--target auto with a saved phone and a live simulator session reuses it without calling devicectl, even if the phone is gone', async () => {
  deviceWorld(ABSENT);
  app.fx.phone = false; // the simulator run: Appium's stand-in is not the phone here
  const first = await lab.up(['--target', 'simulator']);
  savePhone();
  const creates = createdSessions();
  const out = await lab.up([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(out.target, { simulator: U });
  assert.equal(out.reused, true);
  assert.equal(out.session, first.session);
  assert.equal(stepOf(out, 'phone').found, 'live simulator session');
  assert.deepEqual(devicectlCalls(calls), []);
  assert.equal(createdSessions(), creates);
  assert.equal(simctl('boot').length, 0);
});

test('a live device session is kept with one lock check and no other devicectl call; --resign under it and --target simulator beside it are refused', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  sim.state = 'Shutdown';
  const first = await lab.up([]);
  const before = devicectlCalls(calls).length;
  const again = await lab.up(['--target', 'device']);
  assert.equal(again.reused, true);
  assert.equal(again.session, first.session);
  assert.equal(stepOf(again, 'phone').found, 'live session on the phone');
  const asked = devicectlCalls(calls).slice(before);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes('lockState'), 'only the lock was asked');

  const resign = await lab.up(['--resign']);
  assert.equal(resign.failedStep, 'phone');
  assert.match(resign.error, /can't be re-signed under it.*`safari stop`/);

  const simRun = await lab.up(['--target', 'simulator']);
  assert.equal(simRun.failedStep, 'simulator');
  assert.match(simRun.error, /already open on .*device.*`safari stop`/);
  assert.equal(sim.state, 'Shutdown', 'the simulator was not booted under the phone run');
  assert.equal(loadState().session, first.session);
});

test('up on a live device session says needs unlock when the phone is locked, keeps the session, and is healthy again once unlocked', async () => {
  const files = { ...CABLE };
  deviceWorld(files, { expires: inHours(72) });
  savePhone();
  const first = await lab.up([]);
  assert.equal(first.ok, undefined, first.error);
  const creates = createdSessions();
  files.lockState = { json: 'lock-locked.json' };
  const locked = await lab.up([]);
  assert.equal(locked.ok, false);
  assert.equal(locked.failedStep, 'phone');
  assert.equal(locked.needs, 'unlock');
  assert.equal(locked.then, 'lab up --target device');
  assert.equal(loadState().session, first.session, 'the session was kept');
  assert.equal(createdSessions(), creates);
  // A lock check that fails is no lock: the session answers, so it is healthy.
  files.lockState = { json: 'lock-offline.json', code: 1, stderr: 'x' };
  assert.equal((await lab.up([])).ok, undefined);
  files.lockState = { json: 'lock-unlocked.json' };
  const again = await lab.up([]);
  assert.equal(again.ok, undefined, again.error);
  assert.equal(again.reused, true);
});

test('--target device beside a live simulator session is refused without asking the phone', async () => {
  deviceWorld(CABLE);
  await lab.up([]);
  savePhone();
  const out = await lab.up(['--target', 'device']);
  assert.equal(out.failedStep, 'phone');
  assert.match(out.error, /already open on .*simulator.*`safari stop`/);
  assert.deepEqual(devicectlCalls(calls), []);
});

test('up refuses what cannot be used, with needs, steps, and the simulator as the way out; no session, no simulator', async () => {
  const noDevMode = variant('devices-cable.json', j => { physical(j).deviceProperties.developerModeStatus = 'disabled'; });
  const unpaired = variant('devices-cable.json', j => { physical(j).connectionProperties.pairingState = 'unpaired'; });
  const table = [
    ['cable (not listed)', ABSENT, 'cable'],
    ['cable (listed but silent)', { 'list devices': { json: 'devices-offline-stale.json' }, lockState: { json: 'lock-offline.json', code: 1 } }, 'cable'],
    ['unlock', { ...CABLE, lockState: { json: 'lock-locked.json' } }, 'unlock'],
    ['developer-mode', { ...CABLE, 'list devices': { raw: noDevMode } }, 'developer-mode'],
    ['trust', { ...CABLE, 'list devices': { raw: unpaired } }, 'trust'],
  ];
  for (const mode of [[], ['--target', 'device']]) {
    for (const [name, files, needs] of table) {
      deviceWorld(files);
      savePhone();
      const out = await lab.up(mode);
      const label = `${name} ${mode.join(' ')}`;
      assert.equal(out.ok, false, label);
      assert.equal(out.failedStep, 'phone', label);
      assert.equal(out.needs, needs, label);
      assert.ok(out.human.length && out.then, label);
      assert.equal(out.or, 'lab up --target simulator', label);
      assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'phone'], label);
      assert.equal(out.steps.at(-1).error, out.error);
      assert.equal(createdSessions(), 0, label);
      assert.equal(simctl('boot').length, 0, label);
      // A phone that is listed gives its version even when it is refused; one that isn't listed gives none.
      assert.equal(loadState().phone.seen?.osVersion, name === 'cable (not listed)' ? undefined : '27.0.1', `${label}: the version is cached even when the phone is refused`);
    }
  }
});

test('--target device with no saved phone needs setup', async () => {
  deviceWorld(CABLE);
  const out = await lab.up(['--target', 'device']);
  assert.deepEqual([out.failedStep, out.needs, out.then], ['phone', 'setup', 'lab phone setup --udid <UDID> --team <TEAM>']);
  assert.deepEqual(devicectlCalls(calls), []);
  assert.equal(createdSessions(), 0);
  saveState({ phone: 'junk' });
  const bad = await lab.up(['--target', 'device']);
  assert.match(bad.error, /damaged/);
});

test('a session create that fails on the phone carries the needs the error text names', async () => {
  const table = [
    ['Timed out while enabling automation mode', 'passcode'],
    ['errSecInternalComponent while signing', 'keychain'],
    ['No signing certificate "iOS Development" found', 'xcode-account'],
    ['Cannot register more than 10 App IDs', 'slots'],
    ['something nobody has seen', 'unknown'],
  ];
  for (const [text, needs] of table) {
    deviceWorld(CABLE, { expires: inHours(72) });
    savePhone();
    app.fx.sessions.clear();
    app.fx.createErrors = [text];
    const out = await lab.up([]);
    assert.equal(out.failedStep, 'session', text);
    assert.equal(out.needs, needs, text);
    assert.ok(out.human.length, text);
    assert.equal(out.tabLeft, 'new', text); // the lab's tab is on the phone, and the person is told first
    assert.equal(out.tabClosed, false, text);
    assert.match(out.human[0], /^The lab opened a Safari tab \(https:\/\/example\.com\/\?msl-[0-9a-f]{8}\) but couldn't confirm it/, text);
    assert.equal(loadState().session, undefined, text);
  }
});

test('a phone create that fails on a cold-start text gets no simulator rerun hint', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  app.fx.sessions.clear();
  app.fx.createErrors = Array(2).fill('remote debugger did not return any connected web applications after ~32000ms');
  const out = await lab.up([]);
  assert.equal(out.failedStep, 'session');
  assert.equal(out.needs, 'unknown');
  assert.notEqual(out.then, 'lab up --target simulator');
  assert.ok(!out.human.join(' ').includes('run the command below again'));
  const step = stepOf(out, 'session');
  assert.deepEqual([step.human, step.then], [undefined, undefined]);
});

test('a failure that is not Appium\'s reply is not retried even when its text names WebDriverAgent', async () => {
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (u, o) => {
    if (o?.method === 'POST' && String(u).endsWith('/session')) { posts++; return Promise.reject(new Error('WebDriverAgent socket closed')); }
    return realFetch(u, o);
  };
  SAFARI_WAIT.fetchLimitMs = 500e3; // the simulator\'s create goes through fetch, which is stubbed here
  try {
    const out = await lab.up([]);
    assert.equal(out.failedStep, 'session');
    assert.match(out.error, /WebDriverAgent socket closed/); // wd words it as "not reachable (...)": the text matches the retry pattern
    assert.equal(posts, 1);
  } finally { globalThis.fetch = realFetch; SAFARI_WAIT.fetchLimitMs = 280e3; }
});

test('a WebDriverAgent failure on the phone is not retried by the lab (only the simulator\'s is)', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  app.fx.sessions.clear();
  app.fx.createErrors = ['Unable to launch WebDriverAgent because of xcodebuild failure: Timed out waiting for AX loaded notification'];
  const out = await lab.up([]);
  assert.equal(out.failedStep, 'session');
  assert.equal(requests('POST', '/session').length, 1);
});

test('up passes on what is left of the previous run\'s tab when it replaces a device session', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  const first = await lab.up([]);
  const { tag } = loadState().deviceTab;
  saveState({ deviceTab: { tainted: true, tag } }); // the tab guard stopped trusting it
  const again = await lab.up([]);
  assert.equal(again.ok, undefined, again.error);
  assert.notEqual(again.session, first.session);
  assert.deepEqual(again.previousTab, { tabClosed: false, tabLeft: 'previous', human: [`The previous run's lab tab (https://example.com/?${tag}) may still be open; the lab didn't touch it. Close it by hand.`] });
  assert.equal(loadState().deviceTab.tainted, undefined);
  const third = await lab.up([]); // a healthy session reused: nothing to report
  assert.equal(third.reused, true);
  assert.equal(third.previousTab, undefined);
  assert.equal('keyboardRestored' in again, true);
  assert.equal(again.keyboardRestored, true);
  assert.deepEqual(again.human, again.previousTab.human); // the old tab's step, where agents relay steps (#103)
});

test('up that replaces a device session whose restore fails says what to do by hand, next to the previous tab note', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  await lab.up([]);
  const { tag } = loadState().deviceTab;
  saveState({ deviceTab: { tainted: true, tag } });
  app.fx.keyboardFail = true;
  const again = await lab.up([]);
  assert.equal(again.ok, undefined, again.error);
  assert.equal(again.keyboardRestored, false);
  assert.deepEqual(again.human, [...again.previousTab.human, phone.KEYBOARD_HUMAN]); // the old tab's step first (#103)
  assert.equal(again.previousTab.human.length, 1);
  assert.equal(loadState().keyboardPending, true);
});

test('a device run refuses an Appium that could log page URLs: no filters, unreadable plist, not installed, another listener', async () => {
  const cases = [
    ['unreadable', {}, /arguments can't be read/, () => fs.writeFileSync(svc.plistPath(), 'x')],
    ['no filters', {}, /without log redaction \(`--log-filters`, at log level info or debug\)/, () => fs.writeFileSync(svc.plistPath(), '<plist><dict><key>ProgramArguments</key><array><string>node</string><string>appium</string></array></dict></plist>')],
    ['rules file gone', {}, /rules file .* is missing/, () => fs.rmSync(path.join(dir, 'filters.json'))],
    ['not running', { launchdPid: 0 }, /launchd is not running the service/],
    ['someone else listens', { listener: '999\n' }, /not the service \(launchd's pid 4242, listener 999\)/],
    ['nobody listens', { listener: '' }, /listener none/],
  ];
  for (const [name, opts, re, tweak] of cases) {
    deviceWorld(CABLE, { expires: inHours(72), ...opts });
    savePhone();
    tweak?.();
    const out = await lab.up([]);
    assert.equal(out.failedStep, 'phone', name);
    assert.equal(out.needs, 'service', name);
    assert.match(out.error, re, name);
    assert.equal(out.then, 'lab service install', name);
    assert.equal(createdSessions(), 0, name);
  }
  // An Appium at MSL_APPIUM_URL is not ours to check (the stand-in plays it).
  deviceWorld(CABLE, { expires: inHours(72), plist: false });
  savePhone();
  process.env.MSL_APPIUM_URL = `http://127.0.0.1:${app.port}`;
  try { assert.equal((await lab.up([])).ok, undefined); } finally { delete process.env.MSL_APPIUM_URL; }
});

test('--resign deletes only the WDA build folder, then the new expiry is read and cached', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(48) });
  savePhone({ wdaExpires: inHours(48) });
  const keep = [path.join(w.home, 'wda-device', 'Logs', 'x.log'), path.join(w.home, 'wda-device', 'Build', 'Intermediates.noindex', 'y'), path.join(w.home, 'node_modules', 'z')];
  for (const f of keep) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'keep'); }
  const fresh = inHours(24 * 7);
  app.fx.createDelayMs = 120; // Xcode builds while the session is being created
  app.fx.onCreate = () => w.build(fresh);
  const out = await lab.up(['--resign']);
  assert.equal(out.ok, undefined, out.error);
  assert.match(stepOf(out, 'phone').did, /^deleted the old WebDriverAgent build \(--resign\)/);
  assert.match(stepOf(out, 'phone').found, /signing to be renewed/);
  assert.ok(keep.every(f => fs.readFileSync(f, 'utf8') === 'keep'), 'nothing but Build/Products went');
  assert.equal(fs.existsSync(w.products), true, 'rebuilt');
  assert.equal(out.phone.resigned, true);
  assert.equal(out.phone.expiryMoved, undefined);
  assert.equal(out.phone.wdaExpires, fresh);
  assert.ok(Math.abs(out.phone.wdaHoursLeft - 168) < 0.2);
  assert.equal(loadState().phone.wdaExpires, fresh);
  assert.deepEqual(calls.filter(c => c[0] === 'rm'), []);
});

test('--resign says when the signing expiry did not move (Xcode reused the valid profile)', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(72) });
  savePhone({ wdaExpires: w.expires });
  app.fx.createDelayMs = 120;
  app.fx.onCreate = () => w.build(w.expires); // Xcode builds it again with the same profile
  const out = await lab.up(['--resign']);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.phone.resigned, true);
  assert.equal(out.phone.expiryMoved, false);
  assert.match(out.phone.note, /--resign did not move the signing expiry.*renews it only near expiry/);
});

test('under 24 h left, or an unknown expiry, re-signs without --resign; 24 h or more does not', async () => {
  for (const [label, hours, expectDelete] of [['10 h', 10, true], ['30 h', 30, false], ['unknown', null, true]]) {
    const w = deviceWorld(CABLE, { expires: hours === null ? '2020-01-01T00:00:00.000Z' : inHours(hours) });
    fs.writeFileSync(path.join(w.products, 'marker'), 'x');
    if (hours === null) w.expires = 'garbage'; // the profile can't be read, and none is recorded
    savePhone(hours === null ? {} : { wdaExpires: inHours(hours) });
    const out = await lab.up(['--target', 'device']);
    assert.equal(out.phone.resigned, expectDelete, label);
    assert.equal(fs.existsSync(path.join(w.products, 'marker')), !expectDelete, label);
    if (expectDelete) assert.match(stepOf(out, 'phone').did, hours === null ? /expiry unknown/ : /under 24 h left/, label);
    saveState({ session: null, backend: null, target: null });
    app.fx.sessions.clear();
  }
});

test('a first run with no build yet signs with the session and caches the expiry Xcode produced', async () => {
  const w = deviceWorld(CABLE);
  savePhone();
  const fresh = inHours(24 * 7);
  app.fx.createDelayMs = 100;
  app.fx.onCreate = () => w.build(fresh);
  const out = await lab.up([]);
  assert.equal(stepOf(out, 'phone').did, 'no WebDriverAgent build yet: Xcode signs one with the session');
  assert.equal(loadState().phone.wdaExpires, fresh);
  assert.equal(out.phone.wdaExpires, fresh);
});

test('an unreadable new expiry after signing is reported as unknown, not a failure', async () => {
  deviceWorld(CABLE);
  savePhone();
  const out = await lab.up([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual([out.phone.wdaExpires, out.phone.wdaHoursLeft], [null, null]);
});

test('a re-sign that still leaves under 24 h is needs:resign (the session stays open and the error says so)', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(5) });
  savePhone({ wdaExpires: inHours(5) });
  app.fx.createDelayMs = 100;
  app.fx.onCreate = () => w.build(inHours(5)); // Apple handed back the old profile
  const out = await lab.up([]);
  assert.equal(out.ok, false);
  assert.equal(out.needs, 'resign');
  assert.equal(out.failedStep, 'session');
  assert.match(out.error, /session is open; `safari stop` ends it/);
  assert.equal(out.then, 'lab up --target device --resign');
  assert.equal(loadState().session, 'S1');
});

test('the build folder is not deleted when it is a symlink', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(48) });
  savePhone({ wdaExpires: inHours(48) });
  const elsewhere = tempDir('msl-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'precious'), 'x');
  fs.rmSync(w.products, { recursive: true });
  fs.symlinkSync(elsewhere, w.products);
  const out = await lab.up(['--resign']);
  assert.equal(out.failedStep, 'phone');
  assert.match(out.error, /refusing to delete .* not a plain folder/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'precious'), 'utf8'), 'x');
  assert.equal(createdSessions(), 0);
});

test('up checks its flags before it takes the lease or touches anything', async () => {
  deviceWorld(CABLE);
  await assert.rejects(lab.up(['--target', 'both']), /--target must be one of auto, device, simulator/);
  await assert.rejects(lab.up(['--resing', 'x']), /usage: lab up/);
  await assert.rejects(lab.up(['--target']), /--target needs a value/);
  await assert.rejects(lab.up(['--resign']), /--resign .* needs a saved phone/);
  savePhone();
  await assert.rejects(lab.up(['--resign', '--target', 'simulator']), /--resign .* can't go with --target simulator/);
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(lease.read(), null);
});

test('up on the phone goes through cli as one JSON object, with needs on failure', async () => {
  deviceWorld(ABSENT);
  savePhone();
  const lines = [];
  const log = console.log;
  console.log = l => lines.push(l);
  try { assert.equal(await cli(lab, ['up']), 1); } finally { console.log = log; }
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]);
  assert.deepEqual([o.ok, o.failedStep, o.needs, o.or], [false, 'phone', 'cable', 'lab up --target simulator']);
});

test('the build folder is never reached through a symlinked wda-device or Build, and nothing outside the root is deleted', async () => {
  for (const level of ['wda-device', 'Build']) {
    const w = deviceWorld(CABLE, { expires: inHours(48) });
    savePhone({ wdaExpires: inHours(48) });
    // A real tree elsewhere that looks like the build folder; the link under the Appium home points at it.
    const outside = tempDir('msl-outside-');
    const precious = path.join(outside, ...(level === 'wda-device' ? ['Build', 'Products', 'precious'] : ['Products', 'precious']));
    fs.mkdirSync(path.dirname(precious), { recursive: true });
    fs.writeFileSync(precious, 'x');
    const link = level === 'wda-device' ? path.join(w.home, 'wda-device') : path.join(w.home, 'wda-device', 'Build');
    fs.rmSync(link, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    const out = await lab.up(['--resign']);
    assert.equal(out.failedStep, 'phone', level);
    assert.match(out.error, /refusing to delete .* not a plain folder/, level);
    assert.equal(fs.readFileSync(precious, 'utf8'), 'x', level);
    assert.equal(createdSessions(), 0, level);
  }
});

test('a symlinked Appium home is resolved: only its own build folder goes; a home with .. is refused', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(48) });
  savePhone({ wdaExpires: inHours(48) });
  const sibling = path.join(w.home, 'node_modules', 'keep');
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, 'x');
  const link = path.join(tempDir('msl-link-'), 'home');
  fs.symlinkSync(w.home, link);
  process.env.MSL_APPIUM_HOME = link;
  const fresh = inHours(24 * 7);
  app.fx.createDelayMs = 100;
  app.fx.onCreate = () => w.build(fresh);
  const out = await lab.up(['--resign']);
  assert.equal(out.ok, undefined, out.error);
  assert.match(stepOf(out, 'phone').did, /^deleted the old WebDriverAgent build/);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'x');

  saveState({ session: null, backend: null, target: null });
  app.fx.onCreate = undefined;
  const w2 = deviceWorld(CABLE, { expires: inHours(48) });
  savePhone({ wdaExpires: inHours(48) });
  fs.writeFileSync(path.join(w2.products, 'precious'), 'x');
  process.env.MSL_APPIUM_HOME = `${w2.home}/sub/..`;
  const bad = await lab.up(['--resign']);
  assert.equal(bad.failedStep, 'phone');
  assert.match(bad.error, /not an absolute, normalised path/);
  assert.equal(fs.readFileSync(path.join(w2.products, 'precious'), 'utf8'), 'x');
});

// --- down on the phone ---

const OTHER_PHONE = '00008000-000A1B2C3D4E5F61';
const wdaLine = (home, { udid = PHONE, dd = `${home}/wda-device`, exe = '/usr/bin/xcodebuild' } = {}) =>
  `${exe} build-for-testing test-without-building -project ${home}/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=${udid} -derivedDataPath ${dd}`;

// deviceWorld plus ps, launchd and SIGTERM. `procs` ([{ pid, ppid, command, now? }]) is the
// process table (`now` is what the pid runs by the time it is checked: it was reused).
// `runners`: pids of the runner app on the phone (#86); `sticky` (a field, so a test can change it): SIGKILL does not remove them.
function deviceDown({ procs = [], killWorks = true, extra: more = null, runners = [], sticky = false } = {}) {
  let table = []; // `procs` may be (home) => [...]: deviceWorld makes the Appium home
  const x = { kills: [], gone: new Set(), loaded: true, runners: new Set(runners), sticky };
  const w = deviceWorld(CABLE, { expires: inHours(72), extra: (cmd, args) => {
    const mine = more?.(cmd, args); // a test's own commands (the phone's appearance and orientation) come first
    if (mine) return mine;
    if (cmd === 'ps' && args[0] === '-ax') return { stdout: table.filter(p => !x.gone.has(String(p.pid))).map(p => `  ${p.pid}  ${p.ppid} ${p.command}`).join('\n') };
    if (cmd === 'ps' && !args.includes('etime=')) {
      const proc = table.find(p => String(p.pid) === args[3]);
      return { stdout: !proc || x.gone.has(args[3]) ? '' : proc.now ?? proc.command };
    }
    if (cmd === 'xcrun' && args.slice(0, 4).join(' ') === 'devicectl device info processes') { // the phone's process list (#86): no runner on it
      fs.writeFileSync(args[args.indexOf('--json-output') + 1], JSON.stringify({ result: { runningProcesses: [...w.runners].map(processIdentifier => ({ executable: 'file:///private/var/containers/Bundle/Application/ABC/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner', processIdentifier })) } }));
      return { code: 0 };
    }
    if (cmd === 'xcrun' && args.slice(0, 3).join(' ') === 'devicectl device process' && args[3] === 'signal') {
      if (!w.sticky) w.runners.delete(Number(args[args.indexOf('--pid') + 1]));
      return { code: 0 };
    }
    if (cmd === 'launchctl' && args[0] === 'print') return x.loaded ? { stdout: 'state = running\n\tpid = 4242\n' } : { code: 113, stderr: 'Could not find service' };
    if (cmd === 'launchctl' && args[0] === 'bootout') { x.loaded = false; app.fx.up = false; }
    if (cmd === 'launchctl' && args[0] === 'bootstrap') { x.loaded = true; app.fx.up = true; }
    return undefined;
  } });
  table = typeof procs === 'function' ? procs(w.home) : procs;
  svc.setKill((pid, sig) => { x.kills.push([pid, sig]); if (killWorks) x.gone.add(String(pid)); });
  savePhone();
  return Object.assign(w, x);
}
const runnerSignals = () => calls.filter(c => c[0] === 'xcrun' && c[1] === 'devicectl' && c[4] === 'signal');
const quickSettle = () => { const was = STOP_WAIT.settleMs; STOP_WAIT.settleMs = 5; return () => { STOP_WAIT.settleMs = was; }; };
const anySimctl = () => calls.filter(c => c[0] === 'xcrun' && c[1] === 'simctl');
const closeScriptAt = () => app.log.findIndex(([m, u, b]) => m === 'POST' && u.endsWith('/execute/sync') && b?.script?.includes('window.close'));
const deleteAt = () => app.log.findIndex(([m, u]) => m === 'DELETE' && u.endsWith('/session/S1'));

test('down on a device run closes the lab\'s tab before it deletes the session, stops the phone\'s xcodebuild, and runs no simctl or osascript', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7201, ppid: 1, command: wdaLine(home) }] });
  sim.state = 'Booted';
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  calls.length = 0;
  app.log.length = 0;

  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'session', 'wda', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium', 'release']);
  const session = stepOf(out, 'session');
  assert.equal(session.found, 'session S1 (appium)');
  assert.equal(session.did, 'ended it');
  assert.equal(session.tabClosed, true);
  assert.equal(session.human, undefined);
  assert.ok(closeScriptAt() >= 0 && deleteAt() > closeScriptAt(), 'the tab is closed, then the session deleted');
  assert.equal(requests('DELETE', '/session/S1').length, 1);
  assert.equal(stepOf(out, 'wda').found, 'xcodebuild (pid 7201)');
  assert.equal(stepOf(out, 'wda').did, 'stopped xcodebuild (pid 7201)');
  assert.deepEqual(w.kills, [[7201, 'SIGTERM']]);
  for (const name of ['simulator', 'window']) assert.deepEqual([stepOf(out, name).found, stepOf(out, name).did], ['skipped (device run)', null], name);
  assert.deepEqual(anySimctl(), [], 'no simctl at all');
  assert.equal(sim.state, 'Booted');
  assert.deepEqual(calls.filter(c => c[0] === 'osascript'), []);
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().deviceTab, undefined);
  assert.equal(loadState().target, undefined);
  assert.match(stepOf(out, 'appium').did, /^stopped it/);
  assert.equal(lease.read(), null);
  neverUnsafe(app);
});

test('a down whose wda step finds the runner still on the phone fails; the retry reads the phone, kills it and finishes (#86)', async () => {
  const restore = quickSettle();
  try {
    const w = deviceDown({ runners: [4321], sticky: true });
    sim.state = 'Booted';
    const up = await lab.up([]);
    assert.equal(up.ok, undefined, up.error);
    const first = await lab.down([]);
    assert.equal(first.ok, false);
    assert.equal(first.failedStep, 'wda');
    assert.match(first.error, /still on the phone \(pid 4321\).*volume buttons/);
    assert.match(first.error, /found: runner app on the phone \(pid 4321\); did: sent SIGKILL.*\): hold both volume buttons/);
    assert.match(first.error, /the lease is kept/);
    assert.equal(loadState().lastTarget, 'device', 'kept after a failed down');
    assert.equal(loadState().target, undefined, 'the later steps cleared the session: the retry has no device session to go by');

    w.sticky = false;
    calls.length = 0;
    const second = await lab.down([]);
    assert.equal(second.ok, undefined, second.error);
    assert.deepEqual(runnerSignals().map(c => [c[c.indexOf('--pid') + 1], c[c.indexOf('--signal') + 1]]), [['4321', 'SIGKILL']]);
    assert.equal(w.runners.size, 0);
    assert.match(stepOf(second, 'wda').did, /sent SIGKILL to the runner \(pid 4321\)/);
    assert.equal(loadState().lastTarget, undefined, 'a clean down clears it');
    assert.equal(lease.read(), null);
  } finally { restore(); }
});

test('the idle stop keeps retrying a runner that stays on the phone, counts each failure, and finishes once it is gone (#86)', async () => {
  const restore = quickSettle();
  try {
    const w = deviceDown({ runners: [4321], sticky: true });
    sim.state = 'Booted';
    await idleLab(20);
    const first = await lab.down(['--idle']);
    assert.equal(first.idle, true);
    assert.equal(first.ok, false);
    assert.equal(first.failedStep, 'wda');
    assert.equal(loadState().idleStop.failures, 1);
    assert.equal(loadState().lastTarget, 'device');

    setActive(20);
    calls.length = 0;
    const second = await lab.down(['--idle']);
    assert.equal(second.idle, true, second.reason);
    assert.deepEqual(second.running, ['the last run was on the phone and its stop did not finish']);
    assert.equal(second.ok, false);
    assert.equal(loadState().idleStop.failures, 2, 'the failure count goes up');
    assert.equal(runnerSignals().length, 1, 'the retry read the phone and signalled the runner again');

    w.sticky = false;
    setActive(20);
    calls.length = 0;
    const third = await lab.down(['--idle']);
    assert.equal(third.idle, true, third.reason);
    assert.equal(third.ok, undefined, third.error);
    assert.equal(w.runners.size, 0);
    assert.equal(loadState().lastTarget, undefined);
    assert.equal(loadState().idleStop.failures, 0);
    setActive(20);
    assert.equal((await lab.down(['--idle'])).reason, 'nothing the lab started is running');
  } finally { restore(); }
});

// Emits `signal` once the answer to the request matching `when` has been read, before the next request goes out.
async function signalAfter(when, signal, fn) {
  const orig = globalThis.fetch;
  let fired = false;
  globalThis.fetch = async (u, o) => {
    const r = await orig(u, o);
    if (fired || !when(String(u), o)) return r;
    fired = true;
    const text = await r.text();
    process.emit(signal, signal);
    return new Response(text, { status: r.status, headers: r.headers });
  };
  try { return await withInterrupt(fn); } finally { globalThis.fetch = orig; }
}

test('an interrupt while down ends a device session keeps the session record and the lease, and runs no further step', async () => {
  deviceDown({ procs: home => [{ pid: 7202, ppid: 1, command: wdaLine(home) }] });
  sim.state = 'Booted';
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  const sid = loadState().session;
  calls.length = 0;
  app.log.length = 0;
  const out = await signalAfter((u, o) => u.endsWith('/execute/sync') && /window\.close/.test(o?.body), 'SIGTERM', () => lab.down([]));
  assert.equal(out.ok, false);
  assert.match(out.error, /^session: interrupted by SIGTERM.*the lease is kept, run `lab down` again$/);
  assert.equal(out.failedStep, 'session');
  assert.equal(out.sessionKept, true);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'session'], 'nothing after the session step');
  assert.equal(requests('DELETE', `/session/${sid}`).length, 0, 'the session was not deleted');
  assert.equal(loadState().session, sid, 'so its record stays');
  assert.ok(loadState().deviceTab);
  assert.ok(lease.read(), 'the lease is kept');
  assert.deepEqual(calls.filter(c => c[0] === 'kill' || c[0] === 'launchctl'), [], 'no process stopped, no service touched');
  neverUnsafe(app);
});

test('an interrupt while down ends a simulator session keeps its record when the delete was not sent, and keeps the lease', async () => {
  world();
  await lab.up([]);
  const sid = loadState().session;
  calls.length = 0;
  app.log.length = 0;
  const out = await signalAfter(u => u.endsWith('/status'), 'SIGINT', () => lab.down([]));
  assert.equal(out.ok, false);
  assert.match(out.error, /^session: interrupted by SIGINT/);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'session']);
  assert.equal(requests('DELETE', `/session/${sid}`).length, 0);
  assert.equal(loadState().session, sid);
  assert.ok(lease.read());
  assert.deepEqual(simctl('shutdown'), []);
});

test('a signal during a synchronous step of down (simctl shutdown) stops the steps after it, keeps the lease, and exits 143', async () => {
  // A real signal that arrives while spawnSync runs is handled one macrotask after the child returns.
  world({ onShutdown: () => setImmediate(() => process.emit('SIGTERM', 'SIGTERM')) });
  saveState({ windowApp: 'Simulator' });
  await lab.up([]);
  calls.length = 0;
  const printed = [];
  const orig = console.log;
  console.log = l => printed.push(l);
  let code;
  try { code = await cli(lab, ['down']); } finally { console.log = orig; }
  assert.equal(code, 143);
  const out = JSON.parse(printed[0]);
  assert.equal(out.ok, false);
  assert.equal(out.interrupted, 'SIGTERM');
  assert.match(out.error, /interrupted by SIGTERM; the steps after it did not run; the lease is kept/);
  assert.deepEqual(out.steps.map(s => s.step), ['lease', 'session', 'wda', 'tunnel', 'simulator'], 'nothing after the simulator step');
  assert.deepEqual(simctl('shutdown'), [['xcrun', 'simctl', 'shutdown', U]]);
  assert.deepEqual(quits(), [], 'the window was not asked to quit');
  assert.deepEqual(launchctl().filter(c => !c.startsWith('print')), [], 'Appium was not stopped');
  assert.ok(lease.read(), 'the lease is kept');
});

test('lab up on the phone with MSL_SIGNLOCK=off reports signLock disabled and the warning at the top', async () => {
  deviceDown();
  const was = process.env.MSL_SIGNLOCK;
  process.env.MSL_SIGNLOCK = 'off';
  let out;
  try { out = await lab.up([]); } finally { if (was === undefined) delete process.env.MSL_SIGNLOCK; else process.env.MSL_SIGNLOCK = was; }
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.signLock, 'disabled');
  assert.equal(out.warning, 'sign lock disabled; sideload may sign at the same time (Xcode may then create a second certificate)');
});

test('a failed lab up on the phone with MSL_SIGNLOCK=off still reports signLock disabled and the warning at the top', async () => {
  deviceDown();
  app.fx.createErrors = ['xcodebuild failed with code 65'];
  const was = process.env.MSL_SIGNLOCK;
  process.env.MSL_SIGNLOCK = 'off';
  let out;
  try { out = await lab.up([]); } finally { if (was === undefined) delete process.env.MSL_SIGNLOCK; else process.env.MSL_SIGNLOCK = was; }
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'session');
  assert.ok(out.needs, 'the failure keeps its own fields');
  assert.equal(out.signLock, 'disabled');
  assert.equal(out.warning, 'sign lock disabled; sideload may sign at the same time (Xcode may then create a second certificate)');
});

const KB = phone.KEYBOARD_HUMAN;
const keyboardPosts = () => app.log.filter(([m, u, b]) => m === 'POST' && u.endsWith('/appium/settings') && Object.keys(b.settings).some(k => k.startsWith('keyboard')));

test('down on a device run restores the keyboard settings before the session is deleted, says so in the step and at the top, and clears the pending mark', async () => {
  deviceDown({ procs: home => [{ pid: 7601, ppid: 1, command: wdaLine(home) }] });
  await lab.up([]);
  assert.equal(loadState().keyboardPending, true);
  assert.deepEqual(app.fx.keyboard, { keyboardAutocorrection: false, keyboardPrediction: false });
  app.log.length = 0;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.keyboardRestored, true);
  assert.equal(out.human, undefined);
  assert.equal(stepOf(out, 'session').keyboardRestored, true);
  const at = app.log.findIndex(([m, u, b]) => m === 'POST' && u.endsWith('/appium/settings') && 'keyboardAutocorrection' in b.settings);
  assert.ok(at >= 0 && at < deleteAt(), 'the restore comes before DELETE /session');
  assert.deepEqual(app.log[at][2], { settings: { keyboardAutocorrection: true, keyboardPrediction: true } });
  assert.deepEqual(app.log.slice(at, deleteAt()).map(([m, u]) => `${m} ${u.replace('/session/S1', '')}`), ['POST /appium/settings', 'GET /appium/settings']);
  assert.deepEqual(app.fx.keyboard, { keyboardAutocorrection: true, keyboardPrediction: true });
  assert.equal(loadState().keyboardPending, undefined);
  neverUnsafe(app);
});

test('down honours a saved target of off', async () => {
  deviceDown();
  savePhone({ keyboard: { autocorrection: true, prediction: false } });
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.keyboardRestored, true);
  assert.deepEqual(app.fx.keyboard, { keyboardAutocorrection: true, keyboardPrediction: false });
});

test('a failed restore never fails down: it adds keyboardRestored false and the human step, and the teardown still finishes', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7701, ppid: 1, command: wdaLine(home) }] });
  await lab.up([]);
  app.fx.keyboardFail = 'refused for 00008000-000A1B2C3D4E5F60';
  const real = console.error, notes = [];
  console.error = m => notes.push(m);
  let out;
  try { out = await lab.down([]); } finally { console.error = real; }
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.keyboardRestored, false);
  assert.deepEqual(out.human, [KB]);
  assert.equal(stepOf(out, 'session').keyboardRestored, false);
  assert.deepEqual(stepOf(out, 'session').human, [KB]);
  assert.equal(stepOf(out, 'session').did, 'ended it');
  assert.equal(requests('DELETE', '/session/S1').length, 1, 'the session was still deleted');
  assert.ok(w.kills.some(k => k[0] === 7701), 'the WebDriverAgent was still stopped');
  assert.ok(out.steps.some(s => s.step === 'release'), 'the lease was released');
  assert.equal(loadState().session, undefined);
  assert.equal(loadState().keyboardPending, undefined, 'said once, then cleared');
  assert.doesNotMatch(notes.join('\n'), /00008000-000A1B2C3D4E5F60/);
});

test('down with a restore still pending and no session to use does not start one: it says the person has to turn the settings on', async () => {
  deviceDown();
  sim.state = 'Shutdown';
  saveState({ keyboardPending: true });
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.keyboardRestored, false);
  assert.deepEqual(out.human, [KB]);
  assert.equal(stepOf(out, 'session').found, 'no session');
  assert.deepEqual(stepOf(out, 'session').human, [KB]);
  assert.deepEqual(app.log.filter(([m, u]) => m === 'POST' && u === '/session'), [], 'no session was created');
  assert.deepEqual(keyboardPosts(), []);
  assert.equal(loadState().keyboardPending, undefined, 'said once, then cleared');
  const again = await lab.down([]);
  assert.equal('keyboardRestored' in again, false, 'a later down does not repeat it');
});

test('a pending restore is cleared by the next session that ends with a verified restore, and a plain down with nothing pending says nothing about the keyboard', async () => {
  deviceDown();
  saveState({ keyboardPending: true });
  await lab.up([]);
  assert.equal(loadState().keyboardPending, true);
  const out = await lab.down([]);
  assert.equal(out.keyboardRestored, true);
  assert.equal(loadState().keyboardPending, undefined);
  const again = await lab.down([]);
  assert.equal('keyboardRestored' in again, false);
  assert.equal('human' in again, false);
});

test('safari stop then lab down: the restore happens once, at stop', async () => {
  deviceDown();
  await lab.up([]);
  assert.equal((await safari.stop()).keyboardRestored, true);
  const out = await lab.down([]);
  assert.equal('keyboardRestored' in out, false);
  assert.equal(keyboardPosts().length, 1);
});

test('a simulator run never restores the keyboard or marks it pending', async () => {
  sim.state = 'Booted';
  await lab.up(['--target', 'simulator']);
  assert.equal(loadState().keyboardPending, undefined);
  app.log.length = 0;
  const out = await lab.down([]);
  assert.equal('keyboardRestored' in out, false);
  assert.deepEqual(app.log.filter(([, u]) => u.endsWith('/appium/settings')), []);
});

test('a second down on the phone run finds nothing, touches no tab, no process, no simulator', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7201, ppid: 1, command: wdaLine(home) }] });
  sim.state = 'Shutdown';
  await lab.up([]);
  await lab.down([]);
  calls.length = 0;
  app.log.length = 0;
  w.kills.length = 0;
  // The first down used up lastTarget; with no session and no target the simulator logic finds it shut down.
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.ok(out.steps.every(s => s.did === null), JSON.stringify(didOf(out)));
  assert.equal(stepOf(out, 'session').found, 'no session');
  assert.equal(stepOf(out, 'wda').found, 'none running');
  assert.equal(stepOf(out, 'simulator').found, 'shutdown');
  assert.equal(stepOf(out, 'window').found, 'no window opened by the lab');
  assert.equal(app.log.length, 0);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(anySimctl().filter(c => ['boot', 'shutdown'].includes(c[2])), []);
  assert.deepEqual(calls.filter(c => c[0] === 'osascript'), []);
});

test('the phone\'s xcodebuild is stopped only when the command line carries both the phone and the device derived-data folder', async () => {
  const w = deviceDown({ procs: home => {
    const good = wdaLine(home);
    return [
    { pid: 7301, ppid: 1, command: good }, // orphaned after the session went
    { pid: 7302, ppid: 4242, command: good }, // still Appium's child
    { pid: 7303, ppid: 1, command: wdaLine(home, { udid: OTHER_PHONE }) }, // another phone
    { pid: 7304, ppid: 1, command: wdaLine(home, { dd: '/Users/x/work/wda-device' }) }, // another folder
    { pid: 7305, ppid: 1, command: wdaLine(home, { dd: `${home}/wda-device-old` }) }, // the folder name only starts the same
    { pid: 7306, ppid: 1, command: wdaLine(home, { dd: `/elsewhere${home}/wda-device` }) }, // the folder is the tail of another path
    { pid: 7307, ppid: 1, command: `vim ${home}/wda-device id=${PHONE}` }, // not xcodebuild
    { pid: 7308, ppid: 1, command: `sudo ${good}` }, // not the executable
    { pid: 7309, ppid: 999, command: good }, // somebody else's child
    { pid: 7310, ppid: 1, command: good, now: `vim notes id=${PHONE} ${home}/wda-device` }, // pid reused since the listing
    { pid: 7311, ppid: 1, command: good.replace(`id=${PHONE}`, `id=${PHONE}0`) }, // the id is a prefix of a longer token
    { pid: 7312, ppid: 1, command: good.replace(`id=${PHONE}`, `platform=iOS,x${PHONE}`) }, // no id= token
    ];
  } });
  sim.state = 'Shutdown'; // no session and no target: the simulator logic runs, and finds it down
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(w.kills, [[7301, 'SIGTERM'], [7302, 'SIGTERM']]);
  assert.match(stepOf(out, 'wda').found, /^xcodebuild \(pid 7301\), xcodebuild \(pid 7302\), xcodebuild \(pid 7310\); xcodebuild \(pid 7310\) is now something else: left alone$/);
  assert.equal(stepOf(out, 'wda').did, 'stopped xcodebuild (pid 7301), xcodebuild (pid 7302)');
  assert.ok(!calls.some(c => ['kill', 'pkill', 'killall'].includes(c[0])));
});

test('isDeviceWda needs the anchored executable, the phone as its own id= token and the folder as its own path', () => {
  const home = '/Users/x/.local/share/msl-appium';
  const dd = `${home}/wda-device`;
  const line = wdaLine(home);
  assert.equal(isDeviceWda(line, [PHONE], dd), true);
  assert.equal(isDeviceWda(line.replace('/usr/bin/xcodebuild', 'xcodebuild'), [PHONE], dd), true);
  assert.equal(isDeviceWda(line.replace(`id=${PHONE}`, `platform=iOS,id=${PHONE}`), [PHONE], dd), true);
  assert.equal(isDeviceWda(line, [OTHER_PHONE], dd), false);
  assert.equal(isDeviceWda(line, [OTHER_PHONE, PHONE], dd), true);
  assert.equal(isDeviceWda(line, [PHONE], `${home}/wda-simulator`), false);
  assert.equal(isDeviceWda(line.replace(`id=${PHONE}`, ''), [PHONE], dd), false);
  assert.equal(isDeviceWda(line.replace(` -derivedDataPath ${dd}`, ''), [PHONE], dd), false);
  assert.equal(isDeviceWda(`nice ${line}`, [PHONE], dd), false);
  assert.equal(isDeviceWda(line.replace('/usr/bin/xcodebuild', '/usr/bin/xcodebuild-wrapper'), [PHONE], dd), false);
  // No phone in the state, no targets, whatever runs.
  assert.deepEqual(deviceWdaTargets({}, [{ pid: 1234, ppid: 1, command: line }]), []);
});

test('a lab tab that cannot be confirmed is left alone and said so in the session step; the session is still deleted', async () => {
  deviceDown();
  await lab.up([]);
  const { tag } = loadState().deviceTab;
  saveState({ deviceTab: { tainted: true, tag } });
  app.log.length = 0;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  const session = stepOf(out, 'session');
  assert.equal(session.tabClosed, false);
  assert.equal(session.tabLeft, 'lab');
  assert.match(session.human[0], /Close the lab's tab on the phone by hand/);
  assert.equal(closeScriptAt(), -1, 'nothing ran in the tab');
  assert.equal(requests('DELETE', '/session/S1').length, 1);
  assert.equal(loadState().deviceTab, undefined);
  assert.equal(loadState().session, undefined);
  neverUnsafe(app);
});

test('a simulator session with a phone saved and no window the lab opened: down shuts the simulator down, and lastTarget is cleared', async () => {
  const w = world();
  savePhone();
  const up = await lab.up(['--target', 'simulator']);
  assert.equal(up.ok, undefined, up.error);
  assert.equal(loadState().windowApp, undefined);
  assert.equal(loadState().lastTarget, 'simulator');
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(stepOf(out, 'simulator').did, 'shut down');
  assert.deepEqual(simctl('shutdown'), [['xcrun', 'simctl', 'shutdown', U]]);
  assert.equal(stepOf(out, 'window').found, 'no window opened by the lab');
  assert.equal(loadState().lastTarget, undefined);
  assert.equal(w.kills.length, 0);
});

test('with no session recorded, lastTarget decides: device skips the simulator and window, simulator (or none) keeps the simulator logic', async () => {
  world();
  savePhone();
  saveState({ lastTarget: 'device', windowApp: 'Simulator' });
  sim.state = 'Booted';
  const skipped = await lab.down([]);
  assert.equal(skipped.ok, undefined, skipped.error);
  assert.equal(stepOf(skipped, 'simulator').found, 'skipped (device run)');
  assert.equal(stepOf(skipped, 'window').found, 'skipped (device run)');
  assert.equal(simctl('shutdown').length, 0);
  assert.equal(quits().length, 0);
  assert.equal(sim.state, 'Booted');
  assert.equal(loadState().lastTarget, undefined, 'cleared after the simulator and window steps');
  assert.equal(loadState().windowApp, 'Simulator', 'the window record stays for a simulator run');

  for (const last of ['simulator', undefined]) {
    world();
    saveState({ lastTarget: last ?? null, windowApp: 'Simulator' });
    sim.state = 'Booted';
    const out = await lab.down([]);
    assert.equal(out.ok, undefined, out.error);
    assert.equal(stepOf(out, 'simulator').did, 'shut down', String(last));
    assert.equal(stepOf(out, 'window').did, 'asked Simulator to quit', String(last));
  }
});

test('lastTarget survives a failed down, so a retry still skips the simulator', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7601, ppid: 1, command: wdaLine(home) }], killWorks: false });
  await lab.up([]);
  assert.equal(loadState().lastTarget, 'device');
  await safari.stop();
  assert.equal(loadState().lastTarget, 'device');
  const first = await lab.down([]);
  assert.equal(first.failedStep, 'wda');
  assert.equal(stepOf(first, 'simulator').found, 'skipped (device run)');
  assert.equal(loadState().lastTarget, 'device');
  assert.deepEqual(anySimctl(), []);
  assert.ok(w.kills.length >= 1);
});

test('an xcodebuild for the phone that will not exit fails the wda step, and the later steps still run', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7401, ppid: 1, command: wdaLine(home) }], killWorks: false });
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'wda');
  assert.match(stepOf(out, 'wda').error, /xcodebuild \(pid 7401\) didn't exit/);
  assert.equal(stepOf(out, 'session').did, 'ended it');
  assert.equal(stepOf(out, 'simulator').found, 'skipped (device run)');
  assert.match(stepOf(out, 'appium').did, /^stopped it/);
  assert.equal(lease.read().owner, 'me');
  assert.deepEqual(w.kills, [[7401, 'SIGTERM']]);
});

test('safari stop on a device run also stops the phone\'s xcodebuild; a second stop finds nothing', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7501, ppid: 1, command: wdaLine(home) }] });
  await lab.up([]);
  app.log.length = 0;
  const out = await safari.stop();
  assert.deepEqual(out, { stopped: true, tabClosed: true, keyboardRestored: true, wda: 'stopped xcodebuild (pid 7501)' });
  assert.ok(closeScriptAt() >= 0 && deleteAt() > closeScriptAt(), 'the tab is closed, then the session deleted');
  assert.deepEqual(w.kills, [[7501, 'SIGTERM']]);
  assert.deepEqual(await safari.stop(), { stopped: true });
  assert.deepEqual(w.kills, [[7501, 'SIGTERM']]);
  neverUnsafe(app);
});

// --- the idle stop: lab down --idle ---

const IDLE_TARGET = `gui/${process.getuid()}/com.dividedby.msl-idle`;
const activityPath = () => path.join(stateDir(), 'activity.json');
// The last lease command was `min` minutes ago.
const setActive = min => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(activityPath(), JSON.stringify({ at: new Date(Date.now() - min * 60e3).toISOString() })); };
// `lab up`, then the agent lets go of the lease (as `safari stop` does) and the last command was `min` minutes ago.
async function idleLab(min = 20) {
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  await lease.release({ owner: 'me' });
  setActive(min);
  calls.length = 0;
  app.log.length = 0;
}
// Runs `fn` with console.error recorded.
async function logged(fn) {
  const lines = [];
  const real = console.error;
  console.error = m => lines.push(String(m));
  try { return [await fn(), lines]; } finally { console.error = real; }
}
const asLeaseHolder = owner => fs.writeFileSync(path.join(stateDir(), 'lease.json'), JSON.stringify({ owner, since: new Date().toISOString(), expires: new Date(Date.now() + 600e3).toISOString() }));
const stopCommands = () => calls.filter(c => c[0] === 'launchctl' && !['print'].includes(c[1])).length + simctl('shutdown').length;

test('down --idle with a live lease or a recent command does nothing at all: no command, no request', async () => {
  world();
  await lab.up([]); // the lease is held by "me"
  setActive(60);
  calls.length = 0;
  app.log.length = 0;
  const held = await lab.down(['--idle']);
  assert.deepEqual(held, { idle: false, reason: held.reason });
  assert.match(held.reason, /in use: leased by "me"/);

  await lease.release({ owner: 'me' });
  setActive(5);
  calls.length = 0;
  const recent = await lab.down(['--idle']);
  assert.equal(recent.idle, false);
  assert.match(recent.reason, /last command 5 min ago, under the 15 min threshold/);
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(lease.read(), null);
  assert.equal(loadState().session, 'S1');
});

test('down --idle with no record of the last command starts the clock and stops nothing', async () => {
  world();
  await lab.up([]);
  await lease.release({ owner: 'me' });
  fs.rmSync(activityPath());
  calls.length = 0;
  const out = await lab.down(['--idle']);
  assert.equal(out.idle, false);
  assert.match(out.reason, /idle clock starts now/);
  assert.ok(fs.existsSync(activityPath()));
  assert.equal(calls.length, 0);
});

test('the threshold is 15 minutes, or MSL_IDLE_MINUTES (1 to 1440)', async () => {
  world();
  await idleLab(20);
  process.env.MSL_IDLE_MINUTES = '30';
  try {
    assert.match((await lab.down(['--idle'])).reason, /under the 30 min threshold/);
    for (const bad of ['0', '1441', '1.5', 'abc', '-3']) {
      process.env.MSL_IDLE_MINUTES = bad;
      await assert.rejects(lab.down(['--idle']), /MSL_IDLE_MINUTES must be a whole number of minutes from 1 to 1440/, bad);
    }
    process.env.MSL_IDLE_MINUTES = '10';
    assert.equal((await lab.down(['--idle'])).idle, true);
  } finally { delete process.env.MSL_IDLE_MINUTES; }
});

test('down --idle on an idle lab stops what the lab started, as lab down does, and hands its lease back', async () => {
  const w = world();
  sim.state = 'Shutdown'; // the lab boots it, so the idle stop may shut it down
  saveState({ windowApp: 'Simulator' });
  await idleLab(20);
  assert.equal(loadState().simBoot, U);
  const [out, lines] = await logged(() => lab.down(['--idle']));
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.idle, true);
  assert.equal(out.idleMin, 15);
  assert.deepEqual(out.steps.map(s => s.step), ['session', 'wda', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium']); // no lease or release step: the idle stop holds its own
  assert.equal(out.owner, 'msl-idle');
  assert.equal(didOf(out).session, 'ended it');
  assert.equal(didOf(out).simulator, 'shut down');
  assert.equal(didOf(out).window, 'asked Simulator to quit');
  assert.match(didOf(out).appium, /^stopped it and disabled it at login/);
  assert.equal(requests('DELETE', '/session/S1').length, 1);
  assert.deepEqual(simctl('shutdown'), [['xcrun', 'simctl', 'shutdown', U]]);
  assert.deepEqual(launchctl().filter(c => !c.startsWith('print')), [`disable ${TARGET}`, `bootout ${TARGET}`]);
  assert.equal(w.kills.length, 0);
  assert.ok(!calls.flat().includes('booted'));
  assert.ok(!calls.some(c => ['kill', 'pkill', 'killall'].includes(c[0])));
  assert.equal(lease.read(), null, 'the idle stop\'s lease is handed back');
  assert.ok(Date.now() - lease.lastActive() > 19 * 60e3, 'the stop is not a command: the idle clock was not reset');
  assert.equal(loadState().simBoot, undefined);
  assert.equal(loadState().session, undefined);

  const rec = loadState().idleStop;
  assert.deepEqual([rec.ok, rec.idleMin, rec.failures], [true, 15, 0]);
  assert.deepEqual(rec.steps.map(s => s.step), ['session', 'wda', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[idle\] stopped the lab after 15 min idle \(.*simulator: shut down.*\)$/);

  const s = await lab.status();
  assert.equal(s.idleStop.last.ok, true);
  assert.equal(s.idleStop.thresholdMinutes, 15);
  assert.equal(s.idleStop.idleMinutes, 20);
  assert.equal(s.idleStop.installed, false);
  assert.match(s.idleStop.lastActive, /^\d{4}-\d\d-\d\dT/);

  // The next tick: nothing is running, so it does nothing, silently.
  calls.length = 0;
  const [again, quiet] = await logged(() => lab.down(['--idle']));
  assert.deepEqual(again, { idle: false, reason: 'nothing the lab started is running' });
  assert.deepEqual(quiet, []);
  assert.equal(stopCommands(), 0);
});

test('the idle stop holds its own lease while it works', async () => {
  const seen = [];
  world({ onShutdown: () => { seen.push(lease.read()); } });
  sim.state = 'Shutdown';
  await idleLab(20);
  await lab.down(['--idle']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].owner, 'msl-idle');
  assert.ok(Math.abs(Date.parse(seen[0].expires) - Date.parse(seen[0].since) - 600e3) < 5e3, 'ten minutes, whatever MSL_LEASE_TTL says');
});

test('the idle stop saves its record before it hands the lease back (an unlocked state write must not follow a lab up)', async () => {
  world();
  sim.state = 'Shutdown';
  await idleLab(20);
  const seen = [];
  const realRm = fs.rmSync;
  fs.rmSync = (p, ...rest) => { if (String(p).endsWith('lease.json')) seen.push(loadState().idleStop?.ok); return realRm(p, ...rest); };
  try { await lab.down(['--idle']); } finally { fs.rmSync = realRm; }
  assert.deepEqual(seen, [true], 'the record was in the state when the lease file was removed');
});

test('lab status shows the threshold of the installed idle stop (from its plist), not this shell\'s', async () => {
  world();
  process.env.MSL_IDLE_MINUTES = '40';
  try {
    let s = await lab.status();
    assert.deepEqual([s.idleStop.installed, s.idleStop.thresholdMinutes, s.idleStop.thresholdFrom], [false, 40, 'this shell (no idle stop installed)']);
    // An installed agent whose plist carries no setting runs at the default, whatever this shell says.
    fs.writeFileSync(svc.idlePlistPath(), svc.buildIdlePlist({ node: '/n', lab: '/r/bin/lab', developerDir: '/d', path: '/usr/bin', log: '/l' }));
    s = await lab.status();
    assert.deepEqual([s.idleStop.installed, s.idleStop.thresholdMinutes, s.idleStop.thresholdFrom], [true, 15, "the idle stop's plist"]);
    fs.writeFileSync(svc.idlePlistPath(), svc.buildIdlePlist({ node: '/n', lab: '/r/bin/lab', developerDir: '/d', path: '/usr/bin', log: '/l', env: { MSL_IDLE_MINUTES: '25' } }));
    assert.equal((await lab.status()).idleStop.thresholdMinutes, 25);
    fs.writeFileSync(svc.idlePlistPath(), svc.buildIdlePlist({ node: '/n', lab: '/r/bin/lab', developerDir: '/d', path: '/usr/bin', log: '/l', env: { MSL_IDLE_MINUTES: '0' } }));
    s = await lab.status();
    assert.equal(s.idleStop.thresholdMinutes, null);
    assert.ok(s.idleStop.issues.some(i => /invalid MSL_IDLE_MINUTES \("0"\).*lab service install/.test(i)));
  } finally { delete process.env.MSL_IDLE_MINUTES; }
});

test('mid-stop, a lab up is refused with an explanation, not let through', async () => {
  const refused = [];
  world({ onShutdown: () => { refused.push(lease.acquire({ owner: 'agent' }).catch(e => e.message)); } });
  sim.state = 'Shutdown';
  await idleLab(20);
  await lab.down(['--idle']);
  assert.match(await refused[0], /The idle stop is shutting the lab down/);
});

// --- lab hold ---

const holdPath = () => path.join(stateDir(), 'hold.json');

test('hold checks its arguments before anything else', async () => {
  world();
  await lab.up([]);
  for (const bad of [['--minutes', '0'], ['--minutes', '121'], ['--minutes', '1.5'], ['--minutes', 'abc'], ['--minutes', ''], ['--minutes', '-5'], ['--minutes', '1e1'], ['--minutes'], ['extra'], ['--force'], ['--minutes=5']]) {
    await assert.rejects(lab.hold(bad), /usage: lab hold \[--minutes N\]|--minutes needs a value|--flag=value|--minutes=…/, JSON.stringify(bad));
  }
  assert.ok(!fs.existsSync(holdPath()));
});

test('hold keeps the idle stop off for an hour by default, takes no lease, and counts as activity', async () => {
  world();
  await idleLab(60); // an hour idle: the idle stop would stop the lab
  const out = await lab.hold([]);
  assert.equal(out.held, true);
  assert.equal(out.minutes, 60);
  assert.match(out.until, /^\d{4}-\d\d-\d\dT/);
  assert.ok(out.running.includes('a session is recorded'));
  assert.equal(lease.read(), null, 'no lease was taken');
  assert.ok(Date.now() - lease.lastActive() < 5e3, 'the hold counts as activity');
  assert.ok(Math.abs(lease.holdUntil() - (Date.now() + 3600e3)) < 5e3);

  setActive(60); // an hour idle again: only the hold is in the way
  calls.length = 0;
  app.log.length = 0;
  const idle = await lab.down(['--idle']);
  assert.deepEqual(idle, { idle: false, reason: `held until ${out.until}` });
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(loadState().session, 'S1');

  assert.equal((await lab.hold(['--minutes', '5'])).minutes, 5);
  assert.ok(Math.abs(lease.holdUntil() - (Date.now() + 300e3)) < 5e3, 'a new hold replaces the old one');
});

test('hold is refused when nothing the lab started is running, and writes nothing', async () => {
  world({ loaded: false });
  await assert.rejects(lab.hold([]), /nothing the lab started is running/);
  assert.ok(!fs.existsSync(holdPath()));
  assert.equal(lease.lastActive(), null);
});

test('lab down ends a hold', async () => {
  world();
  await lab.up([]);
  await lab.hold([]);
  assert.ok(fs.existsSync(holdPath()));
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.ok(!fs.existsSync(holdPath()));
  assert.equal(lease.holdUntil(), null);
});

test('the idle stop\'s own stop ends a hold that has run out', async () => {
  world();
  await idleLab(20);
  fs.writeFileSync(holdPath(), JSON.stringify({ until: new Date(Date.now() - 60e3).toISOString() })); // ended a minute ago
  const out = await lab.down(['--idle']);
  assert.equal(out.idle, true);
  assert.ok(!fs.existsSync(holdPath()));
});

test('a failed down keeps the hold', async () => {
  world({ shutdownWorks: false });
  sim.state = 'Shutdown';
  await lab.up([]);
  await lab.hold([]);
  const out = await lab.down([]);
  assert.equal(out.ok, false);
  assert.ok(fs.existsSync(holdPath()));
});

test('a simulator that was already up keeps the hold', async () => {
  world();
  sim.state = 'Booted';
  await lab.up([]);
  await lab.hold([]);
  await lab.up([]);
  assert.ok(fs.existsSync(holdPath()), 'nothing was booted');
});

test('booting the simulator afresh ends a hold', async () => {
  world();
  sim.state = 'Shutdown';
  fs.writeFileSync(holdPath(), JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString() }));
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  assert.equal(loadState().simBoot, U);
  assert.ok(!fs.existsSync(holdPath()), 'a fresh boot clears the hold');
});

test('status reports the hold and when the idle stop will next stop the lab', async () => {
  const w = world();
  await idleLab(20);
  let s = await lab.status();
  assert.equal(s.idleStop.heldUntil, null);
  assert.equal(s.idleStop.nextStop.earliest, null);
  assert.match(s.idleStop.nextStop.note, /not installed and loaded/);

  fs.writeFileSync(svc.idlePlistPath(), svc.buildIdlePlist({ node: '/n', lab: '/r/bin/lab', developerDir: '/d', path: '/usr/bin', log: '/l' }));
  w.idleLoaded = true;
  s = await lab.status();
  const at = lease.lastActive();
  assert.equal(s.idleStop.nextStop.earliest, lease.localIso(at + 15 * 60e3));
  assert.match(s.idleStop.nextStop.note, /looks every \d+ s/);

  const held = await lab.hold(['--minutes', '90']);
  s = await lab.status();
  assert.equal(s.idleStop.heldUntil, held.until);
  assert.equal(s.idleStop.nextStop.earliest, held.until);
  assert.match(s.idleStop.nextStop.note, /lab hold/);

  await lease.acquire({ owner: 'me' });
  s = await lab.status();
  assert.equal(s.idleStop.nextStop.earliest, held.until, 'the later of the hold and the lease');
  assert.match(s.idleStop.nextStop.note, /lease is live/);
  await lease.release({ owner: 'me' });

  await lab.down([]);
  s = await lab.status();
  assert.equal(s.idleStop.heldUntil, null);
  assert.deepEqual(s.idleStop.nextStop, { earliest: null, note: 'nothing the lab started is running' });
});

test('status counts a failed down\'s kept device run as running, so the next stop is due (#86)', async () => {
  const w = world();
  await idleLab(20);
  await lab.down([]);
  fs.writeFileSync(svc.idlePlistPath(), svc.buildIdlePlist({ node: '/n', lab: '/r/bin/lab', developerDir: '/d', path: '/usr/bin', log: '/l' }));
  w.idleLoaded = true;
  setActive(20);
  assert.deepEqual((await lab.status()).idleStop.nextStop, { earliest: null, note: 'nothing the lab started is running' });
  saveState({ lastTarget: 'device' });
  const s = await lab.status();
  assert.equal(s.idleStop.nextStop.earliest, lease.localIso(lease.lastActive() + 15 * 60e3));
});

test('status gives no next stop after repeated failed idle stops', async () => {
  const w = world();
  await idleLab(20);
  fs.writeFileSync(svc.idlePlistPath(), svc.buildIdlePlist({ node: '/n', lab: '/r/bin/lab', developerDir: '/d', path: '/usr/bin', log: '/l' }));
  w.idleLoaded = true;
  saveState({ idleStop: { at: new Date().toISOString(), idleMin: 15, ok: false, steps: [], failures: 3 } });
  const s = await lab.status();
  assert.equal(s.idleStop.nextStop.earliest, null);
  assert.match(s.idleStop.nextStop.note, /last 3 idle stops failed/);
});

test('a simulator someone else booted is left alone; the rest of the lab is still stopped', async () => {
  world();
  sim.state = 'Booted'; // already up when `lab up` looks: the lab did not boot it
  await idleLab(20);
  assert.equal(loadState().simBoot, undefined);
  const out = await lab.down(['--idle']);
  assert.equal(out.ok, undefined, out.error);
  assert.match(stepOf(out, 'simulator').found, /^booted, not booted by the lab: left alone$/);
  assert.equal(stepOf(out, 'simulator').did, null);
  assert.equal(simctl('shutdown').length, 0);
  assert.equal(sim.state, 'Booted');
  assert.equal(didOf(out).session, 'ended it');
  assert.match(didOf(out).appium, /^stopped it/);
  // Plain `lab down` keeps shutting it down, whoever booted it.
  world();
  sim.state = 'Booted';
  await lab.up([]);
  assert.equal((await lab.down([])).steps.find(s => s.step === 'simulator').did, 'shut down');
});

test('a lab-booted simulator that was shut down by someone since is not "running": simBoot is cleared and nothing happens', async () => {
  world({ loaded: false });
  saveState({ simBoot: U });
  sim.state = 'Shutdown';
  setActive(60);
  calls.length = 0;
  const out = await lab.down(['--idle']);
  assert.deepEqual(out, { idle: false, reason: 'nothing the lab started is running' });
  assert.equal(loadState().simBoot, undefined);
  assert.equal(simctl('shutdown').length, 0);
  assert.ok(!launchctl().some(c => c.startsWith('bootout')));
});

test('with nothing running, an idle lab is left alone: no stop command of any kind', async () => {
  world({ loaded: false });
  setActive(60);
  calls.length = 0;
  const [out, lines] = await logged(() => lab.down(['--idle']));
  assert.deepEqual(out, { idle: false, reason: 'nothing the lab started is running' });
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.filter(c => c[0] === 'launchctl').map(c => c[1]), ['print']);
  assert.equal(calls.filter(c => c[0] !== 'launchctl').length, 0);
  assert.equal(loadState().idleStop, undefined);
});

test('a `lab up` that wins the race between the first look and the take is not stopped', async () => {
  // The first look found it idle; `launchctl print` (the next check) is where the other agent's `lab up` lands.
  let armed = false;
  world({ onCommand: (cmd, args) => { if (armed && cmd === 'launchctl' && args[0] === 'print') asLeaseHolder('agent-b'); } });
  await idleLab(20);
  armed = true;
  const out = await lab.down(['--idle']);
  assert.equal(out.idle, false);
  assert.match(out.reason, /in use: leased by "agent-b"/);
  assert.equal(lease.read().owner, 'agent-b');
  assert.equal(simctl('shutdown').length, 0);
  assert.ok(!launchctl().some(c => c.startsWith('bootout')));
  assert.equal(requests('DELETE', '/session/S1').length, 0);
  assert.equal(loadState().session, 'S1');
});

test('a takeover in the middle of the stop (lab up --force) ends it early, and its lease is not removed', async () => {
  world({ onShutdown: () => asLeaseHolder('agent-b') });
  sim.state = 'Shutdown';
  await idleLab(20);
  const [out, lines] = await logged(() => lab.down(['--idle']));
  assert.equal(out.ok, false);
  assert.match(out.error, /someone took the lab over while the idle stop ran/);
  assert.deepEqual(out.steps.map(s => s.step), ['session', 'wda', 'tunnel', 'simulator']); // window, safaridriver and appium did not run
  assert.ok(!launchctl().some(c => c.startsWith('bootout')));
  assert.equal(lease.read().owner, 'agent-b', 'the other agent keeps its lease');
  assert.equal(loadState().idleStop.failures, 1);
  assert.match(lines[0], /^\[idle\] failed after 15 min idle: .*took the lab over/);
});

test('a step that fails still hands the lease back, is retried on the next ticks, and after 3 failures waits for new activity', async () => {
  const w = world({ bootoutFails: true });
  await idleLab(20);
  for (const n of [1, 2, 3]) {
    const [out, lines] = await logged(() => lab.down(['--idle']));
    assert.equal(out.ok, false, `try ${n}`);
    assert.equal(out.failedStep, 'appium');
    assert.match(out.error, /launchd still has the Appium service/);
    assert.ok(!/lease is kept/.test(out.error), 'the idle stop has no lease to keep');
    assert.equal(lease.read(), null, 'its lease is handed back even though a step failed');
    assert.equal(loadState().idleStop.failures, n);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[idle\] failed after 15 min idle: appium: /);
  }
  assert.equal(loadState().idleStop.ok, false);
  const s = await lab.status();
  assert.equal(s.idleStop.last.ok, false);
  assert.equal(s.idleStop.last.failures, 3);

  calls.length = 0;
  const [capped, quiet] = await logged(() => lab.down(['--idle']));
  assert.equal(capped.idle, false);
  assert.match(capped.reason, /the last 3 idle stops failed: waiting for the next lab command/);
  assert.deepEqual(quiet, []);
  assert.equal(calls.length, 0);

  // A lab command since the last try, and the lab idle again: it tries again.
  saveState({ idleStop: { ...loadState().idleStop, at: new Date(Date.now() - 30 * 60e3).toISOString() } });
  w.loaded = true;
  const retry = await lab.down(['--idle']);
  assert.equal(retry.idle, true);
  assert.equal(loadState().idleStop.failures, 1);
});

test('an unreachable phone: the stop carries on, records the tab as left open, and the WebDriverAgent and Appium are still stopped', async () => {
  const w = deviceDown({ procs: home => [{ pid: 7601, ppid: 1, command: wdaLine(home) }] });
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  const { tag } = loadState().deviceTab;
  saveState({ deviceTab: { tainted: true, tag } }); // the tab can no longer be confirmed as the lab's
  await lease.release({ owner: 'me' });
  setActive(20);
  const [out, lines] = await logged(() => lab.down(['--idle']));
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.idle, true);
  assert.equal(stepOf(out, 'session').tabLeft, 'lab');
  assert.equal(stepOf(out, 'session').did, 'ended it');
  assert.equal(stepOf(out, 'wda').did, 'stopped xcodebuild (pid 7601)');
  assert.deepEqual(w.kills, [[7601, 'SIGTERM']]);
  assert.match(stepOf(out, 'appium').did, /^stopped it/);
  const rec = loadState().idleStop;
  assert.equal(rec.ok, true);
  assert.equal(rec.tabLeft, 'lab');
  assert.match(rec.human[0], /Close the lab's tab on the phone by hand/);
  assert.match(lines[0], /the lab's tab is still open on the phone \(lab\)/);
  assert.equal(lease.read(), null);
  neverUnsafe(app);
});

test('the idle stop does not clear keyboardPending (nobody is there to read it); lab down does', async () => {
  world();
  saveState({ keyboardPending: true });
  setActive(60);
  const out = await lab.down(['--idle']);
  assert.equal(out.keyboardRestored, false);
  assert.match(out.human[0], /keyboard/i);
  assert.equal(loadState().keyboardPending, true);
  assert.equal(loadState().idleStop.keyboardRestored, false);

  world();
  saveState({ keyboardPending: true });
  await lab.down([]);
  assert.equal(loadState().keyboardPending, undefined);
});

test('down --idle interrupted mid-stop ends early, and still hands its lease back', async () => {
  world({ onShutdown: () => process.emit('SIGTERM', 'SIGTERM') });
  sim.state = 'Shutdown';
  await idleLab(20);
  const out = await withInterrupt(() => lab.down(['--idle']));
  assert.equal(out.ok, false);
  assert.match(out.error, /interrupted by SIGTERM/);
  assert.deepEqual(out.steps.map(s => s.step).slice(-1), ['simulator']);
  assert.equal(lease.read(), null);
  assert.equal(loadState().idleStop.failures, 0, 'an interrupt is not a failed stop');
});

test('down --idle takes no other flags, and nothing else changes in how down parses', async () => {
  world();
  await assert.rejects(lab.down(['--idle', '--force']), /usage: lab down .*--idle takes neither --force nor --keep-service/);
  await assert.rejects(lab.down(['--idle', '--keep-service']), /--idle takes neither/);
  await assert.rejects(lab.down(['--idle', 'now']), /usage: lab down/);
  await assert.rejects(lab.down(['--idle', '--minutes', '5']), /usage: lab down/);
  assert.equal(calls.length, 0);
});

// --- lab service: the idle stop agent ---

// An Appium install the service can be installed from (the files appiumMain wants).
function fakeAppiumInstall() {
  const pkg = path.join(process.env.MSL_APPIUM_HOME, 'node_modules', 'appium');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { appium: 'index.js' } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), '');
}

test('service install installs the idle stop agent too, after Appium is up, and --no-idle-stop skips it and removes one', async () => {
  fakeAppiumInstall();
  fs.rmSync(svc.plistPath());
  app.fx.up = false;
  const w = world({ loaded: false });
  const out = await lab.service(['install']);
  assert.equal(out.installed, true);
  assert.equal(out.idleStop.installed, true);
  assert.equal(out.idleStop.plist, svc.idlePlistPath());
  assert.equal(out.idleStop.intervalSeconds, 300);
  assert.ok(fs.existsSync(svc.idlePlistPath()));
  // The tunnel host's agent always goes with it, loaded idle: nothing is started.
  assert.equal(out.tunnelHost.installed, true);
  assert.ok(fs.existsSync(svc.tunnelPlistPath()));
  assert.ok(!launchctl().some(l => l.startsWith('kickstart') && l.includes('msl-tunnel')));
  const xml = fs.readFileSync(svc.idlePlistPath(), 'utf8');
  assert.match(xml, /<string>down<\/string>\s*<string>--idle<\/string>/);
  assert.ok(!/KeepAlive/.test(xml));
  const cmds = launchctl();
  assert.ok(cmds.indexOf(`bootstrap gui/${process.getuid()} ${svc.plistPath()}`) < cmds.indexOf(`bootstrap gui/${process.getuid()} ${svc.idlePlistPath()}`), 'Appium first');
  assert.equal(w.idleLoaded, true);
  assert.equal((await lab.status()).idleStop.installed, true);
  assert.equal(lease.read(), null);

  // Opting out removes a loaded idle stop.
  const opt = await lab.service(['install', '--no-idle-stop']);
  assert.equal(opt.installed, true);
  assert.deepEqual([opt.idleStop.installed, opt.idleStop.optedOut, opt.idleStop.removed], [false, true, true]);
  assert.ok(!fs.existsSync(svc.idlePlistPath()));
  assert.ok(launchctl().includes(`bootout ${IDLE_TARGET}`));
  assert.equal(w.idleLoaded, false);
  // ... and, on a Mac that never had one, installs none.
  const fresh = await lab.service(['install', '--no-idle-stop']);
  assert.deepEqual([fresh.idleStop.installed, fresh.idleStop.removed], [false, false]);
  assert.ok(!fs.existsSync(svc.idlePlistPath()));
});

test('a failure installing the idle stop is reported and does not fail the service install', async () => {
  fakeAppiumInstall();
  fs.rmSync(svc.plistPath());
  app.fx.up = false;
  world({ loaded: false });
  // The idle plist cannot be written: its name is taken by a folder.
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.mkdirSync(svc.idlePlistPath());
  try {
    const out = await lab.service(['install']);
    assert.equal(out.installed, true);
    assert.equal(out.idleStop.installed, false);
    assert.equal(typeof out.idleStop.error, 'string');
    assert.ok(out.idleStop.error.length > 0);
  } finally { fs.rmSync(svc.idlePlistPath(), { recursive: true, force: true }); }
});

test('an idle stop install that fails with an empty error is still reported with text', async () => {
  fakeAppiumInstall();
  fs.rmSync(svc.plistPath());
  app.fx.up = false;
  world({ loaded: false, onCommand: (cmd, args) => { if (cmd === 'launchctl' && args[0] === 'bootstrap' && args.at(-1).includes('msl-idle')) throw new Error(''); } });
  const out = await lab.service(['install']);
  assert.equal(out.installed, true);
  assert.equal(out.idleStop.installed, false);
  assert.ok(out.idleStop.error.trim().length > 0);
});

test('a tunnel host install that fails with an empty error is still reported with text', async () => {
  fakeAppiumInstall();
  fs.rmSync(svc.plistPath());
  app.fx.up = false;
  world({ loaded: false, onCommand: (cmd, args) => { if (cmd === 'launchctl' && args[0] === 'bootstrap' && args.at(-1).includes('msl-tunnel')) throw new Error(''); } });
  const out = await lab.service(['install']);
  assert.equal(out.installed, true);
  assert.equal(out.tunnelHost.installed, false);
  assert.ok(out.tunnelHost.error.trim().length > 0);
});

test('service uninstall removes both agents; --no-idle-stop belongs to install; status shows the idle stop', async () => {
  const w = world();
  w.idleLoaded = true;
  fs.writeFileSync(svc.idlePlistPath(), 'x');
  const st = await lab.service(['status']);
  assert.equal(st.idleStop.installed, true);
  assert.equal(st.idleStop.loaded, true);
  await assert.rejects(lab.service(['uninstall', '--no-idle-stop']), /--no-idle-stop goes with lab service install/);
  assert.ok(fs.existsSync(svc.idlePlistPath()));

  const out = await lab.service(['uninstall']);
  assert.equal(out.uninstalled, true);
  assert.deepEqual([out.idleStop.removed, out.idleStop.wasLoaded], [true, true]);
  assert.equal(out.tunnelHost.installed, false);
  assert.ok(launchctl().includes(`bootout gui/${process.getuid()}/com.dividedby.msl-tunnel`));
  assert.ok(!fs.existsSync(svc.plistPath()));
  assert.ok(!fs.existsSync(svc.idlePlistPath()));
  assert.ok(launchctl().includes(`bootout ${IDLE_TARGET}`));
  assert.ok(launchctl().includes(`bootout ${TARGET}`));
});

// --- simulator profiles: clean (state `udid`) and configured (`profiles.configured`) ---

const C = '7B2C3D4E-5F6A-4B7C-9D8E-0F1A2B3C4D5E';

// Both of the lab's simulators exist; `devs` is each one's state and simctl boots and shuts them down.
function profileWorld(devs = { [U]: 'Shutdown', [C]: 'Shutdown' }) {
  saveState({ udid: U, profiles: { configured: { udid: C, name: 'Claude iPhone (configured)' } } });
  let loaded = true;
  calls = fakeRunner((cmd, args) => {
    if (cmd === 'xcode-select') return { stdout: path.join(dir, 'Xcode', 'Contents', 'Developer') + '\n' };
    if (cmd === 'xcrun' && args[1] === 'list') {
      const list = Object.entries(devs).map(([udid, state]) => ({ udid, name: udid === U ? 'Claude iPhone' : 'Claude iPhone (configured)', state, isAvailable: true }));
      return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': list } }) };
    }
    if (cmd === 'xcrun' && args[1] === 'boot') { devs[args[2]] = 'Booted'; return undefined; }
    if (cmd === 'xcrun' && args[1] === 'shutdown') { devs[args[2]] = 'Shutdown'; return undefined; }
    if (cmd === 'launchctl' && !args.at(-1).includes('msl-idle')) {
      if (args[0] === 'print') return loaded ? { stdout: 'state = running\n\tpid = 4242\n' } : { code: 113, stderr: 'Could not find service' };
      if (args[0] === 'bootout') { loaded = false; app.fx.up = false; }
      if (args[0] === 'bootstrap') { loaded = true; app.fx.up = true; }
    } else if (cmd === 'launchctl') return args[0] === 'print' ? { code: 113, stderr: 'Could not find service' } : undefined;
    return undefined;
  });
  return devs;
}
const sessionCaps = () => requests('POST', '/session').map(([, , b]) => b.capabilities.alwaysMatch);
const shutdownIds = () => simctl('shutdown').map(c => c[3]);
const bootIds = () => simctl('boot').map(c => c[3]);

test('up --profile is checked before anything runs: an unknown profile, a phone, a missing configured simulator', async () => {
  profileWorld();
  await assert.rejects(lab.up(['--profile', 'work']), /--profile must be one of clean, configured \(got "work"\)/);
  await assert.rejects(lab.up(['--profile']), /--profile needs a value/);
  await assert.rejects(lab.up(['--profile', 'configured', '--target', 'device']), /can't go with --target device/);
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(lease.read(), null);

  saveState({ profiles: null });
  const out = await lab.up(['--profile', 'configured']);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'prerequisites');
  assert.match(out.error, /No configured simulator yet: run `sim create --profile configured`/);
  assert.equal(simctl('boot').length, 0);
});

test('up without --profile is clean, even when a profile was left in the state; the profile is set per up', async () => {
  profileWorld();
  saveState({ profile: 'configured' }); // left behind: not sticky
  const out = await lab.up([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(out.target, { simulator: U });
  assert.equal(out.profile, 'clean');
  assert.equal(stepOf(out, 'simulator').profile, 'clean');
  assert.equal(loadState().profile, 'clean');
  assert.deepEqual(bootIds(), [U]);
  assert.equal(loadState().simBoot, U);
  assert.equal('appium:noReset' in sessionCaps()[0], false, 'the clean profile keeps the driver\'s per-session Safari reset');
});

test('up --profile configured shuts the clean simulator down first, boots the configured one by UDID, and keeps its Safari data (noReset)', async () => {
  const devs = profileWorld({ [U]: 'Booted', [C]: 'Shutdown' });
  saveState({ simBoot: U });
  const out = await lab.up(['--profile', 'configured']);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(out.target, { simulator: C });
  assert.equal(out.profile, 'configured');
  assert.equal(stepOf(out, 'simulator').did, 'shut down the clean simulator; booted (was Shutdown)');
  assert.deepEqual(devs, { [U]: 'Shutdown', [C]: 'Booted' }, 'one booted at a time');
  const order = calls.filter(c => c[0] === 'xcrun' && ['shutdown', 'boot'].includes(c[2])).map(c => c.slice(2).join(' '));
  assert.deepEqual(order, [`shutdown ${U}`, `boot ${C}`]);
  assert.equal(loadState().simBoot, C);
  assert.equal(loadState().profile, 'configured');
  assert.equal(sessionCaps()[0]['appium:udid'], C);
  assert.equal(sessionCaps()[0]['appium:noReset'], true);
  assert.ok(!calls.flat().includes('booted'));

  // And back to clean with the next up (no flag, no live session).
  await lab.down([]);
  assert.equal(loadState().profile, undefined);
  const again = await lab.up([]);
  assert.deepEqual(again.target, { simulator: U });
  assert.deepEqual(bootIds().slice(-1), [U]);
});

test('up --profile configured while the clean session is live is a conflict: nothing is shut down or booted', async () => {
  const devs = profileWorld({ [U]: 'Booted', [C]: 'Shutdown' });
  const first = await lab.up([]);
  assert.equal(first.session, 'S1');
  calls.length = 0;
  const out = await lab.up(['--profile', 'configured']);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'simulator');
  assert.match(out.error, /a session is already open on .*safari stop/);
  assert.equal(shutdownIds().length + bootIds().length, 0);
  assert.deepEqual(devs, { [U]: 'Booted', [C]: 'Shutdown' });
  assert.equal(loadState().session, 'S1');
  assert.equal(loadState().profile, 'clean');

  // A dead session record is not a conflict: it is replaced.
  app.fx.sessions.clear();
  const replaced = await lab.up(['--profile', 'configured']);
  assert.equal(replaced.ok, undefined, replaced.error);
  assert.deepEqual(replaced.target, { simulator: C });
  assert.deepEqual(shutdownIds(), [U]);
});

test('up without --profile keeps a live configured session; a dead one is replaced by clean', async () => {
  profileWorld();
  await lab.up(['--profile', 'configured']);
  const kept = await lab.up([]);
  assert.equal(kept.reused, true);
  assert.deepEqual(kept.target, { simulator: C });
  assert.equal(kept.profile, 'configured');
  assert.equal(shutdownIds().length, 0);

  app.fx.sessions.clear();
  const out = await lab.up([]);
  assert.deepEqual(out.target, { simulator: U });
  assert.deepEqual(shutdownIds(), [C]);
});

test('down stops both simulators and clears the profile; with only the clean one the steps read as before', async () => {
  const devs = profileWorld({ [U]: 'Booted', [C]: 'Booted' }); // e.g. a person booted one by hand
  await lab.up(['--profile', 'configured']);
  devs[U] = 'Booted';
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(devs, { [U]: 'Shutdown', [C]: 'Shutdown' });
  assert.deepEqual(shutdownIds().slice(-2).sort(), [U, C].sort());
  assert.equal(stepOf(out, 'simulator').did, `clean: shut down; configured: shut down`);
  assert.equal(loadState().profile, undefined);
  assert.equal(loadState().simBoot, undefined);
  assert.ok(!calls.flat().includes('booted'));

  saveState({ profiles: null }); // no configured simulator: the plain strings
  devs[U] = 'Booted';
  assert.equal(stepOf(await lab.down([]), 'simulator').did, 'shut down');
});

test('down looks for the WebDriverAgent builds of both simulators', async () => {
  const home = process.env.MSL_APPIUM_HOME;
  const wda = udid => `/usr/bin/xcodebuild build-for-testing -project ${home}/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj -destination id=${udid} -derivedDataPath ${home}/wda`;
  world({ procs: [{ pid: 701, ppid: 4242, command: wda(U) }, { pid: 702, ppid: 4242, command: wda(C) }, { pid: 703, ppid: 4242, command: wda('0000AAAA-0000-4000-8000-00000000AAAA') }] });
  saveState({ udid: U, profiles: { configured: { udid: C, name: 'Claude iPhone (configured)' } } });
  const out = await lab.down([]);
  const stopped = stepOf(out, 'wda');
  assert.ok(stopped.did?.includes('701') && stopped.did.includes('702'), JSON.stringify(stopped));
  assert.ok(!stopped.did.includes('703'), 'another simulator\'s build is left alone');
});

test('the idle stop shuts down the configured simulator when the lab booted it, and leaves one the lab did not boot', async () => {
  const devs = profileWorld({ [U]: 'Shutdown', [C]: 'Shutdown' });
  await lab.up(['--profile', 'configured']);
  assert.equal(loadState().simBoot, C);
  await lease.release({ owner: 'me' });
  setActive(20);
  calls.length = 0;
  const out = await lab.down(['--idle']);
  assert.equal(out.idle, true);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(shutdownIds(), [C], 'only the device the lab booted, by its UDID');
  assert.equal(devs[C], 'Shutdown');
  assert.equal(loadState().simBoot, undefined);
  assert.equal(loadState().profile, undefined);
  assert.match(stepOf(out, 'simulator').found, /^clean: shutdown; configured: booted$/);

  // Booted by someone else (no simBoot): left alone, with the rest stopped.
  devs[C] = 'Booted';
  await lab.up(['--profile', 'configured']);
  assert.equal(loadState().simBoot, undefined);
  await lease.release({ owner: 'me' });
  setActive(20);
  calls.length = 0;
  const left = await lab.down(['--idle']);
  assert.equal(shutdownIds().length, 0);
  assert.match(stepOf(left, 'simulator').found, /configured: booted, not booted by the lab: left alone/);
  assert.equal(devs[C], 'Booted');
});

test('status shows both simulators and the profile in use', async () => {
  profileWorld({ [U]: 'Shutdown', [C]: 'Booted' });
  let s = await lab.status();
  assert.deepEqual([s.simulator.udid, s.simulator.state], [U, 'Shutdown']);
  assert.deepEqual([s.configuredSimulator.udid, s.configuredSimulator.state, s.configuredSimulator.name], [C, 'Booted', 'Claude iPhone (configured)']);
  assert.equal(s.profile, null);
  saveState({ profile: 'configured' });
  assert.equal((await lab.status()).profile, 'configured');
  saveState({ profiles: { configured: { udid: 'nope' } } });
  s = await lab.status();
  assert.equal(s.configuredSimulator.damaged, true);
  saveState({ profiles: null });
  assert.equal((await lab.status()).configuredSimulator, null);
});

test('safari start takes no --profile and no unknown flag: refused before anything runs', async () => {
  profileWorld({ [U]: 'Booted', [C]: 'Shutdown' });
  await assert.rejects(safari.start(['--profile', 'configured']), /takes no --profile.*lab up --profile/);
  await assert.rejects(safari.start(['--profile', 'bogus']), /takes no --profile/);
  await assert.rejects(safari.start(['--wat', 'x']), /usage: safari start .*--wat is not a start flag/);
  assert.equal(calls.length, 0);
  assert.equal(app.log.length, 0);
  assert.equal(loadState().session, undefined);
  assert.equal(lease.read(), null);
});

test('up --profile never drops the profile when auto picks the phone: it is refused, nothing booted', async () => {
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  saveState({ profiles: { configured: { udid: C, name: 'Claude iPhone (configured)' } } });
  const out = await lab.up(['--profile', 'configured']);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'phone');
  assert.match(out.error, /--profile configured picks a simulator, but --target auto chose the phone/);
  assert.equal(simctl('boot').length, 0);
  assert.equal(createdSessions(), 0);
});

test('a lab simulator the idle stop left running keeps the profile; a session on the other one is refused, whatever creates it', async () => {
  const devs = profileWorld({ [U]: 'Shutdown', [C]: 'Booted' }); // booted by hand: no simBoot
  await lab.up(['--profile', 'configured']);
  assert.equal(loadState().simBoot, undefined);
  await lease.release({ owner: 'me' });
  setActive(20);
  calls.length = 0;
  const out = await lab.down(['--idle']);
  assert.match(stepOf(out, 'simulator').found, /configured: booted, not booted by the lab: left alone/);
  assert.equal(devs[C], 'Booted');
  assert.equal(loadState().profile, 'configured', 'the profile follows what is still booted');
  assert.equal(simUdid(), C);

  // The profile gone (or clean chosen) while configured is up: no session boots a second simulator.
  saveState({ profile: null });
  calls.length = 0;
  app.log.length = 0;
  for (const args of [[], ['--target', 'simulator']]) {
    await assert.rejects(safari.start(args), /the configured simulator is booted.*lab up --profile clean.*lab down/, String(args));
  }
  assert.equal(simctl('boot').length, 0);
  assert.equal(requests('POST', '/session').length, 0);
  assert.equal(loadState().session, undefined);
  assert.deepEqual(devs, { [U]: 'Shutdown', [C]: 'Booted' });

  // The same through `lab up --profile clean`: it shuts the configured one down first, so it passes.
  const up = await lab.up(['--profile', 'clean']);
  assert.equal(up.ok, undefined, up.error);
  assert.deepEqual(up.target, { simulator: U });
  assert.deepEqual(devs, { [U]: 'Booted', [C]: 'Shutdown' });
});

test('up --profile with auto on the phone is refused before the phone step can delete the WebDriverAgent build', async () => {
  const w = deviceWorld(CABLE, { expires: inHours(1) }); // under 24 h: a re-sign would delete the build
  savePhone();
  const out = await lab.up(['--profile', 'clean']);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'phone');
  assert.ok(fs.existsSync(w.products), 'the build is still there');
  assert.equal(createdSessions(), 0);
});

// --- appearance and orientation on the phone (#27) ---

const LOCKED = { code: 1, stderr: 'The device is locked. (passcodeRequired true)' };
const phoneRestoreOnDisk = () => loadState().phoneRestore;

// deviceDown with the phone's display answering devicectl; the read-backs wait on nothing.
function displayWorld(init) {
  phone.WAIT.readBackMs = 0;
  const ph = displayPhone(init);
  const w = deviceDown({ procs: home => [{ pid: 7801, ppid: 1, command: wdaLine(home) }], extra: (cmd, args) => ph.handle(cmd, args) });
  return Object.assign(w, { ph });
}
const postSessionAt = () => app.log.findIndex(([m, u]) => m === 'POST' && u === '/session');

test('safari appearance and orientation: a bad word is a usage error before any session or phone call; no session is refused', async () => {
  const { ph } = displayWorld();
  for (const argv of [[], ['purple'], ['dark', 'light'], ['auto'], ['portrait']]) await assert.rejects(safari.appearance(argv), /usage: safari appearance light\|dark\|restore\|status/, argv.join(' '));
  for (const argv of [[], ['sideways'], ['landscape', 'portrait'], ['dark'], ['faceUp']]) await assert.rejects(safari.orientation(argv), /usage: safari orientation portrait\|landscape\|restore\|status/, argv.join(' '));
  await assert.rejects(safari.appearance(['dark']), /No Safari session/);
  assert.deepEqual(ph.calls, []);
});

test('a simulator session is refused with a clear message, runs no devicectl, and leaves `sim appearance` alone', async () => {
  await lab.up(['--target', 'simulator']);
  calls.length = 0;
  await assert.rejects(safari.appearance(['dark']), /works on the iPhone only.*simulator.*sim appearance/s);
  await assert.rejects(safari.orientation(['landscape']), /works on the iPhone only/);
  await assert.rejects(safari.appearance(['status']), /works on the iPhone only/);
  assert.deepEqual(calls.filter(c => c[0] === 'xcrun' && c[1] === 'devicectl'), []);
  assert.equal(loadState().phoneRestore, undefined);
});

test('lab up --appearance/--orientation: bad values and the simulator are refused before anything is booted or changed', async () => {
  await assert.rejects(lab.up(['--appearance', 'auto']), /usage: lab up/);
  await assert.rejects(lab.up(['--orientation', 'upside']), /usage: lab up/);
  await assert.rejects(lab.up(['--target', 'simulator', '--appearance', 'dark']), /can't go with --target simulator/);
  sim.state = 'Shutdown';
  const out = await lab.up(['--appearance', 'dark']); // auto, no phone saved: the simulator would be chosen
  assert.equal(out.ok, false);
  assert.match(out.error, /change the iPhone, but this run is on the simulator/);
  assert.equal(simctl('boot').length, 0, 'the simulator was not booted');
  assert.equal(out.steps.some(s => s.step === 'simulator'), false);
  assert.equal(createdSessions(), 0);
});

test('safari appearance and orientation on the phone: record, change, read back; status; stop puts both back', async () => {
  const { ph } = displayWorld();
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  const at = [];
  ph.onSet = () => at.push(app.log.length); // where in the session's traffic each change was made

  const dark = await safari.appearance(['dark']);
  assert.deepEqual(dark, { target: 'device', appearance: 'dark', prior: 'light', changed: true, restoredAtStop: true, note: dark.note });
  assert.match(dark.note, /cannot read whether Appearance is on Automatic/);
  const land = await safari.orientation(['landscape']);
  assert.deepEqual(land, { target: 'device', orientation: 'landscapeLeft', requested: 'landscape', prior: { deviceOrientation: 'portrait', nonFlat: 'portrait' }, changed: true, restoredAtStop: true });
  assert.deepEqual(Object.keys(phoneRestoreOnDisk()).sort(), ['appearance', 'orientation', 'udid']);

  assert.deepEqual(await safari.appearance(['status']), { target: 'device', appearance: 'dark', automatic: 'unknown', pending: true, prior: 'light', set: 'dark' });
  const o = await safari.orientation(['status']);
  assert.deepEqual([o.orientation, o.pending, o.prior.deviceOrientation, o.set], ['landscapeLeft', true, 'portrait', 'landscapeLeft']);

  at.length = 0;
  const stopped = await safari.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.phoneRestored, true);
  assert.equal(stopped.restoredExactly, false);
  assert.equal(stopped.phoneRestore.appearance.restored, true);
  assert.equal(stopped.phoneRestore.orientation.restoredExactly, true);
  assert.equal(stopped.human, undefined);
  assert.equal(ph.style, 'light');
  assert.equal(ph.orientation, 'portrait');
  assert.equal(phoneRestoreOnDisk(), undefined);
  assert.ok(at.length >= 2 && at.every(i => i <= deleteAt()), 'put back before the session is deleted');
  for (const a of ph.calls) assert.equal(a[a.indexOf('--device') + 1], PHONE);
  neverUnsafe(app);
});

test('safari appearance restore and orientation restore put back their own kind; with nothing changed they say so', async () => {
  const { ph } = displayWorld();
  await lab.up([]);
  const none = await safari.appearance(['restore']);
  assert.deepEqual([none.phoneRestored, none.pending], [true, false]);
  await safari.appearance(['dark']);
  await safari.orientation(['landscape']);
  const r = await safari.orientation(['restore']);
  assert.equal(r.phoneRestored, true);
  assert.deepEqual(Object.keys(r.phoneRestore), ['orientation']);
  assert.equal(ph.orientation, 'portrait');
  assert.equal(ph.style, 'dark', 'appearance still pending');
  const a = await safari.appearance(['restore']);
  assert.deepEqual([a.phoneRestored, a.restoredExactly], [true, false]);
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('rotation lock on: safari orientation fails with the lock advice, nothing is left pending', async () => {
  const { ph } = displayWorld({ rotationLock: true });
  await lab.up([]);
  await assert.rejects(safari.orientation(['landscape']), e => {
    assert.match(e.message, /Portrait Orientation Lock is probably on/);
    assert.match(e.extra.human[0], /Turn off Portrait Orientation Lock/);
    return true;
  });
  assert.equal(phoneRestoreOnDisk(), undefined);
  assert.equal(ph.orientation, 'portrait');
});

test('down puts both back in the session step (no extra step), says so at the top, and a second down says nothing about it', async () => {
  const { ph } = displayWorld();
  await lab.up([]);
  await safari.appearance(['dark']);
  await safari.orientation(['landscape']);
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(stepNames(out), ['lease', 'session', 'wda', 'tunnel', 'simulator', 'window', 'safaridriver', 'appium', 'release']);
  assert.equal(out.phoneRestored, true);
  assert.equal(out.restoredExactly, false);
  assert.equal(stepOf(out, 'session').phoneRestored, true);
  assert.equal(out.keyboardRestored, true);
  assert.equal(out.human, undefined);
  assert.deepEqual([ph.style, ph.orientation], ['light', 'portrait']);
  assert.equal(phoneRestoreOnDisk(), undefined);
  const again = await lab.down([]);
  assert.equal('phoneRestored' in again, false);
  assert.equal(stepNames(again).includes('phone-settings'), false);
});

test('safari stop on a locked phone keeps the entry and says what to do; lab down later finishes it in a phone-settings step', async () => {
  const { ph } = displayWorld();
  await lab.up([]);
  await safari.appearance(['dark']);
  ph.error = LOCKED;
  const stopped = await safari.stop();
  assert.equal(stopped.stopped, true, 'a locked phone is not a failure of stop');
  assert.equal(stopped.phoneRestored, false);
  assert.match(stopped.human.join(' '), /unlock it and run `lab phone restore`/);
  assert.ok(phoneRestoreOnDisk().appearance, 'the entry is kept');
  assert.equal(ph.style, 'dark');

  ph.error = null;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(stepNames(out).slice(0, 3), ['lease', 'session', 'phone-settings']);
  assert.equal(stepOf(out, 'phone-settings').found, 'appearance waiting to be put back');
  assert.equal(stepOf(out, 'phone-settings').did, 'put back appearance');
  assert.equal(out.phoneRestored, true);
  assert.equal(ph.style, 'light');
  assert.equal(phoneRestoreOnDisk(), undefined);
  const again = await lab.down([]);
  assert.equal(stepNames(again).includes('phone-settings'), false, 'idempotent');
});

test('down with a locked phone is not a failure: phoneRestored false with the steps, the record kept, the teardown finished; lab phone restore finishes it', async () => {
  const { ph } = displayWorld();
  await lab.up([]);
  await safari.appearance(['dark']);
  ph.error = LOCKED;
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(out.phoneRestored, false);
  assert.match(out.human.join(' '), /appearance was not put back to light/);
  assert.equal(stepOf(out, 'release').did, 'released');
  assert.ok(phoneRestoreOnDisk().appearance);

  const stillLocked = await lab.phone(['restore']);
  assert.equal(stillLocked.ok, false);
  assert.match(stillLocked.error, /not all put back; the record is kept/);
  ph.error = null;
  const done = await lab.phone(['restore']);
  assert.equal(done.phoneRestored, true);
  assert.equal(done.restoredExactly, false);
  assert.equal(ph.style, 'light');
  assert.deepEqual(await lab.phone(['restore']), { pending: false, phoneRestored: true, found: 'nothing waiting to be put back' });
});

test('crash recovery: a record left by a killed run is put back by down with no session at all', async () => {
  const { ph } = displayWorld({ style: 'dark' });
  saveState({ lastTarget: 'device', phoneRestore: { udid: PHONE, appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() } } });
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(stepOf(out, 'session').found, 'no session');
  assert.equal(stepOf(out, 'phone-settings').did, 'put back appearance');
  assert.equal(ph.style, 'light');
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('the next lab up puts back a stale record BEFORE it records new values, and a live session\'s changes are left alone', async () => {
  const { ph } = displayWorld();
  await lab.up([]);
  await safari.appearance(['dark']);

  // A live session: `up` again changes nothing, the dark mode is in use.
  const same = await lab.up([]);
  assert.equal(same.ok, undefined, same.error);
  assert.equal(stepNames(same).includes('phone-settings'), false);
  assert.equal(ph.style, 'dark');
  assert.ok(phoneRestoreOnDisk().appearance);

  // The session ended without a restore (the phone was locked at stop): the next up fixes it first.
  ph.error = LOCKED;
  await safari.stop();
  ph.error = null;
  assert.equal(ph.style, 'dark');
  const at = [];
  ph.onSet = () => at.push(app.log.length);
  app.log.length = 0;
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  assert.deepEqual(stepNames(up), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'phone-settings', 'session']);
  assert.equal(stepOf(up, 'phone-settings').did, 'put back appearance');
  assert.equal(up.phoneRestored, true);
  assert.equal(ph.style, 'light');
  assert.equal(at.length, 1);
  assert.ok(at[0] <= postSessionAt(), 'put back before the new session is created');
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('lab up --appearance --orientation: applied after the session exists and put back by down; a rotation lock fails the step and leaves the session open', async () => {
  const { ph } = displayWorld();
  const up = await lab.up(['--appearance', 'dark', '--orientation', 'landscape']);
  assert.equal(up.ok, undefined, up.error);
  assert.deepEqual(stepNames(up), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'session', 'appearance', 'orientation']);
  assert.equal(stepOf(up, 'appearance').did, 'set dark (put back at the end)');
  assert.equal(stepOf(up, 'orientation').found, 'the phone was portrait');
  assert.deepEqual([ph.style, ph.orientation], ['dark', 'landscapeLeft']);
  const out = await lab.down([]);
  assert.equal(out.phoneRestored, true);
  assert.deepEqual([ph.style, ph.orientation], ['light', 'portrait']);

  ph.rotationLock = true;
  const locked = await lab.up(['--orientation', 'landscape']);
  assert.equal(locked.ok, false);
  assert.equal(locked.failedStep, 'orientation');
  assert.match(locked.error, /Portrait Orientation Lock is probably on/);
  assert.equal(loadState().session, 'S2', 'the session is open; safari stop ends it');
});

test('lab status shows what is waiting to be put back, by name only', async () => {
  displayWorld();
  await lab.up([]);
  assert.equal((await lab.status([])).phone.pendingRestore, undefined);
  await safari.appearance(['dark']);
  await safari.orientation(['landscape']);
  const s = await lab.status([]);
  assert.deepEqual(s.phone.pendingRestore, ['appearance', 'orientation']);
  saveState({ phoneRestore: { udid: PHONE } });
  assert.equal((await lab.status([])).phone.pendingRestore.damaged, true);
});

test('the idle stop puts back what the lab changed, like down; a locked phone is recorded in the idle record', async () => {
  const { ph } = displayWorld();
  await idleLab();
  await safari.appearance(['dark']);
  setActive(20);
  const [out] = await logged(() => lab.down(['--idle']));
  assert.equal(out.idle, true);
  assert.equal(out.phoneRestored, true);
  assert.equal(ph.style, 'light');
  assert.equal(loadState().idleStop.phoneRestored, undefined);

  await idleLab();
  await safari.appearance(['dark']);
  ph.error = LOCKED;
  setActive(20);
  const [locked] = await logged(() => lab.down(['--idle']));
  assert.equal(locked.ok, undefined, locked.error);
  assert.equal(locked.phoneRestored, false);
  assert.equal(loadState().idleStop.phoneRestored, false);
  assert.ok(phoneRestoreOnDisk().appearance);
});

test('lab phone restore --forget drops the record without asking the phone; phone forget warns about a record left behind; bad arguments are usage', async () => {
  const { ph } = displayWorld();
  savePhone();
  saveState({ phoneRestore: { udid: PHONE, orientation: { prior: { deviceOrientation: 'portrait', nonFlat: 'portrait' }, set: 'landscapeLeft', at: new Date().toISOString() } } });
  const f = await lab.phone(['forget']);
  assert.deepEqual(f.pendingRestore, ['orientation']);
  assert.match(f.human[0], /lab phone restore --forget/);
  const gone = await lab.phone(['restore', '--forget']);
  assert.equal(gone.forgot, true);
  assert.match(gone.human[0], /Check Appearance/);
  assert.equal(phoneRestoreOnDisk(), undefined);
  assert.deepEqual(await lab.phone(['restore', '--forget']), { forgot: false, forgotten: [], found: 'nothing waiting to be put back' });
  assert.deepEqual(ph.calls, []);
  await assert.rejects(lab.phone(['restore', 'now']), /usage: lab phone setup/);
  await assert.rejects(lab.phone(['restore', '--hard', 'x']), /usage: lab phone setup/);
});

test('lab phone restore (and --forget) is refused while another owner holds a live lease, and proceeds with no lease or its own', async () => {
  const { ph } = displayWorld({ style: 'dark' });
  savePhone();
  const record = { udid: PHONE, appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() } };
  saveState({ phoneRestore: record });
  asLeaseHolder('agent-b');
  await assert.rejects(lab.phone(['restore']), /agent-b/);
  await assert.rejects(lab.phone(['restore', '--forget']), /agent-b/);
  assert.deepEqual(ph.calls, [], 'the phone was not asked');
  assert.deepEqual(phoneRestoreOnDisk(), record, 'the record is untouched');

  asLeaseHolder('me'); // our own lease
  assert.equal((await lab.phone(['restore'])).phoneRestored, true);
  assert.equal(ph.style, 'light');

  fs.rmSync(path.join(stateDir(), 'lease.json'), { force: true }); // no lease
  saveState({ phoneRestore: record });
  assert.equal((await lab.phone(['restore', '--forget'])).forgot, true);
  assert.equal(phoneRestoreOnDisk(), undefined);
  assert.equal(lease.read(), null, 'it takes no lease');
});

test('lab status reports a pending restore at the top level too, also when the phone record is gone, and names nothing else', async () => {
  displayWorld();
  assert.equal('pendingRestore' in await lab.status([]), false, 'nothing pending: no field');
  const record = { udid: PHONE, appearance: { prior: 'light', set: 'dark', at: new Date().toISOString() }, orientation: { prior: { deviceOrientation: 'portrait', nonFlat: 'portrait' }, set: 'landscapeLeft', at: new Date().toISOString() } };
  saveState({ phoneRestore: record });

  saveState({ phone: null });
  const noPhone = await lab.status([]); // no phone saved
  assert.equal(noPhone.phone, null);
  assert.deepEqual(noPhone.pendingRestore, ['appearance', 'orientation']);
  assert.match(noPhone.human[0], /no phone is saved now.*lab phone restore --forget/);
  assert.equal(JSON.stringify(noPhone.pendingRestore).includes('portrait'), false);

  savePhone();
  const withPhone = await lab.status([]);
  assert.deepEqual(withPhone.pendingRestore, ['appearance', 'orientation']);
  assert.deepEqual(withPhone.phone.pendingRestore, ['appearance', 'orientation']);
  assert.equal(withPhone.human, undefined);

  saveState({ phone: null, phoneRestore: { udid: PHONE } });
  assert.equal((await lab.status([])).pendingRestore.damaged, true);
});

// --- Lab Focus during phone runs (#16) ---

// displayWorld with Lab Focus on (the default; savePhone turns it off for the other tests).
function focusWorld(init, saved = {}) {
  const w = displayWorld(init);
  savePhone({ focus: {}, ...saved });
  return w;
}
// Where in the recorded commands the first call with this word is (the order of devicectl launches: the shortcut, then Safari).
const callIndex = word => calls.findIndex(c => c.includes(word));
const shortcutCalls = () => calls.filter(c => c[0] === 'xcrun' && c.includes('com.apple.shortcuts'));

test('lab up on the phone turns Lab Focus on by default, BEFORE the lab opens its Safari tab, and records it first', async () => {
  const { ph } = focusWorld();
  let entryAtLaunch;
  ph.onSet = () => { entryAtLaunch = structuredClone(phoneRestoreOnDisk()); };
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  assert.deepEqual(stepNames(up), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'focus', 'session']);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  assert.equal(ph.focus, 'on');
  assert.deepEqual(up.focus, { applied: true, shortcut: 'Lab Focus On', verified: false });
  assert.equal(up.human, undefined);
  assert.deepEqual([entryAtLaunch.udid, entryAtLaunch.focus.prior, entryAtLaunch.focus.set], [PHONE, 'unknown', 'on'], 'the entry is on disk before the shortcut runs');
  assert.deepEqual(Object.keys(phoneRestoreOnDisk()).sort(), ['focus', 'udid']);
  // Ordering by the recorded commands, not by time: the shortcut is launched before Safari is (that launch pins the tab).
  assert.ok(callIndex('com.apple.shortcuts') >= 0 && callIndex('com.apple.mobilesafari') >= 0);
  assert.ok(callIndex('com.apple.shortcuts') < callIndex('com.apple.mobilesafari'), 'Shortcuts is in front only until Safari is launched over it');
  assert.ok(callIndex('lockState') < callIndex('com.apple.shortcuts'), 'the lock state was read first');
  // The exact argument list: no shell string, the saved udid, the Shortcuts bundle id.
  const launch = shortcutCalls();
  assert.equal(launch.length, 1);
  assert.deepEqual(launch[0].slice(0, 9), ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', PHONE, '--payload-url', 'shortcuts://run-shortcut?name=Lab%20Focus%20On']);
  assert.equal(launch[0][9], 'com.apple.shortcuts');
  assert.ok(launch[0].includes('--json-output'));
  assert.equal(launch[0].includes('booted'), false);
  assert.equal(stepOf(up, 'focus').did.startsWith('ran it'), true);
  neverUnsafe(app);
});

test('--no-focus skips Lab Focus for one run; `lab phone setup --focus off` skips it until it is turned on again; neither runs a shortcut or writes an entry', async () => {
  const { ph } = focusWorld();
  const once = await lab.up(['--no-focus']);
  assert.equal(once.ok, undefined, once.error);
  assert.deepEqual(stepNames(once), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'session']);
  assert.deepEqual(once.focus, { applied: false, skipped: '--no-focus' });
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(phoneRestoreOnDisk(), undefined);
  await lab.down([]);

  savePhone({ focus: { enabled: false } });
  const off = await lab.up([]);
  assert.equal(off.ok, undefined, off.error);
  assert.deepEqual(off.focus, { applied: false, skipped: '`lab phone setup --focus off`' });
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(shortcutCalls().length, 0);
  await lab.down([]);

  savePhone({ focus: { enabled: true } });
  assert.equal((await lab.up([])).focus.applied, true);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
});

test('a live session is kept as it is: a second lab up does not run the shortcut again (Shortcuts would cover the lab tab)', async () => {
  const { ph } = focusWorld();
  await lab.up([]);
  const again = await lab.up([]);
  assert.equal(again.ok, undefined, again.error);
  assert.equal(stepNames(again).includes('focus'), false);
  assert.equal('focus' in again, false);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
});

test('lab down runs Lab Focus Off through the ledger, says the Focus cannot be confirmed, and a second down does nothing about it', async () => {
  const { ph } = focusWorld();
  await lab.up([]);
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  assert.equal(ph.focus, 'off');
  assert.equal(out.phoneRestored, true);
  assert.equal(out.restoredExactly, false);
  assert.equal(out.phoneRestore.focus.restored, true);
  assert.match(out.phoneRestore.focus.note, /cannot read which Focus is on/);
  assert.equal(phoneRestoreOnDisk(), undefined);
  assert.equal(stepNames(out).includes('phone-settings'), false, 'put back in the session step');
  const again = await lab.down([]);
  assert.equal('phoneRestored' in again, false);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
});

test('safari stop runs Lab Focus Off after the lab tab is closed and before the session is deleted', async () => {
  const { ph } = focusWorld();
  await lab.up([]);
  const at = [];
  ph.onSet = () => at.push(app.log.length);
  const stopped = await safari.stop();
  assert.equal(stopped.phoneRestored, true);
  assert.equal(ph.focus, 'off');
  assert.equal(at.length, 1);
  assert.ok(closeScriptAt() >= 0 && closeScriptAt() < at[0] && at[0] <= deleteAt());
});

test('the shortcut names saved by `lab phone setup` are the ones run, on and off, URL-encoded', async () => {
  const { ph } = focusWorld({}, { focus: { onShortcut: 'My Lab.On_1', offShortcut: 'Lab-Off 2' } });
  await lab.up([]);
  await lab.down([]);
  assert.deepEqual(ph.shortcuts, ['My Lab.On_1', 'Lab-Off 2']);
  assert.ok(shortcutCalls()[0].includes('shortcuts://run-shortcut?name=My%20Lab.On_1'));
  assert.ok(shortcutCalls()[1].includes('shortcuts://run-shortcut?name=Lab-Off%202'));
});

test('a launch that fails is not a failure of lab up: focus.applied false, needs shortcut with the setup steps, no entry left, the session opens', async () => {
  const { ph } = focusWorld({ launchError: { code: 1, stderr: 'ERROR: The application is not installed. (CoreDeviceError 10002)' } });
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  assert.equal(up.session, 'S1');
  assert.equal(up.focus.applied, false);
  assert.equal(up.focus.needs, 'shortcut');
  assert.match(up.focus.error, /not installed/);
  assert.equal('human' in up.focus, false);
  assert.match(up.human.join(' '), /Settings > Focus.*"Lab".*"Lab Focus On".*Turn Lab On Until Turned Off.*"Lab Focus Off".*Turn Lab Off/s);
  assert.match(up.human.join(' '), /--no-focus/);
  assert.equal(stepOf(up, 'focus').did, null);
  assert.equal(stepNames(up).at(-1), 'session');
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(phoneRestoreOnDisk(), undefined, 'nothing was turned on, so nothing is waiting');
  assert.equal(ph.focus, 'off');
});

test('a locked phone at the start is the existing unlock handling: lab up stops at the phone step and runs no shortcut', async () => {
  const { ph } = focusWorld({ locked: true });
  const up = await lab.up([]);
  assert.equal(up.ok, false);
  assert.equal(up.failedStep, 'phone');
  assert.equal(up.needs, 'unlock');
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(shortcutCalls().length, 0);
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('a phone that locks after the phone step is never launched onto: focus.applied false, needs unlock, no entry, the session still opens', async () => {
  const { ph } = focusWorld({ locked: false });
  const real = ph.handle;
  const probe = await lab.up([]); // which lock check is the focus step's own: the last one before its shortcut launch
  assert.equal(probe.ok, undefined, probe.error);
  const own = calls.slice(0, callIndex('com.apple.shortcuts')).filter(c => c.includes('lockState')).length;
  await lab.down([]);
  ph.shortcuts.length = 0;
  let seen = 0;
  ph.handle = (cmd, args) => { if (args.includes('lockState')) ph.locked = ++seen === own; return real(cmd, args); }; // locked for that one check only
  calls.length = 0;
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  assert.equal(up.focus.applied, false);
  assert.equal(up.focus.needs, 'unlock');
  assert.match(up.human.join(' '), /Unlock the phone/);
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(shortcutCalls().length, 0, 'no shortcut was launched on the locked phone');
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('locked at stop: the entry is kept, no shortcut is launched (no passcode prompt), the output says what to do; the next unlocked lab up runs Off BEFORE On', async () => {
  const { ph } = focusWorld({ locked: false });
  await lab.up([]);
  ph.locked = true;
  const stopped = await safari.stop();
  assert.equal(stopped.stopped, true, 'a locked phone is not a failure of stop');
  assert.equal(stopped.phoneRestored, false);
  assert.match(stopped.human.join(' '), /unlock it and run `lab phone restore`/);
  assert.match(stopped.human.join(' '), /turn Lab Focus off by hand/);
  assert.ok(phoneRestoreOnDisk().focus, 'the entry is kept');
  assert.deepEqual(ph.shortcuts, ['Lab Focus On'], 'no Off was launched on the locked phone');
  assert.equal(ph.focus, 'on');
  assert.deepEqual((await lab.status([])).pendingRestore, ['focus']);

  ph.locked = false;
  const up = await lab.up([]);
  assert.equal(up.ok, undefined, up.error);
  assert.deepEqual(stepNames(up), ['lease', 'prerequisites', 'appium', 'phone', 'slot', 'phone-settings', 'focus', 'session']);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off', 'Lab Focus On']);
  assert.equal(up.phoneRestored, true);
  assert.equal(up.focus.applied, true);
  assert.deepEqual(Object.keys(phoneRestoreOnDisk()).sort(), ['focus', 'udid']);
});

test('lab down and lab phone restore on a locked phone keep the entry; an unlocked lab phone restore finishes it', async () => {
  const { ph } = focusWorld({ locked: false });
  await lab.up([]);
  ph.locked = true;
  const down = await lab.down([]);
  assert.equal(down.ok, undefined, down.error);
  assert.equal(down.phoneRestored, false);
  assert.match(down.human.join(' '), /Lab Focus/);
  assert.ok(phoneRestoreOnDisk().focus);
  const still = await lab.phone(['restore']);
  assert.equal(still.ok, false);
  assert.equal(still.phoneRestore.focus.restored, false);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  ph.locked = false;
  const done = await lab.phone(['restore']);
  assert.equal(done.phoneRestored, true);
  assert.equal(done.restoredExactly, false);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('the idle stop on a locked phone launches no shortcut (no surprise passcode prompt) and records phoneRestored false; the entry stays', async () => {
  const { ph } = focusWorld({ locked: false });
  await idleLab();
  ph.locked = true;
  setActive(20);
  const [locked] = await logged(() => lab.down(['--idle']));
  assert.equal(locked.ok, undefined, locked.error);
  assert.equal(locked.phoneRestored, false);
  assert.equal(loadState().idleStop.phoneRestored, false);
  assert.ok(phoneRestoreOnDisk().focus);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  assert.equal(shortcutCalls().length, 0, 'idleLab cleared the calls after the up; nothing was launched since');
});

test('the idle stop on an unlocked phone runs Off', async () => {
  const { ph } = focusWorld({ locked: false });
  await idleLab();
  setActive(20);
  const [out] = await logged(() => lab.down(['--idle']));
  assert.equal(out.phoneRestored, true);
  assert.equal(ph.focus, 'off');
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('a crash (the entry on disk, no session) is finished by lab down: Off runs with no session', async () => {
  const { ph } = focusWorld({ focus: 'on' });
  saveState({ lastTarget: 'device', phoneRestore: { udid: PHONE, focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() } } });
  const out = await lab.down([]);
  assert.equal(out.ok, undefined, out.error);
  assert.equal(stepOf(out, 'phone-settings').did, 'put back focus');
  assert.deepEqual(ph.shortcuts, ['Lab Focus Off']);
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('a failed Off launch keeps the entry with steps for a person; the simulator target never runs a shortcut', async () => {
  const { ph } = focusWorld({ locked: false });
  await lab.up([]);
  ph.launchError = { code: 1, stderr: 'ERROR: something else went wrong' };
  const stopped = await safari.stop();
  assert.equal(stopped.phoneRestored, false);
  assert.ok(phoneRestoreOnDisk().focus);
  assert.match(stopped.human.join(' '), /Lab Focus/);
  ph.launchError = null;
  await lab.down([]);
  assert.equal(phoneRestoreOnDisk(), undefined);

  // The simulator target: with a phone saved and Lab Focus on, --target simulator touches no phone at all.
  calls.length = 0;
  ph.shortcuts.length = 0;
  const simRun = await lab.up(['--target', 'simulator']);
  assert.equal(simRun.ok, undefined, simRun.error);
  assert.equal('focus' in simRun, false);
  assert.deepEqual(ph.shortcuts, []);
  assert.deepEqual(devicectlCalls(calls), []);
});

test('lab phone setup saves Lab Focus: --focus on|off and the two shortcut names, each optional (an omitted one keeps the saved value), bad values refused before anything runs', async () => {
  const c = phoneWorld(CABLE);
  const base = ['setup', '--udid', PHONE, '--team', TEAM];
  await assert.rejects(lab.phone([...base, '--focus', 'maybe']), /--focus "maybe" must be on or off/);
  for (const bad of ['', 'a&b', 'a#b', 'a/b', 'café', 'x'.repeat(61), ' Lab', 'Lab ', 'a?name=b', 'a%20b', '日本']) {
    await assert.rejects(lab.phone([...base, '--focus-on-shortcut', bad]), /is not a shortcut name/, JSON.stringify(bad));
    await assert.rejects(lab.phone([...base, '--focus-off-shortcut', bad]), /is not a shortcut name/, JSON.stringify(bad));
  }
  assert.deepEqual(c, [], 'no command ran');
  assert.equal(loadState().phone, undefined);

  let out = await lab.phone([...base]);
  assert.equal(loadState().phone.focus, undefined, 'no flag, nothing saved');
  assert.deepEqual((await lab.phone(['status'])).phone.focus, { enabled: true, onShortcut: 'Lab Focus On', offShortcut: 'Lab Focus Off' }, 'status shows the defaults');
  out = await lab.phone([...base, '--focus', 'off']);
  assert.deepEqual(loadState().phone.focus, { enabled: false });
  out = await lab.phone([...base, '--focus-on-shortcut', 'Lab In']);
  assert.deepEqual(loadState().phone.focus, { enabled: false, onShortcut: 'Lab In' }, 'the saved --focus stays');
  out = await lab.phone([...base, '--focus', 'on', '--focus-off-shortcut', 'Lab Out']);
  assert.deepEqual(out.phone.focus, { enabled: true, onShortcut: 'Lab In', offShortcut: 'Lab Out' });
  assert.deepEqual((await lab.phone(['status'])).phone.focus, { enabled: true, onShortcut: 'Lab In', offShortcut: 'Lab Out' });
  assert.deepEqual((await lab.status()).phone.focus, { enabled: true, onShortcut: 'Lab In', offShortcut: 'Lab Out' });
});

test('a malformed focus field in the phone record is a damaged record; lab up refuses a --focus flag and names --no-focus in its usage', async () => {
  for (const focus of ['on', null, [], { enabled: 'yes' }, { onShortcut: 'a&b' }, { offShortcut: 7 }, { extra: 1 }]) {
    saveState({ phone: { udid: PHONE, teamId: TEAM, bundleId: BUNDLE, focus } });
    assert.throws(() => phone.readPhone(loadState()), /damaged/, JSON.stringify(focus));
  }
  await assert.rejects(lab.up(['--focus', 'off']), /usage: lab up .*\[--no-focus\]/);
});

test('the Off shortcut named in the entry when On ran is the one run, also after a rename; an entry without a name uses the current setting', async () => {
  const { ph } = focusWorld();
  await lab.up([]);
  assert.equal(phoneRestoreOnDisk().focus.off, 'Lab Focus Off');
  savePhone({ focus: { offShortcut: 'Renamed Off' } });
  await lab.down([]);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  assert.equal(phoneRestoreOnDisk(), undefined);

  saveState({ lastTarget: 'device', phoneRestore: { udid: PHONE, focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() } } });
  await lab.down([]);
  assert.equal(ph.shortcuts.at(-1), 'Renamed Off', 'an old entry has no name');
  saveState({ phoneRestore: { udid: PHONE, focus: { prior: 'unknown', set: 'on', at: new Date().toISOString(), off: 'a&b' } } });
  assert.throws(() => ledger.readRestore(loadState()), /damaged/);
});

test('a lab up that fails after the focus step, before its session opens, turns Lab Focus off again; a locked phone keeps the entry and the failed JSON says it is still on', async () => {
  const { ph } = focusWorld({ locked: false });
  app.fx.createFails = true;
  const out = await lab.up([]);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'session');
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  assert.equal(ph.focus, 'off');
  assert.equal(out.phoneRestored, true);
  assert.equal(out.phoneRestore.focus.restored, true);
  assert.equal((out.human ?? []).join(' ').includes('Lab Focus is still on'), false);
  assert.equal(phoneRestoreOnDisk(), undefined);

  // The phone locks after the shortcut ran, before the failure.
  ph.shortcuts.length = 0;
  const real = ph.handle;
  ph.handle = (cmd, args) => { const r = real(cmd, args); if (args.includes('com.apple.shortcuts')) ph.locked = true; return r; };
  const locked = await lab.up([]);
  assert.equal(locked.ok, false);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On'], 'no Off was launched on the locked phone');
  assert.equal(locked.phoneRestored, false);
  assert.match(locked.human.join(' '), /Lab Focus is still on/);
  assert.match(locked.human.join(' '), /lab phone restore/);
  assert.ok(phoneRestoreOnDisk().focus, 'the entry is kept');
  ph.locked = false;
  assert.equal((await lab.phone(['restore'])).phoneRestored, true);
  assert.equal(ph.focus, 'off');
});

test('a lab up that fails with its session open leaves Lab Focus to safari stop (Shortcuts would cover the lab tab)', async () => {
  const { ph } = focusWorld({ rotationLock: true });
  const out = await lab.up(['--orientation', 'landscape']);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'orientation');
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  assert.ok(phoneRestoreOnDisk().focus);
  assert.equal('phoneRestored' in out, false);
  assert.ok(out.human.some(h => /Lab Focus is still on, and the session is still open: `safari stop`/.test(h)), 'the failed JSON says Focus is still on');
  const stopped = await safari.stop();
  assert.equal(stopped.phoneRestored, true);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
});

test('the idle stop tries a pending Lab Focus restore when nothing else is running, once per idle period', async () => {
  const { ph } = focusWorld({ locked: false });
  await lab.up([]);
  ph.locked = true;
  await lab.down([]); // locked: the entry stays, nothing else is left running
  assert.ok(phoneRestoreOnDisk().focus);
  await lease.release({ owner: 'me' }).catch(() => {});
  setActive(20);
  ph.locked = false;
  const [out] = await logged(() => lab.down(['--idle']));
  assert.equal(out.idle, true);
  assert.match(out.running.join(' '), /Lab Focus is waiting/);
  assert.equal(out.phoneRestored, true);
  assert.equal(ph.focus, 'off');
  assert.equal(phoneRestoreOnDisk(), undefined);
  const [again] = await logged(() => lab.down(['--idle']));
  assert.equal(again.idle, false, 'nothing pending, nothing running');

  // Still locked at the idle stop: one try, then it waits for a lab command.
  await lab.up([]);
  ph.locked = true;
  await lab.down([]);
  setActive(20);
  const [locked] = await logged(() => lab.down(['--idle']));
  assert.equal(locked.idle, true);
  assert.equal(locked.phoneRestored, false);
  const [waits] = await logged(() => lab.down(['--idle']));
  assert.equal(waits.idle, false);
  assert.ok(phoneRestoreOnDisk().focus);
});

// --- lab phone focus test|off (#16) ---

test('lab phone focus test runs the On shortcut with the entry written first and says what to look for; focus off runs Off and clears the entry', async () => {
  const { ph } = focusWorld({ locked: false });
  let entryAtLaunch;
  ph.onSet = () => { entryAtLaunch = structuredClone(phoneRestoreOnDisk()); };
  const t = await lab.phone(['focus', 'test']);
  assert.equal(t.ok, undefined);
  assert.deepEqual(t.focus, { applied: true, shortcut: 'Lab Focus On', verified: false });
  assert.match(t.human.join(' '), /Lab Focus icon.*lab phone focus off/s);
  assert.equal(t.then, 'lab phone focus off');
  assert.deepEqual([entryAtLaunch.focus.prior, entryAtLaunch.focus.set], ['unknown', 'on']);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On']);
  assert.equal(ph.focus, 'on');
  assert.deepEqual((await lab.status([])).pendingRestore, ['focus']);
  const l = shortcutCalls()[0];
  assert.deepEqual(l.slice(5, 10), ['--device', PHONE, '--payload-url', 'shortcuts://run-shortcut?name=Lab%20Focus%20On', 'com.apple.shortcuts']);

  const off = await lab.phone(['focus', 'off']);
  assert.equal(off.ok, undefined);
  assert.equal(off.focus.applied, true);
  assert.equal(off.phoneRestored, true);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  assert.equal(ph.focus, 'off');
  assert.equal(phoneRestoreOnDisk(), undefined);
});

test('lab phone focus test left on is turned off by lab phone restore; focus off with nothing recorded still runs Off', async () => {
  const { ph } = focusWorld({ locked: false });
  await lab.phone(['focus', 'test']);
  assert.equal((await lab.phone(['restore'])).phoneRestored, true);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
  const none = await lab.phone(['focus', 'off']);
  assert.equal(none.ok, undefined);
  assert.match(none.found, /no Lab Focus was recorded as on/);
  assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off', 'Lab Focus Off']);
});

test('lab phone focus test|off on a locked phone launch nothing: test is needs unlock with no entry, off keeps the entry', async () => {
  const { ph } = focusWorld({ locked: true });
  await assert.rejects(lab.phone(['focus', 'test']), e => e.extra.needs === 'unlock');
  assert.equal(phoneRestoreOnDisk(), undefined);
  await assert.rejects(lab.phone(['focus', 'off']), e => e.extra.needs === 'unlock');
  saveState({ phoneRestore: { udid: PHONE, focus: { prior: 'unknown', set: 'on', at: new Date().toISOString() } } });
  const kept = await lab.phone(['focus', 'off']);
  assert.equal(kept.ok, false);
  assert.equal(kept.focus.applied, false);
  assert.ok(phoneRestoreOnDisk().focus);
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(shortcutCalls().length, 0);
});

test('lab phone focus: usage, no phone, a simulator or device session, and another owner\'s lease are refused before any shortcut runs', async () => {
  const { ph } = focusWorld({ locked: false });
  for (const argv of [['focus'], ['focus', 'on'], ['focus', 'test', 'x']]) await assert.rejects(lab.phone(argv), /usage: lab phone setup .*focus test\|off/, argv.join(' '));
  asLeaseHolder('agent-b');
  await assert.rejects(lab.phone(['focus', 'test']), /agent-b/);
  fs.rmSync(path.join(stateDir(), 'lease.json'), { force: true });
  saveState({ phone: null });
  await assert.rejects(lab.phone(['focus', 'test']), e => e.extra.needs === 'setup');
  savePhone({ focus: {} });
  await lab.up(['--target', 'simulator']);
  await assert.rejects(lab.phone(['focus', 'test']), /simulator session is open/);
  await lab.down([]);
  await lab.up(['--no-focus']);
  await assert.rejects(lab.phone(['focus', 'off']), /device session is open.*safari stop/);
  assert.deepEqual(ph.shortcuts, []);
  assert.equal(shortcutCalls().length, 0);
});

test('lab phone focus goes through cli as one JSON object', async () => {
  focusWorld({ locked: false });
  const lines = [];
  const log = console.log;
  console.log = l => lines.push(l);
  try {
    assert.equal(await cli(lab, ['phone', 'focus', 'test']), 0);
    assert.equal(await cli(lab, ['phone', 'focus', 'off']), 0);
    assert.equal(await cli(lab, ['phone', 'focus', 'bogus']), 1);
  } finally { console.log = log; }
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => JSON.parse(l).ok), [true, true, false]);
});

// --- the early look at the signing lock (#63, acceptance item 39) ---

const needPerl = { skip: !havePerl && '/usr/bin/perl is not here' };
// Helper processes of the lock that are alive for this lock file (ps lists their argv).
const helpersFor = dir => spawnSync('ps', ['-axo', 'command=']).stdout.toString().split('\n').filter(l => l.includes(path.join(dir, '.op.lock')));
const noPhoneWork = (ph, t) => {
  assert.equal(app.log.length, 0, 'Appium was not called');
  assert.deepEqual(calls.filter(c => c[0] === 'launchctl'), [], 'no service touched');
  assert.deepEqual(calls.filter(c => c[0] === 'xcrun' && c[1] === 'devicectl'), [], 'the phone was not asked');
  assert.deepEqual(ph?.shortcuts ?? [], [], 'Lab Focus was not run');
  assert.equal(phoneRestoreOnDisk(), undefined);
  assert.equal(createdSessions(), 0);
  if (t) assert.deepEqual([t.kicks, t.spawned.length], [0, 0], 'no tunnel');
};

test('lab up --target device while sideload holds the lock stops at the lock, before Appium, the phone, the tunnel or Lab Focus', needPerl, async () => {
  const dir = tempDir();
  const t = tunnelWorld();
  deviceWorld(WIFI, { expires: inHours(72), extra: t.extra });
  savePhone({ focus: {} });
  const other = await holdLock(dir);
  try {
    const began = Date.now();
    const out = await withSignLock({ home: dir }, () => lab.up(['--target', 'device']));
    assert.ok(Date.now() - began < 3000, 'a busy lock answers at once');
    assert.equal(out.ok, false);
    assert.equal(out.needs, 'busy');
    assert.equal(out.then, 'lab up --target device');
    assert.match(out.human.join(' '), /sideload is signing or installing an app with the same Apple team; try again in a minute\./);
    assert.equal(out.failedStep, 'signing lock');
    assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'signing lock']);
    assert.equal(stepOf(out, 'signing lock').found, 'held by sideload');
    assert.match(stepOf(out, 'signing lock').error, /sideload holds the signing lock/);
    noPhoneWork(null, t);
  } finally { await other.release(); }
  assert.deepEqual(helpersFor(dir), []);
  assert.equal(lockIsFree(dir), true);
});

test('lab up (auto) with a phone while sideload holds the lock stops after the phone step: no tunnel, no phone settings, no Lab Focus', needPerl, async () => {
  const dir = tempDir();
  const { ph } = focusWorld();
  const other = await holdLock(dir);
  try {
    const out = await withSignLock({ home: dir }, () => lab.up([]));
    assert.equal(out.ok, false);
    assert.equal(out.needs, 'busy');
    assert.equal(out.failedStep, 'signing lock');
    assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'phone', 'signing lock']);
    assert.deepEqual(ph.shortcuts, [], 'Lab Focus was not run');
    assert.equal(phoneRestoreOnDisk(), undefined);
    assert.equal(createdSessions(), 0);
    assert.equal(out.focus, undefined);
  } finally { await other.release(); }
  assert.deepEqual(helpersFor(dir), []);
});

test('a free lock at the start is let go at once and the run goes on; the real take at the session step still decides', needPerl, async () => {
  const dir = tempDir();
  focusWorld();
  const out = await withSignLock({ home: dir }, () => lab.up(['--target', 'device']));
  assert.equal(out.ok, undefined, out.error);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'signing lock', 'appium', 'phone', 'slot', 'focus', 'session']);
  assert.equal(stepOf(out, 'signing lock').found, 'free');
  assert.equal(lockIsFree(dir), true, 'nothing holds the lock once up is done');
  assert.deepEqual(helpersFor(dir), []);
});

test('free at the start, taken by sideload before the session: the session step says busy and Lab Focus is turned off again', needPerl, async () => {
  const dir = tempDir();
  const { ph } = focusWorld();
  let other;
  ph.onSet = () => { other ??= holdLockNow(dir); }; // sideload takes the lock as the Focus shortcut runs, after the early look
  try {
    const out = await withSignLock({ home: dir }, () => lab.up(['--target', 'device']));
    assert.ok(other, 'the stand-in took the lock mid-run');
    assert.equal(out.ok, false);
    assert.equal(out.needs, 'busy');
    assert.equal(out.failedStep, 'session');
    assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'signing lock', 'appium', 'phone', 'slot', 'focus', 'session']);
    assert.equal(stepOf(out, 'signing lock').found, 'free');
    assert.deepEqual(ph.shortcuts, ['Lab Focus On', 'Lab Focus Off']);
    assert.equal(ph.focus, 'off');
    assert.equal(phoneRestoreOnDisk(), undefined);
    assert.equal(createdSessions(), 0);
  } finally { await other?.release(); }
  assert.deepEqual(helpersFor(dir), []);
});

test('a live device session is reused without looking at the lock, even while sideload holds it', needPerl, async () => {
  const dir = tempDir();
  focusWorld();
  const first = await withSignLock({ home: dir }, () => lab.up(['--target', 'device']));
  assert.equal(first.ok, undefined, first.error);
  assert.equal(stepOf(first, 'signing lock').found, 'free');
  const other = await holdLock(dir);
  try {
    for (const argv of [['--target', 'device'], []]) {
      const again = await withSignLock({ home: dir }, () => lab.up(argv));
      assert.equal(again.ok, undefined, again.error);
      assert.equal(again.reused, true);
      assert.equal(stepNames(again).includes('signing lock'), false, argv.join(' '));
    }
  } finally { await other.release(); }
  assert.deepEqual(helpersFor(dir), []);
});

test('the simulator never looks at the lock, held or not', needPerl, async () => {
  const dir = tempDir();
  deviceWorld();
  const other = await holdLock(dir);
  try {
    for (const argv of [['--target', 'simulator'], []]) { // no phone is saved: auto is the simulator too
      const out = await withSignLock({ home: dir }, () => lab.up(argv));
      assert.equal(out.ok, undefined, out.error);
      assert.equal(stepNames(out).includes('signing lock'), false, argv.join(' '));
      await lab.down([]);
    }
    deviceWorld(CABLE, { expires: inHours(72) });
    savePhone();
    const sim = await withSignLock({ home: dir }, () => lab.up(['--target', 'simulator']));
    assert.equal(sim.ok, undefined, sim.error);
    assert.equal(stepNames(sim).includes('signing lock'), false);
  } finally { await other.release(); }
  assert.deepEqual(helpersFor(dir), []);
});

test('no sideload folder, or MSL_SIGNLOCK=off: no look at the lock and no step for it', needPerl, async () => {
  const missing = path.join(tempDir(), 'missing');
  deviceWorld(CABLE, { expires: inHours(72) });
  savePhone();
  const none = await withSignLock({ home: missing }, () => lab.up(['--target', 'device']));
  assert.equal(none.ok, undefined, none.error);
  assert.equal(stepNames(none).includes('signing lock'), false);
  assert.equal(none.signLock, undefined);
  assert.equal(fs.existsSync(missing), false, 'the lab does not make sideload\'s folder');
  await lab.down([]);

  const dir = tempDir();
  const off = await withSignLock({ home: dir, off: 'off' }, () => lab.up(['--target', 'device']));
  assert.equal(off.ok, undefined, off.error);
  assert.equal(stepNames(off).includes('signing lock'), false);
  assert.equal(off.signLock, 'disabled');
  assert.equal(fs.existsSync(path.join(dir, '.op.lock')), false);
});

test('an unopenable lock file stops the early look with the same actionable error as the take, before anything starts', needPerl, async () => {
  const dir = tempDir();
  const t = tunnelWorld();
  deviceWorld(WIFI, { expires: inHours(72), extra: t.extra });
  savePhone();
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, '.op.lock'));
  const out = await withSignLock({ home: dir }, () => lab.up(['--target', 'device']));
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'signing lock');
  assert.match(out.error, /couldn't open the signing lock file .*symlink.*MSL_SIGNLOCK=off/s);
  assert.equal(out.needs, undefined);
  assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'signing lock']);
  assert.equal(stepOf(out, 'signing lock').found, null);
  noPhoneWork(null, t);
  assert.deepEqual(helpersFor(dir), []);
});

// --- the slot step (#63, ADR 0008): borrowing a slot from sideload when the phone has no room for WebDriverAgent ---

// deviceWorld plus the phone's app list, installd's answers to the runner install, and a stand-in sideload binary (an executable file the
// lab can find; its answers come from `answers`, its argv is kept in `sideload`). `installs`: 'ok' | 'limit' | a runner reply, one per install.
// `plutil` is the built runner's bundle id. `tunnel` is a tunnelWorld, `listFails` makes the listing fail, `locked` makes the phone locked for the slot's own lock check.
function slotWorld(files, { apps = [], installs = [], answers = [], plutil = `${BUNDLE}.xctrunner`, tunnel: t = null, listFails = false, locked = false } = {}) {
  const s = { apps: new Set(apps), installs: [...installs], answers: [...answers], sideload: [], installed: 0, bin: path.join(tempDir('msl-sideload-bin-'), 'sideload') };
  fs.writeFileSync(s.bin, '#!/bin/sh\n', { mode: 0o755 });
  process.env.MSL_SIDELOAD_BIN = s.bin;
  s.w = deviceWorld(files, {
    expires: inHours(72),
    extra: (cmd, args) => {
      const mine = t?.extra(cmd, args);
      if (mine) return mine;
      if (cmd === 'plutil') return { stdout: `${plutil}\n` };
      if (cmd === s.bin) { s.sideload.push(args); return { stdout: `${JSON.stringify(s.answers.shift() ?? { ok: true, command: 'slot' })}\n` }; }
      if (locked && cmd === 'xcrun' && args.includes('lockState')) { fs.writeFileSync(args[args.indexOf('--json-output') + 1], fs.readFileSync(path.join(FIX, 'lock-locked.json'), 'utf8')); return { code: 0 }; }
      if (cmd !== 'xcrun' || args[0] !== 'devicectl' || args[1] !== 'device') return undefined;
      const out = args[args.indexOf('--json-output') + 1];
      if (args[2] === 'info' && args[3] === 'apps') {
        if (listFails) return { code: 1, stderr: 'devicectl: the device did not answer' };
        fs.writeFileSync(out, JSON.stringify({ result: { apps: [...s.apps].map(bundleIdentifier => ({ bundleIdentifier })) } }));
        return { code: 0 };
      }
      if (args[2] === 'install') {
        s.installed++;
        const r = s.installs.shift() ?? 'ok';
        if (r === 'ok') { s.apps.add(`${BUNDLE}.xctrunner`); return { code: 0 }; }
        return r === 'limit' ? { code: 1, stderr: 'This device has reached the maximum number of installed apps using a free developer profile.' } : r;
      }
      if (args[2] === 'uninstall') { s.apps.delete(args.at(-3)); return { code: 0 }; }
      return undefined;
    },
  });
  return s;
}
const lendReply = (extra = {}) => ({ ok: true, command: 'slot', action: 'lend', freed: 1, app: 'stremio-ios', device: 'iPhone', ...extra });
const lentRecord = (s, extra = {}) => ({ udid: PHONE, phase: 'lent', at: '2026-10-24T12:00:00.000Z', since: '2026-10-24T12:00:00.000Z', app: 'stremio-ios', bin: s.bin, home: tempDir(), ...extra });

test('lab up on a full phone: the slot step borrows a slot from sideload, installs WebDriverAgent, and the result says so (L3)', needPerl, async () => {
  const home = tempDir();
  const s = slotWorld(CABLE, { installs: ['limit', 'ok'], answers: [lendReply()] });
  savePhone();
  try {
    const out = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(out.ok, undefined, out.error);
    assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'signing lock', 'appium', 'phone', 'slot', 'session']);
    const step = stepOf(out, 'slot');
    assert.equal(step.found, 'WebDriverAgent missing, no free slot');
    assert.match(step.did, /^borrowed stremio-ios's slot from sideload and installed it$/);
    assert.deepEqual(step.slot, { lent: 'stremio-ios', freed: 1 });
    assert.deepEqual(out.slot, { lent: 'stremio-ios', freed: 1 });
    assert.deepEqual(s.sideload, [['slot', 'lend', '--udid', PHONE, '--to', 'lab']]);
    assert.equal(s.installed, 2);
    const rec = loadState().slotLend;
    assert.deepEqual([rec.phase, rec.app, rec.udid, rec.bin, rec.home], ['lent', 'stremio-ios', PHONE, s.bin, home]);
    assert.equal(lockIsFree(home), true);

    // `lab down` leaves the slot to the idle stop; the next run keeps the held lend: WebDriverAgent is there, so nothing is returned,
    // installed or asked of sideload.
    fs.writeFileSync(svc.idlePlistPath(), '<plist/>');
    await lab.down(['--keep-service']);
    assert.equal(loadState().slotLend.phase, 'lent');
    const again = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(again.ok, undefined, again.error);
    assert.equal(stepOf(again, 'slot').found, 'WebDriverAgent installed');
    assert.equal(again.slot, undefined);
    assert.equal(s.sideload.length, 1);
    assert.equal(s.installed, 2);
    assert.equal(loadState().slotLend.phase, 'lent');
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a phone with room: the slot step installs WebDriverAgent itself, says nothing was borrowed, and never calls sideload (L2)', needPerl, async () => {
  const home = tempDir();
  const s = slotWorld(CABLE, { installs: ['ok'] });
  savePhone();
  try {
    const out = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(out.ok, undefined, out.error);
    assert.equal(stepOf(out, 'slot').found, 'WebDriverAgent missing');
    assert.match(stepOf(out, 'slot').did, /it fit; nothing borrowed/);
    assert.equal(out.slot, undefined);
    assert.deepEqual(s.sideload, []);
    assert.equal(loadState().slotLend, undefined);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a busy sideload at the slot step stops `up` there: no tunnel, no Lab Focus, no session, a retry time (L12)', needPerl, async () => {
  const home = tempDir();
  const t = tunnelWorld();
  const s = slotWorld(WIFI, { installs: ['limit'], answers: [{ ok: false, command: 'slot', action: 'lend', errors: [{ code: 'SLOT_PENDING', message: 'a lend is pending', fix: 'wait' }], retryAfter: 120 }], tunnel: t });
  savePhone({ focus: {} });
  try {
    const out = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(out.ok, false);
    assert.equal(out.failedStep, 'slot');
    assert.equal(out.needs, 'busy');
    assert.ok(Date.parse(out.retryAt) > Date.now());
    assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'signing lock', 'appium', 'phone', 'slot']);
    assert.match(stepOf(out, 'slot').error, /SLOT_PENDING/);
    assert.equal(createdSessions(), 0);
    assert.deepEqual([t.kicks, t.spawned.length], [0, 0], 'no tunnel');
    assert.deepEqual(calls.filter(c => c.includes('com.apple.shortcuts')), [], 'Lab Focus was not run');
    assert.equal(phoneRestoreOnDisk(), undefined);
    assert.equal(loadState().slotLend.phase, 'lending');
    assert.equal(loadState().slotLend.retryAt, out.retryAt);
    assert.equal(s.installed, 1);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a phone that cannot list its apps lends nothing and the session goes on as it always did (L8)', needPerl, async () => {
  const home = tempDir();
  const s = slotWorld(CABLE, { listFails: true });
  savePhone();
  try {
    const out = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(out.ok, undefined, out.error);
    assert.match(stepOf(out, 'slot').found, /could not list the phone's apps/);
    assert.deepEqual(stepOf(out, 'slot').slot, { checked: false });
    assert.equal(out.slot, undefined);
    assert.equal(s.installed, 0);
    assert.deepEqual(s.sideload, []);
    assert.equal(createdSessions(), 1);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a live device session skips the slot step: no listing at all', needPerl, async () => {
  const home = tempDir();
  const s = slotWorld(CABLE, { apps: [`${BUNDLE}.xctrunner`] });
  savePhone();
  try {
    const first = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(first.ok, undefined, first.error);
    const before = calls.filter(c => c.includes('apps')).length;
    const again = await withSignLock({ home }, () => lab.up(['--target', 'device']));
    assert.equal(again.ok, undefined, again.error);
    assert.equal(stepOf(again, 'slot'), undefined);
    assert.equal(calls.filter(c => c.includes('apps')).length, before);
    assert.deepEqual(s.sideload, []);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a simulator run gives a stale borrowed slot back when nothing else would (a reported step, never a failure of `up`)', async () => {
  const s = slotWorld(CABLE, { apps: [`${BUNDLE}.xctrunner`], answers: [{ ok: true, command: 'slot', action: 'return', reinstalled: true, app: 'stremio-ios' }] });
  savePhone();
  saveState({ slotLend: lentRecord(s) });
  try {
    const out = await lab.up(['--target', 'simulator']);
    assert.equal(out.ok, undefined, out.error);
    assert.deepEqual(stepNames(out), ['lease', 'prerequisites', 'appium', 'slot', 'simulator', 'session']);
    assert.match(stepOf(out, 'slot').did, /^gave it back/);
    assert.equal(out.slotReturned, true);
    assert.deepEqual(out.slot, { returned: true, app: 'stremio-ios', reinstalled: true });
    assert.deepEqual(s.sideload, [['slot', 'return', '--udid', PHONE]]);
    assert.equal(s.apps.has(`${BUNDLE}.xctrunner`), false, 'the runner came off the phone first');
    assert.equal(loadState().slotLend, undefined);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a simulator run leaves a borrowed slot to the idle stop when it is installed and loaded, unless the return had started', async () => {
  const s = slotWorld(CABLE, { apps: [`${BUNDLE}.xctrunner`], answers: [{ ok: true, command: 'slot', action: 'return', alreadyPresent: true }] });
  savePhone();
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.idlePlistPath(), '<plist/>');
  saveState({ slotLend: lentRecord(s) });
  try {
    const held = await lab.up(['--target', 'simulator']);
    assert.equal(held.ok, undefined, held.error);
    assert.equal(stepOf(held, 'slot'), undefined);
    assert.deepEqual(s.sideload, []);
    assert.equal(loadState().slotLend.phase, 'lent');
    await lab.down(['--keep-service']);
    saveState({ slotLend: lentRecord(s, { phase: 'returning' }) });
    const returning = await lab.up(['--target', 'simulator']);
    assert.equal(returning.ok, undefined, returning.error);
    assert.equal(stepOf(returning, 'slot').found, 'a slot borrowed from sideload (stremio-ios)');
    assert.equal(returning.slotReturned, true);
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});

test('a simulator run that cannot give the slot back says so in `human` and goes on', async () => {
  const s = slotWorld(CABLE, { apps: [`${BUNDLE}.xctrunner`], locked: true });
  savePhone();
  saveState({ slotLend: lentRecord(s) });
  try {
    const out = await lab.up(['--target', 'simulator']);
    assert.equal(out.ok, undefined, out.error);
    assert.equal(out.slotReturned, false);
    assert.match(out.human.join(' '), /phone is locked/);
    assert.match(stepOf(out, 'slot').found, /not given back/);
    assert.equal(loadState().slotLend.phase, 'lent');
  } finally { delete process.env.MSL_SIDELOAD_BIN; }
});
