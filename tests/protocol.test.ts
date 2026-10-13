import { describe, expect, it } from 'vitest';
import { packContainer, peekContainerInfo, unpackContainer } from '../src/core/container';
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

describe('container', () => {
  it('round-trips metadata and compresses text', async () => {
    const text = 'Привет, QR! '.repeat(500);
    const data = new TextEncoder().encode(text);
    const packed = await packContainer({ name: 'заметка.txt', mime: 'text/plain', data });
    expect(packed.compressed).toBe(true);
    expect(packed.stream.length).toBeLessThan(data.length / 5);
    expect(peekContainerInfo(packed.stream)).toEqual({ name: 'заметка.txt', mime: 'text/plain', size: data.length, compressed: true });
    const out = await unpackContainer(packed.stream);
    expect(out.name).toBe('заметка.txt');
    expect(new TextDecoder().decode(out.data)).toBe(text);
  });

  it('stores incompressible data as is and detects corruption', async () => {
    const data = new Uint8Array(5000).map((_, i) => (i * 2654435761) >>> 24);
    const packed = await packContainer({ name: 'x.bin', mime: 'image/jpeg', data });
    expect(packed.compressed).toBe(false);
    expect(Array.from((await unpackContainer(packed.stream)).data)).toEqual(Array.from(data));
    packed.stream[packed.stream.length - 1] ^= 1;
    await expect(unpackContainer(packed.stream)).rejects.toThrow(/CRC/);
  });

  it('handles empty files', async () => {
    const packed = await packContainer({ name: 'empty', mime: '', data: new Uint8Array(0) });
    const out = await unpackContainer(packed.stream);
    expect(out.data.length).toBe(0);
    expect(out.mime).toBe('application/octet-stream');
  });
});
