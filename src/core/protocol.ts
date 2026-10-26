// Wire format of a single QR frame (all integers little-endian):
//
//   offset size field
//   0      1    magic 0x51 ('Q'), identifies protocol v1
//   1      4    transferId   hash of the content (transferIdFor); tells transfers apart
//   5      4    totalLength  length of the container stream (metadata + file)
//   9      2    blockSize    payload bytes per symbol (constant within a transfer)
//   11     4    symbolId     fountain symbol id (see fountain/layout.ts)
//   15     B    payload      encoded symbol XOR-ed with a keystream ("whitening")
//
// Whitening makes every frame look like random noise, which lets the sender use a
// fixed QR mask (~20x faster than evaluating all 8 masks) without ever producing
// pathological patterns such as fake finder patterns or large flat areas.

import { Prng, mix32 } from './prng';

export const FRAME_MAGIC = 0x51;
export const HEADER_SIZE = 15;
export const MAX_TOTAL_LENGTH = 0xffffffff;
export const MAX_BLOCK_SIZE = 0xffff;

export interface FrameHeader {
  transferId: number;
  totalLength: number;
  blockSize: number;
  symbolId: number;
}

export interface Frame extends FrameHeader {
  /** De-whitened symbol payload (blockSize bytes). */
  payload: Uint8Array;
}

export function whiten(payload: Uint8Array, transferId: number, symbolId: number): void {
  const rng = new Prng(mix32(symbolId) ^ mix32(transferId ^ 0x27d4eb2d));
  const n = payload.length;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    const r = rng.nextU32();
    payload[i] ^= r;
    payload[i + 1] ^= r >>> 8;
    payload[i + 2] ^= r >>> 16;
    payload[i + 3] ^= r >>> 24;
  }
  if (i < n) {
    let r = rng.nextU32();
    for (; i < n; i++, r >>>= 8) payload[i] ^= r;
  }
}

/** Allocates a frame buffer and lets `fill` write the raw (un-whitened) payload. */
export function buildFrame(header: FrameHeader, fill: (payload: Uint8Array) => void): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + header.blockSize);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_MAGIC);
  view.setUint32(1, header.transferId >>> 0, true);
  view.setUint32(5, header.totalLength >>> 0, true);
  view.setUint16(9, header.blockSize, true);
  view.setUint32(11, header.symbolId >>> 0, true);
  const payload = out.subarray(HEADER_SIZE);
  fill(payload);
  whiten(payload, header.transferId, header.symbolId);
  return out;
}

/** Parses and de-whitens a frame; returns null for anything that is not ours. */
export function parseFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length <= HEADER_SIZE || bytes[0] !== FRAME_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const transferId = view.getUint32(1, true);
  const totalLength = view.getUint32(5, true);
  const blockSize = view.getUint16(9, true);
  const symbolId = view.getUint32(11, true);
  if (blockSize === 0 || totalLength === 0 || bytes.length !== HEADER_SIZE + blockSize) return null;
  const payload = bytes.slice(HEADER_SIZE);
  whiten(payload, transferId, symbolId);
  return { transferId, totalLength, blockSize, symbolId, payload };
}
