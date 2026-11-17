# Pick a target

Detail for step 2 of [AGENTS.md](../../AGENTS.md). Wi-Fi is in [wifi.md](wifi.md).

**Use the iPhone.** Use a simulator only if the owner asks for it or agrees, even when it looks
cleaner for the test: it takes about 3 to 5 GB of memory and 4 to 10 minutes to start cold on an
8 GB Mac. If a test seems to need a clean profile, ask whether to do it on the phone. If the phone
is blocked, relay what's blocking it and ask; don't switch on your own.

| Situation                                                                                                           | Use                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything, unless the owner has said otherwise                                                                       | `--target device`, or `--target auto` (the default) with a phone saved                                                                             |
| A dark-mode or landscape check                                                                                      | `--target device`, then `safari appearance dark` / `safari orientation landscape` (the lab puts them back; see [test-gotchas.md](test-gotchas.md)) |
| The owner asked for the simulator or agreed to it, for a clean profile, status-bar control or identical screenshots | `--target simulator` (clean is the default profile)                                                                                                |
| The owner asked for the signed-in simulator they set up, or agreed to it                                            | `--target simulator --profile configured` (see below)                                                                                              |

**The simulator is off on a Mac until its owner turns it on.** While it's off, anything that would
boot one or start a session on one fails with `needs: simulator-off` before anything starts: `lab up
--target simulator`, `lab up` with no phone saved, `safari start` on the simulator, `sim create` and
`sim boot`. The owner runs `lab simulator on` in their own terminal (away from a terminal it's refused;
never work around that), and `lab simulator off` to turn it off again. `lab simulator status` and `lab
status` show `simulatorAllowed`.

When a phone **is** saved but can't be used, `auto` fails with a `needs` ([needs.md](needs.md)). It never
switches to the simulator.

Differences you should know before you report:

|                                                 | iPhone                                                                                                                                                        | Simulator                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine, GPU, fonts, network                     | real                                                                                                                                                          | the Mac's                                                                                                                                       |
| Profile                                         | the owner's: logged in, with their extensions, which may inject into pages                                                                                    | clean, logged out, no extensions; or `--profile configured`: only the sign-ins the owner made by hand                                           |
| Appearance, status bar                          | appearance and orientation: `safari appearance`, `safari orientation`, put back at the end ([test-gotchas.md](test-gotchas.md)); status bar: not controllable | `sim appearance`, `sim statusbar` (the `safari appearance` and `orientation` commands are refused on a simulator session)                       |
| Setup                                           | signing (free account: re-sign every 7 days), phone unlocked and awake, battery                                                                               | none after setup                                                                                                                                |
| Speed                                           | session ~50 s cold, 14 to 18 s warm; a call is ~20 ms on cable, ~2x on Wi-Fi (to be re-measured over the tunnel)                                              | 4 to 10 minutes cold on a loaded 8 GB Mac, 22 to 31 s warm; fast once booted; the first boot of a new simulator (`sim create`) up to 25 minutes |
| `sim` commands (`tap`, `type`, `shot`, `ui`...) | refused during a device session: use `safari shot\|tap\|keys\|swipe\|ui`                                                                                      | fine outside a session                                                                                                                          |

**Simulator profiles.** The lab has two simulators and only one is booted at a time. **Clean** ("Claude iPhone") is the default of every `lab up` and is never signed in; `sim reset` makes it new. **Configured** ("Claude iPhone (configured)", made once with `sim create --profile configured`) keeps what the owner signed in to by hand, and Safari's data survives between sessions. Pick it per run with `lab up --profile configured` (never sticky; the next `lab up` with no flag is clean). `sim boot`, `shutdown`, `reset`, `udid` and `create` take `--profile` too; any other `sim` command acts on the live session's simulator. `sim profile status` shows both devices. A session on one profile blocks `lab up` on the other (`safari stop` first); the other device is shut down for you. `sim reset` on configured needs `--profile configured --yes` and is the owner's call, not yours. Rules: never type a password, code or any secret into either simulator, and never an Apple ID; the owner signs in by hand, once. A shot of a configured session shows what is signed in, so the screenshot check in [privacy.md](privacy.md) applies; and it is not pristine, so reproduce a bug on clean and say which profile you used.
