# Report what you find (bugs, features, docs)

You may be working in another repo. Watch for lab problems as you go and file them. The backlog
is the issues in `dividedby/mobile-safari-lab` (public: no device IDs, team IDs or whole-phone screenshots in
them, see `CONTRIBUTING.md`; labels `bug`, `enhancement`, `documentation`); in the lab's own repo it is the "Issues and ideas" line of CLAUDE.md.

**While you work.** Note anything that failed, surprised you, was slow, needed a workaround, or that
the docs got wrong or left out. Write it down at the time in `<run folder>/lab-feedback.md` (the
run folder is the `run` field of every command). One line each: the command, what happened, the
JSON `error`, `needs` or `human`, and what you expected.

A loose idea that isn't a bug or a clear request goes to the top of the
[Idea Inbox](https://github.com/dividedby/mobile-safari-lab/issues/6) instead (`docs/agents/idea-inbox.md`).

**What counts.**

- A lab bug: a wrong result, a crash, a misleading `error` or `human`.
- A missing feature: something you needed and the commands can't do.
- Friction: too many steps, slow, a confusing output field.
- Docs that were unclear or wrong.
- Not: bugs in the other repo's own code (those go to that repo, after asking the owner), or a
  `needs` the lab handled as designed (a locked phone, a tab switch).

**When you finish (or are blocked).**

1. De-duplicate against the open issues:
   `gh api 'repos/dividedby/mobile-safari-lab/issues?state=open&per_page=100' --paginate --jq '.[] | select(.pull_request | not) | {number,title}'`.
   If an item is already filed, comment on that issue instead of opening a new one.
2. Show the owner the list in one message and file it once they say OK. One OK covers the batch.
3. File one issue per distinct bug or feature. Small docs or friction items can share one issue.

**How to file.** REST, with the body in a file written with the Write tool (no heredoc):

- New issue: `gh api -X POST repos/dividedby/mobile-safari-lab/issues -f title='...' -F body=@<file> -f 'labels[]=bug'` (or `enhancement`, `documentation`).
- Comment: `gh api -X POST repos/dividedby/mobile-safari-lab/issues/<n>/comments -F body=@<file>`.

**Body.**

- Context: the calling repo and task, the lab commit (`git -C <lab> rev-parse --short HEAD`), the target (iPhone or simulator), the iOS version.
- Steps to reproduce: the exact commands.
- Expected vs actual: the JSON `error`, `needs` or `human`, trimmed.
- Workaround used, if any.
- Impact: blocked, slowed down, or cosmetic.
- For a feature: what you were trying to test, and why the current commands fall short.

**Privacy.** The owner's rules apply to issues too.

- No secrets, tokens, cookies, session ids or response bodies.
- No full device UDID; the lab's `…last4` form is fine.
- No personal data, account names or other people's content.
- Cut private or signed-in page URLs down to their origin.
- Attach no screenshots; name the run-folder path instead.
- Never paste env vars.

**Don't** edit the lab's code from another repo, work around its guards to finish a test, or open
issues for things already handled by design.
