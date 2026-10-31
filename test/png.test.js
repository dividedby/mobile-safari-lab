import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, cropPng, scalePng, encodePng, PNG_LIMITS } from '../lib/png.js';

// --- PNG files built by hand, so the decoder is checked against bytes it did not write ---

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// CRC-32 bit by bit, written here and not borrowed from the lab or from zlib.crc32 (Node 22.2+).
const crc32 = buf => {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data = Buffer.alloc(0)) => {
  const t = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
};
const ihdr = ({ width, height, depth = 8, colour = 2, interlace = 0 }) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = depth; b[9] = colour; b[12] = interlace;
  return chunk('IHDR', b);
};
// `rows`: the scanlines as stored, filter byte first.
const file = ({ rows, before = [], after = [], split = 1, ...head }) => {
  const z = zlib.deflateSync(Buffer.concat(rows));
  const size = Math.ceil(z.length / split);
  const idats = Array.from({ length: split }, (_, i) => chunk('IDAT', z.subarray(i * size, (i + 1) * size)));
  return Buffer.concat([SIG, ihdr(head), ...before, ...idats, ...after, chunk('IEND')]);
};

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
// Pixels (3 bytes each) stored with a chosen filter per row, filtered by the PNG spec's own definition.
function filtered(pixels, width, height, filters, bpp = 3) {
  const stride = width * bpp;
  return Array.from({ length: height }, (_, y) => {
    const f = filters[y % filters.length];
    const row = Buffer.alloc(stride + 1);
    row[0] = f;
    for (let i = 0; i < stride; i++) {
      const cur = pixels[y * stride + i];
      const a = i >= bpp ? pixels[y * stride + i - bpp] : 0;
      const b = y ? pixels[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      row[1 + i] = (cur - pred) & 255;
    }
    return row;
  });
}
const noise = (n, seed = 7) => Buffer.from(Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16 & 255));
const rgb = (width, height, data) => ({ width, height, channels: 3, data: Buffer.from(data), chunks: [] });
const rgba = (width, height, data) => ({ width, height, channels: 4, data: Buffer.from(data), chunks: [] });

test('all five row filters decode to the pixels they were made from', () => {
  const [w, h] = [9, 10];
  const pixels = noise(w * h * 3);
  for (const f of [0, 1, 2, 3, 4]) {
    const img = decodePng(file({ width: w, height: h, rows: filtered(pixels, w, h, [f]) }));
    assert.deepEqual([img.width, img.height, img.channels], [w, h, 3], `filter ${f}`);
    assert.ok(img.data.equals(pixels), `filter ${f}`);
  }
  // Every filter in one picture, and the data split over several IDAT chunks.
  const img = decodePng(file({ width: w, height: h, rows: filtered(pixels, w, h, [0, 1, 2, 3, 4]), split: 3 }));
  assert.ok(img.data.equals(pixels));
});

test('RGBA decodes with its alpha, and the filters work on four bytes', () => {
  const [w, h] = [6, 5];
  const pixels = noise(w * h * 4, 11);
  const img = decodePng(file({ width: w, height: h, colour: 6, rows: filtered(pixels, w, h, [4, 3, 2, 1, 0], 4) }));
  assert.equal(img.channels, 4);
  assert.ok(img.data.equals(pixels));
});

test('encode then decode gives the same pixels, for RGB and RGBA, and the size is in the header', () => {
  for (const [channels, name] of [[3, 'RGB'], [4, 'RGBA']]) {
    const [w, h] = [31, 17];
    const src = { width: w, height: h, channels, data: noise(w * h * channels, channels), chunks: [] };
    const bytes = encodePng(src);
    assert.equal(bytes.readUInt32BE(16), w, name);
    assert.equal(bytes.readUInt32BE(20), h, name);
    assert.equal(bytes[25], channels === 4 ? 6 : 2, name);
    const back = decodePng(bytes);
    assert.ok(back.data.equals(src.data), name);
  }
});

test('encode picks a filter per row: a smooth gradient is stored with Sub, flat colour with any, and it is smaller than raw', () => {
  const [w, h] = [64, 8];
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 3, x * 3, x * 3], (y * w + x) * 3);
  const bytes = encodePng(rgb(w, h, data));
  // The IDAT's filter bytes.
  let pos = 8, idat = Buffer.alloc(0);
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos);
    if (bytes.toString('latin1', pos + 4, pos + 8) === 'IDAT') idat = Buffer.concat([idat, bytes.subarray(pos + 8, pos + 8 + len)]);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  const kinds = Array.from({ length: h }, (_, y) => raw[y * (w * 3 + 1)]);
  assert.ok(kinds.every(k => k !== 0), `a gradient is not stored unfiltered: ${kinds}`);
  assert.ok(bytes.length < data.length / 2);
  assert.ok(decodePng(bytes).data.equals(data));
});

test('decode refuses what it can not crop, naming the type and depth', () => {
  const one = [Buffer.from([0, 1, 2])];
  const bad = (bytes, re, label) => assert.throws(() => decodePng(bytes), re, label);
  bad(file({ width: 1, height: 1, colour: 3, rows: [Buffer.from([0, 1])] }), /palette PNG \(colour type 3, 8-bit\)/, 'palette');
  bad(file({ width: 1, height: 1, colour: 0, rows: [Buffer.from([0, 1])] }), /grayscale PNG \(colour type 0, 8-bit\)/, 'gray');
  bad(file({ width: 1, height: 1, colour: 4, rows: [Buffer.from([0, 1, 1])] }), /grayscale with alpha PNG \(colour type 4, 8-bit\)/, 'gray alpha');
  bad(file({ width: 1, height: 1, colour: 2, depth: 16, rows: [Buffer.alloc(7)] }), /RGB PNG \(colour type 2, 16-bit\)/, '16-bit');
  bad(file({ width: 1, height: 1, interlace: 1, rows: one }), /interlaced/, 'interlaced');
  bad(file({ width: 1, height: 1, rows: [Buffer.from([5, 1, 2, 3])] }), /unknown row filter/, 'filter 5');
  bad(Buffer.from('not a png at all'), /not a PNG/, 'text');
  bad(Buffer.alloc(0), /not a PNG/, 'empty');
});

test('decode refuses a bad checksum, a cut-short file and data that does not match the header', () => {
  const good = file({ width: 2, height: 2, rows: filtered(noise(12), 2, 2, [0]) });
  decodePng(good);
  const flipped = Buffer.from(good);
  flipped[20] ^= 1; // inside IHDR's width
  assert.throws(() => decodePng(flipped), /bad checksum in its IHDR chunk/);
  const idatAt = good.indexOf('IDAT') + 6;
  const bit = Buffer.from(good);
  bit[idatAt] ^= 1;
  assert.throws(() => decodePng(bit), /bad checksum in its IDAT chunk/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 5)), /cut short/); // no room for IEND
  assert.throws(() => decodePng(good.subarray(0, 30)), /cut short/); // inside a chunk
  assert.throws(() => decodePng(good.subarray(0, 8)), /cut short/); // only the signature
  // A file with no IEND at all.
  const noEnd = Buffer.concat([SIG, ihdr({ width: 2, height: 2 }), chunk('IDAT', zlib.deflateSync(Buffer.concat(filtered(noise(12), 2, 2, [0]))))]);
  assert.throws(() => decodePng(noEnd), /cut short/);
  // Less data than the header promises, and more.
  assert.throws(() => decodePng(file({ width: 2, height: 3, rows: filtered(noise(12), 2, 2, [0]) })), /cut short/);
  assert.throws(() => decodePng(file({ width: 2, height: 1, rows: filtered(noise(12), 2, 2, [0]) })), /damaged or larger than its header says/);
  // Not deflate at all.
  const junk = Buffer.concat([SIG, ihdr({ width: 2, height: 2 }), chunk('IDAT', Buffer.from('this is not deflate data')), chunk('IEND')]);
  assert.throws(() => decodePng(junk), /damaged or larger/);
  // IHDR must come first, and there must be pixels.
  assert.throws(() => decodePng(Buffer.concat([SIG, chunk('IEND')])), /does not start with its header/);
  assert.throws(() => decodePng(Buffer.concat([SIG, ihdr({ width: 2, height: 2 }), chunk('IEND')])), /no image data/);
});

test('decode refuses a picture over the size limits before inflating anything', () => {
  const tiny = [Buffer.from([0, 0, 0, 0])];
  assert.throws(() => decodePng(file({ width: PNG_LIMITS.side + 1, height: 1, rows: tiny })), /over the limit of 16384 px a side and 100 megapixels/);
  assert.throws(() => decodePng(file({ width: 1, height: PNG_LIMITS.side + 1, rows: tiny })), /over the limit/);
  assert.throws(() => decodePng(file({ width: 12000, height: 9000, rows: tiny })), /over the limit/); // 108 MP
  assert.throws(() => decodePng(file({ width: 0, height: 1, rows: tiny })), /over the limit/);
});

test('crop takes exactly the pixels inside the rectangle and refuses one outside the picture', () => {
  const [w, h] = [5, 4];
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, 9], (y * w + x) * 3);
  const out = cropPng(rgb(w, h, data), { x: 1, y: 2, width: 3, height: 2 });
  assert.deepEqual([out.width, out.height], [3, 2]);
  assert.deepEqual([...out.data], [1, 2, 9, 2, 2, 9, 3, 2, 9, 1, 3, 9, 2, 3, 9, 3, 3, 9]);
  const whole = cropPng(rgb(w, h, data), { x: 0, y: 0, width: w, height: h });
  assert.ok(whole.data.equals(data));
  for (const r of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 3, y: 0, width: 3, height: 1 }, { x: 0, y: 3, width: 1, height: 2 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: NaN, height: 1 }]) {
    assert.throws(() => cropPng(rgb(w, h, data), r), /is not inside the 5x4 screenshot/, JSON.stringify(r));
  }
});

test('scale averages each area exactly (a box filter)', () => {
  // 2x2 -> 1x1: the mean of the four pixels, per channel.
  const four = scalePng(rgb(2, 2, [0, 0, 0, 255, 255, 255, 10, 20, 30, 11, 21, 31]), 1);
  assert.deepEqual([four.width, four.height, ...four.data], [1, 1, 69, 74, 79]);
  // A half rounds up.
  assert.deepEqual([...scalePng(rgb(2, 1, [0, 0, 0, 255, 255, 255]), 1).data], [128, 128, 128]);
  // 3 -> 2 across: each new pixel covers one and a half old ones, the middle one shared.
  const third = scalePng(rgb(3, 1, [0, 0, 0, 90, 90, 90, 180, 180, 180]), 2);
  assert.deepEqual([third.width, third.height, ...third.data], [2, 1, 30, 30, 30, 150, 150, 150]);
  // 4x4 -> 2x2 takes the 2x2 blocks; the height follows the shape.
  const data = Buffer.alloc(4 * 4 * 3);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data.set([x < 2 ? 0 : 100, y < 2 ? 0 : 200, 50], (y * 4 + x) * 3);
  const quarter = scalePng(rgb(4, 4, data), 2);
  assert.deepEqual([quarter.width, quarter.height, ...quarter.data], [2, 2, 0, 0, 50, 100, 0, 50, 0, 200, 50, 100, 200, 50]);
  assert.equal(scalePng(rgb(5, 3, Buffer.alloc(45)), 2).height, 1); // 3 * 2 / 5 = 1.2
  assert.equal(scalePng(rgb(100, 1, Buffer.alloc(300)), 1).height, 1, 'never zero');
  assert.equal(scalePng(rgb(300, 600, Buffer.alloc(300 * 600 * 3)), 100).height, 200);
});

test('scale weights colour by alpha, so a see-through pixel does not tint its neighbour', () => {
  const half = scalePng(rgba(2, 1, [255, 0, 0, 255, 0, 0, 255, 0]), 1);
  assert.deepEqual([...half.data], [255, 0, 0, 128], 'red stays red at half alpha');
  assert.deepEqual([...scalePng(rgba(2, 1, [100, 100, 100, 255, 200, 0, 0, 255]), 1).data], [150, 50, 50, 255]);
  assert.deepEqual([...scalePng(rgba(2, 1, [9, 9, 9, 0, 7, 7, 7, 0]), 1).data], [0, 0, 0, 0]);
});

test('scale only shrinks, takes whole pixels, and a width equal to the picture is the picture', () => {
  const img = rgb(4, 4, Buffer.alloc(48));
  assert.throws(() => scalePng(img, 5), /larger than the picture \(4 px\)/);
  assert.throws(() => scalePng(img, 2.5), /whole number/);
  assert.throws(() => scalePng(img, 0), /whole number/);
  assert.equal(scalePng(img, 4), img);
});

test('the colour chunks survive decode, crop, scale and encode in place; text and the rest are dropped', () => {
  const [w, h] = [4, 4];
  const pixels = noise(w * h * 3);
  const colour = [chunk('iCCP', Buffer.from('Display P3\0\0abc')), chunk('sRGB', Buffer.from([0])), chunk('gAMA', Buffer.from([0, 1, 0x86, 0xa0])), chunk('cHRM', Buffer.alloc(32, 3)), chunk('cICP', Buffer.from([12, 13, 0, 1]))];
  const noise1 = [chunk('tEXt', Buffer.from('Software\0someone')), chunk('eXIf', Buffer.from('Exif')), chunk('pHYs', Buffer.alloc(9)), chunk('zzZz', Buffer.from('x'))];
  const src = decodePng(file({ width: w, height: h, rows: filtered(pixels, w, h, [0]), before: [colour[0], noise1[0], colour[1], noise1[1], colour[2], colour[3], noise1[2], colour[4], noise1[3]] }));
  assert.deepEqual(src.chunks.map(c => c.type), ['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP']);
  const names = bytes => {
    const out = [];
    for (let pos = 8; pos < bytes.length; pos += 12 + bytes.readUInt32BE(pos)) out.push(bytes.toString('latin1', pos + 4, pos + 8));
    return out;
  };
  for (const img of [src, cropPng(src, { x: 1, y: 1, width: 2, height: 3 }), scalePng(src, 2)]) {
    const bytes = encodePng(img);
    assert.deepEqual(names(bytes), ['IHDR', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'IDAT', 'IEND']);
    assert.ok(bytes.includes(colour[0]) && bytes.includes(colour[4]), 'the chunks are byte for byte as they were');
    assert.deepEqual(decodePng(bytes).chunks.map(c => c.type), ['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP']);
  }
  // A dropped chunk is still checked: a damaged one refuses the file.
  const broken = Buffer.from(noise1[0]);
  broken[broken.length - 1] ^= 1;
  assert.throws(() => decodePng(file({ width: w, height: h, rows: filtered(pixels, w, h, [0]), before: [broken] })), /bad checksum in its tEXt chunk/);
});
