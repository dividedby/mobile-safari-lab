# Test: commands and notes

Detail for step 4 of [AGENTS.md](../../AGENTS.md). Read [test-gotchas.md](test-gotchas.md) too: it holds the behaviours that
refuse or mislead (open select menus, system sheets, appearance and orientation, Lab Focus, screenshots, `--storage`,
`--allow-host`, Back, `wait` instead of `sleep`).

```sh
safari open <url>              # waits for the new page to load
safari inject <file.user.js>   # a userscript (runs after load; `--reinject` on open/refresh re-runs it where its @match fits)
safari inject --forget <file>  # drop one recorded file from `--reinject` (runs nothing); `--clear` drops them all
safari eval 'document.title'   # an expression gives its value; several statements need `return`
safari click <css>             # synthetic events (isTrusted false)
safari select <css> --option "House"   # one option of a <select> (also --value v, --index n from 0); a script choice, not the picker
safari tap <css>               # a real touch; brings up the keyboard on a field
safari tap button --text OK    # by exact visible text; --contains, --nth N (1-based), --shadow host inner (open roots)
safari tap --label "Share"     # the one native element in the web view with exactly this label
safari wait <css> [--visible|--gone]   # until the element exists / is rendered / is removed or hidden; same selectors as tap; --timeout ms
safari wait --settled          # until nothing has loaded, changed or resized for --quiet ms (500)
safari tap 'a.next' --navigates # then waits until the page has changed (also on click; --timeout <ms>)
safari back                     # the tab's previous page; waits until the page has changed (--timeout <ms>)
safari keys "text"             # real key presses into the focused page field
safari swipe up                # real scroll (or down)
safari pinch out               # two-finger zoom in on the page (in: zoom out); --at <css> centres it on an element; reports scaleBefore/scaleAfter
safari dismiss                 # close a system sheet (Share) the page opened over the lab's tab
safari appearance light|dark   # iPhone only: the phone's light/dark mode; also `status`, `restore`
safari orientation portrait|landscape   # iPhone only: the screen orientation; also `status`, `restore`
safari shot <name>             # runs/.../<name>.png (a name, not a path; "x.png" is x.png)
safari shot <name> --page      # web content only: no status bar, no toolbar
safari shot <name> --element <css>   # one element; --text, --contains, --nth, --shadow as for tap (--element '*' --text Buy)
safari shot <name> --page --scale 0.5   # shrink: --scale N (0 to 1] or --width <px>; never enlarges
safari console                 # since the last call; then cleared
safari network                 # since the last call; secrets removed
safari source | safari ui | safari url | safari refresh
```

- `keys` (on the simulator and the phone) reports `caseChanged: true` when the keyboard's
  auto-capitalisation changed only the case (`zq` became `Zq`); that is not a failure.
  `textChecked: false` with a `textSkip` reason says the text was not compared (a password field,
  for example). Anything else that differs fails with `ok: false`. After a failed `keys`, never
  assume the text was typed.
- `click` and `type` are synthetic; use `tap` and `keys` when trusted events matter, and say which
  you used.
- `eval` with one expression returns its value. Several statements are a function body, so
  `safari eval 'const a = 1; a + 1'` returns `null`; write `... return a + 1`. A script that throws
  gives `ok: false` with the page's error (it is not a `needs`); one that doesn't parse is refused
  before anything is sent. A Promise (or any thenable) is awaited, for up to `--timeout <ms>` (10 s by
  default, 100 to 60000): the output has its value, `awaited: true` and `awaitedMs`. A rejection is
  `ok: false` with `the Promise rejected: <reason>`; a timeout, or the page changing while it waits, is
  `ok: false` too.
- `click`, `type` and `tap` also take `--text <T> [--contains]`, `--nth <N>` and `--shadow` (put `--`
  before a selector that starts with `--`). `--text` is exact visible text with whitespace
  collapsed (case matters) and picks the innermost match; with more than one match it is refused
  until you add `--nth` (1-based). `--shadow` enters **open** shadow roots only: every argument is
  a selector and the last is the target (`'*'` with `--text` searches a whole root); a host with no
  open root is refused. Output names your selector and `matches`, never the page's text. For `type`,
  `--text` matches visible text (a label or container, not an `<input>`): use a css selector for
  fields. Extra positionals are refused, and a text that is exactly `--text`, `--nth`, `--contains`
  or `--shadow` must come after `--` (`safari type input -- --text`).
- `tap --label "<a11y label>"` is for what the page can't name (a closed shadow root, a canvas). It
  taps the one native element in the web view whose label is exactly that, read from the native
  tree (`safari ui` lists the labels). It looks inside the web view only, never at Safari's tab bar,
  toolbar or address bar, and it does not scroll: a target off the visible page is refused (`safari
swipe` first). It is not combined with css, `--text`, `--nth` or `--shadow`. Raw coordinates
  (`--at x,y`) are deliberately not offered.
- `tap` scrolls an off-screen target into view (`scrollY` can change), reports `focused: true|false`
  for a text field, and adds a `warning` when the target is invisible (opacity 0, hidden,
  `display: none`, under 2 px): the touch was sent but probably focused nothing. Don't `keys` after
  `focused: false`. On a cold simulator on an 8 GB Mac a `tap` can take seconds (6 to 19 s seen; on the phone 0 to 4 s, typically 3 s), not
  the 0.4 s pause the docs mention: that pause leaves out reading Safari's native tree.
- `keys` counts a character as landed when the field's length or text changed, or it got a
  `keydown`/`beforeinput`/`input` event, but events count only while the field has not changed during
  the run (once it has, a press that fires events and adds nothing is sent again). Pages that reset
  their input after each key (minutecryptic.com) therefore pass with `byEvent` and `unverified`
  counts and `textSkip: "unverified"` (when the field is exactly as it was): the text was not seen,
  so check the page. Such a field costs up to about 1.5 s per character (measured on the phone: about 3 s per
  character and 4 s per Backspace there, about 1 s per character on a plain input). A plain field is
  also length-checked at the end: if a character landed only by event and the field is shorter than
  what was sent, `keys` fails ("the field is N characters short"); a longer field is a `warning` when the text is not compared (password, contenteditable); a readable field that the page reformats fails the text comparison ("the keyboard or the page changed the text").
  A field that swallows a key at the start and still fires `keydown` is caught that way; one that
  never changes at all looks like a self-resetting field and reports `ok` with `byEvent`.
- `--reinject` runs again only the injected files whose `@match`/`@include` fit the page it landed
  on (`@exclude` wins; no `@match` means everywhere). The skipped files are in `reinjectSkipped`.
  `safari inject` runs wherever you say and adds a `warning` when the page doesn't fit. Every file
  stays recorded until you drop it, so when two scripts are for the same site (comparing them) and
  more than one re-runs, `open`/`refresh` add a `warning` naming them: drop one with
  `safari inject --forget <file>` (output: `forgotten`, `remaining`; an unrecorded file is `ok: false`
  and lists what is recorded) or all with `safari inject --clear` (`cleared`). Neither runs anything in
  the page, and both take no other word (`--forget` exactly one file, `--clear` none).
- `--help`, `-h` and `help [command]` on `safari`, `sim` and `lab` print the usage as JSON and run
  nothing (no lease, no run folder, no simulator or phone). Text that is exactly `-h` or `--help`
  can't be typed through `type` or `eval`; `keys` takes it after `--`.
- Device ids in output are masked as `…` plus the last 4 characters (`…5F60`), in JSON, `run.log`
  and stderr. `lab phone status` and `lab phone setup` print the full saved UDID. Never paste
  a full UDID into a report or a commit.
- `safari network` reports `count` and `requests` differently per target. **Simulator:** `count` is the
  raw events saved in `network.json`; `requests` is one entry per request (method, url, status).
  **Phone:** `requests` are the entries, and `truncated` covers the rest.
- `safari console` and `safari network` drain their buffer on each read. They read from different
  places per target. **Simulator:** Safari's own log through Appium; `dropped` counts byte-identical
  copies and WebDriverAgent's own entries, and `truncated`/`copies` say Appium's 5000-entry buffer
  filled. **Phone:** `console` comes from a collector the lab places in its own tab (it misses what
  the page logged before the collector was installed); `network` is the lab page's own Resource
  Timing, limited to the sites the lab tab visited, so `dropped` is 0 and there is no `copies`.
  Its `requests` have `method: null` (Resource Timing has no method), a `status` that was `null` on every
  entry on iOS 27.0.1, and sizes of 0 for another site's requests that send no `Timing-Allow-Origin`. `outside` counts
  entries to other sites (by design; a userscript's own cross-origin calls land there, and
  `GM_xmlhttpRequest` probably isn't seen at all); `truncated: true` means 500 were read and more
  are waiting (read again); `lost` is entries past the collector's 2000; `early: true` means the
  browser's 250-entry buffer was full when the collector started, so the oldest are gone. Don't run
  `eval` on the page's timing entries on the phone to fill the gap: it prints every site the page
  talked to. A redirect to another site is refused. Console URLs and text mask secret query values
  (`token`, `key`, `k`, `code`, ...) on both targets.
- On the simulator a failed page command leaves `fail.png` and `fail.html` in the run folder; the phone saves neither.
- Simulator only: `sim tap --label`, `sim scroll`, `sim shot` for Safari's own UI and system
  prompts. While a `safari` session is open `sim tap` and `sim type` do nothing, silently.
