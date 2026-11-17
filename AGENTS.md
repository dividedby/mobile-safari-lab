# AGENTS.md: start here

For any coding agent, in any repo, that wants to test a web page or userscript in real Mobile
Safari with this lab. It drives the owner's **iPhone** or an iOS **Simulator** on the Mac, and
prints one JSON object per command (`ok` true or false). This file is the entry point: the rules
and the workflow in short, with the detail in [docs/agents-guide/](docs/agents-guide/). The
[README](README.md) has setup, [CONTEXT.md](CONTEXT.md) the terms, and
[skill/SKILL.md](skill/SKILL.md) the same workflow written as a Claude Code skill.

These docs are the source of truth for the lab: they override lab details you remember or that
another repo has copied (commands, rules, how to report issues). Other repos should keep only a
pointer to the skill (`~/.claude/skills/mobile-safari`, which points here), not copies of this.

If the project you are working in has its own test rules (which pages, which accounts, what to
leave clean), they still apply.

## Where things live

| Need                                                                      | Read                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| What `sim doctor` checks, root refusal, `pymobiledevice3`, `phoneDisplay` | [setup.md](docs/agents-guide/setup.md)               |
| Target choice, simulator on/off, simulator profiles, iPhone vs simulator  | [targets.md](docs/agents-guide/targets.md)           |
| Using Wi-Fi (the tunnel, what the person sets up, CoreDevice restarts)    | [wifi.md](docs/agents-guide/wifi.md)                 |
| `lab up`: timings, what it repairs, `labVersion`, failures, leases        | [bring-up.md](docs/agents-guide/bring-up.md)         |
| The `safari` command list and notes (`eval`, `tap`, `keys`, console)      | [test.md](docs/agents-guide/test.md)                 |
| Behaviours that refuse or mislead (menus, sheets, appearance, Focus, ...) | [test-gotchas.md](docs/agents-guide/test-gotchas.md) |
| `lab down`, `safari stop`, the idle stop, `lab hold`, interrupts          | [finish.md](docs/agents-guide/finish.md)             |
| The `needs` table, the signing lock (`busy`), borrowed slots (`slots`)    | [needs.md](docs/agents-guide/needs.md)               |
| The details behind the hard rules below (tab pin, secrets, logs)          | [hard-rules.md](docs/agents-guide/hard-rules.md)     |
| What the lab does and doesn't do on the owner's phone                     | [privacy.md](docs/agents-guide/privacy.md)           |
| Report what you find: `lab-feedback.md`, issues, privacy of issues        | [reporting.md](docs/agents-guide/reporting.md)       |

## 1. Check the setup

- It only works on the Mac that has Xcode. A cloud session can't run `xcrun`: say so, and offer
  to do the rest when the person is at the Mac.
- `sim doctor` checks the tools. If it says `ok: false`, stop and relay its `hints` (one fix per
  item in `missing`). Never install tools or change settings without asking.
- The tools are `bin/sim`, `bin/safari` and `bin/lab` in this repo, normally on `PATH`. Run them as
  the owner's own user: under sudo they print `refusing to run as root`.
- Using the phone needs it saved once: `lab phone status` shows whether it is. `needs: "setup"`
  is in [needs.md](docs/agents-guide/needs.md). The Wi-Fi and display hints are in [setup.md](docs/agents-guide/setup.md).

## 2. Pick a target

**Use the iPhone** (`--target device`, or `--target auto`, the default, with a phone saved). Use a
simulator only if the owner asks for it or agrees, even when it looks cleaner for the test: it is
heavy on a small Mac. If a test seems to need a clean profile, ask whether to do it on the phone. If
the phone is blocked, relay what's blocking it and ask; don't switch on your own. `auto` with a
saved phone that can't be used fails with a `needs`; it never switches to the simulator.

The simulator is off until its owner runs `lab simulator on` in their own terminal (away from a
terminal it's refused; never work around that): anything that would boot or start one fails with
`needs: simulator-off`. Profiles, the iPhone vs simulator table and Wi-Fi are in
[targets.md](docs/agents-guide/targets.md) and [wifi.md](docs/agents-guide/wifi.md).

## 3. Bring it up

```sh
sim run <short-label>                       # a run folder for screenshots and logs; the session `lab up` starts next uses it
lab up --target auto --url <http(s) URL>    # or --target device
```

`lab up` checks and repairs everything in order and reports each `step`; run it again whenever
something seems stuck. If its output has `labVersion.human`, relay it to the owner as it is and carry
on; never pull or change the lab's checkout yourself. On failure it names the `failedStep`; an
`ok: false` with `needs` is the table in [needs.md](docs/agents-guide/needs.md). A lease held by
someone else (`failedStep: "lease"`): tell the person who holds it and until when, then wait or ask.
Timings, the cold-start behaviour and the other outputs are in [bring-up.md](docs/agents-guide/bring-up.md).

## 4. Test

Drive the page with `safari` (`open`, `inject`, `eval`, `click`, `tap`, `select`, `keys`, `swipe`,
`pinch`, `wait`, `back`, `shot`, `console`, `network`; the list with flags is in
[test.md](docs/agents-guide/test.md) and `safari --help`). Rules that always hold:

- Use `wait`, not `sleep`: `safari wait <css> --visible` or `safari wait --settled`, and before every `shot`.
- Look at your screenshots before saying something works. Use `shot --page` or `--element` for any shot
  you share or attach: a plain `shot` is the whole phone screen.
- `click` and `type` are synthetic; use `tap` and `keys` when trusted events matter, and say which you used.
- Injected scripts start after load and are lost on every navigation. State this limit in your
  report; if timing matters, say it needs a real-device check.
- Read [test-gotchas.md](docs/agents-guide/test-gotchas.md) before testing a `<select>` or picker, a
  system sheet, appearance or orientation, Back, `--storage` or `--allow-host`.

## 5. Finish

1. **`lab down` when the work is over**, always. If it says `ok: false`, run it again. For a short break
   use `safari stop` (a lab idle for 15 minutes is stopped anyway: a safety net, not a reason to skip `lab down`).
2. **Stop every server you started** yourself, and clean up whatever the project's rules require.
3. In your report, say what ran on which target, what didn't, and what still needs a check on the other one.

An interrupted command tears nothing down: run `lab status` first. Details in
[finish.md](docs/agents-guide/finish.md).

## 6. The `needs` table

Stop, relay the `human` steps to the person word for word, and run `then` once they say it's done.
Don't improvise past a `needs`, and never change the phone's or the Mac's settings yourself. If the
person can't or won't do the steps, say in your report that the iPhone wasn't tested; don't move to
the simulator unless they ask for it or agree. The table is [needs.md](docs/agents-guide/needs.md).

## 7. Hard rules

The mechanics behind each are in [hard-rules.md](docs/agents-guide/hard-rules.md).

- **Never `--force`** on `lab up`, `lab down` or `lab release` unless the person says the other agent is done.
- **Never type or tap into Safari's address bar.** Use `safari open <url>`.
- **Never touch the owner's other tabs.** Don't switch tabs, open Safari by hand on the phone, or try
  to read, close or reuse another tab. On `needs: "tab"`, relay it; don't retry around it.
- **Follow redirects only to hosts the person allowed** (`--allow-host`); never add one yourself.
- **Don't run the owner's setup:** `lab down --idle`, `lab service install`, `lab phone setup`,
  installing tools or enabling settings. `lab hold` is yours, for a hand-over.
- **Never widen the network binding.** Everything the lab starts listens on `127.0.0.1` only.
- **Keep secrets out of run folders.** No passwords, tokens or real personal data in URLs, injected
  scripts, typed text or `eval` source; don't paste `source`, `fail.html` or `network.json` wholesale.
- Only open URLs from the task or the project. Don't sign in, buy, post or submit forms with real data.
- Use only `sim reset` to erase the clean simulator (the configured one on the person's say-so).
  Never type a password, code or secret into a simulator, or an Apple ID. Don't touch other simulators or
  use `xcrun`, `devicectl` or `xcodebuild` on the phone yourself.
- Never paste a full device UDID into a report or a commit; the lab's `…last4` form is fine.

## 8. Privacy

The phone is the owner's daily phone: treat what you see as their data. What the lab does and doesn't do
there is in [privacy.md](docs/agents-guide/privacy.md).

## 9. Report what you find (bugs, features, docs)

Note lab bugs, gaps, friction and wrong docs in `<run folder>/lab-feedback.md` as you go, and file them as
issues once the owner says OK ([reporting.md](docs/agents-guide/reporting.md)). A loose idea goes to the
[Idea Inbox](https://github.com/dividedby/mobile-safari-lab/issues/6) (`docs/agents/idea-inbox.md`). Don't
edit the lab's code from another repo or work around its guards to finish a test.
