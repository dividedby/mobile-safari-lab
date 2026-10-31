// pymobiledevice3, the tool that opens the Wi-Fi tunnel to the phone (issue 15): where it is and
// whether it is new enough. Read-only; nothing here starts a tunnel or touches the phone.
import os from 'node:os';
import path from 'node:path';
import { run } from './core.js';

// The oldest release known to work for the tunnel; a newer one is accepted (the latest is what the install hint asks for).
export const PMD3_FLOOR = '11.40.2';
export const PMD3_VERSION_MS = 10e3;
export const PMD3_HINT = `Run \`brew install uv\`, then \`uv tool install --python 3.14 pymobiledevice3\` (upgrade: \`uv tool upgrade pymobiledevice3\`). Version ${PMD3_FLOOR} or newer is needed for Wi-Fi.`;
export const PMD3_SLOW_HINT = 'The version check timed out, so the tool may be fine and only slow to start: try again before reinstalling.';

// The hint for a failed check: try again for a slow one, the install steps otherwise.
export const pmd3Hint = tool => (tool.slow ? PMD3_SLOW_HINT : PMD3_HINT);

// Where the tool is: MSL_PMD3 (tests), else the folder `uv tool` installs commands into, else
// ~/.local/bin. Never a PATH lookup: another program of that name must not stand in for it.
export function pmd3Path() {
  const given = process.env.MSL_PMD3;
  if (given !== undefined && given !== '') {
    if (!path.isAbsolute(given)) throw new Error('MSL_PMD3 must be an absolute path');
    return given;
  }
  const r = run('uv', ['tool', 'dir', '--bin'], { allowFail: true, timeoutMs: PMD3_VERSION_MS });
  const bin = r.code === 0 ? r.stdout.trim().split('\n')[0] : '';
  return path.join(path.isAbsolute(bin) ? bin : path.join(os.homedir(), '.local', 'bin'), 'pymobiledevice3');
}

const tuple = v => v.split('.').map(Number);

// Whether version `a` is `b` or newer, by numeric parts (11.9.0 is older than 11.40.2).
export function atLeast(a, b) {
  const [x, y] = [tuple(a), tuple(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

// The tool's version (`11.40.2`), or null with the reason it can't be told and its `kind`:
// `missing` (exit 127), `timeout` (no answer within PMD3_VERSION_MS, twice), `failed` (any other
// exit, or output that is not a version). A first timeout is tried once more unless `retry` is
// false: the tool is sometimes just slow to start (issue 60), and a slow tool is not a missing one.
export function pmd3Version(bin, { retry = true } = {}) {
  let r = run(bin, ['version'], { allowFail: true, timeoutMs: PMD3_VERSION_MS });
  if (retry && r.code === 124) r = run(bin, ['version'], { allowFail: true, timeoutMs: PMD3_VERSION_MS });
  if (r.code === 124) return { version: null, kind: 'timeout', error: `${bin} version timed out ${retry ? `twice (${PMD3_VERSION_MS / 1000}s each)` : `after ${PMD3_VERSION_MS / 1000}s`}` };
  if (r.code === 127) return { version: null, kind: 'missing', error: `pymobiledevice3 is not installed at ${bin}` };
  if (r.code !== 0) return { version: null, kind: 'failed', error: `${bin} version failed (exit ${r.code})` };
  const m = /^\d+\.\d+\.\d+/.exec(String(r.stdout).trim());
  return m ? { version: m[0] } : { version: null, kind: 'failed', error: `${bin} version printed something that is not a version` };
}

// { ok, path, version, error?, kind?, slow? }: ok when the tool answers with PMD3_FLOOR or newer.
// A too-old tool still reports its version. `kind` is missing, old, timeout or failed (a bad
// MSL_PMD3 is `failed`); `slow` is true for `timeout`: the tool did not answer, which says
// nothing about whether it is installed or new enough. `retry: false` looks once (at most
// PMD3_VERSION_MS): the lab-side pre-check, so the whole of both checks fits in the tunnel wait.
export function checkPmd3({ retry = true } = {}) {
  let bin = null;
  try { bin = pmd3Path(); } catch (e) { return { ok: false, path: null, version: null, kind: 'failed', error: e.message }; }
  const { version, error, kind } = pmd3Version(bin, { retry });
  if (!version) return { ok: false, path: bin, version: null, kind, error, ...(kind === 'timeout' ? { slow: true } : {}) };
  if (!atLeast(version, PMD3_FLOOR)) return { ok: false, path: bin, version, kind: 'old', error: `pymobiledevice3 ${version} is older than ${PMD3_FLOOR}` };
  return { ok: true, path: bin, version };
}
