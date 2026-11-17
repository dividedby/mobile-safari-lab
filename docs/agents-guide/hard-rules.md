# Hard rules: the details

The rules themselves are in [AGENTS.md](../../AGENTS.md); this is what stands behind them.

- **Never `--force`** on `lab up`, `lab down` or `lab release` unless the person says the other
  agent is done: it takes the simulator from whoever is using it.
- **Never type or tap into Safari's address bar.** Typing there and pressing Return performs a web
  search. `tap` and `swipe` refuse the toolbar; don't work around it. Use `safari open <url>`.
- **Never touch the owner's other tabs.** The lab opens its own tab on the phone and every command
  checks it is the one showing. Don't switch tabs, open Safari by hand on the phone, or try to read,
  close or reuse another tab. If a command refuses with `needs: "tab"`, relay it; don't retry around it.
  Switching away from the lab's tab only pauses the session: `tap`, `keys`, `swipe`, `shot` and `ui`
  are refused with `needs: "tab"` (nothing done on screen, not tainted) until the owner switches back;
  `url`, `eval` and `wait` can be refused too when Safari pauses the background tab ("did not answer
  within 10s", also untainted, and `pending` on the next command until the tab shows). A busy page can
  hold a script up the same way (issue 104): the next command that gets no answer then says "Appium is still
  waiting on a script the lab sent to its tab", and `lab status` shows `waitingSince` next to
  `usable: false`. Wait, or run `safari start` if it has not cleared within a minute. `open` and
  `refresh` give each script of their navigation up to 30 s, since a loading page is busy. **A refused
  command can still finish in the lab's tab once it shows** (Appium runs one command at a time and
  the refused one waits in its queue): after the owner switches back, check the page before you
  repeat a click or a type. A refused or late script never runs in another tab, and a tab the owner
  opens while you work does not pull the session into it: Appium runs with the lab's `msl-page-pin`
  plugin, and a command it refuses says so (`needs: "tab"`, tainted, nothing ran). If `lab status`
  lists the page pin as missing, or `safari start` is refused with `needs: "service"` about it,
  relay it: the person links the plugin and runs `lab service install`; don't run that yourself.
  The session ends (the run is tainted) only when the lab's own tab changes under it (navigated by
  hand, closed, replaced) or the session is found in another page: `safari start` then opens a fresh tab.
  The exception is a host the session was started with (`safari start --allow-host <host>`, or `lab up
--allow-host <host>`; repeatable, up to 10, exact match, http and https): a tab that went there is
  marked again and followed, and the output says `followed`. Ask the person which hosts to allow; never
  add one yourself to get around a refusal. After a taint the list is gone: the refusal names the hosts,
  and the new session names them again.
- **The idle stop stops only what the lab started.** `lab down --idle` is run by its LaunchAgent, not by
  you; don't run it, install or remove the agent (`lab service install --no-idle-stop`) on your own.
  `lab hold` is yours to run, for a hand-over to the person ([finish.md](finish.md), step 2); it only delays the stop.
  It never shuts down a simulator the lab didn't boot and never touches another simulator.
- **Never widen the network binding.** Appium and everything else the lab starts listen on
  `127.0.0.1` only. Don't pass `0.0.0.0` or a LAN address. The Wi-Fi tunnel's address (`fd...`, in
  `lab tunnel status`) is not a LAN binding: it is the one address the lab's WebDriverAgent binds on the
  phone, and the lab sets it; never pass it to anything else, and never run `pymobiledevice3 remote tunneld`.
- **Keep secrets out of run folders.** Don't put passwords, tokens or real personal data in URLs,
  injected scripts or typed text; `source` and `fail.html` are the page's raw HTML and `network.json`
  can hold more than you expect. Don't paste them wholesale into reports or commits. `--storage`
  values are kept out of every file the lab writes and, through the service's rules, out of Appium's
  log, but that is no reason to use a real secret. At `info` (the default) script arguments, typed
  text and request bodies are redacted there; `--log-level debug` also logs command results,
  including text `keys` reads back from a field, so use it only for debugging and delete the log
  afterwards. **`safari eval` script text reaches Appium's info log** (only its arguments are
  redacted): put a sensitive value in `--storage` or in typed text (`type`, `keys`), never in the
  source of an `eval`. The rules cover the service's Appium and the one
  the lab starts itself (both at log level `info`); an Appium started by hand or reached through
  `MSL_APPIUM_URL` is not checked, so `type` text may be logged there. A service that started
  before its rules file was last written may hold older rules, so it is refused (`needs:
"service"`, `lab service install` again), and `type` and `keys` refuse the same way before they
  send anything. Once `type` or `keys` has sent its first character, a failure saves no
  `fail.png` or `fail.html` and its message holds no typed text (`keys: character #3 did not
land`); a failure before that keeps them.
- Only open URLs from the task or the project (localhost, test pages). Don't sign in, buy, post or
  submit forms with real data, and never sign a simulator into an Apple ID.
- Use only `sim reset` to erase the clean Claude iPhone simulator (the configured one only on the person's say-so: it erases their sign-ins). Never type a password, code or any secret into a simulator. Never touch other simulators, and
  don't use `xcrun`, `devicectl` or `xcodebuild` on the phone yourself: the lab passes the saved UDID.
- Don't install tools, enable settings, or run `lab service install` / `lab phone setup` on your own.
