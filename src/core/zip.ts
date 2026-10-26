// Minimal ZIP writer (stored entries, UTF-8 names) for "save all files at once":
// browsers cannot save several files in one go, but every OS opens a .zip.

import { crc32 } from './crc32';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: ZipEntry[], when = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const names = entries.map((e) => enc.encode(e.name.replace(/^\/+/, '')));
  const crcs = entries.map((e) => crc32(e.data));
  let localSize = 0;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    localSize += 30 + names[i].length + entries[i].data.length;
    centralSize += 46 + names[i].length;
  }
  if (localSize + centralSize + 22 > 0xffffffff || entries.length > 0xffff) throw new RangeError('archive too large for ZIP without ZIP64');
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  const offsets: number[] = [];
  let o = 0;
  for (let i = 0; i < entries.length; i++) {
    const size = entries[i].data.length;
    offsets.push(o);
    v.setUint32(o, 0x04034b50, true);
    v.setUint16(o + 4, 20, true); // version needed
    v.setUint16(o + 6, 0x0800, true); // UTF-8 names
    v.setUint16(o + 8, 0, true); // stored
    v.setUint16(o + 10, time, true);
    v.setUint16(o + 12, date, true);
    v.setUint32(o + 14, crcs[i], true);
    v.setUint32(o + 18, size, true);
    v.setUint32(o + 22, size, true);
    v.setUint16(o + 26, names[i].length, true);
    v.setUint16(o + 28, 0, true);
    out.set(names[i], o + 30);
    out.set(entries[i].data, o + 30 + names[i].length);
    o += 30 + names[i].length + size;
  }
  const centralStart = o;
  for (let i = 0; i < entries.length; i++) {
    const size = entries[i].data.length;
    v.setUint32(o, 0x02014b50, true);
    v.setUint16(o + 4, 20, true); // version made by
    v.setUint16(o + 6, 20, true);
    v.setUint16(o + 8, 0x0800, true);
    v.setUint16(o + 10, 0, true);
    v.setUint16(o + 12, time, true);
    v.setUint16(o + 14, date, true);
    v.setUint32(o + 16, crcs[i], true);
    v.setUint32(o + 20, size, true);
    v.setUint32(o + 24, size, true);
    v.setUint16(o + 28, names[i].length, true);
    // extra, comment, disk, internal attrs: 0
    v.setUint32(o + 38, 0, true);
    v.setUint32(o + 42, offsets[i], true);
    out.set(names[i], o + 46);
    o += 46 + names[i].length;
  }
  v.setUint32(o, 0x06054b50, true);
  v.setUint16(o + 8, entries.length, true);
  v.setUint16(o + 10, entries.length, true);
  v.setUint32(o + 12, o - centralStart, true);
  v.setUint32(o + 16, centralStart, true);
  return out;
}
