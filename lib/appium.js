// Appium-specific pieces of bin/safari: where it's installed, the session capabilities, and
// parsers for the console and network logs it returns. Pure functions; no I/O besides paths.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appiumHome = () => process.env.MSL_APPIUM_HOME || path.join(os.homedir(), '.local', 'share', 'msl-appium');
export const appiumBin = () => path.join(appiumHome(), 'node_modules', '.bin', 'appium');

// The lab's own Appium plugin (`msl-page-pin`, this repo's appium-plugin/), linked into the Appium home.
export const pluginDir = () => fileURLToPath(new URL('../appium-plugin', import.meta.url));
export const PLUGIN = 'msl-page-pin';
// What a device session's `msl:pagePin` capability must be: the plugin sets it once it has pinned the session.
export const PAGE_PIN = 1;

// The words for a missing page pin, shared by the status issue, the refusals and the steps for a person.
export const PIN_RISK = 'a Safari tab opened on the phone could pull the session into it';
export const PIN_MISSING = 'Appium is running without the lab\'s page pin plugin';
// The steps for a person when the page pin is missing (the `service` steps speak of log redaction).
export const PIN_HUMAN = [
  `${PIN_MISSING}, so ${PIN_RISK} while the lab works.`,
  `Make sure the plugin is installed (\`pnpm add link:${pluginDir()}\` in ${appiumHome()}), then run \`lab service install\` (again, if it is installed).`,
];

export const INSTALL_HINT = `Appium isn't installed. Run: \`mkdir -p ~/.local/share/msl-appium && cd ~/.local/share/msl-appium && pnpm add appium@3.8.0 appium-xcuitest-driver@12.18.1\` and, in the same folder, \`pnpm add link:${pluginDir()}\` (the lab's page pin plugin), then \`APPIUM_HOME=~/.local/share/msl-appium ~/.local/share/msl-appium/node_modules/.bin/appium driver list --installed\` should list xcuitest and \`... appium plugin list --installed\` msl-page-pin.`;

// The simulator's session create: the lab's limit on `POST /session` (safari.js), and the Appium
// timeouts inside it, which must end sooner so Appium reports the failure itself (the lab can then retry)
// instead of going on after the lab has given up. Appium's worst case is not the sum of the caps:
// xcuitest tries WebDriverAgent's launch `wdaStartupRetries` times, `wdaStartupRetryInterval` apart, and each
// attempt polls `/status` once per `wdaLaunchTimeout / 500` (appium-webdriveragent xcodebuild.js waitForStart:
// `Math.trunc(timeout / 500)` retries, a 1 s sleep after each failed poll, and each poll is limited to 1 s: lines
// 472-483). A poll costs ~1.2 s when the port refuses at once (measured 2026-10-20: a 270 s cap ran ~620 s) and up
// to 2 s when WebDriverAgent accepts and hangs, so an attempt runs 2.4 to 4 times its cap.
// `wdaConnectionTimeout` bounds the first WebDriverAgent call after a launch; `webviewConnectTimeout` the wait for
// Safari's pages.
export const SIM_CREATE_MS = 420e3;
export const SIM_WDA_LAUNCH_MS = 30e3;
export const SIM_WDA_STARTUP_RETRIES = 2;
export const SIM_WDA_RETRY_INTERVAL_MS = 10e3;
export const SIM_WDA_CONNECT_MS = 90e3;
export const SIM_WEBVIEW_CONNECT_MS = 30e3;
// The slowest a `/status` poll can be: accepted but unanswered (1 s limit) plus the 1 s sleep. A refused port takes ~1.2 s.
export const WDA_POLL_WORST_MS = 2000;

// The longest a simulator session create can run inside Appium: every launch attempt, the waits between
// them, one connection wait and the webview wait. Must stay under SIM_CREATE_MS (asserted by a test).
export const simCreateWorstMs = () => {
  const attempt = Math.ceil(SIM_WDA_LAUNCH_MS / 500) * WDA_POLL_WORST_MS;
  return SIM_WDA_STARTUP_RETRIES * attempt + (SIM_WDA_STARTUP_RETRIES - 1) * SIM_WDA_RETRY_INTERVAL_MS
    + SIM_WDA_CONNECT_MS + SIM_WEBVIEW_CONNECT_MS;
};

// Where WebDriverAgent's web server listens. It has no authentication and answers any origin, and
// without `USE_IP` it binds every interface (appium-webdriveragent WebDriverAgentLib/Routing/
// FBWebServer.m:93-98, FBConfiguration.m:139-145), so anyone on the Wi-Fi could drive the phone, and
// the Mac's LAN could drive the simulator (it shares the Mac's network stack). xcuitest turns the
// `appium:wdaBindingIP` capability into `USE_IP` (xcodebuild.js:432-433, wda-strategies.js:236-237,
// utils/xctestrun.js:getAdditionalRunContent) and uses it as the host it dials (webdriveragent.js:189).
// Over the cable the usbmux forward reaches the phone's loopback (checked live 2026-10-20, item 23).
// Over Wi-Fi (the tunnel, issue 15) WebDriverAgent binds the tunnel address instead (see appiumDeviceCaps).
export const WDA_BINDING_IP = '127.0.0.1';

// remotexpc's tunnel registry, from the lab's Appium install: its package exports only `.`, so the
// tunnel host imports the file by URL. Tied to appium-xcuitest-driver 12.18.1's layout (nested node_modules).
export const registryModule = () => path.join(appiumHome(), 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-ios-remotexpc', 'build', 'src', 'index.js');

// What `sim doctor` and `lab status` say when the registry is not there.
export const registryHint = () => `Wi-Fi needs remotexpc's tunnel registry from appium-xcuitest-driver 12.18.1, and it is not at ${registryModule()}. Install the pinned Appium again, then \`lab service install\`: ${INSTALL_HINT}`;

// WebDriverAgent on the phone over the tunnel: its port and the URL of a tunnel address. `WDA.url`
// is what the lab polls; tests swap it (they have no tunnel), so the capabilities use `wdaUrl`.
export const wdaUrl = address => `http://[${address}]:${WDA.port}`;
export const WDA = { port: 8100, url: wdaUrl };

// W3C alwaysMatch capabilities for Safari on the saved simulator. The first session builds
// WebDriverAgent (~2 min); derivedDataPath keeps that build for the next ones. `keepData` is the
// configured profile: `noReset` stops the driver scrubbing Safari at session start (its default),
// so sign-ins made by hand survive. The clean profile keeps the default: Safari is fresh each session.
export function appiumCaps(udid, { keepData = false } = {}) {
  return {
    platformName: 'iOS',
    browserName: 'Safari',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:derivedDataPath': path.join(appiumHome(), 'wda'),
    'appium:newCommandTimeout': 1800,
    'appium:webviewConnectTimeout': SIM_WEBVIEW_CONNECT_MS,
    'appium:showSafariConsoleLog': true,
    'appium:showSafariNetworkLog': true,
    'appium:wdaLaunchTimeout': SIM_WDA_LAUNCH_MS,
    'appium:wdaStartupRetries': SIM_WDA_STARTUP_RETRIES,
    'appium:wdaStartupRetryInterval': SIM_WDA_RETRY_INTERVAL_MS,
    'appium:wdaConnectionTimeout': SIM_WDA_CONNECT_MS,
    'appium:wdaBindingIP': WDA_BINDING_IP,
    ...(keepData ? { 'appium:noReset': true } : {}),
  };
}

// W3C alwaysMatch capabilities for Safari on the physical iPhone. WebDriverAgent is built and
// signed with the owner's own team under a bundle id of their own; derivedData is the phone's
// build cache, separate from the simulator's. Neither showSafariConsoleLog nor showSafariNetworkLog:
// Safari's logs hold every tab's messages and traffic, so console and network come from collectors
// the lab runs in its own page.
// Over the tunnel (`tunnel`, the tunnel record) the lab has already started WebDriverAgent bound to
// the tunnel address: Appium is pointed at it (webDriverAgentUrl), with the iOS version it would
// otherwise read through usbmux, and none of the build and signing capabilities.
// The cable caps must not set `useNewWDA`: the driver then uninstalls WebDriverAgent at the start of every
// session (prepareForXcodebuild), and removing the developer's last app on the phone drops the phone's trust
// for that developer, so every session launched an untrusted app (exit 65, issue 58). Without it the driver keeps
// the runner whose bundle id is `updatedWDABundleId`, and xcodebuild builds only what changed.
export function appiumDeviceCaps({ udid, teamId, bundleId, derivedData, tunnel, platformVersion }) {
  if (tunnel) {
    return {
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      'appium:udid': udid,
      ...(platformVersion ? { 'appium:platformVersion': platformVersion } : {}),
      'appium:webDriverAgentUrl': wdaUrl(tunnel.address),
      'appium:noReset': true,
      'appium:safariInitialUrl': '',
      'appium:wdaLaunchTimeout': 600000,
      'appium:wdaConnectionTimeout': 600000,
      'appium:wdaBindingIP': tunnel.address,
      'appium:newCommandTimeout': 1800,
      'appium:showXcodeLog': true,
    };
  }
  return {
    platformName: 'iOS',
    browserName: 'Safari',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:xcodeOrgId': teamId,
    'appium:xcodeSigningId': 'Apple Development',
    'appium:updatedWDABundleId': bundleId,
    'appium:allowProvisioningDeviceRegistration': true,
    'appium:derivedDataPath': derivedData,
    'appium:noReset': true,
    'appium:safariInitialUrl': '',
    'appium:wdaLaunchTimeout': 600000,
    'appium:wdaConnectionTimeout': 600000,
    'appium:wdaBindingIP': WDA_BINDING_IP,
    'appium:newCommandTimeout': 1800,
    'appium:showXcodeLog': true,
  };
}

// Rules for Appium's `--log-filters` (the service writes them to a file): at info level Appium
// logs page URLs and titles, which shouldn't land in ~/Library/Logs. Each rule is a regular
// expression, its flags and what replaces a match.
//
// The first three keep typed text and storage values out of the log. Appium logs every request
// body on one line, `--> POST <url> {json}`, cut at 1024 characters (`…`); at debug level also
// `Calling X.cmd() with args: [json]`, the remote debugger's `Executing atom 'a' with
// 'args=[json]; frames='` (not cut) and the proxy's `Proxying [POST /wda/keys] to [...] with body:
// {json}`. Script arguments, the text of `/element/:id/value` and those bodies are secrets, so each
// rule masks from the key to the end of the line rather than matching a value: the value's quotes,
// brackets or a cut-off body can't end a match early. The route rule needs a `{` body after the
// URL, so the `<--` line (status, time) survives.
export const LOG_FILTERS = [
  { pattern: String.raw`((?:"args"|\bargs)\s*[:=]\s*)[^\r\n]*`, flags: 'g', replacer: '$1<redacted>' },
  { pattern: String.raw`(\bwith body:\s*)[^\r\n]*`, flags: 'g', replacer: '$1<redacted>' },
  { pattern: String.raw`(/element/[^\s/]+/value\S*\s(?:\x1b\[[0-9;]*m)*)\{[^\r\n]*`, flags: 'g', replacer: '$1<redacted>' },
  { pattern: String.raw`(https?|wss?|file|about|blob|data):[^\s"'\\,)\]}]+`, flags: 'g', replacer: '<url>' },
  { pattern: String.raw`("?(title|pageTitle|url|href|pageUrl)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)`, flags: 'gi', replacer: '$1<redacted>' },
];

// --- console ---

// Appium keeps the last 5000 raw entries of each log (an LRU, emptied only when read) and
// drops the older ones silently, so a read of that many entries may have lost some.
export const LOG_CAP = 5000;

// How many times the most repeated message came in: about one per Web Inspector listener
// Appium has added (see rawMessage).
const maxCopies = counts => { let m = 0; for (const n of counts.values()) if (n > m) m = n; return m; };

// WebDriverAgent's own web server; its favicon 404s and the like show up in Safari's log.
const WDA_ORIGIN = 'http://127.0.0.1:8100';

const originOf = u => { try { return new URL(u).origin; } catch { return null; } };

// Counts each raw message across the list and calls onFirst(raw) on its first sighting only.
// Gives the number of repeats skipped, whether the log reached LOG_CAP, and the most copies of one.
function tallyCopies(list, onFirst) {
  const seen = new Map();
  let dupes = 0;
  for (const raw of list) {
    const key = rawMessage(raw);
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) > 1) { dupes++; continue; } // one copy per listener Appium has added
    onFirst(raw);
  }
  return { dupes, full: list.length >= LOG_CAP, copies: maxCopies(seen) };
}

// The raw text of a log entry's message, the key for dropping copies. Appium adds another
// Web Inspector listener on every web/native context switch, so one message arrives once
// per switch so far, byte-identical (same timestamp and column). Two genuine identical
// calls differ in those, so exact comparison keeps them apart.
const rawMessage = raw => {
  const msg = raw && typeof raw === 'object' && 'message' in raw ? raw.message : raw;
  return typeof msg === 'string' ? msg : JSON.stringify(msg) ?? '';
};

// Appium returns each console message as { message: '<JSON>', ... }. Gives
// { entries: [{ level, text, source, url, line }], dropped, full, copies } with copies,
// WebDriverAgent's own messages dropped (first occurrence kept, order kept) and query secrets
// masked. `full`: the log reached LOG_CAP, so older entries may be gone; `copies`: the most
// times one message repeated.
export function parseConsole(entries) {
  const out = [];
  let wda = 0;
  const list = Array.isArray(entries) ? entries : [];
  const { dupes, full, copies } = tallyCopies(list, raw => {
    const e = parseConsoleEntry(raw);
    if (originOf(e.url) === WDA_ORIGIN) { wda++; return; }
    e.text = redactUrl(e.text);
    if (typeof e.url === 'string') e.url = redactUrl(e.url);
    out.push(e);
  });
  return { entries: out, dropped: dupes + wda, full, copies };
}

function parseConsoleEntry(raw) {
  const msg = raw && typeof raw === 'object' && 'message' in raw ? raw.message : raw;
  let v = msg;
  if (typeof msg === 'string') { try { v = JSON.parse(msg); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { level: 'log', text: typeof msg === 'string' ? msg : JSON.stringify(msg) ?? '' };
  }
  const e = { level: typeof v.level === 'string' ? v.level : 'log', text: typeof v.text === 'string' ? v.text : String(v.text ?? '') };
  for (const k of ['source', 'url', 'line']) if (v[k] !== undefined) e[k] = v[k];
  return e;
}

// --- network ---

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const SECRET_PARAMS = ['token', 'access_token', 'id_token', 'key', 'k', 'apikey', 'api_key', 'password', 'passwd', 'secret', 'signature', 'sig', 'code', 'session', 'auth'];
const REDACTED = '[redacted]';

const PARAM = new RegExp(`([?&#;])(${SECRET_PARAMS.join('|')})=[^&#\\s"'\\\\]*`, 'gi');
const RAW_HEADER = /((?:set-cookie|proxy-authorization|cookie|authorization|postData)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\r\n]*)/gi;

// Masks the values of secret query/fragment parameters in a URL-like string.
export const redactUrl = s => s.replace(PARAM, `$1$2=${REDACTED}`);

// Whatever was thrown, as an Error: a primitive (`throw 'x'`, `throw undefined`) has no `message` to print and
// can't carry `failedStep` or `extra` (assigning to it throws in strict mode), so it becomes one.
export const asError = e => (e !== null && typeof e === 'object' ? e : new Error(errorText(e)));

// The text a failed command prints as `error`: never empty. An empty or blank message falls back to the
// `cause`'s, then to the error's name (`AbortError`), then to a fixed line.
export function errorText(e) {
  const str = x => (['string', 'number', 'boolean', 'bigint'].includes(typeof x) ? String(x).trim() : '');
  const find = (x, depth) => {
    if (x === null || typeof x !== 'object') return str(x);
    return str(x.message) || (depth < 3 ? find(x.cause, depth + 1) : '') || (x.name === 'Error' ? '' : str(x.name));
  };
  return redactUrl(find(e, 0) || 'failed without a message');
}

// Removes what shouldn't reach a file or a transcript: cookie and authorization headers
// (any depth, any case), request bodies (`postData`), and secret values in URLs. Returns a
// copy.
export function redact(value) {
  // URLs, absolute or relative (a `Location: /cb?code=…` header), but not free text.
  if (typeof value === 'string') return !/\s/.test(value) || /^https?:\/\//i.test(value) ? redactUrl(value) : value;
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  // { name: 'Cookie', value: '…' } pairs, in case headers come as a list.
  const pair = typeof value.name === 'string' && SECRET_HEADERS.has(value.name.toLowerCase());
  for (const [k, v] of Object.entries(value)) {
    if (k === 'postData' || k === '__proto__') continue;
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) || (pair && k === 'value') ? REDACTED : redact(v);
  }
  return out;
}

const scrubRaw = s => redactUrl(s.replace(RAW_HEADER, `$1"${REDACTED}"`));

// Safari's network log arrives as Web Inspector events inside { message: '<JSON>' }:
// { method: 'Network.requestWillBeSent', event: { requestId, request: { url, method, headers }, … } }
// (`params` in the raw protocol, accepted too). Gives the redacted events and a request
// summary in order of first sight, without WebDriverAgent's own traffic, plus `full` (the log
// reached LOG_CAP, so older entries may be gone) and `copies` (most repeats of one event).
// Tolerant: absent fields come out null.
export function parseNetwork(entries) {
  const all = [];
  const list = Array.isArray(entries) ? entries : [];
  const { dupes, full, copies } = tallyCopies(list, raw => {
    const msg = raw && typeof raw === 'object' && 'message' in raw ? raw.message : raw;
    let v = msg;
    if (typeof msg === 'string') { try { v = JSON.parse(msg); } catch { v = null; } }
    if (v && typeof v === 'object') all.push(redact(v));
    else all.push({ raw: scrubRaw(typeof msg === 'string' ? msg : JSON.stringify(msg) ?? '') });
  });
  const payload = ev => {
    const e = typeof ev.method !== 'string' && ev.message && typeof ev.message === 'object' ? ev.message : ev;
    const p = e.event && typeof e.event === 'object' ? e.event : e.params;
    return { method: e.method, p: p && typeof p === 'object' && p.requestId !== undefined ? p : null };
  };
  const urlOf = ({ method, p }) => (method === 'Network.responseReceived' ? p.response?.url : p.request?.url) ?? p.request?.url ?? p.response?.url;
  const wda = new Set();
  for (const ev of all) {
    const x = payload(ev);
    if (x.p && originOf(urlOf(x)) === WDA_ORIGIN) wda.add(String(x.p.requestId));
  }
  const events = all.filter(ev => { const x = payload(ev); return !(x.p && wda.has(String(x.p.requestId))); });
  const byId = new Map();
  for (const ev of events) {
    const { method, p } = payload(ev);
    if (!p) continue;
    const id = String(p.requestId);
    if (!byId.has(id)) byId.set(id, { method: null, url: null, status: null });
    const r = byId.get(id);
    if (method === 'Network.requestWillBeSent') {
      r.method = p.request?.method ?? r.method;
      r.url = p.request?.url ?? r.url;
    } else if (method === 'Network.responseReceived') {
      r.status = p.response?.status ?? r.status;
      r.url = r.url ?? p.response?.url ?? null;
    }
  }
  return { events, requests: [...byId.values()], dropped: dupes + all.length - events.length, full, copies };
}
