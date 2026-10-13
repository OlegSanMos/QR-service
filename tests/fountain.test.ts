import { describe, expect, it } from 'vitest';
import { FountainDecoder } from '../src/core/fountain/decoder';
import { FountainEncoder } from '../src/core/fountain/encoder';
import { GENERATION_MAX, Layout, repairCoefficients } from '../src/core/fountain/layout';
import { Prng } from '../src/core/prng';

function sample(len: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  return new Uint8Array(len).map(() => rng.nextU32() & 0xff);
}

/** Feeds symbols from `start`, dropping each with probability `loss`; returns the decoder. */
function transmit(enc: FountainEncoder, loss: number, start: number, seed: number): FountainDecoder {
  const rng = new Prng(seed);
  const dec = new FountainDecoder(enc.K, enc.blockSize);
  for (let id = start; !dec.isComplete; id++) {
    if (id > start + 20 * enc.K + 200) throw new Error('decoder did not converge');
    if (rng.nextFloat() >= loss) dec.addSymbol(id, enc.encode(id));
  }
  return dec;
}

describe('Layout', () => {
  it('partitions K blocks into balanced generations', () => {
    for (const K of [1, 2, 1023, 1024, 1025, 5000, 70001]) {
      const l = new Layout(K);
      expect(l.G).toBe(Math.ceil(K / GENERATION_MAX));
      let total = 0;
      for (let g = 0; g < l.G; g++) {
        expect(l.start(g)).toBe(total);
        expect(l.size(g)).toBeLessThanOrEqual(GENERATION_MAX);
        expect(l.size(g)).toBeGreaterThanOrEqual(Math.floor(K / l.G));
        total += l.size(g);
      }
      expect(total).toBe(K);
      for (const b of [0, K - 1, Math.floor(K / 2)]) {
        const { g, local } = l.locate(b);
        expect(l.start(g) + local).toBe(b);
      }
    }
  });

  it('never produces an all-zero repair row and is deterministic', () => {
    for (const size of [1, 2, 3, 31, 32, 33, 1024]) {
      for (let local = size; local < size + 200; local++) {
        const a = new Uint32Array((size + 31) >>> 5);
        const b = new Uint32Array(a.length);
        repairCoefficients(3, local, size, a);
        repairCoefficients(3, local, size, b);
        expect(a.some((w) => w !== 0)).toBe(true);
        expect(Array.from(a)).toEqual(Array.from(b));
        if (size & 31) expect(a[a.length - 1] >>> (size & 31)).toBe(0);
      }
    }
  });
});

describe('Fountain code', () => {
  it('passes systematic symbols through verbatim', () => {
    const data = sample(1000, 1);
    const enc = new FountainEncoder(data, 100);
    expect(Array.from(enc.encode(3))).toEqual(Array.from(data.subarray(300, 400)));
  });

  it('needs exactly K symbols without loss', () => {
    const data = sample(64 * 300 - 5, 2);
    const enc = new FountainEncoder(data, 64);
    const dec = transmit(enc, 0, 0, 1);
    expect(dec.received).toBe(enc.K);
    expect(dec.getData(data.length)).toEqual(data);
  });

  for (const [K, loss, start] of [
    [1, 0.5, 0],
    [7, 0.3, 0],
    [100, 0.2, 0],
    [100, 0.5, 1000],
    [1024, 0.1, 0],
    [1024, 0.6, 512],
    [2500, 0.25, 0],
  ] as const) {
    it(`recovers K=${K} with ${loss * 100}% loss starting at symbol ${start}`, () => {
      const blockSize = 37; // deliberately not a multiple of 4
      const data = sample(K * blockSize - 3, K);
      const enc = new FountainEncoder(data, blockSize);
      expect(enc.K).toBe(K);
      const dec = transmit(enc, loss, start, K * 13 + 1);
      expect(dec.getData(data.length)).toEqual(data);
      // Single generation: ML decoding needs only a handful of extra symbols.
      if (K <= GENERATION_MAX) expect(dec.received - K).toBeLessThan(25);
      else expect(dec.received / K).toBeLessThan(1.08);
    });
  }

  it('ignores duplicates and reports progress', () => {
    const enc = new FountainEncoder(sample(500, 3), 50);
    const dec = new FountainDecoder(enc.K, 50);
    expect(dec.addSymbol(20, enc.encode(20))).toBe('progress');
    expect(dec.addSymbol(20, enc.encode(20))).toBe('duplicate');
    expect(dec.rank).toBe(1);
    for (let id = 21; id < 29; id++) dec.addSymbol(id, enc.encode(id));
    expect(dec.addSymbol(29, enc.encode(29))).toBe('complete');
  });

  it('exposes systematic blocks before completion', () => {
    const data = sample(400, 4);
    const enc = new FountainEncoder(data, 100);
    const dec = new FountainDecoder(enc.K, 100);
    dec.addSymbol(0, enc.encode(0));
    expect(Array.from(dec.getBlock(0)!)).toEqual(Array.from(data.subarray(0, 100)));
    expect(dec.getBlock(1)).toBeNull();
  });
});
