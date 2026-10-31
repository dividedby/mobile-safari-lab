# 0004: `lab down`, and resources over always-on

Date: 2026-10-16 · Status: accepted · Partly supersedes [0003](0003-launchagent-health-and-lease.md)

## Context

[0003](0003-launchagent-health-and-lease.md) made the Mac always ready: Appium under launchd
with `RunAtLoad` and `KeepAlive`, and `safari stop` deliberately leaving it running. Nothing
stops the lab again, so after a test the simulator, its window, Appium and (until its TTL
runs out) the lease all stay. The owner decided that the Mac's resources matter more than
having Appium warm: one command should stop everything the lab started, and `lab up` should
bring it back.

## Decision

- **`lab down [--force] [--keep-service]`** in `bin/lab`, built from the same steps as
  `lab up` and reported the same way (`{ok, owner, steps:[{step, found, did, ms}]}`):
  `lease`, `session`, `wda`, `simulator`, `window`, `safaridriver`, `appium`, `release`.
- **Best effort, lease kept on failure.** A failed step is recorded and the later ones still
  run (a stuck simulator shouldn't leave Appium running). Any failure makes the result
  `ok: false` and skips `release`, so the person who retries still owns the simulator. The
  exception is the lease gate: another owner's live lease stops `down` before it touches
  anything (`--force` takes it, as in `lab up`). The check (`lease.check`) reads under the
  mutex and writes nothing; only the last step changes the lease.
- **Idempotent.** A second run finds nothing and does nothing (`did: null`).
- **The session is ended with a short `DELETE`, not `safari stop`.** `stop` waits up to 30 s
  for a dead Appium and skips the pid kill under launchd. `down` asks `/status` first
  (2 s), then deletes with a 10 s bound, and clears the state record either way.
- **Appium is disabled, not just booted out.** `launchctl disable gui/<uid>/<label>` then
  `bootout` (a failed disable fails the step and says the service may start at the next
  login, with the command to run; the exit codes of both are checked): with only a bootout, `RunAtLoad` would start Appium again at the next login,
  which is the always-on behaviour this removes. The plist stays, so `lab up` (through
  `bootstrapIfNeeded`, which already runs `enable` before `bootstrap`) brings it back, and
  `lab service uninstall` is still the way to remove it. `lab service status` words
  "installed but not loaded" as normal after `lab down`. `--keep-service` skips this step.
- **Without the service**, the Appium the lab spawned is stopped by its recorded
  `driverPid`, but only after `ps -o command= -p <pid>` shows its command is Appium (the
  `appium` executable, or `node` running an `appium` script), not merely a command line that
  mentions it such as `vim appium.md` (pids are reused). A pid that runs something else is left alone and dropped from the state; it
  is not an error. A `safaridriver` started for a `--device` session is stopped the same
  way, even with `--keep-service`, which is about the Appium service only. Under launchd a
  recorded Appium pid is never signalled.
- **The window rule.** Simulator.app (Xcode 26 and earlier) and Device Hub (Xcode 27, which
  also shows physical iPhones) are quit only when the lab opened them: `sim boot` and
  `lab up` check `application id "<bundle>" is running` before `open`, and record
  `windowApp` in the state only if it wasn't (or was already recorded as the lab's). `down`
  additionally requires that no simulator at all is booted, then runs
  `osascript -e 'tell application id "<bundle>" to quit'`. An answer it can't read counts
  as "running". It never kills, pkills or killalls anything.
- **What it never touches**: other simulators, Xcode, other node processes, WebDriverAgent
  on the simulator, and a Simulator or Device Hub window a person opened.

- **WebDriverAgent first.** A `wda` step before `simulator` stops the `xcodebuild` that
  Appium started (found by `ps`: parent is Appium's pid, command has `WebDriverAgent`, the
  UDID and a msl-appium path) and a `simctl diagnose` for the UDID, through the same
  command-line guard as the other pids.

## Consequences

- The next `lab up` pays for a cold start: boot the simulator, build and start WebDriverAgent
  (127 to 151 s measured), reset Safari (up to 174 s): 4 to 10 minutes on a loaded 8 GB
  Mac, against 22 to 31 s warm. `lab down` frees about 3 GB there (simulator processes
  3345 MB to 0). That is the trade the owner chose; for a short break `safari stop` keeps
  everything warm. No `--keep-simulator` flag: it would be `safari stop` under another name.
- A cold start exposed two faults in `lab up`, fixed with it. `fetch` gives up on a response
  whose headers take over 300 s, before the session create's own 420 s limit, and `wd`
  called that "not reachable"; waits over 280 s now use `node:http`, and fetch's own
  headers and body timeouts read as "no answer". And Appium can answer the create with a
  500, "remote debugger did not return any connected web applications", because Web
  Inspector shows no pages for about 30 s after a cold boot; the create is tried once more.
- Agents are told to finish with `lab down` (skill, README). `safari stop` alone still ends
  just the session, as before.
- A person who opens Simulator themselves after the lab did, and leaves it, may see it
  quit by a later `lab down` if no simulator is booted: it is the same app and the lab can't
  tell.
- Tests cover this with the recording runner and the stand-in server; the live checks
  (launchd disable and bootout, the real window quit, `ps` on a real pid) are run on the Mac.
