// Safari's native accessibility tree, as `mobile: source` returns it (WebDriverAgent XML, read
// from the web context so the session never leaves the page). Pure: no network, no state.

// One decoding pass, so `&amp;lt;` stays `&lt;` and a numeric reference that is not a code
// point is left as written.
export function xmlText(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|apos|lt|gt|amp);/g, (whole, e) => {
    if (e[0] !== '#') return { quot: '"', apos: '\'', lt: '<', gt: '>', amp: '&' }[e];
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

// A number from an attribute; a missing, empty or malformed one is NaN, never 0.
const num = s => (s === undefined || s === '' ? NaN : Number(s));

// Every element of the XML as { type, label, x, y, width, height } (the tag name, the label
// or '', and the rectangle in points; NaN where a number is missing or not one). Quotes are
// respected, so a `>` inside an attribute value does not end the tag; attribute order does
// not matter. Fails closed: an `<XCUIElementType…` tag the reader can't take in (single
// quotes, an unquoted value) throws instead of vanishing, since a Safari control missing from
// the list would let the chrome guard pass a tap on it.
export function parseNodes(xml) {
  const nodes = [];
  const taken = []; // [start, end) of every tag read
  for (const tag of xml.matchAll(/<(\w+)((?:\s+[\w:.-]+="[^"]*")*)\s*\/?>/g)) {
    taken.push([tag.index, tag.index + tag[0].length]);
    const a = {};
    for (const m of tag[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) a[m[1]] = xmlText(m[2]);
    nodes.push({ type: tag[1], label: a.label ?? '', x: num(a.x), y: num(a.y), width: num(a.width), height: num(a.height) });
  }
  for (const open of xml.matchAll(/<XCUIElementType\w*/g)) {
    if (taken.some(([from, to]) => open.index >= from && open.index < to)) continue;
    // Attribute values are left out of the message: they can be page text.
    const near = xml.slice(open.index, open.index + 80).replace(/"[^"]*"?/g, '"…"').replace(/'[^']*'?/g, '\'…\'').replace(/=[^\s"'>/…]+/g, '=…').split('>')[0].slice(0, 50);
    throw new Error(`couldn't read Safari's native tree (malformed element near ${JSON.stringify(near)})`);
  }
  return nodes;
}

const CHROME_TYPES = ['XCUIElementTypeToolbar', 'XCUIElementTypeNavigationBar', 'XCUIElementTypeTabBar'];

// Safari's own controls. Page fields are text fields too, so they are not matched by type:
// the address bar is found by its label.
export const isChrome = n => CHROME_TYPES.includes(n.type) || n.label === 'TabBarItemTitle' || n.label === 'Address';
export const isProbe = (n, label) => n.label === label;
export const isDeleteKey = n => n.type === 'XCUIElementTypeKey' && n.label.toLowerCase() === 'delete';
export const isApplication = n => n.type === 'XCUIElementTypeApplication';

// The web view's element, with everything under it, as XML text. Safari's own tab bar and
// toolbar sit outside it and can hold the owner's other tabs' titles, so on the phone only this
// is ever kept. Safari nests web views inside each other (all full screen), so the outermost
// one is taken and those inside it come along as part of it. Throws (saying nothing of what the
// tree holds) when there is no web view, when there are several separate ones (nothing says
// which is the page), or when one can't be cut out whole.
export function webViewSubtree(xml) {
  const tops = [];
  let seen = 0, depth = 0, start = -1;
  for (const t of xml.matchAll(/<(\/?)(\w+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [whole, closing, name, , selfClosing] = t;
    const isView = name === 'XCUIElementTypeWebView';
    if (start < 0) {
      if (closing || !isView) continue;
      seen++;
      if (selfClosing) tops.push(whole);
      else { start = t.index; depth = 1; }
      continue;
    }
    if (isView && !closing) seen++;
    if (closing) depth--;
    else if (!selfClosing) depth++;
    if (depth === 0) {
      tops.push(xml.slice(start, t.index + whole.length));
      start = -1;
    }
  }
  const raw = (xml.match(/<XCUIElementTypeWebView(?![\w])/g) || []).length;
  if (start >= 0 || raw !== seen) throw new Error('Safari\'s native tree has a web view the lab can\'t read whole, so none of it was kept');
  if (tops.length !== 1) throw new Error(`Safari's native tree has ${tops.length} web views, none inside another, not exactly one, so none of it was kept`);
  return tops[0];
}
