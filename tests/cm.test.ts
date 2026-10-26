import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cmCompress, cmDecompress } from '../src/core/cm';
import { crc32 } from '../src/core/crc32';
import { Prng } from '../src/core/prng';

function roundTrip(data: Uint8Array): Uint8Array {
  const packed = cmCompress(data);
  const back = cmDecompress(packed, data.length);
  expect(back.length).toBe(data.length);
  expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
  return packed;
}

const text = new TextEncoder().encode(
  Array.from({ length: 400 }, (_, i) => `Строка ${i}: передача файлов через поток QR-кодов, line ${i * 7} — ok.\n`).join(''),
);

describe('context-mixing compressor', () => {
  it('round-trips edge cases', () => {
    roundTrip(new Uint8Array(0));
    roundTrip(Uint8Array.of(0));
    roundTrip(Uint8Array.of(255));
    roundTrip(new Uint8Array(5000)); // all zeros
    roundTrip(new Uint8Array(5000).fill(0xab));
    roundTrip(new Uint8Array(70000).map((_, i) => i & 255)); // ramp, crosses table-size thresholds
  });

  it('round-trips random data with little expansion', () => {
    const rng = new Prng(7);
    const data = new Uint8Array(100_000).map(() => rng.nextU32() & 255);
    const packed = roundTrip(data);
    expect(packed.length).toBeLessThan(data.length * 1.03);
  });

  it('beats deflate on text by a wide margin', () => {
    const packed = roundTrip(text);
    const deflated = deflateRawSync(text, { level: 9 }).length;
    expect(packed.length).toBeLessThan(deflated * 0.8);
  });

  it('round-trips structured binary data and long repeats', () => {
    const rng = new Prng(3);
    const rec = new Uint8Array(60_000);
    for (let i = 0; i < rec.length; i += 12) {
      new DataView(rec.buffer).setUint32(i, i * 3, true);
      new DataView(rec.buffer).setFloat32(i + 4, i / 7, true);
      rec[i + 8] = rng.nextU32() & 3;
    }
    roundTrip(rec);
    const block = text.subarray(0, 3000);
    const repeated = new Uint8Array(block.length * 5);
    for (let i = 0; i < 5; i++) repeated.set(block, i * block.length);
    expect(roundTrip(repeated).length).toBeLessThan(roundTrip(block).length * 1.2);
  });

  it('is deterministic and its format is frozen (sender and receiver may run different app versions)', () => {
    const a = cmCompress(text);
    const b = cmCompress(text);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // Changing the model changes this fingerprint. If that is intended, it is a new
    // format: give it a new method id in container.ts instead of editing this value.
    expect({ length: a.length, crc: crc32(a).toString(16) }).toMatchInlineSnapshot(`
      {
        "crc": "b76df67",
        "length": 875,
      }
    `);
  });

  it('reports progress', () => {
    const calls: number[] = [];
    cmCompress(new Uint8Array(200_000), (done) => calls.push(done));
    expect(calls.at(-1)).toBe(200_000);
    expect(calls.length).toBeGreaterThan(2);
  });
});
