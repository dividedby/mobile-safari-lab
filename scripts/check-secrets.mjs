#!/usr/bin/env node
// Secrets guard, after sideload's: keeps key material, provisioning profiles, device and team IDs, signing
// identity names, the owner's home folder and run folders out of the repo.
//
//   node scripts/check-secrets.mjs --staged   files in the index (the pre-commit hook)
//   node scripts/check-secrets.mjs --all      tracked and untracked-not-ignored files (CI)
//
// Prints exactly one JSON object: { ok, mode, scanned, findings }. Findings never echo the matched value.
// Exit 0 clean, 1 findings, 2 internal error.
//
// A line containing `msl-allow-secret` is skipped by every content rule. Tests build fake secrets at
// runtime instead; the fixed fake UDIDs the tests use (PLACEHOLDER_UDID) pass on their own.

import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Every child gets a timeout so a hung process fails loudly instead of stalling the hook.
const run = async (file, args, opts = {}) => {
  const options = { timeout: 30000, killSignal: 'SIGKILL', ...opts };
  try {
    return await execFileAsync(file, args, options);
  } catch (err) {
    if (err.killed) err.message = `timed out after ${options.timeout / 1000} s: ${file} ${args[0] ?? ''}`.trim();
    throw err;
  }
};

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOW_MARKER = 'msl-allow-secret';

const FORBIDDEN_EXTENSIONS = new Set([
  '.p12', '.pfx', '.mobileprovision', '.provisionprofile', '.ipa',
  '.key', '.pem', '.cer', '.der', '.certsigningrequest',
]);
// `runs` holds screenshots, page source and logs of real sessions (gitignored; this catches `git add -f`).
const FORBIDDEN_SEGMENTS = new Set(['runs', 'secrets', 'xcuserdata', 'deriveddata']);
const FORBIDDEN_SEGMENT_SUFFIXES = ['.app', '.xcarchive', '.dsym', '.xcresult'];

const PEM_KEY = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;
// No \b or hex boundaries: adjacent word characters or extra hex must not hide a UDID.
const MODERN_UDID = /0000[0-9a-f]{4}-[0-9a-f]{16}/gi;
// The fake phones of the tests and fixtures: a real UDID's tail is random hex, never these.
const PLACEHOLDER_UDID = /^0000[0-9]{4}-(?:000A1B2C3D4E5F6[0-9A-F]|001A2B3C4D5E[0-9A-F]{4}|0{13}BAD)$/i;
// A signing identity's full name ("Apple Development: <name> (<team>)"): the name can hold an email address, and the
// suffix is a team ID. The bare kind ("Apple Development") Xcode is asked for passes.
const SIGNING_IDENTITY = /(?:(?:Apple|iPhone|Mac) (?:Development|Distribution)|Developer ID (?:Application|Installer)|3rd Party Mac Developer (?:Application|Installer))\s*:\s*[^\n()]{1,80}\(\s*[A-Z0-9]{10}\s*\)/;
const realUdid = text => [...text.matchAll(MODERN_UDID)].some(([m]) => !PLACEHOLDER_UDID.test(m));
// Built at runtime so this file does not hold the literal markers.
const PROFILE_DEVICES = '<key>' + 'ProvisionedDevices' + '</key>';
const PROFILE_TEAM = '<key>' + 'TeamIdentifier' + '</key>';
const PROFILE_EXPIRY = '<key>' + 'ExpirationDate' + '</key>';

function parseMode(argv) {
  if (argv.length !== 1 || !['--staged', '--all'].includes(argv[0])) throw new Error('usage: check-secrets.mjs --staged | --all');
  return argv[0].slice(2);
}

async function git(root, args, opts = {}) {
  const { stdout } = await run('git', args, { cwd: root, encoding: opts.buffer ? 'buffer' : 'utf8', maxBuffer: MAX_BYTES + 1024 * 1024 });
  return stdout;
}

const splitZ = s => s.split('\0').filter(Boolean);

// The IDs the lab saved for this Mac (lib/core.js stateDir: MSL_STATE, else ~/.config/mobile-safari-lab): the phone's
// UDID, team and bundle id, and the simulators' UDIDs. Lowercased; none when there is no state.
async function loadSavedIds() {
  const dir = process.env.MSL_STATE || join(homedir(), '.config', 'mobile-safari-lab');
  let raw;
  try {
    raw = await readFile(join(dir, 'state.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A state that can't be read means the exact-match check can't run: fail loudly (exit 2), quoting none of it.
  let s;
  try { s = JSON.parse(raw); } catch { throw new Error('the lab state (state.json) is not valid JSON; cannot check the saved IDs'); }
  const ids = [s?.udid, s?.phone?.udid, s?.phone?.teamId, s?.phone?.bundleId, ...Object.values(s?.profiles ?? {}).map(p => p?.udid)];
  return [...new Set(ids.filter(id => typeof id === 'string' && id.length >= 8).map(id => id.toLowerCase()))];
}

// The owner's own home folder (`/Users/<name>/`): the placeholder ones the docs and tests use don't count.
const PLACEHOLDER_HOMES = new Set(['/users/me', '/users/x', '/users/owner', '/users/a b', '/users/you']);
function homePath() {
  const h = homedir().replace(/\/+$/, '').toLowerCase();
  return /^\/users\/[^/]+$/.test(h) && !PLACEHOLDER_HOMES.has(h) ? h : null;
}
const hasHome = (lower, home) => home !== null && new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![^/\\s"'\`),;:.])`).test(lower);

function checkPath(file, savedIds) {
  const out = [];
  const lower = file.toLowerCase();
  const segments = lower.split('/');
  const name = segments.at(-1);
  // A bare dotfile like `.p12` has no extname, so the whole name is compared too.
  if (FORBIDDEN_EXTENSIONS.has(extname(name)) || FORBIDDEN_EXTENSIONS.has(name)) {
    out.push({ file, rule: 'forbidden-extension', message: 'file type is reserved for keys, certificates and profiles' });
  }
  if (basename(name).startsWith('.env')) out.push({ file, rule: 'forbidden-filename', message: 'env files must not be committed' });
  if (segments.slice(0, -1).some(s => FORBIDDEN_SEGMENTS.has(s) || FORBIDDEN_SEGMENT_SUFFIXES.some(x => s.endsWith(x)))) {
    out.push({ file, rule: 'forbidden-path', message: 'path is inside a run folder or a secrets or build folder' });
  }
  if (realUdid(file)) out.push({ file, rule: 'device-udid', message: 'path holds something that looks like an Apple device UDID' });
  if (savedIds.some(id => lower.includes(id))) out.push({ file, rule: 'saved-id', message: 'path holds an ID saved in the lab state' });
  return out;
}

// Findings never echo an ID, even inside a file's path: the last 4 characters are kept.
function redactPath(file, savedIds) {
  const mask = m => `...${m.slice(-4)}`;
  let out = file.replace(MODERN_UDID, mask);
  for (const id of savedIds) out = out.replace(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), mask);
  return out;
}

function checkContent(file, buf, savedIds, home) {
  const out = [];
  const binary = buf.includes(0);
  // Binary or UTF-16 content is read as a NUL-stripped latin1 view, so ASCII inside it is still seen. Line numbers
  // only mean something for text files.
  const text = binary ? buf.toString('latin1').replace(/\0/g, '') : buf.toString('utf8');
  const lines = text.split('\n').map(l => (l.includes(ALLOW_MARKER) ? '' : l)); // allowed lines keep their numbers
  const at = i => (binary ? {} : { line: i + 1 });
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (PEM_KEY.test(line)) out.push({ file, ...at(i), rule: 'private-key', message: 'PEM private key block' });
    if (realUdid(line)) out.push({ file, ...at(i), rule: 'device-udid', message: 'looks like an Apple device UDID' });
    if (savedIds.some(id => lower.includes(id))) out.push({ file, ...at(i), rule: 'saved-id', message: 'matches an ID saved in the lab state' });
    if (SIGNING_IDENTITY.test(line)) out.push({ file, ...at(i), rule: 'signing-identity', message: 'a signing identity\'s full name (it names a person and a team)' });
    if (hasHome(lower, home)) out.push({ file, ...at(i), rule: 'home-path', message: 'holds this Mac\'s home folder; use a placeholder such as /Users/me' });
  });
  const all = lines.join('\n');
  if (all.includes(PROFILE_EXPIRY) && (all.includes(PROFILE_DEVICES) || all.includes(PROFILE_TEAM))) {
    out.push({ file, rule: 'provisioning-profile', message: 'holds provisioning profile markers' });
  }
  return out;
}

// Staged paths mapped to their index entries. Reading by blob id (not `:<path>`) means a path like `0:t.txt`
// can't be taken for stage 0 of `t.txt`.
async function stagedEntries(root) {
  const entries = new Map();
  for (const rec of splitZ(await git(root, ['ls-files', '-s', '-z']))) {
    const tab = rec.indexOf('\t');
    const [mode, oid, stage] = rec.slice(0, tab).split(' ');
    if (stage === '0') entries.set(rec.slice(tab + 1), { mode, oid });
  }
  return entries;
}

async function readStaged(root, entry) {
  if (!entry) throw new Error('a staged file has no stage-0 index entry (an unresolved conflict?)');
  if (entry.mode === '160000') return null; // a submodule: no content
  const size = Number((await git(root, ['cat-file', '-s', entry.oid])).trim());
  if (size > MAX_BYTES) return { size };
  return { size, buf: await git(root, ['cat-file', 'blob', entry.oid], { buffer: true }) };
}

async function readWorking(root, file) {
  let st;
  try { st = await lstat(join(root, file)); } catch (err) {
    if (err.code === 'ENOENT') return null; // tracked but deleted
    throw err;
  }
  if (!st.isFile()) return null; // symlinks, submodules
  if (st.size > MAX_BYTES) return { size: st.size };
  return { size: st.size, buf: await readFile(join(root, file)) };
}

let knownIds = []; // so an error's text (which can quote a path) is redacted too

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const root = (await run('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const savedIds = await loadSavedIds();
  knownIds = savedIds;
  const home = homePath();
  let files, entries;
  if (mode === 'staged') {
    files = splitZ(await git(root, ['diff', '--cached', '--name-only', '--diff-filter=d', '-z']));
    entries = await stagedEntries(root);
  } else {
    const tracked = splitZ(await git(root, ['ls-files', '-z']));
    const untracked = splitZ(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
    files = [...new Set([...tracked, ...untracked])];
  }
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    findings.push(...checkPath(file, savedIds));
    const data = mode === 'staged' ? await readStaged(root, entries.get(file)) : await readWorking(root, file);
    if (!data) continue;
    scanned++;
    if (!data.buf) {
      findings.push({ file, rule: 'oversize', message: `file is over ${MAX_BYTES} bytes and was not scanned` });
      continue;
    }
    findings.push(...checkContent(file, data.buf, savedIds, home));
  }
  for (const f of findings) f.file = redactPath(f.file, savedIds);
  return { ok: findings.length === 0, mode, scanned, findings };
}

function emit(result, code) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = code;
}

try {
  const result = await main();
  emit(result, result.ok ? 0 : 1);
} catch (err) {
  const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--staged') ? 'staged' : null;
  emit({ ok: false, mode, scanned: 0, findings: [], error: redactPath(String(err?.message ?? err), knownIds) }, 2);
}
