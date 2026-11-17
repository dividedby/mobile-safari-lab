# Finish

Detail for step 5 of [AGENTS.md](../../AGENTS.md).

1. **`lab down` when the work is over**, always. It closes the lab's tab (phone) or shuts the
   simulator down, ends the session, stops Appium and WebDriverAgent (and the Wi-Fi tunnel: step `tunnel`, also with `--keep-service`), and releases the lease so the
   next agent isn't kept waiting. If it says `ok: false`, run it again; the lease is kept for a retry.
   On the phone this is also the battery rule: the phone stays awake while a lab session runs
   and only locks normally after `lab down`.
   On the phone it also sets the owner's Auto-Correction and Predictive back on (WebDriverAgent turns
   them off for the whole phone while a session runs); the output says `keyboardRestored`. If that is
   `false`, relay its `human` step (turn them on in Settings > General > Keyboard); the teardown still finished.
   `keyboardNote` says why a restore failed (in the JSON, not on stderr).
   If you changed the phone's appearance or orientation, `lab down` puts them back too (a `phone-settings` step when a
   record was left behind) and says `phoneRestored`; see [test-gotchas.md](test-gotchas.md). The same goes for Lab Focus: `lab down` runs the owner's
   "Lab Focus Off" shortcut (the Shortcuts app is then in front on the phone), unless the phone is locked: then the record is kept.
2. For a short break use `safari stop` instead: it ends the session, closes the tab and releases the
   lease, but leaves Appium (and the simulator) warm. A lab on which no command that takes, renews or releases the lease has run for 15 minutes (`sim shot` and `sim ui` count; `lab status` doesn't) is stopped by
   the **idle stop** (a LaunchAgent `lab service install` adds): it does what `lab down` does, so
   a break longer than 15 minutes ends in a cold `lab up`. `lab status` shows `idleStop` (the last stop,
   and `tabLeft` with a `human` step if the phone could not be reached; `heldUntil` and `nextStop` say when it will next act). It is a safety net, not
   a reason to skip `lab down`.
   If you hand the simulator to the person to use by hand (they sign in, look around), run
   `lab hold` first (`--minutes N`, 1 to 120, default 60): the idle stop leaves the lab alone until then,
   even though nothing runs a lab command. It takes no lease, so it never blocks another agent; `lab down`
   or a fresh boot of the simulator ends it. It is refused when nothing the lab started is running.
3. **Stop every server you started** yourself (a dev server for the page, say), and clean up
   whatever the project's rules require. `lab down` never stops a server it didn't start.
4. In your report, say what ran on which target, what didn't, and what still needs a check on the
   other one.

If a command is interrupted (`interrupted` in its output, exit 130, 143 or 129), nothing is torn
down: the session, Appium and the lease are kept. Run `lab status` first. On the phone, **a page
command that was already sent may still finish in the lab's tab** (`sessionKept: true`; `tainted`
says whether the run still trusts the tab): check the page before you repeat a click or a type.
An interrupted `safari stop` or `lab down` keeps the session record (and `lab down` the lease, with
no later step run) unless the session was already deleted: run it again to finish.
