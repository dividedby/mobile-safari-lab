// msl-page-pin: an Appium plugin that keeps a real-device Safari session on the page the client
// selected. Stock appium-xcuitest-driver (12.18.1) follows any page that appears while the
// session is in a web context (`onPageChange`), and `remote.execute` takes its target page when it
// is called, so a tab the owner opens can receive a lab script. Three layers, each closing that
// on its own (see docs/adr/0005-physical-iphone-via-appium.md):
//   1. a page-change handler that never selects: a page that appears is only logged, a page that
//      goes takes the session to the native context;
//   2. `remote.selectPage` runs only for the page a `setContext` being handled asked for;
//   3. `remote.execute` runs only when the page the driver holds is the one the client selected,
//      checked in the same tick the driver takes it.
// No imports: a `link:` install resolves from this folder, where Appium isn't installed. Logs
// carry page ids and counts only, never an address, a title or script text.

export const PIN = 1; // the value of the `msl:pagePin` capability the session answers with
export const EVENT = 'remote_debugger_page_change';
export const REFUSED = 'msl-page-pin: ';

const STATE = Symbol.for('msl-page-pin.state');
const WRAPPED = Symbol.for('msl-page-pin.wrapped');
const noop = () => {};

// "9.1", "WEBVIEW_9.1" -> { app: '9', page: 1 }; anything else (NATIVE_APP, "WEBVIEW", null) -> null.
export function parseContext(name) {
  if (typeof name !== 'string') return null;
  const s = name.replace(/^WEBVIEW_/, '');
  const i = s.lastIndexOf('.');
  const app = s.slice(0, i).replace(/^PID:/, '');
  const page = Number(s.slice(i + 1));
  return i > 0 && app && s.slice(i + 1) !== '' && Number.isInteger(page) ? { app, page } : null;
}

const appOf = id => String(id ?? '').replace(/^PID:/, '');
const same = (a, b) => !!a && !!b && a.app === b.app && a.page === b.page;
// The page a remote debugger currently holds.
const heldBy = remote => ({ app: appOf(remote._appIdKey), page: Number(remote._pageIdKey) });

// The driver's page-change handler while pinned (`this` is the driver). Never selects, never
// switches: the session stays on its page, or goes native when that page is gone.
export function pinnedPageChange(n) {
  const log = this[STATE]?.log ?? noop;
  if (!this.curContext) return; // native: nothing is attached, nothing to follow
  const cur = parseContext(this.curContext);
  if (!cur || appOf(n?.appIdKey) !== cur.app) return;
  const pages = Array.isArray(n.pageArray) ? n.pageArray : [];
  if (!pages.some(p => Number(p?.id) === cur.page)) {
    this.curContext = null;
    log(`${REFUSED}the selected page ${cur.page} went (${pages.length} pages left); the session is native`);
  } else {
    log(`${REFUSED}listing changed (${pages.length} pages); not following`);
  }
}

const refuse = (st, what, text) => {
  st.log(`${REFUSED}${what}`);
  return Promise.reject(new Error(`${REFUSED}${text}`));
};

function wrap(remote, name, make) {
  const orig = remote[name];
  if (typeof orig !== 'function') return false;
  if (orig[WRAPPED]) return true;
  const wrapper = make(orig);
  wrapper[WRAPPED] = true;
  remote[name] = wrapper;
  return true;
}

// Whether the driver and its current remote debugger are pinned: the handler is ours and the
// only listener, and the remote's `selectPage` and `execute` are wrapped.
export function verify(driver) {
  const r = driver?._remote;
  if (!driver?.[STATE] || driver.onPageChange !== pinnedPageChange || !r || typeof r.listeners !== 'function') return false;
  const on = r.listeners(EVENT);
  return on.length === 1 && on[0].name === `bound ${pinnedPageChange.name}` && r.selectPage?.[WRAPPED] === true && r.execute?.[WRAPPED] === true;
}

// Pins a driver: every later (re)connect binds our handler, and the live remote debugger gets
// ours as its only page-change listener plus the two wrappers. Gives whether it holds (verify).
// The first call also takes the page the driver holds as the selected one (the driver picked it
// when the session started, the lab's start check confirms it).
export function arm(driver, log = m => driver.log?.info?.(m)) {
  // The first selection is the page the driver picked itself when the session started: the lab's start
  // check runs without a setContext, and the lab's selectTab follows before any other script.
  const first = !driver[STATE];
  const st = driver[STATE] ??= { selected: null, allow: null, log };
  st.log = log;
  if (first) st.selected = parseContext(driver.curContext);
  driver.onPageChange = pinnedPageChange;
  const r = driver._remote;
  if (!r || typeof r.removeAllListeners !== 'function' || typeof r.on !== 'function') return false;
  r.removeAllListeners(EVENT);
  r.on(EVENT, pinnedPageChange.bind(driver));
  wrap(r, 'selectPage', orig => function (appIdKey, pageIdKey, ...rest) {
    const ask = { app: appOf(appIdKey), page: Number(pageIdKey) };
    if (!same(ask, st.allow)) return refuse(st, `selectPage refused page=${pageIdKey}`, 'Appium tried to select a page the lab did not ask for');
    return orig.call(this, appIdKey, pageIdKey, ...rest);
  });
  wrap(r, 'execute', orig => function (...args) {
    const held = heldBy(this);
    if (!same(held, st.selected)) return refuse(st, `evaluate refused page=${held.page}`, 'the session is not on the selected page');
    st.log(`${REFUSED}evaluate page=${held.page}`);
    return orig.apply(this, args);
  });
  return verify(driver);
}

// Before a command runs: a pinned driver whose remote debugger was replaced (a reconnect) is
// pinned again, or the command is refused. Drivers that were never pinned pass untouched.
// A reconnect through GET /contexts stays pinned (the handler is an instance property, so the new
// remote binds ours); its selectPage and execute are wrapped again here, at the next setContext or script.
function ensureArmed(driver) {
  if (!driver?.[STATE] || !driver._remote) return;
  if (verify(driver)) return;
  if (!arm(driver, driver[STATE].log)) throw new Error(`${REFUSED}the page pin could not be put back after Appium reconnected`);
}

export class PagePinPlugin {
  constructor(name) {
    this.name = name;
  }

  // `driver` is the umbrella driver; the session's own driver is `driver.sessions[id]`. The
  // answer is `{ value: [id, caps] }`, or `{ error }`. Only a real device that is verified
  // pinned gets the marker; the lab refuses a device session without it.
  async createSession(next, driver) {
    const res = await next();
    if (res?.error) return res;
    const [id, caps] = res?.value ?? [];
    const d = driver?.sessions?.[id];
    let pinned = false;
    try { pinned = !!d && d.isRealDevice?.() === true && arm(d); } catch (e) { d?.log?.warn?.(`${REFUSED}not armed: ${e.message}`); }
    if (pinned && caps && typeof caps === 'object') {
      caps['msl:pagePin'] = PIN;
      d.log?.info?.(`${REFUSED}armed session=${id}`);
    }
    return res;
  }

  // The only way the selected page changes: the page named is the one selectPage may take.
  async setContext(next, driver, name) {
    const st = driver?.[STATE];
    if (!st) return next();
    ensureArmed(driver);
    st.allow = parseContext(name);
    let res;
    try { res = await next(); } finally { st.allow = null; }
    st.selected = parseContext(driver.curContext);
    return res;
  }

  async execute(next, driver, script) {
    if (driver?.[STATE] && !/^mobile:/.test(String(script).trim())) ensureArmed(driver);
    return next();
  }

  // Async scripts reach the page through the remote debugger without `execute`.
  async executeAsync(next, driver) {
    if (driver?.[STATE]) throw new Error(`${REFUSED}async scripts are refused on a pinned session`);
    return next();
  }
}
