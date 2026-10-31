# 0002: Appium for the simulator, safaridriver for a real iPhone

Date: 2026-10-14 · Status: accepted · Partly supersedes [0001](0001-safaridriver-first.md)

## Context

[0001](0001-safaridriver-first.md) chose `safaridriver` for the page layer and left two
uncertainties: whether it can start sessions on current simulators, and what AXe does
during one. On macOS 27 / Xcode 27 / iOS 27 `safaridriver` cannot start a simulator
session on the owner's Mac (cause unknown). It also gives no network log and a lossy
console, and the simulator's own tooling moved: Xcode 27 has no Simulator.app (Device Hub
replaced it) and lists device types newest first.

## Decision

- **Simulator sessions use Appium 3.8.0 with the XCUITest driver 12.18.1**, controlled
  through the existing `bin/safari` CLI (not an MCP server). They are installed with pnpm
  in `~/.local/share/msl-appium`, outside this repo, so the repo stays dependency-free.
  `safari start` launches the server if needed, bound to `127.0.0.1`, without
  `--relaxed-security` or `--allow-insecure`, and `safari stop` ends it when the CLI
  started it.
- **`safaridriver` stays** for `safari start --device <iPhone UDID>`. That path is
  unchanged and untested in this milestone.
- **`bin/sim` stays** (simctl + AXe) for boot, screenshots and recovery outside a session,
  with three fixes: pick the iPhone by model number, open Device Hub when there is no
  Simulator.app, and retry AXe's cold-start failures and use its `physical` tap style.
- **State** records the `backend` next to the session, port and target, and is validated
  on every read; a state from before this change is read as `safaridriver`.

## Evidence (proof of concept, 2026-10-14)

- Appium sessions start on the iOS 27 simulator (about 2 minutes the first time, while
  WebDriverAgent is built), can be reattached from separate processes by session id, and
  load pages from the Mac's localhost.
- **Input:** `mobile: tap` on screen coordinates and `mobile: keys` deliver trusted events
  with the software keyboard and auto-capitalisation. WebDriver `sendKeys` in the web
  context delivers synthetic events (`isTrusted` false). Touch pointer actions scroll the
  page; `mobile: swipe` did not in one try. `axe type` during a session delivers nothing.
- **Console:** `safariConsole` returns each message more than once (see Consequences), plus WebDriverAgent's own
  noise (favicon 404s on `127.0.0.1:8100`), and reading drains it.
- **Network:** `safariNetwork` returns Web Inspector `Network.*` events including `Cookie`
  and `Referer` headers, so redaction is part of reading it.
- **Injection:** a script run through `execute/sync` is lost on navigation and refresh.
  `refresh` returns before the reload happens, so the CLI waits for a new
  `performance.timeOrigin`.
- **Gotcha:** a native predicate for a bare text field matches Safari's address bar;
  typing there and pressing Return performs a web search. The CLI never queries it, and
  refuses to tap or swipe on Safari's toolbar or address bar.
- A marker query parameter appears in the server's access log with the iPhone user agent.

## Consequences

- New setup step (Appium), and a slow first session. `sim doctor` checks for it.
- Console and network logs, trusted taps and key presses, and scrolling are available on
  the simulator. `network` redacts cookie and authorization headers, request bodies and
  secret-looking query parameters before writing or printing; other secrets are not
  recognised.
- Injection still happens after load. `--reinject` re-runs recorded files; `document-start`
  needs a real iPhone or the Userscripts app.
- On Safari 27 the native web view is the whole screen (the page is drawn behind the
  status bar and toolbar), so its rectangle can't map page coordinates: measured on the
  Mac, a 414x750 page sits 48pt down on a 414x896 screen at scale 1. `tap` and `swipe`
  therefore calibrate on each use: a transparent 100x100 probe is pinned to the page's
  top-left corner, found in the native tree by its unique `aria-label`, and its
  rectangle gives the offset and scale. The probe is always removed, and the command
  refuses if it can't be found. Guards (point inside the page area, outside Safari's
  controls, element not covered; too many control matches refuse rather than truncate)
  and the diagnostic output of `tap` remain.
- `document.hasFocus()` is false in an automated session whenever the Simulator window isn't
  frontmost, so `safari keys` never asks it: it checks the active element plus a keyboard-shown
  check, never neither.
- Appium adds a Web Inspector listener on every web/native context switch, so console and
  network messages arrive once per switch so far (measured: one `console.warn` became 23
  entries after about 20 native commands). The copies are byte-identical raw messages, so
  `console` and `network` drop exact duplicates; genuine repeats differ in timestamp and
  column. The log gets heavier over a session; `safari stop` and `start` resets it. Appium's
  buffers (`SafariConsoleLog`, `SafariNetworkLog`) are 5000-entry LRUs emptied only by a
  read, so the copies make older entries fall out silently; `console` and `network` report
  `truncated`, `copies` and a `note` when a read returns 5000. Only a native-to-web switch
  adds a listener (switching to the context already current is a no-op), and
  `mobile:` commands go to WebDriverAgent whatever the context, so code stays in the web
  context: `keys`, and since issue 7 `tap`, `swipe`, `ui` and Backspace too. They read the
  native tree with `mobile: source` (XML rooted at the Application node, whose rectangle is
  the screen; measured live to give the same rectangles as the native element queries and
  `/window/rect` they replaced), send touches with `mobile: tap` and `/actions`, and never
  call `POST /context`. In the web context `/window/rect` is the CSS window, so it must not
  be read for the screen.
- The idle wait is off (`waitForIdleTimeout` 0 through session settings, set by `start` on new
  and reused sessions): on the simulator Safari never idles, so each native action cost
  about 20 s. `keys` checks every character by reading the focused field's length in the
  page, resends a lost one twice, then fails. It does this in the web context without
  switching. Backspace taps the keyboard's delete key, found once per run in the native tree
  (`mobile: keys` deletes nothing with "\b", "\u007f", "\uE003" or "\u0008", tried live).
- `keys` types only after the keyboard has been reported shown and has settled (0.7 s);
  typing earlier loses the first character.
- Appium listening on localhost is a trust boundary: keep `127.0.0.1` and no relaxed
  security.

## Deferred

A bootstrap script for the Appium install, the Userscripts app for `document-start`
scripts, `Page.setBootstrapScript` experiments, and testing on a physical iPhone.

The LaunchAgent for Appium and the simulator lock with a `lab up` health and recovery
command, deferred when this was written, are decided in
[0003](0003-launchagent-health-and-lease.md).
