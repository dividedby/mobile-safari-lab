# 0008: The lab borrows a slot from sideload when the phone has no room, and gives it back

Date: 2026-10-24 · Status: accepted (built, and run live on 2026-10-25: acceptance item 41) · Builds on [0007](0007-phone-settings-restore-ledger.md) (the ledger rules) and [0006](0006-wifi-tunnel.md) · Issue 63

## Context

The lab and sideload (another tool of the owner's) sign apps with the same free Apple account. A free account holds
three apps on a phone. sideload's apps may fill all three, and then the lab's WebDriverAgent runner
(`<bundle id>.xctrunner`) has no room: `lab up --target device` stops with `needs: slots`. The signing lock
(`lib/signlock.js`) already keeps the two from signing at once; it does not make room.

sideload's side of the agreement is a pair of commands: `sideload slot lend --udid <UDID> --to lab` uninstalls one
app it names as lendable (Stremio) and records the loan; `sideload slot return --udid <UDID>` reinstalls it. Both
print one JSON envelope, take sideload's own operation lock, and are safe to repeat (`alreadyLent`, `nothingLent`).

One fact shapes the design: **`slot lend` does not check that the phone is full.** It would uninstall the
lendable app whenever it is asked, even when WebDriverAgent would have fitted. So the question "does it fit?" is not
sideload's to answer here, and the lab does not count apps itself (that would copy sideload's count rule and the
limit 3, and a miscount evicts the owner's app for nothing). The authority is installd: the lab installs the runner
it already built, and only an installd refusal with its free-app limit leads to a lend. (sideload confirmed on issue 63 that the
missing check is intended and that any later precondition will be opt-in.)

## Decision

- **Two device mutations, both the lab's own runner.** Install of the built runner (the lend step; the lab builds it first when
  there is no build) and uninstall of
  `<saved bundle id>.xctrunner` (the return). The uninstall refuses any id that is not that one and any id under
  `io.github.dividedby.free.*` (sideload's apps). Every device command passes the saved phone's UDID; sideload is called
  with `--udid`, never its `--device` alias.
- **A record of the lab's claim, `state.slotLend`** (`lib/slot-lend.js`), modelled on the restore ledger of 0007:
  `{udid, phase, at, bin, home, since?, app?, device?, retryAt?, returnFailed?}` with phases `lending` (written before
  `slot lend` runs), `lent` (sideload said yes) and `returning` (written before the runner is uninstalled). Intent
  first, so a crash leaves a record. The record only says "I may hold a slot": **sideload's answers are the authority**.
  The lab never resolves a phase by reading the phone or `sideload status`; only a `slot lend` or `slot return` answer
  does. The record is cleared only when `slot return` says `reinstalled`, `alreadyPresent` or `nothingLent` (`settled`
  is not required).
- **`bin` and `home` are in the record.** The idle stop runs under launchd, whose `PATH` has neither `~/.local/bin` nor
  `/opt/homebrew/bin`, and a different `SIDELOAD_HOME` would make `slot return` answer `nothingLent`, which would clear
  the record and strand the owner's app. Every slot call passes `SIDELOAD_HOME=<record.home>` and runs `record.bin`.
  Resolution: `MSL_SIDELOAD_BIN` (absolute, executable; wrong is refused, never replaced) > the record > `PATH`.
- **Never hold the signing lock across a slot call.** The lab takes the lock around its own install and releases it
  before it calls sideload, which takes it itself.
- **What each code means is data** (`lib/sideload.js`): busy (retry later: `SLOT_PENDING`, `OPERATION_IN_PROGRESS`, the
  uncertain results, `TIMEOUT`, `INTERRUPTED`, `SNAPSHOT_FAILED`, and the lab's own timeout or unreadable output),
  the phone (`DEVICE_LOCKED`, `DEVICE_NOT_CONNECTED`, `DEVICE_NOT_PAIRED`), the free-account limit, definite failures
  that are safe to retry, and owner actions (everything else, including codes not listed yet). A timeout or an answer
  the lab cannot read is **unknown**, not failed: the record keeps its intent phase and the next call decides. Time limits are
  named constants (`SLOT_WAIT`: 15 min lend, 20 min return, plus a 2 min margin for the data backup sideload is adding;
  SIGTERM, then SIGKILL after 30 s so sideload can print `INTERRUPTED`).
- **The lend step** (`ensureWdaSlot`, the `slot` step of `lab up`; a new phone session only). After `phone` and the early look
  at the signing lock, before the phone settings, the tunnel, Lab Focus and the session, so a stop opens nothing on the phone.
  One bounded listing of the runner's bundle id (`devicectl device info apps --bundle-id`; an unreadable listing lends
  nothing and the session goes on). Present: nothing more. Missing: under the signing lock the lab builds if needed
  (`buildWda`, shared with the Wi-Fi launch), checks the build's bundle id is the saved phone's `.xctrunner`, installs it, and
  releases the lock. Accepted: it fit, nothing is borrowed. Refused with installd's free-app limit (`isAppLimit`: never the
  App-ID-per-week limit): the record `lending` is written, `slot lend --udid <saved> --to lab` runs **with the lock released**,
  the record becomes `lent`, and the runner is installed again. `freed:1` or `alreadyLent` is a lend; any other ok answer is
  not trusted. Every failure is data (`LEND_MAP`, `lendOutcome`): the intent the lab wrote this run is dropped when nothing
  changed, kept when the outcome is unknown; `busy` carries the `retryAt`; owner actions are `needs: slots` with sideload's fix
  last. A phone `lab up` **reuses a held lend** (a record in `lent` with the runner on the phone changes nothing); a record in
  `lending` or `returning` with the runner on the phone, or one that fits again, is settled with one `slot return` call (never
  an uninstall): `FREE_APP_LIMIT` means the lend stands (`lent`), `reinstalled`/`alreadyPresent`/`nothingLent` clear it. A
  simulator `lab up` gives a stale lend back under the same condition as `lab down`.
- **The return** (`returnSlot`): record for another phone, or no phone: no device call, a person returns it by hand;
  a device session is open: nothing; sideload's retry time or an unanswered owner action: not tried (the idle stop only);
  binary found first; phone unlocked and reachable (never a passcode prompt at an unattended Mac); then `returning` is
  written, WebDriverAgent is stopped and uninstalled and checked gone, and `slot return` runs. The idle stop renews its
  lease before the uninstall and before the call, and stops when `lab up --force` took the lab over.
- **When it goes back.** The idle stop, every tick while a record exists. `lab down`, when the idle stop is not
  installed and loaded or a return had started. By hand with `lab phone slot return`. Never a failure of `down` or of the
  idle stop (it does not count toward the three failures); the idle stop says a failure once (keyed on code and cause).
  `lab phone slot forget` drops the record without touching anything; `lab phone forget` and `setup` for another
  phone are refused while one exists, because the return needs the saved phone.

## Consequences

- The record can outlive a phone that is gone; the escape is `lab phone slot forget` after returning by hand, and the
  messages say so.
- `lab up --target device` reuses a held lend instead of returning it first (two Stremio round trips otherwise). That narrows
  "retry at the next unlocked `lab up`" to runs that are not on the phone (the owner agreed). The `slot` step can take about
  17 minutes for the lend (its wait plus a margin for the data backup), plus the WebDriverAgent build (first time) and up to two installs, so a device `lab up` is no longer bounded by the session
  create alone.
- The listing costs one `devicectl` call (a second or two) on every new phone session. The probe install is a new device
  mutation; on the cable path Appium must reuse the lab-built derived data (it should build incrementally).
- State writes stay read-merge-write without a lock, as elsewhere; the windows are seconds, and the lease keeps the idle
  stop and `lab up` apart.
- Passed live on 2026-10-25. Acceptance item 41 covers the whole path with the real sideload; the crash matrix (a record left
  in each phase, then the next `lab up`) is covered by `test/slot.test.js` (C1 to C9).
