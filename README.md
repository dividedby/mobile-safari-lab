# mobile-safari-lab

Drive **real Mobile Safari** in the Xcode iOS Simulator, or on your own iPhone, from Claude
Code (or by hand): screenshots, taps and typing on the phone, plus DOM access and JavaScript
in the page. It replaces iPhone Mirroring for routine testing. The simulator is the default
when no phone is saved; the iPhone is the final check, and it drives only its own tab.

Three small command-line tools, no dependencies in this repo:

| Tool | Drives | Built on |
| --- | --- | --- |
| `bin/sim` | the phone: boot, open a URL, screenshot, tap, type, scroll, accessibility tree, dark mode | `xcrun simctl` + [AXe](https://github.com/cameroncooke/AXe) |
| `bin/lab` | availability: one command (`lab up`) that gets a working simulator or iPhone and Safari session whatever state the Mac is in, `lab down` that stops it all again (and stops it by itself after 15 minutes idle), `lab phone` to save the iPhone, the Appium LaunchAgent, and the simulator lease that keeps two agents apart | `launchctl`, `xcrun simctl`, `xcrun devicectl`, the other two tools |
| `bin/safari` | the page: open, refresh, find by CSS, click, tap and type like a finger, scroll, run JS, inject a userscript, page source, console and network logs | [Appium](https://appium.io) XCUITest (kept outside this repo), on the simulator or the saved iPhone |

Every command prints JSON. Screenshots, page source and logs go into a run folder
(`runs/<date>-<label>/`, newest 20 kept, gitignored). Plans and reasoning:
[ADR 0001](docs/adr/0001-safaridriver-first.md) and
[ADR 0002](docs/adr/0002-appium-for-the-simulator.md); the Wi-Fi tunnel is
[ADR 0006](docs/adr/0006-wifi-tunnel.md).

Issue and pull request numbers in this README, the CHANGELOG, the docs and code comments written before the repo went
public (2026-10-31) are plain text ("issue 98"): they refer to the private archive, not to this repo's issues.

> **Status:** 0.10.0, with iPhone support. The simulator passes the
> [acceptance checklist](docs/acceptance.md) on a Mac (macOS 27, Xcode 27, iOS 27 simulator),
> including Phase 2: the Appium LaunchAgent, `lab up` and the simulator lease. The iPhone path
> was re-checked live on 2026-10-18 (iOS 27.0.1, a free Apple ID, by cable and over Wi-Fi); the
> iPhone items of that checklist are partly done. `safari wait` (item 16), the `shot` crop
> (item 17), `open --storage` (item 18) and the page pin (item 19, issue 37,
> which keeps a tab you open from receiving a lab script) were run live on 2026-10-19 (simulator
> and iPhone; items 17 and 19 on the iPhone only) and pass. The idle stop (item 20,
> issue 40) is built and covered by tests; its first live idle tick passed (Appium stopped after 15 idle minutes), the
> rest of its live check is open, and so is the simulator `keys` re-check after the 0.5.0 fix. **Upgrading from 0.4.0:** link the
> plugin (`pnpm add link:<this repo>/appium-plugin` in `~/.local/share/msl-appium`) and run
> `lab service install` again; it loads the page pin plugin and installs the idle agent. The iPhone over Wi-Fi with no cable (issue 15) is built, covered by tests and checked live on the phone (2026-10-23, items 24 to 36 of the acceptance doc). The first run passed the walk-up, the LAN isolation, the cleanup after `lab down` and the re-sign over the tunnel; the re-check after the fixes (issue 58 to issue 62 and PR 70) passed the wrong-device refusal with an Apple TV on the network, a phone asleep for 10 minutes, Wi-Fi off and on (`lab up` back in 36 s), and a short Mac sleep. Not run live: the idle stop over Wi-Fi, `ssh localhost`, the first-run passcode prompt, a stuck CoreDevice, and `lab` as root. Away from the Mac's network is not supported. **Upgrading from 0.5.0:** run `uv tool upgrade pymobiledevice3` (Wi-Fi needs 11.40.2 or newer), then `lab service install` again; it installs the tunnel host. If sideload is set up on this Mac, phone starts now share its signing lock (`needs: busy` while sideload signs). Appearance and orientation on the iPhone (issue 27) and the Lab Focus (issue 16) are in 0.7.0 and partly checked live on the phone over Wi-Fi (2026-10-24, items 37 and 38 of the acceptance doc; both items stay open for the paths not run). **Upgrading from 0.6.0:** the Lab Focus is on by default for phone sessions. It needs the Focus you make and the "Lab Focus On" / "Lab Focus Off" shortcuts (see "Lab Focus during phone runs"); without them `lab up` still works and reports `needs: shortcut`. Turn it off with `lab phone setup --focus off` (saved) or `lab up --no-focus` (one run). `lab service install` does not need re-running for this release: the LaunchAgents are unchanged. Borrowing a sideload slot when the phone is full (issue 63) is in 0.8.0 and passed live on the phone over Wi-Fi (2026-10-25, item 41 of the acceptance doc; a crash mid-lend was not run). **Upgrading from 0.7.0:** nothing is required. To let the lab borrow a slot, sideload must be on `PATH` or named by `MSL_SIDELOAD_BIN`; the idle stop only gives a borrowed slot back if it can find sideload too, so run `MSL_SIDELOAD_BIN=<path to sideload> lab service install` once (the idle agent keeps `MSL_SIDELOAD_BIN` and `SIDELOAD_HOME`). 0.9.0 brings the iPhone over Wi-Fi back on iOS 27.2 (issue 111), with `eval` awaiting a Promise and `inject` saying when the page changed (issue 102), all checked live on the phone over Wi-Fi (2026-10-29). **Upgrading from 0.8.0:** nothing is required; the LaunchAgents are unchanged. `safari eval` now refuses an extra argument other than `--timeout <ms>`, and `safari inject` takes a file whose name starts with `--` only as `./--name`. 0.10.0 gives Safari's UI tree read 30 s (issue 98) and a busy page's scripts during `open` and `refresh` 30 s, with a note when Appium is still waiting on one (issue 104), checked live on the phone over Wi-Fi on www.reddit.com and sh.reddit.com (2026-10-31; issue 104's stall itself did not come back). **Upgrading from 0.9.0:** nothing is required; the LaunchAgents are unchanged. When `safari start` or `lab up` replaces a session whose lab tab may still be open, the step to close it by hand is now in `human` too (issue 103).
> Deviations of the simulator run: item 7's initiating session was a short-lived process rather
> than a Claude Code session ended over SSH; item 8 ran as a minor node upgrade, not a patch.

## Setup (once, on the Mac)

1. **Xcode** from the App Store (Xcode 27 needs macOS Tahoe 26.6+; on Sequoia use Xcode
   26.0–26.3), then the iOS simulator runtime (~8–10 GB):
   ```sh
   xcodebuild -downloadPlatform iOS
   ```
2. **AXe** (simulator taps and typing):
   ```sh
   brew install cameroncooke/axe/axe
   ```
3. **Appium**, for the page (installed outside this repo, with pnpm):
   ```sh
   mkdir -p ~/.local/share/msl-appium && cd ~/.local/share/msl-appium && pnpm add appium@3.8.0 appium-xcuitest-driver@12.18.1
   APPIUM_HOME=~/.local/share/msl-appium ~/.local/share/msl-appium/node_modules/.bin/appium driver list --installed   # should list xcuitest
   ```
   Link the lab's own **page pin plugin** into the same folder (after step 5 has cloned this
   repo; a link, so the plugin is always the code in your checkout). This is for the iPhone and
   simulator-only setups alike: `lab service install` refuses until the plugin is linked (step 7):
   ```sh
   cd ~/.local/share/msl-appium && pnpm add link:$HOME/repos/mobile-safari-lab/appium-plugin
   APPIUM_HOME=~/.local/share/msl-appium ~/.local/share/msl-appium/node_modules/.bin/appium plugin list --installed   # should list msl-page-pin
   ```
   Set `MSL_APPIUM_HOME` to install somewhere else. The first session builds
   WebDriverAgent into that folder, which takes about 2 minutes; later ones start fast.

   Without the service, `safari start` launches Appium on `127.0.0.1:4723` itself when it
   isn't running (log: `~/Library/Logs/msl-appium.log`) and `safari stop` ends it again.
   WebDriverAgent, on the phone and on the simulator, is told to listen on `127.0.0.1` only
   (`appium:wdaBindingIP`), so nothing else on the Wi-Fi can reach it.
   For a Mac that is used remotely, install it as a **LaunchAgent** instead (step 7):
   launchd keeps it running and restarts it when it dies.
4. **An iPhone**, optional: see [Real iPhone](#real-iphone). It needs step 7 (the LaunchAgent).
   For Wi-Fi (no cable) it also needs **pymobiledevice3** (11.40.2 or newer), installed as your own user
   with uv; the lab finds it in `uv tool dir --bin`, else `~/.local/bin`, never on `PATH`:
   ```sh
   brew install uv
   uv tool install --python 3.14 pymobiledevice3     # later: uv tool upgrade pymobiledevice3
   ```
   `sim doctor` reports its version (`pymobiledevice3`, `null` when missing) and, with a phone saved,
   a hint if it is missing or too old; that never makes `ok` false, since the cable and the simulator don't need it.
   `lab status` shows the same under `tunnelTool`; `lab up` over Wi-Fi without it stops with
   `needs: tunnel-tool`. A version check that times out twice is reported as slow, not missing:
   `lab status` and `sim doctor` say to try again, and `lab up` says `needs: tunnel`. The lab refuses to run as root: run every command as your own user.
5. **This repo** (Node 22+):
   ```sh
   git clone https://github.com/dividedby/mobile-safari-lab ~/repos/mobile-safari-lab
   echo 'export PATH="$HOME/repos/mobile-safari-lab/bin:$PATH"' >> ~/.zshrc
   mkdir -p ~/.claude/skills && ln -s ~/repos/mobile-safari-lab/skill ~/.claude/skills/mobile-safari
   ```
6. **The simulator:**
   ```sh
   sim doctor     # lists anything missing, with a fix for each; exits 1 if any (with a phone saved it also
                  # reports phoneDisplay: whether devicectl can set the iPhone's appearance and orientation; never fails ok)
   sim create     # "Claude iPhone": newest iPhone on the newest iOS runtime
   sim boot       # opens Simulator, or Device Hub on Xcode 27, and waits for the boot
   ```
   `sim create` boots a new simulator once to finish its first-boot setup (iOS migrates the device's
   data, about 11 minutes on a loaded 8 GB Mac), waits up to 25 minutes, then shuts it down again.
   Run it in the background if a tool caps a command's time (Claude Code's is 10 minutes).
   In the new simulator, open Safari once by hand and dismiss its first-run screens.
   Don't sign in to an Apple ID or save passwords on it.
   Optional: `sim create --profile configured` makes a second simulator that keeps sign-ins you make by
   hand ("Two simulators" under Using it).
7. **Appium as a LaunchAgent** (recommended when Claude uses the Mac remotely):
   ```sh
   lab service install      # writes ~/Library/LaunchAgents/com.dividedby.msl-appium.plist and loads it
   lab service status       # loaded, pid, reachable, the node it runs, the log level, and anything wrong
   ```
   This runs Appium as you, in your login session (the `gui/<uid>` domain, so it can reach
   the simulator), with the page pin plugin (`--use-plugins msl-page-pin`; `install` refuses
   until the plugin is linked as in step 3, and `lab service status` lists a plist without it),
   on `127.0.0.1:4723` only, restarted by launchd if it dies, with its log in
   `~/Library/Logs/msl-appium.log`. If you started Appium by hand it refuses and names the
   process; `--replace` stops that one (its session is lost). `lab service uninstall`
   removes it again (the Appium install, the WebDriverAgent build and the log are left
   alone). While it is installed, `safari start` and `lab up` wait for it rather than
   starting their own Appium, and `safari start --port` must stay 4723. `safari stop` ends the session but leaves the
   service's Appium running; `lab down` stops it too (see below). `lab service install` and
   `uninstall` take the simulator lease while they run, so another agent's live lease
   refuses them, and hand it back when they end (also when they fail); a lease you already
   held is kept and renewed. They leave none behind.

   `lab service install` also installs the **idle stop**, a second LaunchAgent
   (`com.dividedby.msl-idle`) that stops the lab when no lab command has used it for 15 minutes (see
   "The idle stop" below). `lab service install --no-idle-stop` skips it (and removes one that
   is installed); `lab service uninstall` removes both. A failure installing it is reported
   as `idleStop.error` and does not fail the service install.

   It also installs the **tunnel host**, a third LaunchAgent (`com.dividedby.msl-tunnel`, plist
   `~/Library/LaunchAgents/com.dividedby.msl-tunnel.plist`, log `~/Library/Logs/msl-tunnel.log`, mode 0600)
   that holds the Wi-Fi tunnel to the phone (see "Using Wi-Fi"). It has no `RunAtLoad` and no `KeepAlive`: it is
   loaded and idle until `lab up` over Wi-Fi (or `lab tunnel up`) starts it with `launchctl kickstart`, and
   `lab down`, the idle stop and `lab tunnel down` stop it. Used with the cable only, it never runs.
   `lab service uninstall` removes it; `lab service status` shows it under `tunnelHost`.

   The plist records the absolute path of `node`: `/opt/homebrew/bin/node` when that leads
   to the node running the install, otherwise the first stable `node` symlink on `PATH`
   (never a versioned Cellar path, so a Homebrew patch upgrade keeps working). `lab service
   status` shows the path it chose as `node`. **A node major upgrade, or moving node, may
   need `lab service install` again**; `lab service status` lists it under `issues` when the
   recorded node no longer exists.

   For a debugging session, `lab service install --log-level debug` makes Appium's log more
   detailed; the log-filter rules stay on, and `lab service status` shows the `logLevel`. At
   `info` (the default) script arguments, typed text and request bodies are redacted; at `debug`
   Appium also logs command results, including text read back from fields (`keys` reads the field
   to check it). Use `debug` only for debugging and delete the log afterwards. Switch back with
   `lab service install`.

## Using it

Start every session with one command. It checks, and fixes what it finds, in order: the
simulator lease, Appium (waits for the LaunchAgent, or starts Appium if there is none), the
simulator (boots it if it is shut down), and the Safari session (reuses a working one,
replaces a dead one), then optionally opens a page. Each step says what it found and did;
a second run finds everything healthy and does nothing:

```sh
lab up --url http://127.0.0.1:3000/   # --url is optional; --force takes a live lease
lab up --profile configured           # the simulator with sign-ins you made by hand (see "Two simulators")
lab status                            # everything `lab up` looks at, changing nothing
lab status --check-update             # the same, asking GitHub again for the lab's own version
lab hold [--minutes N]                # keep the idle stop off while you use the simulator by hand (default 60, 1 to 120)
lab tunnel up | down | status         # the iPhone's Wi-Fi tunnel by hand (up and down take the lease; status shows it and, with it up, whether the route to the phone works: `reaches`)
lab release                           # hand the simulator back (`safari stop` does too)
lab down                              # when you're done: stop everything the lab started
```

`lab down [--force] [--keep-service]` is the way to finish. It ends the Safari session,
shuts the Claude iPhone down (by its UDID, and the configured one too if there is one; no other simulator is touched), quits the
Simulator or Device Hub window **only if** `sim boot` or `lab up` opened it and no other
simulator is booted (a window you had open is left alone, and nothing is ever killed: it
asks the app to quit), stops Appium, and releases the lease. For the LaunchAgent that
means `launchctl disable` then `bootout`: the plist stays, but Appium doesn't come back at
your next login either; `lab up` enables and loads it again (and `lab service status`
calls that "not loaded", which is normal after `lab down`). Without the LaunchAgent it
stops the Appium the lab started, after checking with `ps` that the recorded pid still
runs it. `--keep-service` leaves the Appium service
running. A Wi-Fi tunnel is stopped in its own step, `tunnel`, right after `wda`, also with `--keep-service`. A foreign lease is refused like `lab up` does; `--force` takes it. Each step
reports `found` and `did`, a second run changes nothing, and if a step fails the others
still run, the result is `ok: false`, and the lease is kept so a retry stays yours. A page
you started a local server for is not the lab's: stop that yourself.

### Two simulators: clean and configured

The lab has two simulators, never booted together. **Clean** is the "Claude iPhone" above: logged
out, no extensions, and `sim reset` makes it new. **Configured** is a second device, "Claude iPhone
(configured)", for pages that need a signed-in user. Whatever you sign in to on it stays through
`lab down` and the next `lab up`, and nothing wipes it but `sim reset --profile configured --yes`. It
costs disk (about 5 GB with its own copy of Safari's data), not memory: only one is booted.

```sh
sim create --profile configured   # once; boots the new device once (up to 25 min), then shuts it down
lab up --profile configured       # shuts the clean one down if it is up, boots this one
lab up                            # no flag: clean, always the default (not sticky)
sim profile status                # both devices, their state, which is booted; reads nothing on them
```

The profile is chosen for each `lab up`; with no flag a live session keeps its own, otherwise it is
clean. `lab up --profile configured` while a session is live on the clean one is refused (run
`safari stop` first), and so is the other way round; it never ends a session under its owner. A
command that takes no `--profile` acts on the live session's simulator, else on the profile the last
`lab up` or `sim boot` set (`lab down` clears it), else on clean. `sim boot`, `shutdown`, `reset`,
`udid` and `create` take `--profile`; `lab status` shows both devices (`configuredSimulator`) and
the profile in use (`profile`). The idle stop shuts down whichever one the lab booted.

`sim reset` on the configured profile is refused unless you give both `--profile configured` and
`--yes`, because it erases the sign-ins. Sessions on configured keep Safari's data from one
session to the next (the driver's `noReset`); sessions on clean still start with Safari scrubbed.

Signing in is yours to do, by hand: boot it (`lab up --profile configured`), look at it in the
Simulator window, and sign in there. Agents never type a password, a code or any secret into the
simulator (`sim type`, `safari keys` and `safari type` are not for credentials); if a test needs a
login, a person signs in once, or the account is a throwaway test account whose details the person
gives. Never an Apple ID or iCloud on either simulator. A screenshot of a configured session shows
whatever is signed in, so the Privacy check (look at the picture before it is kept or shared) applies:
treat it as the owner's data. A configured session is not pristine (cookies, storage and any
extension you install persist): reproduce a bug on clean before reporting it.

### The idle stop

If an agent finishes without `lab down`, or dies, Appium and the phone's WebDriverAgent would
run until someone noticed (on an 8 GB Mac that means swap). `lab service install` therefore
also installs a LaunchAgent, `com.dividedby.msl-idle`, that launchd starts every 5 minutes to
run `lab down --idle`. It has no process of its own between runs (node starts for about a
tenth of a second, looks, and exits), listens on nothing, and has no `KeepAlive`. Its log is
`~/Library/Logs/msl-idle.log`, and it gets a line only when the stop acts or fails.

The lab is **idle** when no lease is live (none, expired, or unreadable) and no lab command
has taken, renewed or released the lease for **15 minutes** (`MSL_IDLE_MINUTES`, 1 to 1440;
the install passes the value it sees on to the agent, and `lab status` shows the one in the
agent's plist as `idleStop.thresholdMinutes`). A "lab command" is any that takes, renews or
releases the lease: `lab up`, every `safari` command, and the `sim` commands that change the
phone, plus `sim shot` and `sim ui` (which look but take no lease); `lab status` and the like do not count. The last command's time is kept in
`activity.json` next to `lease.json`, because `safari stop` deletes the lease while Appium stays
warm. An idle lab is stopped within the threshold plus 5 minutes. A lab in use (a live lease, or
a command inside the last 15 minutes) is never stopped, and a lab with nothing running is
left alone without a command.

What it stops is what `lab down` stops: it ends the session (closing the lab's tab on the
phone), stops the WebDriverAgent, quits a window the lab opened, and stops and disables the
Appium service (`lab up` brings everything back, cold). Two differences:

- It shuts the simulator down **only if the lab booted it** (`sim boot` or `lab up` found it
  `Shutdown`; the state's `simBoot` records it). A simulator that was already running when
  `lab up` looked is left alone, and so is every other simulator.
- A slot borrowed from sideload goes back (see "A slot borrowed from sideload" under "Real iPhone"): a `slot` step after
  `wda`, retried every tick until sideload says it is back. A locked phone is left alone and reported once.
- If the phone is unreachable it carries on, and `lab status` shows the tab as left open
  (`idleStop.last.tabLeft` with the `human` step to close it by hand). It does not clear the
  keyboard note (nobody is there to read it), so the next `lab down` says it.

While it runs it holds a lease of its own (`msl-idle`, 10 minutes) so a `lab up` that arrives
in the middle is refused for a moment with a message that says why, rather than racing it;
a `lab up --force` takes the lease and the stop ends early (the steps that already ran stay
done). The lease is handed back when the stop ends, also when a step failed. A failed stop is
tried again on the next tick; after 3 failures in a row it waits for the next lab command.
`lab status` shows `idleStop`: the agent (installed, loaded, anything wrong), the threshold, when
the last lab command was and how many minutes ago, what the last stop did, `heldUntil` (a hold
in force, or null) and `nextStop`: `{ earliest, note }`, the later of the threshold, the hold and a live
lease's expiry (the agent only looks every 5 minutes, so the stop lands up to that much later);
`earliest` is null, and the note says why, when the agent isn't loaded, nothing is running, the failure limit
is hit, or there is no record of a last command yet.

**`lab hold [--minutes N]`** keeps the idle stop off while a person uses the simulator by hand
(signing in, looking around): nothing runs a lab command then, so the stop would shut the simulator
down under them. `N` is a whole number of minutes from 1 to 120, default 60. It is written to
`hold.json` (`{until}`) in the state dir, counts as activity, takes no lease (it never blocks an
agent), and is checked together with the idle check, so a stop can't slip in between. After the hold
the usual threshold applies, counted from the last activity. A second `lab hold` replaces the first
(there is no way to shorten one; `lab down` ends it, as does a fresh boot of the simulator, and a
hold file that is damaged or ends more than 120 minutes ahead is ignored). It is refused when
nothing the lab started is running.

### Keeping the lab up to date

Other repos run `bin/*` from this checkout (the skill is a link into it), so a checkout that
falls behind GitHub is out of date everywhere. `lab up` and `lab status` add a `labVersion`
object (and `sim doctor` adds it when there is something to say):

```json
{ "checked": "2026-10-18T17:02:11.480Z", "path": "/Users/me/repos/mobile-safari-lab", "local": "064985a",
  "branch": "main", "dirty": false, "remote": "bc0e46a", "behind": true,
  "human": ["The lab at /Users/me/repos/mobile-safari-lab is out of date (064985a vs bc0e46a on GitHub). Run: git -C /Users/me/repos/mobile-safari-lab pull --ff-only",
            "Then start a new agent session so the skill reloads."] }
```

`local`, `branch` and `dirty` (uncommitted changes to tracked files) come from the checkout the
tools run from, found from their own location, not from where you are. `remote` is origin's
`HEAD` (from `ls-remote`), cached for 6 hours (`lab status --check-update` asks again) so
`lab up` stays fast and works offline. `behind` is true when that commit is not in your
history. `human` appears when the checkout is behind or not on `main`; relay it, and update with

```sh
git -C ~/repos/mobile-safari-lab pull --ff-only
```

then start a new agent session so the skill reloads. The lab never pulls, fetches or changes
anything by itself. When the check can't run (offline, no origin, a 5 s timeout) the output is
`"labVersion": { "checked": false, "reason": "origin did not answer within 5s", ... }` and
nothing else changes: it never fails a command and never adds `needs`. A failed check is
remembered for 15 minutes, so an offline Mac isn't slowed on every call.

**What `lab down` costs.** It frees about 3 GB on a small Mac (measured on an 8 GB one:
the simulator's processes went from 3345 MB to nothing), but the next `lab up` starts
cold: boot the simulator, build and start WebDriverAgent (about 2 to 2.5 minutes), reset
Safari, so **4 to 10 minutes under load**, against 22 to 31 seconds for a warm session.
`lab up` waits up to 10 minutes for the boot (25 for a device that is still unwarmed: `sim
reset` makes the next boot a first boot again) and renews the lease while it waits. It tries
the session once more if Appium fails because Web Inspector listed no pages right after the
boot (the pages list empty, or no applications at all), or because WebDriverAgent failed to
start (Appium gives up on that within about 370 s at worst, inside the lab's own 420 s limit:
two launch attempts of 30 s, which Appium polls for 72 to 120 s each, 10 s apart, plus 90 s and
30 s). If a cold `lab up` still fails that way, or with `WebDriver POST /session got no answer in
420s`, the simulator is booted by then, so run `lab up` again: the failed `session` step and the
top level carry `human` lines and `then: "lab up --target simulator"` saying so, as a device
`needs` does (without `needs` or `or`).
For a short break don't use `lab down`: `safari stop` ends
the session and releases the lease but leaves the simulator and Appium running, so the
next `lab up` is warm. Which flag keeps what: `--keep-service` keeps only the Appium
service (it still stops the session and WebDriverAgent, shuts the simulator down and quits
the window, and the next start is still cold, so it saves little); there is no flag that
keeps the simulator. Before it shuts the simulator down, `lab down` also stops the
WebDriverAgent `xcodebuild` Appium started for it and any `simctl diagnose` on it (step
`wda`).

Then:

```sh
sim run connections-check          # new run folder for what follows, which the next session uses
sim open https://example.com       # opens in Safari (phone-level)
sim shot home                      # runs/…/home.png (a name, not a path), full resolution; `scale: null` plus a `note` means AXe wasn't ready: retry
sim tap --label "Address"          # tap by accessibility label
sim tap 603 300 --px               # or by pixels read off the last shot
sim type "hello"
sim scroll down
sim ui                             # accessibility tree → ui.json + labels

safari start                       # Appium session on the Claude iPhone, or the saved phone (see below)
safari start --allow-host old.reddit.com   # phone only: hosts the lab may follow its tab to when a page sends it there (repeatable, up to 10; see Privacy)
safari open https://example.com    # waits for the new document to finish loading
safari refresh                     # reload, same wait
safari open https://example.com --wait-for '.card' --settle   # ...then until that element exists and the page stops loading and changing (also on refresh; --timeout <ms> for each)
safari open https://example.com/app --storage flag=on   # sets localStorage on that origin first, then loads the page (repeatable; see "Setting localStorage")
safari eval 'document.title'       # one expression gives its value; several statements need `return` (below)
safari click '[data-testid="card-label"]'      # synthetic click
safari type 'input[name=q]' 'cats'             # synthetic key events (isTrusted false)
safari tap 'input[name=q]'         # scrolls the element into view first, then a real touch; keyboard comes up; says `focused: true|false` for a text field
safari tap button --text 'Continue'              # by visible text (exact, whitespace collapsed); --contains for part of it; --nth 2 for the second match
safari click li --nth 3            # the third match of a selector (also on tap and type)
safari tap --shadow x-app x-card button          # into open shadow roots: every argument is a selector, the last is the target
safari tap --label 'Share'         # the one native element in the web view with exactly this accessibility label (see `safari ui`)
safari wait '.card' --visible      # until the element exists (default), is rendered (--visible) or is removed or hidden (--gone); same selectors as tap; --timeout <ms>
safari wait --settled              # until the page has been quiet for --quiet <ms> (default 500): nothing loaded, changed or resized; use it instead of `sleep` before `shot`
safari keys 'Hello'                # real key events into the focused page field (waits for the keyboard);
                                   # checks each character landed, fails naming the one that didn't
safari keys --no-verify 'Hello'    # each character sent once, nothing checked
safari keys $'\b\b'                # \b = Backspace (taps the keyboard's delete key, ~0.6 s each in the simulator, ~4 s on a self-resetting iPhone field); \n = Return
safari swipe up                    # real scroll (also: down)
safari appearance dark             # iPhone only: the phone's light or dark mode (also: light, status, restore); put back at `safari stop` / `lab down` (see "Appearance and orientation")
safari orientation landscape       # iPhone only: the screen orientation (also: portrait, status, restore); put back the same way
safari ui                          # Safari's own UI tree → ui.xml + labels
safari inject path/to/script.user.js   # runs it now, after load
safari open https://example.com/other --reinject   # ...and again after the load, for the files whose @match fits the page
safari inject --forget path/to/script.user.js   # stop re-running that file (runs nothing in the page); --clear drops them all
safari console                     # console messages since the last call (then cleared)
safari network                     # requests since the last call → network.json (secrets removed)
safari source                      # page.html
safari shot page                   # the whole screen → page.png
safari shot card --page            # only the web content: no status bar, no Safari toolbar
safari shot card --element .card   # one element (--text, --contains, --nth, --shadow as for tap)
safari shot card --page --scale 0.5    # half the size; or --width 600 for a width in pixels
safari stop                        # ends the session; `lab down` (above) stops everything
```

**Cropping screenshots.** `safari shot` alone saves the whole screen, which on the phone includes
the status bar (with your notifications and Live Activities) and Safari's toolbar. `--page` keeps
the web content only. `--element <css>` keeps one element (`--element '*' --text Buy` finds it by
its text; `--contains`, `--nth` and `--shadow` work as for `tap`, and `--shadow` takes `--element`
once per selector). `--scale N` (above 0, up to 1) or `--width <px>` then shrinks the cut; they only
shrink. The cut is made in memory and only the result is written: if the cut can't be made nothing
is saved, never the full screen (not even a `fail.png` on the simulator). The lab finds the web content from Safari's own native tree (the
page area, less every toolbar or bar that overlaps it, less the top safe-area inset), so no toolbar
height is assumed. `--element` takes the element's rectangle as it is: it is refused when hidden,
not wholly inside the page area, or under a Safari bar (the lab scrolls nothing), and a
`warning` says when something covers it. The page is measured before and after the picture and
the cut is made only when both agree (three tries). On the phone the lab's tab is checked right
before the picture and right before the file is written, as for every screenshot. The output says
what happened: `file`, `width` and `height` (of the file), `source` (the screenshot's pixels),
`crop` (the pixels kept, in `source`'s coordinates), `scale` (the factor actually applied),
`mode` (`page`, `element`, or `screen` for `--scale` alone), `matches` (`--element`), and `points`
(the screen, the page area, the safe-area `inset` and the crop in points, before the pixel scale).
Look at the first `--page` shot on a new iOS version before relying on it. Only 8-bit RGB and
RGBA PNGs (what Appium gives) are cut, up to 16384 px a side and 100 megapixels; the colour profile
chunks are kept (the phone's are sRGB on iOS 27.0.1), text and EXIF chunks are dropped. A plain `shot` is
never re-encoded: it is the bytes Appium sent.

A failed `safari` command on the simulator saves `fail.png`, `fail.html` and the error to
`run.log`. On the iPhone it saves nothing from the phone (a screenshot or the page source
could show your other tabs); the error is in the JSON.

**Setting localStorage.** `safari open <url> --storage key=value` (repeatable) sets localStorage
for the address's origin before the page loads, for a feature flag or a login state the page
reads at start. It is for `open` only (`refresh --storage` is refused) and for localStorage only.
Limits: the pair splits at the first `=`; a key is 1 to 256 characters with no control
characters; a value is at most 4096 characters (empty is fine); at most 20 pairs and 16 KiB in
all; a repeated key is refused. All of that is checked before the session is asked anything, and
an error names the pair's place and the rule (`--storage #2 needs key=value`), never a key or a
value. What happens: if the tab is already on the address's exact origin the values are written
there and then the address loads. Otherwise the lab first loads the origin's root (`/`) in its tab,
the same way `open` loads any page (on the phone a guarded `location.replace`, the marker put back
only on an allowed origin, an off-site redirect refused and tainting the run), writes the values,
and then loads the address. A root that lands on the `www` or https twin is refused before
anything is written (`the root redirected to <origin>; open the final address`), and so is an
address that differs from the page the tab is on only by its `#fragment` (no new page would
load). When the page the values went into is already the address (the root with a `#fragment`,
or the exact same URL), the lab sets the fragment and reloads, so the page's scripts run after
the write. **`--storage` needs the lab's Appium service with current log-filter rules, on both
targets:** without the LaunchAgent, with an older or missing rules file, or with `MSL_APPIUM_URL`
set it is refused with `needs: service` before anything is asked of the page (run `lab service
install`). The service must also be what answers: launchd must be running it, its process must be
the only listener on its port, and the session must be on that port, or it is refused the same
way. The output adds `storage: { count, keys, origin, extraLoad }`, and `applied: false` with a `warning`
when the page ended on another origin than the one written to. `--reinject`, `--wait-for`,
`--settle` and `--timeout` apply to the final load. **The values stay out of the lab's files:** they
travel only as an argument of a page script, and are in no output, `run.log` (which gets
`storage=<count> keys=<k,...>`), run-folder file, error message or script source; a failure after
the write saves no `fail.png` or `fail.html` on the simulator, as the page may show them. They
also stay out of Appium's log, which is why the service is required (next paragraph). What they
cost: the page can read what was written (it is its own origin's storage), the extra root load
shows in `safari network` and runs that site's own scripts, and the values are set before the
requested page loads but cannot come before the very first script of a first visit. After the
write the page can repeat what it holds (its title, its own error messages, the screen), and values
are in your shell history and the process list, so use test flags and dummy tokens, never real
secrets. `open` and `refresh` read their words in one place and refuse any they don't take by
position, never by echoing it: `--storage=k=v` (the pair is the next word), any other
`--flag=value`, an unknown or misspelled flag (`--Storage`, `-storage`), a second address, a repeated
`--wait-for` or `--timeout`; `refresh` refuses `--storage` in any spelling.

**Appium's log and typed text.** Appium logs request bodies, script arguments and what it sends
on to WebDriverAgent, and the rules (`--log-filters`) mask the arguments of script calls, the
text of `type` and keys, along with URLs and titles. The service's Appium and an Appium the lab
starts itself (no service installed) both run at log level `info` with the rules; at `--log-level
debug` Appium also logs command results, including text read back from fields (use it only for
debugging and delete the log afterwards). **The text of a `safari eval` script reaches the
info log** (only its arguments are redacted): put a sensitive value in `--storage` or in typed
text (`type`, `keys`), never in the source of an `eval`. After updating
the lab, run `lab service install` once: until the rules file matches this lab's, `lab service
status` lists it, `safari start` and `lab up` on the phone, and a simulator start through the
service, refuse with `needs: service`, and so does `open --storage`. An Appium you started by
hand, or one reached through `MSL_APPIUM_URL`, is not checked: `type` text can be logged there
(`open --storage` is refused for it). The rules are read once, when Appium starts, so the lab
also checks the running service: one that started before its rules file was last written may hold
older rules and is refused (`lab service install` again). `type` and `keys` check this too before
they send anything, and `lab service install` writes the new rules only after the old service has
gone. Text typed with `type` or `keys` is kept out of messages and `run.log`; once the first
character has been sent, a failure saves no `fail.png` or `fail.html`.

**Help.** `safari help`, `safari help <command>`, `safari <command> --help` and `-h` (the
same for `sim` and `lab`) print one JSON object with the usage and exit 0. They never run
the command, take the lease, make a run folder or touch the simulator or the phone, so
`sim statusbar --help` changes nothing. A bare `--` ends the scan, and `keys` takes text that
starts with `-` after it (`safari keys -- '--help'`). Text that is exactly `-h` or `--help`
therefore can't be typed through `type` or `eval`.

**`eval`.** A single expression gives its value (`safari eval 'document.title'`). A script
of several statements is the body of a function, so it returns `null` unless it uses
`return`: `safari eval 'const n = document.links.length; return n'`. A script that throws
comes back as `ok: false` with the page's error (`the page script threw: TypeError: ...` on
the phone); a script that does not parse is refused before anything is sent
(`eval: syntax error: ...`). A Promise (or any object with a `then` method) is awaited for up
to `--timeout <ms>` (10 s by default, 100 to 60000): `safari eval 'fetch("/x.json").then(r =>
r.json())'` gives the JSON, with `awaited: true` and `awaitedMs`. A rejection is `ok: false` with
`the Promise rejected: <reason>`; so is a timeout, or a navigation or reload while it waits.

`safari network` removes cookie, authorization and proxy-authorization headers, request
bodies, and the values of query-string parameters named like secrets (`token`,
`access_token`, `id_token`, `key`, `k`, `apikey`, `api_key`, `password`, `passwd`, `secret`,
`signature`, `sig`, `code`, `session`, `auth`; also in the `Referer` and `documentURL`;
`safari console` masks the same names in URLs and text) before anything is saved or
printed; WebDriverAgent's own requests (`127.0.0.1:8100`) are left out. Secrets under other
names are not recognised, so look at `network.json` before sharing it.

**What `network` and `console` report.** Where they read from depends on the target (see
Limits for the details):

| | Simulator | iPhone |
| --- | --- | --- |
| `console` | Safari's own log, through Appium | the lab's collector in its own tab |
| `network` | Safari's own log, through Appium: every request with method, status and headers (secrets removed) | the lab page's own Resource Timing, rebuilt from a fixed list of fields |
| `count`, `requests` | `count` is the raw events in `network.json`; `requests` is one entry per request (method, url, status) | `requests` are the entries; `truncated` says more are waiting |
| `dropped` | entries the lab left out: byte-identical copies (Appium repeats an entry once per listener it added) and WebDriverAgent's own `127.0.0.1:8100` traffic | always 0 |

### Real iPhone

The same commands drive Safari on your own iPhone: `lab up` picks the phone or the
simulator, `safari` runs the same page commands on either. The lab signs and installs a
small helper app (WebDriverAgent) on the phone through Xcode, so this needs an Apple ID
(a free one works, with the limits below) and the LaunchAgent from setup step 7: on the
phone `safari start` and `lab up` refuse to run without it, because only the service's
Appium starts with a log that leaves out page URLs, titles and, at the default `info` level, typed text (`needs: service`). The same service runs Appium with the page pin plugin (setup step 3), so
a session without it is refused too, and a plist from before the plugin needs `lab service install` again.

**Set the phone up (once)**

1. On the phone: Settings → Privacy & Security → **Developer Mode** on (the phone restarts
   and asks to confirm). Settings → Apps → Safari → Advanced → **Web Inspector** on.
2. On the Mac: Xcode → Settings → Accounts → sign in with the Apple ID, then Manage
   Certificates → **+** → Apple Development. The account's team id (10 characters) is shown
   under Accounts; a free account has a "Personal Team".
3. Connect the phone by cable, unlock it and tap **Trust This Computer**. Then, on the phone,
   Settings → General → VPN & Device Management → the developer profile → **Trust**. (The
   profile appears after the first install, so you may do this on the first `lab up`. A cable
   session keeps WebDriverAgent installed, so the trust stays; if it is lost, the failed
   `lab up` says `needs: trust` and gives only this profile step.)
4. Save the phone. The UDID is in Xcode → Window → Devices and Simulators, or
   `xcrun devicectl list devices`:
   ```sh
   lab phone setup --udid <UDID> --team <TEAMID>     # --bundle-id <id> to choose the app's id;
                                                     # --autocorrection/--prediction on|off: see "Your keyboard settings"; --focus on|off, --focus-on-shortcut, --focus-off-shortcut: see "Lab Focus"
   lab phone status                                  # live: reachable, transport, locked, iOS version, signing expiry
   lab phone forget                                  # removes the saved record again
   lab phone restore [--forget]                      # puts back the appearance, orientation and Lab Focus the lab changed (below); --forget drops that record instead
   lab phone slot return | forget                    # a slot borrowed from sideload (below): give it back now / drop the record without touching anything
   ```
5. The first `lab up` signs WebDriverAgent with your certificate, and macOS asks, at the Mac
   itself, to let `codesign` use the key: click **Always Allow** once (over SSH the prompt
   can't be answered and the lab says `needs: keychain`). Later runs don't ask.

**Choosing the target**

```sh
lab up --target auto        # the default
lab up --target device      # the saved phone, or a `needs` value saying what to fix
lab up --target simulator   # the Claude iPhone simulator, whatever else is saved
safari start --target ...   # the same three values; --device <UDID> = --target device
```

`auto` chooses: no phone saved, the simulator; a saved phone that is reachable, unlocked and
in Developer Mode, the phone; a saved phone that is not, **a refusal** with `needs` and the
steps to fix it, and `or: lab up --target simulator` for the way out (it never silently
runs on the simulator when you saved a phone). `--device <UDID>` must be the saved phone.
`lab status` shows the saved phone and its signing expiry from the lab's own record without
calling the phone, with `seen` (the iOS version the phone gave the last time `lab up` or
`lab phone setup` read it); `lab phone status` asks it live and also gives `osVersion` and
`buildVersion` (it saves nothing). `lab up`, `safari start` and `lab status` carry a
`targetType` (`device` or `simulator`) next to `target`, and `lab status` shows the
simulator's `runtime`. Safari's user agent is frozen at one iOS version, so read the
phone's version from `osVersion`, never from the user agent. `sim` commands refuse while a session is on
the phone.

**Cable or Wi-Fi.** Both work for every page command. Over the cable the Mac reaches the
phone through usbmux, as before. Over Wi-Fi it reaches it through **Apple's own tunnel**
(the CoreDevice tunnel Xcode uses to reach a phone on the network), held by a LaunchAgent
of the lab's: no root, no Private Wi-Fi Address setting, and no cable once the phone has
been paired over it. `lab up` opens the tunnel itself when it finds the phone on the
network (a `tunnel` step), starts the phone's WebDriverAgent on the tunnel address, and
points Appium at it. Only the Mac's own network works: away from it is not supported.

| | Cable | Wi-Fi (same network as the Mac) |
| --- | --- | --- |
| Setup | plug in, trust | cable once to pair and trust (no Xcode setting); pymobiledevice3 11.40.2 or newer; `lab service install` (it installs the tunnel agent) |
| Speed | `safari eval` about 20 ms | roughly half the speed per call (to be re-measured over the tunnel) |
| Phone must be | unlocked at `lab up` | unlocked at `lab up` and on the same network |
| After sleep, or toggling Wi-Fi | fine | a failed command says `needs: tunnel`; `lab up` opens a new tunnel and drops the old session at once (below) |
| Away from the Mac | the cable is all that is needed | not supported |

Either way the first session after a while takes about 50 s (WebDriverAgent is built and
installed), and later ones 14 to 18 s; over Wi-Fi the warm target is about 20 s.

**Using Wi-Fi**

1. Once, with the cable in: pair and trust the Mac (the first cable `lab up` does it). There is
   no Xcode setting to turn on: Xcode 15 removed **Connect via network**, and a paired phone is
   reachable on the network by itself.
2. Install pymobiledevice3 (step 4 of Setup) and run `lab service install` (it writes the tunnel agent).
3. Run `lab up --target device` with the cable out. The `tunnel` step starts the tunnel host (up to 45 s);
   the phone must be unlocked and on the same network as the Mac. Guest networks and any network
   with client isolation don't work. The lab then builds WebDriverAgent if there is no build,
   runs it detached on the phone (its output: `~/Library/Logs/msl-wda-device.log`, mode 0600)
   and waits up to 120 s for it to answer on the tunnel address.
4. `lab phone status` says `transport: wifi` when the phone is on the network with no cable;
   with the cable in the lab uses the cable (`transport: cable`) and stops a tunnel left up.
5. The tunnel stays up between `safari stop` and the next `safari start`, and ends with `lab down`
   or the idle stop. `lab tunnel status` shows it (address, ports, whether its host runs, and for a tunnel that went down its `reason` and, when the tool said, a `detail`) and, with the tunnel up,
   whether the route works (`reaches`: one TCP connect to the phone through the tunnel, and one WebDriverAgent
   request when a session runs over it; `reachesWhy` says what failed), and
   `lab tunnel up` and `lab tunnel down` start and stop it by hand. `lab status` only reads the record.

What the tunnel exposes: the tool opens no listener on the Mac, and the small registry that
tells Appium where the tunnel is listens on `127.0.0.1` only. WebDriverAgent on the phone binds
the tunnel address only, so it is not reachable on the phone's LAN address. While the tunnel is
up, other programs on the Mac can reach the phone's services through it, much as they can
through usbmux over the cable; `lab down` and the idle stop end it.

If CoreDevice is stuck (`lockState` times out while the device list says the phone's tunnel is
connecting, or the tool stays silent), the lab restarts your CoreDeviceService once, itself, and
says so in the step (`restarted CoreDeviceService`, `coreDeviceRestarted: true`): Xcode's and
`devicectl`'s connections to the phone drop for a moment. It never does this from the tunnel
agent or the idle stop, and only once per command.

**iPhone or simulator**

| | iPhone | Simulator |
| --- | --- | --- |
| Engine | the real WebKit build, GPU, fonts and network | the Mac's, close but not the same |
| Profile | your own: logged in, your extensions (they may inject into pages) | clean, logged out, no extensions; or `--profile configured`: only the sign-ins you made by hand |
| Appearance | `safari appearance light` or `dark`, `safari orientation portrait` or `landscape`, put back when the session ends (no status-bar control) | `sim appearance`, `sim statusbar` (appearance and orientation commands are not supported on the simulator) |
| Signing | needed; renewed weekly (below) | none |
| Cost | battery; the phone must be unlocked and awake; 14 to 18 s warm `lab up`, about 50 s cold | about 3 to 5 GB of RAM; fast once booted, but a cold `lab up` takes 4 to 10 minutes on an 8 GB Mac, and the first boot of a new simulator up to 25 |
| Your other tabs | untouched (see Privacy) | none |

**Free-account limits.** The profile lasts **7 days**; `lab up` signs WebDriverAgent again
when less than 24 hours are left (`--resign` deletes the build and signs again, but Xcode
reuses a provisioning profile that is still valid, so the expiry does not move until a re-sign
near expiry; the output says `expiryMoved: false` when it didn't; `lab phone status` shows
`wdaHoursLeft`). A free Apple ID allows **3 active sideloaded apps per device** (WebDriverAgent
takes one) and **10 new app IDs per week**; app IDs are global, so a bundle id registered by
one team can't be used by another (the default id carries the first four characters of the
team). Apple can also reject a team's profiles outright (`0xe8008018`, then a cached
`0xe8008024` "banned"; the codes decide, so these are `resign`, not `xcode-account`): the lab says `needs: resign`, and the way out is
`lab phone setup --udid <UDID> --team <ID>` with another team.

**Shared signing lock (sideload).** If you also use sideload with the same Apple team, the two tools take one
lock (`$SIDELOAD_HOME/.op.lock`, default `~/.sideload`) around signing and installing, so Xcode doesn't create a
second certificate. The lab holds it only while it creates a phone session, and `lab up` looks at it early (before
the tunnel and Lab Focus, and before Appium with `--target device`) so a busy lock stops it at once; if sideload
holds it the lab stops with `needs: busy` and you try again in a minute. No `~/.sideload` folder, no lock. `MSL_SIGNLOCK=off` (yours
alone, not for agents) turns it off, and the lab's output then says `signLock: "disabled"` with a warning.

**A slot borrowed from sideload** (issue 63;
[ADR 0008](docs/adr/0008-slot-lending.md)). A free Apple account holds only a few apps on the phone, and sideload's
apps may fill them. sideload can lend the lab one of its slots (`sideload slot lend`) so WebDriverAgent fits, and takes
it back with `sideload slot return`.

*Borrowing.* A `lab up` that creates a new phone session has a `slot` step (after `phone` and the early look at the
signing lock, before the phone settings, the tunnel, Lab Focus and the session, so a stop there opens nothing on the phone).
It lists the phone's apps once (`xcrun devicectl device info apps --bundle-id <bundle id>.xctrunner`, a second or two);
a live session skips it. WebDriverAgent there: nothing more. Missing: the lab builds the runner when there is no build
and installs it under the signing lock; **installd decides whether it fits**. `sideload slot lend` does not check that
the phone is full, so the lab never calls it on a guess, only after installd refused that install with its free-app limit
(never the 10-app-IDs-a-week limit, never an unreadable listing: those lend nothing). Then, with the lock released, it
runs `sideload slot lend --udid <saved UDID> --to lab`, records the lend, and installs the runner again. The result says
`slot: {lent: "<app>", freed: 1}` (`alreadyLent`, sideload's app-data backup counts `dataBackedUp`, `dataFiles` and `dataFilesFailed`, and sideload's warnings are passed through). The step
can take about 17 minutes for the lend (sideload's own worst case is 10), plus the WebDriverAgent build the first time and up to two installs; the lease is renewed while it waits. When sideload says
`busy` (a lend pending, a result not known, a timeout) the lab stops with `needs: busy` and a `retryAt`, and keeps its
record, so the next `lab up` finds out what became of the call. Owner actions (no lendable app, the lendable app unsigned or
not on the phone, sideload does not know the phone, a binary that is not found) are `needs: slots` with sideload's own fix as
the last line. A phone `lab up` **reuses a lend it already holds** instead of returning it first. A record the lab finds
in `lending` or `returning` with WebDriverAgent on the phone is settled by one `slot return` call (the runner is not
uninstalled for that): the lend stands (`lent`) or the slot is back.

*Giving back.* The lab writes down what it borrows in `state.slotLend`, with the sideload binary and
`SIDELOAD_HOME` it used. The record is written before the lend and before the return, so a crash leaves it behind, and the lab gives the slot back:
- at the **idle stop** (retried every tick, but not while sideload asked for a later retry, and, when sideload
  needs you to act, not until a lab command has run), and at **`lab down`** when the idle stop is not installed and
  loaded or the return had already started (a `slot` step right after `wda`; never a failure of `down`);
- by `lab up --target simulator`, under the same condition as `lab down` (a reported `slot` step; never a failure of `up`);
- by hand with **`lab phone slot return`** (lease-checked, refused while a phone session is open).

Giving it back takes WebDriverAgent off the phone (`xcrun devicectl device uninstall app`, only `<bundle id>.xctrunner`
from the saved phone, never one of sideload's apps), then runs `sideload slot return --udid <saved UDID>`. The lab
never uninstalls or calls anything on a locked or unreachable phone (no passcode prompts at an unattended Mac), never
while a phone session is open, and it finds the sideload binary **before** it uninstalls anything. The binary is
`MSL_SIDELOAD_BIN` (an absolute path; a wrong value is refused, not replaced), else the one the record remembers (the
idle stop's `PATH` is launchd's), else the first `sideload` on `PATH`. `lab service install` passes `MSL_SIDELOAD_BIN`
and `SIDELOAD_HOME` on to the idle stop. sideload's answers decide: the record is cleared only when it says the slot is back
(`reinstalled`, `alreadyPresent` or `nothingLent`). The return's `slot` also carries sideload's restore report when it gives one: `dataRestored`, `dataFilesRestored`, `dataFilesFailed` and its warnings; the lab reports them and never depends on them. A return that cannot finish says `slotReturned: false` with a
`human` step and keeps the record (`phase` `returning`); the idle stop says it once, and it does not count toward its
three failures. Calls wait up to about 22 minutes (sideload's own worst case is 15) and renew the lease while they do. `MSL_SIDELOAD_BIN` is for the owner (and the debug build of sideload that Stage 2 testing uses); agents never set it.
`lab status` shows `slot`: the binary found (`bin`), the record (`lend`: phase, app, `retryAt`, the last failure) and
sideload's own `status` (only while a record exists, display only). `lab phone slot forget` drops the record without
touching the phone or sideload (you returned it by hand: `sideload slot return --device <alias>`); `lab phone forget`
and `lab phone setup` for another phone are refused while a record exists.

**Privacy: what the lab does with your tabs**

- It opens **its own tab** and pins it, and checks that it is showing and is still the lab's
  (its marker, its site) **before and after every command**. If anything is in doubt it
  refuses with `needs: tab` and reads nothing.
- It **never reads any other tab**: no URLs, titles, page text, screenshots or console
  lines. The one exception is a yes/no check at start that the page it attached to is the
  lab's tab.
- It **never runs anything in another tab** either. Appium is started with the lab's
  `msl-page-pin` plugin: a tab you open (or switch to) is only listed, never followed or
  attached to, and every script is refused unless the session is on the page the lab selected.
  If the lab's own tab closes under a command, the session goes to the native app and nothing
  else is touched. Device sessions refuse to start without the plugin (`needs: service`). One
  moment is not covered: while a session is being created, before the plugin has pinned it,
  Appium can attach to a tab you open in that instant (its Web Inspector setup and one
  `document.readyState` read; no lab script, nothing is read). The start check refuses the
  session if the page it attached to is not the lab's tab, so don't open or switch tabs while
  `lab up` or `safari start` creates the session.
- Safari **restarts when the lab opens its tab**. Your other tabs stay, but reload when you
  next view them, and unsaved text in a form in them can be lost.
- `safari stop` and `lab down` **close the lab's tab** (from a timer in the page, so the lab
  never has to touch another one). A tab with more history than the lab's own is blanked
  instead, and if the lab can't confirm which tab is its, it says so and asks you to close
  it by hand.
- **Off-site redirects are refused**: the tab may end only on the site the lab sent it to
  (or its https and `www` twin), or on a host you named with `--allow-host`.
- **Allowed hosts** (`safari start --allow-host <host>`, repeatable, also on `lab up`): a site that
  sends its own tab on to another host (a login, a short link, a redirect that a link click or the
  page's own script starts) would otherwise taint the run. Name the hosts you expect and the lab
  follows the tab there: when its marker is gone and the page is on one of them, it asks the page
  one yes/no question (is this one of the allowed hosts?), and only if so marks the tab again by
  the same steps `open` uses (the same pinned tab, the context checked after each script, a
  complete document, the marker tied to that document), puts its console and network collectors
  back, and then runs your command. The output says `followed: [<origins>]` and `run.log` has
  `safari follow:` lines. Any other site still taints the run: nothing is written into that
  page and nothing is read from it beyond the guard's yes/no check. (The origin tests the lab runs
  in a page are plain `===` comparisons, not methods the page could patch; a page that forges the
  lab's answers can at most be sent the read-only probe and the mark, which write nothing there.) A host is `name`, `name:port`, an IP or `localhost`, matched exactly
  (no wildcards, no automatic `www`), for both `http` and `https`; at most 10. A later `safari start`
  or `lab up` on the same session adds hosts and never removes any; a taint drops the list (the
  refusal names it, so the next session can name the hosts again). `open` and `refresh` accept a
  redirect to an allowed host too, and `network` still lists only the sites the tab visited.
  **If you move the lab's tab to an allowed host by hand, the lab follows it too**: it cannot tell
  your hand from the page's own navigation. Scripts are not injected again after a follow. On the
  simulator there is no tab guard: the hosts are not stored and the output says so.
- **Appium's log leaves out URLs, titles and (at the default `info` level) typed text** (the service starts it with filters), and
  the lab's output masks device ids: a phone UDID (or any 40-hex id) is printed as `…` and its
  last 4 characters (`…5F60`) in every command's JSON, in `run.log` and on stderr. The two
  exceptions are `lab phone status` and `lab phone setup`, which echo the saved UDID in
  full because you need it there (`lab phone forget` is masked). The state file keeps the
  full value. Simulator ids are not device ids and are left as they are.
- **`safari network`** lists only requests to the sites the lab's tab visited, rebuilt from
  a fixed list of fields (no headers, bodies or other sites), and says how many entries it
  left out as `outside`; see Limits for what it can and cannot show. **`safari console`**
  is the lab's own collector in its page, not Safari's log, which holds every tab's.
- Nothing from the phone goes into `fail.png` or `fail.html`.
- **Switching Safari tabs pauses the session; it ends only when the lab's tab changes.**
  While you are on one of your own tabs the lab's page is in the background: `url`, `eval`
  and `wait` may still answer from it, but `tap`, `keys`, `swipe`, `shot` and `ui` are refused
  (`needs: tab`, nothing done on screen, the run is not tainted). Safari can also pause the
  background tab, and then `url`, `eval` and `wait` are refused too ("did not answer within
  10s"): that is a pause, not a loss. A busy page (one still running its scripts) can hold a
  script up too: the next command that gets no answer then says Appium is still waiting on that
  script, and `lab status` shows `waitingSince` next to `usable: false`; wait, or run `safari start`
  if it has not cleared within a minute. `open` and `refresh` give each script of their navigation
  up to 30 s, since a loading page is busy. A command that gets no answer is not taken for a
  move (one exception below): the lab sends nothing to any page, the next command checks where the session is
  before it does anything, and switching back to the lab's tab carries on. **A refused
  command can still finish in the lab's tab once it shows** (Appium runs one command at a
  time and the refused one is still waiting in its queue), so after switching back, check the
  page before you repeat a click or a type. A refused or late script never runs in your other tabs, and a tab you open while the lab works
  does not pull the session into it (the page pin, above). If the lab's
  own tab changes under it (you navigate it by hand, close it, or it is replaced), the next
  command says `needs: tab` ("no longer carries its marker", or "gone" when it was closed)
  and a changed tab taints the run; `safari start` then opens a fresh tab, and its `human` (and `previousTab`) asks you to close the old lab tab by hand, naming the site the lab last sent it to: the lab never closes a tab it can't confirm is its own. A session that
  is found in another page, or that does not return to the native app, taints too.
  The exception: if you switch away while `open` or `refresh` is putting the marker back into the lab's tab after a navigation, the command says the tab did not answer while it was being marked again (untainted); if the navigation went to another origin the next command taints the run (`safari start` then opens a fresh tab), and on the same origin the session goes on.
  Measured on the iPhone, 2026-10-18 and 2026-10-19.
- **A command that gets no answer over Wi-Fi asks why before it says `tab`.** On a session over the tunnel, a page
  command that times out (or finds the tab gone) first checks the route: one TCP connect to the phone through the
  tunnel (3 s) and one WebDriverAgent `/status` request (3 s). A tunnel that does not answer, a dead tunnel host, or
  WebDriverAgent silent behind a good tunnel (the lock is asked first then, since a locked phone silences it) is
  `needs: tunnel` (not tainted, the session is kept; `lab up --target device` replaces a session whose WebDriverAgent
  does not answer). With the route good it then asks whether the phone is locked (`needs: unlock`, also when a locked phone lists no
  tab). Only a route that works and a phone that is unlocked leave `needs: tab`. A cable session is never route-checked.
  This adds at most about 6 s to the 10 s a timed-out command already waits.

**When it won't run: `needs`.** Every device failure ends in JSON with `needs`, `human`
(what a person does) and `then` (what to run afterwards; a `lab up` there repeats the flags
the run was given that fit its target, such as `--allow-host` and `--url`, never `--force`). The values: `setup` (no phone
saved), `xcode-account` (sign in, make a certificate), `keychain` (Always Allow at the Mac),
`developer-mode`, `trust`, `unlock` (phone locked or asleep), `passcode` (enter the passcode
on the phone when it asks to enable UI automation; a timeout the first time after a while
usually means this), `cable` (the Mac can't reach the phone: unplugged, or not seen on the network; a phone that was last reached over Wi-Fi and is gone says `tunnel` instead),
`tunnel-tool` (Wi-Fi needs pymobiledevice3 11.40.2 or newer), `tunnel` (no route over Wi-Fi: no tunnel
within 45 s, it dropped, it reached another device, or the pymobiledevice3 version check timed out twice; see "Using Wi-Fi"), `resign` (signing expired or
rejected), `slots` (free-account app limit), `busy` (sideload is signing; try again in a minute), `tab` (the lab's tab can't be confirmed;
`safari start` for a fresh one), `service` (`lab service install`), and `unknown` (run
`lab phone status`). The full table, with the exact steps, is in [AGENTS.md](AGENTS.md).

**Finishing.** `lab down` on the phone ends the session and closes the lab's tab, stops
the WebDriverAgent it left running (step `wda`) and stops Appium like on the
simulator. The `wda` step first asks WebDriverAgent to shut down (over the Wi-Fi tunnel; the
`xcodebuild` then exits by itself, and is stopped only if it does not), then reads the phone's
process list (`devicectl`, the saved phone only) and SIGKILLs the runner app
(`WebDriverAgentRunner-Runner.app`) if it is still there, so "Automation Running" does not stay on
the phone. A runner that survives that is a failed step that says to hold both volume buttons or
run `lab down` again; `safari stop` does the same and reports it as `wdaError`.
It skips the `simulator` and `window` steps, since the simulator is not in use.
Whether the tab closed is `steps[session].tabClosed` (with `tabClosed: false` its `human` step,
close it by hand, is in that step too); the top level of the output has `keyboardRestored` and
its own `human` (and `phoneRestored`, when the lab had changed the phone's appearance or orientation). The helper app stays installed on the phone; delete it there if you need the slot.

**Your keyboard settings.** WebDriverAgent switches **Auto-Correction** and **Predictive** off
for the whole phone when it starts (it does that on every start, and iOS gives no way to read
the values you had before). The lab keeps them off while a session runs, so typed text isn't
rewritten, and **sets them back when it ends the session** (`safari stop`, `lab down`, or a
session it replaces), reading them back to be sure: the output says `keyboardRestored: true`.
The target is saved with the phone and is both on unless you say otherwise
(`lab phone setup ... --autocorrection off --prediction on`; an omitted flag keeps the saved
value; `lab phone status` shows it). If the restore fails (WebDriverAgent was killed, Appium
crashed, the phone is out of reach) `safari stop` and `lab down` still finish and say
`keyboardRestored: false` with the step: turn them on in Settings → General → Keyboard. A later
`lab down` with no session to restore through says it once (a `lab down` that fails keeps it for
the next try); it starts no session for it, since that would turn them off again. The reason a
restore failed is the output's `keyboardNote` (never a line on stderr: the output stays one JSON object).

**Appearance and orientation** (issue 27). On the phone, a dark-mode
script or a landscape layout can be tested on the real device:

```sh
safari appearance dark|light     # the phone's Appearance (an open Safari page follows at once, no reload)
safari orientation landscape     # or portrait (landscape is landscapeLeft)
safari appearance status         # the current reading, and what the lab will put back (also: orientation status)
safari appearance restore        # put it back now (also: orientation restore)
lab up --appearance dark --orientation landscape   # both are optional; applied after the session exists
```

These change **your phone's settings**, so the lab keeps a **restore ledger**: before it changes one it reads the
current value and writes it down (`state.phoneRestore`, with the value it will set; [ADR 0007](docs/adr/0007-phone-settings-restore-ledger.md)), and it puts the value back
only after the phone reads it back correctly. It is put back at `safari stop`, `lab down` (also the idle stop) and,
if a run was killed, at the next `lab up` (a `phone-settings` step before the new session) or `lab phone restore`.
The output says `phoneRestored: true|false`; a phone that is locked or out of reach at that moment is not a failure of
`stop` or `down`: the record is kept, `phoneRestored: false` comes with a `human` step, and the next `lab up`,
`lab down` or `lab phone restore` finishes it. If you turned the setting yourself after the lab changed it, the lab leaves
your value (`ownerChanged: true`). `lab status` lists what is waiting as `pendingRestore` (names only; at the top level, also when the phone record is gone, and under `phone`);
`lab phone restore --forget` drops a record whose phone is gone or that is damaged, without touching the phone.

- **Automatic appearance.** `devicectl` cannot see whether Appearance is on **Automatic** (sunrise to sunset). The lab sets
  back the mode the phone showed (light or dark) and says `restoredExactly: false` with a note, never that Automatic was kept.
  In the live check, Automatic stayed on after a light-to-dark-and-back run; if you see otherwise, turn it on again in
  Settings → Display & Brightness.
- **Orientation** is read back after every change. Putting it back sets the upright orientation the phone had first
  (a phone upside down is put back as portrait, `restoredExactly: false`), then the flat reading (face up or down) if it lay flat.
  With **Portrait Orientation Lock** on, the phone takes the change and ignores it, and its own lock flag still reads off:
  the command fails (`ok: false`) with "Portrait Orientation Lock is probably on" and a step to turn it off.
- The simulator is **not supported** for these commands (a simulator session is refused with a message); `sim appearance`
  is unchanged. They need Xcode 27's `devicectl`, and the saved UDID is passed on every call.
- Landscape is untested for `safari shot --page`, `tap` and `swipe` (the crop only trims the top and bottom); check a
  shot before trusting it.

**Lab Focus during phone runs** (issue 16). So notifications do not
pop up over the page or into screenshots, `lab up` on the phone turns on a Focus of yours called **Lab**, and `lab down`
(and `safari stop`, the idle stop, `lab phone restore`) turns it off again. The lab cannot create or change a Focus: you make
the Focus and two Shortcuts once, and the lab runs the shortcuts by name.

Set it up (once, on the phone):

1. Settings → Focus → **+** → Custom. Name it **Lab**. Under Silence Notifications From, choose **all apps** (iOS 27's "Silence
   notifications from" list) and allow nobody. The default "allowed apps" setup lets Time Sensitive notifications (Reminders,
   Calendar and so on) through: in a live check a Reminders alert still showed over the page until the Lab Focus silenced all apps.
   While the Focus is on, the Lock Screen shows it at the bottom and the status bar shows its icon: a plain `shot` shows the icon,
   `safari shot --page` crops the status bar out. Under Focus → **Share Across Devices**, decide whether the Lab Focus should also turn on on your other
   devices: with it on, your Mac and iPad go quiet too while the lab runs.
2. Shortcuts → **+** → name it **Lab Focus On**. Add the action **Set Focus**, set it to **Turn Lab On Until Turned Off**.
3. Shortcuts → **+** → name it **Lab Focus Off**. Add the action **Set Focus**, set it to **Turn Lab Off**.

Other names work: `lab phone setup --udid <UDID> --team <TEAM> --focus-on-shortcut "<name>" --focus-off-shortcut "<name>"` saves them
(letters, digits, space, dot, hyphen and underscore, up to 60; the name is URL-encoded when run). `--focus off` turns the
whole thing off until `--focus on`; `lab up --no-focus` skips it for one run. It is **on by default** for every phone `lab up`;
the simulator never runs it. `lab phone status` shows the saved settings. To check your setup without a session: `lab phone focus test` runs the On
shortcut (the same lock check and ledger entry as `lab up`) and tells you to look for the Lab Focus icon; `lab phone focus off` runs the Off
shortcut and clears the record. Both need the phone unlocked, take no session (they are refused while a device or simulator session is open), and check the lease like `lab phone restore`.

How it works:

- `lab up` runs the shortcut in a new `focus` step, **before** it opens the lab's Safari tab (the Shortcuts app is left in
  front by the shortcut, and the tab is opened over it): `xcrun devicectl device process launch --device <saved UDID>
  --payload-url 'shortcuts://run-shortcut?name=Lab%20Focus%20On' com.apple.shortcuts`. A session that is already open is kept
  as it is and runs nothing. After `lab down` or `safari stop` the Shortcuts app is in front on the phone.
- It is recorded in the restore ledger first (kind `focus`, [ADR 0007](docs/adr/0007-phone-settings-restore-ledger.md)) and put back with
  the Off shortcut at the same points as appearance and orientation. The lab **cannot read which Focus is on**, and
  `devicectl` confirms that the shortcut was started, not that the Focus changed. So the ledger only says "the lab turned Lab
  Focus on", the restore runs Off and clears the record once that launch is delivered, and the output says
  `restoredExactly: false` with a note: it assumes Lab Focus was off before the run.
- **A locked phone is never launched onto.** `devicectl` reports success on a locked phone, but iOS then shows a passcode prompt
  and does not run the shortcut. The lab reads the lock state first. At the start, a locked phone is the usual `needs: unlock`.
  At the stop (and the idle stop, which runs 15 minutes later when the phone has probably locked) the entry is kept and
  nothing is launched, so there is no surprise passcode prompt; `phoneRestored: false` with a `human` step says so, and the
  next unlocked `lab up`, `lab down` or `lab phone restore` runs Off (a `lab up` runs Off first, then On).
- If the shortcut cannot be run, `lab up` still succeeds: the output has `focus: { applied: false, needs: "shortcut", error }`
  and a `human` step with the setup above (`needs: unlock` if the phone locked in between). A shortcut that does not exist is not
  detected: the Shortcuts app shows an error on the phone and the lab reports `applied: true, verified: false`. A `lab up` that fails before its session opens turns Lab Focus off again itself (a failure after the session is open leaves that to `safari stop`/`lab down`, since the Shortcuts app would cover the lab's tab; the failed JSON has `phoneRestored`; on a locked phone the entry is kept and a `human` line says Lab Focus is still on).
- Calls, people you allowed in the Focus, and Time Sensitive notifications can still break through a Focus; that is the Focus's setting,
  not the lab's. Silence notifications from all apps in the Lab Focus (setup step 1) and check its allowed people.

**After the Wi-Fi tunnel dropped.** A session records which tunnel it ran on (`transport.startedAt`).
`lab up` (and `safari start`) first asks whether that tunnel is still the one and still answers (the
record, its host, one 3 s TCP connect and one 3 s WebDriverAgent `/status` request through the tunnel). If it is gone, was replaced or WebDriverAgent is silent, the old
session is dead for certain, so the lab does not probe it, does not try to restore the keyboard through it
(each would wait out 10 s for a route that is not there) and ends it with a short (3 s) delete, then starts the
new one: recovery costs about the tunnel start plus the session create. The output then has
`keyboardDeferred` ("the new session puts them back when it ends") instead of `keyboardRestored: false` and a
step for you to do: the restore mark stays, so the new session's end (or `lab down`) restores the settings or
says what to do. The old lab tab is left open on the phone and `previousTab` says so once ("its session was on a
tunnel that is gone, so the lab could not close it"): the lab does not look for it among your tabs; close it
by hand. A session whose tunnel is fine but which is dead anyway is probed, restored and deleted as before.

**Battery: always `lab down`.** The phone does not auto-lock while a lab session
(WebDriverAgent) is running, so the screen stays on however long the session sits idle. After
`lab down` it locks normally again. A locked phone mid-session is not a failure: commands say
`needs: unlock` and carry on once the phone is unlocked (the session is kept, and so is its
tab; `lab up` also checks the lock on a session it keeps).

**Command differences.** Everything works on the phone, with these differences: `open` and
`refresh` replace the lab's own tab and refuse a redirect to another site (unless it is one of the session's allowed hosts). Safari clears the
tab's marker when the site changes, so after each of them the lab marks the tab again; if the
page list moves under it during that moment (a new page appeared and pulled the driver away; with the page pin that only happens if the pin failed),
the lab waits for the list to settle (up to 5 s) and marks the tab once more, and the
output says `markRetried: true`. Only one such retry is allowed per navigation; a second
move, or a page that ended on another site, still ends the run with `needs: tab`. When that
happens the tab left behind may be on the page of the failed command, and the text for
the owner names the last site the lab sent it to ("the lab last sent it to
https://example.com"), never a path or a redirect's target. `safari keys`
checks the typed text against the field at the end (on the simulator too) and reports
`textChecked`, and
`caseChanged: true` when only the case differs (the phone's keyboard capitalises: `zq`
becomes `Zq`; that is not a failure, anything beyond case is) and, when it could not compare,
`textChecked: false` with `textSkip` (password, contenteditable, caret, newline, backspace,
`no-verify`, unverified). The first WebDriverAgent start after a while may ask for the
phone's passcode on the phone.

## Limits

- **Interrupts.** `Ctrl-C`, `kill` (SIGTERM) and a closed terminal (SIGHUP) stop a `sim`,
  `safari` or `lab` command with one JSON object (`ok: false`, `interrupted: "SIGTERM"`, no
  failure screenshot) and exit code 130, 143 or 129 (128 plus the signal number). A wait or a
  request to Appium ends at once and the command's own cleanup runs. An interrupted phone page
  command parks the session in the native app and says `sessionKept: true` and whether the run
  was `tainted`: **a request already sent may still finish in the lab's tab**, so check the
  page (`lab status`, `safari url`) before repeating a click or a type. The session, Appium and
  the lease are kept (`lab service` hands back a lease it took itself); `lab down` or
  `safari stop` ends them. An interrupted `safari stop` or `lab down` keeps the session record
  (and `lab down` the lease, running no later step) unless the session was deleted: run it again. A command inside a synchronous `simctl`, `devicectl` or `launchctl` call
  notices the signal when that call returns (calls that can run long carry their own timeouts;
  any other command is cut off after 120 s with exit 124); a second signal, or 8 s after the
  first, ends the command at once with a short JSON object. A command that still finishes `ok`
  after a signal exits 0, with `interrupted` set in its output.
- **Userscripts run after the page loads** (`safari inject`), not at `document-start`, and
  only scripts that need no `GM_*` API beyond `GM_info` work. An injected script is lost
  on every navigation and refresh: `safari open --reinject` and `safari refresh --reinject`
  run the injected files again after the new page loads, but only the files whose
  `@match`, `@include` and `@exclude` fit the final page (a file with none of them runs
  everywhere; any `@exclude` wins). The others are named in `reinjectSkipped` and not run.
  `safari inject` runs a file wherever it is asked to and adds a `warning` when the page does
  not fit its `@match`. Every injected file stays recorded, so with two scripts for one site
  `--reinject` runs both and adds a `warning` naming them; `safari inject --forget <file>` drops
  one (`remaining` lists the rest; a file that is not recorded is an error that lists what is) and
  `safari inject --clear` drops all (`cleared` is the count). Neither runs anything in the page,
  and each is refused with any other file or flag. App Store extensions (the
  Userscripts app, Tampermonkey) can't be installed in a simulator, and WebDriver sessions
  start clean (like a private window, probably without extensions). Scripts that must run
  before the page draws are not supported on the simulator or the iPhone. Other Safari
  extensions of yours can inject into the lab's tab on the iPhone, but the Userscripts app's
  scripts did not in one run (iOS 27.0.1, cable, 2026-10-27; cause unknown,
  issue 102): test a userscript on the
  phone with `safari inject`, not the installed copy. `safari inject` right after a navigation
  may run in the outgoing page and do nothing (seen once, not reproduced): `inject` watches for
  half a second afterwards and reports `pageChanged: true` with a `warning` when the page showing
  is no longer the document the script ran in (run it again, unless the script navigates by
  itself). Waiting for the page first (`safari wait <css>`, or `open --wait-for`) avoids it.
- **Synthetic vs real input.** `safari click` and `safari type` act through WebDriver and
  give the page untrusted events (`isTrusted` false). `safari tap`, `keys` and `swipe` go
  through the native layer and give trusted touches and key presses, with the software
  keyboard and auto-capitalisation. `tap` and `swipe` work out where the page is on screen
  by pinning a transparent probe element to the visible (visual viewport) corner of the
  page and reading its place in the native tree (Safari 27 draws the page behind the status
  bar and toolbar, so the web view's own rectangle is the whole screen). The probe's
  measured position, in the page and on screen, anchors the mapping and the scale comes
  from the visual viewport, so it holds when the page is zoomed in or pinch-zoomed and
  scrolled; the probe is removed again, and the command refuses if it can't be found or if
  it is off the screen. `tap` scrolls an off-screen element in, then reads the element's
  rectangle three times (before the probe, in the probe's own script, and right before the
  touch) and taps only when they agree; an element that keeps moving (a scrolling or
  reflowing page) is refused with "kept moving" and no touch is sent. After tapping a text
  field it reports `focused` (whether the field is now the page's active element). `tap` scrolls an
  element that is off screen (or near the edge, under Safari's controls) into the middle of
  the page first, so `scrollY` can change. If the target is invisible (computed opacity 0,
  `visibility: hidden`, `display: none`, or under 2 px wide or high) the touch is still sent,
  with a `warning` saying it probably focused nothing: a page that reads keys from such a
  field (a 1x1 transparent input) is not focused by a tap on it, so check `focused`. `tap` and `swipe` also refuse to touch Safari's own toolbar
  or address bar; `keys` refuses unless a page field (the page's active element) is focused and the keyboard is up. Don't type into the
  address bar: it performs a web search.
- **Finding by text, position or shadow root.** `click`, `type` and `tap` take `[css]`
  `--text <T>` `--contains` `--nth <N>` `--shadow` (a bare `--` ends the flags; `type`'s last
  argument is the text, and a text that is exactly `--text`, `--nth`, `--contains` or `--shadow` is
  read as a flag, so type it after `--`; extra positionals are refused). The text is the element's `innerText`, trimmed, with every run of
  whitespace one space (your `--text` is cleaned the same way): exact by default, a substring with
  `--contains`, case-sensitive. It matches visible text, so for `type` it usually finds a label or
  container rather than an `<input>` (inputs have no `innerText`): use a css selector for fields.
  Without a css selector it looks at every element under `body`
  (`script`, `style`, `noscript` and `template` are skipped; more than 5000 candidates are
  refused, so give a css selector to narrow it); of the elements whose text matches, one that
  contains another match is dropped, so you get the innermost. More than one match is refused
  (`3 elements match text "OK" (button); add --nth 1..3`) when `--text` is given; plain CSS, or
  CSS with `--nth` or `--shadow` but no text, keeps taking the first match and reports `matches`.
  `--nth` is 1-based, 1 to 10000. `--shadow` enters **open** shadow roots only: all the arguments
  are selectors, each host is searched in the roots of the one before, and the last is the
  target (use `'*'` with `--text` to search a whole root). A host with no open root (none, or a
  closed one, which can't be entered) is refused; use `tap --label` there. The output names what
  you asked for (`button text="Continue" #2`) and `matches`, never the page's own text. On the
  phone these run inside the tab guard like every page script. On the simulator `click` and `type`
  resolve the element in the page and then use WebDriver's own click and keystroke routes, as plain
  CSS does; on the phone they use the guarded click and value scripts. `type` sets the text the
  same way for every kind of selector on each target. A plain CSS selector behaves and prints as
  before.
  `tap --label "<label>"` (alone: no css, `--text`, `--nth` or `--shadow`) reads Safari's native
  tree once, keeps only the web view's subtree (never Safari's tab bar, toolbar or address bar,
  whose labels can be the owner's other tabs' titles) and taps the centre of the one element whose
  accessibility label is exactly that (none, or several, are refused with the count; `safari ui`
  lists the labels). It does not scroll or check for a cover: a target outside the visible page is
  refused (scroll with `safari swipe`), a point on Safari's toolbar or address bar is refused, and
  on the phone the tab is checked to be showing right before the touch. There is no `--at x,y`
  form: a tap by raw coordinates would go to whatever is there.
- **`safari wait` polls the page, within limits.** `wait` takes the selectors of `tap` and `click`
  (`[css] --text --contains --nth --shadow`, not `--label`) and asks the page every 250 ms on the
  simulator and every 500 ms on the phone (one tab-guarded script per poll; nothing loops inside the
  page). It stops at `--timeout` (10000 ms by default, 100 to 60000; a timeout is checked between
  polls, so a poll that hangs can overrun it by the tab's own limit, and `elapsedMs` is the real
  time) with `ok: false`, the counts and no `needs`; the simulator also leaves `fail.png` and
  `fail.html`. Plain `wait` means at least one match exists. `--visible` means at least one match
  is rendered: not `display: none`, `visibility: hidden` or `opacity: 0`, and at least 2 by 2 px
  (the check `tap` uses for its `warning`). An element that is covered or off screen is still
  visible, an ancestor with `opacity: 0` is not noticed, and only the first 50 matches are
  measured, so `--gone` is not satisfied while more than 50 match (without `--nth`), even if the
  first 50 are hidden. `--gone` means no match is visible: removed and hidden both count. With `--nth` only
  that element is looked at. A shadow host that is missing, or has no open root, keeps `wait`
  polling and the timeout names the host (`--gone` treats a missing host as gone, but not a host it
  cannot look into). `wait --settled` returns when the document is complete, no image or font is
  loading (an unfinished image that is hidden, or a lazy one outside the viewport or with no size,
  is not waited for; the output always has `skippedImages`, the number of those) and, for
  `--quiet` ms (100 to 10000, less than `--timeout`), no resource finished loading, the DOM did
  not change and the page's scroll size did not change. Its first call
  installs the observers in the page, so a page that never waits has none; they stay until the next
  navigation, after which the next `wait --settled` installs them again. A request still in flight
  is not seen until it completes, and a page that animates through the DOM never settles: the
  timeout then reports the activity it saw (`resources`, `mutations`, `sizeChanges`). If the
  browser has no `PerformanceObserver` or `MutationObserver` the output says `resourcesWatched:
  false` or `domWatched: false`. `open --wait-for <css>` and `--settle` (also on `refresh`) run
  these waits after the load and after `--reinject`, each with its own `--timeout`; a wait that
  fails still says `navigated: true` with the `url` and `title`. The output never carries page
  text.
- **AXe does nothing during an Appium session.** `sim tap` and `sim type` are silently
  ignored while a `safari` session is open: use `safari tap` and `safari keys`. Outside a
  session `sim` works as before.
- **Page source is not redacted.** `safari source` and `fail.html` are the page's raw HTML,
  as the artifact asked for; they can contain whatever the page shows. Only URLs in the
  logs, errors and `network.json` are scrubbed.
- **Simulator sessions are private and logged out**, one at a time, unless you chose the configured
  profile (then they hold the sign-ins you made by hand; see "Two simulators"). On the iPhone the lab's
  tab is in your own Safari profile.
- **`safari keys` is slow and checks itself.** It sends one character per call with a 120 ms
  pause (Backspace about 0.6 s each in the simulator), because sending them in bulk dropped characters
  mid-word. Even so a character can be lost (the key goes down, the field gets nothing), so
  after each one `keys` reads the focused field in the page, for up to 1.5 s (a press has
  been seen to arrive 0.9 s late). A character has **landed** when the field's length
  changed, its text changed (a hash of it; the text itself never leaves the page, so a
  field that rewrites itself to the same length counts) or the field received a
  `keydown`, `beforeinput` or `input` event (events from other elements don't count). If
  none of those happened it waits again and then
  sends the character again, up to twice more, then fails with `ok: false` naming the
  character's position (#N) and how many characters were typed before it (never the text or the
  field's value, which may be a password). If a resend
  turns out to have doubled a late press (the field grew by more than one character), it
  also fails, saying so. A success means every checked character landed; `retries` counts
  the resends. Events count only while the field has never changed during the run: once it
  has, a press that fires its events and adds nothing is a dropped press and is sent again.
  **Self-resetting fields.** Some pages reset a hidden input after every key (minutecryptic.com
  keeps a 1x1 field at two spaces), so neither the length nor the text ever changes. Those
  characters land by event only: they are sent once, counted in `byEvent` (and in
  `unverified`, since the text was not seen to change), and the text post-check is skipped
  when the field is exactly as it was (`textChecked: false`, `textSkip: "unverified"`);
  `byEvent` alone does not skip it when the field changed. Because an event
  can arrive before the text does, `keys` waits the whole 1.5 s window for the text to
  change before it settles for the event, so such a field costs up to about 1.5 s per
  character on top of the 120 ms pause (measured on the iPhone, 2026-10-18: about 3 s per
  character, and about 4 s per Backspace, on minutecryptic's field; about 1 s per character on
  a plain input). The catch: where neither the text comparison nor the length check applies
  (`textChecked: false` and a Backspace, a newline, a selection, a full field or focus that left the field, or a field
  that never changed), a field that swallows a key but still fires `keydown` can report `ok` with
  `byEvent`; look at `byEvent`, `textChecked` and the page.
  A plain field is also length-checked at the end (lengths only, so password fields are
  covered): when a character landed only by event and the field ended up shorter than what was
  sent, `keys` fails ("the field is N characters short of what was sent"; the text is not
  shown, the field may hold a secret), so a dropped press at the start of the text is not
  reported as ok. A field that grew by more than was sent is a `warning` giving the counts only when the
  text is not compared (password, contenteditable); a readable field that the page reformats
  (an input mask) fails the text comparison ("the keyboard or the page changed the text").
  Sent once and not checked, counted as `unverified` when they could have been: a character
  typed into a field already at its `maxlength`, and anything once focus has moved to another
  field (an OTP form that advances by itself). A character typed over a selected range (a
  page that selects on focus) replaces it, so it is sent once and any change of length or
  caret counts; if nothing changed it is `unverified`. Return (`\n`) is never checked, since
  it may submit or navigate, and Backspace in an empty field or at its start is pressed once.
  A field that refuses a character on purpose without firing an event (a number or email
  input, an input mask) therefore fails `keys`;
  `--no-verify` sends every character once without checking, as before (`verified: false`
  in the result). Text that starts with `--` needs `--` before it (`safari keys -- '--x'`).
  `keys` stays in the page, Backspace included (it reads Safari's native tree once per run
  to find the keyboard's delete key, then taps it; the first Backspace of a run costs about
  a second more), so typing adds no log listeners to Appium. Keep texts short.
- **Appium's idle wait is turned off** (`waitForIdleTimeout` 0, set by `safari start` and
  `lab up` on new and reused sessions). WebDriverAgent otherwise waits up to 10 s before and
  after every native action for Safari to be idle, which it never is in the simulator, so a
  tap or a key cost about 20 s. Without the wait, `tap` and `swipe` pause 0.4 s and 0.6 s
  for the page to stop moving; that pause leaves out the time to read Safari's native tree,
  which is the slow part: on a cold simulator on an 8 GB Mac one `tap` took 6 to 19 s
  (simulator). On the iPhone a `tap` took 0 to 4 s, typically 3 s (2026-10-18). Budget seconds, not 0.4 s, per `tap`. A session made
  before this change gets the setting the next
  time you run `safari start` or `lab up`. Speed of `keys` now: see `docs/acceptance.md`.
- **The first session is slow** (about 2 minutes) while WebDriverAgent is built; `safari
  start` waits for it.
- **Xcode 27 has no Simulator.app.** `sim boot` opens Device Hub instead; the window is
  only a view, nothing depends on it.
- **Console messages** depend on the target. On the **simulator** they come from Safari's
  own log, read through Appium rather than a hook. Reading clears the
  buffer. Appium adds another log listener on every switch from the native layer to the page,
  and no command here switches any more: `tap`, `swipe`, `ui` and Backspace read the native
  tree and send touches from the page context (`mobile:` calls go straight to
  WebDriverAgent), so a message arrives once. `safari console` and `safari network` still
  drop byte-identical copies (a session made by an older version has some; two genuine
  repeats differ in timestamp and stay); `dropped` counts those copies and WebDriverAgent's
  own entries. Appium keeps only the last 5000 raw entries of each
  log and drops older ones silently: when a read comes back with 5000, the output adds
  `truncated: true`, `copies` (how many times the most repeated message came in) and a
  `note`; read more often, or `safari stop` then `safari start` to reset it. On the
  **iPhone** Safari's log holds every tab's messages, so the lab never reads it: `console`
  is the lab's own collector, a small script it puts in its tab after each `open` and
  `refresh`. It records `console.log`, `warn` and `error`, uncaught errors and unhandled
  rejections (500 at most, `dropped` always 0) and misses whatever the page logged before it
  was installed. Query secrets in console URLs and text are masked on both targets like
  those in the network log (the names above, `k` included). Seen live on the iPhone for the
  network log only (2026-10-18: `k=[redacted]`); no such console line has been seen there yet.
- **Network on the iPhone is the page's own Resource Timing, not a request log.** Safari's
  log would hold every tab's traffic and, through Appium, repeats every event once per
  context switch until its 5000-entry buffer overflows, so the phone never uses it. Instead
  the collector in the lab's tab records what the page's Resource Timing says, and
  `safari network` reads it through the tab guard. Per request: `name` (the URL, secrets in the
  query masked), `initiatorType`, `startTime`, `duration`, `transferSize`, `encodedBodySize`,
  `decodedBodySize`, `responseStatus` and `nextHopProtocol`
  (`network.json` has them all; the printed `requests` list is `method`, `url`, `status`). What is missing, because Resource
  Timing does not carry it: the **method** (always `null`), headers and bodies, and the
  **status** (`responseStatus` and the printed `status` were `null` on every entry in the
  2026-10-18 check on iOS 27.0.1, and `null` does not mean the request failed); a request to another site that does not send
  `Timing-Allow-Origin` reports its sizes (and status) as 0. The collector is installed once
  the page has loaded (right after `open`/`refresh`) and starts from the browser's own
  buffer of the requests so far; that buffer holds 250, and `early: true` says it was full,
  so the oldest requests are gone. Fetches
  and XHRs the page makes show up; `GM_xmlhttpRequest` and a userscript manager's own
  requests probably do not (they leave the page's world; not verified), so a userscript's
  cross-origin calls can't be checked here. The fields:
  `count` (entries listed), `outside` (entries to other sites, by design: only the lab tab's
  sites are listed, and they are only counted; this includes a script's own calls to, say, a
  dictionary API), `origins` (the sites that were allowed), `dropped` (always 0 here),
  `truncated: true` (more than 500 were waiting, run `network` again for the rest), `lost` (entries
  past the collector's 2000 that were only counted) and `note`. There is no `copies`: no
  Appium log is read. Don't fill the gap by reading the page's timing
  entries with `eval` on the phone: that prints every site the page talked to, which can
  carry account ids. Use the simulator when you need to see a script's own requests.
- **The lease is advisory and per user.** It is a file in `~/.config/mobile-safari-lab/`
  that these three tools honour; nothing stops a process that talks to `simctl` or Appium
  directly. Every `safari` command and the `sim` commands that change the phone (`create`, `boot`,
  `open`, `tap`, `type`, `scroll`, `swipe`, `appearance`, `statusbar`, `shutdown`, `reset`)
  take or renew it, so the first agent to act owns the simulator for 15 minutes
  (`MSL_LEASE_TTL`, in seconds) after its last command. Another owner is refused with who
  holds it and until when; `udid`, `shot`, `ui`, `run`, `doctor`, `profile`, `lab status`
  and `lab service status` don't need it. An expired lease is taken over (and reported as
  `lease` in the output). To take a live one: `lab up --force` or `lab release --force`;
  `safari stop` releases it; `lab service install` and `uninstall` take it only while they run.
  Every take, renewal and release also writes the time to `activity.json`, which the idle stop reads;
  `sim shot` and `sim ui` write it too, without taking the lease (best effort: a busy lease lock is a
  note on stderr and the command still runs).
  The owner is `MSL_OWNER`, else `CLAUDE_CODE_SESSION_ID`, else
  `user@host:tty`; shells without a terminal all count as `notty`, so set `MSL_OWNER`
  there. There is no way to tell that a crashed agent is gone, so a new agent can be
  refused for up to 15 minutes after the old one died.
- **The idle stop** is a per-user LaunchAgent that runs this checkout's `bin/lab` with the node
  `lab service install` chose, so a moved checkout or a removed node breaks it (`lab status` lists
  that under `idleStop.issues`; run `lab service install` again). It sees only what the shell
  that installed it had set (`MSL_STATE`, `MSL_APPIUM_HOME`, `MSL_IDLE_MINUTES` and the like), not
  `MSL_APPIUM_URL`, and never stops an Appium it did not start. A simulator the lab booted and
  that you then used by hand is shut down all the same once the lab is idle. The lab records
  that it booted the simulator (`simBoot`), not which boot: there is no cheap identifier for a
  boot in `simctl list`, so if the lab boots it and you shut it down and boot it again by hand
  before the record is cleared, the idle stop still takes it for the lab's and shuts it down.
  `simBoot` holds one UDID: only one of the two simulators is ever booted, so one is enough. Only `lab down`, `sim shutdown`, `sim reset` and an idle-stop check that finds it `Shutdown`
  clear the record, so boot it by hand only after one of those, or run `lab down` first.
- **The LaunchAgent needs you logged in.** It lives in your GUI login session, so the Mac
  has to be logged in (the simulator needs that anyway). `lab down` stops it and disables
  it until `lab up` ([ADR 0004](docs/adr/0004-lab-down.md)). Its log,
  `~/Library/Logs/msl-appium.log`, is not rotated. The node path is fixed at install time
  (see step 7).
- **Recovery recreates the session** (about 1 to 2 minutes), so page state, injected
  scripts and the console and network buffers are lost when `lab up` or `safari start`
  finds the session dead.
- **Simulator ≠ phone** for performance, GPU rendering, touch feel and the camera.

## Development

Run `pnpm install` once: it turns on the pre-commit secrets check (`scripts/check-secrets.mjs`), which refuses a
commit that stages a key, certificate or profile, a real device UDID, an ID saved in the lab's state (the phone's
UDID, team or bundle id, a simulator's UDID), this Mac's home folder, or a run folder; `pnpm check-secrets` scans
every file, as CI does. `pnpm test` (or `node --test`) runs the tests on any OS: commands are recorded instead of
run, and a stand-in WebDriver server plays Appium; the iPhone's `devicectl` answers are recorded fixtures. Code style and conventions:
[CLAUDE.md](CLAUDE.md). Agents in other repos report what they find in the lab (bugs, missing
features, friction, wrong docs) as described in [AGENTS.md](AGENTS.md#9-report-what-you-find-bugs-features-docs).
To report a problem or send a change, see [CONTRIBUTING.md](CONTRIBUTING.md) (with guidance for AI agents).

## License and trademarks

MIT (`LICENSE`). mobile-safari-lab is not affiliated with or endorsed by Apple Inc. Apple, iPhone, Safari, Xcode and
macOS are trademarks of Apple Inc., registered in the U.S. and other countries. Appium, AXe and pymobiledevice3 belong
to their own authors; the lab runs them and ships none of them.
