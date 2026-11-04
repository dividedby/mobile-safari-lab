# 0010: The simulator is off until the owner turns it on

Date: 2026-11-04 · Status: accepted · Builds on [0002](0002-appium-for-the-simulator.md) and [0005](0005-physical-iphone-via-appium.md)

## Context

A simulator takes about 3 to 5 GB of memory and 4 to 10 minutes to start cold on an 8 GB Mac, and the owner doesn't want agents using one there. The docs said the opposite: the target tables listed it for a clean profile or an unreachable phone, and every `needs` carried `or: lab up --target simulator`. An agent blocked on the phone did what they said, and started one mid-task ([issue #14](https://github.com/dividedby/mobile-safari-lab/issues/14), and again during [issue #17](https://github.com/dividedby/mobile-safari-lab/issues/17)). Rewording alone leaves it to each agent to read closely.

## Decision

- **Off by default, per Mac.** `simulatorAllowed` in the state, off unless `lab simulator on` set it. An existing install starts off too.
- **Turning it on takes a terminal.** `lab simulator on` is refused when stdin isn't a TTY. A flag such as `--allow-simulator` wasn't used, because an agent could add it to any command. This is a guard against agents that follow instructions, not a security boundary: one could still run the command in a terminal or edit the state file, and the docs tell them not to.
- **Refused where a simulator would start.** `lab up` when it would use the simulator (before the lease or anything else), `startSession` for a new simulator session (and `safari start` before the lease when that's all it can mean), `bootSim`, and `sim create` and `sim boot` before the lease. A simulator already running can still be used by the session on it and shut down (`lab down`, `safari stop`, the idle stop), and `lab simulator off` stops nothing; asking for it again with `lab up --target simulator` is refused while it's off.
- **`needs: simulator-off`.** The steps say to use the iPhone, and that turning the simulator on is the owner's call.
- **No simulator way out in `needs`.** `or` stays only on `resign`, where it's another fix for the person. A blocked agent relays the steps and asks.

## Consequences

- Someone with no phone hits the refusal once on first use, and its steps tell them what to run. That friction was accepted to keep a small Mac safe by default.
- `auto` with no phone saved still means the simulator, but only once it's on.
- Output changes: agents reading `or` for a way out no longer get one.
