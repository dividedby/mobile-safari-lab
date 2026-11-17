# Check the setup

Detail for step 1 of [AGENTS.md](../../AGENTS.md).

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
  `needs: "setup"`, see [needs.md](needs.md).
