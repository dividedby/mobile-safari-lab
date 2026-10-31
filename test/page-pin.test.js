// The msl-page-pin Appium plugin, against a fake xcuitest driver and remote debugger (Appium is not needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PagePinPlugin, arm, verify, parseContext, pinnedPageChange, PIN, EVENT } from '../appium-plugin/index.js';
import { PAGE_PIN, PLUGIN, pluginDir } from '../lib/appium.js';

// What the stock driver does with a listing, reduced to the part that matters: any new page wins.
async function stockPageChange(n) {
  const [app] = this.curContext.split('.');
  if (app !== n.appIdKey) return;
  const fresh = n.pageArray.map(p => String(p.id)).filter(id => !this.contexts.includes(`${n.appIdKey}.${id}`));
  if (!fresh.length) return;
  this.contexts.push(...fresh.map(id => `${n.appIdKey}.${id}`));
  this.curContext = `${n.appIdKey}.${fresh.at(-1)}`;
  await this._remote.selectPage(n.appIdKey, Number(fresh.at(-1)));
}

// A driver sitting in page 3 of app A, its remote debugger holding it, the stock listener bound first.
function fake({ real = true, curContext = 'A.3' } = {}) {
  const logs = [];
  const calls = { select: [], execute: [] };
  const remote = new EventEmitter();
  Object.assign(remote, {
    _appIdKey: 'PID:A', _pageIdKey: 3,
    async selectPage(app, page) { calls.select.push([app, page]); this._appIdKey = `PID:${app}`; this._pageIdKey = page; },
    async execute(script) { calls.execute.push([this._appIdKey, this._pageIdKey, script]); return 'ran'; },
  });
  const driver = {
    curContext, contexts: ['NATIVE_APP', 'A.3'], _remote: remote, onPageChange: stockPageChange,
    isRealDevice: () => real,
    log: { info: m => logs.push(m), warn: m => logs.push(m) },
  };
  remote.on(EVENT, driver.onPageChange.bind(driver));
  return { driver, remote, calls, logs };
}
const listing = (...ids) => ({ appIdKey: 'A', pageArray: ids.map(id => ({ id, url: 'https://private.test/secret', title: 'Private' })) });

test('the stand-in for the stock driver does follow a new page (the model the pin is tested against)', async () => {
  const { driver, remote, calls } = fake();
  remote.emit(EVENT, listing(3, 4));
  await new Promise(r => setImmediate(r));
  assert.equal(driver.curContext, 'A.4');
  assert.deepEqual(calls.select, [['A', 4]]);
});

test('the plugin\'s PIN is the marker the lab requires (lib/appium.js PAGE_PIN)', () => {
  assert.equal(PIN, PAGE_PIN);
  assert.equal(PIN, 1);
});

test('the plugin folder is what the lab links', () => {
  const manifest = JSON.parse(fs.readFileSync(`${pluginDir()}/package.json`, 'utf8'));
  assert.equal(manifest.appium.pluginName, PLUGIN);
  assert.equal(manifest.name, PLUGIN);
  assert.equal(manifest.appium.mainClass, 'PagePinPlugin');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.dependencies, undefined, 'no dependencies');
  assert.ok(!/^\s*import\b/m.test(fs.readFileSync(`${pluginDir()}/index.js`, 'utf8')), 'the plugin imports nothing, Appium included');
});

test('parseContext reads the driver\'s "app.page" ids and the client\'s WEBVIEW_ names, and nothing else', () => {
  assert.deepEqual(parseContext('9.1'), { app: '9', page: 1 });
  assert.deepEqual(parseContext('WEBVIEW_9.1'), { app: '9', page: 1 });
  assert.deepEqual(parseContext('WEBVIEW_PID:9.12'), { app: '9', page: 12 });
  for (const bad of ['NATIVE_APP', 'WEBVIEW', 'WEBVIEW_9', '9.', '.1', '9.x', null, undefined, 7]) assert.equal(parseContext(bad), null, String(bad));
});

test('after arm, a new page leaves the context, the held page and selectPage alone; the stock listener is gone', async () => {
  const { driver, remote, calls, logs } = fake();
  assert.equal(arm(driver), true);
  assert.equal(remote.listenerCount(EVENT), 1);
  remote.emit(EVENT, listing(3, 4));
  await new Promise(r => setImmediate(r));
  assert.equal(driver.curContext, 'A.3');
  assert.equal(remote._pageIdKey, 3);
  assert.deepEqual(calls.select, []);
  assert.deepEqual(logs, ['msl-page-pin: listing changed (2 pages); not following']);
  assert.ok(!JSON.stringify(logs).match(/private|secret|Private/), 'no address or title in the log');
});

test('a listing without the selected page takes the session native; a listing of another app, or one made in native, does nothing', () => {
  const { driver, remote, logs } = fake();
  arm(driver);
  remote.emit(EVENT, { appIdKey: 'B', pageArray: [{ id: 1 }] });
  assert.equal(driver.curContext, 'A.3');
  remote.emit(EVENT, listing(5, 6));
  assert.equal(driver.curContext, null);
  assert.match(logs.at(-1), /^msl-page-pin: the selected page 3 went \(2 pages left\); the session is native$/);
  const n = logs.length;
  remote.emit(EVENT, listing(5, 6, 7)); // native now: nothing is attached, nothing to follow
  assert.equal(driver.curContext, null);
  assert.equal(logs.length, n);
  const { driver: d2, remote: r2 } = fake({ curContext: null });
  arm(d2);
  r2.emit(EVENT, listing(8));
  assert.equal(d2.curContext, null);
});

test('a reconnect binds the pinned handler (it is the driver\'s own property), and ensureArmed wraps the new remote', async () => {
  const { driver, remote } = fake();
  arm(driver);
  const next = new EventEmitter();
  Object.assign(next, { _appIdKey: 'PID:A', _pageIdKey: 3, selectPage: async () => {}, execute: async () => 'ran' });
  driver._remote = next;
  next.on(EVENT, driver.onPageChange.bind(driver)); // what connectToRemoteDebugger does
  next.emit(EVENT, listing(3, 4));
  assert.equal(driver.curContext, 'A.3', 'pinned from the first listing');
  assert.equal(verify(driver), false, 'the new remote is not wrapped yet');
  const plugin = new PagePinPlugin('msl-page-pin');
  await plugin.execute(async () => 'ok', driver, 'return 1');
  assert.equal(verify(driver), true);
  assert.equal(next.selectPage !== remote.selectPage, true);
  await assert.rejects(next.selectPage('A', 4), /^Error: msl-page-pin: /);
});

test('selectPage runs only for the page a setContext being handled asked for', async () => {
  const { driver, remote, calls, logs } = fake();
  arm(driver);
  await assert.rejects(remote.selectPage('A', 4), /^Error: msl-page-pin: Appium tried to select a page the lab did not ask for$/);
  assert.deepEqual(calls.select, [], 'the driver\'s own selectPage was not reached');
  assert.match(logs.at(-1), /^msl-page-pin: selectPage refused page=4$/);
  const plugin = new PagePinPlugin('msl-page-pin');
  await plugin.setContext(async () => {
    await assert.rejects(remote.selectPage('A', 5), /msl-page-pin:/); // not the page asked for
    await remote.selectPage('A', 4);
    driver.curContext = 'A.4';
  }, driver, 'WEBVIEW_A.4');
  assert.deepEqual(calls.select, [['A', 4]]);
  await assert.rejects(remote.selectPage('A', 4), /msl-page-pin:/, 'the permission ends with the command');
});

test('execute is refused unless the page the driver holds is the client\'s selection, checked in the tick it is called', async () => {
  const { driver, remote, calls, logs } = fake();
  arm(driver);
  assert.equal(await remote.execute('1'), 'ran');
  assert.match(logs.at(-1), /^msl-page-pin: evaluate page=3$/);
  remote._pageIdKey = 4; // something moved the held page
  await assert.rejects(remote.execute('2'), /^Error: msl-page-pin: the session is not on the selected page$/);
  assert.equal(calls.execute.length, 1, 'the original never ran');
  assert.match(logs.at(-1), /^msl-page-pin: evaluate refused page=4$/);
  // The refusal is synchronous with the call: a page change right after it cannot make it run.
  remote._pageIdKey = 3;
  const run = remote.execute('3');
  remote._pageIdKey = 4;
  assert.equal(await run, 'ran');
  assert.deepEqual(calls.execute.at(-1), ['PID:A', 3, '3'], 'it took the ids at the call');
  // A selection the client made is what counts from then on.
  const plugin = new PagePinPlugin('msl-page-pin');
  remote._pageIdKey = 4;
  await plugin.setContext(async () => { await remote.selectPage('A', 4); driver.curContext = 'A.4'; }, driver, 'WEBVIEW_A.4');
  assert.equal(await remote.execute('4'), 'ran');
  await plugin.setContext(async () => { driver.curContext = null; }, driver, 'NATIVE_APP');
  await assert.rejects(remote.execute('5'), /msl-page-pin:/, 'native: nothing is selected');
  assert.ok(!JSON.stringify(logs).includes('return'), 'no script text in the log');
});

test('async scripts are refused on a pinned session and pass on any other', async () => {
  const { driver } = fake();
  const plugin = new PagePinPlugin('msl-page-pin');
  assert.equal(await plugin.executeAsync(async () => 'ok', driver), 'ok');
  arm(driver);
  await assert.rejects(plugin.executeAsync(async () => 'ok', driver), /^Error: msl-page-pin: async scripts are refused/);
});

test('createSession adds the marker for a real device that verifies, and for nothing else', async () => {
  const plugin = new PagePinPlugin('msl-page-pin');
  const created = (id = 'S1') => ({ protocol: 'W3C', value: [id, { browserName: 'Safari' }, 'W3C'] });
  const run = async (d, res = created()) => {
    const out = await plugin.createSession(async () => res, { sessions: d ? { S1: d } : {} });
    return out;
  };
  let { driver, logs } = fake();
  let out = await run(driver);
  assert.equal(out.value[1]['msl:pagePin'], 1);
  assert.equal(verify(driver), true);
  assert.deepEqual(logs, ['msl-page-pin: armed session=S1']);
  // A simulator: untouched.
  ({ driver } = fake({ real: false }));
  out = await run(driver);
  assert.equal(out.value[1]['msl:pagePin'], undefined);
  assert.equal(driver.onPageChange, stockPageChange);
  // A driver whose internals are not as expected: no marker (the lab refuses the session).
  ({ driver } = fake());
  delete driver._remote;
  out = await run(driver);
  assert.equal(out.value[1]['msl:pagePin'], undefined);
  ({ driver } = fake());
  driver._remote.selectPage = undefined;
  out = await run(driver);
  assert.equal(out.value[1]['msl:pagePin'], undefined);
  // An extra listener on the remote debugger that arm can't account for does not survive arm; the count is checked after.
  ({ driver } = fake());
  driver._remote.on(EVENT, () => {});
  out = await run(driver);
  assert.equal(out.value[1]['msl:pagePin'], 1);
  assert.equal(driver._remote.listenerCount(EVENT), 1);
  // A failed create passes through, and so does a session the umbrella doesn't know.
  const failed = { protocol: 'W3C', error: new Error('no') };
  assert.equal(await run(driver, failed), failed);
  assert.equal((await run(null)).value[1]['msl:pagePin'], undefined);
});

test('commands on a session that was never pinned pass through untouched', async () => {
  const { driver } = fake({ real: false });
  const plugin = new PagePinPlugin('msl-page-pin');
  assert.equal(await plugin.setContext(async () => 'set', driver, 'WEBVIEW_A.4'), 'set');
  assert.equal(await plugin.execute(async () => 'ok', driver, 'return 1'), 'ok');
  assert.equal(driver.onPageChange, stockPageChange);
});

test('a pinned session whose pin cannot be put back after a reconnect refuses the command', async () => {
  const { driver } = fake();
  arm(driver);
  driver._remote = Object.assign(new EventEmitter(), { _appIdKey: 'PID:A', _pageIdKey: 3 }); // no selectPage / execute to wrap
  const plugin = new PagePinPlugin('msl-page-pin');
  await assert.rejects(plugin.execute(async () => 'ok', driver, 'return 1'), /^Error: msl-page-pin: the page pin could not be put back/);
  await assert.rejects(plugin.setContext(async () => 'set', driver, 'WEBVIEW_A.3'), /msl-page-pin:/);
  assert.equal(await plugin.execute(async () => 'native', driver, 'mobile: tap'), 'native', 'a native call needs no page');
});

test('the pinned handler is the one function arm installs', () => {
  const { driver } = fake();
  arm(driver);
  assert.equal(driver.onPageChange, pinnedPageChange);
});
