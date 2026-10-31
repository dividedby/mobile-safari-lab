// PNG in pure Node (node:zlib): decode, crop, scale down and encode the screenshots `safari shot`
// is asked to cut. 8-bit RGB and RGBA only, which is what Appium's screenshots are; anything
// else is refused by name rather than guessed at. No dependencies, no state.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PNG_LIMITS = { side: 16384, pixels: 100e6 };
// Chunks that say how the colours are meant to look. A phone shot carries its own (sRGB on iOS
// 27.0.1; a wide-gamut profile would be washed out if dropped), so the source's are kept; text,
// EXIF and the rest are not.
const KEPT = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP']);
const COLOUR_TYPES = { 0: 'grayscale', 2: 'RGB', 3: 'palette', 4: 'grayscale with alpha', 6: 'RGBA' };

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(...parts) {
  let c = 0xffffffff;
  for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const chunk = (type, data) => {
  const t = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(t, data), 8 + data.length);
  return out;
};

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// { width, height, channels (3 or 4), data (rows of width * channels bytes), chunks (the colour
// chunks kept, as { type, data }) } from a PNG file's bytes. Throws, naming what is wrong, for
// a file that isn't a PNG, is damaged or cut short, or isn't 8-bit non-interlaced RGB or RGBA.
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('the screenshot is not a PNG');
  let pos = 8, header = null, ended = false;
  const idat = [], chunks = [];
  while (!ended) {
    if (pos + 12 > buf.length) throw new Error('the screenshot PNG is cut short');
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + length > buf.length) throw new Error('the screenshot PNG is cut short');
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (crc32(buf.subarray(pos + 4, pos + 8), data) !== buf.readUInt32BE(pos + 8 + length)) throw new Error(`the screenshot PNG is damaged (bad checksum in its ${/^[A-Za-z]{4}$/.test(type) ? type : 'unnamed'} chunk)`);
    pos += 12 + length;
    if (!header && type !== 'IHDR') throw new Error('the screenshot PNG does not start with its header');
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('the screenshot PNG has a bad header');
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9], compression: data[10], filter: data[11], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else if (KEPT.has(type)) chunks.push({ type, data: Buffer.from(data) });
  }
  const { width, height, depth, colour, interlace } = header;
  if (!(colour === 2 || colour === 6) || depth !== 8) {
    throw new Error(`the screenshot is a ${COLOUR_TYPES[colour] ?? 'unknown'} PNG (colour type ${colour}, ${depth}-bit); only 8-bit RGB and RGBA can be cropped`);
  }
  if (interlace !== 0) throw new Error('the screenshot is an interlaced PNG; only non-interlaced ones can be cropped');
  if (header.compression !== 0 || header.filter !== 0) throw new Error('the screenshot PNG has an unknown compression or filter method');
  if (!(width > 0) || !(height > 0) || width > PNG_LIMITS.side || height > PNG_LIMITS.side || width * height > PNG_LIMITS.pixels) {
    throw new Error(`the screenshot is ${width}x${height} px, over the limit of ${PNG_LIMITS.side} px a side and ${PNG_LIMITS.pixels / 1e6} megapixels`);
  }
  if (!idat.length) throw new Error('the screenshot PNG has no image data');
  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw new Error('the screenshot PNG\'s image data is damaged or larger than its header says');
  }
  if (raw.length !== expected) throw new Error('the screenshot PNG\'s image data is cut short');
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('the screenshot PNG uses an unknown row filter');
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? data[dst + i - channels] : 0;
      const above = y ? data[up + i] : 0;
      const aboveLeft = y && i >= channels ? data[up + i - channels] : 0;
      const add = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >> 1 : paeth(left, above, aboveLeft);
      data[dst + i] = (raw[src + i] + add) & 0xff;
    }
  }
  return { width, height, channels, data, chunks };
}

// The pixels inside { x, y, width, height } (whole pixels, wholly inside the picture).
export function cropPng(img, { x, y, width, height }) {
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > img.width || y + height > img.height) {
    throw new Error(`the crop ${JSON.stringify({ x, y, width, height })} is not inside the ${img.width}x${img.height} screenshot`);
  }
  const { channels } = img;
  const data = Buffer.alloc(width * height * channels);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * img.width + x) * channels;
    img.data.copy(data, row * width * channels, from, from + width * channels);
  }
  return { ...img, width, height, data };
}

// The picture shrunk to `width` pixels across (the height keeps the shape), each new pixel the
// average of the area it covers (a box filter, with fractions of the pixels at the edges). RGBA
// is averaged with its colours weighted by alpha, so a see-through pixel does not tint its
// neighbours. Down only: a larger width is refused.
export function scalePng(img, width) {
  if (!Number.isInteger(width) || width < 1) throw new Error('the new width must be a whole number of pixels');
  if (width > img.width) throw new Error(`the new width (${width} px) is larger than the picture (${img.width} px); only shrinking is supported`);
  if (width === img.width) return img;
  const height = Math.max(1, Math.round(img.height * width / img.width));
  const { channels } = img;
  const alpha = channels === 4;
  // The boxes along one axis: for each new pixel, the old ones it covers and how much of each.
  const boxes = (from, to) => {
    const span = from / to;
    return Array.from({ length: to }, (_, d) => {
      const lo = d * span, hi = lo + span, list = [];
      for (let s = Math.floor(lo); s < Math.min(from, Math.ceil(hi - 1e-9)); s++) {
        const w = Math.min(hi, s + 1) - Math.max(lo, s);
        if (w > 0) list.push([s, w / span]);
      }
      return list;
    });
  };
  // Colour premultiplied by alpha (0..255 scale), so a see-through pixel does not tint its neighbours.
  const premult = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i += channels) {
    const a = alpha ? img.data[i + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) premult[i + c] = img.data[i + c] * a;
    if (alpha) premult[i + 3] = img.data[i + 3];
  }
  const across = new Float32Array(width * img.height * channels);
  boxes(img.width, width).forEach((list, d) => {
    for (const [s, w] of list) {
      for (let y = 0; y < img.height; y++) {
        const from = (y * img.width + s) * channels, to = (y * width + d) * channels;
        for (let c = 0; c < channels; c++) across[to + c] += premult[from + c] * w;
      }
    }
  });
  const down = new Float32Array(width * height * channels);
  boxes(img.height, height).forEach((list, d) => {
    for (const [s, w] of list) {
      for (let i = 0; i < width * channels; i++) down[d * width * channels + i] += across[s * width * channels + i] * w;
    }
  });
  const data = Buffer.alloc(width * height * channels);
  const byte = v => Math.max(0, Math.min(255, Math.floor(v + 0.5005))); // round half up; the float sums are off by far less than the 0.0005
  for (let i = 0; i < data.length; i += channels) {
    const a = alpha ? down[i + 3] : 255;
    for (let c = 0; c < 3; c++) data[i + c] = alpha ? (a > 0 ? byte(down[i + c] * 255 / a) : 0) : byte(down[i + c]);
    if (alpha) data[i + 3] = byte(a);
  }
  return { ...img, width, height, data };
}

// The PNG file's bytes: the colour chunks the picture came with, then its pixels, each row
// stored with whichever of the five filters leaves the smallest bytes, deflated at level 6.
export function encodePng(img) {
  const { width, height, channels } = img;
  const stride = width * channels;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const raw = Buffer.alloc((stride + 1) * height);
  const tries = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride;
    let best = 0, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = tries[f];
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const cur = img.data[row + i];
        const left = i >= channels ? img.data[row + i - channels] : 0;
        const above = y ? img.data[up + i] : 0;
        const aboveLeft = y && i >= channels ? img.data[up + i - channels] : 0;
        const sub = f === 0 ? 0 : f === 1 ? left : f === 2 ? above : f === 3 ? (left + above) >> 1 : paeth(left, above, aboveLeft);
        const v = (cur - sub) & 0xff;
        t[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) { best = f; bestCost = cost; }
    }
    raw[y * (stride + 1)] = best;
    tries[best].copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...(img.chunks ?? []).filter(c => KEPT.has(c.type)).map(c => chunk(c.type, c.data)),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
