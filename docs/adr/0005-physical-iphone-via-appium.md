# 0005: A physical iPhone through Appium, with the owner's tabs left alone

Date: 2026-10-16 · Status: accepted · Supersedes the `safaridriver` device path of [0001](0001-safaridriver-first.md) and [0002](0002-appium-for-the-simulator.md) · Builds on [0003](0003-launchagent-health-and-lease.md) and [0004](0004-lab-down.md)

## Context

[0002](0002-appium-for-the-simulator.md) kept `safaridriver` for `safari start --device <UDID>`
and said it was untested. Tried on the owner's iPhone 15 Pro Max (iOS 27.0.1), it does not work:
a click is delivered as a press with no release, and typing inserts nothing. The owner wants to
test pages and userscripts on the real phone, with its real WebKit, GPU, fonts, network and
extensions, over a cable or over Wi-Fi.

A real phone also holds the owner's own Safari: their tabs, logins and history. A driver that
attaches to "whatever page is current" would read them. That, more than the page commands,
is what shaped the design.

## Decision

- **The phone is the `appium` backend with another capability set.** Appium with the XCUITest
  driver and WebDriverAgent (WDA), built and signed on the Mac, started by the same `safari`
  commands as the simulator. The session's target is `{device: <UDID>}`. `appiumDeviceCaps` in
  `lib/appium.js` builds the capabilities; `lib/phone.js` holds everything phone-specific
  (`devicectl` parsing, reachability, lock state, signing expiry, the `needs` classifier, the lab
  tab). One session path, one client.
- **Targets.** `lab up` and `safari start` take `--target auto|device|simulator`. `auto` picks
  the simulator when no phone is saved and the phone when it is reachable and unlocked; a saved
  phone that isn't reachable stops with a `needs` and the simulator as the way out, rather than
  silently running somewhere else. `--device <UDID>` stays as an alias and must equal the saved
  UDID. An existing simulator session is reused without asking `devicectl` anything.
- **Reachability is a live call.** `devicectl list devices` still says `localNetwork`,
  `connected`, `paired` after Wi-Fi is off and the cable is out, so it is not evidence. The
  phone counts as reachable when `devicectl device info lockState` answers (20 s bound) and
  usbmux (what Appium uses) lists it. After toggling Wi-Fi, usbmux may drop the phone while
  `devicectl` still sees it; the fix is the cable, briefly.
- **Unattended failures say what a person must do.** Every device failure is
  `{ok:false, error, needs, human:[...], then, or}` and never prompts or waits. `needs` is one of
  `setup`, `xcode-account`, `keychain`, `developer-mode`, `trust`, `unlock`, `passcode`, `cable`,
  `resign`, `slots`, `tab`, `service`, `unknown`. The classifier maps the failure texts seen on
  the real phone (CoreDeviceError 4016 and NWError 60 mean `cable`; "Timed out while enabling
  automation mode" means `passcode`); text it doesn't know is `unknown`, redacted.
- **Free-account constraints, designed in rather than hit.**
  - Profiles last 7 days. The WDA's expiry is read from its `embedded.mobileprovision` and cached
    as `wdaExpires`; below 24 hours (or unknown, or `--resign`) `lab up` deletes only
    `<appium home>/wda-device/Build/Products` (the path is asserted before deleting) so
    `xcodebuild` signs it again. A forced re-sign that doesn't move the expiry is `needs: "resign"`.
  - A device holds 3 sideloaded apps per Apple ID, and WDA takes one. A free account also gets 10
    new app IDs a week, and app IDs are global: one registered by another team can't be used.
    So the bundle id is fixed and reused; a fresh one per run would burn the weekly allowance.
  - Apple can reject a team's profiles outright (`REJECT_PROFILE`, then `0xe8008018`, then a
    cached `0xe8008024` "banned"). The owner's main account was rejected this way. The lab runs
    under a separate free account, and `needs: "resign"` names `lab phone setup` with another
    team as the way out.
  - The first WDA start after a while may ask for the phone's passcode ("enable UI
    automation"); a timeout then means `passcode`.
- **Team and bundle id are stored, not coded.** `lab phone setup --udid <UDID> --team <TEAMID>
  [--bundle-id <id>]` validates the pair against the live phone and saves
  `{udid, teamId, bundleId, wdaExpires?}` in the state file. The default bundle id is
  `com.dividedby.msl-wda-<first 4 characters of the team, lowercased>`. No team id, Apple ID or UDID
  appears in code or tests (fixtures use fake ones), so the repo stays publishable and a second
  team is a data change.
- **The lab tab and the tab guard.** `safari start` restarts Safari on the phone
  (`devicectl device process launch --terminate-existing`, which keeps its tabs) at
  `https://example.com/?msl-<8 hex>`, then:
  - The driver picks a page itself (the lowest id). One fixed boolean check runs in it,
    whether `location.origin` is `https://example.com` and `location.search` is exactly `?` + TAG
    (plain `===`/`!==` comparisons, nothing the page can patch, since issue 101), and nothing else. **This is the one accepted
    exception**: the only code ever run in a page before it is known to be the lab's. A page that
    fails the check is not touched again and the start is refused.
  - The verified page id is the *pinned page*. A token is planted in `window.name`, and the
    session goes to the native context, where it rests. In the native context the driver only
    records new page ids and never attaches, so tabs the owner opens or switches to are not read.
  - Every page command selects the pinned page, confirms the current context is it, runs its script
    behind the token guard (`if (!token) return {__msl:0}`) and a 10 s timeout, confirms the
    context again, and returns to native in a `finally`. Native taps, keys and swipes first confirm
    the page is `visibilityState` visible (`hasFocus()` is often false on a visible tab, so it
    isn't used). Screenshots check before and after and delete the file if the second check fails.
    Any failure discards the result and reports `needs: "tab"`. A context that moved, a missing
    marker or a foreign origin also taints the run; a tab that is only hidden, or gone, does not
    (the owner switches back, or the lab is started again), and neither does a script that gets no
    answer (see the note of 2026-10-19 below).
  - Navigation is a guarded `location.replace`, never `POST /url` (which navigates whatever is
    current) and never `DELETE /window` (which closed a non-lab page in a probe). `window.name`
    is cleared by a cross-site navigation, so the token is planted again after each one, only if
    `location.origin` is among the origins the lab asked for (the https upgrade and www twin
    count). An off-site redirect is refused and taints the run.
  - Closing (`safari stop`, `lab down`): one guarded script either blanks the tab (history longer
    than 1) or arms `window.close()` on a 3 s timer; the session goes native at once and polls
    until the page is gone, because a close while selected makes the driver jump to Safari's
    key tab. If the close did not land the tab is blanked; if the run was tainted or the tab can't
    be verified, the lab touches nothing and reports `tabClosed: false`, `tabLeft` and a step for
    the owner. Whether Safari honours a timer-armed `window.close()` without a user gesture is
    the live probe P8 (see [acceptance](../acceptance.md)); the blanking fallback is correct
    either way.
  - Note (2026-10-19, Appium 3.8.0, appium-xcuitest-driver 12.18.1): Appium runs one session's
    commands one at a time. A script sent to a tab that is not showing is not answered, and every
    later request of the session (`GET /context`, `POST /context`) waits behind it, so the guard's
    own reads got no answer either; the old code took an unreadable context for a move and tainted
    the run (seen live with `shot --page` while the owner was on another tab). **No answer is not
    evidence of a move** (one exception, below). After a script times out the guard sends one read of the context and one
    `POST /context NATIVE_APP`, each waiting only 1 s, and nothing that touches a page. A context
    that is read and is another page taints; so does a park that is answered but does not land in
    the native app, and an answered park whose landing can't be confirmed (the read after it is another
    page or an error); an answered error on the first read does not taint when the park then lands in
    the native app. If nothing is answered the run
    is not tainted and the command is refused as a pause. The next command's pre-select checks decide
    (the context is the native app or the pinned page: continue; another page: taint; no answer:
    refuse again as `pending`, sending nothing more). One consequence is accepted: the refused
    script is still queued, so it can finish in the lab's tab once it shows (never in another tab: the
    driver fixes the page when a command starts). The docs tell agents to check the page before repeating a click or a type. A calibration probe
    left in the lab's page by a refused `tap` or `shot` is removed by the next probe. The
    exception is the navigation path: if the select, the probe or the mark that puts the marker back
    after `open` or `refresh` gets no answer and the park shows no other page, the command says so,
    untainted. The probe only reads; the mark writes only into the document the probe checked, so a
    mark that runs late writes into the lab's tab or nowhere. The record is not updated, so if the
    navigation went to another origin (a cross-site open, an off-site redirect, a www or https twin),
    the next command taints, even if the late mark ran; on the same origin the session goes on. A
    redirect that returns to the original origin while paused continues untainted (the page is the
    lab's own tab on its own origin).
  - Note (2026-10-19, issue 37; Appium 3.8.0, appium-xcuitest-driver 12.18.1, appium-remote-debugger
    17.5.12): **a tab the owner opens must never receive a lab script, and Appium must not attach to it.**
    What the driver does: `connectToRemoteDebugger` binds `this.onPageChange` to the remote debugger's
    page-change event (`commands/context.js:106`; `onPageChange` is an instance field, `driver.js:320`, so
    every reconnect binds whatever the instance holds). The event is emitted synchronously from the Web
    Inspector listing, outside Appium's command queue (`mixins/message-handlers.js:18-43`). While the session
    is in a web context the handler selects any page it has not seen (`context.js:221-223`) or, when the current
    page went, the key tab the owner is looking at (`:225-235`), sets `curContext` and calls
    `remote.selectPage`, which enables the Inspector domains on that page and polls `document.readyState`
    in it (`:249-256`, `rpc-client.js:628-683, 952-983`). In the native context it returns at once
    (`:211-214`), which is why the lab rests there. `remote.execute` takes the target page
    (`_appIdKey`, `_pageIdKey`) when it is called (`mixins/execute.js:127-130`) and there is no way to
    name a page per script, so the window between the lab's last check and that moment is inside Appium and
    cannot be closed from the client. No capability stops it: `safariIgnoreWebHostnames` is a hostname list,
    `includeSafariInWebviews`, `additionalWebviewBundleIds` and `ignoredWebviewBundleIds` filter apps (the
    owner's tabs are in the same app as the lab's), `fullContextList` changes only the shape of
    `GET /contexts`, and the automation session needs a setting on the phone.
    **Decision (option A): a local Appium plugin, `msl-page-pin` (`appium-plugin/`, no dependencies, no import
    from Appium), loaded with `--use-plugins msl-page-pin` and linked into the lab's Appium home with
    `pnpm add link:`.** It runs in Appium's process and event loop and has three layers, each closing the
    window alone: (1) the driver's `onPageChange` is replaced by a handler that never selects (a page that
    appears is only logged, by id and count; a page that goes sets the context to native); (2) the remote
    debugger's `selectPage` runs only for the page a `setContext` being handled asked for; (3) its `execute`
    runs only when the page it is about to take is the one the client selected, checked in the same tick the
    driver takes it, so nothing can fall between the check and the use. Async scripts are refused on a pinned
    session. The plugin arms only a real device, verifies itself (our handler is the only page-change listener,
    both methods wrapped) and only then adds `msl:pagePin: 1` to the session's capabilities; the lab ends a
    device session without the marker before anything is read (`needs: service`) and does not reuse a
    recorded one without `pagePin`. A pinned session whose remote debugger is replaced (a reconnect) is
    pinned again before the next `setContext` or script, or the command is refused. The plugin's refusals
    (`msl-page-pin: ...`) are read by the lab as a move: tainted, nothing ran. Every lab tripwire stays, so a
    pin that fails is still caught after the fact. When the lab's tab closes under a command (the close
    timer winning the race in `endDeviceSession`) the session goes native instead of following the key tab;
    the `closeRace` flag and the taint stay, conservatively.
    **Residual, accepted by the owner:** between the driver connecting the remote debugger inside
    `createSession` and the plugin arming when that returns, the stock handler is live and the session sits
    in a web context. A tab opened in that instant can be selected and attached to by Appium (Inspector
    domains and one `document.readyState` read), not by a lab script; the start check then runs its one
    yes/no tag check in the attached page (the accepted exception above) and refuses. Closing it needs code
    before the driver connects (an early arm through Appium's internal `pendingDrivers`, or a patched
    driver); both were declined as more fragile than the gap is wide. **Why not the others:** patching
    the driver with `pnpm patch` has the same effect but edits vendor code outside the repo, cannot be
    verified per session (no marker) and is silently absent after a reinstall; stronger in-script checks
    already exist (the token) or are impossible (the probe has no marker after a cross-site navigation) and
    still run in the foreign page; tighter client timing shrinks the window but cannot close it; capabilities
    do nothing (above). **Risk:** the plugin relies on driver internals (`onPageChange`, `_remote`,
    `_appIdKey`, `_pageIdKey`, the remote's `selectPage` and `execute`). The install recipe pins the
    versions, arming fails closed (no marker, no session), and a driver bump needs the live check
    (acceptance, iPhone item 19). Tested against the stand-in (`dv.pinned`) and a fake driver
    (`test/page-pin.test.js`) and checked live on the phone on 2026-10-19 (acceptance item 19).
- **Appium's log is redacted.** At debug level Appium logs every tab's URL and title, which is
  the owner's browsing. The LaunchAgent starts Appium with `--log-level info --log-filters <file>`
  (rules in `lib/appium.js`, written to the state dir); `lab service install --log-level debug` is
  allowed too, and the filters stay on at both levels. A device start refuses with "run
  `lab service install`" when the plist lacks them or the listener on the port is not the launchd
  job's pid. A live check with the filters found no unredacted URL or title.
  Note (2026-10-18): Appium's info log also holds request bodies (cut at 1024 characters), so script
  arguments and element value text (`type`, `keys`, storage values) were readable in it, and at debug
  level the remote debugger's atom lines and the proxy's bodies too. The rules now mask them too (the
  service's Appium and the lab's self-started one both run at `info` with them), and a rules file
  older than the code (compared byte for byte) refuses with `needs: "service"`; `lab service install`
  writes the new one. `open --storage` requires the service with current rules on both targets, running
  and the only listener on its port, with the session on that port; an Appium started by hand or
  reached through `MSL_APPIUM_URL` is not checked. This is the `info` level: at `--log-level debug`
  Appium also logs command results (base-driver, remote-debugger), including text read back from
  fields, so debug is for debugging only and the log is deleted afterwards.
  Note (2026-10-19): the rules are read once, when Appium starts, so "current" is also checked against
  the running process: the service must have started after its rules file was last written (`ps`
  elapsed time against the file's mtime, one second of slack; unreadable means refused), and
  `lab service install` writes the file only after launchd has let go of the old service. A plist
  whose arguments can't be read, without `--log-filters` or naming no file is refused on the simulator
  as it is on the phone. `type` and `keys` check this before they send anything. Secrets are kept out
  of messages by place, not by echo: `open` and `refresh` take only the words they know (`--flag=value`,
  unknown flags and extra addresses are refused by position), `keys` names its unknown `--word` by
  position and its failures by character number, the generic flag parser prints only a flag name that
  looks like one, and the storage write's error name is mapped to a short list. After the first
  character of `type` or `keys` is sent, a failure saves no screenshot or page source and says nothing
  the page or Appium wrote. Not closed, only documented: after the write the page can repeat what it
  holds (title, its own errors, the screen), and values are in the shell history and the process list.
- **Network is the lab page's own Resource Timing, kept to an allowlist.** The driver's network
  events cover every attached page, not just ours, and (field test, issue 17) each web-context
  switch adds a network listener to the driver that is never removed, so one event arrives
  once per switch and its 5000-entry buffer overflows within a session (`copies: 190`, the
  page load evicted). First design: filter that log (a request kept only when every URL field is
  http(s) on an origin the lab navigated to, each event rebuilt from typed fields). Replaced:
  the phone no longer sets `showSafariNetworkLog` and the tab guard refuses `safariNetwork`
  from `deviceNative`, so the driver adds no listener and nothing of other tabs' traffic is
  fetched at all. A small collector in the lab's own page (installed after each `open` and
  `refresh`) follows `PerformanceObserver({type: 'resource', buffered: true})` into a buffer of
  2000 (the rest counted as `lost`; `early` when the browser's 250-entry buffer was already
  full; it never resizes or clears the browser's buffer), copying each entry field by field.
  `safari network` reads it with one guarded call (500 at most, `truncated` beyond), then in
  Node keeps an entry only if its URL is http(s), without credentials, on an origin in the
  tab's `origins`, and rebuilds it from `name` (secrets in the query masked, 8192 characters at
  most), `initiatorType`, `startTime`, `duration`, `transferSize`, `encodedBodySize`,
  `decodedBodySize`, `responseStatus` and `nextHopProtocol`, each type-checked. Everything else
  is only counted in `outside`. What it costs: no method (`null`), headers or bodies, `status` (null on
  every entry measured on iOS 27.0.1), sizes of 0 for another site's requests without `Timing-Allow-Origin`, and
  probably nothing from a userscript manager's own requests (another JavaScript world; not
  verified). A script's cross-origin calls therefore only count in `outside`, which is the owner's
  rule (lab sites only). It must not be worked around with `eval` of the page's timing entries,
  which prints every site the page talked to. `dropped` is 0 and `copies` does not exist on the
  phone. The simulator keeps Appium's log (one tab, nobody else's traffic), where `dropped` is
  byte-identical copies plus WebDriverAgent's own requests. Console on the phone is the lab's
  in-page collector for the same reason; the driver's `showSafariConsoleLog` is not set.
- **Autocapitalise: report, don't change.** The phone's keyboard capitalises ("zq" becomes "Zq").
  Editing the page's `autocapitalize` / `autocorrect` attributes would mutate the page under test
  and need a refocus, and the owner's keyboard settings are theirs. `safari keys` compares what
  the field gained with what was typed (never echoing it): equal ignoring case is `ok: true`
  with `caseChanged: true`, any other difference fails ("the keyboard or the page changed the text"). The same
  check now runs on the simulator.
  `textChecked` and `textSkip` say when the text wasn't compared (password field,
  contenteditable, `--no-verify`, a backspace, a tab that couldn't be confirmed).
- **safaridriver is cleanup-only.** The start path and its capabilities are gone. A recorded
  `safaridriver` session is still read so `safari stop` and `lab down` can end it (kept for one
  release); every other command refuses it with "run `safari stop`".
- **`lab down` on a device run** ends the lab tab, then the session, stops the WDA `xcodebuild`
  (it outlives the session with parent pid 1; found by the phone UDID and the `wda-device` path,
  through the same command-line guard as the other pids), leaves the simulator and its window
  alone (no `simctl boot` or `shutdown`, no `osascript`) and stops Appium. `sim` commands that
  change or read the screen refuse during a device session.

## Alternatives rejected

- **`safaridriver` on the device.** Click arrives down-only and typing inserts nothing on iOS
  27.0.1 (above). It would also have kept a second backend alive for a path that doesn't work.
- **A root RemoteXPC tunnel.** Not needed: cable and same-network Wi-Fi both worked for every
  page command without one, and a root daemon is a larger thing to leave on the owner's Mac.
  Use away from the network is future work (issue 15).
- **Signing with the owner's main Apple account.** Apple rejected that team's profiles. A separate
  free account is used instead.
- **Attaching to the driver's current page**, or searching the phone's pages for the lab's tab.
  Both read tabs that aren't the lab's.

## Consequences

- Wi-Fi and cable both work; Wi-Fi is about twice as slow per call (an `eval` about 50 ms against
  20 ms). A cold session start is about 50 s (first WDA build and install), warm 14 to 18 s.
- The phone must be unlocked and awake, and the lab restarts Safari when it opens its tab: the
  owner's other tabs reload when next viewed, and unsaved text in a form can be lost.
- The owner's extensions can inject into pages under test (a feature for userscript testing, a
  variable for anything else). No status-bar control (appearance and orientation have been
  controllable since issue 27, through
  `devicectl` and a restore ledger, not through Appium); screenshots show the whole
  phone screen (since 2026-10-19 `safari shot --page` / `--element` crop to the page or one
  element in memory before writing, so the status bar and Safari's bars can be left out).
- The app ID allowance (3 apps, 10 new IDs a week) and the 7-day profile make a weekly re-sign
  part of using the phone. `lab phone status` shows hours left.
- The guard is only as strong as the driver's page-selection rules, which were read in
  appium-xcuitest-driver 12.18.1. A driver upgrade needs the live probes re-run.
- Tests cover this on fakes (a recording runner and a stand-in WebDriver that, like the real
  driver, switches pages when the current one disappears); the live checks are the "Acceptance:
  iPhone" section of [acceptance](../acceptance.md).
