import { describe, expect, it } from 'vitest';
import { QrEncoder } from '../src/core/qr/encoder';
import { ECC_LEVELS, byteCapacity } from '../src/core/qr/tables';
import { decodeAll, rasterize } from './helpers/zxing';

function randomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

describe('QR capacity tables', () => {
  it('matches the well-known byte-mode capacities', () => {
    expect(byteCapacity(1, 'L')).toBe(17);
    expect(byteCapacity(1, 'H')).toBe(7);
    expect(byteCapacity(10, 'M')).toBe(213);
    expect(byteCapacity(25, 'L')).toBe(1273);
    expect(byteCapacity(40, 'L')).toBe(2953);
    expect(byteCapacity(40, 'M')).toBe(2331);
    expect(byteCapacity(40, 'Q')).toBe(1663);
    expect(byteCapacity(40, 'H')).toBe(1273);
  });
});

describe('QrEncoder round-trip through ZXing', () => {
  for (const ecc of ECC_LEVELS) {
    it(`decodes every version 1..40 at ECC ${ecc} with full-capacity random payloads`, async () => {
      for (let version = 1; version <= 40; version++) {
        const enc = new QrEncoder(version, ecc);
        const payload = randomBytes(enc.capacity, version * 31 + ecc.charCodeAt(0));
        const matrix = enc.encode(payload);
        expect(matrix.size).toBe(version * 4 + 17);
        const decoded = await decodeAll(rasterize(matrix, 3));
        expect(decoded.length, `v${version}-${ecc}`).toBe(1);
        expect(Buffer.from(decoded[0]).equals(Buffer.from(payload)), `v${version}-${ecc}`).toBe(true);
      }
    }, 60_000);
  }

  it('decodes with every forced mask and short payloads', async () => {
    for (const version of [2, 7, 21, 32, 40]) {
      for (let mask = 0; mask < 8; mask++) {
        const enc = new QrEncoder(version, 'M', { mask });
        for (const len of [1, 2, 17, Math.floor(enc.capacity / 2)]) {
          const payload = randomBytes(len, mask * 7 + len + 1);
          const matrix = enc.encode(payload);
          expect(matrix.mask).toBe(mask);
          const decoded = await decodeAll(rasterize(matrix, 3));
          expect(decoded.length, `v${version} mask${mask} len${len}`).toBe(1);
          expect(Array.from(decoded[0])).toEqual(Array.from(payload));
        }
      }
    }
  }, 60_000);

  it('handles degenerate payloads (all zeros / all 0xFF)', async () => {
    const enc = new QrEncoder(20, 'L');
    for (const fill of [0x00, 0xff, 0xec]) {
      const payload = new Uint8Array(enc.capacity).fill(fill);
      const decoded = await decodeAll(rasterize(enc.encode(payload), 3));
      expect(Array.from(decoded[0])).toEqual(Array.from(payload));
    }
  });

  it('rejects oversize payloads', () => {
    const enc = new QrEncoder(5, 'L');
    expect(() => enc.encode(new Uint8Array(enc.capacity + 1))).toThrow(RangeError);
  });
});
