# 0001: Simulator + safaridriver first, Appium only if needed

Date: 2026-10-13 · Status: accepted, partly superseded by [0002](0002-appium-for-the-simulator.md)

## Context

Testing userscripts and web apps on iPhone meant iPhone Mirroring: laggy, dropped taps, the
phone tied up, and an agent limited to pixels. The goal is real Mobile Safari that Claude
can drive and inspect from the Mac.

## Decision

- **Target:** Mobile Safari in the Xcode iOS Simulator, one dedicated device
  ("Claude iPhone") always addressed by UDID.
- **Page layer:** Apple's `safaridriver` with `safari:useSimulator` and
  `safari:deviceUDID`. It ships with macOS, needs no WebDriverAgent build, and gives find,
  click, type, execute script, page source and screenshots. The client is our own ~200
  lines over `fetch` rather than a WebDriver library, for zero dependencies.
- **Phone layer:** `xcrun simctl` plus AXe through the shell, not an MCP server. AXe
  supports Xcode 26/27, takes `--udid` on every command and taps by label. The simulator
  MCPs reviewed (joshuayoes, whitesmith, XcodeBuildMCP, mobile-mcp) add no DOM access, and
  some fall back to "first booted".
- **Later, only if needed:** Appium XCUITest for console and network logs; building the
  open-source Userscripts app for the simulator for `document-start` scripts.
- **Not here:** Playwright WebKit. It's Playwright's own WebKit on the host, not iOS Safari.
  It belongs in an app's own CI tests.

## Consequences

- Userscripts are injected after load; `document-start` behavior is checked on a real
  iPhone (same `bin/safari` with `--device`, or by hand).
- Console capture starts at `safari open`; no network log.
- Two uncertainties to settle on first use: `safaridriver` session start on iOS 26/27
  simulators (WebKit bug 205532), and whether AXe taps work during a WebDriver session.

Research and comparison: the "Mobile Safari testing from the Mac" doc (2026-10-13).
