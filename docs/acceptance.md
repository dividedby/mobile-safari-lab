# Acceptance checklist (milestone 1: Appium backend)

Run by the owner on the Mac (Xcode 27, iOS 27 simulator). Record pass/fail, the run folder
and any surprises here, then update the README's Status. Run the proof-of-concept items
(3 to 12) three times each. Targets: a local dev server (a one-line `python3 -m http.server`
page with a text input is enough) and the Minute Cryptic Plus puzzle.

- [x] **1. Tests and tools:** `pnpm test` is green. `sim doctor` returns `ok: true` and lists `appium`.
- [x] **2. Simulator:** `sim create` on a fresh list picks the newest iPhone, not iPhone 11. `sim boot` opens Device Hub and exits 0.
- [x] **3. Session:** the first `safari start` (cold, about 2 minutes) returns a session. A second `safari start` says `reused: true`. A separate shell reattaches. `lsof -iTCP:4723 -sTCP:LISTEN` shows `127.0.0.1` only.
- [x] **4. Open and UA:** `safari open http://127.0.0.1:<port>/` loads; `safari eval navigator.userAgent` contains `Mobile Safari`; `safari eval "(()=>{const x=1;return x})()"` returns 1.
- [x] **5. Inject:** `safari inject x.user.js` works. After `safari refresh` the injected global is gone. After `safari refresh --reinject` it is back. Also check `safari open <url>#frag` on the same page returns promptly.
- [x] **6. Console:** `safari console` after `safari eval "console.error('x')"` shows exactly one entry and no `127.0.0.1:8100` noise, also after about 20 `tap`/`keys` commands (one entry, not one per context switch). A second call is empty.
- [x] **7. Network:** `safari network` after an `open` with a cookie set lists the requests. `grep -iE 'cookie|authorization' network.json` shows only `[redacted]`, and a `?token=...` in a URL shows `[redacted]`.
- [x] **8. Tap and keys:** `safari tap 'input'` shows the keyboard (check `tap`'s `x`, `y`, `page` and `calibration` against a `safari shot`; no `msl-probe` element is left in the page afterwards); `safari keys "Hello"` (straight after the `tap`) types all five letters, first one included, and produces trusted events (`isTrusted` true) with auto-capitalisation. `safari keys $'\b'` deletes a character. `safari keys` on a page with no focused field refuses. The address bar never changes (`sim shot`).
- [x] **9. Swipe:** `safari swipe up` moves `scrollY` above 0; `safari swipe down` brings it back.
- [x] **10. UI tree:** `safari ui` saves `ui.xml` and lists labels.
- [x] **11. Correlation:** the dev server's access log shows the request with `?run=MARK` and an iPhone user agent.
- [x] **12. Minute Cryptic Plus:** `safari tap` and `safari keys` put nonsense letters only into a cell, then clear them. Leave the puzzle unsolved.
- [x] **13. Stop:** `safari stop` ends the session, and Appium only if `safari start` launched it (without the service; with the LaunchAgent installed, launchd's Appium keeps running). `safari start --device <UDID>` is not tested in this milestone.

## Result: 2026-10-15, macOS 27.0.1, Xcode 27.0 (27A266a), iOS 27.0 (24A434) "Claude iPhone" (iPhone 11 type)

All 13 items pass. Items 3 to 11 were scripted (27 checks per pass): the last three passes on
the final code were 27/27 each. Run folders: `runs/20261015-*-acceptance-pass-3{1,2,3}`,
`runs/20261015-002215-minute-cryptic-final`.

- **2:** with Xcode 27's device list `pickDevice` picks iPhone 18 Pro. The existing sim
  (created before the fix) is still an iPhone 11 type.
- **3:** a cold `safari start` took 1:14 with WebDriverAgent already built once (2:05 the very
  first time).
- **8:** the probe calibration found the page 48 pt below the top of Safari 27's full-screen
  web view, scale 1. `document.hasFocus()` is false in the simulator whenever its window isn't
  frontmost, so `keys` checks the active element instead (ADR 0002).
  Sending a whole word in one `mobile: keys` call dropped characters (5/6 correct), which is
  why `keys` sends one character at a time (6/6). `mobile: keys` with "\b" delivers nothing,
  which is why Backspace taps the keyboard's delete key.
- **9:** in one earlier pass `swipe down` left `scrollY` at 176 instead of 0: the swipe up's
  momentum scrolled further than the swipe down undid. Expected iOS behaviour.
- **12:** tapping an answer box opened the system keyboard through the script's hidden
  field; nonsense letters went in and were deleted with `safari keys \b…'`. The puzzle was
  left unsolved and empty. The puzzle's "par" marker moved one dot during the session (no
  hints or checks were used).
- **13:** `safari stop` ended the session and left the Appium server running, since it was
  started by hand, not by `safari start`.
- Keys reliability, idle wait and console copies, found live on iOS 27 (iPhone 18 Pro Max):
  - Before: every native action took about 21 s (WebDriverAgent waited 10 s before and
    after for Safari to go idle, which it never does); `tap` then `keys hello` gave "Hello"
    2 times in 5, otherwise a dropped or uncapitalised first letter; a dropped key fires
    `keydown` but never `input`, and some land up to about 0.9 s late. Each switch into the
    page added a console and network listener in Appium for good: one `console.error` came
    back 837 times and 10 distinct ones returned only 6 (the 5000-entry buffer evicts).
  - After (`waitForIdleTimeout` 0, per-character check in the web context, run folder
    `runs/20261015-keys-verify-live6`, fresh session): 27/27 `keys hello` `ok: true` with 5
    characters, no retries (26 "Hello", 1 "hello": iOS did not auto-capitalise), 3.8 to
    10.6 s (median 4.0 s); `tap` 1 to 3 s (`runs/20261015-keys-verify-live`). After 10 `keys` runs a message is stored 2
    times, not about 80; 10 distinct messages all came back. Select-on-focus field 5/5;
    Backspace, Backspace at the caret's start, `--no-verify` and the refusal on a number
    field as documented; 6000 logs gave `truncated: true` with the note; network still
    redacts cookie and authorization. Earlier rounds: `runs/20261015-keys-verify-live`
    (late presses doubled), `-live2` (43/43), `-live3` (selection; the listener finding).
- Tap mapping, found live on iOS 27 (run folder `runs/20261015-101013-tap-zoom-check`):
  - Safari's toolbar at the top: passes (calibration y=122, all targets hit, swipes scroll).
    The chrome guard only matches the Address field; the other controls are protected
    because they lie outside `area`.
  - Page zoomed: failed before the fix. The probe's size is rounded to whole points (45x46
    for a scale-0.449 page), so the scale was off by up to about 2%: on a page with no
    viewport meta (980 px wide) 6 of 14 taps on 24 px bars missed, and even at scale 1 a
    bottom tap was 6 px low. On a zoomed-in (`initial-scale=2` or pinch) and scrolled page
    the fixed probe was not at the visible corner (its rect was (-100, -300)), so
    calibration y was -190 or -734 instead of 62: taps went to y=-336 or hit BODY and swipes
    started off screen and scrolled nothing, all with `ok: true`.
  - After the fix (mapping anchored on the probe's measured client position, scale from
    `visualViewport.scale`, refusal when the probe is off screen), run folder
    `runs/20261015-113213-tap-zoom-live3`: no-meta page 12/12 bars logged (b2 to b13; worst 2.5 CSS px off);
    `initial-scale=2` scrolled to (100, 300) 5/5 (0 px); pinch-zoomed 1.394 and scrolled 5/5
    (2.1 px); scale 1 top and bottom fixed bars hit (0 px); Compact layout 5/5; toolbar at
    the top 3/3 (calibration y=122). `scaleFrom` was `visualViewport` on every tap, no
    refusals, and swipes scrolled in every case. Two intermediate attempts failed live and
    are worth knowing: Appium drops a top-level `scale` key from an `execute/sync` result
    (so the visual viewport is returned nested), and a zoomed, scrolled page's fixed probe
    is not at its CSS position or at `visualViewport.offsetLeft/Top` in client coordinates
    (so its measured rect anchors the mapping); `runs/20261015-110924-tap-zoom-live2`.
- No context switches (issue 7), live on iOS 27, run folder `runs/20261015-235706-issue7-live`:
  - Probed first: from the web context `mobile: source` returns the native tree (about
    0.35 s with attributes excluded, 1.1 s with the keyboard up), the probe's XML rect equals
    its native rect (scale 1, `initial-scale=2` scrolled, no-meta), the Application node is
    the screen (440x956; the web context's `/window/rect` is the CSS window), W3C `/actions`
    still scrolls, and `mobile: tap` on the keyboard's delete key deletes one character.
  - Fresh session, twice: 20/20 taps (worst 3.0 CSS px), 5 swipes all scrolled, `ui` ok,
    the session stayed in `WEBVIEW_*`, and one `console.error` came back exactly once (raw
    log size 1). In the first run `keys zq` failed with the old 10 s read timeout (below);
    only the second run's Backspace succeeded and left one character. Tap matrix: no-meta 4/4,
    `initial-scale=2` scrolled 3/3, scale 1 fixed bars 2/2, pinch-zoomed 1.299 and scrolled
    4/4 (worst 1 px), toolbar at the top 4/4 (calibration y=122) with swipes scrolling.
  - Found on the way: a `keys` field read sometimes waits more than 10 s for Safari's Web
    Inspector (11.8 s seen) right after a key press, which failed `keys` with "not
    reachable"; reads now wait up to 30 s and a timeout says Appium may be busy or stuck.

# Acceptance checklist (Phase 2: reliable remote availability)

Run on the Mac by a Claude Code session over SSH (the point of this phase), after
`git pull` of the Phase 2 branch and with the simulator created (`sim create`). A manual
`nohup` Appium is expected on 127.0.0.1:4723 at the start: item 0 replaces it. Record
pass/fail, run folder, timings and surprises in the Phase 2 Result section below, then update
the README's Status. Unit tests (`pnpm test`) cover the logic with fakes; none of this was
run on a Mac when the code was written.

Setup for the script (`J` picks a field from JSON on stdin):

```sh
J() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o=JSON.parse(s);console.log(eval("o."+process.argv[1]))})' "$1"; }
UDID=$(sim udid | J udid); L=com.dividedby.msl-appium
```

- [x] **0. Service.** `lab service install` with the manual Appium still running: refused, naming its pid. Then `lab service install --replace`: ok, `replaced` is that pid.
  - `plutil -lint ~/Library/LaunchAgents/$L.plist` is OK; the plist has no `relaxed` or `insecure`.
  - `lab service status`: `loaded` true, `state` running, a `pid`, `reachable` true, `issues` empty, and `node` is `/opt/homebrew/bin/node` (a stable path, not `.../Cellar/node/<version>/...`). If the `launchctl print` fields come back null, the output format differs from the patterns in `lib/service.js`: record it.
  - `lsof -nP -iTCP:4723 -sTCP:LISTEN` shows `127.0.0.1` only.
  - Run `lab service install` again (idempotent: it rewrites the plist and reloads). `lab service uninstall`, then `lab service install` again.
  - Do this from the SSH session, not only from a Terminal on the Mac: `bootstrap gui/<uid>` needs the logged-in GUI session.
- [x] **1. Appium killed.** `lab up | J steps` gives a session. `kill $(lab service status | J pid)`; `sleep 1; lab up`: the `appium` step's `did` mentions launchd, the `session` step's `did` is a new session; `safari eval 1+1` is 2. Repeat with `kill -9`.
- [x] **2. Safari killed.** `xcrun simctl terminate $UDID com.apple.mobilesafari`; `lab up`: the `session` step finds the session dead and creates a new one; `safari open http://127.0.0.1:8000/` works. If the probe wrongly calls the session healthy, record it: the planned tightening is a trivial `execute` (`return document.readyState`) in the probe.
- [x] **3. Simulator shut down.** `sim shutdown`; `lab up`: the `simulator` step's `did` is `booted (was Shutdown)`, then a new session (about 1:14 with WebDriverAgent built).
- [x] **4. Session deleted.** `curl -s -X DELETE http://127.0.0.1:4723/session/$(safari start | J session)`; `lab up`: found dead, new session.
- [x] **5. Idempotence.** `lab up` twice: the second shows `did: null` everywhere and `reused: true`; `safari console` shows no duplicate growth from the probe (the probe switches context only when it must).
- [x] **6. Lock contention.**
  - `MSL_OWNER=agent-a lab up`.
  - `MSL_OWNER=agent-b safari url`: `ok:false`, names agent-a, the expiry and `lab release --force`; no `fail.png` is written. `MSL_OWNER=agent-b sim tap 1 1` is refused too.
  - `MSL_OWNER=agent-b sim shot x` and `MSL_OWNER=agent-b lab status` work.
  - `MSL_OWNER=agent-a MSL_LEASE_TTL=5 sim appearance light; sleep 6; MSL_OWNER=agent-b sim appearance light`: ok, with `lease.tookOver` = `agent-a`.
  - `MSL_OWNER=agent-b safari stop` releases it (`lab status` shows `lease: null`).
  - `MSL_OWNER=agent-a lab up; MSL_OWNER=agent-b lab up --force` takes a live lease (`did` says forced). `lab release --force` clears it.
- [x] **7. Survives the initiating session.** Record `lab service status | J pid` and the session id (`safari start | J session`); end the Claude session and drop the SSH link; from a fresh login the pid is unchanged and the simulator is still `Booted` (`xcrun simctl list devices | grep $UDID`). A new session's `lab up` is refused while the old lease is unexpired (expected, up to 15 minutes); `lab up --force` then reuses or recreates the session; `safari eval 1+1` is 2. *First run had three deviations (old session idle, not ended; refusal not observed; no pid recorded beforehand); a recheck observed the refusal and the unchanged pid and session id, with a short-lived process as the initiating session. See the Result.*
- [x] **8. Node upgrade.** After a `brew upgrade node` patch release, `lab service status` still shows `loaded`, `reachable` and no `issues` (the plist uses `/opt/homebrew/bin/node`). After a major upgrade the README's advice applies: run `lab service install` again. *Run as a minor upgrade (26.11.1 to 26.12.0; no patch release was pending); the major-upgrade path was not exercised. See the Result.*

## Result (Phase 2): 2026-10-15, macOS 27.0.1, Xcode 27.0, iOS 27.0, "Claude iPhone" (iPhone 18 Pro Max)

Run by Claude Code over the desktop app's SSH link. All items pass. 7 passes with one
deviation left: the initiating session was a short-lived process with its own `MSL_OWNER`
that exited, not a Claude Code session ended with its SSH link dropped. 8 was a minor
upgrade (26.11.1 to 26.12.0), not a patch, and the major-upgrade path was not exercised.

- **0:** `lab service install` refused the manual Appium (named its pid); `--replace` took
  over. Plist lints, no relaxed/insecure flags, `node` = `/opt/homebrew/bin/node`, listening
  on 127.0.0.1:4723 only. Reinstall, uninstall and install again all worked. The `launchctl
  print` fields parsed (`loaded`, `state`, `pid`).
- **1:** after `kill` and `kill -9`, launchd had Appium back within 1 s, so the `appium` step
  found it reachable; `lab up` replaced the dead session in 15 to 18 s; `eval 1+1` = 2.
- **2:** Safari terminated in the sim: the probe found the session dead ("Missing parameter:
  appIdKey") and a new one was made in 17 s.
- **3:** `sim shutdown`: booted in 4.5 s, then the new session took 206 s (WebDriverAgent is
  installed again on a freshly booted device). 211 s in all.
- **4:** session deleted: found dead, replaced in 13 s.
- **5:** a second `lab up` changed nothing (`session alive`, 10 ms); two more `lab up`s added
  no duplicate console entries.
- **6:** all lease checks pass; refusals print the holder and expiry in local time and leave
  no `fail.*` artifacts.
- **7:** taken over from a second Claude Code session while the first one (which ran items
  0 to 6) was still open but idle; it could not be closed, so "end the session and drop the
  SSH link" was not literally done. The first session's lease had already expired, so the
  new session's `lab up` refusal was not observed; `lab up --force` reported `took over
  expired lease of <old owner>`, found Appium reachable, the simulator booted and the
  session alive (`reused: true`; every step after `lease` had `did` null). `lab status` then showed the new
  session as the lease owner (`mine: true`); `safari eval 1+1` = 2. `lab service status`:
  `loaded`, `running`, `reachable`, no `issues`; Appium's parent is launchd
  (`ps -o ppid= -p <pid>` prints 1) and it had been up about 9 hours, so it does not depend
  on any Claude or SSH session. No pid or session id was recorded before the takeover, so
  "pid unchanged" rests on that uptime rather than a before/after comparison. Still listening on 127.0.0.1:4723 only.

  Recheck at 23:24 CT (`runs/20261015-232403-item7-recheck`): a separate process with
  `MSL_OWNER=item7-initiator-<id>` ran `lab up` (took over the expired lease, made a new
  session in 115 s) and `safari start`, then exited; Appium's pid (41056, parent 1) and the
  session id were recorded right after. From this Claude Code session, `lab up` was refused
  with `failedStep: "lease"`, naming the initiator, its expiry (23:41 CT), `lab release --force` and
  `lab up --force`. `lab up --force` reported `forced lease from item7-initiator-<id>` with
  every later step `did` null; `safari start` returned the same session id, `safari eval 1+1`
  = 2, the pid was still 41056 with parent 1, the simulator still `Booted`, and Appium still
  listened on 127.0.0.1:4723 only.
- **8:** 23:26 CT (`runs/20261015-232628-item8-node-upgrade`): `brew upgrade node` went from
  26.11.1_1 to 26.12.0 (a minor release; no patch release was pending; it also upgraded the
  `simdjson` dependency) and removed the old Cellar folder. Some outputs below were only seen
  on the terminal and are transcribed in the run's `notes.txt`. The running Appium (still on the deleted binary) stayed `loaded`, `running`,
  `reachable` with no `issues`, and `safari eval 1+1` = 2. After `kill <pid>`, launchd had a
  new Appium up in 3 s (parent 1), running `Cellar/node/26.12.0/bin/node` through the
  `/opt/homebrew/bin/node` path in the plist; `lab service status` showed `loaded`, `running`,
  `reachable`, no `issues`. `lab up` replaced the dead session in 30 s, `safari eval 1+1` = 2,
  listening on 127.0.0.1:4723 only. No `lab service install` was needed.

# Acceptance: `lab down`

- [x] **Stop and start again.** `lab up`, `lab down --keep-service` (Appium stays loaded), `lab up`, `lab down` (Appium disabled and booted out), `lab status`, `lab down` again (no-op), `lab up` (re-enables and loads Appium), `safari eval 1+1`.

## Result: 2026-10-16, macOS 27.0.1, Xcode 27.0, iOS 27.0, "Claude iPhone"

First run 00:41 CT (`runs/20261016-004127-lab-down-live`): `lab down` worked, but the
`lab up` after it failed at 300 s (`fetch failed`: Node fetch's headers limit while a cold
Web Inspector came up). Fixed by waiting on that one call with `node:http`, and one retry
when Web Inspector lists no pages.

Re-run 16:06 CT with the fixed build (`runs/20261016-160635-lab-down-live2`): every step
`ok`.
- Cold `lab up` (Appium disabled overnight): session created in 396 s, past the old 300 s
  limit. Warm-Appium `lab up` after `lab down --keep-service`: 224 s. `lab up` after a full
  `lab down`: 224 s, the LaunchAgent re-enabled; `safari eval 1+1` = 2.
- `lab down`: ended the session, stopped the WebDriverAgent `xcodebuild`, shut the simulator
  down, disabled and booted out Appium. Loaded, Appium took 90 MB and the simulator 244
  processes (5085 MB); after `lab down` both were 0 and no `xcodebuild` remained.
- `lab status` after `lab down`: service not loaded, with the note that this is normal and
  how to load it; simulator `Shutdown`; no session, no lease. A second `lab down` changed
  nothing (`did` null in every step).

# Acceptance: iPhone

Run by the owner, or by Claude Code on the Mac, on the physical iPhone (see
[0005](adr/0005-physical-iphone-via-appium.md)). Unit tests (`pnpm test`) cover the logic with
fakes. The first live pass was the field-test re-check of 2026-10-18 (Result below); items it did not cover stay open. Record pass/fail, run folder, timings and surprises in a
Result section below, then update the README's Status. Use fake or placeholder values in what
you write down: no UDID, team id, Apple ID or device name. Before and after each run, note the
lab tab count (the ids from `/contexts`, ids only) and `xcrun simctl list devices | grep -c Booted`
(the simulator must not change).

- [ ] **1. Cable.** `lab phone setup --udid <UDID> --team <TEAMID>`, then `lab up --target device --url <public page>`: `transport` is `cable`, the lab opened its own tab, and the lab tab count is one more than before. `safari eval`, `tap`, `keys` (note `caseChanged`), `swipe`, `console`, `network` (only the lab page's sites), `shot` work. `lab down` closes the tab (count back to before), leaves no `xcodebuild` for the phone, and the simulator is untouched.
  *Checked 2026-10-18 on cable (iOS 27.0.1, `runs/20261018-195725-iphone-fieldfix-recheck` and `runs/20261018-195735-session`): `lab up` cold start 41 s, session 37 s; `eval`, `tap`, `keys`, `network` and `shot` worked; `lab down` gave `tabClosed: true`, nothing on :4723, no WebDriverAgent `xcodebuild`, and the owner's tabs were unchanged. Not checked: `swipe`, `console` (see 15 and J below), the tab and Booted counts, or that the simulator was untouched.*
- [ ] **2. Wi-Fi.** Same run with the cable out: `transport` is `wifi`. Note the per-call latency against item 1.
  *Checked 2026-10-18 over Wi-Fi once Private Wi-Fi Address was Off for the network (`runs/20261018-210009-session`; see the Wi-Fi result below). Per-call latency was not recorded.*
- [ ] **3. Locked phone.** `lab up --target device` on a locked phone returns `needs: "unlock"` with `human`, `then` and `or`. Unlock, run again: passes.
- [ ] **4. Unplugged and off the network.** `needs: "cable"` with `then` and `or`; no hang (well under a minute). `lab up --target simulator` works.
- [ ] **5. Another tab.** Switch tabs by hand mid-session: the next command refuses with `needs: "tab"` and the owner's tab is never read (the access log and the Appium log show none of its URL or title). Switch back: `safari start` is needed if the run was tainted.
  *Checked 2026-10-18 (cable): the real behavior differs from this item. Switching to another tab pauses the lab: `url` and `eval` still answered from the lab's own background page, `tap` was refused with `needs: "tab"` and did nothing on screen, the run was not tainted, and switching back continued; `safari start` reused the session. Only when the lab's own tab changed under it (the owner navigated it by hand to another site) did `url` return `needs: "tab"` ("no longer carries its marker") and taint the run; then `safari start` gave `recovered: true`, `previousTab` and `keyboardRestored: true`. Not checked: the access and Appium logs for the owner's tab URL.*
- [ ] **6. Forced re-sign.** `lab up --resign`: `wdaExpires` moves later, the session works, and the phone's app list shows no new lab app (no new app ID).
- [ ] **7. Idle 5 minutes** (auto-lock on) on cable and on Wi-Fi: record what happens. A lock mid-session gives `needs: "unlock"`.
- [ ] **8. Simulator fallback.** `lab up --target simulator` end to end. During a device session `sim tap`, `sim shot` and the other mutators refuse, naming `safari ...` or `safari stop`.
- [ ] **9. `lab down` twice.** The second changes nothing (`did: null` everywhere). `ps` shows no `xcodebuild` for the phone and Appium is stopped.
- [ ] **10. Keychain.** The first signing from a non-GUI session (SSH) returns `needs: "keychain"` rather than hanging.
- [ ] **11. P8, closing the tab.** On `safari stop`: does the timer-armed `window.close()` close the lab tab (`tabClosed: true`, the page id gone from `/contexts`), or does Safari block it and the tab end blank (`blanked: true`)? Record `closeRace` if it appears. With a debug-level Appium and the log filters, count (counts only): "We do not appear to have window set yet" at least 1 after arming; "Selecting page", "Initializing page" and "Debugger already selected page" 0; unredacted URLs 0. The owner confirms only the lab tab closed. Count the `XCUIElementTypeWebView` nodes and the `TabBarItemTitle` nodes outside the web view in `safari ui`. Delete that log afterwards.
- [ ] **12. Redaction.** At the default log level, `grep` of Appium's log for the lab URL and page title finds none, and `lab service status` shows no issues. With the old plist (no filters) `safari start --target device` refuses with `needs: "service"`.
  *Partly checked 2026-10-18: Appium's log (info level, filters on) held 0 unredacted site URLs after the session. The old-plist refusal and the page title were not checked.*
- [ ] **13. Off-site redirect.** `safari open` a page that redirects to another origin: refused with `needs: "tab"`, the token never lands in the other page, and the other origin is not printed.
- [ ] **14. Lab tab count over a long run.** After about 20 page commands with the owner switching tabs a few times, the lab tab count is still one more than before and `safari stop` leaves it back to the starting count (or says plainly `tabClosed: false` and what to do).
  *Partly checked 2026-10-18: 24 `safari open` calls across 11 origins, every one ok with 0 `needs`, and no `markRetried`; 1 to 5 s each. Tab counts were not recorded.*
- [ ] **15. Keyboard settings.** During a session Settings > General > Keyboard shows Auto-Correction and Predictive off (WebDriverAgent did that). After `lab down` (and after `safari stop`), `keyboardRestored: true` and Settings > General > Keyboard shows Auto-Correction and Predictive on. With `lab phone setup ... --autocorrection off` only Predictive comes back on. Kill Appium mid-session, then `lab down`: `keyboardRestored: false` with the `human` step and no session started for it; a second `lab down` says nothing about the keyboard.
  *Checked 2026-10-18 (the first two sentences, default settings): during the session the owner saw Auto-Correction and Predictive off; after `lab down`, `keyboardRestored: true` and the owner saw both on. Not checked: `safari stop` alone, `--autocorrection off`, the killed-Appium case.*
- [x] **16. Wait** (issue 20), on the phone and on the simulator. (1) A page that shows a card after 2 s: `safari wait '.card' --visible` returns in about 2 s (`elapsedMs`, `polls`). (2) `safari wait --settled` on a lazy-loading page, then `safari shot`: no blank cards. (3) A spinner that is removed, and one that is only hidden, both satisfy `safari wait .spinner --gone`. (4) A selector that never matches: `ok: false` at the limit (`--timeout 3000`), no `needs`, and on the simulator `fail.png`. (5) On the phone, switch tabs by hand during a `wait`: it ends with `needs: "tab"` ("did not answer within 10s", a pause), the run is not tainted, and `url` works after switching back. (6) `safari open <url> --settle`, then `safari shot`. Also note the per-poll cost over Wi-Fi (`elapsedMs` against `polls`).
  *Checked 2026-10-19 on the phone (cable) and the simulator; see "Result: 2026-10-19" below. Not run: the per-poll cost over Wi-Fi.*
- [x] **17. Shot crop and scale** (issue 22), on the phone (the `--page` geometry on iOS 27 was never checked live). (1) `file` on a plain phone `safari shot` and on a cut one: colour type 2 or 6, 8-bit; a cut file keeps the source's colour profile (sRGB IEC61966-2.1 on iOS 27.0.1, not Display P3; open it in Preview: Tools > Show Inspector, or `sips -g profile`). (2) `safari shot a --page` with the full toolbar showing (after a load) and `safari shot b --page` with the pill (after scrolling): neither has the status bar or any toolbar, and no page content is cut off; compare `crop` and `points` (`area`, `inset`, `crop`) with the picture and say which edge is wrong if one is. Also with the address bar at the top, if the phone is set that way. (3) `safari shot c --element '.card'` on a card wholly in view: just the card, edges to the pixel; `--element '*' --text Buy` the same; a card half off the screen is refused (`not wholly inside`), and one under the toolbar is refused. (4) `safari shot d --page --width 600`: 600 px wide, sharp enough to read, `scale` equals 600 over the crop width; `--scale 0.5` half. (5) Leave the lab's tab during a shot (switch tabs by hand): `needs: "tab"` (a pause), no file, the run is not tainted and the next command works after switching back. (6) Zoomed in by pinch, `--page` still matches what is on the screen. Note `elapsedMs` by eye: a cut shot is two page reads and a native tree read each, plus the picture.
  *Checked 2026-10-19 on the phone (cable): (1) to (4) and (6) pass; (5) first refused with `needs: "tab"` and wrote no file, but the run was tainted (the finding fixed after it), and passed on the re-check that evening: `needs: "tab"`, untainted, ok after switching back. See "Result: 2026-10-19, items 16 to 18" and "Result: 2026-10-19 (evening)" below. Not checked: the address bar at the top (the phone's is at the bottom).*
- [ ] **18. Storage and log redaction** (issue 21, PR 34), on the phone and on the simulator. Use a dummy value such as `CANARY-<4 hex>`, never a real secret. (0) Before `lab service install`: `lab up --target device` and `safari open <url> --storage k=CANARY-…` both say `needs: "service"` (rules older than the code). Run `lab service install`; `lab service status` lists no issues. (1) `safari open <url> --storage k=CANARY-…` from another site (`storage.extraLoad: true`) and again from the same site (`extraLoad: false`), on a page that reads the key at start: the page sees the value; the output and `run.log` show the key and count only. (2) `--storage` with a `#fragment` target from another site: the page's scripts run after the write (the page shows the value). (3) After a `safari type`, a `safari keys` and a storage open, `grep -c CANARY ~/Library/Logs/msl-appium.log` is 0, and `grep -c CANARY` over the run folder is 0. (4) `safari open <url> --storage=k=CANARY-…`: refused by position, the value nowhere in the output. (5) On the phone the lab's tab stays pinned (`safari url` after the storage open works, no `needs: "tab"`).
  *Partly checked 2026-10-19 on the phone and the simulator: (1) to (5) pass. Step (0) was not run (the service was already installed).*
- [x] **19. Page pin** (issue 37), on the phone, owner present, on the Mac only. A tab the owner opens never receives a lab script and Appium never attaches to it. (1) `cd ~/.local/share/msl-appium && pnpm add link:<repo>/appium-plugin`; `APPIUM_HOME=~/.local/share/msl-appium ~/.local/share/msl-appium/node_modules/.bin/appium plugin list --installed` lists `msl-page-pin`; the owner runs `lab service install`; `lab status` shows no issues (this also checks the manifest fields Appium 3.8 needs and that it finds the plugin through the link). (2) `lab up --target device` (or `safari start --device <UDID>`): ok; the state has `pagePin: 1`; Appium's log has `msl-page-pin: armed session=...`. The negative case (no plugin, so no marker, so refused) is unit-tested and not run on the phone. (3) Note the lab page id from the state (`deviceTab.page`). Run for about 5 minutes: `for i in $(seq 40); do safari open https://example.com/?a$i; safari eval 'return document.title'; safari open https://example.org/?b$i; safari eval 'return 1'; done`. Meanwhile the owner, at random moments, opens a new tab (+, then a bookmark), opens a link in a new tab, closes those tabs, and twice switches to another tab for about 15 s and back. (4) Pass, from Appium's log for the run's time span: zero `We have new pages, selecting page` and zero `Debugger already selected page` (the stock handler's lines); every `Selecting page '<n>'` and every `msl-page-pin: evaluate page=<n>` has `<n>` = the lab page id; `msl-page-pin: listing changed ... not following` lines appear at the moments tabs were opened; no `msl-page-pin:` refusal; every lab command is ok or a pause (`did not answer within 10s`, untainted); no `markRetried`; no tainted `needs: tab`; the new tabs are untouched (Safari on the Mac, Develop, the phone, the new tab: `window.name` is empty). (5) `safari stop` with the owner on the lab's tab: `tabClosed: true`, no `Debugger already selected page` line. The slow-close race can't be forced live (the stand-in test covers it). (6) `lab down`. Record the results below with times in CT. After a change to the xcuitest driver or Appium version, run this item again: the plugin relies on the driver's internals.
  *Checked 2026-10-19, 15:33 to 15:39 CT, on the phone by cable (iOS 27.0.1), owner present: two loops of `open`/`eval`, 280 commands, all ok, 0 `We have new pages, selecting page` and 0 `Debugger already selected page`, every `msl-page-pin: evaluate page=` was the lab page, no refusal, no taint. See "Result: 2026-10-19 (evening)" below for the numbers. Not recorded there: the `window.name` check of the new tabs, step (5) and the no-plugin refusal (unit-tested only).*
- [ ] **20. Idle stop** (issue 40), on the Mac, phone and simulator. Use `MSL_IDLE_MINUTES=2` in the shell that runs `lab service install` so it takes minutes, not a quarter hour; never run `lab down --idle` by hand as the test. (1) `lab service install`: `idleStop.installed: true`; `plutil -lint ~/Library/LaunchAgents/com.dividedby.msl-idle.plist`; `launchctl print gui/$(id -u)/com.dividedby.msl-idle` shows `run interval = 300 seconds`, `state = not running` and no pid between runs; `lsof -iTCP -sTCP:LISTEN` shows nothing new; `lab status` shows `idleStop.installed` and `loaded` true and no issues. (2) In use: `lab up --target device`, then a `safari eval` every minute for 6 minutes (at least one tick falls inside): nothing is stopped, `~/Library/Logs/msl-idle.log` gets no line and `idleStop.last` stays unset. (3) Idle: `safari stop`, wait 2 minutes plus up to 5: Appium, WebDriverAgent (`ps` for the phone's `xcodebuild`) and the service are gone, `idleStop.last.ok: true` with `steps`, the log has one `[idle] stopped the lab after 2 min idle` line, the lab's tab on the phone is closed, the keyboard settings are back on, and `lab status` shows `idleMinutes`. `lab up --target device` brings everything back (cold). (4) Simulator: boot the Claude iPhone with `lab up --target simulator` (it was Shutdown), `safari stop`, wait: the simulator is `Shutdown` afterwards. Boot it by hand with `xcrun simctl boot <udid>` first, then `lab up`, `safari stop`, wait: Appium stops but the simulator stays `Booted` (`steps[simulator].found` says `not booted by the lab: left alone`). Another booted simulator is never touched. (5) Race: start a `lab up` at the moment of a tick (watch `launchctl print` for `state = running`, or set `StartInterval` low in a copy): either `lab up` is refused with `The idle stop is shutting the lab down` and works a minute later, or the stop reports `idle: false`; never a half-stopped lab. `lab up --force` during a stop ends it early with `someone took the lab over`. (6) Phone unreachable: end a device session, unplug the cable and turn Wi-Fi off on the phone, wait for a tick: the stop finishes the Mac side, `idleStop.last.tabLeft` and its `human` step name the tab left open, and `lab down` afterwards says the keyboard note once. (7) `lab service install --no-idle-stop` removes the agent (`launchctl print` says not found); `lab service uninstall` removes both plists. Record the results below with times in CT.
- [ ] **21. Simulator profiles, phase 1** (issue 25), on the Mac, simulator only; nothing here touches the phone. (1) `sim create --profile configured`: a second device named `Claude iPhone (configured)`, the clean one unchanged; `sim profile status` lists both, `lab status` shows `configuredSimulator`. (2) `lab up --profile configured`: with the clean one booted it is shut down first (`xcrun simctl list devices | grep -c Booted` is 1 at the end), `steps[simulator].did` says so, the session target is the configured UDID. (3) By hand in the Simulator window, sign in to a throwaway test site (never an Apple ID), then `lab down`, `lab up --profile configured`: still signed in (this is the `appium:noReset` check; the driver scrubbed Safari at every session before, and if the cookie is gone `noReset` did not do what it should). (4) `lab up` with no flag after `lab down`: clean, logged out, and the sign-in is not visible there; `sim reset` on it still works. (5) `lab up --profile configured`, then `lab up` with no flag while that session is live: the session is kept; `lab up --profile clean` then: refused with `a session is already open`, nothing shut down. (6) `sim reset --profile configured` and `sim reset` while the profile is configured are both refused; `sim reset --profile configured --yes` erases it (do this last). (7) Idle: `lab up --profile configured`, `safari stop`, wait for the idle stop: the configured simulator is `Shutdown`. Booted by hand first, it is left alone. (8) Look at what a `sim shot` of the signed-in session shows before keeping it. Record the results below with times in CT.
- [ ] **22. First boot** (`fix/first-boot`: the new-device warm-up, the long first-boot limit and the shorter Appium timeouts), on the Mac, simulator only; nothing here touches the phone. Run the long steps in the background (`sim create` can take 25 minutes). (1) `sim create --profile configured` (or `sim reset` on clean first) on a loaded Mac: it boots the device, waits, shuts it down and returns `warmed: true` with no `shutDown` unless the other profile was up; `state.json` has no `unwarmed` entry for it and no `simBoot`; the time it took is the first-boot migration (about 11 minutes was seen). (2) The `lab up --target simulator --profile configured` that follows reaches a session in under 60 s of boot plus the usual session time, not the 4 to 10 minutes of a cold first boot. (3) Kill the `bootstatus` child of a running warm-up (`pkill -f 'simctl bootstatus'`) at the 150 s mark: `sim create` reports a failure with the `sim boot` hint, the device stays saved and unwarmed, and `sim boot` then attaches to the boot still going (does `bootstatus -b` re-attach after a piece is cut? Record what it did) and clears the marker. (4) Press Ctrl-C during a warm-up: one JSON object with `interrupted`, exit 130, the lease and the saved device kept, the marker still there. (5) `sim reset` marks the device again: the next `sim boot` is allowed 1500 s (watch the lease renewed between pieces with `lab status`), and a boot of an already-warmed device is cut at 600 s. (6) The first session after `lab down` on a freshly warmed device (and after a `derivedData` wipe) comes up: WebDriverAgent gets 30 s per launch attempt, which Appium polls for 72 to 120 s, twice, so Appium's own error arrives within about 370 s, before the lab's 420 s. If the first try fails, the lab retries once (`did` says `retried after WebDriverAgent failed to start` or `... Web Inspector listed no pages`, which now also covers "returned N web applications, but none of them had pages") and the second try succeeds; `sim shot` right after a boot may return `scale: null` with a `note` (or the saved scale), never a failure. Record the times. Result so far: see 2026-10-20 below; this item stays open until the next live run with the 30 s caps.
- [ ] **23. WebDriverAgent on loopback only** (issue 51, `fix/wda-loopback-51`: `appium:wdaBindingIP` `127.0.0.1` in both cap sets), on the Mac, phone and simulator. (1) Phone: with a session open, `curl -m 3 http://<phone Wi-Fi IP>:8100/status` fails (it answered before the fix), and `lab up --target device`, `safari open`, `eval`, `tap`, `keys` and `shot` work over the cable and over Wi-Fi (the usbmux forward must reach WebDriverAgent on the phone's loopback; if a session now fails to start, this is the first suspect). (2) Simulator: with a session open, `curl -m 3 http://<Mac LAN IP>:8100/status` fails while `curl -m 3 http://127.0.0.1:8100/status` answers, and the session works. (3) `lsof -iTCP:8100 -sTCP:LISTEN` on the Mac shows `127.0.0.1:8100`, not `*:8100`, during a simulator session.
  - Result 2026-10-20, phone by cable (Private Wi-Fi Address Fixed): (1) passes over the cable. `lab up` 56 s, `eval` returned the title, the Appium log shows WebDriverAgent "binding IP address: 127.0.0.1", port 8100 on the phone's Wi-Fi and link-local addresses refused (lockdown's 62078 open on both, as the control), the Mac's forward listens on `127.0.0.1:8100` only, `lab down` closed the tab and restored the keyboard. Wi-Fi over usbmux not run (the owner chose to retire it for the tunnel, issue 15). (2) and (3) not run: simulator work is parked until the Mac upgrade.
- [x] **24. Walk-up Wi-Fi** (issue 15, `feat/wifi-tunnel-pr2`: the tunnel host, `lab tunnel`, WebDriverAgent over the tunnel), on the Mac and the phone, owner present. Cable out, Private Wi-Fi Address "Fixed", Connect via network on, `lab service install` done, pymobiledevice3 11.40.2 or newer. `lab up --target device`: `phone.transport` is `wifi`, `phone.via` is `tunnel`, the `tunnel` step started the host, `lab status` shows the tunnel up. Time a warm `lab up` (target about 20 s) and the cold one; note the per-call latency against item 1's cable run.
  *Checked 2026-10-23 on the phone over Wi-Fi, cable out: `phone status` gives `transport: wifi`, `via: tunnel`, and the `tunnel` step started the host. Warm `lab up` 25 s; cold 3 min (it re-signed WebDriverAgent). Per call: `open` 1.6 s, `eval` about 240 ms, `shot` 0.8 s. See "Result: 2026-10-23" below. A warm Wi-Fi `lab up` took 24 s in the late re-check ("Result: 2026-10-23 (late)").*
- [x] **25. Nothing reachable from the LAN.** With a Wi-Fi session open: `curl -m 3 http://<phone LAN IP>:8100/status` is refused or times out, and `curl -g -m 3 'http://[<tunnel address>]:8100/status'` answers from the Mac. `lsof -nP -iTCP -sTCP:LISTEN` shows only `127.0.0.1` listeners for Appium and the registry, and none for pymobiledevice3 (check the tool's pid too: `lsof -nP -a -p <pid> -i`).
  *Checked 2026-10-23: passes. See "Result: 2026-10-23" below.*
- [x] **26. Wrong device refused.** With an Apple TV (or a second phone) on the network: the tunnel host connects only to the saved phone. If the tool picks the other device, the `tunnel` step fails with `needs: tunnel` (reason `wrong-device` in `lab tunnel status`) and the tool is gone.
  *Checked 2026-10-23 (late): passes. With an Apple TV connected to CoreDevice on the network, `start-tunnel` without `--udid` opened the tunnel to the Apple TV three times in a row, and each time the lab refused it (`needs: tunnel`, `wrong-device`) and the tool was gone afterwards. PR 70 starts the tunnel with `--udid <saved phone>` (pymobiledevice3 floor 11.40.2); with the Apple TV still on, the tunnel reached the phone. See "Result: 2026-10-23 (late)" below.*
- [ ] **27. Clean after `lab down` and the idle stop.** After `lab down` (and, separately, after the idle stop with `MSL_IDLE_MINUTES=2`): `lab tunnel status` says none, no `lab-tunnel-host` process runs, `ifconfig` shows the same `utun` interfaces as before the run, and the registry key `~/Library/Application Support/appium-xcuitest-driver-nodejs/strongbox/tunnelRegistryPort` is back to its old value (or gone if it was absent). `ps` shows no `xcodebuild` for the phone.
  *Checked 2026-10-23 after `lab down` only: passes. The idle stop was not run, and the `utun` list was compared with the one during the run, not before it. See "Result: 2026-10-23" below.*
- [ ] **28. Over SSH.** `ssh localhost` from another machine or Terminal session: `lab up --target device` works (the tunnel host runs in the `gui/<uid>` domain; the tool under launchd needs nothing from the SSH shell).
- [x] **29. Phone asleep 10 minutes.** Lock the phone and leave it for 10 minutes, then run a page command and `lab up`. Record what happens (`needs: unlock` or `needs: tunnel`, and how long recovery takes).
  *Checked 2026-10-23: partial. `lab up` said `needs: unlock`, then recovered in 22 s; the page command said `needs: tab` (issue 59).*
  *Re-run 2026-10-23 (late), after the issue 59 fix: passes. Locked 10 min: `safari eval` gave `needs: unlock` in 11 s, with "the session is still good", and no stderr. `lab up` gave `needs: unlock` in 10 s, keeping the session. After unlocking, the same session answered in 1 s and `lab up` reused it (`reused: true`).*
- [x] **30. Wi-Fi off and on.** Turn the phone's Wi-Fi off for a minute, then on, with a session open: the next command says `needs: tunnel`; after the Wi-Fi is back `lab up --target device` recovers. Time it.
  *Checked 2026-10-23: fails. The next command said `needs: tab`, not `tunnel` (issue 59); the first `lab up` after said `needs: tunnel-tool` (issue 60); the second recovered in 63 s (issue 62).*
  *Re-run 2026-10-23 (late), after the issue 59 and issue 62 fixes: passes. Wi-Fi off: `safari url` gave `needs: tunnel` in 13 s and `safari eval` in 10 s, with no stderr. `lab tunnel status` gave `reaches: false` ("the phone does not answer through the tunnel"). `lab phone status` gave `needs: tunnel`. Wi-Fi on: `lab up` took 36 s (63 s before the fix). The session step said "its route to the phone is gone (its tunnel was replaced)" and replaced the session with no 10 s probes. `previousTab` named the old tab once, `keyboardDeferred` was set, and the later `lab down` gave `keyboardRestored: true`.*
- [x] **31. Mac sleep.** Sleep the Mac with a Wi-Fi session open, wake it, run a command: either it works or it says `needs: tunnel` and `lab up` recovers. Record which.
  *Checked 2026-10-23: the command said `needs: tab` (issue 59); `lab up` recovered in 77 s with a new tunnel.*
  *Re-run 2026-10-23 (late): passes, for a short sleep. The Mac slept 16 s (23:09:40 to 23:09:56 CT). Afterwards the tunnel was still up, the page command worked in 1 s, and `lab up` reused the session. A longer sleep that kills the tunnel goes down the item-30 path (`needs: tunnel`, then `lab up` replaces the session); it was not run.*
- [x] **32. Re-sign over the tunnel.** `lab up --target device --resign` (after `safari stop`) with the cable out: WebDriverAgent is built and signed over the tunnel (`msl-wda-device.log`), the session works, no new app ID appears.
  *Checked 2026-10-23: passes. 72 s, same bundle id, no trust prompt.*
- [ ] **33. First-run passcode prompt.** On a phone that has not run UI automation lately, `lab up` over Wi-Fi: the first WebDriverAgent start asks for the passcode on the phone; the lab's wait ends in `needs: passcode` with the steps if it is not entered, and works after it is.
- [ ] **34. CoreDevice stuck.** When `devicectl` hangs (`lockState` times out while the device list says connecting) over Wi-Fi: the lab restarts CoreDeviceService once and says so (`did` starts `restarted CoreDeviceService`, `coreDeviceRestarted: true`); the command goes on, or fails with `needs: tunnel` after the one restart. Xcode's connection to the phone drops briefly and comes back.
- [ ] **35. No root-owned files.** After items 24 to 34: `find ~ -user root -newer <time of item 24> 2>/dev/null` finds nothing in the home folder, and `lab` run as root refuses (`refusing to run as root`).
  *Checked 2026-10-23: no root-owned files under `~` newer than the run. Not run: `lab` as root (this session cannot run commands as root).*
- [x] **36. The cable still works with the tunnel stopped.** `lab tunnel down`, cable in, Wi-Fi off on the phone: `lab up --target device` is `transport: cable`, `via: usbmux`, with no `tunnel` step, and `appium:wdaBindingIP` `127.0.0.1` in the Appium log. With a tunnel left up and the cable in, `lab up` stops it first (the `tunnel` step says the cable was chosen).
  *Checked 2026-10-23: passes after the issue 58 fix (PR 65). With a tunnel up and the cable in, `lab up` stopped the tunnel and chose the cable. With the tunnel down, the cable in and Wi-Fi off, `lab up` gave `transport: cable`, `via: usbmux` and no `tunnel` step in 22 s, and the Appium log had `appium:wdaBindingIP` `127.0.0.1`. See "Result: 2026-10-23" below.*
- [ ] **37. Appearance and orientation on the phone** (issue 27), iPhone, owner present, over the cable and over Wi-Fi. (1) `safari appearance dark`: the output has `prior`, `changed: true`; Settings > Display & Brightness shows Dark; an open page's `matchMedia('(prefers-color-scheme: dark)').matches` is true with no reload; `lab status` shows `phone.pendingRestore: ["appearance"]`; `safari appearance status` agrees. Then `safari stop`: `phoneRestored: true`, `restoredExactly: false`, the phone shows the original mode, and **Automatic is still on** if it was. Repeat through `lab down`, through the idle stop (`MSL_IDLE_MINUTES=1`), and through `kill -9` of the lab process followed by `lab up` (the `phone-settings` step puts it back before the new session) and by `lab down`. (2) `safari orientation landscape`: Safari reports `innerWidth > innerHeight`; `safari orientation portrait` back. With the phone lying flat, and with it upside down, `safari stop` returns it to the reading it had (face up stays face up; upside down comes back as portrait with `restoredExactly: false`). Does the argv `orientation set <value> --device <udid>` work as the lab sends it, and does a flat phone read `deviceOrientation` as the value just set (it is how the lab confirms a change)? (3) Portrait Orientation Lock on: `safari orientation landscape` is `ok: false` with "Portrait Orientation Lock is probably on" and a `human` step, and nothing is left in `phone.pendingRestore`. (4) Phone locked at `safari stop`: stop still succeeds with `phoneRestored: false` and a `human` step, the record stays in `lab status`, and after unlocking `lab phone restore` (or the next `lab up` / `lab down`) puts it back. (5) Change the mode by hand after the lab set it, then `safari stop`: your value is left, `ownerChanged: true`. (6) The NYT Games Dark script follows the switch live (closes the issue 17 gap). (7) Landscape: `safari shot --page`, `tap`, `swipe` and `keys` (untested; the crop only trims top and bottom). (8) `lab up --appearance dark --orientation landscape` end to end, then `lab down`.
  *Checked 2026-10-24, 00:38 to 00:46 CT, iPhone over Wi-Fi (main @ 3090b52), owner present, phone on Automatic (dark at night): (1) `safari appearance light`: `prior: "dark"`, `changed: true`, the note about Automatic; the open page's `prefers-color-scheme: dark` went false with no reload; `lab status` showed `pendingRestore: ["appearance"]`. `safari stop`: `phoneRestored: true`, `restoredExactly: false`, the phone back to dark, and the owner confirmed **Automatic still on**. Crash path: `appearance light`, then `kill -9` of Appium, then `lab up`: the `phone-settings` step put back appearance before the dead session was replaced; the phone read dark. (2) `safari orientation landscape`: 814x430 `landscape-primary`; restored to portrait at `safari stop` (`restoredExactly: true`). In landscape `shot`, `shot --page` (crop 2442x1290, the notch side trimmed; iOS draws the home indicator over the page bottom), `swipe up` and `tap a` worked; `lab down` restored the orientation. (3) Portrait Orientation Lock on: `ok: false`, "Portrait Orientation Lock is probably on" with the `human` steps, nothing left pending. Not run: the idle stop, the phone lying flat or upside down at stop, a locked phone at stop, and the cable.*
- [ ] **38. Lab Focus during phone runs** (issue 16), iPhone, owner present, with the Focus "Lab" and the shortcuts "Lab Focus On" / "Lab Focus Off" made as the README says. (1) `lab up --target device --url <page>`: the `focus` step runs before `session`, `focus: {applied: true, verified: false}`, the Focus Lab is on (the status bar shows its icon in a plain `safari shot`, not in `shot --page`), and the lab's tab is the one showing (the Shortcuts app is not left over it). (2) **A Reminders alert (or another test notification) shows no banner** while the session runs. Which exceptions still break through (calls, people allowed in the Focus, Time Sensitive)? (3) `safari stop`, `lab down`, the idle stop (`MSL_IDLE_MINUTES=1`) and `kill -9` of the lab process followed by `lab down` (or `lab up`): Lab Focus is off afterwards (`phoneRestored: true`, `restoredExactly: false` with the note), and Focus is off after a failed `lab up` (a failed `lab up` before the session opens turns it off itself; a locked phone leaves it on and says so; with the session open `safari stop` does it). (4) Phone **locked** at `safari stop` and at the idle stop: no passcode prompt appears, nothing is launched, `phoneRestored: false` with a `human` step, `lab status` lists `pendingRestore: ["focus"]`; after unlocking, `lab phone restore` (or the next `lab up`, which runs Off then On) turns the Focus off. (5) Phone locked at `lab up`: the usual `needs: unlock`, no shortcut. (6) With the shortcut renamed or deleted: `lab up` still works and says what happens (`focus.applied: true, verified: false`: the Shortcuts app shows its own error; the lab cannot tell); with the Shortcuts app missing, `focus: {applied: false, needs: "shortcut"}` and the steps. (7) `lab up --no-focus` and `lab phone setup --focus off`: no shortcut runs. (8) Over Wi-Fi (no cable) and over the cable. (9) Share Across Devices: does your Mac or iPad go quiet too? (10) The Shortcuts app is in front on the phone after the stop; the lab's tab is closed. (11) `lab phone focus test` (phone unlocked, no session): the Lab Focus icon shows and the output says to look for it; `lab phone focus off` turns it off; on a locked phone neither launches anything and both say to unlock. (12) If the Focus was already on before `lab up`, `lab down` turns it off (known, documented).
  *Checked 2026-10-24, 09:59 to 10:20 CT, iPhone over Wi-Fi (main @ 12adf2c), owner present: `lab phone focus test`: the first try failed with CoreDeviceError 4000 (connection could not be established) reported as `needs: unknown`; a retry worked (issue 81). The Lab Focus came on, the status bar icon showed, and the Lock Screen showed it at the bottom. A Reminders alert during Focus first broke through as Time Sensitive; after the owner set the Lab Focus to silence all apps, a second alert showed nothing. `lab phone focus off`: off. `lab up --target device`: the `focus` step ran before `session`; the Lab Focus came on, and Safari with the lab's tab was in front, not Shortcuts. `lab down` with the phone locked: no passcode prompt; the Focus stayed on, `pendingRestore: ["focus"]`, and the `human` step said to unlock and run `lab phone restore` (the keyboard restore also couldn't run on the locked phone: `keyboardRestored: false` with its human step; that is existing behaviour). After unlocking, `lab phone restore` turned the Lab Focus off and nothing was left pending. Not run: the Focus being off after a failed `lab up` (it couldn't be triggered safely), the idle stop, `kill -9`, and the cable.*
- [x] **39. The signing lock shared with sideload** (issue 63, PR 66), on the Mac and the phone, owner present. (a) While sideload holds `$SIDELOAD_HOME/.op.lock`, `lab up --target device` stops with `needs: "busy"` and its `human` line, opens nothing on the phone, and turns the Lab Focus off again if it had turned it on. (b) While `lab up` is creating its session, a sideload command that takes the lock (`sideload fetch --app stremio-ios`) is refused with `OPERATION_IN_PROGRESS`, and `lab up` still finishes `ok`. (c) The lab's signing identity is the one sideload pinned for the free team (fingerprint prefixes compared locally, not posted).
  *Checked 2026-10-24, about 10:27 to 10:40 CT, iPhone over Wi-Fi, lab 0.7.0, sideload main @ 0e6651f (results on issue 63). (b) passed: `lab up` was ok, with a new session in about 16 s and the Lab Focus applied; `sideload fetch` returned `OPERATION_IN_PROGRESS`. (a) passed: sideload's own `provision`/`sign` hold the lock only 2 to 9 s, too short to race by hand, so the lock was held for 60 s with the same `flock` call sideload's `FileLock` makes. `lab up` stopped at `session` with `needs: "busy"` and nothing opened on the phone; the Lab Focus it had turned on was off afterwards (owner checked the phone), and `lab status` showed nothing pending. (c) matched. A busy stop costs 8 to 20 s of setup (Appium, tunnel, Focus) before the lock is tried; checking the lock first would fail faster.*
  - [x] (d) The early check (Unreleased): with sideload holding the lock (the same 60 s `flock`), `lab up --target device` stops within about a second at a `signing lock` step (`found: "held by sideload"`, `failedStep: "signing lock"`, `needs: "busy"`) with no Appium start, no tunnel and no Lab Focus shortcut on the phone; `--target auto` stops after the `phone` step the same way; with the lock free the steps show `signing lock` found `free` and the run finishes `ok`; a live session reused while sideload holds the lock has no `signing lock` step.
    *Checked 2026-10-25, about 09:40 to 10:30 CT, as part of item 41 (lab @ 677e99c, iPhone over Wi-Fi). With the lock held for 60 s (a perl `flock`, as in (a)), `lab up --target device` stopped at `signing lock` (`found: "held by sideload"`, `failedStep: "signing lock"`, `needs: "busy"`) in 0.5 s, with no Appium start, no tunnel and no Lab Focus shortcut. `--target auto` stopped the same way after the `phone` step, in 3.8 s. In the cleanup, a second `lab up` with the lock held reused the live session and had no `signing lock` step. With the lock free, the lend run (finished 09:54:54 CT) and the cleanup `lab up` both showed the `signing lock` step found `free` and finished `ok`.*
- [x] **40. Lending Stage 1: a fresh WebDriverAgent install keeps the team's trust** (issue 63), iPhone, owner present, with sideload's `slot lend`/`return` and its test app `filler`. With WebDriverAgent uninstalled and the free team's three slots filled by sideload's apps, `sideload slot lend --to lab` frees Stremio's slot; `lab up --target device` then installs WebDriverAgent fresh, and the session starts with **no new Trust tap** (another app from the team stays installed throughout). `lab down`, uninstalling WebDriverAgent, and `sideload slot return` put Stremio back and clear the lend; removing `filler` and one `lab up` put WebDriverAgent back.
  *Checked 2026-10-24, 16:50 to 17:30 CT, iPhone over Wi-Fi (main @ 77bda74), sideload debug build @ bba18fe, owner present (results on issue 63). Before the run, sideload's live slot count included the owner's five TestFlight betas (`used: 8`); sideload fixed it to count by the team in each installed profile (sideload #36), with the lent slot and WebDriverAgent counted once. Reinstalling Apollo and Stremio in place kept their sign-ins. `filler`: `used: 3`, `free: 0`. Lend: `freed: 1`. `lab up`: WebDriverAgent installed fresh (`xcodebuild test-without-building`, 33 s, no new App ID); it launched, the session started and a page opened; the owner saw no Trust prompt, only the usual passcode entry for automation. Return: `reinstalled: true` (a normal return prints no `settled`; that appears only when an interrupted return is resumed), `lent: null`; Stremio signed in again. The phone ended as it started (Apollo, Stremio, WebDriverAgent).*
- [x] **41. Lending Stage 2: the lab lends by itself** (issue 63, [ADR 0008](adr/0008-slot-lending.md)), iPhone over Wi-Fi, owner present, with the real sideload (a debug build through `MSL_SIDELOAD_BIN`) and the idle stop set to `MSL_IDLE_MINUTES=2`. With WebDriverAgent uninstalled and the free team's three slots full (sideload's two apps and `filler`): (1) `lab up --target device` finds WebDriverAgent missing and installd refusing it with the free-app limit, borrows a slot (`slot: {lent, freed: 1}`) and installs it; `lab status` shows `slot.lend.phase: "lent"`. (2) `lab down` stops the runner and leaves the slot lent (issue 86: no WebDriverAgent runner process on the phone afterwards). (3) The idle stop gives the slot back after the idle time (`slot: {returned: true, reinstalled: true}`, the record cleared), and the lent app opens with its data. (4) The failure paths: (a) sideload busy (a lend pending): `needs: busy` with `retryAt`, no tunnel, no Focus, the record kept, and `lab phone slot return` settles it; (b) a return that fails (`RETURN_FAILED`): `ok: false`, `needs` from the cause, the record kept, and a plain `lab phone slot return` finishes it; (c) the signing lock held: the early stop of 39(d); (d) no lendable app: `needs: slots`, `failedStep: "slot"`, nothing lent. (5) The phone locked at the idle stop: not given back, one log line, nothing on the lock screen, and the next tick after unlocking gives it back. (6) A crash in the middle of a lend (optional).
  *Checked 2026-10-25, about 09:40 to 10:30 CT, iPhone over Wi-Fi (iOS 27.0.1), lab @ 677e99c (on main @ 727190a), sideload debug build @ 51b8c24. WebDriverAgent uninstalled; the owner installed `filler` (no new App ID; 3 App IDs in the last 7 days) so the phone held 3 of 3 (Apollo, `filler`, Stremio), and was signed in to Stremio. **It found a bug first:** the first `lab up --target device` stopped at `slot` with `needs: "unknown"`. devicectl's free-app-limit refusal (CoreDeviceError 3002, IXUserPresentableErrorDomain 14, MIInstallerErrorDomain 13) puts "maximum number of installed apps using a free developer profile" past character 400, and the failure text was cut to 400 before it was classified. Fixed in 677e99c: every failed devicectl call is classified on its whole redacted text (real stderr kept as a fixture). (1) Passed: `lab up --target device` ok in 57 s; the `slot` step took 21.1 s, found "WebDriverAgent missing, no free slot" and "borrowed stremio-ios's slot from sideload and installed it"; `slot: {lent: "stremio-ios", freed: 1}` with the warning `DATA_BACKUP_INCOMPLETE` ("2 of 13 data files were not backed up"); the session opened in 26.8 s; `lab status` showed `slot.lend.phase: "lent"`. (2) Passed: `lab down` ok; the `wda` step said "runner asked to shut down" and "its xcodebuild exited by itself"; no WebDriverAgent runner process on the phone afterwards (**issue 86 live check passed**). The slot stayed lent. (3) Passed: the idle stop returned it at 09:59 CT, about 4 min after `lab down` (idle time 2 min): "gave it back: took WebDriverAgent off the phone, and sideload put its app back", `{returned: true, reinstalled: true, dataRestored: true}` with the warning `DATA_RESTORE_PARTIAL_BACKUP`, record cleared. The owner opened Stremio: still signed in, library and add-ons all there (the first live restore from sideload; it worked although 2 of 13 files had not been backed up). (4a) Passed: with `SIDELOAD_TEST_FORCE_SLOT=pending`, `lab up` gave `needs: "busy"`, `SLOT_PENDING`, a `retryAt` 645 s on, no tunnel and no Focus; the lab kept a `lending` record with `retryAt` while sideload showed nothing lent, and `lab phone slot return` settled it (`returned: true`, `nothingLent: true`). (4b) Passed: after a real lend and `lab down`, with `SIDELOAD_TEST_FORCE_SLOT=return-failed`, `lab phone slot return` gave `ok: false`, `RETURN_FAILED` with cause `DEVICE_LOCKED`, `needs: "unlock"`, and the record kept (`phase: "returning"`, `returnFailed`); a plain `lab phone slot return` then returned it (`reinstalled`, `dataRestored`). (4c) Passed, with the held lock of 39(d). (4d) Passed: with the owner's `sideload device lendable --alias <phone> --none --yes`, `lab up` gave `needs: "slots"`, `failedStep: "slot"`, `NO_LENDABLE_APP` with the owner's steps; nothing lent, no tunnel. The owner marked the app lendable again afterwards. (5) Passed: a lend (the backup missed 1 of 12 files), `lab down` at 10:10 CT, then the owner locked the phone. The 10:14 CT tick did not return it: code `DEVICE_NOT_CONNECTED` (a locked phone on Wi-Fi is unreachable, so it never read as `DEVICE_LOCKED`), `needs: "tunnel"`, record kept (`phase: "lent"`, `returnFailed`), failures 0, one log line, and nothing on the phone's lock screen. After the owner unlocked it, the 10:20 CT tick returned it (reinstalled, `dataRestored`). (6) Not run (covered by unit tests). **Cleanup:** the owner removed `filler` (phone 2 of 3). `lab up` installed WebDriverAgent into its own slot ("it fit; nothing borrowed"); a second `lab up` with sideload's lock held reused the live session with no `signing lock` step. `lab down` was clean, with no runner process left (issue 86, second pass). The idle plist went back to 15 minutes with no sideload binary. **Gap found:** the lab passed on only `dataRestored` and the warnings from sideload's data counts; the counts (`dataBackedUp`, `dataFiles`, `dataFilesFailed` on a lend; `dataFilesRestored`, `dataFilesFailed` on a return) are now passed through (see the changelog), covered by unit tests only: the live run was at 677e99c, before that change.*
- [x] **42. Allowed hosts on the phone** (issue 101, [ADR 0009](adr/0009-follow-allowed-hosts.md)), iPhone, owner present. (1) `lab up --target device --allow-host old.reddit.com --allow-host www.reddit.com --url https://old.reddit.com/`: the output has `allowHosts` with both. (2) The page moves the lab's tab to the other allowed host (an `eval` that sets `location.href` after a short delay): the next command is `ok` with `followed` naming the site, and `eval` still runs in the tab. (3) The page moves it to a host that is not allowed: the next command is `needs: "tab"`, tainted, and the refusal names the session's allowed hosts and says to name them again; the command after that stays refused. (4) `lab down` ends the session and gives the old lab tab's close-by-hand step.
  *Checked 2026-10-28, about 20:15 to 20:30 CT, iPhone over the cable (iOS 27.2), main @ f6dfe30, owner present. Wi-Fi failed twice first at the `tunnel` step (`rsd-failed`), so the run used the cable. (1) passed: `allowHosts: ["old.reddit.com", "www.reddit.com"]`, the page ended on `https://old.reddit.com/hot/`. (2) passed: the page went to www.reddit.com and the owner's own Reddit redirect brought it back to old.reddit.com, without the marker; `safari url` was `ok` with `followed: ["https://old.reddit.com"]`, and `eval location.host` then answered `old.reddit.com`. (3) passed: after a move to example.org, `wait --settled` was `needs: "tab"` with "it is not on one of this session's allowed hosts (old.reddit.com, www.reddit.com); run `safari start` for a new session (and name the hosts again with `--allow-host`)", and `safari url` stayed refused. (4) passed: `lab down` was `ok`, `keyboardRestored: true`, `tabClosed: false` with the close-by-hand step, and nothing was left to restore. Not covered: a follow that lands and stays on www.reddit.com (the owner's redirect sends it back to old), and the follow over Wi-Fi.*

## Result: 2026-10-23 (late), re-check after issue 58 to issue 62 and PR 70

Main @ cb5b77c, iPhone over Wi-Fi, owner present, 22:2x to 23:10 CT.

| Item | Result |
|---|---|
| 24 | A warm Wi-Fi `lab up` took 24 s. |
| 26 | Pass. With an Apple TV connected to CoreDevice on the network, `start-tunnel` without `--udid` opened the tunnel to the Apple TV three times in a row. Each time the lab refused it (`needs: tunnel`, `wrong-device`), and the tool was gone afterwards. PR 70 now starts the tunnel with `--udid <saved phone>` (pymobiledevice3 floor 11.40.2). With the Apple TV still on, the tunnel reached the phone. |
| 29 | Pass. Locked 10 min: `safari eval` gave `needs: unlock` in 11 s, with "the session is still good", and no stderr. `lab up` gave `needs: unlock` in 10 s, keeping the session. After unlocking, the same session answered in 1 s and `lab up` reused it (`reused: true`). |
| 30 | Pass. Wi-Fi off: `safari url` gave `needs: tunnel` in 13 s and `safari eval` in 10 s, with no stderr. `lab tunnel status` gave `reaches: false` ("the phone does not answer through the tunnel"). `lab phone status` gave `needs: tunnel`. Wi-Fi on: `lab up` took 36 s (63 s before the fix). The session step said "its route to the phone is gone (its tunnel was replaced)" and replaced it with no 10 s probes. `previousTab` named the old tab once, `keyboardDeferred` was set, and the later `lab down` gave `keyboardRestored: true`. |
| 31 | Pass, for a short sleep. The Mac slept 16 s (23:09:40 to 23:09:56). Afterwards the tunnel was still up, the page command worked in 1 s, and `lab up` reused the session. A longer sleep that kills the tunnel goes down the item-30 path. |

## Result: 2026-10-23, the Wi-Fi tunnel on the iPhone (issue 15, items 24 to 36)

Main @ 8bf1e23, iOS 27.0.1, pymobiledevice3 11.40.2, owner present, 18:32 to 20:00 CT. `lab service install` installed the tunnel host first. The first `lab up` re-signed WebDriverAgent over the tunnel (under 24 h of signing left). The phone then needed the developer profile trusted, and the hint wrongly asked for the cable (issue 61).

| Item | Result |
|---|---|
| 24 | Pass. Warm `lab up` 25 s, cold 3 min with the re-sign. `open` 1.6 s, `eval` about 240 ms (five runs), `shot` 0.8 s. |
| 25 | Pass. Port 8100 was refused or timed out on all 9 other LAN hosts; WebDriverAgent answered at the tunnel address. Listeners: Appium on `127.0.0.1:4723` and `:9100`, the registry on `127.0.0.1:<port>`, none for pymobiledevice3. |
| 26, 28, 33, 34 | Not run. There was no second device on the network, Remote Login stays off, and neither a passcode prompt nor a CoreDevice hang came up. |
| 27 | Pass after `lab down`. Tunnel `none`; no host, tool or `xcodebuild` left running; the registry key gone (it was absent before). Idle stop not run. |
| 29 | Partial. After 10 min locked, `safari eval` said `needs: tab` ("the lab's tab is gone") and `lab up` said `needs: unlock`. After unlocking, `lab up` took 22 s. |
| 30 | Fail. With Wi-Fi off, `eval` and `url` said `needs: tab`, `lab tunnel status` still said `up`, and `lab phone status` said `needs: cable` (issue 59). With Wi-Fi back on, the first `lab up` failed with `needs: tunnel-tool` after a 10 s version timeout (issue 60); the second worked in 63 s (issue 62). |
| 31 | The command said `needs: tab` (issue 59). `lab up` recovered in 77 s with a new tunnel. |
| 32 | Pass. `--resign` over the tunnel took 72 s, kept the same bundle id, needed no trust prompt, and the session works. |
| 35 | Pass for files. Not run: `lab` as root. |
| 36 | Pass after the fix. First run: with the tunnel up and the cable in, `lab up` stopped the tunnel and chose the cable. The phone then refused WebDriverAgent as untrusted twice, because the cable caps uninstalled it at every session (issue 58). After PR 65 (20:38 to 20:42 CT), with the profile trusted once: two cable `lab up` in a row took 45 s (Appium cold) and 27 s, with no uninstall in the Appium log and no new trust prompt. The cable-only run (Wi-Fi off, tunnel down) took 22 s: `cable`/`usbmux`, no `tunnel` step, `wdaBindingIP` `127.0.0.1`. |

## Result: 2026-10-20, smoke gate before the Wi-Fi tunnel work (issue 15)

Passed. `pymobiledevice3 remote start-tunnel --native --script-mode` ran under a throwaway
LaunchAgent (no `RunAtLoad`, no `KeepAlive`) in `gui/<uid>` and opened the tunnel, and
`launchctl kickstart -k user/<uid>/com.apple.CoreDevice.CoreDeviceService` restarted
CoreDeviceService (so the lab's automatic restart can use it). This gate used a throwaway agent, not
the lab's: items 24 to 36 above are the live checks of the lab's own agent and `lab up`.

## Result: 2026-10-18, field-test re-check on the iPhone (cable)

Branch `feat/iphone` @ 8f30e43, iPhone 15 Pro Max type, iOS 27.0.1, cable. Run folders:
`runs/20261018-195725-iphone-fieldfix-recheck` (command JSON) and
`runs/20261018-195735-session` (shots, network, console, `run.log`). Every item below passed and
the owner confirmed it on the phone. It also found two bugs, fixed after it (run folder, shot path;
see the CHANGELOG).

| Item | Measured |
|---|---|
| lab up | Cold start 41 s; session 37 s. |
| A, repeated `open` | 24 `safari open` calls across 11 origins, all ok, 0 `needs`, no `markRetried`, 1 to 5 s each. Includes Connections 2023-11-08, a tap on Play, then Wordle 2023-09-14, and minutecryptic.com then help.nytimes.com/hc/en-us (redirected to `/`). The Appium log (info level, filters on) had 0 unredacted site URLs. |
| B, throwing script | `eval 'null.x'`: `ok: false`, "the page script threw: null is not an object (evaluating 'null.x')" in 1 s; the next `url` worked. |
| C, `keys` | On a Minute Cryptic practice clue: `keys zqx` gave keyed 3, byEvent 3, `textChecked: false`, `textSkip: "unverified"`, cells showed exactly "zqx". Five `\b` gave keyed 5, byEvent 5, cells empty, 19 s (about 4 s per Backspace). On a plain input on example.com, `keys zqxv` gave `textChecked: true`, and two `\b` left "zq". |
| D, `network` | 20 taps and 20 `keys` ok; after `refresh`, example.com: count 2, no `copies`, dropped 0. Connections 2023-11-07: 85 entries, all www.nytimes.com, 5 outside. Wordle 2023-09-14: 51 entries, 5 outside. `responseStatus` and `method` were null on all 136 entries (iOS 27.0.1 Safari); `transferSize` was 0 on 85 of 136 (cached or opaque). `initiatorType` was navigation, link, css, script, xmlhttprequest, fetch and other. |
| E, device ids | The full UDID appears nowhere in `lab up`, `status`, `start`, `down` output or `run.log`; outputs show the last four. |
| F, tabs | See item 5 above. |
| G, `--reinject` | connections-color-marker 1.2.4 injected on Connections; `open wordle/2023-09-14 --reinject` gave `reinjected: []` and `reinjectSkipped` with that file; no element of it on Wordle. |
| H, invisible tap | Tap on minutecryptic's `input[aria-label="Type your answer"]`: ok, `focused: false`, `warning` "is hidden (opacity 0, 1x1 px); the tap probably focused nothing". A visible letter cell (a BUTTON) took focus. |
| I, help | `safari tap --help`, `safari help`, `sim statusbar --help`: usage only, no lease or status bar change. |
| J, redaction | Network entries carry `k=[redacted]` (Statsig). No Statsig line reached `safari console` (entries `[]`), so the console side is not tested live. |
| Tap obstruction | On example.com an SVG covered an input inserted at the top: `tap` refused with "covered by <path>". |
| 15 Keyboard | See item 15 above. |
| lab down | ok; `steps[session].tabClosed: true` (the tab's report is in that step; the top level has `keyboardRestored`); `keyboardRestored: true`; nothing on :4723; no WebDriverAgent `xcodebuild`; the owner's tabs unchanged. |

Timing on the phone: 0 to 4 s per `tap` (typically 3 s); `keys` about 1 s per character on a
plain input and about 3 s per character on byEvent fields.

Found, then fixed: `safari shot <absolute path>` wrote `-<path>.png.png` inside the session run
folder; and a session started after `sim run <label>` opened a second run folder, splitting the
artifacts.

## Result: 2026-10-18, Wi-Fi run on the iPhone

iPhone 15 Pro Max type, iOS 27.0.1, cable out. Run folder: `runs/20261018-210009-session`.

| Item | Measured |
|---|---|
| Private Wi-Fi Address "Fixed" | The phone advertised `_apple-mobdev2._tcp` and CoreDevice (`devicectl`) showed it connected, but usbmux (Appium's device list, read through appium-ios-device) listed nothing, silently. |
| Private Wi-Fi Address "Off" | Within seconds usbmux listed a `ConnectionType: "Network"` entry. usbmux lists the phone over Wi-Fi only when the Wi-Fi address it advertises matches the pairing record, which happens only with the hardware address. |
| lab up | `lab up --target device` over Wi-Fi: 42 s. |
| Page commands | `open`, `eval`, `tap`, `shot` and `network` worked. |
| lab down | ok; `steps[session].tabClosed: true`; `keyboardRestored: true`; nothing left on :4723. |
| Cable in | usbmux shows only the USB entry. |

The setting is per network, so it has to be Off on each network used. Both devices must be on the
same network (no guest networks with client isolation). The raw usbmux entries carry
`ConnectionType` ("USB" or "Network"); appium-ios-device's `getConnectedDevices` dedupes and drops
it, so `lab phone status` now reads the raw list, and when CoreDevice reaches the phone over the
network but usbmux lists nothing, `needs: cable` names Private Wi-Fi Address first.

## Result: 2026-10-19, items 16 to 18 on the phone and the simulator

`main` at 986dd29 (0.4.0). Phone: iPhone 15 Pro Max type, iOS 27.0.1 (24A446), cable (Wi-Fi did not
come up; see below). Simulator: Claude iPhone, iOS 27. Test pages: example.com and example.org
with injected userscripts. Item 16 passes on both targets, item 17 on the phone except 17(5), and
item 18 on both targets with step (0) not run.

| Item | Measured |
|---|---|
| 16 wait, phone | (1) `.card --visible` 1899 ms, 4 polls. (2) `--settled` 2364 ms, 5 polls, mutations 16, sizeChanges 1. (3) removed spinner gone in 1242 ms, hidden spinner in 87 ms. (4) `.nope --timeout 3000`: `ok: false` at 3072 ms, 7 polls, no `needs`. (5) owner switched tabs during a 45 s wait: `needs: "tab"` ("did not answer within 10s"), run not tainted, `url` worked after switching back. (6) `open --settle` 628 ms, then `shot --page` ok. A poll costs about 430 ms over cable. |
| 16 wait, simulator | (1) 1863 ms, 6 polls. (2) 2134 ms, 8 polls. (3) 975 ms and 769 ms. (4) `ok: false` at 3027 ms, 12 polls, `fail.png` and `fail.html`. (6) 552 ms. (5) is phone-only. |
| 17 shot, phone | (1) plain, `--element` and `--page` shots are 8-bit RGB, non-interlaced; the profile is sRGB IEC61966-2.1 (not Display P3) on raw and cut files. (2) `--page` with the full toolbar: points area y 59, h 715 (crop px y 177, h 2145 of 2796), no status bar or toolbar; with the pill after a swipe: y 58, h 815, no bars; the address bar was at the bottom (top not tested). (3) `--element .card.top` exact to the pixel; `--element '*' --text Buy` is the button; a card far below is refused ("not wholly inside"); a card 30 pt under the bottom bar is refused, no file. (4) `--width 600` gave 600x998, scale 0.4651; `--scale 0.5` gave 645x1073. (5) With the owner on another tab, `shot` was refused with `needs: "tab"` and no file, but the run was tainted: the next `url`, `eval` and `shot` said the lab lost track of its tab. Fixed afterwards (no answer is no longer a move); pending a live re-check. (6) Pinch zoom 1.34, offset (55, 110): `--page` showed the zoomed view, no bars. |
| 18 storage, phone and simulator | (1) another site: `extraLoad: true`; the same site: `extraLoad: false`; the value was present (checked by length or equality). (2) `https://example.com/#frag` from example.org: navigation type "reload", value present. (3) A fresh canary through `--storage`, `type` and `keys`: 0 hits in `~/Library/Logs/msl-appium.log` (10342 lines), the run folders and the state dir. (4) `--storage=k=v` refused by position, no value echoed. (5) `url` works after a storage open (phone). (0) not run. |

Findings of that run, fixed in the next release (see the CHANGELOG): a `shot` with the owner on
another tab tainted the run; a `keys` on the simulator returned `ok: true, keyed: 10` with 7
characters in the field (a dropped press that fired its events); `lab service install` left the
simulator lease held; the Wi-Fi `needs: cable` text blamed Private Wi-Fi Address alone (Appium's
Wi-Fi listing also lapses when the phone sleeps, and the cable restores it); phone shots are sRGB,
not Display P3; a cold `lab up` failed once with `got no answer in 420s` (run it again).

## Result: 2026-10-19 (evening), items 17(5) and 19 on the phone

`main` at 7b02801, run from a temporary worktree. iPhone by cable, iOS 27.0.1, owner present.
Times are CT. Items 17(5) and 19 pass; item 20 (the idle stop) is not part of this result.

| Item | Measured |
|---|---|
| 19 page pin | 15:33 to 15:39. Two loops of `open`/`eval`: the first 160 commands with no owner action; the second 120 commands while the owner opened a new tab, opened a link in a new tab, closed them, and twice switched to another tab for about 15 s. All 280 commands ok. Appium log over the two spans: 0 `We have new pages, selecting page`, 0 `Debugger already selected page`; every `msl-page-pin: evaluate page=` was page 1, the lab's page (864 in the first span, 873 in the second; 1 `armed` per session); `listing changed ... not following` 2 times in the first span and 4 in the second. No refusals, no taint. Page commands kept working while the lab's tab was in the background, until Safari paused it. |
| 17(5) shot, owner elsewhere | With the owner on another tab, `safari shot --page` returned `needs: "tab"` with "The session is still good", untainted. After switching back, `shot --page` was ok: 1290x2145, a crop of 1290x2796, page content only. |
| 16(5) wait, owner elsewhere | `safari wait '.never-there' --timeout 45000` with the owner switching tabs during it: `needs: "tab"`, the session still good. |
| Open while away | A `safari open` sent after the owner had been away a while was refused with `needs: "tab"` before anything was sent. Then 20 opens, one about every 2 s, with a switch of about 10 s: 20 of 20 ok, untainted, no `markRetried`; a final `eval` read example.com. |

Still open: the simulator `keys` re-check of the PR 38 test plan (`textChecked` on the simulator, and
that `keys CANARYxxxx` no longer reports `ok` when a dropped press fired its events) has not been
run since the fix.

Item 20, first tick (not yet checked in full): after `lab service install` at 17:44:54 CT (the last
lease activity) with the default 15-minute threshold, `launchctl print` showed `com.dividedby.msl-idle`
loaded with a 300 s run interval. With no session and the simulator shut down, the tick at 17:59:56 CT
stopped the lab: `steps` found no session, no WebDriverAgent, the simulator shut down, no window or
safaridriver of the lab's, and Appium loaded, which it stopped and disabled at login
(`com.dividedby.msl-appium => disabled`, the idle agent still enabled). `lab status` showed `idleStop.last`
with `ok: true`, `failures: 0`, and `~/Library/Logs/msl-idle.log` had one line. Not run yet: a live
session or phone tab at the tick, an unreachable phone, a simulator the lab booted, and `lab up` racing a stop.

## Result: 2026-10-20, item 22 on a reset simulator (before the WDA budget fix)

Clean simulator after `sim reset`. (1) The first boot after the reset took 553 s: pass. (3) Re-attaching to a cut `bootstatus` piece: pass (it re-attached). (6) `lab up` failed twice, then worked: run 1 failed with `got no answer in 420s` and the lab's WebDriverAgent retry never fired (Appium's own error had not arrived: `wdaLaunchTimeout` 270 s is polled `270000 / 500` = 540 times about 1.15 s apart, about 620 s, then xcuitest's `wdaStartupRetries` 2 with 10 s between; the 270 + 60 + 30 < 420 sum was wrong); run 2 failed with `The remote debugger returned 4 web applications, but none of them had pages` (not retried: only "did not return any connected web applications" was); run 3 came up in 110 s. `sim shot` returned `scale: null` while AXe's tree was not ready. The fix is `wdaLaunchTimeout` 30 s with 2 attempts, `wdaConnectionTimeout` 90 s (worst case 370 s by the real formula), the no-pages retry and the `sim shot` scale fallback. Item 22 stays unchecked until it is run again with these.
