import { describe, expect, it } from 'vitest';
import { packContainer, unpackContainer } from '../src/core/container';
import { Prng } from '../src/core/prng';
import { TransferEncoder, TransferReceiver } from '../src/core/transfer';
import { photograph } from './helpers/camera';
import { decodeAll } from './helpers/zxing';

describe('end-to-end: file → QR frames → camera → file', () => {
  it('transfers a file through simulated camera captures with frame loss', async () => {
    const rng = new Prng(42);
    const data = new Uint8Array(6000).map(() => rng.nextU32() & 0xff);
    const packed = await packContainer({ name: 'photo.bin', mime: 'application/octet-stream', data });
    const sender = new TransferEncoder(packed.stream, { version: 12, ecc: 'M' });
    const receiver = new TransferReceiver();

    let id = 0;
    let shown = 0;
    let decodedFrames = 0;
    while (!receiver.complete) {
      expect(shown).toBeLessThan(sender.K * 3 + 20);
      const matrix = sender.matrix(id++);
      shown++;
      // 25 % of displayed codes are never captured (camera/display phase mismatch).
      if (rng.nextFloat() < 0.25) continue;
      const image = photograph(matrix, {
        width: 400,
        height: 400,
        pixelsPerModule: 3.6,
        rotation: (rng.nextFloat() - 0.5) * 16,
        blur: 1,
        noise: 25,
        seed: id,
      });
      const codes = await decodeAll(image, { tryHarder: false });
      for (const bytes of codes) {
        decodedFrames++;
        receiver.ingest(bytes, shown * 50);
      }
    }
    const status = receiver.status!;
    expect(status.info).toMatchObject({ name: 'photo.bin', size: data.length });
    const file = await unpackContainer(receiver.stream());
    expect(Array.from(file.data)).toEqual(Array.from(data));
    expect(decodedFrames).toBeGreaterThan(0);
  }, 60_000);

  it('locks onto one transfer and switches only after the old one goes quiet', () => {
    const a = new TransferEncoder(new Uint8Array(5000).fill(1), { version: 10, ecc: 'L' }, 111);
    const b = new TransferEncoder(new Uint8Array(5000).fill(2), { version: 10, ecc: 'L' }, 222);
    const rx = new TransferReceiver();
    expect(rx.ingest(a.frame(0), 0).kind).toBe('pending');
    expect(rx.ingest(a.frame(0), 10).kind).toBe('pending'); // same symbol twice does not confirm
    const started = rx.ingest(a.frame(1), 20);
    expect(started.started).toBe(true);
    expect(rx.status!.transferId).toBe(111);
    expect(rx.status!.rank).toBe(2);
    expect(rx.ingest(b.frame(0), 30).kind).toBe('foreign');
    // After a quiet period the new transfer may take over.
    expect(rx.ingest(b.frame(0), 5000).kind).toBe('pending');
    expect(rx.ingest(b.frame(1), 5010).started).toBe(true);
    expect(rx.status!.transferId).toBe(222);
  });

  it('ignores unrelated QR codes', () => {
    const rx = new TransferReceiver();
    expect(rx.ingest(new TextEncoder().encode('WIFI:S:home;T:WPA;P:secret;;'), 0).kind).toBe('foreign');
    expect(rx.status).toBeNull();
  });
});
