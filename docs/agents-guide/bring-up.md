# Bring it up

Detail for step 3 of [AGENTS.md](../../AGENTS.md).

```sh
sim run <short-label>                       # a run folder for screenshots and logs; the session `lab up` starts next uses it
lab up --target auto --url <http(s) URL>    # or --target device
```

`lab up` checks and repairs everything in order (lease, prerequisites, Appium, phone or
simulator, Safari session, the page) and reports each `step` with what it `found` and `did`. Run
it again whenever something seems stuck; on a healthy setup it changes nothing. Expect:

- **iPhone:** about 50 s the first time (WebDriverAgent is built and installed), 14 to 18 s warm.
  WebDriverAgent is signed again once when under 24 hours are left. Xcode keeps a still-valid profile
  (seen kept with 23.6 h left), so the expiry usually does not move: the run still succeeds, says
  `phone.expiryMoved: false` and gives a `phone.warning` with the expiry in Central time (only on that run). A run that
  goes past it loses WebDriverAgent; the lab does not rebuild again for that expiry, and the first
  `lab up` after it has passed signs again. `--resign` always deletes the build and signs again. Over Wi-Fi a `tunnel` step comes between `phone` and
  `session` (up to 45 s for a new tunnel; none when a live session is reused), and the session
  start also builds (if needed) and launches WebDriverAgent itself, up to 120 s. After a dropped
  tunnel the old session is dropped at once: a session records the tunnel it ran on, and one whose tunnel is gone or
  was replaced is neither probed nor asked to restore the keyboard (a short delete only), so recovery is about the tunnel
  start plus the session create. The output then has `keyboardDeferred` (the new session restores the settings when it
  ends; relay nothing for it) and `previousTab` says the old lab tab was left open because its session was on a tunnel
  that is gone: relay that, the person closes it by hand.
- **Simulator:** 22 to 31 s warm; 4 to 10 minutes cold (after `lab down`). A new simulator's first boot (done by `sim create`, which boots it once and shuts it down; or by `sim reset`'s next boot) takes up to 25 minutes: run `sim create` in the background, since a foreground command is capped at 10 minutes, and `lab up` renews the lease while it waits. A cold `lab up` retries by itself, once, when WebDriverAgent fails to start or Web Inspector lists no pages; if it still fails that way, or with `WebDriver POST /session got no answer in 420s`, the simulator is booted by then, so run `lab up` again. That failure carries `human` and `then` (`lab up --target simulator`), on the failed `session` step and at the top level, like a device `needs` but with no `needs` or `or`: relay `human`, run `then` once, and if it fails the same way again stop and tell the person.

If the output has `labVersion.human`, this checkout of the lab is behind GitHub or not on `main`:
relay those lines to the owner as they are (they say how to update, then to start a new agent
session so the skill reloads), and carry on with the version you have. Never pull or change the
checkout yourself. `labVersion: { checked: false, reason }` means the check could not run
(offline, no repository, a timeout): ignore it. `sim doctor` adds `labVersion` the same way, and
`lab status --check-update` asks GitHub again instead of using the 6-hour cache.

`target` is the id object; `targetType` (`device` or `simulator`) is the plain answer, in `lab up`,
`safari start` and `lab status`'s `session`. The phone's iOS version is `osVersion` (and
`buildVersion`) from `lab phone status` or `lab up`'s `phone` block: Safari's user agent is frozen
at one iOS version, so never read it from there. `lab status` makes no device calls; its `phone.seen`
is what `lab up` or `lab phone setup` last read, with `at`, and its `simulator.runtime` is the
simulator's iOS (for example `iOS 27.0`).

On failure it names the `failedStep`. An `ok: false` that carries `needs` is the table in
[needs.md](needs.md). If the simulator is leased by someone else (`failedStep: "lease"`), tell the person who
holds it and until when (it names the owner and expiry) and wait or ask. An expired lease is
taken over by itself. `lab service install` and `uninstall` take the lease while they run and
hand it back when they end (a lease the caller already held is kept), so they leave none behind.
A lease held by `msl-idle` means the idle stop is shutting the lab down: wait a minute and run `lab up` again.
