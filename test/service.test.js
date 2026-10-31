import { test, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, linkPlugin, fakeRunner, standin, CURRENT_RULES } from './helpers.js';
import { loadState, saveState } from '../lib/core.js';
import * as svc from '../lib/service.js';
import { INSTALL_HINT, LOG_FILTERS } from '../lib/appium.js';
import { handlers as safari, appiumEndpoint, ensureAppium, selfStartArgs } from '../lib/safari.js';

const U = '6A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
const UID = process.getuid();
const TARGET = `gui/${UID}/com.dividedby.msl-appium`;

let app, home, dir;

before(async () => {
  app = standin();
  await app.listen();
  svc.SERVICE.port = app.port; // the stand-in plays the service's port
  svc.setPlatform('darwin');
});
after(async () => { await app.close(); });

beforeEach(() => {
  dir = sandbox();
  delete process.env.MSL_APPIUM_URL;
  // A fake Appium install: package.json with a bin, and the script it points at.
  home = path.join(dir, 'appium-home');
  process.env.MSL_APPIUM_HOME = home;
  linkPlugin(home);
  const pkg = path.join(home, 'node_modules', 'appium');
  fs.mkdirSync(path.join(pkg, 'build', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'appium', bin: { appium: 'index.js' } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), '');
  Object.assign(svc.WAIT, { statusMs: 500, pollMs: 10, serviceMs: 1500, kickMs: 400, portFreeMs: 500 });
  app.fx.up = true;
  app.fx.sessions.clear();
  app.fx.created = 0;
  app.log.length = 0;
  svc.setKill(() => {});
});
afterEach(() => { svc.setPlatform('darwin'); });

// A pretend launchd + xcode-select + lsof: `world.loaded` and the stand-in's `up` change as
// launchctl is told to bootstrap or bootout.
function world({ loaded = false, up = false, state = 'running', pid = 4242, lsof = '', command = '' } = {}) {
  const w = { loaded, kills: [] };
  app.fx.up = up;
  w.calls = fakeRunner((cmd, args) => {
    if (cmd === 'xcode-select') return { stdout: '/Applications/Xcode.app/Contents/Developer\n' };
    if (cmd === 'lsof') return { stdout: lsof };
    if (cmd === 'ps' && !args.includes('etime=')) return { stdout: command };
    if (cmd !== 'launchctl') return undefined;
    switch (args[0]) {
      case 'print':
        return w.loaded ? { stdout: `${TARGET} = {\n\tstate = ${state}\n\tpid = ${pid}\n}\n` } : { code: 113, stderr: 'Could not find service' };
      case 'bootstrap': w.loaded = true; setTimeout(() => { app.fx.up = true; }, 30); return undefined;
      case 'bootout': w.loaded = false; app.fx.up = false; return undefined;
      default: return undefined;
    }
  });
  svc.setKill((p, sig) => { w.kills.push([p, sig]); app.fx.up = false; });
  return w;
}
const verbs = calls => calls.filter(c => c[0] === 'launchctl').map(c => c[1]);

// --- the plist ---

const SPEC = {
  node: '/opt/homebrew/bin/node', main: '/h/node_modules/appium/index.js', home: '/h', port: 4723,
  log: '/L/msl-appium.log', filters: '/S/appium-log-filters.json', developerDir: '/Applications/Xcode.app/Contents/Developer', path: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
};

test('buildPlist runs at log level info by default, or debug, always with the log filters, and refuses any other level', () => {
  const args = xml => [...xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*)<\/string>/g)].map(m => m[1]).slice(-6, -2);
  assert.deepEqual(args(svc.buildPlist(SPEC)), ['--log-level', 'info', '--log-filters', '/S/appium-log-filters.json']);
  assert.deepEqual(args(svc.buildPlist({ ...SPEC, logLevel: 'debug' })), ['--log-level', 'debug', '--log-filters', '/S/appium-log-filters.json']);
  for (const bad of ['warn', 'INFO', '', 'info --log-filters x']) assert.throws(() => svc.buildPlist({ ...SPEC, logLevel: bad }), /--log-level must be info or debug/);
});

test('buildPlist holds exactly the keys the service needs', () => {
  const xml = svc.buildPlist(SPEC);
  const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1]);
  assert.deepEqual(keys, ['Label', 'ProgramArguments', 'WorkingDirectory', 'EnvironmentVariables', 'APPIUM_HOME', 'DEVELOPER_DIR', 'PATH', 'RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'StandardOutPath', 'StandardErrorPath']);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC/);
  const args = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  assert.deepEqual([...args.matchAll(/<string>(.*)<\/string>/g)].map(m => m[1]), ['/opt/homebrew/bin/node', '/h/node_modules/appium/index.js', '--address', '127.0.0.1', '--port', '4723', '--log-level', 'info', '--log-filters', '/S/appium-log-filters.json', '--use-plugins', 'msl-page-pin']);
  const value = k => xml.match(new RegExp(`<key>${k}</key>\\s*<string>(.*)</string>`))[1];
  assert.equal(value('Label'), 'com.dividedby.msl-appium');
  assert.equal(value('WorkingDirectory'), '/h');
  assert.equal(value('APPIUM_HOME'), '/h');
  assert.equal(value('DEVELOPER_DIR'), '/Applications/Xcode.app/Contents/Developer');
  assert.equal(value('PATH'), '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin');
  assert.equal(value('StandardOutPath'), '/L/msl-appium.log');
  assert.equal(value('StandardErrorPath'), '/L/msl-appium.log');
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
});

test('buildPlist escapes XML and never turns on the insecure Appium features', () => {
  const xml = svc.buildPlist({ ...SPEC, home: '/a&b/<c>', log: '/x&y.log' });
  assert.ok(xml.includes('/a&amp;b/&lt;c&gt;'));
  assert.ok(xml.includes('/x&amp;y.log'));
  assert.ok(!/relaxed|insecure/i.test(xml));
  assert.ok(!/relaxed|insecure/i.test(fs.readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')));
});

test('the plist passes plutil -lint where plutil exists', { skip: process.platform !== 'darwin' }, () => {
  const f = path.join(dir, 'x.plist');
  fs.writeFileSync(f, svc.buildPlist({ ...SPEC, home: '/a&b' }));
  const r = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('appiumMain follows package.json bin through the symlinks, and says how to install when it is missing', () => {
  assert.equal(svc.appiumMain(), path.join(home, 'node_modules', 'appium', 'index.js'));
  const pkg = path.join(home, 'node_modules', 'appium', 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ bin: 'index.js' }));
  assert.equal(svc.appiumMain(), path.join(home, 'node_modules', 'appium', 'index.js'));
  fs.writeFileSync(pkg, JSON.stringify({ bin: { appium: 'gone.js' } }));
  assert.throws(() => svc.appiumMain(), err => err.message === INSTALL_HINT);
  process.env.MSL_APPIUM_HOME = path.join(dir, 'nothing');
  assert.throws(() => svc.appiumMain(), err => err.message === INSTALL_HINT);
});

// --- which node ---

test('chooseNode prefers a stable symlink over the versioned Cellar path', () => {
  const real = path.join(dir, 'Cellar', 'node', '25.1.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(real, path.join(bin, 'node'));
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'node'), 'a different node');

  const choose = o => svc.chooseNode({ execPath: real, preferred: path.join(dir, 'nowhere', 'node'), ...o });
  // the preferred path wins when it leads to the running node
  assert.equal(choose({ preferred: path.join(bin, 'node'), pathEnv: '' }), path.join(bin, 'node'));
  // otherwise the first PATH symlink that leads to it (a different node, or a non-link, is skipped)
  assert.equal(choose({ pathEnv: [other, bin].join(path.delimiter) }), path.join(bin, 'node'));
  // a symlink that itself lives in a Cellar directory is not stable
  const cellarBin = path.join(dir, 'Cellar', 'node', '25.1.0', 'bin');
  assert.equal(choose({ pathEnv: cellarBin }), fs.realpathSync(real));
  // nothing stable: the running node, resolved
  assert.equal(choose({ pathEnv: other }), fs.realpathSync(real));
});

// --- install and uninstall ---

test('install writes the plist, then enable and bootstrap in gui/<uid>, and waits for Appium', async () => {
  const w = world();
  const out = await svc.install({ node: '/opt/homebrew/bin/node' });
  assert.equal(out.installed, true);
  assert.equal(out.node, '/opt/homebrew/bin/node');
  assert.equal(out.pid, 4242);
  assert.equal(out.port, app.port);
  assert.equal(out.plist, path.join(dir, 'LaunchAgents', 'com.dividedby.msl-appium.plist'));
  assert.equal(out.replaced, undefined);
  assert.deepEqual(verbs(w.calls), ['print', 'print', 'enable', 'bootstrap', 'print']);
  assert.deepEqual(w.calls.find(c => c[1] === 'enable'), ['launchctl', 'enable', TARGET]);
  assert.deepEqual(w.calls.find(c => c[1] === 'bootstrap'), ['launchctl', 'bootstrap', `gui/${UID}`, out.plist]);
  assert.ok(w.calls.some(c => c[0] === 'xcode-select' && c[1] === '-p'));
  const xml = fs.readFileSync(out.plist, 'utf8');
  assert.ok(xml.includes(path.join(home, 'node_modules', 'appium', 'index.js')));
  assert.ok(xml.includes('<string>/Applications/Xcode.app/Contents/Developer</string>'));
  assert.ok(xml.includes(path.join(dir, 'Logs', 'msl-appium.log')));
  assert.ok(xml.includes(`<string>${app.port}</string>`));
  assert.equal(fs.statSync(out.plist).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(path.dirname(out.plist)), ['com.dividedby.msl-appium.plist']); // no temp file
});

test('install writes the log-filter rules into the lab\'s state dir and starts Appium with them', async () => {
  world();
  const out = await svc.install({ node: '/opt/homebrew/bin/node' });
  const file = svc.logFiltersPath();
  assert.equal(file, path.join(dir, 'state', 'appium-log-filters.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), LOG_FILTERS);
  assert.equal(fs.readFileSync(file, 'utf8'), CURRENT_RULES); // the text that `status` compares against
  assert.ok(svc.logFiltersCurrent());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
  const xml = fs.readFileSync(out.plist, 'utf8');
  const args = [...xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(args.slice(-6), ['--log-level', 'info', '--log-filters', file, '--use-plugins', 'msl-page-pin']);
});

test('install --log-level debug writes a debug plist that keeps the log filters, and a bad level touches nothing', async () => {
  const w = world();
  const out = await svc.install({ node: '/opt/homebrew/bin/node', logLevel: 'debug' });
  assert.equal(out.logLevel, 'debug');
  const xml = fs.readFileSync(out.plist, 'utf8');
  const args = [...xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(args.slice(-6), ['--log-level', 'debug', '--log-filters', svc.logFiltersPath(), '--use-plugins', 'msl-page-pin']);
  assert.ok(fs.existsSync(svc.logFiltersPath()));
  assert.equal((await svc.install({ node: '/opt/homebrew/bin/node' })).logLevel, 'info'); // back to normal
  assert.match(fs.readFileSync(out.plist, 'utf8'), /<string>--log-level<\/string>\s*<string>info<\/string>/);

  fs.rmSync(svc.plistPath());
  w.calls.length = 0;
  await assert.rejects(svc.install({ node: '/n', logLevel: 'trace' }), /--log-level must be info or debug, not "trace"/);
  assert.ok(!fs.existsSync(svc.plistPath()));
  assert.deepEqual(w.calls, []);
});

test('install again unloads the loaded service before loading the new plist', async () => {
  const w = world({ loaded: true, up: true });
  await svc.install({ node: '/opt/homebrew/bin/node' });
  const v = verbs(w.calls);
  assert.ok(v.indexOf('bootout') < v.indexOf('enable') && v.indexOf('enable') < v.indexOf('bootstrap'), v.join());
  assert.deepEqual(w.calls.find(c => c[1] === 'bootout'), ['launchctl', 'bootout', TARGET]);
  assert.equal(w.kills.length, 0); // our own service is not a stray Appium
});

test('install refuses to run over a manual Appium unless --replace, which ends only that process', async () => {
  const w = world({ up: true, lsof: '4321\n', command: '/usr/local/bin/node /home/x/node_modules/.bin/appium --port 4723\n' });
  await assert.rejects(svc.install({ node: '/n' }), /an Appium is already on 127\.0\.0\.1:\d+ \(pid 4321\); stop it or pass --replace \(its session will be lost\)/);
  assert.deepEqual(w.kills, []);
  assert.ok(!fs.existsSync(svc.plistPath()));
  assert.ok(!verbs(w.calls).includes('bootstrap'));
  assert.deepEqual(w.calls.find(c => c[0] === 'lsof'), ['lsof', '-nP', `-iTCP:${app.port}`, '-sTCP:LISTEN', '-t']);
  assert.deepEqual(w.calls.find(c => c[0] === 'ps'), ['ps', '-o', 'command=', '-p', '4321']);

  const out = await svc.install({ replace: true, node: '/n' });
  assert.deepEqual(w.kills, [[4321, 'SIGTERM']]);
  assert.equal(out.replaced, 4321);
  assert.ok(verbs(w.calls).includes('bootstrap'));
});

test('install will not kill a process on the port that is not Appium', async () => {
  const w = world({ up: true, lsof: '99\n', command: '/usr/bin/python3 -m http.server\n' });
  await assert.rejects(svc.install({ replace: true, node: '/n' }), /isn't Appium \(pid 99\)/);
  assert.deepEqual(w.kills, []);
});

test('the ps calls for a stray Appium and for stopProcess carry their exact arguments and no timeout', async () => {
  const w = world({ up: true, lsof: '99\n', command: '/usr/bin/python3 -m http.server\n' });
  await assert.rejects(svc.install({ replace: true, node: '/n' }), /isn't Appium \(pid 99\)/);
  const at = w.calls.findIndex(c => c[0] === 'ps');
  assert.deepEqual(w.calls[at], ['ps', '-o', 'command=', '-p', '99']);
  assert.equal(w.calls.opts[at].timeoutMs, undefined);

  w.calls.length = 0;
  w.calls.opts.length = 0;
  await svc.stopProcess(99, /nothing-matches/);
  assert.deepEqual(w.calls, [['ps', '-o', 'command=', '-p', '99']]);
  assert.equal(w.calls.opts[0].timeoutMs, undefined);
});

test('install gives up with the log path when Appium never answers', async () => {
  const w = world();
  svc.WAIT.serviceMs = 150;
  w.calls.length = 0;
  fakeRunner((cmd, args) => (cmd === 'xcode-select' ? { stdout: '/X\n' } : cmd === 'launchctl' && args[0] === 'print' ? { code: 113 } : undefined));
  await assert.rejects(svc.install({ node: '/n' }), err => err.message.includes("didn't answer") && err.message.includes(path.join(dir, 'Logs', 'msl-appium.log')));
});

test('install needs macOS, an Appium install and an Xcode path, before touching anything', async () => {
  const w = world();
  svc.setPlatform('linux');
  await assert.rejects(svc.install({ node: '/n' }), /needs macOS/);
  svc.setPlatform('darwin');
  fs.rmSync(path.join(home, 'node_modules'), { recursive: true });
  await assert.rejects(svc.install({ node: '/n' }), err => err.message === INSTALL_HINT);
  assert.equal(w.calls.length, 0);
  assert.ok(!fs.existsSync(svc.agentsDir()));
});

test('uninstall boots the service out, removes the plist, and tolerates "not found"', async () => {
  const w = world({ loaded: true, up: true });
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.plistPath(), 'x');
  const out = await svc.uninstall();
  assert.deepEqual(out, { uninstalled: true, wasInstalled: true, wasLoaded: true });
  assert.ok(!fs.existsSync(svc.plistPath()));
  assert.deepEqual(w.calls.find(c => c[1] === 'bootout'), ['launchctl', 'bootout', TARGET]);

  fakeRunner((_c, a) => (a[0] === 'print' || a[0] === 'bootout' ? { code: 113, stderr: 'Could not find service' } : undefined));
  assert.deepEqual(await svc.uninstall(), { uninstalled: true, wasInstalled: false, wasLoaded: false });
  assert.ok(fs.existsSync(home)); // the Appium install is never touched
});

// --- the idle stop agent ---

const IDLE_TARGET = `gui/${UID}/com.dividedby.msl-idle`;
const IDLE_SPEC = { node: '/opt/homebrew/bin/node', lab: '/repo/bin/lab', developerDir: '/Applications/Xcode.app/Contents/Developer', path: '/opt/homebrew/bin:/usr/bin', log: '/L/msl-idle.log' };

// A pretend launchd for the idle stop's label only; the Appium service is never loaded here.
function idleWorld({ loaded = false, stuck = false } = {}) {
  const w = { loaded };
  w.calls = fakeRunner((cmd, args) => {
    if (cmd === 'xcode-select') return { stdout: '/Applications/Xcode.app/Contents/Developer\n' };
    if (cmd !== 'launchctl') return undefined;
    if (args[0] === 'print') return w.loaded ? { stdout: `${IDLE_TARGET} = {\n\tstate = not running\n}\n` } : { code: 113, stderr: 'Could not find service' };
    if (args[0] === 'bootout') { if (!stuck) w.loaded = false; return undefined; }
    if (args[0] === 'bootstrap') { w.loaded = true; return undefined; }
    return undefined;
  });
  return w;
}
const labFile = () => { const f = path.join(dir, 'bin-lab'); fs.writeFileSync(f, ''); return f; };

test('buildIdlePlist runs `lab down --idle` every 300 s, with no KeepAlive, no RunAtLoad and no port', () => {
  const xml = svc.buildIdlePlist({ ...IDLE_SPEC, env: { MSL_STATE: '/S' } });
  const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1]);
  assert.deepEqual(keys, ['Label', 'ProgramArguments', 'WorkingDirectory', 'EnvironmentVariables', 'DEVELOPER_DIR', 'PATH', 'MSL_STATE', 'RunAtLoad', 'StartInterval', 'StandardOutPath', 'StandardErrorPath']);
  assert.ok(!/KeepAlive|ThrottleInterval|Sockets/.test(xml));
  const args = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  assert.deepEqual([...args.matchAll(/<string>(.*)<\/string>/g)].map(m => m[1]), ['/opt/homebrew/bin/node', '/repo/bin/lab', 'down', '--idle']);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.dividedby\.msl-idle<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/L\/msl-idle\.log<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo<\/string>/);
  assert.match(xml, /<key>MSL_STATE<\/key>\s*<string>\/S<\/string>/);
});

test('the idle plist passes plutil -lint where plutil exists', { skip: process.platform !== 'darwin' }, () => {
  const f = path.join(dir, 'idle.plist');
  fs.writeFileSync(f, svc.buildIdlePlist({ ...IDLE_SPEC, log: '/a&b/<c>.log' }));
  const r = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('installIdle writes the plist (0644, no temp file), then enable and bootstrap in gui/<uid>, and carries the lab\'s settings', async () => {
  const w = idleWorld();
  const saved = { m: process.env.MSL_IDLE_MINUTES, o: process.env.MSL_OWNER };
  process.env.MSL_IDLE_MINUTES = '20';
  process.env.MSL_OWNER = 'not-passed-on';
  try {
    const out = await svc.installIdle({ node: '/opt/homebrew/bin/node', lab: labFile() });
    assert.equal(out.installed, true);
    assert.equal(out.plist, path.join(dir, 'LaunchAgents', 'com.dividedby.msl-idle.plist'));
    assert.equal(out.intervalSeconds, 300);
    assert.deepEqual(verbs(w.calls).filter(v => v !== 'print'), ['enable', 'bootstrap']);
    assert.deepEqual(w.calls.find(c => c[1] === 'enable'), ['launchctl', 'enable', IDLE_TARGET]);
    assert.deepEqual(w.calls.find(c => c[1] === 'bootstrap'), ['launchctl', 'bootstrap', `gui/${UID}`, out.plist]);
    const xml = fs.readFileSync(out.plist, 'utf8');
    assert.match(xml, /<key>MSL_STATE<\/key>\s*<string>[^<]*state<\/string>/);
    assert.match(xml, /<key>MSL_IDLE_MINUTES<\/key>\s*<string>20<\/string>/);
    assert.ok(!xml.includes('MSL_OWNER') && !xml.includes('MSL_APPIUM_URL'));
    assert.equal(fs.statSync(out.plist).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(path.dirname(out.plist)), ['com.dividedby.msl-idle.plist']);
    assert.ok(!w.calls.some(c => c.join(' ').includes('com.dividedby.msl-appium')), 'the Appium service is not touched');
  } finally {
    if (saved.m === undefined) delete process.env.MSL_IDLE_MINUTES; else process.env.MSL_IDLE_MINUTES = saved.m;
    if (saved.o === undefined) delete process.env.MSL_OWNER; else process.env.MSL_OWNER = saved.o;
  }
});

test('installIdle carries MSL_SIDELOAD_BIN and SIDELOAD_HOME, so the idle stop can give a borrowed slot back (#63)', async () => {
  idleWorld();
  const saved = { b: process.env.MSL_SIDELOAD_BIN, h: process.env.SIDELOAD_HOME };
  process.env.MSL_SIDELOAD_BIN = '/opt/homebrew/bin/sideload';
  process.env.SIDELOAD_HOME = '/Users/me/.sideload-test';
  try {
    const out = await svc.installIdle({ node: '/opt/homebrew/bin/node', lab: labFile() });
    const xml = fs.readFileSync(out.plist, 'utf8');
    assert.match(xml, /<key>MSL_SIDELOAD_BIN<\/key>\s*<string>\/opt\/homebrew\/bin\/sideload<\/string>/);
    assert.match(xml, /<key>SIDELOAD_HOME<\/key>\s*<string>\/Users\/me\/\.sideload-test<\/string>/);
  } finally {
    for (const [k, v] of [['MSL_SIDELOAD_BIN', saved.b], ['SIDELOAD_HOME', saved.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('installIdle boots a loaded one out first, and refuses off macOS, without bin/lab, or when launchd keeps the old one', async () => {
  const w = idleWorld({ loaded: true });
  await svc.installIdle({ node: '/n', lab: labFile() });
  const v = verbs(w.calls).filter(x => x !== 'print');
  assert.deepEqual(v, ['bootout', 'enable', 'bootstrap']);

  await assert.rejects(svc.installIdle({ node: '/n', lab: path.join(dir, 'nope') }), /not found: the idle stop runs this checkout's bin\/lab/);
  svc.setPlatform('linux');
  await assert.rejects(svc.installIdle({ node: '/n', lab: labFile() }), /needs macOS/);
  svc.setPlatform('darwin');
  idleWorld({ loaded: true, stuck: true });
  await assert.rejects(svc.installIdle({ node: '/n', lab: labFile() }), /launchd did not unload the old idle stop within 10s/);
});

test('uninstallIdle boots out and removes the plist, tolerates "not found", and never touches the Appium service', async () => {
  const w = idleWorld({ loaded: true });
  await svc.installIdle({ node: '/n', lab: labFile() });
  w.calls.length = 0;
  assert.deepEqual(await svc.uninstallIdle(), { removed: true, wasLoaded: true });
  assert.ok(!fs.existsSync(svc.idlePlistPath()));
  assert.deepEqual(w.calls.filter(c => c[1] === 'bootout'), [['launchctl', 'bootout', IDLE_TARGET]]);
  assert.deepEqual(await svc.uninstallIdle(), { removed: false, wasLoaded: false });
  assert.ok(!w.calls.some(c => c.join(' ').includes('msl-appium')));
});

test('idleStatus says whether the agent is installed and loaded, and flags a node or bin/lab that is gone', async () => {
  const w = idleWorld();
  assert.deepEqual(svc.idleStatus(), { installed: false, loaded: false, intervalSeconds: 300, plist: svc.idlePlistPath(), log: path.join(dir, 'Logs', 'msl-idle.log'), node: null, lab: null, env: {}, issues: [] });
  const node = path.join(dir, 'node');
  fs.writeFileSync(node, '');
  const lab = labFile();
  await svc.installIdle({ node, lab });
  w.loaded = true;
  const ok = svc.idleStatus();
  assert.deepEqual([ok.installed, ok.loaded, ok.node, ok.lab, ok.issues], [true, true, node, lab, []]);
  fs.rmSync(lab);
  fs.rmSync(node);
  const gone = svc.idleStatus();
  assert.equal(gone.issues.length, 2);
  assert.match(gone.issues[0], /node in the idle stop's plist .* no longer exists.*lab service install/);
  assert.match(gone.issues[1], /bin\/lab in the idle stop's plist .* no longer exists \(the lab moved\?\).*lab service install/);
  w.loaded = false;
  assert.ok(svc.idleStatus().issues.some(i => /installed but not loaded/.test(i)));
});

// --- status ---

const PRINT = `gui/501/com.dividedby.msl-appium = {
\tactive count = 1
\tpath = /Users/x/Library/LaunchAgents/com.dividedby.msl-appium.plist
\tstate = running

\tprogram = /opt/homebrew/bin/node
\tpid = 8123
\tlast exit status = 0
}`;

test('status reads state and pid from launchctl print and notes the node in the plist', async () => {
  fakeRunner(cmd => (cmd === 'ps' ? undefined : { stdout: PRINT })); // (ps: the default, a service that just started)
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  const stable = path.join(dir, 'bin', 'node');
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, '');
  fs.mkdirSync(path.dirname(svc.logFiltersPath()), { recursive: true });
  fs.writeFileSync(svc.logFiltersPath(), CURRENT_RULES);
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath() }));
  const s = await svc.status();
  assert.deepEqual({ ...s, plist: undefined, log: undefined }, {
    installed: true, loaded: true, state: 'running', pid: 8123, port: app.port, reachable: true,
    plist: undefined, log: undefined, logLevel: 'info', node: stable, argsReadable: true, issues: [],
  });
  assert.equal(s.log, path.join(dir, 'Logs', 'msl-appium.log'));
});

test('status lists what is wrong: no plist, a vanished node, loaded but silent', async () => {
  fakeRunner(() => ({ code: 113 }));
  let s = await svc.status();
  assert.equal(s.installed, false);
  assert.equal(s.loaded, false);
  assert.equal(s.pid, null);
  assert.match(s.issues[0], /not installed/);

  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: '/gone/versions/node' }));
  s = await svc.status();
  assert.equal(s.node, '/gone/versions/node');
  assert.ok(s.issues.some(i => /no longer exists.*lab service install/.test(i)));
  assert.ok(s.issues.some(i => /not loaded/.test(i)));

  fakeRunner(() => ({ stdout: 'state = waiting\n' }));
  app.fx.up = false;
  s = await svc.status();
  assert.equal(s.reachable, false);
  assert.equal(s.state, 'waiting');
  assert.ok(s.issues.some(i => /nothing answers/.test(i)));
});

test('status tells an install from before the log filters to reinstall, and one whose rules file is gone', async () => {
  fakeRunner(cmd => (cmd === 'ps' ? undefined : { stdout: PRINT })); // (ps: the default, a service that just started)
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  const stable = path.join(dir, 'bin', 'node');
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, '');
  const old = svc.buildPlist({ ...SPEC, node: stable })
    .replace(/\s*<string>--log-level<\/string>\s*<string>info<\/string>\s*<string>--log-filters<\/string>\s*<string>[^<]*<\/string>/, '');
  assert.ok(!old.includes('--log-'));
  fs.writeFileSync(svc.plistPath(), old);
  let s = await svc.status();
  assert.ok(s.issues.some(i => /without log redaction \(`--log-filters`, at log level info or debug\).*lab service install/.test(i)), s.issues.join('|'));

  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath() }));
  s = await svc.status();
  assert.ok(s.issues.some(i => /rules file.*is missing.*lab service install/.test(i)), s.issues.join('|'));
  assert.ok(!s.issues.some(i => /without/.test(i)));

  fs.mkdirSync(path.dirname(svc.logFiltersPath()), { recursive: true });
  fs.writeFileSync(svc.logFiltersPath(), CURRENT_RULES);
  s = await svc.status();
  assert.deepEqual(s.issues, []);
  assert.equal(s.argsReadable, true);
  assert.equal(s.logLevel, 'info');

  // Rules from an older lab (or edited by hand) are not this lab's: reinstall.
  fs.writeFileSync(svc.logFiltersPath(), JSON.stringify(LOG_FILTERS.slice(3), null, 2) + '\n');
  s = await svc.status();
  assert.ok(s.issues.some(i => /log-filter rules are older than this lab's.*lab service install/.test(i)), s.issues.join('|'));
  assert.equal(s.issues.length, 1);
  fs.writeFileSync(svc.logFiltersPath(), CURRENT_RULES);
  assert.deepEqual((await svc.status()).issues, []);

  // Debug with the filters is fine and reported; debug (or any level) without them is not.
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath(), logLevel: 'debug' }));
  s = await svc.status();
  assert.deepEqual(s.issues, []);
  assert.equal(s.logLevel, 'debug');
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath(), logLevel: 'debug' })
    .replace(/\s*<string>--log-filters<\/string>\s*<string>[^<]*<\/string>/, ''));
  s = await svc.status();
  assert.equal(s.logLevel, 'debug');
  assert.ok(s.issues.some(i => /without log redaction \(`--log-filters`, at log level info or debug\).*lab service install/.test(i)), s.issues.join('|'));

  // A plist whose arguments can't be read: no issue of its own (the node checks say nothing either),
  // but `argsReadable` is false, which a device session refuses to start on.
  fs.writeFileSync(svc.plistPath(), 'not a plist');
  s = await svc.status();
  assert.equal(s.installed, true);
  assert.equal(s.argsReadable, false);
  assert.ok(!s.issues.some(i => /log-level|rules file/.test(i)));
  assert.equal(s.logLevel, null);
});

// --- safari start with the service installed ---

// The service as `lab service install` leaves it: the plist, and the rules file it names, current.
const installPlist = () => {
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  svc.writeLogFilters();
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, filters: svc.logFiltersPath() }));
};

test('safari start with the service installed waits for launchd instead of spawning Appium', async () => {
  installPlist();
  saveState({ udid: U, driverPid: 777 });
  app.fx.up = false;
  const calls = fakeRunner(); // launchctl print answers "loaded" with no state
  setTimeout(() => { app.fx.up = true; }, 800);
  svc.WAIT.kickMs = 5000;
  const out = await safari.start([]);
  assert.equal(out.session, 'S1');
  assert.equal(loadState().driverPid, undefined); // no stale pid for `stop` to kill
  assert.deepEqual(verbs(calls), ['print', 'print']); // the rules check reads launchd's pid, then the wait
  assert.equal(path.dirname(svc.plistPath()), process.env.MSL_LAUNCH_AGENTS);
  fs.rmSync(path.join(home, 'node_modules'), { recursive: true }); // a spawn would now fail with the install hint
  app.fx.up = false;
  setTimeout(() => { app.fx.up = true; }, 700);
  await safari.stop();
  assert.equal((await safari.start([])).session, 'S2');
});

test('safari start loads the plist if launchd does not have it', async () => {
  installPlist();
  saveState({ udid: U });
  app.fx.up = false;
  const w = world({ loaded: false, up: false });
  const out = await safari.start([]);
  assert.equal(out.session, 'S1');
  assert.deepEqual(verbs(w.calls).slice(0, 4), ['print', 'print', 'enable', 'bootstrap']); // the rules check first: launchd runs nothing yet
});

test('safari start kicks a service that is not running once, and gives up with a pointer to the log', async () => {
  installPlist();
  saveState({ udid: U });
  app.fx.up = false;
  // Well past kickMs: one slow first probe on a busy runner must not use up the whole wait.
  Object.assign(svc.WAIT, { kickMs: 80, serviceMs: 1000 });
  const calls = fakeRunner((_c, a) => (a[0] === 'print' ? { stdout: 'state = waiting\n' } : undefined));
  await assert.rejects(safari.start([]), err => /didn't answer within/.test(err.message) && err.message.includes('msl-appium.log') && /lab service status/.test(err.message));
  assert.deepEqual(calls.filter(c => c[1] === 'kickstart'), [['launchctl', 'kickstart', '-k', TARGET]]);

  const running = fakeRunner((_c, a) => (a[0] === 'print' ? { stdout: 'state = running\n' } : undefined));
  await assert.rejects(safari.start([]), /didn't answer/);
  assert.equal(running.filter(c => c[1] === 'kickstart').length, 0); // launchd is already trying
});

test('safari start --port other than the service port is refused while the service is installed', async () => {
  installPlist();
  saveState({ udid: U });
  app.fx.up = false;
  fakeRunner();
  await assert.rejects(safari.start(['--port', '4999']), /service listens on \d+, not 4999.*lab service uninstall/);
});

test('safari start --port N refuses before probing N or reading the simulator', async () => {
  installPlist();
  saveState({ udid: U });
  const probe = standin(); // listening on the refused port: it must never be asked anything
  await probe.listen();
  try {
    const calls = fakeRunner();
    await assert.rejects(safari.start(['--port', String(probe.port)]), /service listens on \d+, not \d+/);
    assert.equal(probe.log.length, 0);
    assert.equal(app.log.length, 0);
    assert.equal(calls.length, 0);
    // A recorded session on that port is not probed either.
    saveState({ backend: 'appium', session: 'S9', port: probe.port, target: { simulator: U } });
    await assert.rejects(safari.start(['--port', String(probe.port)]), /service listens on/);
    assert.equal(probe.log.length, 0);
  } finally { await probe.close(); }
});

test('with the service installed ensureAppium clears a stale driverPid even when Appium is already up', async () => {
  installPlist();
  saveState({ udid: U, driverPid: 4242 });
  fakeRunner();
  const out = await safari.start([]);
  assert.equal(out.session, 'S1');
  assert.equal(loadState().driverPid, undefined);
});

test('with the service installed the port saved with a session is stale: recovery uses the service port', async () => {
  installPlist();
  saveState({ udid: U, backend: 'appium', session: 'S9', port: 4800, target: { simulator: U } }); // dead: the stand-in never made S9
  fakeRunner();
  const ep = appiumEndpoint(); // what `lab up` asks before it knows the session is dead
  assert.equal(ep.port, app.port);
  assert.deepEqual(await ensureAppium(ep), { found: 'reachable' });
  assert.equal((await safari.start([])).session, 'S1');
  assert.equal(loadState().port, app.port);

  // An explicit --port 4800 is still refused.
  saveState({ backend: 'appium', session: 'S9', port: 4800, target: { simulator: U } });
  await assert.rejects(safari.start(['--port', '4800']), /service listens on \d+, not 4800.*lab service uninstall/);
  assert.equal(appiumEndpoint(4800).port, 4800);
  await assert.rejects(ensureAppium(appiumEndpoint(4800)), /service listens on \d+, not 4800/);
});

test('without the service the port saved with a session is still used', () => {
  saveState({ udid: U, backend: 'appium', session: 'S9', port: 4800, target: { simulator: U } });
  assert.equal(appiumEndpoint().port, 4800);
});

test('safari stop never kills by a recorded pid while the service is installed', async () => {
  installPlist();
  saveState({ udid: U });
  fakeRunner();
  await safari.start([]);
  saveState({ driverPid: process.pid }); // a recycled pid; killing it would end this test run
  const kill = process.kill;
  const killed = [];
  process.kill = (pid, sig) => { killed.push([pid, sig]); };
  try { await safari.stop(); } finally { process.kill = kill; }
  assert.deepEqual(killed, []);
  assert.equal(loadState().driverPid, undefined);

  // Without the service the pid is still used to end an Appium that start spawned.
  fs.rmSync(svc.plistPath());
  saveState({ driverPid: 4242 });
  process.kill = (pid, sig) => { killed.push([pid, sig]); };
  try { await safari.stop(); } finally { process.kill = kill; }
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
});

test('safari stop still ends a --device safaridriver it started while the service is installed', async () => {
  installPlist();
  saveState({ udid: U, backend: 'safaridriver', driverPid: 4343 });
  const kill = process.kill;
  const killed = [];
  process.kill = (pid, sig) => { killed.push([pid, sig]); };
  try { await safari.stop(); } finally { process.kill = kill; }
  assert.deepEqual(killed, [[4343, 'SIGTERM']]);
  assert.equal(loadState().driverPid, undefined);
});

test('install clears the recorded driverPid of the manual Appium it replaced', async () => {
  saveState({ driverPid: 4321 });
  const w = world({ up: true, lsof: '4321\n', command: 'node .../appium --port 4723\n' });
  await svc.install({ replace: true, node: '/opt/homebrew/bin/node' });
  assert.deepEqual(w.kills, [[4321, 'SIGTERM']]);
  assert.equal(loadState().driverPid, undefined);
});

test('status warns when the plist runs a node inside a versioned Cellar directory', async () => {
  fakeRunner(() => ({ stdout: PRINT }));
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  const cellar = path.join(dir, 'Cellar', 'node', '25.1.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(cellar), { recursive: true });
  fs.writeFileSync(cellar, '');
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: cellar }));
  let s = await svc.status();
  assert.equal(s.node, cellar);
  assert.ok(s.issues.some(i => /Cellar.*node upgrade will break the service.*stable node symlink.*lab service install/.test(i)), s.issues.join('|'));

  const stable = path.join(dir, 'bin', 'node');
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, '');
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable }));
  s = await svc.status();
  assert.ok(!s.issues.some(i => /Cellar/.test(i)));
});

// --- unload and stopProcess (lab down) ---

test('unload disables the service at login, boots it out, keeps the plist, and waits until launchd lets go', async () => {
  const w = world({ loaded: true, up: true });
  installPlist();
  assert.deepEqual(await svc.unload(), { wasLoaded: true, stopped: true, disabled: true });
  assert.deepEqual(verbs(w.calls).filter(v => v !== 'print'), ['disable', 'bootout']);
  assert.deepEqual(w.calls.find(c => c[1] === 'disable'), ['launchctl', 'disable', TARGET]);
  assert.deepEqual(w.calls.find(c => c[1] === 'bootout'), ['launchctl', 'bootout', TARGET]);
  assert.ok(fs.existsSync(svc.plistPath()));

  // Already unloaded: nothing to boot out.
  const again = world({ loaded: false });
  assert.deepEqual(await svc.unload(), { wasLoaded: false, stopped: true, disabled: true });
  assert.ok(!again.calls.some(c => c[1] === 'bootout'));
});

test('unload reports a service launchd will not let go of, within the bound', async () => {
  fakeRunner((cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { stdout: 'state = running\n' } : undefined)); // always loaded
  const t = Date.now();
  assert.deepEqual(await svc.unload(), { wasLoaded: true, stopped: false, disabled: true });
  assert.ok(Date.now() - t < 3000);
});

test('unload says when disable failed, but still boots the service out', async () => {
  const w = world({ loaded: true, up: true });
  fakeRunner((cmd, args) => {
    if (cmd !== 'launchctl') return undefined;
    if (args[0] === 'disable') return { code: 1, stderr: 'Operation not permitted\n' };
    if (args[0] === 'bootout') { w.loaded = false; return undefined; }
    return w.loaded ? { stdout: 'state = running\n' } : { code: 113 };
  });
  assert.deepEqual(await svc.unload(), { wasLoaded: true, stopped: true, disabled: false, disableError: 'Operation not permitted' });
});

test('unload reports launchctl\'s message when bootout fails and launchd still has the service', async () => {
  fakeRunner((cmd, args) => {
    if (cmd !== 'launchctl') return undefined;
    if (args[0] === 'bootout') return { code: 5, stderr: 'Boot-out failed: 5: Input/output error\n' };
    if (args[0] === 'print') return { stdout: 'state = running\n' };
    return undefined;
  });
  const out = await svc.unload();
  assert.equal(out.stopped, false);
  assert.equal(out.disabled, true);
  assert.equal(out.bootoutError, 'Boot-out failed: 5: Input/output error');
});

test('stopProcess terminates a pid whose command matches, and waits for it to go', async () => {
  const killed = [];
  let alive = true;
  const calls = fakeRunner(cmd => (cmd === 'ps' ? { stdout: alive ? 'node /h/node_modules/.bin/appium --port 4723\n' : '' } : undefined));
  svc.setKill((p, sig) => { killed.push([p, sig]); alive = false; });
  assert.deepEqual(await svc.stopProcess(4242, /appium/i), { state: 'stopped' });
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
  assert.deepEqual(calls[0], ['ps', '-o', 'command=', '-p', '4242']);
  assert.deepEqual(await svc.stopProcess(4242, /appium/i), { state: 'gone' }); // nothing there any more
  assert.equal(killed.length, 1);
});

test('stopProcess leaves a pid that now runs something else alone, and reports one that will not exit', async () => {
  const killed = [];
  svc.setKill((p, sig) => { killed.push([p, sig]); });
  fakeRunner(cmd => (cmd === 'ps' ? { stdout: 'vim notes.txt\n' } : undefined));
  assert.deepEqual(await svc.stopProcess(4242, /appium/i), { state: 'other', command: 'vim notes.txt' });
  assert.deepEqual(killed, []);

  fakeRunner(cmd => (cmd === 'ps' ? { stdout: 'node appium\n' } : undefined)); // survives SIGTERM
  assert.deepEqual(await svc.stopProcess(4242, /appium/i), { state: 'stuck' });
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
});

test('status says an unloaded plist is normal after `lab down`', async () => {
  fakeRunner((cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { code: 113 } : undefined));
  installPlist();
  const s = await svc.status();
  assert.ok(s.issues.some(i => /not loaded \(normal after `lab down`\).*`lab up`/.test(i)), JSON.stringify(s.issues));
});

test('requireRedactedService wants the filtered plist AND the service itself listening on the port', () => {
  const filters = path.join(dir, 'filters.json');
  fs.writeFileSync(filters, CURRENT_RULES);
  const plist = args => {
    fs.mkdirSync(svc.agentsDir(), { recursive: true });
    fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  };
  const runner = (pid, listener) => fakeRunner((cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { stdout: `state = running\n\tpid = ${pid}\n` };
    if (cmd === 'lsof') return { stdout: listener };
    return undefined;
  });
  const refused = (re, needs = 'service') => assert.throws(() => svc.requireRedactedService(), e => { assert.match(e.message, re); assert.equal(e.extra.needs, needs); assert.equal(e.extra.then, 'lab service install'); return true; });
  const good = [process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters, '--use-plugins', 'msl-page-pin'];
  runner(4242, '4242\n');
  refused(/the LaunchAgent is not installed/);
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.plistPath(), 'x');
  refused(/arguments can't be read/);
  plist([process.execPath, '/x/appium/main.js']);
  refused(/without log redaction \(`--log-filters`, at log level info or debug\)/);
  plist([process.execPath, '/x/appium/main.js', '--log-level', 'debug']); // debug alone is not enough: the filters are never optional
  refused(/without log redaction \(`--log-filters`, at log level info or debug\)/);
  plist([process.execPath, '/x/appium/main.js', '--log-level', 'warn', '--log-filters', filters]);
  refused(/without log redaction \(`--log-filters`, at log level info or debug\)/);
  plist([process.execPath, '/x/appium/main.js', '--log-filters', filters]);
  refused(/without log redaction \(`--log-filters`, at log level info or debug\)/);
  plist([...good.slice(0, 5), path.join(dir, 'gone.json')]);
  refused(/rules file .* is missing/);
  fs.writeFileSync(filters, JSON.stringify(LOG_FILTERS.slice(3)));
  plist(good);
  refused(/log-filter rules are older than this lab's/); // before the listener is even asked
  fs.writeFileSync(filters, CURRENT_RULES);
  svc.requireRedactedService(); // the service listens: fine
  plist([...good.slice(0, 3), 'debug', ...good.slice(4)]);
  svc.requireRedactedService(); // debug with the filters is fine too
  plist(good);
  runner(0, '4242\n');
  refused(/launchd is not running the service/);
  runner(4242, '999\n');
  refused(/not the service \(launchd's pid 4242, listener 999\)/);
  runner(4242, '4242\n999\n');
  refused(/listener 4242, 999/);
  runner(4242, '');
  refused(/listener none/);
  process.env.MSL_APPIUM_URL = 'http://127.0.0.1:1'; // not ours to check
  try { svc.requireRedactedService(); } finally { delete process.env.MSL_APPIUM_URL; }
});

test('requireCurrentRules: a simulator start through the service is refused on stale or missing rules, and says which', () => {
  const filters = path.join(dir, 'filters.json');
  const plist = args => {
    fs.mkdirSync(svc.agentsDir(), { recursive: true });
    fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  };
  const refused = re => assert.throws(() => svc.requireCurrentRules(), e => { assert.match(e.message, re); assert.equal(e.extra.needs, 'service'); assert.equal(e.extra.then, 'lab service install'); assert.ok(e.extra.human.length > 0); return true; });
  const withFilters = [process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters];
  svc.requireCurrentRules(); // no service: the lab's own Appium gets the rules when it starts
  plist(withFilters);
  refused(/rules file .* is missing/); // not "older": there is no file
  assert.doesNotMatch((() => { try { svc.requireCurrentRules(); } catch (e) { return e.message; } })(), /older than this lab/);
  fs.writeFileSync(filters, '[]');
  refused(/older than this lab's/);
  fs.writeFileSync(filters, CURRENT_RULES);
  svc.requireCurrentRules();
  // A plist that cannot be shown to redact is refused, not waved through: no filters, no readable arguments.
  plist(withFilters.slice(0, 1));
  refused(/without log redaction/);
  plist([]);
  refused(/arguments can't be read/);
  plist([process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters']); // names no file
  refused(/./);
  plist([process.execPath, '/x/appium/main.js', '--log-filters', filters]); // the default log level is not info or debug
  refused(/without log redaction/);
  plist(withFilters);
  process.env.MSL_APPIUM_URL = 'http://127.0.0.1:1'; // not ours to check
  try { fs.writeFileSync(filters, '[]'); svc.requireCurrentRules(); } finally { delete process.env.MSL_APPIUM_URL; }
});

test('requireServiceForValues: only the installed service with current rules passes; every other way is needs "service"', () => {
  const filters = path.join(dir, 'filters.json');
  const plist = args => {
    fs.mkdirSync(svc.agentsDir(), { recursive: true });
    fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  };
  let sessionPort = svc.SERVICE.port;
  const runner = (pid, listener) => fakeRunner((cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { stdout: `state = running\n\tpid = ${pid}\n` } : cmd === 'lsof' ? { stdout: listener } : undefined));
  runner(4242, '4242\n');
  const refused = re => assert.throws(() => svc.requireServiceForValues(sessionPort), e => {
    assert.match(e.message, re);
    assert.match(e.message, /^--storage needs the lab's Appium service with current log-filter rules/);
    assert.equal(e.extra.needs, 'service');
    assert.equal(e.extra.then, 'lab service install');
    assert.match(e.extra.human.join(' '), /--storage .*lab service install/s);
    return true;
  });
  refused(/the LaunchAgent is not installed/);
  const good = [process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters];
  plist(good);
  refused(/rules file .* is missing/);
  fs.writeFileSync(filters, '[]');
  refused(/older than this lab's/);
  plist(good.slice(0, 1));
  refused(/names no log-filter rules file/);
  plist(good);
  fs.writeFileSync(filters, CURRENT_RULES);
  runner(0, '4242\n');
  refused(/launchd is not running the service/);
  runner(4242, '999\n');
  refused(/not the service \(launchd's pid 4242, listener 999\)/);
  runner(4242, '4242\n999\n');
  refused(/listener 4242, 999/);
  runner(4242, '');
  refused(/listener none/);
  runner(4242, '4242\n');
  sessionPort = svc.SERVICE.port + 1;
  refused(/the session is on port \d+, not the service's \d+/);
  sessionPort = svc.SERVICE.port;
  svc.requireServiceForValues(sessionPort); // the service, listening, current rules, the session on its port
  process.env.MSL_APPIUM_URL = 'http://127.0.0.1:1';
  try { refused(/MSL_APPIUM_URL/); } finally { delete process.env.MSL_APPIUM_URL; }
});

test('an Appium the lab starts itself gets the service\'s log level and rules, and the page pin when it is installed', () => {
  const args = selfStartArgs(4723, '/L/msl-appium.log', '/S/f.json');
  assert.deepEqual(args, ['--address', '127.0.0.1', '--port', '4723', '--log', '/L/msl-appium.log', '--log-level', 'info', '--log-filters', '/S/f.json']);
  assert.deepEqual(selfStartArgs(4723, '/L/msl-appium.log', '/S/f.json', true).slice(-2), ['--use-plugins', 'msl-page-pin']);
});

test('writeLogFilters writes the current rules, owner-only, and replaces an old file without a temp file left', () => {
  fs.mkdirSync(path.dirname(svc.logFiltersPath()), { recursive: true });
  fs.writeFileSync(svc.logFiltersPath(), '[]');
  assert.ok(!svc.logFiltersCurrent());
  assert.equal(svc.writeLogFilters(), svc.logFiltersPath());
  assert.equal(fs.readFileSync(svc.logFiltersPath(), 'utf8'), CURRENT_RULES);
  assert.equal(fs.statSync(svc.logFiltersPath()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(svc.logFiltersPath())).filter(f => f.endsWith('.tmp')), []);
  assert.ok(svc.logFiltersCurrent());
});

// --- the rules the running process holds, not only the file on disk ---

const T = 1_800_000_000; // a moment, in seconds
const rulesFile = (mtime = T) => {
  const f = path.join(dir, 'rules.json');
  fs.writeFileSync(f, CURRENT_RULES);
  fs.utimesSync(f, mtime, mtime);
  return f;
};
const psSays = (etime, code = 0) => fakeRunner((cmd, args) => (cmd === 'ps' && args.includes('etime=') ? { code, stdout: etime } : undefined));
const elapsed = sec => {
  const two = n => String(n).padStart(2, '0');
  const [h, m, r] = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60];
  return `${h ? `${two(h)}:` : ''}${two(m)}:${two(r)}\n`;
};

test('rulesLoadedBy: a process that started before the rules were written may hold older ones, to the second', () => {
  const f = rulesFile(T);
  const now = (T + 100) * 1000 + 400; // 100.4 s after the file
  // started at T: the same second as the file
  psSays(elapsed(100));
  assert.equal(svc.rulesLoadedBy(4242, f, now), null);
  // started 1 s before: inside the second the clock and ps round
  psSays(elapsed(101));
  assert.equal(svc.rulesLoadedBy(4242, f, now), null);
  // started 2 s before: older
  psSays(elapsed(102));
  assert.match(svc.rulesLoadedBy(4242, f, now), /^the running Appium \(pid 4242\) started before its log-filter rules were written, so it may hold older rules: run `lab service install` again$/);
  psSays(elapsed(5000));
  assert.match(svc.rulesLoadedBy(4242, f, now), /started before its log-filter rules were written/);
  // started after
  psSays(elapsed(3));
  assert.equal(svc.rulesLoadedBy(4242, f, now), null);
  // ps is asked with an argument list, for that pid, and nothing else
  const calls = psSays(elapsed(3));
  svc.rulesLoadedBy(77, f, now);
  assert.deepEqual(calls, [['ps', '-o', 'etime=', '-p', '77']]);
});

test('rulesLoadedBy: what cannot be read is refused', () => {
  const f = rulesFile(T);
  const now = (T + 100) * 1000;
  for (const [etime, code] of [['', 0], ['\n', 0], ['garbage\n', 0], ['12\n', 0], ['-1:00\n', 0], ['00:61x\n', 0], ['00:05\n', 1]]) {
    psSays(etime, code);
    assert.equal(svc.rulesLoadedBy(4242, f, now), 'couldn\'t read when the service started', JSON.stringify([etime, code]));
  }
  psSays('00:05\n');
  assert.equal(svc.rulesLoadedBy(4242, path.join(dir, 'gone.json'), now), 'couldn\'t read when the rules file was written');
});

test('parseEtime reads ps\'s MM:SS, HH:MM:SS and D-HH:MM:SS', () => {
  assert.equal(svc.parseEtime('00:05'), 5);
  assert.equal(svc.parseEtime('  1:02\n'), 62);
  assert.equal(svc.parseEtime('12:34'), 754);
  assert.equal(svc.parseEtime('01:02:03'), 3723);
  assert.equal(svc.parseEtime('1:02:03'), 3723);
  assert.equal(svc.parseEtime('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(svc.parseEtime('12-00:00:00'), 12 * 86400);
  for (const bad of ['', '5', '1:2', '1:60', '61:00:00x', '1-02:03', 'a:bc', '1-1:00:00:00', null, undefined]) assert.equal(svc.parseEtime(bad), null, String(bad));
});

test('the plist starts Appium with the page pin plugin, and an install without the plugin in the Appium home is refused', async () => {
  world();
  const out = await svc.install({ node: '/opt/homebrew/bin/node' });
  assert.match(fs.readFileSync(out.plist, 'utf8'), /<string>--use-plugins<\/string>\s*<string>msl-page-pin<\/string>/);
  // Appium exits at start on a plugin it can't load, so nothing is written for a missing or foreign one.
  fs.rmSync(svc.plistPath());
  fs.rmSync(path.join(home, 'node_modules', 'msl-page-pin'));
  await assert.rejects(svc.install({ node: '/opt/homebrew/bin/node' }), e => { assert.match(e.message, /the page pin plugin is not installed in .*pnpm add link:.*appium-plugin/); return true; });
  assert.ok(!fs.existsSync(svc.plistPath()));
  const other = path.join(dir, 'other-plugin');
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(home, 'node_modules', 'msl-page-pin'));
  await assert.rejects(svc.install({ node: '/opt/homebrew/bin/node' }), /is not a link to this lab's appium-plugin/);
  assert.ok(!fs.existsSync(svc.plistPath()));
});

test('status tells a plist without the page pin to reinstall, and a missing plugin to link it', async () => {
  const stable = path.join(dir, 'bin', 'node');
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, '');
  fs.mkdirSync(path.dirname(svc.logFiltersPath()), { recursive: true });
  fs.writeFileSync(svc.logFiltersPath(), CURRENT_RULES);
  fakeRunner((cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { stdout: 'state = running\n\tpid = 4242\n' } : undefined));
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath() }));
  assert.deepEqual((await svc.status()).issues, []);
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath() }).replace(/\s*<string>--use-plugins<\/string>\s*<string>msl-page-pin<\/string>/, ''));
  let s = await svc.status();
  assert.ok(s.issues.some(i => /without the lab's page pin plugin \(`--use-plugins msl-page-pin`\).*lab service install/.test(i)), s.issues.join('|'));
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: stable, filters: svc.logFiltersPath() }));
  fs.rmSync(path.join(home, 'node_modules', 'msl-page-pin'));
  s = await svc.status();
  assert.ok(s.issues.some(i => /page pin plugin is not installed.*pnpm add link:/.test(i)), s.issues.join('|'));
});

test('requireRedactedService refuses a plist without the page pin, or a home without the plugin, with the pin\'s own steps', () => {
  const filters = svc.logFiltersPath();
  fs.mkdirSync(path.dirname(filters), { recursive: true });
  fs.writeFileSync(filters, CURRENT_RULES);
  fakeRunner((cmd, args) => (cmd === 'launchctl' ? { stdout: 'state = running\n\tpid = 4242\n' } : cmd === 'lsof' ? { stdout: '4242\n' } : undefined));
  const plist = args => {
    fs.mkdirSync(svc.agentsDir(), { recursive: true });
    fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  };
  const base = [process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters];
  const refused = re => assert.throws(() => svc.requireRedactedService(), e => {
    assert.match(e.message, re);
    assert.equal(e.extra.needs, 'service');
    assert.equal(e.extra.then, 'lab service install');
    assert.deepEqual(e.extra.human, svc.PIN_HUMAN);
    return true;
  });
  plist(base);
  refused(/without the lab's page pin plugin \(`--use-plugins msl-page-pin`\)/);
  plist([...base, '--use-plugins', 'other']);
  refused(/without the lab's page pin plugin/);
  plist([...base, '--use-plugins', 'other,msl-page-pin']);
  svc.requireRedactedService(); // a list that holds it is fine
  fs.rmSync(path.join(home, 'node_modules', 'msl-page-pin'));
  refused(/page pin plugin is not installed/);
  linkPlugin(home);
  svc.requireRedactedService();
});

test('requireCurrentRules also asks the process: a service older than its rules file is refused', () => {
  const filters = rulesFile(Math.floor(Date.now() / 1000) - 50);
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${[process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters, '--use-plugins', 'msl-page-pin'].map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  const world = (pid, etime) => fakeRunner((cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { stdout: `state = running\n\tpid = ${pid}\n` } : cmd === 'ps' ? { stdout: etime } : undefined));
  world(4242, '10:00\n'); // started ten minutes ago, the rules 50 s ago
  assert.throws(() => svc.requireCurrentRules(), e => { assert.match(e.message, /started before its log-filter rules were written/); assert.equal(e.extra.needs, 'service'); return true; });
  world(4242, '00:40\n'); // started 40 s ago: after the rules
  svc.requireCurrentRules();
  world(4242, 'x\n');
  assert.throws(() => svc.requireCurrentRules(), /couldn't read when the service started/);
  world(0, '10:00\n'); // launchd runs nothing: nothing holds old rules
  svc.requireCurrentRules();
  // ... and the stricter door too
  world(4242, '10:00\n');
  fakeRunner((cmd, args) => (cmd === 'launchctl' ? { stdout: 'state = running\n\tpid = 4242\n' } : cmd === 'lsof' ? { stdout: '4242\n' } : cmd === 'ps' ? { stdout: '10:00\n' } : undefined));
  assert.throws(() => svc.requireRedactedService(), /started before its log-filter rules were written/);
  assert.throws(() => svc.requireServiceForValues(svc.SERVICE.port), /started before its log-filter rules were written/);
});

test('install writes the rules only once the old service is gone: a bootout that does not finish leaves the file as it was', async () => {
  fs.mkdirSync(path.dirname(svc.logFiltersPath()), { recursive: true });
  const old = JSON.stringify(LOG_FILTERS.slice(3), null, 2) + '\n';
  fs.writeFileSync(svc.logFiltersPath(), old);
  const before = fs.statSync(svc.logFiltersPath()).mtimeMs;
  // launchd accepts the bootout and keeps the job running with the rules it was started with.
  const stuck = fakeRunner((cmd, args) => {
    if (cmd === 'xcode-select') return { stdout: '/Applications/Xcode.app/Contents/Developer\n' };
    if (cmd === 'launchctl' && args[0] === 'print') return { stdout: `${TARGET} = {\n\tstate = running\n\tpid = 4242\n}\n` };
    return undefined;
  });
  await assert.rejects(svc.install(), /launchd did not unload the old service within 10s/);
  assert.equal(fs.readFileSync(svc.logFiltersPath(), 'utf8'), old, 'the old process still holds the old rules, and the file still says so');
  assert.equal(fs.statSync(svc.logFiltersPath()).mtimeMs, before);
  assert.ok(stuck.some(c => c[0] === 'launchctl' && c[1] === 'bootout'), 'it did ask');
  assert.ok(!stuck.some(c => c[0] === 'launchctl' && c[1] === 'bootstrap'));
  // A bootout that works: the rules are written after it, before the bootstrap.
  let loaded = true;
  const seen = {};
  const read = () => fs.readFileSync(svc.logFiltersPath(), 'utf8');
  app.fx.up = true;
  const calls = fakeRunner((cmd, args) => {
    if (cmd === 'xcode-select') return { stdout: '/Applications/Xcode.app/Contents/Developer\n' };
    if (cmd !== 'launchctl') return undefined;
    if (args[0] === 'print') return loaded ? { stdout: `${TARGET} = {\n\tstate = running\n\tpid = 4242\n}\n` } : { code: 113, stderr: 'Could not find service' };
    if (args[0] === 'bootout') { loaded = false; app.fx.up = false; seen.bootout = read(); }
    if (args[0] === 'bootstrap') { loaded = true; seen.bootstrap = read(); setTimeout(() => { app.fx.up = true; }, 30); }
    return undefined;
  });
  await svc.install();
  assert.equal(seen.bootout, old, 'not yet written when the old service is asked to go');
  assert.equal(seen.bootstrap, CURRENT_RULES, 'written before the new one starts');
  assert.deepEqual(verbs(calls).filter(v => v !== 'print'), ['bootout', 'enable', 'bootstrap']);
});

test('requireServiceForValues refuses a plist that does not show redaction, even with a current rules file', () => {
  const filters = rulesFile(Math.floor(Date.now() / 1000) - 50);
  fakeRunner((cmd, args) => (cmd === 'launchctl' ? { stdout: 'state = running\n\tpid = 4242\n' } : cmd === 'lsof' ? { stdout: '4242\n' } : undefined));
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  const plist = args => fs.writeFileSync(svc.plistPath(), `<plist><dict><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>`);
  plist([process.execPath, '/x/appium/main.js', '--log-filters', filters]); // no --log-level: Appium's default is debug
  assert.throws(() => svc.requireServiceForValues(svc.SERVICE.port), e => { assert.match(e.message, /without log redaction/); assert.equal(e.extra.needs, 'service'); return true; });
  plist([process.execPath, '/x/appium/main.js', '--log-level', 'info', '--log-filters', filters]);
  svc.requireServiceForValues(svc.SERVICE.port);
});

test('status lists a running service that started before its rules were written', async () => {
  const filters = rulesFile(Math.floor(Date.now() / 1000) - 50);
  fs.mkdirSync(svc.agentsDir(), { recursive: true });
  fs.writeFileSync(svc.plistPath(), svc.buildPlist({ ...SPEC, node: '/opt/homebrew/bin/node', filters }));
  const world = etime => fakeRunner((cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { stdout: 'state = running\n\tpid = 4242\n' } : cmd === 'ps' ? { stdout: etime } : undefined));
  const issues = async () => (await svc.status()).issues.filter(i => /started|rules/.test(i));
  world('10:00\n');
  const [old] = await issues();
  assert.match(old, /^the running Appium \(pid 4242\) started before its log-filter rules were written, so it may hold older rules: run `lab service install` again$/);
  world('x\n');
  assert.deepEqual(await issues(), ['couldn\'t read when the service started: run `lab service install` again']);
  world('00:40\n');
  assert.deepEqual(await issues(), []);
});

// --- golden plists and launchctl sequences (the LaunchAgent helper must change none of it) ---

const gold = s => s.slice(1);
const GOLD_HEAD = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`;

test('golden: buildPlist output, byte for byte', () => {
  const xml = svc.buildPlist({ node: '/opt/homebrew/bin/node', main: '/H/node_modules/appium/index.js', home: '/H', port: 4723, log: '/L/msl-appium.log', filters: '/S/filters.json', developerDir: '/Dev', path: '/opt/homebrew/bin:/usr/bin', logLevel: 'debug' });
  assert.equal(xml, gold(GOLD_HEAD) + `  <key>Label</key>
  <string>com.dividedby.msl-appium</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/H/node_modules/appium/index.js</string>
    <string>--address</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>4723</string>
    <string>--log-level</string>
    <string>debug</string>
    <string>--log-filters</string>
    <string>/S/filters.json</string>
    <string>--use-plugins</string>
    <string>msl-page-pin</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/H</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>APPIUM_HOME</key>
    <string>/H</string>
    <key>DEVELOPER_DIR</key>
    <string>/Dev</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/L/msl-appium.log</string>
  <key>StandardErrorPath</key>
  <string>/L/msl-appium.log</string>
</dict>
</plist>
`);
});

test('golden: buildIdlePlist output, byte for byte (with XML escaping)', () => {
  const xml = svc.buildIdlePlist({ ...IDLE_SPEC, developerDir: '/Dev', log: '/L/a&b/<c>.log', env: { MSL_STATE: '/S&1' } });
  assert.equal(xml, gold(GOLD_HEAD) + `  <key>Label</key>
  <string>com.dividedby.msl-idle</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/repo/bin/lab</string>
    <string>down</string>
    <string>--idle</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEVELOPER_DIR</key>
    <string>/Dev</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin</string>
    <key>MSL_STATE</key>
    <string>/S&amp;1</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/L/a&amp;b/&lt;c&gt;.log</string>
</dict>
</plist>
`);
});

test('golden: installIdle and uninstallIdle run exactly these commands, in this order', async () => {
  const PLIST = path.join(dir, 'LaunchAgents', 'com.dividedby.msl-idle.plist');
  const DEV = ['xcode-select', '-p'];
  const print = ['launchctl', 'print', IDLE_TARGET];
  const bootout = ['launchctl', 'bootout', IDLE_TARGET];
  const enable = ['launchctl', 'enable', IDLE_TARGET];
  const bootstrap = ['launchctl', 'bootstrap', `gui/${UID}`, PLIST];

  let w = idleWorld();
  await svc.installIdle({ node: '/n', lab: labFile() });
  assert.deepEqual(w.calls, [DEV, print, enable, bootstrap]);
  w.calls.length = 0;
  assert.deepEqual(await svc.uninstallIdle(), { removed: true, wasLoaded: true });
  assert.deepEqual(w.calls, [print, bootout, print]);
  w.calls.length = 0;
  assert.deepEqual(await svc.uninstallIdle(), { removed: false, wasLoaded: false });
  assert.deepEqual(w.calls, [print, bootout], 'idle asks launchd even when not installed');

  w = idleWorld({ loaded: true });
  await svc.installIdle({ node: '/n', lab: labFile() });
  assert.deepEqual(w.calls, [DEV, print, bootout, print, enable, bootstrap]);
});
