// Deterministically generate the four Chrome Web Store icon sizes without an
// image-tool dependency. The mark is a dark rounded tile with a teal truth
// check; PNG chunks use the same CRC implementation as the extension ZIP.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../src/extzip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'icons');

function chunk(type, data) {
  const kind = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, crc]);
}

function insideRoundedSquare(x, y, size, radius) {
  const left = 1;
  const top = 1;
  const right = size - 2;
  const bottom = size - 2;
  if (x >= left + radius && x <= right - radius && y >= top && y <= bottom) return true;
  if (y >= top + radius && y <= bottom - radius && x >= left && x <= right) return true;
  const cx = x < left + radius ? left + radius : right - radius;
  const cy = y < top + radius ? top + radius : bottom - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function makePng(size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  const radius = Math.max(2, Math.round(size * 0.2));
  const stroke = Math.max(1.5, size * 0.095);
  const p1 = [size * 0.25, size * 0.52];
  const p2 = [size * 0.43, size * 0.69];
  const p3 = [size * 0.76, size * 0.32];
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // PNG filter: none
    for (let x = 0; x < size; x++) {
      const offset = row + 1 + x * 4;
      const tile = insideRoundedSquare(x + 0.5, y + 0.5, size, radius);
      let rgba = tile ? [13, 23, 32, 255] : [0, 0, 0, 0];
      if (tile && Math.min(
        distanceToSegment(x + 0.5, y + 0.5, ...p1, ...p2),
        distanceToSegment(x + 0.5, y + 0.5, ...p2, ...p3),
      ) <= stroke) rgba = [45, 212, 191, 255];
      raw.set(rgba, offset);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), makePng(size));
}
console.log(`Generated PriceTruth extension icons in ${OUT}`);
