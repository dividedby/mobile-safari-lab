# Idea Inbox: drain protocol

How an agent operates the repo's **Idea Inbox** ([issue #6](https://github.com/dividedby/mobile-safari-lab/issues/6),
label `idea-inbox`, one per repo). The Inbox body is for people: the live `## Ideas` list and a collapsed `✅ Actioned`
window. It carries no operating instructions; those live here, and its first line points here:

```
<!-- agent-protocol: drain=docs/agents/idea-inbox.md -->
```

The repo is public, so everything in the Inbox follows `CONTRIBUTING.md` under "Issues": no device or team IDs, device
names, signing identities, Apple ID details or whole-phone screenshots.

## Capture

A new idea goes in as an unchecked item at the **top** of `## Ideas`. Capture the idea and the context available right
now: the file, issue, PR or link that prompted it, and a sentence on why it matters, so a later drain doesn't start
cold. Don't question, expand or scope it yet; that happens at drain.

A plainly scoped bug, or a request for a tracked issue, skips the Inbox: file the issue directly.

## Drain

When asked to drain the Inbox, or one item in it, take the item as far as it needs:

1. **Dedup and relate.** Review the open issues first. Decide whether the idea already exists (move it to `✅ Actioned`,
   pointing at that issue), fits into an open issue (comment there instead of filing a new one), or blocks or depends on
   one (record that). When an idea cites another issue or PR, check its current state: a closed issue's last comment may
   already answer the idea. Numbers from before the repo went public refer to the private archive.
2. **Map the decisions, if it's tangled.** When the idea has several unknowns or competing approaches, split it into a
   sequence of investigation issues ("Investigate X to determine Y"), each settling a decision the next depends on. Skip
   this when the idea is already one decision with a clear next step.
3. **Do only the steps it needs.** Talk it through with the owner when it's fuzzy or touches the terms in `CONTEXT.md`
   or an ADR. Write a spec first only when it's big enough to need one. A small, clear idea may need only one issue.
4. **Labels.** Use the repo's: `bug`, `enhancement` or `documentation`.
5. **Write a brief an agent can finish.** Name the files or area, what done looks like, what's out of scope, and how to
   test it with the stand-ins. Anything that needs the real phone or simulator is the owner's to run: say so, with
   step-by-step instructions and what to check, instead of leaving it to judgement.
6. **Move it to Actioned.** Once the idea is an issue or PR, or is settled as a duplicate, move it to `✅ Actioned`,
   check it, and append `→ #<number>`.

Never delete an idea silently: drain it, or move it with a one-line reason.

## Actioned is a rolling window

`✅ Actioned` keeps about the 8 most recent items, newest on top. Each drain adds the new item and drops the oldest; the
record survives on the issue or PR each one links to.
