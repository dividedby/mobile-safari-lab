# AGENTS.md: start here

For any coding agent, in any repo, that wants to test a web page or userscript in real Mobile
Safari with this lab. It drives the owner's **iPhone** or an iOS **Simulator** on the Mac, and
prints one JSON object per command (`ok` true or false). This file is the short version; the
[README](README.md) has setup, [CONTEXT.md](CONTEXT.md) the terms, and
[skill/SKILL.md](skill/SKILL.md) the same workflow written as a Claude Code skill.

These docs are the source of truth for the lab: they override lab details you remember or that
another repo has copied (commands, rules, how to report issues). Other repos should keep only a
pointer to the skill (`~/.claude/skills/mobile-safari`, which points here), not copies of this.

If the project you are working in has its own test rules (which pages, which accounts, what to
leave clean), they still apply.

## 1. Check the setup

- It only works on the Mac that has Xcode. A cloud session can't run `xcrun`: say so, and offer
  to do the rest when the person is at the Mac.
- `sim doctor` checks the tools. If it says `ok: false`, stop and relay its `hints` (one fix per
  item in `missing`). Never install tools or change settings without asking.
- The tools are `bin/sim`, `bin/safari` and `bin/lab` in this repo, normally on `PATH`. They refuse
  to run as root (under sudo they print `refusing to run as root` and exit 1): run them as the
  owner's own user.
- `sim doctor` also reports `pymobiledevice3` (its version, or `null`), the tool Wi-Fi needs
  (issue 15). With a phone
  saved, a missing or too-old one (older than 11.40.2) adds `hints.pymobiledevice3`: relay it if the
  task wants Wi-Fi, otherwise ignore it. It never makes `ok` false, since the cable and the simulator
  don't need it. With a phone saved it also reports `phoneDisplay` (whether `xcrun devicectl` has the appearance and orientation
  commands, Xcode 27); `false` adds `hints.phoneDisplay` and means `safari appearance` / `safari orientation` will fail: relay the hint
  if the task wants them, otherwise ignore it. `lab status` shows it as `tunnelTool`; `lab up` over Wi-Fi without it stops with
  `needs: tunnel-tool`. A version check that times out twice (10 s each) is not that: the tool is
  probably fine, so `lab status` and `sim doctor` say it timed out and to try again, and `lab up`
  says `needs: tunnel` (run it again).
- Using the phone also needs it saved once: `lab phone status` shows whether it is. If it says
  `needs: "setup"`, see the table in section 6.

## 2. Pick a target

| Situation | Use |
| --- | --- |
| The task says "iPhone", "real device", or needs the owner's extensions, the real WebKit build, GPU or fonts, or the real network | `--target device` |
| Clean profile, status-bar control, or screenshots that must look the same every run | `--target simulator` (clean is the default profile) |
| A dark-mode or landscape check on the real phone | `--target device`, then `safari appearance dark` / `safari orientation landscape` (the lab puts them back; below) |
| A page that needs a signed-in user the owner set up on the simulator, and the owner's phone isn't wanted | `--target simulator --profile configured` (see below) |
| A phone-width check, nothing special, and a phone is saved | `--target auto` (the default): the phone when it is reachable and unlocked |
| The phone is not saved, unreachable, locked, or the person isn't around to unlock it | `--target simulator` |
| The Mac is short on memory (the simulator takes about 3 to 5 GB; measured on an 8 GB Mac) | `--target device` |

`auto` uses the simulator when no phone is saved. When a phone **is** saved but can't be used, `auto`
fails with a `needs` (section 6) instead of quietly switching: add `--target simulator` if the
task doesn't need the phone.

Differences you should know before you report:

| | iPhone | Simulator |
| --- | --- | --- |
| Engine, GPU, fonts, network | real | the Mac's |
| Profile | the owner's: logged in, with their extensions, which may inject into pages | clean, logged out, no extensions; or `--profile configured`: only the sign-ins the owner made by hand |
| Appearance, status bar | appearance and orientation: `safari appearance`, `safari orientation`, put back at the end (section 4); status bar: not controllable | `sim appearance`, `sim statusbar` (the `safari appearance` and `orientation` commands are refused on a simulator session) |
| Setup | signing (free account: re-sign every 7 days), phone unlocked and awake, battery | none after setup |
| Speed | session ~50 s cold, 14 to 18 s warm; a call is ~20 ms on cable, ~2x on Wi-Fi (to be re-measured over the tunnel) | 4 to 10 minutes cold on a loaded 8 GB Mac, 22 to 31 s warm; fast once booted; the first boot of a new simulator (`sim create`) up to 25 minutes |
| `sim` commands (`tap`, `type`, `shot`, `ui`...) | refused during a device session: use `safari shot\|tap\|keys\|swipe\|ui` | fine outside a session |

**Simulator profiles.** The lab has two simulators and only one is booted at a time. **Clean** ("Claude iPhone") is the default of every `lab up` and is never signed in; `sim reset` makes it new. **Configured** ("Claude iPhone (configured)", made once with `sim create --profile configured`) keeps what the owner signed in to by hand, and Safari's data survives between sessions. Pick it per run with `lab up --profile configured` (never sticky; the next `lab up` with no flag is clean). `sim boot`, `shutdown`, `reset`, `udid` and `create` take `--profile` too; any other `sim` command acts on the live session's simulator. `sim profile status` shows both devices. A session on one profile blocks `lab up` on the other (`safari stop` first); the other device is shut down for you. `sim reset` on configured needs `--profile configured --yes` and is the owner's call, not yours. Rules: never type a password, code or any secret into either simulator, and never an Apple ID; the owner signs in by hand, once. A shot of a configured session shows what is signed in, so section 8's screenshot check applies; and it is not pristine, so reproduce a bug on clean and say which profile you used.

**Using Wi-Fi** (the iPhone). Over Wi-Fi the Mac reaches the phone through Apple's own tunnel (the CoreDevice tunnel Xcode uses to reach a phone on the network), which a LaunchAgent of the lab's (`com.dividedby.msl-tunnel`, installed by `lab service install`) holds: no root, no cable once the phone is paired, and Private Wi-Fi Address does not matter. `lab up` shows a `tunnel` step when the phone is on the network with no cable (up to 45 s), then starts the phone's WebDriverAgent bound to the tunnel address (`transport: wifi`; its output is `~/Library/Logs/msl-wda-device.log`). Away from the Mac's network is not supported. You can't change these on the phone yourself; relay them:

- Once, with the cable in: pair and trust the Mac (the first cable `lab up` does it). There is no Xcode setting to turn on: Xcode 15 removed Connect via network, and a paired phone is reachable on the network by itself.
- pymobiledevice3 11.40.2 or newer, installed by the person as their own user (`brew install uv`, `uv tool install --python 3.14 pymobiledevice3`; later `uv tool upgrade pymobiledevice3`); without it Wi-Fi says `needs: tunnel-tool` (a check that merely times out twice says `needs: tunnel`: run it again). And `lab service install` (the person runs it) for the tunnel agent.
- The phone unlocked and on the same network as the Mac. No guest or client-isolated networks.
- With the cable in the lab uses the cable and stops a tunnel left up. `lab tunnel status` shows the tunnel (a tunnel that went down has its `reason` and, when the tool said why, a `detail`, such as the exception line of `rsd-info`; the `tunnel` error carries it too) and, with it up, whether the route works (`reaches`; it makes one bounded TCP connect to the phone through the tunnel, and one WebDriverAgent request when a session runs over it); `lab tunnel up|down` start and stop it by hand (they take the lease). `lab down`, `lab down --idle` and the idle stop end it.
- If CoreDevice is stuck (lockState times out while the phone's tunnel state is "connecting", or the tool stays silent) the lab restarts the user's CoreDeviceService itself, once per command, and says so (`restarted CoreDeviceService`, `coreDeviceRestarted: true`). Xcode's and `devicectl`'s connections drop for a moment: mention it in your report. Don't restart it yourself.
- A command that fails over Wi-Fi with no working tunnel says `needs: tunnel`; run `lab up --target device` again once the person has done the steps.

## 3. Bring it up

```sh
sim run <short-label>                       # a run folder for screenshots and logs; the session `lab up` starts next uses it
lab up --target auto --url <http(s) URL>    # or --target device / --target simulator
```

`lab up` checks and repairs everything in order (lease, prerequisites, Appium, phone or
simulator, Safari session, the page) and reports each `step` with what it `found` and `did`. Run
it again whenever something seems stuck; on a healthy setup it changes nothing. Expect:

- **iPhone:** about 50 s the first time (WebDriverAgent is built and installed), 14 to 18 s warm.
  Signing is renewed by itself when under 24 hours are left. `--resign` deletes the build and signs
  again, but Xcode reuses a still-valid profile, so the expiry does not move until near expiry
  (the output says `expiryMoved: false`). Over Wi-Fi a `tunnel` step comes between `phone` and
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
section 6. If the simulator is leased by someone else (`failedStep: "lease"`), tell the person who
holds it and until when (it names the owner and expiry) and wait or ask. An expired lease is
taken over by itself. `lab service install` and `uninstall` take the lease while they run and
hand it back when they end (a lease the caller already held is kept), so they leave none behind.
A lease held by `msl-idle` means the idle stop is shutting the lab down: wait a minute and run `lab up` again.

## 4. Test

```sh
safari open <url>              # waits for the new page to load
safari inject <file.user.js>   # a userscript (runs after load; `--reinject` on open/refresh re-runs it where its @match fits)
safari inject --forget <file>  # drop one recorded file from `--reinject` (runs nothing); `--clear` drops them all
safari eval 'document.title'   # an expression gives its value; several statements need `return`
safari click <css>             # synthetic events (isTrusted false)
safari tap <css>               # a real touch; brings up the keyboard on a field
safari tap button --text OK    # by exact visible text; --contains, --nth N (1-based), --shadow host inner (open roots)
safari tap --label "Share"     # the one native element in the web view with exactly this label
safari wait <css> [--visible|--gone]   # until the element exists / is rendered / is removed or hidden; same selectors as tap; --timeout ms
safari wait --settled          # until nothing has loaded, changed or resized for --quiet ms (500)
safari keys "text"             # real key presses into the focused page field
safari swipe up                # real scroll (or down)
safari appearance light|dark   # iPhone only: the phone's light/dark mode; also `status`, `restore`
safari orientation portrait|landscape   # iPhone only: the screen orientation; also `status`, `restore`
safari shot <name>             # runs/.../<name>.png (a name, not a path; "x.png" is x.png)
safari shot <name> --page      # web content only: no status bar, no toolbar
safari shot <name> --element <css>   # one element; --text, --contains, --nth, --shadow as for tap (--element '*' --text Buy)
safari shot <name> --page --scale 0.5   # shrink: --scale N (0 to 1] or --width <px>; never enlarges
safari console                 # since the last call; then cleared
safari network                 # since the last call; secrets removed
safari source | safari ui | safari url | safari refresh
```

- **`safari appearance` and `safari orientation` change the owner's phone** (iPhone only; through `devicectl`, so no
  page or tab is involved, and a simulator session is refused: use `sim appearance` there). The lab writes the old value
  down first (the restore ledger, [ADR 0007](docs/adr/0007-phone-settings-restore-ledger.md)) and puts it back at `safari stop`, `lab down`, the idle stop and, after a crash, the next
  `lab up`; `safari appearance restore` / `orientation restore` / `lab phone restore` put it back now. Do not leave the phone
  changed on purpose: end with `safari stop` or `lab down`. Every change is read back. **Orientation with Portrait
  Orientation Lock on** is silently ignored by the phone and the lab says so (`ok: false`, "Portrait Orientation Lock is
  probably on"): relay its `human` step, the person turns the lock off. **Automatic appearance** cannot be read: a restore
  sets back light or dark and says `restoredExactly: false` with a note; relay it, never claim Automatic was kept. If
  `phoneRestored` is `false` (a locked or unreachable phone), relay its `human` step; the record is kept and the next `lab up`,
  `lab down` or `lab phone restore` finishes it (`lab status` lists it as `pendingRestore`, and under `phone.pendingRestore` while a phone is saved). If the person
  changed the setting by hand meanwhile, the lab leaves it (`ownerChanged: true`). Landscape with `shot --page`, `tap` and
  `swipe` is untested: look at the shot.
- **Lab Focus** (issue 16): on the phone, `lab up` turns on the owner's Focus "Lab"
  (runs their shortcut "Lab Focus On" through the Shortcuts app, in a `focus` step before the lab's tab opens) so notifications do not
  show over the page or in shots; `lab down`, `safari stop`, the idle stop and `lab phone restore` run "Lab Focus Off" (ledger kind
  `focus`). It is **on by default**; `lab up --no-focus` skips it for one run, `lab phone setup --focus on|off` (and
  `--focus-on-shortcut` / `--focus-off-shortcut`) save it. The simulator never runs it, and a live session is kept as it is. The lab
  cannot read which Focus is on: the output says `restoredExactly: false` (assumed off before). A shortcut that cannot be run does not
  fail `lab up`: relay `focus.human` (`focus: {applied: false, needs: "shortcut"}`: the owner makes the Focus and the two shortcuts;
  see the README). A locked phone is never launched onto (iOS would ask for the passcode): at the stop the record is kept
  (`phoneRestored: false`, relay its `human` step) and the next unlocked `lab up`, `lab down` or `lab phone restore` finishes it.
  `focus.applied: true` means the shortcut was started, not that the Focus changed (`verified: false`); the Shortcuts app is in front
  on the phone after the stop. `lab phone focus test|off` is the owner's setup check (`test` turns Lab Focus on and says to look for the icon, `off` turns it off and clears the record); it is refused while a session is open. A `lab up` that fails before its session opens turns it off again itself (with a session open, `safari stop` / `lab down` does it); if the phone was locked, its `human` says Lab Focus is still on and the next unlocked `lab up`, `lab down` or `lab phone restore` finishes it.
- **Look at your screenshots** before saying something works. On the phone, a plain `shot` is the
  whole screen, not only the page: it can show the status bar, notifications and the owner's other
  apps. Don't share them wholesale. `--page` or `--element` removes the status bar and Safari's
  toolbar; use one of them for any shot you will share or attach, and read `crop` and `points` in
  its output (a wrong crop is shown there, not guessed away). An uncuttable shot saves nothing (no `fail.png` of the full screen either).
  `--element` doesn't scroll: it refuses an element that isn't wholly in view. Wait for the page
  first (`safari wait --settled`), since a page that moves while the picture is taken is refused.
- `keys` (on the simulator and the phone) reports `caseChanged: true` when the keyboard's
  auto-capitalisation changed only the case (`zq` became `Zq`); that is not a failure.
  `textChecked: false` with a `textSkip` reason says the text was not compared (a password field,
  for example). Anything else that differs fails with `ok: false`. After a failed `keys`, never
  assume the text was typed.
- **Use `wait`, not `sleep`.** `open` returns when the document is complete, which can be before the
  page has drawn: `safari wait '.card' --visible` waits for an element, `safari wait --settled` for
  the page to stop loading and changing (nothing loaded, changed or resized for `--quiet` ms, 500
  by default), and `open`/`refresh` take `--wait-for <css>` and `--settle`. Run `wait --settled`
  before a `shot`. `--visible` means rendered (not `display: none`, `visibility: hidden` or
  `opacity: 0`, at least 2 by 2 px; covered or off-screen still counts); `--gone` means none is
  visible, removed or hidden. `--timeout` is 10000 ms by default (100 to 60000). A timeout is
  `ok: false` with counts, not a `needs`; a page that animates or polls constantly never settles,
  so use `wait <css>` for it. It reads the page only, with no screen checks.
- `click` and `type` are synthetic; use `tap` and `keys` when trusted events matter, and say which
  you used.
- **`open <url> --storage key=value`** (repeatable, `open` only) sets localStorage on the address's
  origin before the page loads: a flag or a login state the page reads at start. If the tab is
  already on that origin it writes and then navigates; otherwise it loads the origin's root `/`
  first (`storage.extraLoad: true`), writes, then loads the address. Limits: key 1 to 256
  characters, value at most 4096, at most 20 pairs and 16 KiB; a repeated key is refused; a
  `#fragment`-only change from the current page is refused (the root with a `#fragment`, or the
  exact same URL, is set and then reloaded so the page's scripts run after the write). Output is `storage: { count, keys,
  origin, extraLoad }` and, when the page ended on another origin, `applied: false` plus a
  `warning`: open the final address directly. `--storage` needs the lab's Appium service with
  current log-filter rules, on both targets (no service, an older or missing rules file, or
  `MSL_APPIUM_URL` set, launchd not running the service, another listener on its port, or the
  session on another port: `needs: "service"`, before anything is sent); relay it, and the person runs
  `lab service install`. The values are never printed or saved by the lab, and
  a failure after the write saves no `fail.png`. Don't pass real secrets: they are on the command
  line (shell history, process list) and the page can read them, and after the write it can repeat
  them (title, its own errors, the screen). Use test flags and dummy tokens. `--storage=k=v`, any
  `--flag=value`, an unknown or misspelled flag and a second address are refused by position (`open:
  argument #3 is extra`), and `refresh --storage` in any spelling: put the pair in the next word.
  Say in the report that `--storage` was used.
- `eval` with one expression returns its value. Several statements are a function body, so
  `safari eval 'const a = 1; a + 1'` returns `null`; write `... return a + 1`. A script that throws
  gives `ok: false` with the page's error (it is not a `needs`); one that doesn't parse is refused
  before anything is sent. A Promise (or any thenable) is awaited, for up to `--timeout <ms>` (10 s by
  default, 100 to 60000): the output has its value, `awaited: true` and `awaitedMs`. A rejection is
  `ok: false` with `the Promise rejected: <reason>`; a timeout, or the page changing while it waits, is
  `ok: false` too.
- `click`, `type` and `tap` also take `--text <T> [--contains]`, `--nth <N>` and `--shadow` (put `--`
  before a selector that starts with `--`). `--text` is exact visible text with whitespace
  collapsed (case matters) and picks the innermost match; with more than one match it is refused
  until you add `--nth` (1-based). `--shadow` enters **open** shadow roots only: every argument is
  a selector and the last is the target (`'*'` with `--text` searches a whole root); a host with no
  open root is refused. Output names your selector and `matches`, never the page's text. For `type`,
  `--text` matches visible text (a label or container, not an `<input>`): use a css selector for
  fields. Extra positionals are refused, and a text that is exactly `--text`, `--nth`, `--contains`
  or `--shadow` must come after `--` (`safari type input -- --text`).
- `tap --label "<a11y label>"` is for what the page can't name (a closed shadow root, a canvas). It
  taps the one native element in the web view whose label is exactly that, read from the native
  tree (`safari ui` lists the labels). It looks inside the web view only, never at Safari's tab bar,
  toolbar or address bar, and it does not scroll: a target off the visible page is refused (`safari
  swipe` first). It is not combined with css, `--text`, `--nth` or `--shadow`. Raw coordinates
  (`--at x,y`) are deliberately not offered.
- `tap` scrolls an off-screen target into view (`scrollY` can change), reports `focused: true|false`
  for a text field, and adds a `warning` when the target is invisible (opacity 0, hidden,
  `display: none`, under 2 px): the touch was sent but probably focused nothing. Don't `keys` after
  `focused: false`. On a cold simulator on an 8 GB Mac a `tap` can take seconds (6 to 19 s seen; on the phone 0 to 4 s, typically 3 s), not
  the 0.4 s pause the docs mention: that pause leaves out reading Safari's native tree.
- `keys` counts a character as landed when the field's length or text changed, or it got a
  `keydown`/`beforeinput`/`input` event, but events count only while the field has not changed during
  the run (once it has, a press that fires events and adds nothing is sent again). Pages that reset
  their input after each key (minutecryptic.com) therefore pass with `byEvent` and `unverified`
  counts and `textSkip: "unverified"` (when the field is exactly as it was): the text was not seen,
  so check the page. Such a field costs up to about 1.5 s per character (measured on the phone: about 3 s per
  character and 4 s per Backspace there, about 1 s per character on a plain input). A plain field is
  also length-checked at the end: if a character landed only by event and the field is shorter than
  what was sent, `keys` fails ("the field is N characters short"); a longer field is a `warning` when the text is not compared (password, contenteditable); a readable field that the page reformats fails the text comparison ("the keyboard or the page changed the text").
  A field that swallows a key at the start and still fires `keydown` is caught that way; one that
  never changes at all looks like a self-resetting field and reports `ok` with `byEvent`.
- `--reinject` runs again only the injected files whose `@match`/`@include` fit the page it landed
  on (`@exclude` wins; no `@match` means everywhere). The skipped files are in `reinjectSkipped`.
  `safari inject` runs wherever you say and adds a `warning` when the page doesn't fit. Every file
  stays recorded until you drop it, so when two scripts are for the same site (comparing them) and
  more than one re-runs, `open`/`refresh` add a `warning` naming them: drop one with
  `safari inject --forget <file>` (output: `forgotten`, `remaining`; an unrecorded file is `ok: false`
  and lists what is recorded) or all with `safari inject --clear` (`cleared`). Neither runs anything in
  the page, and both take no other word (`--forget` exactly one file, `--clear` none).
- `--help`, `-h` and `help [command]` on `safari`, `sim` and `lab` print the usage as JSON and run
  nothing (no lease, no run folder, no simulator or phone). Text that is exactly `-h` or `--help`
  can't be typed through `type` or `eval`; `keys` takes it after `--`.
- Device ids in output are masked as `…` plus the last 4 characters (`…5F60`), in JSON, `run.log`
  and stderr. `lab phone status` and `lab phone setup` print the full saved UDID. Never paste
  a full UDID into a report or a commit.
- **`--allow-host <host>`** (on `safari start`, passed through by `lab up`; phone only) lets the lab follow its
  own tab to a host the page sends it to (a login redirect, a short link) instead of tainting the run. A host
  is `name`, `name:port`, an IP or `localhost`: no scheme, path, login or wildcard, no automatic `www` twin;
  at most 10; a reused session takes the union and never loses a host. The lab marks the tab again by the
  same probe and mark steps as after `open`, reinstalls its console and network collectors (it never injects
  scripts again) and runs the command; the result has `followed: [<origins>]` (a refusal too). The tab
  moving to any other site still taints the run, and the refusal says so: with no list it adds how to start
  one next time. The owner navigating the lab's tab to an allowed host by hand is followed as well. On the
  simulator the hosts are not stored (`note` says it has no tab guard).
- `open` and `refresh` on the phone mark the tab again after the navigation. If the page list moves
  during that moment they wait for it to settle (up to 5 s) and retry once, saying `markRetried: true`.
  A second move still ends the run with `needs: "tab"`.
- Injected scripts start after load and only provide `GM_info`; they are lost on every navigation
  and refresh. State this limit in your report; if timing matters, say it needs a real-device check.
- Other Safari extensions of the owner's can run in the lab's tab on the phone, but the Userscripts
  app's scripts did not in one run (iOS 27.0.1, cable, 2026-10-27; cause unknown,
  issue 102). To test a userscript on the
  phone, `safari inject` the file; don't rely on the installed copy.
- `inject` right after a navigation may run in the outgoing page and do nothing (seen once, not
  reproduced). `inject` watches for half a second afterwards and says so (`pageChanged: true` and a
  `warning`) when the page showing is no longer the document the script ran in; then run it again,
  unless the script navigates by itself. Waiting for the page first (`safari wait <css>`, or
  `open --wait-for`) avoids it (issue 102).
- `safari network` reports `count` and `requests` differently per target. **Simulator:** `count` is the
  raw events saved in `network.json`; `requests` is one entry per request (method, url, status).
  **Phone:** `requests` are the entries, and `truncated` covers the rest.
- `safari console` and `safari network` drain their buffer on each read. They read from different
  places per target. **Simulator:** Safari's own log through Appium; `dropped` counts byte-identical
  copies and WebDriverAgent's own entries, and `truncated`/`copies` say Appium's 5000-entry buffer
  filled. **Phone:** `console` comes from a collector the lab places in its own tab (it misses what
  the page logged before the collector was installed); `network` is the lab page's own Resource
  Timing, limited to the sites the lab tab visited, so `dropped` is 0 and there is no `copies`.
  Its `requests` have `method: null` (Resource Timing has no method), a `status` that was `null` on every
  entry on iOS 27.0.1, and sizes of 0 for another site's requests that send no `Timing-Allow-Origin`. `outside` counts
  entries to other sites (by design; a userscript's own cross-origin calls land there, and
  `GM_xmlhttpRequest` probably isn't seen at all); `truncated: true` means 500 were read and more
  are waiting (read again); `lost` is entries past the collector's 2000; `early: true` means the
  browser's 250-entry buffer was full when the collector started, so the oldest are gone. Don't run
  `eval` on the page's timing entries on the phone to fill the gap: it prints every site the page
  talked to. A redirect to another site is refused. Console URLs and text mask secret query values
  (`token`, `key`, `k`, `code`, ...) on both targets.
- On the simulator a failed page command leaves `fail.png` and `fail.html` in the run folder; the phone saves neither.
- Simulator only: `sim tap --label`, `sim scroll`, `sim shot` for Safari's own UI and system
  prompts. While a `safari` session is open `sim tap` and `sim type` do nothing, silently.

## 5. Finish

1. **`lab down` when the work is over**, always. It closes the lab's tab (phone) or shuts the
   simulator down, ends the session, stops Appium and WebDriverAgent (and the Wi-Fi tunnel: step `tunnel`, also with `--keep-service`), and releases the lease so the
   next agent isn't kept waiting. If it says `ok: false`, run it again; the lease is kept for a retry.
   On the phone this is also the battery rule: the phone stays awake while a lab session runs
   and only locks normally after `lab down`.
   On the phone it also sets the owner's Auto-Correction and Predictive back on (WebDriverAgent turns
   them off for the whole phone while a session runs); the output says `keyboardRestored`. If that is
   `false`, relay its `human` step (turn them on in Settings > General > Keyboard); the teardown still finished.
   `keyboardNote` says why a restore failed (in the JSON, not on stderr).
   If you changed the phone's appearance or orientation, `lab down` puts them back too (a `phone-settings` step when a
   record was left behind) and says `phoneRestored`; see section 4. The same goes for Lab Focus: `lab down` runs the owner's
   "Lab Focus Off" shortcut (the Shortcuts app is then in front on the phone), unless the phone is locked: then the record is kept.
2. For a short break use `safari stop` instead: it ends the session, closes the tab and releases the
   lease, but leaves Appium (and the simulator) warm. A lab on which no command that takes, renews or releases the lease has run for 15 minutes (`sim shot` and `sim ui` count; `lab status` doesn't) is stopped by
   the **idle stop** (a LaunchAgent `lab service install` adds): it does what `lab down` does, so
   a break longer than 15 minutes ends in a cold `lab up`. `lab status` shows `idleStop` (the last stop,
   and `tabLeft` with a `human` step if the phone could not be reached; `heldUntil` and `nextStop` say when it will next act). It is a safety net, not
   a reason to skip `lab down`.
   If you hand the simulator to the person to use by hand (they sign in, look around), run
   `lab hold` first (`--minutes N`, 1 to 120, default 60): the idle stop leaves the lab alone until then,
   even though nothing runs a lab command. It takes no lease, so it never blocks another agent; `lab down`
   or a fresh boot of the simulator ends it. It is refused when nothing the lab started is running.
3. **Stop every server you started** yourself (a dev server for the page, say), and clean up
   whatever the project's rules require. `lab down` never stops a server it didn't start.
4. In your report, say what ran on which target, what didn't, and what still needs a check on the
   other one.

If a command is interrupted (`interrupted` in its output, exit 130, 143 or 129), nothing is torn
down: the session, Appium and the lease are kept. Run `lab status` first. On the phone, **a page
command that was already sent may still finish in the lab's tab** (`sessionKept: true`; `tainted`
says whether the run still trusts the tab): check the page before you repeat a click or a type.
An interrupted `safari stop` or `lab down` keeps the session record (and `lab down` the lease, with
no later step run) unless the session was already deleted: run it again to finish.

## 6. The `needs` table

A device failure that a person can fix carries four fields: `needs` (one of the values below),
`human` (steps for a person), `then` (the command **you** run afterwards) and `or` (the way out
without the phone, normally `lab up --target simulator`). **Stop, relay the `human` steps to the
person word for word, and run `then` once they say it's done.** Don't improvise past a `needs`,
and never change the phone's or the Mac's settings yourself. When `then` is a `lab up`, it already
repeats the flags your run was given that fit its target (`--allow-host`, `--url`, `--appearance`,
`--orientation` and `--no-focus` for the phone; `--url` and `--profile` for the simulator; never
`--force`): run it as it is, and don't add or drop any. It holds `--url` as given, so keep secrets out of it.

| `needs` | What it means | Human steps to relay | Then (you run) |
| --- | --- | --- | --- |
| `setup` | No phone is saved yet | Run `lab phone setup --udid <phone UDID> --team <10-character team id>` once to save the phone (UDID: Xcode > Window > Devices and Simulators; team id: Xcode > Settings > Accounts). | `lab phone setup --udid <UDID> --team <TEAM>` (with their values) |
| `xcode-account` | Xcode can't sign for the team: no account, or no Apple Development certificate (a bare "banned" in Xcode's output lands here too; Apple's `0xe8008018` / `0xe8008024` codes go to `resign`) | On the Mac, open Xcode > Settings > Accounts and sign in with the Apple ID used for the lab (a free account works). Make sure the account has an Apple Development certificate (Manage Certificates > +). | `lab up --target device` |
| `keychain` | The signing tool is waiting for a keychain prompt nobody can click (unattended or over SSH) | At the Mac itself (not over SSH), run `lab up --target device` and click Always Allow when the keychain prompt for codesign appears. | `lab up --target device` |
| `developer-mode` | Developer Mode is off on the phone | On the phone: Settings > Privacy & Security > Developer Mode, turn it on, restart the phone and confirm. | `lab up --target device` |
| `trust` | The phone doesn't trust this Mac, or the developer profile | Unlock the phone, connect the cable and tap Trust This Computer. On the phone: Settings > General > VPN & Device Management, open the developer profile and tap Trust. (When the evidence is the developer profile alone, "has not been explicitly trusted" or "Developer App Certificate is not trusted", only the second step is given.) | `lab up --target device` |
| `unlock` | The phone is locked (or locked mid-session: a command that times out on a locked phone, or finds its tab gone, says this, not `tab`, and the session and its tab are kept) | Unlock the phone and keep it awake while the lab runs (Settings > Display & Brightness > Auto-Lock). | `lab up --target device` |
| `passcode` | iOS is asking for the passcode to "enable UI automation" (the first WebDriverAgent start after a while) | Enter the passcode on the phone when it asks to enable UI automation. A timeout here means exactly this. | `lab up --target device` |
| `cable` | The phone isn't reachable: unplugged, or not seen on the network (the Mac's list of network devices doesn't include it, or its link dropped; also devicectl's "connection to this device could not be established", CoreDeviceError 4000, after one automatic retry). A phone the lab last reached over Wi-Fi that is gone says `tunnel` instead | Connect the phone to the Mac with a cable, unlock it, and tap Trust if asked. Or, once the phone has been paired over the cable, put it on the same Wi-Fi network as the Mac. If the phone is already connected and this came right after it sat idle, run the command below again: the connection to it dropped. | `lab up --target device` |
| `tunnel-tool` | Wi-Fi needs the pymobiledevice3 tool and it is missing or older than 11.40.2 (a version check that times out twice is `tunnel`, not this) | Wi-Fi needs the pymobiledevice3 tool, version 11.40.2 or newer, and it is missing or too old. Run `brew install uv` if uv is not installed, then `uv tool install --python 3.14 pymobiledevice3` (to upgrade: `uv tool upgrade pymobiledevice3`). Or connect the phone with a cable. | `lab up --target device` |
| `tunnel` | The Mac could not open or keep a route to the phone over Wi-Fi: no tunnel within 45 s, it dropped, it reached another device (the tunnel is refused when the device is not the saved phone), or the pymobiledevice3 version check timed out twice (the tool is probably fine: the person runs the command again; the `human` steps then say so and have no install steps). Also from a page command that got no answer over Wi-Fi: the tunnel does not answer, or WebDriverAgent does not answer through it (the error's `tunnel` field says which; the session is kept and not tainted) | The Mac could not open a route to the phone over Wi-Fi: no tunnel within 45 s, it dropped, or it reached another device. Unlock the phone and keep it on the same Wi-Fi network as the Mac. If the error names a refused, timed-out or no-route connection, check for a VPN, a different network or band, or the phone's Wi-Fi asleep. Run the command below again, or connect the phone with a cable. | `lab up --target device` |
| `resign` | The lab app's signing expired or Apple rejected it | With the phone unlocked, run the command to sign it again. If a re-sign doesn't fix it, Apple is rejecting this team: run `lab phone setup` with another team. | `lab up --target device --resign`; or: `lab phone setup --udid <UDID> --team <ID>` (the output also has `simulator`) |
| `slots` | A free Apple account allows 3 apps (or 10 new app IDs a week) on the phone; or, in `lab up`'s `slot` step, the phone is full and sideload could not lend the lab a slot (`failedStep: "slot"`; the last `human` line is sideload's own advice) | Delete an app you don't need from the phone, such as an old lab runner. For a `slot` failure the steps say what sideload needs (a lendable app marked, the app signed again, the phone saved in sideload, the sideload binary found). | `lab up --target device` |
| `busy` | sideload (the owner's other signing tool) is signing or installing an app with the same Apple team, so the lab did not start; nothing was opened on the phone | sideload is signing or installing an app with the same Apple team; try again in a minute. | `lab up --target device` |
| `tab` | The lab can't confirm its own Safari tab is the one showing (switched away from, which only pauses the session until the owner switches back: native actions are refused, and `url`, `eval` and `wait` can be too when Safari pauses the background tab, with "did not answer within 10s"; or navigated by hand, closed, or replaced, which taints the run). Over Wi-Fi a command that got no answer (or found the tab gone) checks the route first: a dead tunnel, or WebDriverAgent silent behind a good one, is `tunnel`, a locked phone is `unlock`, and only a working route and an unlocked phone leave `tab`. A command that gets no answer is not taken for a move, with one exception: if the owner switches away while `open` or `refresh` is putting the marker back into the lab's tab after a navigation, the command says the tab did not answer while it was being marked again (untainted); if the navigation went to another origin the next command taints the run (`safari start` then opens a fresh tab), and on the same origin the session goes on. Nothing was read from any other tab. The tab left behind can be on the page of the failed command, not the page the session started on; the output (and `safari start`'s `previousTab`) names the last site the lab sent it to. With allowed hosts (`--allow-host`), a tab that went to one of them is followed, not refused; one still loading there after 30 s is `tab`, untainted ("run the command again"). | Switch back to the lab's tab (the one the lab opened), or run the command to end this session and open a new one. If the output says the lab *lost track* of its tab, run it and close the old lab tab on the phone by hand; the text says which site it was last sent to ("the lab last sent it to https://..."), and the tag (`example.com/?msl-...`) is only where it started. `safari start` and `lab up` put that step in `human` as well as `previousTab`: relay it. | `safari start` |
| `service` | Appium isn't running with up-to-date log redaction, so page URLs, titles, script arguments or typed text could reach its log (at `--log-level debug`, command results too) | Run `lab service install` (again, if the log-filter rules are out of date): it starts Appium with a log that leaves out page URLs, titles, script arguments and typed text. | `lab service install` (the person runs it; you don't) |
| `shortcut` | Only inside `lab up`'s `focus` block (`focus: {applied: false, needs: "shortcut"}`; `ok` stays true, no `then` or `or`): the lab could not run its Lab Focus shortcut (the Shortcuts app is missing, or the launch failed). The session is open; Lab Focus is not on | Make the Focus and the two shortcuts (once): Settings > Focus > + > Custom, name it "Lab", and silence notifications from all apps (the default allowed-apps setup lets Time Sensitive ones like Reminders through); Shortcuts > + "Lab Focus On" with the action Set Focus > Turn Lab On Until Turned Off; Shortcuts > + "Lab Focus Off" with Set Focus > Turn Lab Off. Names are saved with `lab phone setup --focus-on-shortcut/--focus-off-shortcut`; `lab up --no-focus` skips it. | `lab up --target device` (after the owner's steps) |
| `unknown` | None of the above matched | Read the error. `lab phone status` shows what the Mac can see of the phone. | `lab phone status` |

Every `needs` also has `or`: when the person can't or won't do the steps, run
`lab up --target simulator` and say in your report that the iPhone wasn't tested.

**`busy` and the shared signing lock.** The lab and sideload (the owner's tool that signs and
installs apps on the same phone, with the same free Apple team) take one lock between them,
`$SIDELOAD_HOME/.op.lock` (`SIDELOAD_HOME` defaults to `~/.sideload`), a BSD `flock`. Two tools
signing at once make Xcode create a second signing certificate, and a free account allows very few.
The lab holds it only while a device session is created: the lab's tab, the WebDriverAgent build and
launch (including a re-sign) and the Appium create; never for page commands, while a session is open,
or on the simulator. A `lab up` that will create a new phone session also looks at the lock early (a
`signing lock` step, before the tunnel, the phone settings and Lab Focus; before Appium too with
`--target device`), so a busy lock costs a second, not 8 to 20 s of setup. If sideload holds it the lab
does not wait: `lab up` / `safari start` stops with `needs: busy` before opening anything on the phone, and
the `then` command is safe to run again in a minute. A lab that dies lets the lock go (the kernel drops it). If `~/.sideload` doesn't exist the
lab takes no lock. The lab never creates sideload's folder and never deletes the lock file; inside an
existing folder it may create the file (mode 0600), as sideload does.
`MSL_SIGNLOCK=off` turns the lock off. It is for the owner only (an escape hatch for a stuck lock,
and for tests): never set it yourself. A start that would have taken the lock reports
`signLock: "disabled"` and a `warning` ("sign lock disabled; sideload may sign at the same time (Xcode
may then create a second certificate)") in its JSON, also when it fails. Relay that warning to the person.

**`slots` and borrowing a slot from sideload.** A phone `lab up` has a `slot` step (after `phone`, before the tunnel and
Lab Focus). It lists the phone's apps once; with WebDriverAgent missing it installs the runner, and only when installd
refuses with the free-account app limit does it ask sideload to lend a slot (`sideload slot lend --udid <saved UDID> --to
lab`; the owner's lendable app, Stremio, is taken off the phone and put back at the idle stop or `lab down`). Things to know:
- **`lab up` may take about 17 minutes in the `slot` step** for the lend, plus the WebDriverAgent build (first time) and up to two installs (sideload's lend can back up the app's data first). Run
  it in the background as for a cold simulator boot, not in a foreground command capped at 10 minutes, and do not run it a
  second time while it runs. A `needs: busy` with `retryAt` from that step means sideload is still working or the result is
  not known: run `lab up` again after `retryAt`, not before.
- The result may carry `slot: {lent: "<app>", ...}`: say in your report that a slot was borrowed from sideload and the owner's
  app is off the phone until the lab gives it back (`lab down`, the idle stop or `lab phone slot return`).
- `needs: slots` from the `slot` step is the owner's to fix (relay `human`, last line is sideload's own advice). Never run
  `sideload` yourself, never `lab phone slot forget`, never delete or reinstall an app on the phone.
- **`MSL_SIDELOAD_BIN`** (an absolute path to the sideload binary) is the owner's, and for Stage 2 testing against sideload's
  debug build; never set it yourself. Without it the lab finds `sideload` on `PATH` (the idle stop remembers the path the
  lend used). A wrong value is refused, not replaced. `lab service install` passes it and `SIDELOAD_HOME` to the idle stop.

## 7. Hard rules

- **Never `--force`** on `lab up`, `lab down` or `lab release` unless the person says the other
  agent is done: it takes the simulator from whoever is using it.
- **Never type or tap into Safari's address bar.** Typing there and pressing Return performs a web
  search. `tap` and `swipe` refuse the toolbar; don't work around it. Use `safari open <url>`.
- **Never touch the owner's other tabs.** The lab opens its own tab on the phone and every command
  checks it is the one showing. Don't switch tabs, open Safari by hand on the phone, or try to read,
  close or reuse another tab. If a command refuses with `needs: "tab"`, relay it; don't retry around it.
  Switching away from the lab's tab only pauses the session: `tap`, `keys`, `swipe`, `shot` and `ui`
  are refused with `needs: "tab"` (nothing done on screen, not tainted) until the owner switches back;
  `url`, `eval` and `wait` can be refused too when Safari pauses the background tab ("did not answer
  within 10s", also untainted, and `pending` on the next command until the tab shows). A busy page can
  hold a script up the same way (issue 104): the next command that gets no answer then says "Appium is still
  waiting on a script the lab sent to its tab", and `lab status` shows `waitingSince` next to
  `usable: false`. Wait, or run `safari start` if it has not cleared within a minute. `open` and
  `refresh` give each script of their navigation up to 30 s, since a loading page is busy. **A refused
  command can still finish in the lab's tab once it shows** (Appium runs one command at a time and
  the refused one waits in its queue): after the owner switches back, check the page before you
  repeat a click or a type. A refused or late script never runs in another tab, and a tab the owner
  opens while you work does not pull the session into it: Appium runs with the lab's `msl-page-pin`
  plugin, and a command it refuses says so (`needs: "tab"`, tainted, nothing ran). If `lab status`
  lists the page pin as missing, or `safari start` is refused with `needs: "service"` about it,
  relay it: the person links the plugin and runs `lab service install`; don't run that yourself.
  The session ends (the run is tainted) only when the lab's own tab changes under it (navigated by
  hand, closed, replaced) or the session is found in another page: `safari start` then opens a fresh tab.
  The exception is a host the session was started with (`safari start --allow-host <host>`, or `lab up
  --allow-host <host>`; repeatable, up to 10, exact match, http and https): a tab that went there is
  marked again and followed, and the output says `followed`. Ask the person which hosts to allow; never
  add one yourself to get around a refusal. After a taint the list is gone: the refusal names the hosts,
  and the new session names them again.
- **The idle stop stops only what the lab started.** `lab down --idle` is run by its LaunchAgent, not by
  you; don't run it, install or remove the agent (`lab service install --no-idle-stop`) on your own.
  `lab hold` is yours to run, for a hand-over to the person (section 5, step 2); it only delays the stop.
  It never shuts down a simulator the lab didn't boot and never touches another simulator.
- **Never widen the network binding.** Appium and everything else the lab starts listen on
  `127.0.0.1` only. Don't pass `0.0.0.0` or a LAN address. The Wi-Fi tunnel's address (`fd...`, in
  `lab tunnel status`) is not a LAN binding: it is the one address the lab's WebDriverAgent binds on the
  phone, and the lab sets it; never pass it to anything else, and never run `pymobiledevice3 remote tunneld`.
- **Keep secrets out of run folders.** Don't put passwords, tokens or real personal data in URLs,
  injected scripts or typed text; `source` and `fail.html` are the page's raw HTML and `network.json`
  can hold more than you expect. Don't paste them wholesale into reports or commits. `--storage`
  values are kept out of every file the lab writes and, through the service's rules, out of Appium's
  log, but that is no reason to use a real secret. At `info` (the default) script arguments, typed
  text and request bodies are redacted there; `--log-level debug` also logs command results,
  including text `keys` reads back from a field, so use it only for debugging and delete the log
  afterwards. **`safari eval` script text reaches Appium's info log** (only its arguments are
  redacted): put a sensitive value in `--storage` or in typed text (`type`, `keys`), never in the
  source of an `eval`. The rules cover the service's Appium and the one
  the lab starts itself (both at log level `info`); an Appium started by hand or reached through
  `MSL_APPIUM_URL` is not checked, so `type` text may be logged there. A service that started
  before its rules file was last written may hold older rules, so it is refused (`needs:
  "service"`, `lab service install` again), and `type` and `keys` refuse the same way before they
  send anything. Once `type` or `keys` has sent its first character, a failure saves no
  `fail.png` or `fail.html` and its message holds no typed text (`keys: character #3 did not
  land`); a failure before that keeps them.
- Only open URLs from the task or the project (localhost, test pages). Don't sign in, buy, post or
  submit forms with real data, and never sign a simulator into an Apple ID.
- Use only `sim reset` to erase the clean Claude iPhone simulator (the configured one only on the person's say-so: it erases their sign-ins). Never type a password, code or any secret into a simulator. Never touch other simulators, and
  don't use `xcrun`, `devicectl` or `xcodebuild` on the phone yourself: the lab passes the saved UDID.
- Don't install tools, enable settings, or run `lab service install` / `lab phone setup` on your own.

## 8. Privacy

The phone is the owner's daily phone. What the lab does and doesn't do there:

- It opens **its own tab**, pins it, checks it before every command, and never reads or runs
  anything in another tab. The one exception is a yes/no check at session start that the attached
  page is the lab's tab. Appium's `msl-page-pin` plugin stops it following a tab the owner opens;
  the one moment it does not cover is session creation, before the plugin pins the session, so tell
  the person not to open or switch tabs while `lab up` or `safari start` creates it. It passed a live check on the phone (iPhone item 19, 2026-10-19).
- Safari **restarts** when the lab opens its tab; the owner's other tabs reload when next viewed,
  and unsaved text in a form in one of them can be lost. Warn the person before the first run if they
  may be in the middle of something.
- `safari stop` and `lab down` close the lab's tab (or blank it, or say `tabClosed: false` with a
  `human` step to close it by hand). In `lab down` that is `steps[session].tabClosed` (the tab's `human` step is in
  that step too); the top level has `keyboardRestored` and its own `human`. After a dropped Wi-Fi tunnel a replaced session's keyboard
  is `keyboardDeferred`: the new session restores it when it ends.
- Appium's log leaves out page URLs, titles, script arguments and typed text at the default `info` level (storage values included; `--log-level debug` also logs command results, including text read back from fields); `lab up` refuses to drive the phone without that, or when the rules are out of date
  (`needs: "service"`). `network` on the phone is limited to the lab tab's sites and a fixed set of
  fields, and an off-site redirect is refused (the session's `--allow-host` hosts excepted). Device ids are masked in output (`…5F60`).
- A plain screenshot is the whole screen (`--page` and `--element` cut it to the web content), and the owner's extensions and logged-in sessions are live in
  the page you test (on the simulator too, with `--profile configured`). Treat what you see as the owner's data.
- Everything the lab starts on the Mac listens on `127.0.0.1` (Appium, and the small registry the tunnel host
  serves for Appium; the pymobiledevice3 tool opens no listener). WebDriverAgent is told to listen on `127.0.0.1` on the simulator and over the
  cable, and on the tunnel address only over Wi-Fi, so nothing else on the Wi-Fi can drive the phone. While the tunnel is up,
  other programs on the Mac can reach the phone's services through it, much as through usbmux over a cable (the idle stop and
  `lab down` end it). Reaching the phone away from the Mac's network is not supported.

## 9. Report what you find (bugs, features, docs)

You may be working in another repo. Watch for lab problems as you go and file them. The backlog
is the issues in `dividedby/mobile-safari-lab` (public: no device IDs, team IDs or whole-phone screenshots in
them, see `CONTRIBUTING.md`; labels `bug`, `enhancement`, `documentation`); in the lab's own repo it is the CLAUDE.md "Agent skills" line.

**While you work.** Note anything that failed, surprised you, was slow, needed a workaround, or that
the docs got wrong or left out. Write it down at the time in `<run folder>/lab-feedback.md` (the
run folder is the `run` field of every command). One line each: the command, what happened, the
JSON `error`, `needs` or `human`, and what you expected.

A loose idea that isn't a bug or a clear request goes to the top of the
[Idea Inbox](https://github.com/dividedby/mobile-safari-lab/issues/6) instead (`docs/agents/idea-inbox.md`).

**What counts.**
- A lab bug: a wrong result, a crash, a misleading `error` or `human`.
- A missing feature: something you needed and the commands can't do.
- Friction: too many steps, slow, a confusing output field.
- Docs that were unclear or wrong.
- Not: bugs in the other repo's own code (those go to that repo, after asking the owner), or a
  `needs` the lab handled as designed (a locked phone, a tab switch).

**When you finish (or are blocked).**
1. De-duplicate against the open issues:
   `gh api 'repos/dividedby/mobile-safari-lab/issues?state=open&per_page=100' --paginate --jq '.[] | select(.pull_request | not) | {number,title}'`.
   If an item is already filed, comment on that issue instead of opening a new one.
2. Show the owner the list in one message and file it once they say OK. One OK covers the batch.
3. File one issue per distinct bug or feature. Small docs or friction items can share one issue.

**How to file.** REST, with the body in a file written with the Write tool (no heredoc):
- New issue: `gh api -X POST repos/dividedby/mobile-safari-lab/issues -f title='...' -F body=@<file> -f 'labels[]=bug'` (or `enhancement`, `documentation`).
- Comment: `gh api -X POST repos/dividedby/mobile-safari-lab/issues/<n>/comments -F body=@<file>`.

**Body.**
- Context: the calling repo and task, the lab commit (`git -C <lab> rev-parse --short HEAD`), the target (iPhone or simulator), the iOS version.
- Steps to reproduce: the exact commands.
- Expected vs actual: the JSON `error`, `needs` or `human`, trimmed.
- Workaround used, if any.
- Impact: blocked, slowed down, or cosmetic.
- For a feature: what you were trying to test, and why the current commands fall short.

**Privacy.** The owner's rules apply to issues too.
- No secrets, tokens, cookies, session ids or response bodies.
- No full device UDID; the lab's `…last4` form is fine.
- No personal data, account names or other people's content.
- Cut private or signed-in page URLs down to their origin.
- Attach no screenshots; name the run-folder path instead.
- Never paste env vars.

**Don't** edit the lab's code from another repo, work around its guards to finish a test, or open
issues for things already handled by design.
