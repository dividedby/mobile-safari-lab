import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The secrets check runs as its own process against a throwaway git repo, with a throwaway lab state and HOME.
const execFileAsync = promisify(execFile);
const run = (file, args, opts = {}) => execFileAsync(file, args, { timeout: 30000, killSignal: 'SIGKILL', ...opts });
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-secrets.mjs');

// Fake secrets are put together at runtime so this file itself stays clean.
const REAL_SHAPED_UDID = ['0000', '8130'].join('') + '-' + ['0019', '4E6A2C91B03E'].join('');
const PLACEHOLDER_UDID = ['0000', '8000'].join('') + '-' + ['000A1B2C', '3D4E5F60'].join(''); // the fake phone the tests use
const LEGACY_UDID = ['a1b2c3d4e5', 'f60718293a', '4b5c6d7e8f', '9012a3b4c5'].join('');
const SIM_UDID = ['5C3E9A10', '7B2D', '4F61', '9E08', 'A1B2C3D4E5F6'].join('-');
const TEAM = ['Q7W', 'E8R9T0Y'].join('');
const BUNDLE = ['com.example', '.msl-wda-q7we'].join('');
const PEM_KEY = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join('') + '\nMIIB\n';
const PROFILE_PLIST = ['<key>', 'TeamIdentifier', '</key>\n<key>', 'ExpirationDate', '</key>\n'].join('');
const HOME = ['/Users/', 'jdoe-msl-test'].join('');

let root, state;

const git = (...args) => run('git', args, { cwd: root });
async function put(file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}
async function check(mode = 'staged') {
  let stdout, code = 0;
  try {
    ({ stdout } = await run('node', [SCRIPT, `--${mode}`], { cwd: root, env: { ...process.env, MSL_STATE: state, HOME } }));
  } catch (e) { ({ stdout } = e); code = e.code; }
  return { code, stdout, json: JSON.parse(stdout) };
}
async function stageAndCheck(file, content, mode = 'staged') {
  await put(file, content);
  await git('add', '-A', '-f');
  return check(mode);
}
const rules = r => r.json.findings.map(f => f.rule);
const saveLabState = s => writeFile(path.join(state, 'state.json'), typeof s === 'string' ? s : JSON.stringify(s));

const temps = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'msl-secrets-repo-'));
  state = await mkdtemp(path.join(tmpdir(), 'msl-secrets-state-'));
  temps.push(root, state);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'dividedby');
  await git('config', 'user.email', '64715420+dividedby@users.noreply.github.com');
});
after(() => Promise.all(temps.map(t => rm(t, { recursive: true, force: true }))));

test('check-secrets passes a clean file and prints one JSON object', async () => {
  const r = await stageAndCheck('README.md', '# hello\n');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, mode: 'staged', scanned: 1, findings: [] });
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('check-secrets blocks key, certificate and profile files, env files and run folders', async () => {
  for (const f of ['certs/dev.P12', 'a.mobileprovision', '.pem', 'sub/x.key']) await put(f, 'x');
  for (const f of ['.env', '.Env.local']) await put(f, 'x');
  for (const f of ['runs/20261031-000626-live/sh-1.png', 'Secrets/a.txt', 'x/xcuserdata/b', 'WebDriverAgentRunner-Runner.APP/c']) await put(f, 'x');
  await git('add', '-A', '-f');
  const r = await check();
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.findings.map(f => `${f.file}:${f.rule}`).sort(), [
    '.Env.local:forbidden-filename', '.env:forbidden-filename', '.pem:forbidden-extension',
    'Secrets/a.txt:forbidden-path', 'WebDriverAgentRunner-Runner.APP/c:forbidden-path', 'a.mobileprovision:forbidden-extension',
    'certs/dev.P12:forbidden-extension', 'runs/20261031-000626-live/sh-1.png:forbidden-path', 'sub/x.key:forbidden-extension',
    'x/xcuserdata/b:forbidden-path',
  ]);
});

test('check-secrets blocks a PEM private key with its line number', async () => {
  const r = await stageAndCheck('a.txt', 'ok\n' + PEM_KEY);
  assert.deepEqual(r.json.findings, [{ file: 'a.txt', line: 2, rule: 'private-key', message: 'PEM private key block' }]);
});

test('check-secrets blocks a UDID of the modern shape, but not the fake ones the tests use', async () => {
  const real = await stageAndCheck('a.txt', `device DEVICE_${REAL_SHAPED_UDID.toLowerCase()}abc\n`);
  assert.equal(real.code, 1);
  assert.deepEqual(rules(real), ['device-udid']);
  await git('rm', '-q', '-f', 'a.txt');
  const fakes = [PLACEHOLDER_UDID, PLACEHOLDER_UDID.replace(/0$/, '1'), ['0000', '8110-001A2B3C4D5E6F78'].join(''), ['0000', '8000-0000000000000BAD'].join('')];
  const ok = await stageAndCheck('b.js', fakes.map(u => `const D = '${u}';`).join('\n'));
  assert.equal(ok.code, 0, ok.stdout);
});

test('check-secrets blocks the IDs saved in the lab state, in any case, and never prints them', async () => {
  await saveLabState({ udid: SIM_UDID, phone: { udid: LEGACY_UDID, teamId: TEAM, bundleId: BUNDLE }, profiles: { configured: { udid: SIM_UDID.replace('A1B2', 'C3D4'), name: 'x' } } });
  await put('a.txt', `id: ${LEGACY_UDID.toUpperCase()}\n`);
  await put('b.md', `team ${TEAM} and ${BUNDLE}\n`);
  await put('c.json', `{"sim": "${SIM_UDID.toLowerCase()}", "configured": "${SIM_UDID.replace('A1B2', 'C3D4')}"}\n`);
  await put(`d/${LEGACY_UDID}.txt`, 'x');
  await git('add', '-A');
  const r = await check();
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.findings.map(f => `${f.file}:${f.rule}`).sort(), [
    'a.txt:saved-id', 'b.md:saved-id', 'c.json:saved-id', 'd/...b4c5.txt:saved-id',
  ]);
  for (const secret of [LEGACY_UDID, TEAM, BUNDLE, SIM_UDID]) assert.ok(!r.stdout.toLowerCase().includes(secret.toLowerCase()), 'output leaked a saved ID');
});

test('check-secrets blocks a signing identity\'s full name, but not the bare kind Xcode is asked for', async () => {
  const names = [['Apple Development', ': Jane Doe (', TEAM, ')'], ['iPhone Distribution', ':Example Co (', TEAM, ')'], ['Developer ID Application', ': Jane Doe (', TEAM, ')']].map(p => p.join(''));
  const r = await stageAndCheck('a.md', names.join('\n') + '\n');
  assert.deepEqual(rules(r), ['signing-identity', 'signing-identity', 'signing-identity']);
  assert.ok(!r.stdout.includes('Jane'));
  await git('rm', '-q', '-f', 'a.md');
  const ok = await stageAndCheck('b.js', "args.push('CODE_SIGN_IDENTITY=Apple Development'); caps['appium:xcodeSigningId'] = 'Apple Development';\n");
  assert.equal(ok.code, 0, ok.stdout);
});

test('check-secrets passes a 40-hex git SHA that is not a saved ID, and runs with no lab state', async () => {
  const r = await stageAndCheck('a.txt', `commit ${'0123456789abcdef'.repeat(3).slice(0, 40)}\n`);
  assert.equal(r.code, 0);
});

test('check-secrets exits 2 with JSON when the lab state is not valid JSON, and quotes none of it', async () => {
  await saveLabState(`{ nope ${LEGACY_UDID}`);
  const r = await stageAndCheck('a.txt', 'x\n');
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /lab state/);
  assert.ok(!r.stdout.includes(LEGACY_UDID));
});

test('check-secrets blocks the real home folder, but not the placeholder ones', async () => {
  const r = await stageAndCheck('a.md', `log at ${HOME}/.config/mobile-safari-lab\n`);
  assert.deepEqual(rules(r), ['home-path']);
  assert.ok(!r.stdout.includes(HOME));
  await git('rm', '-q', '-f', 'a.md');
  const ok = await stageAndCheck('b.md', '/Users/me/repos and /Users/x/.local and /Users/owner/x and /Users/A B/y\n');
  assert.equal(ok.code, 0, ok.stdout);
});

test('check-secrets blocks provisioning profile markers, in text and binary files', async () => {
  const text = await stageAndCheck('p.txt', PROFILE_PLIST);
  assert.deepEqual(rules(text), ['provisioning-profile']);
  const bin = await stageAndCheck('p.bin', Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x00]), Buffer.from(PROFILE_PLIST)]));
  assert.ok(bin.json.findings.some(f => f.file === 'p.bin' && f.rule === 'provisioning-profile'));
});

test('check-secrets scans UTF-16 files for the text rules', async () => {
  const utf16 = s => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  const r = await stageAndCheck('u16.txt', utf16(`id ${REAL_SHAPED_UDID}\n`));
  assert.deepEqual(rules(r), ['device-udid']);
});

test('check-secrets skips a line with the allow marker, and only that line', async () => {
  const r = await stageAndCheck('a.txt', `${REAL_SHAPED_UDID} # msl-allow-secret\nclean\n`);
  assert.equal(r.code, 0);
  const again = await stageAndCheck('b.txt', `${REAL_SHAPED_UDID}\n`);
  assert.equal(again.code, 1);
});

test('check-secrets flags a file too big to scan', async () => {
  const r = await stageAndCheck('big.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
  assert.deepEqual(rules(r), ['oversize']);
});

test('check-secrets --all scans tracked and untracked files that are not ignored, from the working tree', async () => {
  await put('.gitignore', 'ignored.txt\n');
  await put('tracked.txt', 'clean\n');
  await git('add', '.gitignore', 'tracked.txt');
  await put('tracked.txt', `${REAL_SHAPED_UDID}\n`); // an unstaged edit: only --all sees it
  await put('untracked.txt', 'clean\n');
  await put('ignored.txt', `${REAL_SHAPED_UDID}\n`);
  assert.equal((await check('staged')).code, 0);
  const all = await check('all');
  assert.equal(all.code, 1);
  assert.equal(all.json.mode, 'all');
  assert.deepEqual(all.json.findings.map(f => f.file), ['tracked.txt']);
  assert.equal(all.json.scanned, 3);
});

test('check-secrets catches the home folder at the end of a sentence, and not a longer name that starts the same', async () => {
  assert.deepEqual(rules(await stageAndCheck('a.md', `it lives in ${HOME}.\n`)), ['home-path']);
  await git('rm', '-q', '-f', 'a.md');
  assert.equal((await stageAndCheck('b.md', `${HOME}2/x and ${HOME}-other/y\n`)).code, 0);
});

// The edge cases sideload's own tests pin, kept for the port.
test('check-secrets redacts a UDID or a saved ID in a path, keeping the last 4 characters', async () => {
  await saveLabState({ phone: { udid: LEGACY_UDID, teamId: TEAM, bundleId: BUNDLE } });
  await put(`d/${REAL_SHAPED_UDID}.json`, 'x');
  await put(`d/${REAL_SHAPED_UDID}.P12`, 'x');
  await git('add', '-A');
  const r = await check();
  assert.deepEqual(r.json.findings.map(f => f.rule).sort(), ['device-udid', 'device-udid', 'forbidden-extension']);
  assert.deepEqual(r.json.findings.map(f => f.file).sort(), ['d/...B03E.P12', 'd/...B03E.P12', 'd/...B03E.json']);
  assert.ok(!r.stdout.toLowerCase().includes(REAL_SHAPED_UDID.toLowerCase()));
});

test('check-secrets reads a staged path holding a colon as its own blob', async () => {
  await put('t.txt', 'clean\n');
  await git('add', '-A');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const r = await stageAndCheck('0:t.txt', `${REAL_SHAPED_UDID}\n`);
  assert.deepEqual(rules(r), ['device-udid']);
});

test('check-secrets scans a file whose type changed from a symlink', async () => {
  const { symlink, unlink } = await import('node:fs/promises');
  await symlink('target', path.join(root, 'link'));
  await git('add', '-A');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'symlink');
  await unlink(path.join(root, 'link'));
  const r = await stageAndCheck('link', `${PEM_KEY}${REAL_SHAPED_UDID}\n`);
  assert.equal((await git('diff', '--cached', '--name-status')).stdout.trim(), 'T\tlink');
  assert.deepEqual(rules(r), ['private-key', 'device-udid']);
});

test('check-secrets skips a submodule entry instead of failing', async () => {
  await git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`);
  const r = await check();
  assert.equal(r.code, 0, r.stdout);
});

test('check-secrets finds a UDID in binary content past the first 8000 bytes', async () => {
  const r = await stageAndCheck('late.bin', Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.from(`${REAL_SHAPED_UDID}\n`, 'utf16le')]));
  assert.deepEqual(rules(r), ['device-udid']);
});

test('check-secrets exits 2 with JSON on bad usage', async () => {
  let out, code = 0;
  try { await run('node', [SCRIPT], { cwd: root }); } catch (e) { out = e.stdout; code = e.code; }
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(out), { ok: false, mode: null, scanned: 0, findings: [], error: 'usage: check-secrets.mjs --staged | --all' });
});
