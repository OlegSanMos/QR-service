import { describe, expect, it } from 'vitest';
import { readBarcodes } from 'zxing-wasm/reader';
import { TransferEncoder } from '../src/core/transfer';
import { CodeTracker } from '../src/core/tracks';
import { photograph } from './helpers/camera';
import './helpers/zxing';

// Two v25 codes as the sender's 2-code mode shows them (quiet 4 + gap 4 + quiet 4
// modules between the symbols), filmed by a phone in portrait (codes one above
// the other) or in landscape (side by side). Each track's crop is decoded on its
// own with the receiver worker's options and must not trip over the neighbour.
describe('per-code crops next to another code', () => {
  for (const layout of ['portrait', 'landscape'] as const) {
    it(`decode reliably, camera in ${layout}`, async () => {
      const enc = new TransferEncoder(new Uint8Array(200_000).map((_, i) => (i * 131) & 255), { version: 25, ecc: 'L' });
      const N = 117;
      const S = 4 + N + 12 + N + 4; // both symbols with the space between them and outer margins
      const off = Math.floor((S - N) / 2);
      const across = layout === 'landscape';
      const W = across ? 1200 : 600;
      const H = across ? 600 : 1200;
      const at = (along: number, side: number): [number, number] => (across ? [along, side] : [side, along]);
      let ok = 0;
      let total = 0;
      for (const ppm of [3, 3.5, 4]) {
        for (let f = 0; f < 12; f++) {
          const a = enc.matrix(2 * f);
          const b = enc.matrix(2 * f + 1);
          const modules = new Uint8Array(S * S);
          for (let y = 0; y < N; y++)
            for (let x = 0; x < N; x++) {
              const [ax, ay] = at(4 + x, off + y);
              const [bx, by] = at(4 + N + 12 + x, off + y);
              modules[ay * S + ax] = a.modules[y * N + x];
              modules[by * S + bx] = b.modules[y * N + x];
            }
          const img = photograph({ size: S, modules } as never, { width: W, height: H, pixelsPerModule: ppm, blur: 1, noise: 30, seed: f + 1 });
          const quiet = S + 8;
          const toCam = ([mx, my]: [number, number]): [number, number] => [W / 2 + (mx + 4 - quiet / 2) * ppm, H / 2 + (my + 4 - quiet / 2) * ppm];
          const [x0, y0] = toCam(at(4, off));
          const [x1, y1] = toCam(at(4 + N, off + N));
          const tracker = new CodeTracker(W, H);
          tracker.update([{ points: [x0, y0, x1, y0, x1, y1, x0, y1], version: 25 }], null);
          const rect = tracker.all[0].rect;
          const data = new Uint8ClampedArray(rect.w * rect.h * 4);
          for (let y = 0; y < rect.h; y++) data.set(img.data.subarray(((rect.y + y) * W + rect.x) * 4, ((rect.y + y) * W + rect.x + rect.w) * 4), y * rect.w * 4);
          const res = await readBarcodes({ width: rect.w, height: rect.h, data } as unknown as ImageData, {
            formats: ['QRCode'],
            tryHarder: false,
            tryRotate: false,
            tryInvert: false,
            tryDownscale: true,
            maxNumberOfSymbols: 1,
          });
          if (res.some((r) => r.isValid)) ok++;
          total++;
        }
      }
      expect(ok / total).toBeGreaterThanOrEqual(0.9);
    }, 120_000);
  }
});
