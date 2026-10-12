#!/usr/bin/env node
/**
 * Renders the Reader PWA icons (public/reader-icon-{192,512}.png and the 180px
 * apple-touch-icon) from the same geometry as public/reader-icon.svg, using
 * only Node built-ins. Re-run after changing the design:
 *
 *   node scripts/generate-reader-icons.mjs
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const publicDir = resolve(import.meta.dirname, '../public');

// Geometry in a 0..1 square (matches reader-icon.svg's 512 viewBox / 512).
const BARS = [0.2, 0.36, 0.52, 0.36, 0.2];
const BAR_WIDTH = 0.075;
const BAR_GAP = 0.05;
const TOP = [0x31, 0x2e, 0x81]; // indigo-900
const BOTTOM = [0x0a, 0x0a, 0x0a]; // neutral-950, the dark theme background
const BAR = [0xff, 0xff, 0xff];

function barCoverage(x, y) {
  const total = BARS.length * BAR_WIDTH + (BARS.length - 1) * BAR_GAP;
  let left = 0.5 - total / 2;
  for (const height of BARS) {
    const cx = left + BAR_WIDTH / 2;
    const radius = BAR_WIDTH / 2;
    const half = height / 2 - radius;
    // Capsule: distance to the vertical segment, minus the radius.
    const dy = Math.max(Math.abs(y - 0.5) - half, 0);
    const distance = Math.hypot(x - cx, dy) - radius;
    if (distance <= 0) return 1;
    left += BAR_WIDTH + BAR_GAP;
  }
  return 0;
}

function render(size) {
  const samples = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let coverage = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++)
          coverage += barCoverage(
            (px + (sx + 0.5) / samples) / size,
            (py + (sy + 0.5) / samples) / size,
          );
      coverage /= samples * samples;
      // Diagonal gradient, top-left to bottom-right.
      const t = Math.min(1, Math.max(0, (px + py) / (2 * size)) * 1.15);
      const offset = 1 + px * 4;
      for (let channel = 0; channel < 3; channel++) {
        const background = TOP[channel] + (BOTTOM[channel] - TOP[channel]) * t;
        row[offset + channel] = Math.round(background + (BAR[channel] - background) * coverage);
      }
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [
  ['reader-icon-192.png', 192],
  ['reader-icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(resolve(publicDir, name), render(size));
  console.log(`wrote public/${name}`);
}
