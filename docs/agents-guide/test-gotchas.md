# Test: gotchas

Detail for step 4 of [AGENTS.md](../../AGENTS.md). The command list and the other notes are in [test.md](test.md).

- **An open `<select>` menu or picker refuses `tap` and `swipe`** ([#23](https://github.com/dividedby/mobile-safari-lab/issues/23)). While a
  `<select>`, or an `<input>` of type `date`, `time`, `datetime-local`, `month`, `week` or `color`, has the focus, iOS shows
  its native menu or picker over the page, and a touch lands on that, not on the page. So `tap` (also `--label`) and `swipe`
  check the page's focused element first (following open shadow roots) and refuse with "has the focus, so its native menu
  or picker is probably open", naming the element by tag, type and `id` or `name`; nothing is sent. To choose an option, use
  `safari select` (below), which also blurs the `<select>`; otherwise `safari refresh` closes it (the page reloads, so
  its state is lost). `click` is a script click and isn't checked. The check reads the page only, so a menu whose
  element a script has already blurred isn't caught. `safari open` to an address that differs only by its `#fragment` doesn't
  load a new page, so it doesn't close a menu either. Checked on the iPhone (iOS 27.2, 2026-11-11): a tap with a `<select>`'s
  menu open is refused, and once a person picks an option iOS takes the focus off the `<select>`, so the next tap goes through. Pickers and a `<select>` in a shadow root have only run with stand-ins.
- **A system sheet over the page is `needs: sheet`** ([#26](https://github.com/dividedby/mobile-safari-lab/issues/26)). When the
  page opens one (`navigator.share` brings up the Share sheet), `tap`, `swipe` and `shot --page` / `--element` are refused
  with `needs: "sheet"`. The output's `sheet` is the bar the lab took for it: on the iPhone (iOS 27.2, portrait) that is the dimmed area above the sheet's card, from the top of the screen to the card's top edge. Close it with `safari dismiss`: it taps
  once in that dimmed area (halfway between the page's top and the card), which closes it (checked on the iPhone, iOS 27.2,
  2026-11-11: the Share sheet closed with the tap, and the page got no click), and if the sheet is still there drags it down from just inside the card's top edge, looking again after each; `dismissed: true` with
  `via: "tap-outside"` or `"swipe"` (the drag hasn't been needed on the phone yet), or `needs: "sheet"` if it is still there, and then the owner closes it on the phone
  (relay the `human` step). It reads no label and touches nothing in the sheet's card but the drag, and it refuses when
  no sheet is open, the phone is in landscape (not seen yet), or the bar reaches near the screen's bottom (no card below it to read). `safari dismiss --dry-run`
  reports the `tap` and the `drag` (geometry only) and sends no touch: run it first on a sheet the lab hasn't closed
  before. `click` is a script click and isn't
  checked. Checked on the iPhone (iOS 27.2, 2026-11-11): the Share sheet is caught; `safari refresh` does not close it
  (the page reloads under it), and `lab down` with it still up can't close the lab's tab, so it blanks the tab and asks
  the owner to close it: dismiss the sheet before `lab down`.
- **`safari select <css> --option <text> | --value <v> | --index <n>`** ([#24](https://github.com/dividedby/mobile-safari-lab/issues/24))
  chooses one option of a `<select>` with a page script, on both targets: it sets the index, then sends `input` and
  `change` (bubbling), as a person's choice does. It does not use the native picker, so it tests the page's handling of
  the choice, not the picker itself. `--option` matches the option's visible text exactly (whitespace collapsed), `--value`
  its value exactly (`""` too), and `--index` counts from 0 like `selectedIndex` (unlike `--nth`, from 1). The `<select>` is
  found with the selectors of `click`; give it by css (`#race`, `select[name=race]`), since its visible text, which
  `--text` matches, is all its options' text run together. Output: `selected`, `matches`, the option's `index`, `text` and `value`, and `changed`
  (`false` when it was already chosen: then no events are sent, as when a person picks it again). A `<select>` that had the
  focus is blurred afterwards (`blurred: true`, and `stillFocused` says whether the focus left); on the iPhone that
  closes its native menu (checked on iOS 27.2). The open menu's options are not in the web view (`safari ui` doesn't list
  them, and `tap --label` looks only in the web view), so use `safari select` to choose one. Refused, with nothing changed: a target that
  isn't a `<select>`, `<select multiple>` (set it with `safari eval`), a disabled `<select>` or option (or one in a disabled
  `<optgroup>`), and no option or several matching (with the count). Custom dropdowns built from other elements: use `tap`.
- **`safari appearance` and `safari orientation` change the owner's phone** (iPhone only; through `devicectl`, so no
  page or tab is involved, and a simulator session is refused: use `sim appearance` there). The lab writes the old value
  down first (the restore ledger, [ADR 0007](../adr/0007-phone-settings-restore-ledger.md)) and puts it back at `safari stop`, `lab down`, the idle stop and, after a crash, the next
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
- **Use `wait`, not `sleep`.** `open` returns when the document is complete, which can be before the
  page has drawn: `safari wait '.card' --visible` waits for an element, `safari wait --settled` for
  the page to stop loading and changing (nothing loaded, changed or resized for `--quiet` ms, 500
  by default), and `open`/`refresh` take `--wait-for <css>` and `--settle`. Run `wait --settled`
  before a `shot`. `--visible` means rendered (not `display: none`, `visibility: hidden` or
  `opacity: 0`, at least 2 by 2 px; covered or off-screen still counts); `--gone` means none is
  visible, removed or hidden. `--timeout` is 10000 ms by default (100 to 60000). A timeout is
  `ok: false` with counts, not a `needs`; a page that animates or polls constantly never settles,
  so use `wait <css>` for it. It reads the page only, with no screen checks.
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
- **Testing Back:** use `safari back`, not `eval 'history.back()'`: it refuses when there is nothing to go back to, waits until
  the page has changed and reports `url`, so the next read can't show the page it left. **On the phone `open` adds no history:**
  it replaces the lab's page, so `history.length` stays 1 and `history.back()` silently does nothing. Build the history with real
  taps (`safari tap <css> --navigates`). The lab can only close a tab with one history entry, so after this `lab down` blanks the
  tab instead, and its `human` step asks the owner to close it by hand: relay that. On the simulator `open` does add history.
- Injected scripts start after load and only provide `GM_info`; they are lost on every navigation
  and refresh. State this limit in your report; if timing matters, say it needs a real-device check.
- The owner's Safari extensions, the Userscripts app's scripts included, can run in the lab's tab on the
  phone and change what you see. Installed scripts ran there on iOS 27.2 over Wi-Fi, including at
  `document-start` (2026-11-01, [issue #8](https://github.com/dividedby/mobile-safari-lab/issues/8)). They did not in one earlier run (iOS 27.0.1, cable, 2026-10-27,
  issue 102); the app wasn't loading scripts in any tab that day, the likely cause, though cable and
  that iOS version weren't ruled out. If an installed script doesn't run, have the owner check the app first.
  The installed copy is the way to test `document-start`; `safari inject` runs after load. A script
  that redirects needs `--allow-host` for the hosts it goes to, or it taints the run.
- `inject` right after a navigation may run in the outgoing page and do nothing (seen once, not
  reproduced). `inject` watches for half a second afterwards and says so (`pageChanged: true` and a
  `warning`) when the page showing is no longer the document the script ran in; then run it again,
  unless the script navigates by itself. Waiting for the page first (`safari wait <css>`, or
  `open --wait-for`) avoids it (issue 102).
