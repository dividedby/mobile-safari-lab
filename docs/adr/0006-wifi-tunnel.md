# 0006: The iPhone over Wi-Fi through Apple's native tunnel

Date: 2026-10-22 · Status: accepted · Supersedes the Wi-Fi path of [0005](0005-physical-iphone-via-appium.md) (usbmux's "Network" listing) · Builds on [0003](0003-launchagent-health-and-lease.md) and [0004](0004-lab-down.md) · Issue 15

## Context

[0005](0005-physical-iphone-via-appium.md) reached the phone through usbmuxd, for cable and Wi-Fi
alike. Over Wi-Fi that was fragile: usbmux lists the phone only when the Wi-Fi address it
advertises matches the pairing record (so Private Wi-Fi Address had to be Off for each
network), the listing lapsed after the phone slept, and nothing showed that WebDriverAgent,
bound to loopback since issue 51, is
reachable through it at all. The owner wants a walk-up run with no cable.

Xcode's "Connect via network" uses a different route: a CoreDevice tunnel (an IPv6 `fd..`
address on a `utun` interface) opened through remotepairingd. Apple's tooling opens it for
Xcode as root. `pymobiledevice3 remote start-tunnel --native` opens the same tunnel as the
user, with no root and no Private Wi-Fi Address condition, and `remote rsd-info` then answers
with the phone's UDID (the spike is on the issue). The smoke gate before this work passed on
2026-10-20: the tool ran under a throwaway LaunchAgent, and `launchctl kickstart -k
user/<uid>/com.apple.CoreDevice.CoreDeviceService` restarted CoreDeviceService (see
[acceptance](../acceptance.md)). What the gate did not cover (the lab's own agent, over SSH,
the whole `lab up`) is acceptance items 24 and 28.

## Decision

- **Wi-Fi always goes through the tunnel; usbmux is the cable only.** `phoneStatus` reads a
  USB entry in usbmux as the cable (`via: usbmux`); otherwise a phone CoreDevice lists on
  the network that answers `lockState` is Wi-Fi (`via: tunnel`). usbmux's own "Network"
  entries are ignored. The Private Wi-Fi Address diagnosis is gone.
- **One process holds the tunnel: a user LaunchAgent, `com.dividedby.msl-tunnel`.** Lab
  commands are short-lived, and remotepairingd and CoreDeviceService are per-user services
  that a detached child of an SSH command may not reach; a LaunchAgent in `gui/<uid>` can.
  `lab service install` writes it (no `RunAtLoad`, no `KeepAlive`: idle until started with
  `launchctl kickstart`, ended with `launchctl kill TERM`). It runs `bin/lab-tunnel-host`
  (`lib/tunnel-host.js`): it starts the tool (argument list, no `--udid`, stdin from
  `/dev/null`), requires the first line to be `fd... <port>` within 30 s, asks `remote
  rsd-info` and refuses any device whose `UniqueDeviceID` is not the saved phone's (without
  `--udid` the tool can pick an Apple TV), serves the tunnel registry on `127.0.0.1`, and
  records `tunnel.json` (0600, atomic). It watches the tool and three TCP checks of the RSD
  port, and on any end (or SIGTERM) stops the phone's WebDriverAgent and the registry,
  restores the registry key and records `down` with a reason.
- **An exception to the saved-UDID rule, and its substitute.** The lab otherwise passes the saved
  phone UDID to every device command ([CLAUDE.md](../../CLAUDE.md)). `pymobiledevice3 remote
  start-tunnel` is run without `--udid`: remotepairingd knows the phone by an id of its own, not
  the UDID. Instead the lab never trusts the device the
  tool happened to reach: `rsd-info`'s `UniqueDeviceID` must equal the saved UDID, or the tool is
  killed and the tunnel refused (`wrong-device`). Every other device command (`devicectl`,
  `xcodebuild`, Appium) still carries the saved UDID.
- **The registry is remotexpc's, imported from the lab's own Appium install** by file URL (its
  package exports only `.`): no new dependency, but it ties the host to appium-xcuitest-driver
  12.18.1's layout. It writes the `tunnelRegistryPort` key in `@appium/strongbox`
  unconditionally, so the host reads the old value first and puts it back only while the key
  is still its own; a live foreign registry is refused (`registry-busy`).
- **The lab starts WebDriverAgent itself over Wi-Fi.** Appium's own launch checks the device
  through usbmux. `launchWda` stops an old one, builds it when the device derived data has no
  xctestrun (xcodebuild arguments as appium-webdriveragent's, from the saved team and bundle
  id), then starts `xcodebuild test-without-building` detached with `USE_IP` set to the tunnel
  address, and polls `/status` for up to 120 s. Appium gets `appium:webDriverAgentUrl` and
  `appium:wdaBindingIP` for that address, `appium:platformVersion`, and none of the build and
  signing capabilities. The session create order is: tunnel, the lab's own tab, WebDriverAgent,
  `POST /session`. The session records `transport: {via, address}`.
- **The lab restarts CoreDeviceService itself when it is stuck** (owner's decision): `lockState`
  timing out while the device list says the tunnel is connecting, or the tool silent for 30 s.
  Only inside a lab command under the lease, once per command, never from the host or the
  idle stop, with `launchctl kickstart -k` (else SIGTERM then SIGKILL to the pid launchd shows,
  after its command line is checked) and a report in the step. Xcode's and `devicectl`'s
  connections drop briefly; a second failure is `needs: tunnel`.
- **The tunnel lives for a lab-up window.** It is reused across `safari stop` and
  `safari start`; `lab down` (also with `--keep-service`), `lab down --idle` and choosing the
  cable stop it (a `tunnel` step right after `wda`), and the idle stop counts a live one as
  running. `lab tunnel up|down|status` do it by hand.
- **pymobiledevice3 is the latest release, not an exact pin** (owner's decision), with 11.23.0
  as the floor checked at each start; the version is reported by `sim doctor` and
  `lab status`. It is found in `uv tool dir --bin`, else `~/.local/bin`, never on `PATH`.
- **The lab refuses to run as root** everywhere (`MSL_ALLOW_ROOT=1` exists for the test suite
  only, because cloud sessions run as root).

## Alternatives rejected

- **`remote tunneld`** (a resident daemon with an HTTP API, run as root): a root-owned process
  and a listener, against the lab's rules.
- **Wi-Fi through usbmux, kept as it was**: needs Private Wi-Fi Address Off, lapses after
  sleep, and loopback-only WebDriverAgent may not be reachable through it.
- **Letting Appium start WebDriverAgent over the tunnel**: its launch goes through usbmux and
  would need the registry to be right for the cable too.
- **A tunnel the owner starts by hand and the lab leaves up**: nothing would end it; the idle
  stop and `lab down` end the lab's.
- **Our own RSD client** instead of `rsd-info`: more code for the same answer.

## Consequences

- No cable and no Private Wi-Fi Address setting for Wi-Fi; the phone must be unlocked, awake and
  on the Mac's network. Away from that network is not supported.
- A third LaunchAgent, idle until used, and a root-free dependency on a tool the lab does not
  ship (`needs: tunnel-tool` when missing or older than 11.23.0).
- Local exposure while the tunnel is up is about that of usbmux over a cable: other programs
  on the Mac can reach the phone's services through the `utun` interface and the registry
  tells them where. The tool opens no listener; the registry listens on `127.0.0.1` only;
  WebDriverAgent binds the tunnel address only. The idle stop bounds the time.
- Known risks: the registry import is tied to xcuitest 12.18.1 (the host fails with a clear
  error and `lab tunnel status` shows the path); a newer pymobiledevice3 may change its output
  (the first line and the `rsd-info` shape are checked, the version is reported); restarting
  CoreDeviceService interrupts Xcode's connections for a moment.
- Tests use a fake `pymobiledevice3` (`test/fixtures/fake-pmd3`, driven by `FAKE_MODE`), recorded
  launchd and `xcodebuild` commands, a stand-in for `/status`, and a temporary HOME. The live
  checks are items 24 to 36 of the iPhone acceptance list in [acceptance](../acceptance.md).

## Note, 2026-10-23: the tool takes `--udid`

With an Apple TV on the network, `pymobiledevice3 remote start-tunnel --native`
run without `--udid` opened the tunnel to the Apple TV, and the host refused it (`wrong-device`)
three times in a row: correct, but Wi-Fi was unusable while the Apple TV was around. The tool
(11.40.2) takes `--udid` with `--native`, and with the saved phone UDID it opened the phone's
tunnel. The host now passes `--udid <saved phone UDID>`; the `rsd-info` check stays as a
backstop, so the "exception to the saved-UDID rule" above no longer applies. The floor is
raised from 11.23.0 to 11.40.2, the lowest version verified to take `--udid` with `--native`
(an older tool is `needs: tunnel-tool`). The text above is left as it was decided.

## Note, 2026-10-29: `rsd-info --native`, not `--rsd` (issue 111)

From iOS 27.2 (24B119) every Wi-Fi `lab up` failed at the check (`rsd-failed: ConnectionRefusedError`).
`remote rsd-info --rsd <address> <port>` handshakes with pymobiledevice3's host-id UUID, while the
native tunnel's connection uses remoted's. On iOS 27.2 a handshake with a different UUID makes the
phone re-attach and close every service listener on the tunnel, the check's own included, and they
stay closed. The host now runs `remote rsd-info --native` with `PYMOBILEDEVICE3_UDID=<saved phone
UDID>` (`rsd-info` takes no `--udid`). It rides the same remoted tunnel as `start-tunnel --native`,
handshakes with remoted's UUID (no re-attach), and returns the same `UniqueDeviceID`, version and
service ports (85 of 85 equal to the tunnel's own on the phone). The floor stays 11.40.2, which has
`--native` on `rsd-info`.

Measured on the phone over Wi-Fi with the native tunnel held: the old `--rsd` check closed every
listener; `rsd-info --native`, a userspace `rsd-info` and ten plain TCP connects to the RSD port
(the watch's probe) closed none, and `devicectl` kept the phone after each. Then `lab up --target
device` came up in 30 s and the page commands worked over it.

Rejected:
- **Waiting for `start-tunnel --native --format json`** (doronz88/pymobiledevice3#2140, the record
  from the tunnel's own connection): no second connection at all, but it needs an upstream release,
  and the maintainer pointed to the existing commands.
- **The default userspace `rsd-info`** (its own tunnel, chosen by `PYMOBILEDEVICE3_UDID`): harmless
  beside the native tunnel, but its service ports are its own tunnel's (none equal the native
  tunnel's), so the registry's catalog would be wrong, and on Wi-Fi it needs usbmux's "Network"
  listing, the route this ADR left.
- **`remotectl dumpstate`** (remoted's view, no connection): has the UDID, the version and the
  `utun` interface, but no service ports.
- **Dropping the check**: loses the device check and the catalog.

`rsd-info --native` still opens a second RSD connection from the Mac, which on the native tunnel
replaces remoted's (the device keeps one per host address; remoted redials). It happens once per
tunnel start, as `start-tunnel --native` itself already does.

## Note, 2026-10-30: `--rsd` fixed upstream in 11.49.0

pymobiledevice3 11.49.0 (doronz88/pymobiledevice3#2155) makes `--rsd` present remoted's UUID when
the address is on remoted's tunnel, so the re-attach above no longer happens with `--rsd` either.
The lab keeps `rsd-info --native`: it works from the 11.40.2 floor, so the floor does not move.
Checked live on the phone over Wi-Fi (iOS 27.2) with 11.49.0 on 2026-10-30: `lab up --target
device` in 48 s, then `eval`, an awaited `fetch` and `shot --page`.
