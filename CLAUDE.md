# CLAUDE.md

## Project

`mobile-safari-lab` drives real Mobile Safari in the Xcode iOS Simulator for testing web
pages and userscripts: `bin/sim` (simctl + AXe) for the phone, `bin/safari` (Apple's
`safaridriver`, W3C WebDriver over `fetch`) for the page. Node 22+, ES modules, no
dependencies, no build step. Terms are in `CONTEXT.md`; the design is `docs/adr/0001`.
How projects use it is `skill/SKILL.md` (linked into `~/.claude/skills/mobile-safari`).

`pnpm test` (`node --test`) runs everywhere: `setRunner` records commands instead of running
them, and a stand-in HTTP server plays safaridriver. Real runs need macOS with Xcode;
cloud sessions can't run `xcrun`, so say what was and wasn't run on the Mac.

## Rules

- Commands run with argument lists (`run(cmd, args)`), never shell strings.
- Every simulator command passes the saved UDID; never `booted`.
- Every device command (`devicectl`, `xcodebuild`, `pymobiledevice3`, Appium `appium:udid`) passes the saved phone UDID from `lab phone setup`; never "the connected device". `pymobiledevice3 remote start-tunnel` passes it too (`--udid`, [ADR 0006](docs/adr/0006-wifi-tunnel.md)), and the tunnel's device is checked against it afterwards. Team and bundle id come from state, not code.
- The owner's tabs on the phone are theirs: the lab opens, checks and closes its own tab only, and reads no other (the one exception: a yes/no check at start that the attached page is its own tab).
- Every command prints one JSON object (`ok` true/false); errors are messages a person can act on.
- Validate inputs before running anything (URLs are http(s) only); check stored state's shape.
- Network calls time out; polling is bounded.
- No secrets, device or team IDs, or run folders in the repo: the pre-commit hook (`pnpm install` turns it on) runs
  `scripts/check-secrets.mjs`; never `--no-verify`. Tests build fake IDs at runtime or use the fixed fake UDIDs.
- Public identity is `dividedby` only. Commit as `dividedby <64715420+dividedby@users.noreply.github.com>`.
- User-facing changes update `CHANGELOG.md`, the README and, when usage changes, the skill.

## Agent skills

Issues: GitHub issues in `dividedby/mobile-safari-lab` (via `gh api` REST routes). A loose idea goes to the top of the
[Idea Inbox](https://github.com/dividedby/mobile-safari-lab/issues/6), not scoped yet; to capture or drain one, see
`docs/agents/idea-inbox.md`.
