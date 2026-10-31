# 0003: Appium as a LaunchAgent, `lab up` for health, and an advisory simulator lease

Date: 2026-10-15 · Status: accepted, partly superseded by [0004](0004-lab-down.md) (Appium is no longer always on: `lab down` stops it) (real-Mac acceptance passed, all items; item 7's initiating session was a short-lived process, not an ended Claude Code session; item 8 ran as a minor node upgrade) · Builds on [0002](0002-appium-for-the-simulator.md)

## Context

The Mac is always on, logged in and unlocked, and Claude Code sessions reach it over SSH.
After [0002](0002-appium-for-the-simulator.md) three things stood in the way of "a remote
session gets a working Safari with one command and nobody at the Mac":

- Appium was a child that `safari start` spawned; nothing restarted it when it died.
- Nothing healed a session whose Safari, simulator or session had gone away.
- Nothing stopped two agents from driving the same simulator and trampling each other's
  session.

## Decision

- **Appium runs as a per-user LaunchAgent** (`com.dividedby.msl-appium`, `gui/<uid>`
  domain, `RunAtLoad`, `KeepAlive`, 5 s `ThrottleInterval`), installed by
  `lab service install`. The `gui` domain is the one that can reach the simulator. launchd
  rather than spawning Appium on demand: an on-demand child dies with whatever started it
  and has no supervisor, so the first command after any crash pays for a cold start and
  races with other callers; launchd restarts it within seconds, keeps one copy, and
  survives the end of the SSH or Claude session that installed it. The cost is that it
  needs the user's login session (a fixed assumption here) and is one more thing to
  install. While the plist exists, `safari start` and `lab up` never spawn Appium: they
  load the agent if needed, wait up to 60 s (kicking it once at 30 s) and fail with the log
  path. Without the plist the spawn path from 0002 is unchanged. Port 4723 is fixed.
- **The plist names an absolute `node`** that survives Homebrew upgrades: `/opt/homebrew/bin/node`,
  or the first non-Cellar `node` symlink on `PATH`, when it leads to the node running the
  install; otherwise the running node, resolved. Never the versioned Cellar path. A node
  major upgrade (or moving node) may still need `lab service install` again; `lab service
  status` reports the recorded `node` and flags one that no longer exists.
- **`bin/lab` is a third entry point**, not more verbs on `sim` and `safari`. Health spans
  launchd, simctl, Appium and the session, and imports both `sim.js` and `safari.js`; a
  separate tool keeps their verbs and imports as they were.
- **`lab up` is idempotent and reports each step** (`lease`, `prerequisites`, `appium`,
  `simulator`, `session`, `open`) as what it *found* and what it *did*. Recovery is
  **recreate, not repair**: if the recorded session fails a probe (in Safari's page, then
  `GET /url`), the stale session is deleted (best effort), the state cleared and a new
  session created (about 1 to 2 minutes). One code path then covers all four failure modes
  (Appium killed, Safari killed, simulator shut down, session deleted) instead of one repair
  per cause. The probe changes context only when it has to, because every context switch
  adds a Web Inspector listener and so duplicate console entries.
- **The lease is a file** `lease.json` (`{owner, since, expires}`, default 15 min,
  `MSL_LEASE_TTL`) in the state dir, changed only inside a `mkdir` mutex and written by
  temp file and rename. A bare `O_EXCL` create cannot do takeover of an expired lease
  safely; with the mutex, create, renew and takeover are one critical section across
  processes. A stale mutex (older than 10 s) is cleared; waiting is bounded at 3 s.
  The lease is enforced centrally by hooks in `cli()` (`before` takes it, `after` renews it,
  `safari stop` releases it) from one list per tool, so handlers stay directly callable and
  `lab up` holds the lease itself. Every `safari` command is guarded (they share one
  session and even `url` switches context); of `sim`, the ones that change the phone;
  read-only ones are not. Takeover has no `--force` on `sim` and `safari`, because
  `parseArgs` would read the next word as the flag's value; it is `lab up --force` or
  `lab release --force`, and the refusal message names them.
- **Owner** is `MSL_OWNER`, else `CLAUDE_CODE_SESSION_ID`, else `user@host:tty` (`notty`
  without a terminal): stable for one agent across separate CLI invocations. Shells without
  a terminal share one owner; `MSL_OWNER` overrides.

## Consequences

- The lease is **advisory**: it binds these three tools and nothing else (raw `simctl`, raw
  Appium HTTP). It also cannot tell that an agent died, so a new agent is refused for up to
  one TTL; `--force`, which the skill tells agents to use only after asking the person,
  covers that. The alternative, a liveness signal, would need a daemon.
- `lab up` can take up to about 14 minutes in the worst case (a cold WebDriverAgent build),
  inside one TTL because the lease is renewed after every step.
- `msl-appium.log` is not rotated. `launchctl print` output is not documented, so state and
  pid are read with tolerant patterns (acceptance item 0 checks them on the Mac).
- Tests cover all of this with fakes (a recording `launchctl`/`simctl` runner and a stand-in
  Appium); behaviour under real launchd is the Phase 2 acceptance checklist in
  [docs/acceptance.md](../acceptance.md).

## Not decided here

Phase 3 (artifacts, bootstrap script injection, the Userscripts app) and Phase 4 (a
physical iPhone) remain as listed in 0002.
