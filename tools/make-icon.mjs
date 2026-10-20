// Draws Cellovision artwork (same shapes as web/icon.svg) into PNGs, no image tools needed.
//   node tools/make-icon.mjs <out.png> [size=512]                 the rounded app icon
//   node tools/make-icon.mjs <out.png> <w> <h> <mode>            mode: full (square-cornered, opaque: iOS icons),
//        bg (gradient only), fg (the ring + play mark only, transparent), banner (gradient + mark)

import fs from "node:fs";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const out = args[0];
let W, H, mode;
if (args.length >= 4) { W = +args[1]; H = +args[2]; mode = args[3]; }
else { W = H = Number(args[1] || 512); mode = args[2] === "--foreground" ? "fg" : "icon"; }
const SS = 3;

const A = [139, 108, 255], B = [63, 184, 255];
const lerp = (t) => A.map((a, i) => Math.round(a + (B[i] - a) * t));
// The mark lives in a 64-unit box centred in the picture, as tall as the picture (or 60% for banners).
const markBox = mode === "banner" || mode === "fg" && W !== H ? Math.min(W, H) * 0.8 : Math.min(W, H);
const ox = (W - markBox) / 2, oy = (H - markBox) / 2, unit = markBox / 64;
function inRound(x, y) { const r = 15 * (Math.min(W, H) / 64), cx = Math.max(r, Math.min(W - r, x)), cy = Math.max(r, Math.min(H - r, y)); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; }
function mark(x, y) {
  const u = (x - ox) / unit, v = (y - oy) / unit;
  const s = (ax, ay, bx, by) => (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d1 = s(27, 21.5, 44, 32), d2 = s(44, 32, 27, 42.5), d3 = s(27, 42.5, 27, 21.5);
  const tri = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  if (tri) return "tri";
  return Math.abs(Math.hypot(u - 32, v - 32) - 19) <= 1.5 ? "ring" : null;
}
function sample(x, y) {
  const m = mode === "bg" ? null : mark(x, y);
  if (mode === "fg") return m === "tri" ? [255, 255, 255, 255] : m === "ring" ? [255, 255, 255, 90] : null;
  if (mode === "icon" && !inRound(x, y)) return null;
  const base = lerp((x / W + y / H) / 2);
  if (m === "tri") return [255, 255, 255, 255];
  if (m === "ring") return base.map((c) => c + (255 - c) * 0.35).concat(255);
  return base.concat(255);
}

const rows = [];
for (let py = 0; py < H; py++) {
  const row = Buffer.alloc(1 + W * 4);
  for (let px = 0; px < W; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
      if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
    }
    const o = 1 + px * 4;
    if (a) { row[o] = r / a; row[o + 1] = g / a; row[o + 2] = b / a; row[o + 3] = a / (SS * SS); }
  }
  rows.push(row);
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.mkdirSync(out.replace(/[\\/][^\\/]*$/, "") || ".", { recursive: true });
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
console.log(`${out} (${W}×${H}, ${mode})`);
