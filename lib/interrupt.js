// SIGINT, SIGTERM and SIGHUP while a command runs: the signal becomes a rejection of the wait
// the command is in (`sleep`, a WebDriver request), so its own cleanup runs and one JSON object
// is printed. A command stuck in a synchronous child (spawnSync) only sees the signal when the
// child returns; the child's timeout bounds that. No dependencies; Node 22+.
import fs from 'node:fs';

const CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
export const SIGNALS = Object.keys(CODES);
export const GRACE_MS = 8e3;

export const exitCodeFor = signal => CODES[signal] ?? 1;

export class InterruptError extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}; the command was stopped before it finished (run \`lab status\` to see where things stand)`);
    this.name = 'InterruptError';
    this.signal = signal;
    this.interrupted = true;
    this.skipArtifacts = true; // no screenshot or page source: the caller wants out
  }
}

let received = null; // the first signal of this command (sticky)
let controller = new AbortController();
let active = false;
let acted = false; // this command sent something that acts on a page (see noteActed)

// The signal that interrupted the running command, or null.
export const interrupted = () => received;

// Whether the running command has sent a request that acts on a page (a script, a tap, keys),
// so an interrupt can say whether something may already have run. Set once the request left,
// even if it never answered; a request refused before it was sent does not count.
export const noteActed = () => { acted = true; };
export const hasActed = () => acted;

// Runs `fn` (cleanup after an interrupt: parking the session) with WebDriver requests allowed
// again. Outside it, a request made after an interrupt is refused, so a `catch` that swallows the
// InterruptError cannot send the command on to its next request.
let cleaning = 0;
export const cleaningUp = () => cleaning > 0;
export async function duringCleanup(fn) {
  cleaning++;
  try { return await fn(); } finally { cleaning--; }
}

// Resolves once a signal that arrived during a synchronous child has been handled. Two turns: the
// first check phase can come before the poll phase that reads the signal, so one full poll must pass.
export const afterPendingSignals = async () => {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
};

// An AbortSignal for the request about to be made. One-shot: a signal aborts the signal handed
// out so far and starts a new one, so a cleanup request made afterwards (parking the session)
// is not aborted by the signal that caused it.
export const requestSignal = () => controller.signal;

function fallback(signal, why) {
  const text = JSON.stringify({ ok: false, interrupted: signal, error: `interrupted by ${signal}; ${why}` }, null, 2) + '\n';
  try { fs.writeSync(1, text); } catch { /* stdout is gone */ }
  process.exit(exitCodeFor(signal));
}

// Runs `fn` with the three signals handled. A second signal, or `fn` still running GRACE_MS
// after the first, prints a short JSON object and exits at once.
export async function withInterrupt(fn) {
  if (active) return fn(); // the outermost call owns the handlers
  active = true;
  received = null;
  acted = false;
  let grace = null;
  const onSignal = signal => {
    if (received) return fallback(received, 'a second signal ended it at once');
    received = signal;
    const hit = controller;
    controller = new AbortController();
    hit.abort();
    grace = setTimeout(() => fallback(signal, `it did not stop within ${GRACE_MS / 1000}s`), GRACE_MS);
    grace.unref();
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    return await fn();
  } finally {
    for (const s of SIGNALS) process.off(s, onSignal);
    clearTimeout(grace);
    received = null;
    acted = false;
    controller = new AbortController();
    cleaning = 0;
    active = false;
  }
}
