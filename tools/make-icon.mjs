// Draws the Cellovision icon (same shapes as web/icon.svg) into a PNG, no image tools needed.
//   node tools/make-icon.mjs <out.png> [size=512] [--foreground]   (foreground: just the white marks, for Android)

import fs from "node:fs";
import zlib from "node:zlib";

const [out, sizeArg, flag] = process.argv.slice(2);
const N = Number(sizeArg || 512), S = N / 64, SS = 4;
const fgOnly = flag === "--foreground";

const A = [139, 108, 255], B = [63, 184, 255];
const lerp = (t) => A.map((a, i) => a + (B[i] - a) * t);
function inRound(x, y, r = 15) { const cx = Math.max(r, Math.min(64 - r, x)), cy = Math.max(r, Math.min(64 - r, y)); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; }
function inTri(x, y) { // (27,21.5) (44,32) (27,42.5)
  const s = (ax, ay, bx, by) => (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d1 = s(27, 21.5, 44, 32), d2 = s(44, 32, 27, 42.5), d3 = s(27, 42.5, 27, 21.5);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function sample(x, y) {
  const d = Math.hypot(x - 32, y - 32);
  const ring = Math.abs(d - 19) <= 1.5;
  if (fgOnly) return inTri(x, y) ? [255, 255, 255, 255] : ring ? [255, 255, 255, 90] : null;
  if (!inRound(x, y)) return null;
  if (inTri(x, y)) return [255, 255, 255, 255];
  const base = lerp((x + y) / 128);
  return ring ? base.map((c) => c + (255 - c) * 0.35).concat(255) : base.concat(255);
}

const rows = [];
for (let py = 0; py < N; py++) {
  const row = Buffer.alloc(1 + N * 4);
  for (let px = 0; px < N; px++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample((px + (sx + 0.5) / SS) / S, (py + (sy + 0.5) / SS) / S);
      if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; n++; }
    }
    const o = 1 + px * 4;
    if (a) { row[o] = r / a; row[o + 1] = g / a; row[o + 2] = b / a; row[o + 3] = a / (SS * SS); }
  }
  rows.push(row);
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
console.log(`${out} (${N}×${N})`);
