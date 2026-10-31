# 0009: The lab follows its tab to hosts the session names, and refuses every other site

Date: 2026-10-28 · Status: accepted (built; tests only, not run live) · Builds on [0005](0005-physical-iphone-via-appium.md) (the tab guard) · Issue 101

## Context

The tab guard (0005) checks a marker in `window.name` and the tab's origin before every page command. A site that sends
its own tab on to another host (a login, a short link, a script) clears the marker and changes the origin, and the
next command taints the run: the owner's flow cannot be tested past the redirect. Loosening the check for every site
would let the lab read and mark a page it was never sent to.

## Decision

- **The session names the hosts.** `safari start --allow-host <host>` (repeatable; `lab up` passes it through), at most 10,
  kept as `deviceTab.allowHosts`. A host is `host[:port]` as `new URL` writes it, matched exactly, `https` and `http`
  both, no wildcards and no `www` twin. A reused session takes the union and never loses a host. A taint drops the
  list, and the refusal names it so the next session can name the hosts again.
- **The guard asks one yes/no question.** With a list the guard script answers `3` (not `0` or `2`) when the marker is
  gone or the origin changed and `location.origin` is one of the allowed origins; it reads and writes nothing else.
  With no list the script is byte for byte what it was.
- **The marker goes back only through the existing path.** On `3` the lab runs `plantAfterNav` (select, read-only
  probe, mark tied to the probed document's `timeOrigin`, the context checked after each script, one move waited
  out) with the allowed origins as the expected set. A page that is on any other origin by the probe or the mark
  taints, and nothing is written into it. A document still loading is waited for; one that never completes in
  `WAIT.timeoutMs` is an untainted `needs: tab` ("run the command again").
- **The command runs once more, strictly.** After the mark the lab records the origin (`origin`, `origins`, so
  `network` admits it), reinstalls its console and network collectors (no userscript is injected again) and re-runs the
  command with the unchanged guard script, so a second move taints.
- **It is reported.** `followed: [<origins>]` in the output (a refusal too) and a `safari follow:` line in `run.log`.
  `open` and `refresh` also accept a redirect to an allowed host.

## Consequences

- The owner navigating the lab's tab to an allowed host by hand is followed as well: the lab cannot tell that from the
  page's own navigation. Documented, not prevented.
- An allowed host is trusted with the tab: the lab's commands run scripts in its pages like in any page of the session. The owner chooses them.
- The guard's yes/no check, the probe and the mark run in the page, so a page on another site can try to answer for them.
  No origin test in a script the lab sends into a page calls a method of a prototype the page can patch
  (`Array.prototype.includes` was one): each is `location.origin === "<origin>" || ...`, built from the list. A page on a
  site that is not allowed therefore cannot get `3` from the guard, and is tainted with no probe and no mark sent. This
  also hardens the probe and the mark that `open` and `refresh` use. A page that forges the answers themselves (the
  stand-in tests do) can make the lab send it the read-only probe and the mark, but the mark's own origin test is native,
  so it writes nothing; the forged answer is checked in Node (it can only name an allowed origin), and the strict
  re-run of the guard then finds no marker and taints. A forged origin can end up recorded as the last site in the
  tainted record, and nothing else.
- The simulator has no tab guard: the hosts are not stored and the output says so.
- Closing the stale tab after a taint, and the `open` that timed out in the same report, are separate issues.
