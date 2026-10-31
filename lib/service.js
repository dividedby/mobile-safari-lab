// Appium as a per-user LaunchAgent: launchd starts it at login and restarts it when it dies,
// in the gui/<uid> domain so it can reach the simulator. Install and uninstall write and
// remove the plist and call `launchctl`; `safari start` and `lab up` wait for it rather than
// spawning their own. No dependency on safari.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, saveState, sleep, stateDir, processCommand, REPO } from './core.js';
import { pmd3Path } from './pmd3.js';
import { appiumHome, INSTALL_HINT, LOG_FILTERS, PLUGIN, pluginDir, PIN_RISK, PIN_HUMAN } from './appium.js';
export { PIN_HUMAN };
import { needsError } from './phone.js';

export const LABEL = 'com.dividedby.msl-appium';
// The idle stop: a second LaunchAgent that launchd starts every IDLE_INTERVAL_S seconds to run
// `lab down --idle`. It has no process of its own between runs.
export const IDLE_LABEL = 'com.dividedby.msl-idle';
export const IDLE_INTERVAL_S = 300;
// The Wi-Fi tunnel host (bin/lab-tunnel-host): a third LaunchAgent, loaded idle (no RunAtLoad, no
// KeepAlive). `lab up` and `lab tunnel up` start it with `launchctl kickstart`; `lab down` and
// `lab tunnel down` stop it with SIGTERM. launchd, not the lab command, is its parent, so it can
// reach CoreDevice's per-user services from an SSH session too.
export const TUNNEL_LABEL = 'com.dividedby.msl-tunnel';
// The settings of the installing shell that the idle stop needs to find the same lab again (MSL_SIDELOAD_BIN and
// SIDELOAD_HOME: the idle stop gives a slot borrowed from sideload back, issue 63).
const IDLE_ENV = ['MSL_STATE', 'MSL_APPIUM_HOME', 'MSL_RUNS', 'MSL_LOGS', 'MSL_LAUNCH_AGENTS', 'MSL_LEASE_TTL', 'MSL_IDLE_MINUTES', 'MSL_SIDELOAD_BIN', 'SIDELOAD_HOME'];
// The service always listens here (tests point `port` at a stand-in server).
export const SERVICE = { port: 4723 };

// Waits, in ms (tests shorten them).
export const WAIT = { statusMs: 2000, pollMs: 500, serviceMs: 60e3, kickMs: 30e3, portFreeMs: 10e3 };

// --- where things are ---

export const agentsDir = () => process.env.MSL_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents');
export const plistPath = () => path.join(agentsDir(), `${LABEL}.plist`);
export const idlePlistPath = () => path.join(agentsDir(), `${IDLE_LABEL}.plist`);
export const tunnelPlistPath = () => path.join(agentsDir(), `${TUNNEL_LABEL}.plist`);
export const logsDir = () => process.env.MSL_LOGS || path.join(os.homedir(), 'Library', 'Logs');
export const logPath = () => path.join(logsDir(), 'msl-appium.log');
export const idleLogPath = () => path.join(logsDir(), 'msl-idle.log');
export const tunnelLogPath = () => path.join(logsDir(), 'msl-tunnel.log');
// The redaction rules Appium is started with (`--log-filters`), kept in the lab's own state dir.
export const logFiltersPath = () => path.join(stateDir(), 'appium-log-filters.json');
// What the rules file holds for this lab's LOG_FILTERS.
const rulesText = () => `${JSON.stringify(LOG_FILTERS, null, 2)}\n`;
// Whether the rules file is the one this lab writes. An older lab's (or a hand-edited) file is
// not: Appium keeps masking what the old rules covered and leaks what the new ones added.
export function logFiltersCurrent(file = logFiltersPath()) {
  try { return fs.readFileSync(file, 'utf8') === rulesText(); } catch { return false; }
}
// Writes the rules file (atomically, owner-only) and returns its path.
export function writeLogFilters() {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${logFiltersPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rulesText(), { mode: 0o600 });
  fs.renameSync(tmp, logFiltersPath());
  return logFiltersPath();
}
const domain = () => `gui/${process.getuid()}`;
const target = () => `${domain()}/${LABEL}`;
const idleTarget = () => `${domain()}/${IDLE_LABEL}`;
export const tunnelTarget = () => `${domain()}/${TUNNEL_LABEL}`;
export const serviceUrl = () => `http://127.0.0.1:${SERVICE.port}`;

// Tests replace the platform check and `process.kill`.
const host = { platform: process.platform, kill: (pid, sig) => process.kill(pid, sig) };
export const setPlatform = p => { host.platform = p; };
export const setKill = fn => { host.kill = fn; };
// Sends a signal through the same (swappable) kill.
export const signalPid = (pid, sig) => host.kill(pid, sig);

export const serviceInstalled = () => fs.existsSync(plistPath());

// Appium's entry script inside the install, as a path through the (pnpm) symlinks rather
// than a realpath, so it survives a reinstall of the same folder.
export function appiumMain() {
  const dir = path.join(appiumHome(), 'node_modules', 'appium');
  let main;
  try {
    const bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin;
    main = typeof bin === 'string' ? bin : bin?.appium;
  } catch { /* not installed */ }
  const file = typeof main === 'string' ? path.join(dir, main) : null;
  if (!file || !fs.existsSync(file)) throw new Error(INSTALL_HINT);
  return file;
}

// A node path that outlives Homebrew upgrades. Prefers /opt/homebrew/bin/node, then the
// first `node` on PATH that is a symlink outside a versioned Cellar directory, as long as it
// leads to the same node that is running this; otherwise the running node, resolved.
export function chooseNode({ execPath = process.execPath, pathEnv = process.env.PATH || '', preferred = '/opt/homebrew/bin/node' } = {}) {
  const real = fs.realpathSync(execPath);
  const same = file => {
    try { return fs.realpathSync(file) === real; } catch { return false; }
  };
  const isLink = file => {
    try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
  };
  const stable = file => !file.split(path.sep).includes('Cellar');
  if (stable(preferred) && same(preferred)) return preferred;
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, 'node');
    if (path.isAbsolute(file) && stable(file) && isLink(file) && same(file)) return file;
  }
  return real;
}

// --- the plist ---

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s, pad = '') => `${pad}<string>${esc(s)}</string>`;
const pair = (k, v, pad) => `${pad}<key>${esc(k)}</key>\n${v}`;

// The log levels the service may run at: `info` (normal) and `debug`. The redaction rules
// (`--log-filters`) go on at both, so debug never writes page URLs and titles to the log.
export const LOG_LEVELS = ['info', 'debug'];
export function checkLogLevel(level) {
  if (!LOG_LEVELS.includes(level)) throw new Error(`--log-level must be ${LOG_LEVELS.join(' or ')}, not ${JSON.stringify(String(level))}`);
  return level;
}

// The plist all three agents share. `extra` is [key, rawValue] pairs (`<true/>`, `<integer>5</integer>`)
// between EnvironmentVariables and StandardOutPath.
function agentPlist({ label, args, workingDir, env, extra, stdout, stderr }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    pair('Label', str(label, '  '), '  '),
    pair('ProgramArguments', ['  <array>', ...args.map(a => str(a, '    ')), '  </array>'].join('\n'), '  '),
    pair('WorkingDirectory', str(workingDir, '  '), '  '),
    pair('EnvironmentVariables', ['  <dict>', ...Object.entries(env).map(([k, v]) => pair(k, str(v, '    '), '    ')), '  </dict>'].join('\n'), '  '),
    ...extra.map(([k, v]) => pair(k, `  ${v}`, '  ')),
    pair('StandardOutPath', str(stdout, '  '), '  '),
    pair('StandardErrorPath', str(stderr, '  '), '  '),
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

// Never --relaxed-security or --allow-insecure. `--log-filters` is always there and keeps
// page URLs and titles out of the log (the rules file is written by `install`); so is
// `--use-plugins msl-page-pin`, which keeps a phone session on the lab's tab (see appium-plugin/).
export function buildPlist({ node, main, home, port, log, filters, developerDir, path: searchPath, logLevel = 'info' }) {
  checkLogLevel(logLevel);
  return agentPlist({
    label: LABEL,
    args: [node, main, '--address', '127.0.0.1', '--port', String(port), '--log-level', logLevel, '--log-filters', filters, '--use-plugins', PLUGIN],
    workingDir: home,
    env: { APPIUM_HOME: home, DEVELOPER_DIR: developerDir, PATH: searchPath },
    extra: [['RunAtLoad', '<true/>'], ['KeepAlive', '<true/>'], ['ThrottleInterval', '<integer>5</integer>']],
    stdout: log,
    stderr: log,
  });
}

// The idle stop's plist: `node bin/lab down --idle` every IDLE_INTERVAL_S seconds. No KeepAlive
// and no RunAtLoad (nothing resident, and no run at login), nothing listening; stdout goes
// nowhere (the command prints JSON), stderr to the log (one line when it acts or fails).
export function buildIdlePlist({ node, lab, developerDir, path: searchPath, log, env = {} }) {
  return agentPlist({
    label: IDLE_LABEL,
    args: [node, lab, 'down', '--idle'],
    workingDir: path.dirname(path.dirname(lab)),
    env: { DEVELOPER_DIR: developerDir, PATH: searchPath, ...env },
    extra: [['RunAtLoad', '<false/>'], ['StartInterval', `<integer>${IDLE_INTERVAL_S}</integer>`]],
    stdout: '/dev/null',
    stderr: log,
  });
}

// The tunnel host's plist: `node bin/lab-tunnel-host`, started and stopped only by lab commands
// (no RunAtLoad, no KeepAlive, no StartInterval), nothing on stdout, stderr to the log.
export function buildTunnelPlist({ node, host: hostFile, developerDir, path: searchPath, log, env = {} }) {
  return agentPlist({
    label: TUNNEL_LABEL,
    args: [node, hostFile],
    workingDir: path.dirname(path.dirname(hostFile)),
    env: { DEVELOPER_DIR: developerDir, PATH: searchPath, ...env },
    extra: [['RunAtLoad', '<false/>'], ['KeepAlive', '<false/>']],
    stdout: '/dev/null',
    stderr: log,
  });
}

// The node path, Appium script and all arguments the installed plist runs, or nulls.
function plistPrograms(file = plistPath()) {
  try {
    const xml = fs.readFileSync(file, 'utf8');
    const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] || '';
    const un = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const args = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => un(m[1]));
    return { node: args[0] ?? null, main: args[1] ?? null, args };
  } catch { return { node: null, main: null, args: [] }; }
}

// The MSL_* variables a plist's EnvironmentVariables sets, as an object (empty when it can't be read).
function plistEnv(file) {
  try {
    const xml = fs.readFileSync(file, 'utf8');
    const block = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] || '';
    const un = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return Object.fromEntries([...block.matchAll(/<key>(MSL_[A-Z_]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(m => [m[1], un(m[2])]));
  } catch { return {}; }
}

// The value after a flag in an argument list, or undefined.
const flagValue = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
// Redacted means a log level the lab offers and the filter rules both on.
const redacted = args => LOG_LEVELS.includes(flagValue(args, '--log-level')) && !!flagValue(args, '--log-filters');

// Pinned means the page pin plugin is among the plugins Appium is started with.
const pinned = args => (flagValue(args, '--use-plugins') ?? '').split(',').includes(PLUGIN);

// Why the plugin can't load, or null: the Appium home must hold `msl-page-pin` as a link to this
// lab's own appium-plugin (so the plugin always is the code in this checkout).
export function pluginProblem() {
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  const dir = path.join(appiumHome(), 'node_modules', PLUGIN);
  const fix = `run \`pnpm add link:${pluginDir()}\` in ${appiumHome()}`;
  if (!real(dir)) return `the page pin plugin is not installed in ${appiumHome()} (${fix})`;
  if (real(dir) !== real(pluginDir())) return `${dir} is not a link to this lab's appium-plugin (${fix})`;
  return null;
}

// --- launchd ---

// { loaded, state, pid } from `launchctl print`. Its output format isn't documented, hence
// the tolerant patterns.
export function launchdState(tgt = target()) {
  const r = run('launchctl', ['print', tgt], { allowFail: true });
  if (r.code !== 0) return { loaded: false, state: null, pid: null };
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
  return { loaded: true, state: /^\s*state = (\S+)/m.exec(r.stdout)?.[1] ?? null, pid: pid ? Number(pid) : null };
}

export async function reachable(ms = WAIT.statusMs) {
  try {
    const res = await fetch(`${serviceUrl()}/status`, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch { return false; }
}

export async function waitUntil(test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= end) return false;
    await sleep(WAIT.pollMs);
  }
}

export async function status() {
  const installed = serviceInstalled();
  const l = launchdState();
  const up = await reachable();
  const { node, args } = plistPrograms();
  const issues = [];
  if (!installed) issues.push('the LaunchAgent is not installed: run `lab service install`');
  if (installed && node && !fs.existsSync(node)) issues.push(`the node in the plist (${node}) no longer exists: run \`lab service install\` again`);
  if (installed && node && /\/Cellar\//.test(node)) {
    issues.push(`the node in the plist (${node}) is inside a versioned Cellar directory: a Homebrew node upgrade will break the service. Put a stable node symlink on PATH (such as /opt/homebrew/bin/node) and run \`lab service install\` again`);
  }
  // Like the node checks: no issue for a plist whose arguments couldn't be read (`argsReadable`
  // says so; a device session refuses to start on it, see requireRedactedService below).
  if (installed && args.length && !redacted(args)) {
    issues.push('the plist starts Appium without log redaction (`--log-filters`, at log level info or debug), so page URLs and titles can end up in the log: run `lab service install` again');
  } else if (installed && args.length && !fs.existsSync(flagValue(args, '--log-filters'))) {
    issues.push(`the log-filter rules file (${flagValue(args, '--log-filters')}) is missing: run \`lab service install\` again`);
  } else if (installed && args.length && !logFiltersCurrent(flagValue(args, '--log-filters'))) {
    issues.push('the log-filter rules are older than this lab\'s, so typed text and storage values can end up in the log: run `lab service install` again');
  } else if (installed && args.length && validPid(l.pid)) {
    const why = rulesLoadedBy(l.pid, flagValue(args, '--log-filters'));
    if (why) issues.push(`${why}${/run `lab service install`/.test(why) ? '' : ': run `lab service install` again'}`);
  }
  if (installed && args.length && !pinned(args)) {
    issues.push(`the plist starts Appium without the lab's page pin plugin (\`--use-plugins msl-page-pin\`), so ${PIN_RISK}: run \`lab service install\` again`);
  }
  const noPlugin = pluginProblem();
  if (installed && noPlugin) issues.push(noPlugin);
  if (installed && !l.loaded) issues.push('the plist is installed but not loaded (normal after `lab down`): `lab up` or `lab service install` loads it');
  if (l.loaded && !up) issues.push(`launchd has it (${l.state ?? 'unknown state'}) but nothing answers on 127.0.0.1:${SERVICE.port}: see ${logPath()}`);
  return { installed, ...l, port: SERVICE.port, reachable: up, plist: plistPath(), log: logPath(), logLevel: flagValue(args, '--log-level') ?? null, node, argsReadable: args.length > 0, issues };
}

const STALE_RULES = 'the log-filter rules are older than this lab\'s';

// The simulator's way to the same check, and type's and keys': when the LaunchAgent is installed,
// Appium is the service, and what it logs depends on the rules it was started with. Its plist must
// show redaction and name a rules file that is this lab's, and a running service must have started
// after that file was written (see rulesLoadedBy). Throws a `needs` "service" error. Nothing to
// check without the service (the lab's own Appium gets current rules, see ensureAppium), with
// MSL_APPIUM_URL (not ours), or while launchd runs nothing.
export function requireCurrentRules() {
  if (process.env.MSL_APPIUM_URL || !serviceInstalled()) return;
  const bad = why => { throw needsError('service', `${why}, so typed text and storage values would reach Appium's log`); };
  const { args } = plistPrograms();
  if (!args.length) bad('the plist\'s arguments can\'t be read');
  if (!redacted(args)) bad('the plist starts Appium without log redaction (`--log-filters`, at log level info or debug)');
  const file = flagValue(args, '--log-filters');
  if (!fs.existsSync(file)) bad(`the log-filter rules file (${file}) is missing`);
  if (!logFiltersCurrent(file)) bad(STALE_RULES);
  const pid = launchdState().pid;
  const why = validPid(pid) ? rulesLoadedBy(pid, file) : null;
  if (why) bad(why);
}

// For values that must never reach an unredacted log (`open --storage`): only the lab's own
// service, with this lab's rules file, will do, and it must be the one that receives them. No
// service, MSL_APPIUM_URL (an Appium the lab can't check), a plist without rules, a missing or an
// older rules file, a service launchd is not running or another listener on its port, and a session
// on another port (`sessionPort`) all refuse with `needs` "service". Throws before anything is
// asked of the page.
export function requireServiceForValues(sessionPort) {
  const bad = why => {
    const e = needsError('service', `--storage needs the lab's Appium service with current log-filter rules, so its values can't reach an unredacted Appium log: ${why}`);
    e.extra.human = ['--storage sends values through Appium, and its log is only kept clean by the lab\'s Appium service with up-to-date log-filter rules.', 'Run `lab service install` (again, if the rules are out of date).'];
    throw e;
  };
  if (process.env.MSL_APPIUM_URL) bad('MSL_APPIUM_URL points at an Appium the lab can\'t check');
  if (!serviceInstalled()) bad('the LaunchAgent is not installed');
  const { args } = plistPrograms();
  const file = flagValue(args, '--log-filters');
  if (!file) bad('the plist names no log-filter rules file');
  if (!redacted(args)) bad('the plist starts Appium without log redaction (`--log-filters`, at log level info or debug)');
  if (!fs.existsSync(file)) bad(`the log-filter rules file (${file}) is missing`);
  if (!logFiltersCurrent(file)) bad(STALE_RULES);
  requireServiceListening(bad, file);
  if (sessionPort !== SERVICE.port) bad(`the session is on port ${sessionPort}, not the service's ${SERVICE.port}`);
}

// A device run only goes through an Appium that keeps page URLs and titles out of its log: the
// lab's LaunchAgent with `--log-filters` (at log level info or debug), and that agent is what listens on the
// port. It also runs with the page pin plugin (and the plugin is installed), so a tab the owner opens
// can't pull the session into it. Unreadable plist arguments fail. (MSL_APPIUM_URL: not ours to check;
// the session's `msl:pagePin` capability is, see safari.js.) Throws a `needs`
// "service" error; `safari start` and `lab up` both call it.
export function requireRedactedService() {
  if (process.env.MSL_APPIUM_URL) return;
  const bad = (why, pin = false) => {
    const e = needsError('service', `a device run needs the Appium service with its log filters and page pin plugin: ${why}`);
    if (pin) e.extra.human = [...PIN_HUMAN];
    throw e;
  };
  if (!serviceInstalled()) bad('the LaunchAgent is not installed');
  const { args } = plistPrograms();
  if (!args.length) bad('the plist\'s arguments can\'t be read');
  if (!redacted(args)) bad('the plist starts Appium without log redaction (`--log-filters`, at log level info or debug)');
  if (!fs.existsSync(flagValue(args, '--log-filters'))) bad(`the log-filter rules file (${flagValue(args, '--log-filters')}) is missing`);
  if (!logFiltersCurrent(flagValue(args, '--log-filters'))) bad(STALE_RULES);
  if (!pinned(args)) bad(`the plist starts Appium without the lab's page pin plugin (\`--use-plugins msl-page-pin\`), so ${PIN_RISK}; run \`lab service install\` again`, true);
  const noPlugin = pluginProblem();
  if (noPlugin) bad(noPlugin, true);
  requireServiceListening(bad, flagValue(args, '--log-filters'));
}

const validPid = p => Number.isInteger(p) && p > 1;

// `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null for anything else.
export function parseEtime(text) {
  const m = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [d, h, min, sec] = [m[1], m[2], m[3], m[4]].map(n => Number(n ?? 0));
  return sec > 59 || min > 59 || h > 23 ? null : ((d * 24 + h) * 60 + min) * 60 + sec;
}

// Whether the process `pid` started after the rules file was written, so it holds these rules and
// not older ones (Appium reads them once, at its start; the file on disk says nothing of what a
// running process loaded). Gives null when it did, else why not: the process started more than a
// second before the file's last write (ps and the file system count whole seconds), or either time
// can't be read. `nowMs` is for tests.
export function rulesLoadedBy(pid, file, nowMs = Date.now()) {
  const r = run('ps', ['-o', 'etime=', '-p', String(pid)], { allowFail: true, timeoutMs: 5e3 });
  const up = r.code === 0 ? parseEtime(r.stdout) : null;
  if (up === null) return 'couldn\'t read when the service started';
  let written;
  try { written = Math.floor(fs.statSync(file).mtimeMs / 1000); } catch { return 'couldn\'t read when the rules file was written'; }
  if (Math.floor(nowMs / 1000) - up < written - 1) return `the running Appium (pid ${pid}) started before its log-filter rules were written, so it may hold older rules: run \`lab service install\` again`;
  return null;
}

// launchd runs the service, and its pid is the only listener on the service's port (so what answers
// there is the service, not another Appium), and that process started after `file`, its rules, was
// written. Calls `bad(why)`, which throws, when not.
function requireServiceListening(bad, file) {
  const job = launchdState().pid;
  if (!validPid(job)) bad('launchd is not running the service');
  const lsof = run('lsof', ['-nP', `-iTCP:${SERVICE.port}`, '-sTCP:LISTEN', '-t'], { allowFail: true, timeoutMs: 5e3 });
  const pids = lsof.stdout.split('\n').map(l => Number(l.trim())).filter(n => validPid(n));
  if (!pids.length || pids.some(p => p !== job)) bad(`what listens on port ${SERVICE.port} is not the service (launchd's pid ${job}, listener ${pids.join(', ') || 'none'})`);
  const why = rulesLoadedBy(job, file);
  if (why) bad(why);
}

// Enables an agent and loads its plist into gui/<uid>.
function bootstrapAgent(tgt, file) {
  run('launchctl', ['enable', tgt], { allowFail: true });
  run('launchctl', ['bootstrap', domain(), file]);
}

// Writes an agent's plist (0644, through a temp file), boots a loaded one out and waits for launchd
// to let go of it (`oldName` is what the error calls it), then loads the new one.
async function loadAgent({ file, tgt, plist, oldName }) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, plist, { mode: 0o644 });
  fs.renameSync(tmp, file);
  if (launchdState(tgt).loaded) {
    run('launchctl', ['bootout', tgt], { allowFail: true });
    if (!await waitUntil(() => !launchdState(tgt).loaded, WAIT.portFreeMs)) throw new Error(`launchd did not unload the old ${oldName} within 10s`);
  }
  bootstrapAgent(tgt, file);
}

// Boots an agent out and removes its plist; the caller says whether it was loaded. Returns the
// fields to spread into the result: a `note` when launchd still has it.
async function removeAgent({ file, tgt, label, wasLoaded }) {
  run('launchctl', ['bootout', tgt], { allowFail: true });
  fs.rmSync(file, { force: true });
  const stopped = !wasLoaded || await waitUntil(() => !launchdState(tgt).loaded, WAIT.portFreeMs);
  return stopped ? {} : { note: `launchd still has ${label} after bootout` };
}

// If the plist is installed but launchd doesn't have it (after a bootout, say), loads it.
export function bootstrapIfNeeded() {
  if (!serviceInstalled() || launchdState().loaded) return false;
  bootstrapAgent(target(), plistPath());
  return true;
}

export function kickstart() {
  run('launchctl', ['kickstart', '-k', target()]);
}

// The pid of a manual Appium on the port, if one is there.
function strayAppium() {
  const lsof = run('lsof', ['-nP', `-iTCP:${SERVICE.port}`, '-sTCP:LISTEN', '-t'], { allowFail: true });
  const pid = Number(lsof.stdout.trim().split('\n')[0]);
  if (!Number.isInteger(pid) || pid < 2) return null;
  const cmd = processCommand(pid);
  return { pid, appium: /appium/i.test(cmd) };
}

export async function install({ replace = false, node = chooseNode(), logLevel = 'info' } = {}) {
  checkLogLevel(logLevel);
  if (host.platform !== 'darwin') throw new Error('the Appium LaunchAgent needs macOS (launchd)');
  const main = appiumMain();
  const noPlugin = pluginProblem(); // Appium exits at start on a plugin it can't load
  if (noPlugin) throw new Error(noPlugin);
  const developerDir = run('xcode-select', ['-p']).stdout.trim();
  if (!developerDir) throw new Error('xcode-select -p printed nothing: install Xcode and run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`');

  let replaced;
  if (!launchdState().loaded && await reachable()) {
    const stray = strayAppium();
    if (!stray) throw new Error(`something answers on 127.0.0.1:${SERVICE.port} but its process wasn't found (lsof); stop it first`);
    if (!stray.appium) throw new Error(`port ${SERVICE.port} is in use by a process that isn't Appium (pid ${stray.pid}); stop it first`);
    if (!replace) throw new Error(`an Appium is already on 127.0.0.1:${SERVICE.port} (pid ${stray.pid}); stop it or pass --replace (its session will be lost)`);
    host.kill(stray.pid, 'SIGTERM');
    if (!await waitUntil(async () => !(await reachable()), WAIT.portFreeMs)) {
      throw new Error(`the Appium on 127.0.0.1:${SERVICE.port} (pid ${stray.pid}) didn't stop within ${Math.round(WAIT.portFreeMs / 1000)}s`);
    }
    replaced = stray.pid;
  }

  const plist = buildPlist({
    node, main, home: appiumHome(), port: SERVICE.port, log: logPath(), filters: logFiltersPath(), developerDir, logLevel,
    path: [...new Set([path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/opt/homebrew/bin'])].join(':'),
  });
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
  const tmp = `${plistPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, plist, { mode: 0o644 });
  fs.renameSync(tmp, plistPath());
  saveState({ driverPid: null }); // a manual Appium's pid (maybe just replaced) is not ours to kill any more

  if (launchdState().loaded) {
    run('launchctl', ['bootout', target()], { allowFail: true });
    if (!await waitUntil(() => !launchdState().loaded, WAIT.portFreeMs)) throw new Error('launchd did not unload the old service within 10s');
  }
  // Only once the old process is gone: a rules file written before it left would look current while
  // that process still held the old rules. The new process starts after the write (see rulesLoadedBy).
  writeLogFilters();
  run('launchctl', ['enable', target()], { allowFail: true });
  run('launchctl', ['bootstrap', domain(), plistPath()]);
  if (!await waitUntil(reachable, WAIT.serviceMs)) {
    throw new Error(`Appium didn't answer on 127.0.0.1:${SERVICE.port} within ${Math.round(WAIT.serviceMs / 1000)}s: see ${logPath()}`);
  }
  return { installed: true, plist: plistPath(), node, logLevel, pid: launchdState().pid, port: SERVICE.port, ...(replaced ? { replaced } : {}) };
}

// --- the idle stop agent ---

export const idleInstalled = () => fs.existsSync(idlePlistPath());

// Writes the idle stop's plist and loads it (replacing a loaded one). It runs this checkout's
// `bin/lab` with the same node the Appium plist uses. Returns { installed, plist, node, lab, ... }.
export async function installIdle({ node = chooseNode(), lab = path.join(REPO, 'bin', 'lab') } = {}) {
  if (host.platform !== 'darwin') throw new Error('the idle stop needs macOS (launchd)');
  if (!fs.existsSync(lab)) throw new Error(`${lab} not found: the idle stop runs this checkout's bin/lab`);
  const developerDir = run('xcode-select', ['-p']).stdout.trim();
  if (!developerDir) throw new Error('xcode-select -p printed nothing: install Xcode and point xcode-select at it');
  const env = Object.fromEntries(IDLE_ENV.filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const plist = buildIdlePlist({
    node, lab, developerDir, log: idleLogPath(), env,
    path: [...new Set([path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/opt/homebrew/bin'])].join(':'),
  });
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
  await loadAgent({ file: idlePlistPath(), tgt: idleTarget(), plist, oldName: 'idle stop' });
  return { installed: true, plist: idlePlistPath(), node, lab, intervalSeconds: IDLE_INTERVAL_S, log: idleLogPath() };
}

// Boots the idle stop out and removes its plist. "Not found" is fine.
export async function uninstallIdle() {
  const wasInstalled = idleInstalled();
  const wasLoaded = launchdState(idleTarget()).loaded;
  return { removed: wasInstalled, wasLoaded, ...await removeAgent({ file: idlePlistPath(), tgt: idleTarget(), label: IDLE_LABEL, wasLoaded }) };
}

// What `lab status` and `lab service status` say of the idle stop agent. An issue only when the
// node or `bin/lab` the plist runs is gone (it would fail every five minutes).
export function idleStatus() {
  const installed = idleInstalled();
  const { node, main: lab } = plistPrograms(idlePlistPath());
  const l = installed ? launchdState(idleTarget()) : { loaded: false };
  const issues = [];
  if (installed && node && !fs.existsSync(node)) issues.push(`the node in the idle stop's plist (${node}) no longer exists: run \`lab service install\` again`);
  if (installed && lab && !fs.existsSync(lab)) issues.push(`the bin/lab in the idle stop's plist (${lab}) no longer exists (the lab moved?): run \`lab service install\` again`);
  if (installed && !l.loaded) issues.push('the idle stop is installed but not loaded: run `lab service install` again');
  return { installed, loaded: l.loaded, intervalSeconds: IDLE_INTERVAL_S, plist: idlePlistPath(), log: idleLogPath(), node, lab, env: plistEnv(idlePlistPath()), issues };
}

// --- the tunnel host agent ---

export const tunnelInstalled = () => fs.existsSync(tunnelPlistPath());

// Writes the tunnel host's plist and loads it idle (replacing a loaded one, which stops a running
// host). Its PATH has the folder `uv tool` installs pymobiledevice3 into; the log is created 0600.
export async function installTunnel({ node = chooseNode(), host: hostFile = path.join(REPO, 'bin', 'lab-tunnel-host') } = {}) {
  if (host.platform !== 'darwin') throw new Error('the tunnel host needs macOS (launchd)');
  if (!fs.existsSync(hostFile)) throw new Error(`${hostFile} not found: the tunnel host runs this checkout's bin/lab-tunnel-host`);
  const developerDir = run('xcode-select', ['-p']).stdout.trim();
  if (!developerDir) throw new Error('xcode-select -p printed nothing: install Xcode and point xcode-select at it');
  let toolDir = null;
  try { toolDir = path.dirname(pmd3Path()); } catch { /* MSL_PMD3 is not absolute: the host reports it */ }
  const env = Object.fromEntries([...IDLE_ENV, 'MSL_PMD3'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const plist = buildTunnelPlist({
    node, host: hostFile, developerDir, log: tunnelLogPath(), env,
    path: [...new Set([path.dirname(node), ...(toolDir ? [toolDir] : []), '/usr/bin', '/bin', '/usr/sbin', '/opt/homebrew/bin'])].join(':'),
  });
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
  fs.closeSync(fs.openSync(tunnelLogPath(), 'a', 0o600));
  fs.chmodSync(tunnelLogPath(), 0o600);
  await loadAgent({ file: tunnelPlistPath(), tgt: tunnelTarget(), plist, oldName: 'tunnel host' });
  return { installed: true, plist: tunnelPlistPath(), node, host: hostFile, log: tunnelLogPath() };
}

// Loads the installed plist if launchd doesn't have it. Returns whether it did.
export function bootstrapTunnelIfNeeded() {
  if (!tunnelInstalled() || launchdState(tunnelTarget()).loaded) return false;
  bootstrapAgent(tunnelTarget(), tunnelPlistPath());
  return true;
}

// Boots the tunnel host out (a running one gets SIGTERM and cleans up) and removes its plist.
export async function uninstallTunnel() {
  const wasInstalled = tunnelInstalled();
  const wasLoaded = wasInstalled && launchdState(tunnelTarget()).loaded;
  return { removed: wasInstalled, wasLoaded, ...await removeAgent({ file: tunnelPlistPath(), tgt: tunnelTarget(), label: TUNNEL_LABEL, wasLoaded }) };
}

// What `lab status` and `lab tunnel status` say of the agent. Issues when the node or the host
// script it runs is gone, or it is installed but not loaded.
export function tunnelAgentStatus() {
  const installed = tunnelInstalled();
  const { node, main: hostFile } = plistPrograms(tunnelPlistPath());
  const l = installed ? launchdState(tunnelTarget()) : { loaded: false, state: null, pid: null };
  const issues = [];
  if (!installed) issues.push('the tunnel host is not installed: run `lab service install`');
  if (installed && node && !fs.existsSync(node)) issues.push(`the node in the tunnel host's plist (${node}) no longer exists: run \`lab service install\` again`);
  if (installed && hostFile && !fs.existsSync(hostFile)) issues.push(`the bin/lab-tunnel-host in the tunnel host's plist (${hostFile}) no longer exists (the lab moved?): run \`lab service install\` again`);
  if (installed && !l.loaded) issues.push('the tunnel host is installed but not loaded: `lab up` or `lab service install` loads it');
  return { installed, loaded: l.loaded, state: l.state ?? null, pid: l.pid ?? null, plist: tunnelPlistPath(), log: tunnelLogPath(), node, host: hostFile, issues };
}

// Stops the service for now and keeps the plist: disabled, so RunAtLoad doesn't start it at
// the next login either, then booted out. `lab up` (through `bootstrapIfNeeded`) enables and
// loads it again.
// Returns { wasLoaded, stopped, disabled } with launchctl's message as `disableError` when
// the disable failed (it is still booted out, but may come back at login) and `bootoutError`
// when the bootout failed and launchd still has it.
export async function unload() {
  const wasLoaded = launchdState().loaded;
  const said = r => (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ');
  const disable = run('launchctl', ['disable', target()], { allowFail: true });
  const bootout = wasLoaded ? run('launchctl', ['bootout', target()], { allowFail: true }) : null;
  const stopped = !wasLoaded || await waitUntil(() => !launchdState().loaded, WAIT.portFreeMs);
  return {
    wasLoaded, stopped, disabled: disable.code === 0,
    ...(disable.code === 0 ? {} : { disableError: said(disable) || `exit ${disable.code}` }),
    ...(!stopped && bootout && bootout.code !== 0 ? { bootoutError: said(bootout) || `exit ${bootout.code}` } : {}),
  };
}

export const serviceTarget = target;

// Every process as { pid, ppid, command } (one `ps`; the command is last on the line).
export function listProcesses() {
  const r = run('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], { allowFail: true });
  const rows = [];
  for (const line of r.code === 0 ? r.stdout.split('\n') : []) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return rows;
}

// SIGTERMs a process the lab started, after `ps` shows the pid still runs what we started
// (`pattern.test` on its command line): pids get reused. Returns { state: 'gone' } if nothing
// runs there, { state: 'other', command } for some other process (left alone), and
// 'stopped' or 'stuck' (still there after WAIT.portFreeMs).
export async function stopProcess(pid, pattern) {
  const command = () => processCommand(pid);
  const cmd = command();
  if (!cmd) return { state: 'gone' };
  if (!pattern.test(cmd)) return { state: 'other', command: cmd.slice(0, 120) };
  try { host.kill(pid, 'SIGTERM'); } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  return { state: await waitUntil(() => !command(), WAIT.portFreeMs) ? 'stopped' : 'stuck' };
}

// Unloads the service and removes the plist. Leaves the Appium install, the WebDriverAgent
// cache and the log alone.
export async function uninstall() {
  const wasInstalled = serviceInstalled();
  const wasLoaded = launchdState().loaded;
  run('launchctl', ['bootout', target()], { allowFail: true }); // "not found" is fine
  fs.rmSync(plistPath(), { force: true });
  const stopped = await waitUntil(async () => !(await reachable()), WAIT.portFreeMs);
  return { uninstalled: true, wasInstalled, wasLoaded, ...(stopped ? {} : { note: `something still answers on 127.0.0.1:${SERVICE.port}` }) };
}
