/**
 * Generates the PWA icons (fully original placeholder art): a stage-dark
 * rounded tile with a three-block signal chain. Pure Node — RGBA raster
 * encoded as PNG via zlib, no dependencies.
 *
 * Run once (icons are committed): node scripts/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BG = [0x0d, 0x11, 0x17];
const BLOCKS = [
  [0x3f, 0xb9, 0x50], // green
  [0xd2, 0x99, 0x22], // amber
  [0x58, 0xa6, 0xff], // blue
];
const WIRE = [0x8b, 0x94, 0x9e];

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cornerR = size * 0.22;
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };
  const insideRounded = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
  };

  // Tile background with rounded corners (transparent outside).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRounded(x, y, 0, 0, size - 1, size - 1, cornerR)) set(x, y, BG);
    }
  }
  // Signal wire across the middle.
  const wireY = Math.round(size / 2);
  const wireH = Math.max(2, Math.round(size * 0.018));
  for (let y = wireY - wireH; y <= wireY + wireH; y++) {
    for (let x = Math.round(size * 0.1); x < Math.round(size * 0.9); x++) set(x, y, WIRE);
  }
  // Three chain blocks.
  const blockW = size * 0.19;
  const blockH = size * 0.3;
  const gap = size * 0.065;
  const totalW = blockW * 3 + gap * 2;
  let bx = (size - totalW) / 2;
  for (const color of BLOCKS) {
    const x0 = Math.round(bx);
    const x1 = Math.round(bx + blockW);
    const y0 = Math.round(size / 2 - blockH / 2);
    const y1 = Math.round(size / 2 + blockH / 2);
    const r = size * 0.045;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (insideRounded(x, y, x0, y0, x1, y1, r)) set(x, y, color);
      }
    }
    bx += blockW + gap;
  }
  return rgba;
}

for (const [name, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  writeFileSync(join(outDir, name), encodePng(size, draw(size)));
  console.log(`wrote ${name} (${size}x${size})`);
}
