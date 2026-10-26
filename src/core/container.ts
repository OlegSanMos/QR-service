// The byte stream that is actually fountain-coded: a header describing the
// files, followed by all file contents concatenated and compressed together
// ("solid" archive — repeats across files compress too).
//
// Version 2 (current), all integers little-endian:
//
//   offset size field
//   0      1    container version (2)
//   1      1    method: 0 = stored, 1 = deflate-raw, 2 = context mixing (cm.ts, format 1)
//   2      4    total size of all files (u32)
//   6      4    CRC-32 of all files concatenated
//   10     2    number of files N (u16)
//   12     ...  N entries: u16 name length, UTF-8 path ("folder/file.txt"),
//               u8 MIME length, MIME (ASCII), u32 size
//   ...    ...  payload
//
// Version 1 (single file, read-only for compatibility with older senders):
//   0 version(1) · 1 flags(bit0 = deflate) · 2 size · 6 CRC · 10 u16 name length ·
//   name · u8 MIME length · MIME · payload

import { cmCompress, cmDecompress } from './cm';
import { crc32 } from './crc32';
import { MAX_TOTAL_LENGTH } from './protocol';

export type Method = 'store' | 'deflate' | 'cm';

const METHOD_IDS: Record<Method, number> = { store: 0, deflate: 1, cm: 2 };
const METHODS_BY_ID: Method[] = ['store', 'deflate', 'cm'];

const VERSION_1 = 1;
const VERSION_2 = 2;
const FLAG_DEFLATE_V1 = 1;
const MAX_NAME_BYTES = 1024;
const MAX_MIME_BYTES = 255;
const MAX_FILES = 0xffff;
/** Context mixing keeps ~70 MB of model tables plus the data; above this, deflate. */
export const CM_MAX_BYTES = 512 * 1024 * 1024;

export interface FileEntry {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface FileInfo {
  name: string;
  mime: string;
  size: number;
}

export interface ContainerInfo {
  files: FileInfo[];
  totalSize: number;
  method: Method;
  headerLength: number;
}

export interface PackProgress {
  phase: Method;
  done: number;
  total: number;
}

export interface PackOptions {
  /** 'auto' picks the method with the shortest expected end-to-end time. */
  method?: Method | 'auto';
  /** Expected useful throughput of the QR channel, bytes/s (default 20 KB/s). */
  linkBytesPerSecond?: number;
  /** How much slower than this device the receiver may decompress (default 1.5). */
  receiverSlowdown?: number;
  onProgress?: (p: PackProgress) => void;
  /** Clock in ms (tests inject a fake one). */
  now?: () => number;
}

export interface Candidate {
  method: Method;
  size: number;
  ms: number;
  /** Estimated seconds: compression + transfer + decompression. */
  cost: number;
  aborted?: boolean;
}

export interface PackResult {
  stream: Uint8Array;
  method: Method;
  totalSize: number;
  candidates: Candidate[];
}

export interface UnpackResult {
  files: FileEntry[];
  method: Method;
}

export function compressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function pipeThrough(data: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function truncateUtf8(s: string, maxBytes: number): Uint8Array {
  const enc = new TextEncoder();
  let bytes = enc.encode(s);
  while (bytes.length > maxBytes) {
    s = s.slice(0, -1);
    bytes = enc.encode(s);
  }
  return bytes;
}

function concat(files: FileEntry[]): Uint8Array {
  if (files.length === 1) return files[0].data;
  let total = 0;
  for (const f of files) total += f.data.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of files) {
    out.set(f.data, off);
    off += f.data.length;
  }
  return out;
}

function encodeHeader(files: FileEntry[], method: Method, raw: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const names = files.map((f) => truncateUtf8(f.name || 'file', MAX_NAME_BYTES));
  const mimes = files.map((f) => enc.encode((f.mime || 'application/octet-stream').slice(0, MAX_MIME_BYTES)));
  let len = 12;
  for (let i = 0; i < files.length; i++) len += 2 + names[i].length + 1 + mimes[i].length + 4;
  const head = new Uint8Array(len);
  const view = new DataView(head.buffer);
  view.setUint8(0, VERSION_2);
  view.setUint8(1, METHOD_IDS[method]);
  view.setUint32(2, raw.length, true);
  view.setUint32(6, crc32(raw), true);
  view.setUint16(10, files.length, true);
  let o = 12;
  for (let i = 0; i < files.length; i++) {
    view.setUint16(o, names[i].length, true);
    head.set(names[i], o + 2);
    o += 2 + names[i].length;
    view.setUint8(o, mimes[i].length);
    head.set(mimes[i], o + 1);
    o += 1 + mimes[i].length;
    view.setUint32(o, files[i].data.length, true);
    o += 4;
  }
  return head;
}

class CmAbort extends Error {}

/**
 * Packs files into one stream. With method 'auto' it tries the candidates and
 * keeps the one that minimises compression time + transfer time + the
 * receiver's decompression time; the slow context-mixing pass is abandoned
 * early as soon as its projection can no longer win.
 */
export async function packFiles(files: FileEntry[], options: PackOptions = {}): Promise<PackResult> {
  if (files.length === 0) throw new RangeError('no files');
  if (files.length > MAX_FILES) throw new RangeError(`at most ${MAX_FILES} files`);
  const now = options.now ?? (() => performance.now());
  const link = options.linkBytesPerSecond ?? 20_000;
  const slowdown = options.receiverSlowdown ?? 1.5;
  const want = options.method ?? 'auto';
  const raw = concat(files);
  if (raw.length > MAX_TOTAL_LENGTH) throw new RangeError('files are larger than 4 GiB in total');

  const cost = (size: number, ms: number, method: Method): number => {
    const decodeMs = method === 'cm' ? ms * slowdown : 0;
    return (ms + decodeMs) / 1000 + size / link;
  };
  const candidates: Candidate[] = [{ method: 'store', size: raw.length, ms: 0, cost: cost(raw.length, 0, 'store') }];
  const payloads = new Map<Method, Uint8Array>([['store', raw]]);

  const tryDeflate = want === 'deflate' || (want === 'auto' && raw.length >= 64 && compressionSupported());
  if (tryDeflate) {
    options.onProgress?.({ phase: 'deflate', done: 0, total: raw.length });
    const t0 = now();
    const deflated = await pipeThrough(raw, new CompressionStream('deflate-raw'));
    const ms = now() - t0;
    candidates.push({ method: 'deflate', size: deflated.length, ms, cost: cost(deflated.length, ms, 'deflate') });
    payloads.set('deflate', deflated);
  }

  // Context mixing only where data is compressible at all (deflate saved ≥ 3 %).
  const deflateSize = payloads.get('deflate')?.length ?? raw.length;
  const tryCm = want === 'cm' || (want === 'auto' && raw.length >= 64 && raw.length <= CM_MAX_BYTES && deflateSize < raw.length * 0.97);
  if (tryCm) {
    const best = Math.min(...candidates.map((c) => c.cost));
    const t0 = now();
    try {
      const packed = cmCompress(raw, (done, total, written) => {
        options.onProgress?.({ phase: 'cm', done, total });
        if (want !== 'auto' || done >= total || done < Math.min(total * 0.2, 256 * 1024)) return;
        const elapsed = now() - t0;
        // The model keeps learning, so the rest usually compresses better than the prefix.
        const projectedSize = written + (total - done) * (written / done) * 0.85;
        const projectedMs = elapsed * (total / done);
        if (cost(projectedSize, projectedMs, 'cm') > best * 1.05) throw new CmAbort();
      });
      const ms = now() - t0;
      candidates.push({ method: 'cm', size: packed.length, ms, cost: cost(packed.length, ms, 'cm') });
      payloads.set('cm', packed);
    } catch (err) {
      if (!(err instanceof CmAbort)) throw err;
      const ms = now() - t0;
      candidates.push({ method: 'cm', size: NaN, ms, cost: Infinity, aborted: true });
    }
  }

  let chosen: Candidate;
  if (want === 'auto') {
    chosen = candidates.reduce((a, b) => (b.cost < a.cost ? b : a));
  } else {
    chosen = candidates.find((c) => c.method === want && !c.aborted) ?? candidates[0];
  }
  const payload = payloads.get(chosen.method)!;
  const head = encodeHeader(files, chosen.method, raw);
  if (head.length + payload.length > MAX_TOTAL_LENGTH) throw new RangeError('archive is larger than 4 GiB');
  const stream = new Uint8Array(head.length + payload.length);
  stream.set(head);
  stream.set(payload, head.length);
  return { stream, method: chosen.method, totalSize: raw.length, candidates };
}

/** Reads the metadata from the beginning of a (possibly partial) stream, or null if incomplete. */
export function peekContainerInfo(head: Uint8Array): ContainerInfo | null {
  if (head.length < 12) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const dec = new TextDecoder();
  const version = head[0];
  if (version === VERSION_1) {
    if (head.length < 13) return null;
    const nameLen = view.getUint16(10, true);
    if (head.length < 13 + nameLen) return null;
    const mimeLen = view.getUint8(12 + nameLen);
    if (head.length < 13 + nameLen + mimeLen) return null;
    const size = view.getUint32(2, true);
    return {
      files: [{ name: dec.decode(head.subarray(12, 12 + nameLen)), mime: dec.decode(head.subarray(13 + nameLen, 13 + nameLen + mimeLen)), size }],
      totalSize: size,
      method: view.getUint8(1) & FLAG_DEFLATE_V1 ? 'deflate' : 'store',
      headerLength: 13 + nameLen + mimeLen,
    };
  }
  if (version !== VERSION_2) return null;
  const method = METHODS_BY_ID[view.getUint8(1)];
  if (!method) return null;
  const count = view.getUint16(10, true);
  const files: FileInfo[] = [];
  let o = 12;
  for (let i = 0; i < count; i++) {
    if (head.length < o + 2) return null;
    const nameLen = view.getUint16(o, true);
    if (head.length < o + 2 + nameLen + 1) return null;
    const name = dec.decode(head.subarray(o + 2, o + 2 + nameLen));
    o += 2 + nameLen;
    const mimeLen = view.getUint8(o);
    if (head.length < o + 1 + mimeLen + 4) return null;
    const mime = dec.decode(head.subarray(o + 1, o + 1 + mimeLen));
    o += 1 + mimeLen;
    files.push({ name, mime, size: view.getUint32(o, true) });
    o += 4;
  }
  return { files, totalSize: view.getUint32(2, true), method, headerLength: o };
}

export async function unpackContainer(stream: Uint8Array, onProgress?: (p: PackProgress) => void): Promise<UnpackResult> {
  const info = peekContainerInfo(stream);
  if (!info) throw new Error('повреждённый заголовок архива');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const expectedCrc = view.getUint32(6, true);
  const payload = stream.subarray(info.headerLength);
  let raw: Uint8Array;
  if (info.method === 'deflate') {
    if (!compressionSupported()) throw new Error('браузер не поддерживает распаковку (DecompressionStream)');
    onProgress?.({ phase: 'deflate', done: 0, total: info.totalSize });
    raw = await pipeThrough(payload, new DecompressionStream('deflate-raw'));
  } else if (info.method === 'cm') {
    raw = cmDecompress(payload, info.totalSize, (done, total) => onProgress?.({ phase: 'cm', done, total }));
  } else {
    raw = payload.slice();
  }
  if (raw.length !== info.totalSize) throw new Error(`неверный размер: ${raw.length} ≠ ${info.totalSize}`);
  if (crc32(raw) !== expectedCrc) throw new Error('контрольная сумма CRC-32 не совпала');
  const files: FileEntry[] = [];
  let off = 0;
  for (const f of info.files) {
    if (off + f.size > raw.length) throw new Error('повреждённый список файлов');
    files.push({ name: f.name, mime: f.mime, data: raw.subarray(off, off + f.size) });
    off += f.size;
  }
  return { files, method: info.method };
}

/** Human summary: "notes.txt" or "3 файла". */
export function describeFiles(files: { name: string }[]): string {
  if (files.length === 1) return files[0].name;
  const n = files.length;
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'файл' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'файла' : 'файлов';
  return `${n} ${word}`;
}
