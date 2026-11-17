# Privacy

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
- A plain screenshot is the whole screen (`--page` and `--element` cut it to the web content); with a system sheet up
  (Share), it shows the sheet and the owner's contacts in it, and `--page` is refused (`needs: sheet`). The owner's extensions and logged-in sessions are live in
  the page you test (on the simulator too, with `--profile configured`). Treat what you see as the owner's data.
- Everything the lab starts on the Mac listens on `127.0.0.1` (Appium, and the small registry the tunnel host
  serves for Appium; the pymobiledevice3 tool opens no listener). WebDriverAgent is told to listen on `127.0.0.1` on the simulator and over the
  cable, and on the tunnel address only over Wi-Fi, so nothing else on the Wi-Fi can drive the phone. While the tunnel is up,
  other programs on the Mac can reach the phone's services through it, much as through usbmux over a cable (the idle stop and
  `lab down` end it). Reaching the phone away from the Mac's network is not supported.
