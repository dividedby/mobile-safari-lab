# 0007: Phone settings the lab changes are put back from a ledger

Date: 2026-10-23 · Status: accepted · Extends the keyboard restore of [0005](0005-physical-iphone-via-appium.md) (that one keeps its own mark) · Builds on [0004](0004-lab-down.md) · Issue 27; Lab Focus (issue 16) is the second user of it (see the addendum at the end)

## Context

The phone is the owner's daily phone. issue 27 asks for
light and dark mode and portrait and landscape on it, to test a dark-mode userscript or a landscape layout on
the real device. Both are settings the owner sees: a lab that leaves the phone dark or sideways after a run, or
after a crash, has done harm.

The one earlier precedent is the keyboard (0005): WebDriverAgent turns Auto-Correction and Predictive off, the
lab sets them back through the live WebDriverAgent session, and with no session it only tells a person what to
do. That is too weak here ("put back exactly, also after crashes"), so the new settings need a restore that
does not depend on a session.

The live spike of 2026-10-23 (iPhone, iOS 27.0.1, over Wi-Fi, Xcode 27 `devicectl` 642.16) settled the mechanism:

- `devicectl device info appearance` and `settings appearance --mode light|dark` work without any
  WebDriverAgent session, and an open Safari page's `prefers-color-scheme` followed at once, with no reload. The
  output has `userInterfaceStyle` ("light" or "dark") and no field for **Automatic** appearance, which the owner
  uses. After light to dark and back the owner saw Automatic still on.
- `devicectl device orientation get|set` works: `get` gives `deviceOrientation`, `deviceOrientationNonFlat`
  and `deviceIsOrientationLocked`. A phone lying on a desk reads `faceUp`; `set faceUp` alone left Safari in
  landscape, while `set portrait` and then `set faceUp` put the interface and the reading back.
- With **Portrait Orientation Lock** on, `orientation set` exits 0 and changes nothing, and
  `deviceIsOrientationLocked` still reads false.

## Decision

- **Mechanism: `devicectl`, argument lists only.** Every call is `xcrun devicectl ... --device <saved
  UDID> --json-output <file>`, bounded (20 s), the JSON parsed from the file the way the rest of
  `lib/phone.js` does. `settings appearance` is given `--mode` only, because it can also change text
  size, contrast and the Liquid Glass look. The WebDriverAgent route (`mobile: setAppearance`, which falls back
  to a Siri command when the WDA call throws) is not used. Phone only: a simulator session is refused with a
  message; `sim appearance` is unchanged.
- **A ledger, `state.phoneRestore`** (`lib/phone-restore.js`): `{udid, appearance?: {prior, set, at},
  orientation?: {prior: {deviceOrientation, nonFlat}, set, at}}`, validated like the saved phone (a damaged
  record names `lab phone restore --forget`). Its rules, each of them a test:
  1. **The entry is written before the change is sent**, so a crash between the two restores to a value the
     phone already had.
  2. **The prior is read first**; if it cannot be read the change is refused ("won't change what it can't put
     back"). A flat phone that gave no upright reading is refused for the same reason.
  3. **An entry that is already there keeps its `prior`**: the value now on the phone is the lab's own
     leftover, not the owner's.
  4. **A value is put back only if the phone still shows what the lab set.** If the owner changed it by hand the
     lab leaves it and reports `ownerChanged: true`.
  5. **An entry is cleared only after the phone reads back the value that was put back.** A failure keeps the
     entry and adds a `human` step.
  6. **Every call passes the saved phone's UDID**, and an entry for another phone is refused.
- **Restore triggers.** `safari stop` (in `endDeviceSession`, next to the keyboard restore); `lab down` (the
  same, and a `phone-settings` step after `session` when a record is left behind: a crash, or a stop that could
  not reach the phone), which the idle stop runs too; the start of the next `lab up` that creates a new
  session (before it records new priors; a live session's changes are in use and are left alone);
  `lab phone restore` by hand (it takes the lease check of the other lab commands: another owner's live lease
  refuses it). `lab status` lists what is pending (`phone.pendingRestore`, names only);
  `lab phone restore --forget` drops a record whose phone is gone or that is damaged, without touching the
  phone. A locked or unreachable phone is not a failure of `stop`, `down` or `up`: the output says
  `phoneRestored: false` with a `human` step, the entry stays, and the next trigger retries. After the first call
  that finds the phone out of reach, the other kinds are not tried (one wait, not one per kind). An interrupt
  leaves the entry.
- **Automatic appearance cannot be seen**, so appearance restore sets back the mode the phone showed (light or
  dark) and always reports `restoredExactly: false` with a note; the lab never says Automatic was kept.
  Asking for the mode the phone already shows sends and records nothing.
- **Orientation restore order.** Set the prior upright orientation first (`portraitUpsideDown` becomes
  `portrait`, the interface orientation, and the result says `restoredExactly: false`), then the prior flat
  reading (`faceUp` or `faceDown`) if the phone was lying flat. Confirmation compares against what that
  sequence should read, not the raw prior.
- **Every set is read back** (at most three readings, 1 s apart), when changing and when putting back. For
  orientation, a reading still equal to the one before the set means the phone ignored it: "Portrait
  Orientation Lock is probably on", with a step to turn it off. A change reports `ok: false` and drops an entry
  the command created; a restore keeps its entry and says to run `lab phone restore` after turning the lock off.
  `deviceIsOrientationLocked` is not trusted.
- **Where it is used.** `safari appearance light|dark|restore|status`, `safari orientation
  portrait|landscape|restore|status` (landscape is `landscapeLeft`) and `lab up --appearance --orientation`
  (applied after the session exists). They take the lease like every `safari` command and need an open
  session, although `devicectl` itself does not.

## Alternatives rejected

- **WebDriverAgent through Appium** (`mobile: getAppearance/setAppearance`, session orientation): needs a live
  session, so no restore after a crash; the setter's Siri fallback is unacceptable; WDA orientation cannot say
  `faceUp`.
- **pymobiledevice3**: no appearance setter, and its orientation reading is read-only.
- **Driving the Settings app**: fragile, and it drives the owner's UI.
- **Extending the keyboard mark** (`keyboardPending`) to these settings: a boolean cannot carry a prior value,
  and it restores through a live session.
- **A "remembered" prior that is re-read at each change** (no rule 3): after a crash it would record the lab's
  own leftover as the owner's.

## Consequences

- A phone changed by the lab is put back after a normal stop, an idle stop, and a crash (at the next
  `lab up`, `lab down` or `lab phone restore`), except where a person must act: a phone that stays locked, which
  the output says.
- Appearance restore is not exact for an owner on Automatic, by design and in every output. If the live check
  ever shows Automatic turning off, the restore must say so loudly or stop restoring appearance.
- Orientation is not a persistent setting (the accelerometer rules), so "restore" means setting the prior
  reading again; an upside-down phone comes back upright.
- The tools are Xcode 27's: an older `devicectl` fails with output the lab reports as unrecognised.
- Landscape is untested for `safari shot --page`, `tap` and `swipe` (the crop trims only the top and
  bottom); the docs say to look at the shot.
- Each kind of setting is one entry in a table (`SETTINGS` in `lib/phone-restore.js`: its values and command words, its
  devicectl read and write, the entry's shape, how it is put back, its messages); the change, restore and status
  code, the record's validation and the `safari` and `lab up` words all read the table.
- The ledger is the place for the next phone setting (Lab Focus, issue 16, is now one): a new kind
  adds its entry shape, its read, its set and its restore, and gets the triggers and the rules for free. The
  keyboard may move onto it later; it keeps its own mark for now.

## Addendum: Lab Focus (issue 16), 2026-10-24

Lab Focus is the `focus` kind in the table. It differs from appearance and orientation in one way that matters: **the
phone's state cannot be read.** `devicectl` has no Focus command, so the lab runs two owner-made Shortcuts ("Lab Focus On",
"Lab Focus Off", names configurable) for the owner's own Focus "Lab" through the Shortcuts app:
`xcrun devicectl device process launch --device <saved UDID> --payload-url 'shortcuts://run-shortcut?name=<encoded>'
com.apple.shortcuts` (argument list, bounded at 30 s; the bundle id is `com.apple.shortcuts`, found in the live spike of
2026-10-23: `is.workflow.my.app` is "not installed"). Live-checked then: unlocked, the shortcut turns the Focus on with no
prompt and leaves the Shortcuts app in front.

How the rules read for a kind that cannot be read (`blind: true` in the table):

- **Rule 1 holds**: the entry `{prior: "unknown", set: "on", at}` is written before the shortcut is launched. A launch that
  was refused (not delivered) removes an entry the call created; one that timed out keeps it, since it may have run.
- **Rules 2 and 4 cannot hold**: there is no prior to read and no value to compare, so the lab does not refuse the change and
  does not notice an owner who turned the Focus off or on by hand. The prior is *assumed* off: the restore runs Off and
  reports `restoredExactly: false` with a note (so it also turns the Focus off if the owner had it on before the run).
- **Rule 5 changes**: there is no read-back, so the entry is cleared when the Off launch was delivered. `devicectl` confirms
  the launch, not the effect (`verified: false` in `lab up`'s `focus` block; the live acceptance checks the effect).
- **Rules 3 and 6 hold unchanged.**
- **A locked phone is never launched onto.** In the spike, `devicectl` reported success on a locked phone while iOS showed a
  passcode prompt and did not run the shortcut (it did not run after unlocking either). The adapter reads `lockState` first
  (one extra bounded call) and returns `needs: unlock` without launching. At the start of `lab up` that is the existing unlock
  handling; at a stop (and the idle stop, 15 minutes later, when the phone has probably locked) the entry is kept and the
  restore is retried by the next unlocked `lab up` (which runs Off before On), `lab down` or `lab phone restore`. No trigger
  ever causes a surprise passcode prompt.
- **Where it is used differs**: there is no `safari focus` command and no `lab up --focus` flag (`command: false` in the
  table). `lab up` on a new phone session applies it by default in a `focus` step after the stale-record restore and the
  tunnel, immediately before the session is created, because the shortcut leaves the Shortcuts app in front and the lab's
  Safari tab (opened by the session start) must be opened after it. `--no-focus` skips it once; `lab phone setup --focus on|off`
  saves the choice; a live session and the simulator never run it. Failure to run the shortcut is not a failure of `lab up`:
  the output has `focus: {applied: false, needs, error}` and a `human` step (`needs: shortcut` has the steps to make the Focus
  and the shortcuts; a locked or unreachable phone keeps its own `needs`).
- The entry carries the Off shortcut's name as saved when On ran (`off`), and the restore runs that one, so renaming the shortcut in `lab phone setup` between On and Off does not strand the Focus. An entry without it (none are expected) uses the current setting.

Rejected for issue 16: a Shortcuts personal automation on the WebDriverAgent runner opening and closing (no prior record, no
restore after a crash or a Mac-side stop, and the runner goes to the background as soon as Safari is activated); driving Control
Center or Settings through WebDriverAgent (the only way to read the prior state, but it drives SpringBoard outside the tab guard);
Siri commands. "Get Current Focus" exists in Shortcuts and could later give a prior-state restore; not used yet.
