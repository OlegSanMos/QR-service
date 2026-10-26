import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32';
import { HEADER_SIZE, buildFrame, parseFrame } from '../src/core/protocol';

describe('crc32', () => {
  it('matches the reference check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('frame protocol', () => {
  it('round-trips header and payload, whitening on the wire', () => {
    const payload = new Uint8Array(100).fill(0);
    const frame = buildFrame({ transferId: 0xdeadbeef, totalLength: 123456, blockSize: 100, symbolId: 77 }, (p) => p.set(payload));
    expect(frame.length).toBe(HEADER_SIZE + 100);
    // Whitened: an all-zero payload must not stay all-zero on the wire.
    expect(frame.subarray(HEADER_SIZE).some((b) => b !== 0)).toBe(true);
    const parsed = parseFrame(frame)!;
    expect(parsed).toMatchObject({ transferId: 0xdeadbeef, totalLength: 123456, blockSize: 100, symbolId: 77 });
    expect(Array.from(parsed.payload)).toEqual(Array.from(payload));
  });

  it('rejects foreign or inconsistent data', () => {
    expect(parseFrame(new TextEncoder().encode('https://example.com'))).toBeNull();
    const frame = buildFrame({ transferId: 1, totalLength: 10, blockSize: 20, symbolId: 0 }, () => {});
    expect(parseFrame(frame.subarray(0, frame.length - 1))).toBeNull();
  });
});
