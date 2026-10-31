// The restore ledger for phone settings the lab changes (appearance, orientation, Lab Focus; ADR 0007). The
// owner's phone is theirs: before the lab changes one of these it writes down what it was
// (`state.phoneRestore`), and puts it back at `safari stop`, `lab down`, the idle stop and the next
// `lab up` (so a crash does not leave the phone changed). The rules, each of them tested:
//   1. intent first: the entry (with `prior`) is written BEFORE the change is sent;
//   2. the prior value is read first; if it can't be read the change is refused;
//   3. an entry that is already there keeps its `prior` (a crashed run's leftover is the lab's own, not the owner's);
//   4. a value is put back only if the phone still shows what the lab set: if the owner changed it by hand, it is left (`ownerChanged`);
//   5. an entry is cleared only after the phone reads back the value that was put back; a failure keeps it;
//   6. every call passes the saved phone's UDID, and an entry for another phone is refused.
// The device calls are devicectl (phone.js): no WebDriverAgent session, so this works after a crash too.
//
// One table, SETTINGS, describes each kind of setting; the engine below (change, restore, status, the record's shape,
// the command words) reads only the table. A new kind is one entry here plus its devicectl adapter in phone.js.
import { loadState, saveState, isUdid, isObj, isAt, sleep } from './core.js';
import { InterruptError } from './interrupt.js';
import {
  WAIT, READ_BACK_TRIES, APPEARANCES, ORIENTATIONS, FLAT_ORIENTATIONS, UPRIGHT_ORIENTATIONS,
  getAppearance, setAppearance, getOrientation, setOrientation, setFocus, focusConfig, isShortcutName, readPhone, needsError, redactMessage,
} from './phone.js';

export const FORGET = 'lab phone restore --forget';

export const AUTOMATIC_NOTE = 'The lab cannot read whether Appearance is on Automatic (Settings > Display & Brightness). It set back the mode the phone showed before; if Automatic was on, check that it still is.';
export const FOCUS_NOTE = 'The lab cannot read which Focus is on, so it ran the Lab Focus Off shortcut and assumes Lab Focus was off before the run; the phone confirms the shortcut was started, not that the Focus changed.';
const UPSIDE_DOWN_NOTE = 'The phone was upside down (portraitUpsideDown); the lab puts it back to portrait, the interface orientation.';

// The interface orientation the lab sets for a prior upright reading: portraitUpsideDown becomes portrait.
const INTERFACE = { portrait: 'portrait', portraitUpsideDown: 'portrait', landscapeLeft: 'landscapeLeft', landscapeRight: 'landscapeRight' };

// One entry per kind of setting (the key is the name in the record, the `safari` command and the `lab up` flag):
//   command    false: no `safari <kind>` command and no `lab up --<kind>` flag (the kind has its own way in)
//   blind      true: the phone's state can't be read (no read, no read-back): the prior is `snapshot()`, a change is "sent", and a restore
//              is "sent" too; both are only as confirmed as the adapter's write says (ADR 0007, Lab Focus)
//   words      the command words and flag values -> the value they set ({ light: 'light' }, { landscape: 'landscapeLeft' })
//   values     what a set accepts; valuesText says so in the refusal
//   noun       how messages name it; where: how a person finds it in Settings; readDesc: what a failed first read could not read
//   read/write the devicectl adapter: read(udid) and write(udid, value, phone) give { ok, value } or { ok: false, error, needs }
//   key        the comparable value of a reading
//   snapshot   what is written down as `prior` from a reading
//   refuse     (prior) -> a reason not to change it when the prior could not be put back, else nothing
//   isEntry    the shape of its entry in the record; entryExtra (blind kinds): (phone) -> fields added to a new entry
//   mismatch   the message when a set was read back as something else
//   ignored    optional: { change(want, still), restore(entry, expected, still) } for a phone that takes a set and ignores it
//   plan       (entry) -> { expected (the key once put back), steps (values to write, in order), exact, note? }
//   ownerNote  the note when the owner changed it by hand
//   byHand     what a person does when the lab cannot put it back; priorLabel: the prior in a sentence
//   status     (reading) -> the fields `safari <kind> status` shows
//   found      (prior) -> what a `lab up` step found; requested/note: extras in the output of a change
export const SETTINGS = {
  appearance: {
    words: Object.fromEntries(APPEARANCES.map(a => [a, a])),
    values: APPEARANCES,
    valuesText: 'light or dark',
    noun: 'Appearance',
    where: 'Appearance (Settings > Display & Brightness)',
    readDesc: 'the current mode',
    read: getAppearance,
    write: setAppearance,
    key: v => v,
    snapshot: v => v,
    isEntry: e => isObj(e) && APPEARANCES.includes(e.prior) && APPEARANCES.includes(e.set) && isAt(e.at),
    mismatch: (seen, want) => `the phone shows ${seen ?? 'an unreadable appearance'} after Appearance was set to ${want}`,
    plan: entry => ({ expected: entry.prior, steps: [entry.prior], exact: false, note: AUTOMATIC_NOTE }),
    backMismatch: (seen, expected) => `the phone shows ${seen} after Appearance was set back to ${expected}`,
    ownerNote: (entry, now) => `Appearance was changed by hand after the lab set ${entry.set} (it shows ${now}), so the lab left it.`,
    byHand: entry => `set Appearance back to ${entry.prior} by hand (Settings > Display & Brightness)`,
    priorLabel: entry => entry.prior,
    status: v => ({ appearance: v, automatic: 'unknown' }),
    found: prior => `Appearance was ${prior}`,
    note: AUTOMATIC_NOTE,
  },
  orientation: {
    words: { portrait: 'portrait', landscape: 'landscapeLeft' },
    values: ORIENTATIONS,
    valuesText: `one of ${ORIENTATIONS.join(', ')}`,
    noun: 'the orientation',
    where: 'the screen orientation',
    readDesc: 'the current one',
    read: getOrientation,
    write: setOrientation,
    key: v => v?.deviceOrientation,
    snapshot: v => ({ deviceOrientation: v.deviceOrientation, nonFlat: v.nonFlat }),
    refuse: prior => (FLAT_ORIENTATIONS.includes(prior.deviceOrientation) && prior.nonFlat === null
      ? 'won\'t change the orientation it can\'t put back: the phone lies flat and did not say which way up it was' : undefined),
    isEntry: e => isObj(e) && isObj(e.prior)
      && ORIENTATIONS.includes(e.prior.deviceOrientation)
      && (e.prior.nonFlat === null || UPRIGHT_ORIENTATIONS.includes(e.prior.nonFlat))
      && (!FLAT_ORIENTATIONS.includes(e.prior.deviceOrientation) || e.prior.nonFlat !== null) // a flat phone needs the upright reading to be put back
      && ORIENTATIONS.includes(e.set) && isAt(e.at),
    mismatch: (seen, want) => `the phone reports ${seen ?? 'an unreadable orientation'} after the orientation was set to ${want}`,
    // The upright orientation first (the interface follows it), then the flat reading if the phone was lying flat.
    plan: entry => {
      const { prior } = entry;
      const flat = FLAT_ORIENTATIONS.includes(prior.deviceOrientation);
      const upright = INTERFACE[prior.nonFlat];
      const exact = flat ? upright === prior.nonFlat : upright === prior.deviceOrientation; // upside down comes back as portrait, flat or not
      return { expected: flat ? prior.deviceOrientation : upright, steps: flat ? [upright, prior.deviceOrientation] : [upright], exact, ...(exact ? {} : { note: UPSIDE_DOWN_NOTE }) };
    },
    backMismatch: (seen, expected) => `the phone reads ${seen} after the orientation was set back to ${expected}`,
    // Nothing moved: with Portrait Orientation Lock on the phone takes `set` and ignores it, and its own lock flag still reads false.
    ignored: {
      change: (want, still) => Object.assign(new Error(`the phone's orientation did not change after setting ${want} (still ${still}): Portrait Orientation Lock is probably on`), {
        extra: {
          rotationLock: 'probably',
          human: ['Turn off Portrait Orientation Lock on the phone (Control Center), then run the command again.', 'The phone reports its lock as off even when it is on, so the lab can only tell from the result.'],
        },
      }),
      restore: (entry, expected, still) => ({
        error: `the orientation did not change when the lab set it back to ${expected} (still ${still}): Portrait Orientation Lock is probably on`,
        human: [`Portrait Orientation Lock is probably on, so the phone ignored the lab putting its orientation back to ${expected}. Turn it off in Control Center, then run \`lab phone restore\` (the record is kept; the next \`lab up\` and \`lab down\` try again too), or ${SETTINGS.orientation.byHand(entry)}.`],
      }),
    },
    ownerNote: (entry, now) => `The phone was turned by hand after the lab set ${entry.set} (it reads ${now}), so the lab left it.`,
    byHand: entry => `turn the phone back to ${entry.prior.deviceOrientation}${FLAT_ORIENTATIONS.includes(entry.prior.deviceOrientation) ? ` (lay it flat, ${entry.prior.nonFlat} up)` : ''} by hand`,
    priorLabel: entry => entry.prior.deviceOrientation,
    status: v => ({ orientation: v.deviceOrientation, upright: v.nonFlat }),
    found: prior => `the phone was ${prior.deviceOrientation}`,
    requested: true,
  },
  // Lab Focus (issue 16): the owner's Focus "Lab", turned on and off by two owner-made shortcuts. Nothing can be read (no Focus state
  // from devicectl), so the entry only says the lab turned it on; restore runs the Off shortcut and cannot confirm the effect.
  focus: {
    command: false, // `lab up` turns it on by default (--no-focus skips it); there is no `safari focus`
    blind: true,
    words: { on: 'on' },
    values: ['on'],
    valuesText: 'on',
    noun: 'Lab Focus',
    where: 'Lab Focus (Control Center > Focus)',
    write: setFocus,
    snapshot: () => 'unknown',
    entryExtra: phone => ({ off: focusConfig(phone).offShortcut }), // the Off shortcut to run is the one saved when On ran
    isEntry: e => isObj(e) && e.prior === 'unknown' && e.set === 'on' && isAt(e.at) && (e.off === undefined || isShortcutName(e.off)),
    plan: () => ({ expected: 'off', steps: ['off'], exact: false, note: FOCUS_NOTE }),
    byHand: () => 'turn Lab Focus off by hand (Control Center > Focus)',
    priorLabel: () => 'off',
    found: () => 'Lab Focus (the lab cannot read its state)',
    note: FOCUS_NOTE,
  },
};

export const KINDS = Object.keys(SETTINGS);
// The kinds with a `safari <kind>` command and a `lab up --<kind>` flag.
export const COMMAND_KINDS = KINDS.filter(k => SETTINGS[k].command !== false);

// The words a `safari <kind>` command and the `lab up --<kind>` flag take.
export const settingWords = kind => Object.keys(SETTINGS[kind].words);
export const settingUsage = kind => settingWords(kind).join('|');

// What a person checks by hand when a record is dropped.
export const CHECK_BY_HAND = KINDS.map(k => SETTINGS[k].where).join(' and ');
const NOUNS = KINDS.map(k => SETTINGS[k].noun).join(' and ');

const DAMAGED = `the saved record of phone settings to put back is damaged: run \`${FORGET}\`, then check ${CHECK_BY_HAND} on the phone by hand`;

// --- the record ---

// state.phoneRestore = { udid, <kind>?: { prior, set, at } for each kind in SETTINGS }, or null when nothing is pending;
// throws the damaged-record message when it is not that shape.
export function readRestore(state) {
  const r = state?.phoneRestore;
  if (r === undefined || r === null) return null;
  const ok = isObj(r) && isUdid(r.udid)
    && Object.keys(r).every(k => k === 'udid' || KINDS.includes(k))
    && KINDS.some(k => r[k] !== undefined)
    && KINDS.every(k => r[k] === undefined || SETTINGS[k].isEntry(r[k]));
  if (!ok) throw new Error(DAMAGED);
  return structuredClone(r);
}

export const pendingKinds = ledger => KINDS.filter(k => ledger?.[k] !== undefined);

function putKind(udid, kind, entry) {
  const ledger = readRestore(loadState()) ?? { udid };
  saveState({ phoneRestore: { ...ledger, udid, [kind]: entry } });
}

function dropKind(kind) {
  const ledger = readRestore(loadState());
  if (!ledger) return;
  const rest = { ...ledger };
  delete rest[kind];
  saveState({ phoneRestore: pendingKinds(rest).length ? rest : null });
}

// `lab phone restore --forget`: drops the record without touching the phone.
export function forgetRestore() {
  const state = loadState();
  let names = [];
  try { names = pendingKinds(readRestore(state)); } catch { names = ['(damaged record)']; }
  const had = state.phoneRestore !== undefined && state.phoneRestore !== null;
  if (had) saveState({ phoneRestore: null });
  return { forgot: had, forgotten: names };
}

// What `lab status` shows: names only.
export function pendingNames(state) {
  try { return pendingKinds(readRestore(state)); } catch (e) { return { damaged: true, error: e.message }; }
}

// --- reading back ---

async function readBack(read, matches) {
  let last;
  for (let i = 0; i < READ_BACK_TRIES; i++) {
    if (i > 0 && WAIT.readBackMs > 0) await sleep(WAIT.readBackMs);
    last = read();
    if (!last.ok) break; // an unreachable phone is not asked again
    if (matches(last.value)) return { ok: true, value: last.value };
  }
  return { ok: false, last };
}

const failed = (res, what) => needsError(res.needs ?? 'unknown', `${what}: ${res.error}`);

// The saved phone for these calls: the ledger (if any) must be for it.
function ledgerFor(phone) {
  if (!phone || !isUdid(phone.udid)) throw needsError('setup', 'no phone is saved, so there is no phone setting to change');
  const ledger = readRestore(loadState());
  if (ledger && ledger.udid !== phone.udid) {
    throw new Error(`the phone settings waiting to be put back belong to another phone than the saved one: run \`${FORGET}\` to drop them`);
  }
  return ledger;
}

// --- changing ---

// Sets `kind` to `want` (a value the kind's set accepts) on the saved phone. Returns { [kind]: want, prior, changed, pending }.
export async function changeSetting(kind, phone, want) {
  const s = SETTINGS[kind];
  if (!s.values.includes(want)) throw new Error(`${kind}: "${want}" is not ${s.valuesText}`);
  const ledger = ledgerFor(phone);
  const held = ledger?.[kind];
  if (s.blind) return changeBlind(kind, phone, want, held);
  const cur = s.read(phone.udid);
  if (!cur.ok) throw failed(cur, `won't change ${s.noun} it can't put back (${s.readDesc} could not be read)`);
  const prior = held?.prior ?? s.snapshot(cur.value); // an entry that is already there keeps its prior
  const why = held ? undefined : s.refuse?.(prior);
  if (why) throw new Error(why);
  if (s.key(cur.value) === want) {
    if (held) putKind(phone.udid, kind, { ...held, set: want });
    return { [kind]: want, prior, changed: false, pending: held !== undefined };
  }
  putKind(phone.udid, kind, { prior, set: want, at: new Date().toISOString() }); // before the change is sent
  const sent = s.write(phone.udid, want);
  if (!sent.ok) throw failed(sent, `could not set ${s.noun} to ${want}`);
  const back = await readBack(() => s.read(phone.udid), v => s.key(v) === want);
  if (!back.ok) {
    if (back.last?.ok === false) throw failed(back.last, `could not read ${s.noun} back after setting ${want}`);
    const seen = s.key(back.last?.value);
    if (s.ignored && seen === s.key(cur.value)) {
      if (!held) dropKind(kind); // nothing changed, so nothing to put back
      throw s.ignored.change(want, seen);
    }
    throw new Error(s.mismatch(seen, want));
  }
  return { [kind]: want, prior, changed: true, pending: true };
}

// A kind whose state can't be read: the entry (the prior is "unknown") is written first, then the change is sent; there is
// no read-back. A change that was not delivered leaves no entry behind (unless it timed out: it may have run).
function changeBlind(kind, phone, want, held) {
  const s = SETTINGS[kind];
  const prior = held?.prior ?? s.snapshot();
  putKind(phone.udid, kind, { prior, set: want, at: new Date().toISOString(), ...s.entryExtra?.(phone) });
  const sent = s.write(phone.udid, want, phone);
  if (!sent.ok) {
    if (!held && !sent.maybeSent) dropKind(kind);
    throw failed(sent, `could not set ${s.noun} to ${want}`);
  }
  return { [kind]: want, prior, changed: true, pending: true };
}

export const changeAppearance = (phone, want) => changeSetting('appearance', phone, want);
export const changeOrientation = (phone, want) => changeSetting('orientation', phone, want);
export const changeFocus = phone => changeSetting('focus', phone, 'on');

// --- looking ---

// `safari <kind> status`: the phone's reading and what the lab has waiting.
export function settingStatus(kind, phone) {
  const s = SETTINGS[kind];
  const entry = ledgerFor(phone)?.[kind];
  const cur = s.read(phone.udid);
  if (!cur.ok) throw failed(cur, `could not read ${s.noun}`);
  return { ...s.status(cur.value), pending: entry !== undefined, ...(entry ? { prior: entry.prior, set: entry.set } : {}) };
}

export const appearanceStatus = phone => settingStatus('appearance', phone);
export const orientationStatus = phone => settingStatus('orientation', phone);

// --- putting back ---

const keptResult = (kind, entry, res, why) => ({
  restored: false,
  error: redactMessage(`${why}: ${res.error}`),
  ...(res.needs ? { needs: res.needs } : {}),
  human: [`The ${kind} was not put back to ${SETTINGS[kind].priorLabel(entry)} (${redactMessage(res.error, 160)}). If the phone is locked or out of reach, unlock it and run \`lab phone restore\` (the next \`lab up\` and \`lab down\` try again too); or ${SETTINGS[kind].byHand(entry)}.`],
  unreachable: (res.needs !== undefined && res.needs !== 'unknown') || /timed out/.test(res.error ?? ''),
});

async function restoreSetting(kind, phone, entry) {
  const udid = phone.udid;
  const s = SETTINGS[kind];
  const { expected, steps, exact, note } = s.plan(entry);
  const done = changed => ({ restored: true, changed, restoredExactly: exact, ...(note ? { note } : {}) });
  if (s.blind) { // nothing to compare with and nothing to read back: the entry goes once the write was delivered
    for (const value of steps) {
      const sent = s.write(udid, value, phone, entry);
      if (!sent.ok) return keptResult(kind, entry, sent, `could not set ${s.noun} back to ${value}`);
    }
    dropKind(kind);
    return done(true);
  }
  const cur = s.read(udid);
  if (!cur.ok) return keptResult(kind, entry, cur, `could not read ${s.noun}`);
  const now = s.key(cur.value);
  if (now === expected) { dropKind(kind); return done(false); }
  if (now !== entry.set) {
    dropKind(kind);
    return { restored: false, ownerChanged: true, note: s.ownerNote(entry, now) };
  }
  for (const value of steps) {
    const sent = s.write(udid, value);
    if (!sent.ok) return keptResult(kind, entry, sent, `could not set ${s.noun} back to ${value}`);
  }
  const back = await readBack(() => s.read(udid), v => s.key(v) === expected);
  if (!back.ok) {
    const why = `${s.noun} was not confirmed`;
    if (back.last?.ok === false) return keptResult(kind, entry, back.last, why);
    const seen = s.key(back.last?.value);
    const kept = keptResult(kind, entry, { error: s.backMismatch(seen, expected) }, why);
    if (s.ignored && seen === now) Object.assign(kept, s.ignored.restore(entry, expected, seen)); // the entry stays
    return kept;
  }
  dropKind(kind);
  return done(true);
}

// Puts back whatever the ledger holds (`only`: one kind). Never throws but for an interrupt (the entry stays and the
// next stop, up or `lab phone restore` finishes it). Returns { pending: false } when there was nothing to do, else
// { pending: true, restored, <kind>?, human? }. `restored` is true when every pending kind was put
// back or deliberately left (the owner changed it). A phone that can't be reached, a locked phone, a record for
// another phone: reported, the entry kept, not a failure of the caller.
export async function restorePending({ only } = {}) {
  const state = loadState();
  let ledger;
  try { ledger = readRestore(state); } catch (e) { return { pending: true, restored: false, human: [e.message], error: e.message }; }
  if (!ledger) return { pending: false };
  const kept = (why, human) => ({ pending: true, restored: false, error: why, human: [human ?? why], ...Object.fromEntries(pendingKinds(ledger).map(k => [k, { restored: false, error: why }])) });
  let phone = null;
  try { phone = readPhone(state); } catch { /* damaged: handled below */ }
  if (!phone) return kept('no phone is saved, so the lab cannot put the phone\'s settings back', `The lab changed the phone's settings but no phone is saved now, so it cannot put them back. Save the phone again (\`lab phone setup\`) or run \`${FORGET}\` and set ${NOUNS} by hand.`);
  if (phone.udid !== ledger.udid) return kept('the settings waiting to be put back belong to another phone than the saved one', `The settings waiting to be put back belong to another phone than the saved one: run \`${FORGET}\` to drop them, and check that phone by hand.`);

  const kinds = pendingKinds(ledger).filter(k => only === undefined || k === only);
  if (!kinds.length) return { pending: false };
  const out = { pending: true, restored: true };
  let reachable = true;
  for (const kind of kinds) {
    if (!reachable) {
      out[kind] = { restored: false, error: 'not tried: the phone did not answer the call before', human: [`The ${kind} was not put back; the phone did not answer. Run \`lab phone restore\` when it is unlocked, or ${SETTINGS[kind].byHand(ledger[kind])}.`] };
      continue;
    }
    try { out[kind] = await restoreSetting(kind, phone, ledger[kind]); } catch (e) {
      if (e instanceof InterruptError) throw e;
      out[kind] = { restored: false, error: redactMessage(e.message), human: [`The ${kind} could not be put back (${redactMessage(e.message, 160)}); ${SETTINGS[kind].byHand(ledger[kind])}.`] };
    }
    if (out[kind].unreachable) reachable = false;
    delete out[kind].unreachable;
  }
  const done = KINDS.filter(k => out[k]).every(k => out[k].restored || out[k].ownerChanged);
  out.restored = done;
  return out;
}

// The lines for a person from a restorePending result (each failed kind carries its own).
export const restoreHuman = r => (r?.human ?? []).concat(KINDS.flatMap(k => r?.[k]?.human ?? []));

// The fields every command adds to its output for a restore that found something to do.
export function restoreReport(r) {
  if (!r?.pending) return {};
  const kinds = Object.fromEntries(KINDS.filter(k => r[k]).map(k => [k, r[k]]));
  const inexact = KINDS.some(k => r[k]?.restored && r[k].restoredExactly === false);
  const human = restoreHuman(r);
  return {
    phoneRestored: r.restored,
    phoneRestore: { ...kinds, ...(r.human ? { human: r.human } : {}) }, // restoreHuman(phoneRestore) gives the lines again
    ...(inexact ? { restoredExactly: false } : {}),
    ...(r.error && !KINDS.some(k => r[k]) ? { phoneRestoreNote: r.error } : {}),
    ...(human.length ? { human } : {}),
  };
}
