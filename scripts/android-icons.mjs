// Regenerates the legacy Android launcher PNGs (mipmap-*/ic_launcher.png + ic_launcher_round.png, used
// below API 26; newer devices use the adaptive vector in drawable/ic_launcher_foreground.xml) from the
// design of public/icon.svg. No dependencies: a tiny supersampled rasterizer + node:zlib for the PNGs.
//   node scripts/android-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'android', 'app', 'src', 'main', 'res');
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

const hex = (s, a = 1) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), a];
const mix = (c0, c1, t) => c0.map((v, i) => v + (c1[i] - v) * Math.max(0, Math.min(1, t)));
/** signed distance to a rounded rect (x, y, w, h, r) */
function rrect(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// The design of public/icon.svg: two fanned KuCards (teal behind, amber in front) on the night-teal tile.
const BG0 = hex('#1e5a66');
const BG1 = hex('#13232e');
const IVORY = hex('#fff6e6');
const TEAL = hex('#14a3a0');
const AMBER = hex('#ffb627');
const INK = hex('#13232e');
const SHADOW = hex('#0b161c', 0.35);
/** cards: rotation (deg) about (256, 280), then the card's top-left offset; 176 x 260, r 26 */
const CARDS = [
  { deg: -16, ox: -88, oy: -150, fill: TEAL, dot: 0 },
  { deg: 12, ox: -70, oy: -140, fill: AMBER, dot: 34 },
];
function local(x, y, deg, ox, oy) {
  const t = (-deg * Math.PI) / 180;
  const dx = x - 256;
  const dy = y - 280;
  return [dx * Math.cos(t) - dy * Math.sin(t) - ox, dx * Math.sin(t) + dy * Math.cos(t) - oy];
}

/** colour (straight RGBA, a in 0..1) of the 512-unit icon at (x, y); `round` = circular background */
function sample(x, y, round) {
  const inBg = round ? Math.hypot(x - 256, y - 256) <= 256 : rrect(x, y, 0, 0, 512, 512, 112) <= 0;
  if (!inBg) return [0, 0, 0, 0];
  let c = mix(BG0, BG1, Math.hypot(x - 256, y - 0.4 * 512) / (0.7 * 512));
  const over = (col) => (c = mix(c, [col[0], col[1], col[2], 1], col[3]));
  for (const k of CARDS) {
    const [sx, sy] = local(x - 6, y - 12, k.deg, k.ox, k.oy);
    if (rrect(sx, sy, 0, 0, 176, 260, 26) <= 0) over(SHADOW);
    const [lx, ly] = local(x, y, k.deg, k.ox, k.oy);
    if (rrect(lx, ly, -5, -5, 186, 270, 31) <= 0) over(IVORY);
    if (rrect(lx, ly, 5, 5, 166, 250, 21) <= 0) {
      over(k.fill);
      if (k.dot && Math.hypot(lx - 88, ly - 130) <= k.dot) over(IVORY);
      if (k.dot && Math.hypot(lx - 88, ly - 130) <= k.dot * 0.45) over(INK);
      // the wave on the teal card
      if (!k.dot) {
        const wy = 140 - 12 * Math.sin(((lx - 40) / 48) * Math.PI);
        if (lx >= 34 && lx <= 142 && Math.abs(ly - wy) <= 7) over(IVORY);
      }
    }
  }
  return c;
}

/** size px icon, content scaled to `fill` of the canvas (legacy icons keep a small margin) */
function render(size, round, fill = 44 / 48) {
  const N = 5; // N×N samples per pixel
  const k = 512 / (size * fill);
  const off = (size - size * fill) / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++)
        for (let sx = 0; sx < N; sx++) {
          const c = sample((px + (sx + 0.5) / N - off) * k, (py + (sy + 0.5) / N - off) * k, round);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      const i = (py * size + px) * 4;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / (N * N)) * 255);
    }
  return out;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [d, size] of Object.entries(DENSITIES)) {
  for (const round of [false, true]) {
    const file = join(RES, `mipmap-${d}`, round ? 'ic_launcher_round.png' : 'ic_launcher.png');
    writeFileSync(file, png(render(size, round), size));
    console.log('wrote', file);
  }
}
