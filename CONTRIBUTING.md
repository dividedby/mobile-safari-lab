# Contributing

mobile-safari-lab drives real Mobile Safari, on your own iPhone or in the Xcode iOS Simulator, for testing web pages
and userscripts. It is maintained in spare time. Support isn't guaranteed, but issues and pull requests are welcome
and I'll try to get to them.

## Before you start

- Read `README.md` (setup and every command) and `AGENTS.md` (the workflow and the hard rules; they apply to people as
  much as to agents). `CONTEXT.md` has the terms, and `docs/adr/` the design decisions.
- Requirements: macOS with Xcode for real runs (an Apple Silicon Mac on macOS 27 and Xcode 27 is what it is checked
  on), Node 22 or newer, and pnpm (never npm or yarn). The tests run anywhere Node does.
- The phone you test with is yours to set up: `lab phone setup` saves its UDID, your team and a bundle id in the
  lab's state, never in the repo.

## Issues

- Bugs and scoped requests: open an issue, one per bug or feature. Small docs fixes can share one. Loose ideas go in
  the [Idea Inbox](https://github.com/dividedby/mobile-safari-lab/issues/6).
- Never put device UDIDs or CoreDevice IDs, device names, team IDs, signing identity names, Apple ID details,
  certificates or profiles in an issue, a log you paste or a screenshot. A plain `safari shot` on the iPhone is the
  whole screen (status bar, notifications, other apps): share `safari shot --page` or `--element` crops only.
  `network.json` has cookies, auth headers and secret URL parameters removed, but don't paste it wholesale either.
- Security problems: don't post details publicly. Open an issue that says only that you have a security report, and
  I'll arrange a private channel.
- Issue and pull request numbers in the docs and code comments written before the repo went public (2026-10-31) are
  plain text ("issue 98"): they refer to the private archive, not to this repo's issues.

## Making a change

1. Run `pnpm install` once. It sets `core.hooksPath` so the pre-commit secrets check (`scripts/check-secrets.mjs`)
   runs on every commit. Never bypass it with `--no-verify`.
2. Branch off `main`. Keep the change focused.
3. Follow the rules in `CLAUDE.md` and `AGENTS.md`:
   - Node 22+, ES modules, no dependencies, no build step.
   - Commands run with argument lists (`run(cmd, args)`), never shell strings. Every network call times out and every
     poll is bounded.
   - Every simulator command passes the saved UDID (never `booted`); every device command passes the saved phone UDID
     (never "the connected device").
   - Every command prints one JSON object (`ok` true or false); errors are messages a person can act on.
   - On the phone the lab opens, checks and closes its own tab only, and reads no other.
   - Tests never touch a real simulator, phone or Appium: `setRunner` records commands, and stand-in servers play
     Appium and WebDriverAgent. Build fake device IDs and secrets in the test, never real ones.
4. Update `README.md`, `CHANGELOG.md` (under `## [Unreleased]`) and, when usage changes, `AGENTS.md` and
   `skill/SKILL.md` in the same pull request.
5. Run `pnpm test` and `pnpm check-secrets` and make sure it passes before you open the pull request. Say what you ran on a real Mac, simulator
   or iPhone, and what you didn't. CI must be green; pull requests are merged with a merge commit.

By contributing, you agree that your contribution is licensed under the MIT License (`LICENSE`).

## Guidance for AI agents

If an AI coding agent works on this repo, for you or on its own, these rules bind it. Most tools read `AGENTS.md`
automatically; if yours reads only another file (for example `CLAUDE.md`), point it at `AGENTS.md`.

- **Read `AGENTS.md` first and follow it.** Where this file and `AGENTS.md` differ, `AGENTS.md` wins.
- **The iPhone is its owner's.** Ask before any run on the phone (`lab up --target device`, `safari start --device`).
  Never switch, read or close the owner's other Safari tabs, never change the phone's or the Mac's settings, and relay
  a `needs` failure's `human` steps instead of working around them.
- **Don't take what another agent holds.** A refused `lab up` names the lease's owner; never use `--force` on your own.
- **No credentials.** Never ask for, type or store an Apple ID password, and never type real credentials into a page.
  `open --storage` is for test flags and dummy tokens.
- **Tests stay hermetic:** no real devices, simulators, Appium or network; fake IDs built at runtime.
- **Say what you ran.** In the pull request, say that an agent wrote or helped with the change, and list the checks it
  ran (`pnpm test`, and anything on a real Mac, simulator or phone). Don't claim a device run that didn't happen.
- pnpm only, no `--no-verify`, and no secrets or device IDs in commits, issues or pull request text.
