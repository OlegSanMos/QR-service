// Produces ready-to-blit QR frames ahead of time so the display loop on the
// main thread only has to copy pixels.

import { Layout } from '../core/fountain/layout';
import { TransferEncoder } from '../core/transfer';
import type { EncodeRequest, EncodeResponse, RenderedFrame } from './messages';

const QUIET_ZONE = 4;

let encoder: TransferEncoder | null = null;
let epoch = -1;

function post(msg: EncodeResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function render(symbolId: number, enc: TransferEncoder): RenderedFrame {
  const { size, modules } = enc.matrix(symbolId);
  const width = size + QUIET_ZONE * 2;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < size; y++) {
    let p = ((y + QUIET_ZONE) * width + QUIET_ZONE) * 4;
    const row = y * size;
    for (let x = 0; x < size; x++, p += 4) {
      if (modules[row + x]) pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
    }
  }
  return { symbolId, pixels, width };
}

self.onmessage = (e: MessageEvent<EncodeRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      epoch = msg.epoch;
      encoder = new TransferEncoder(msg.stream, { version: msg.version, ecc: msg.ecc }, msg.transferId);
      post({ type: 'ready', epoch, K: encoder.K, G: new Layout(encoder.K).G, blockSize: encoder.blockSize, size: encoder.qr.size });
    } else if (msg.type === 'frames') {
      if (msg.epoch !== epoch || !encoder) return;
      const t0 = performance.now();
      const frames: RenderedFrame[] = [];
      for (let i = 0; i < msg.count; i++) frames.push(render(msg.firstId + i, encoder));
      post({ type: 'frames', epoch, frames, ms: performance.now() - t0 }, frames.map((f) => f.pixels.buffer));
    }
  } catch (err) {
    post({ type: 'error', epoch: msg.epoch, message: err instanceof Error ? err.message : String(err) });
  }
};
