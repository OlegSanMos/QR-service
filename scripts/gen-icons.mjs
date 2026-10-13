// Generates the PWA icons in public/: a QR-like 21×21 glyph with a "wave" accent.
// Run: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 21;
const grid = Array.from({ length: N }, () => new Array(N).fill(0));
const finder = (ox, oy) => {
  for (let y = -1; y <= 7; y++)
    for (let x = -1; x <= 7; x++) {
      const gx = ox + x, gy = oy + y;
      if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      grid[gy][gx] = d === 4 ? 0 : d !== 2 ? 1 : 0;
    }
};
finder(0, 0); finder(N - 7, 0); finder(0, N - 7);
let s = 0x2545f491;
const rnd = () => ((s ^= s << 13), (s ^= s >>> 17), (s ^= s << 5), (s >>> 0) / 4294967296);
const reserved = (x, y) => (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!reserved(x, y)) grid[y][x] = rnd() < 0.5 ? 1 : 0;
// Clear the bottom-right corner for the accent mark.
for (let y = 13; y < N; y++) for (let x = 13; x < N; x++) grid[y][x] = 0;

const BG = [14, 16, 20], FG = [233, 236, 242], ACC = [79, 140, 255];

function svg() {
  const cell = 10, pad = 30, size = N * cell + pad * 2;
  let rects = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (grid[y][x]) rects += `<rect x="${pad + x * cell}" y="${pad + y * cell}" width="${cell}" height="${cell}"/>`;
  const cx = pad + 17 * cell, cy = pad + 17 * cell;
  const arcs = [14, 26, 38].map((r) => `<path d="M ${cx - r} ${cy + r * 0.2} A ${r} ${r} 0 0 1 ${cx + r * 0.2} ${cy - r}" fill="none" stroke="rgb(${ACC})" stroke-width="7" stroke-linecap="round"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size * 0.18}" fill="rgb(${BG})"/><g fill="rgb(${FG})">${rects}</g>${arcs}<circle cx="${cx - 6}" cy="${cy + 6}" r="7" fill="rgb(${ACC})"/></svg>`;
}

function png(size) {
  const px = new Uint8Array(size * size * 4);
  const pad = Math.round(size * 0.12), cell = (size - pad * 2) / N;
  const cx = pad + 17 * cell, cy = pad + 17 * cell;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let c = BG;
      const gx = Math.floor((x - pad) / cell), gy = Math.floor((y - pad) / cell);
      if (gx >= 0 && gy >= 0 && gx < N && gy < N && grid[gy][gx]) c = FG;
      const dx = x - (cx - cell * 0.6), dy = y - (cy + cell * 0.6);
      const d = Math.hypot(dx, dy);
      if (dx > -cell && dy < cell && (d < cell * 0.75 || [1.4, 2.6, 3.8].some((r) => Math.abs(d - r * cell) < cell * 0.35))) c = ACC;
      px.set([...c, 255], (y * size + x) * 4);
    }
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = ~0; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync('public/icon.svg', svg());
writeFileSync('public/icon-192.png', png(192));
writeFileSync('public/icon-512.png', png(512));
console.log('icons written');
