// Is this checkout of the lab behind origin? Other repos run bin/* from one checkout (the skill
// is a link into it), so a stale checkout is stale everywhere. This only looks: it never
// pulls, fetches or changes the checkout. Every failure (no git, offline, no remote, a
// timeout) comes back as `{ checked: false, reason }` and never fails a command.
import { run, loadState, saveState, REPO, quote } from './core.js';

export const WAIT = { localMs: 5e3, remoteMs: 5e3, cacheMs: 6 * 3600e3, failCacheMs: 15 * 60e3 };

// git must never stop to ask for a password.
const ENV = { GIT_TERMINAL_PROMPT: '0' };
const SHA = /^[0-9a-f]{40,64}$/;
const SHORT = /^[0-9a-f]{4,64}$/;

// What to tell the owner; empty when the checkout is current and on main.
export function humanFor({ root, local, remote, branch, dirty, behind }) {
  const at = quote(root);
  const lines = [];
  const onMain = branch === 'main';
  if (behind && onMain) {
    lines.push(`The lab at ${root} is out of date (${local} vs ${remote} on GitHub). Run: git -C ${at} pull --ff-only`);
    if (dirty) lines.push('It has uncommitted changes to tracked files; the pull stops until they are committed or stashed.');
    lines.push('Then start a new agent session so the skill reloads.');
  } else if (behind) {
    lines.push(`The lab at ${root} is on ${branch ? `branch ${branch}` : 'a detached HEAD'}, not main, and is out of date (${local} vs ${remote} on GitHub). Run: git -C ${at} switch main && git -C ${at} pull --ff-only`);
    lines.push('Then start a new agent session so the skill reloads.');
  } else if (!onMain) {
    lines.push(`The lab at ${root} is on ${branch ? `branch ${branch}` : 'a detached HEAD'}, not main: other repos run this checkout's code. To go back: git -C ${at} switch main`);
  }
  return lines;
}

// A cached remote answer for this checkout that is still fresh, else null.
function readCache(root, now) {
  const c = loadState().labVersionCache;
  if (!c || typeof c !== 'object' || c.root !== root) return null;
  const at = Date.parse(c.at);
  if (!Number.isFinite(at) || at > now) return null;
  if (typeof c.remote === 'string' && SHA.test(c.remote)) return now - at < WAIT.cacheMs ? c : null;
  if (typeof c.reason === 'string' && c.reason) return now - at < WAIT.failCacheMs ? c : null;
  return null;
}

const remember = cache => { try { saveState({ labVersionCache: cache }); } catch { /* a cache that can't be written is only slower */ } };

// The result for `lab up`, `lab status` and `sim doctor`. `force` skips the cache and asks
// origin again; `root` and `now` are for tests. The local facts (HEAD, branch, dirty, whether
// the remote commit is an ancestor of HEAD) are always read fresh, so a pull is seen at once
// even while the remote answer is cached.
export function labVersion({ force = false, root = REPO, now = Date.now() } = {}) {
  try {
    const git = (args, timeoutMs = WAIT.localMs) => run('git', ['-C', root, ...args], { allowFail: true, timeoutMs, env: ENV });
    const head = git(['rev-parse', '--short', 'HEAD']);
    const local = head.stdout.trim();
    if (head.code !== 0 || !SHORT.test(local)) {
      const reason = head.code === 127 ? 'git is not available' : head.code === 124 ? 'git did not answer in time' : `${root} is not a git checkout`;
      return { checked: false, reason };
    }
    const branch = git(['branch', '--show-current']).stdout.trim() || null;
    const status = git(['status', '--porcelain', '--untracked-files=no']);
    const dirty = status.code === 0 ? status.stdout.trim() !== '' : null;
    const facts = { path: root, local, branch, dirty };

    let cache = force ? null : readCache(root, now);
    if (cache?.reason) return { checked: false, reason: cache.reason, ...facts, cached: true };
    const cached = !!cache;
    if (!cache) {
      const r = git(['ls-remote', 'origin', 'HEAD'], WAIT.remoteMs);
      const sha = r.code === 0 ? r.stdout.trim().split(/\s/)[0] : '';
      if (r.code !== 0 || !SHA.test(sha)) {
        const reason = r.code === 124 ? `origin did not answer within ${Math.round(WAIT.remoteMs / 1000)}s`
          : r.code === 0 ? 'origin returned no HEAD'
            : "couldn't ask origin (offline, or the checkout has no origin remote)";
        remember({ root, at: new Date(now).toISOString(), reason });
        return { checked: false, reason, ...facts };
      }
      cache = { root, at: new Date(now).toISOString(), remote: sha };
      remember(cache);
    }

    const remote = cache.remote.slice(0, local.length);
    // Exit 1: not an ancestor of HEAD; 128: not in the checkout at all. Both mean behind.
    // Anything else (a timeout, a broken repo) is no answer, not a false warning. Needs no network.
    const anc = git(['merge-base', '--is-ancestor', cache.remote, 'HEAD']).code;
    if (anc !== 0 && anc !== 1 && anc !== 128) return { checked: false, reason: 'git could not compare the checkout with origin', ...facts };
    const behind = anc !== 0;
    const out = { checked: cache.at, ...facts, remote, behind, ...(cached ? { cached: true } : {}) };
    const human = humanFor({ root, local, remote, branch, dirty, behind });
    return human.length ? { ...out, human } : out;
  } catch (e) {
    return { checked: false, reason: `the version check failed: ${e.message}` };
  }
}
