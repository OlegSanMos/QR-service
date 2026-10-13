// Renders a QR transfer into a raw YUV4MPEG2 clip for Chromium's fake camera.
// Each code is held for 2 camera frames (≈ 15 codes/s at 30 fps) and every 5th
// code is skipped to exercise fountain recovery.

import { mkdirSync, writeFileSync } from 'node:fs';
import { packContainer } from '../src/core/container';
import { TransferEncoder } from '../src/core/transfer';
import { CACHE_DIR, FAKE_CAMERA_SOURCE, FAKE_CAMERA_VIDEO } from './paths';

const W = 480;
const H = 360;

export default async function globalSetup(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}. Файл передан по воздуху через поток QR-кодов — ${(i * 7919) % 10007}`);
  const text = lines.join('\n');
  writeFileSync(FAKE_CAMERA_SOURCE, text);
  // No compression: keeps the clip long enough to need several generations' worth of frames.
  const packed = await packContainer({ name: 'e2e.txt', mime: 'text/plain', data: new TextEncoder().encode(text) }, { compress: false });
  const enc = new TransferEncoder(packed.stream, { version: 10, ecc: 'M' }, 0x00e2e000);
  const symbols = enc.K * 2 + 10;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`, 'ascii');
  const ySize = W * H;
  const cSize = (W / 2) * (H / 2);
  const chunks: Buffer[] = [header];
  for (let id = 0; id < symbols; id++) {
    if (id % 5 === 4) continue;
    const { size, modules } = enc.matrix(id);
    const ppm = 4;
    const total = (size + 8) * ppm;
    const ox = Math.floor((W - total) / 2);
    const oy = Math.floor((H - total) / 2);
    const y = Buffer.alloc(ySize, 90); // grey surroundings, like a phone bezel
    for (let py = 0; py < total; py++) {
      for (let px = 0; px < total; px++) {
        const mx = Math.floor(px / ppm) - 4;
        const my = Math.floor(py / ppm) - 4;
        const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx] === 1;
        y[(oy + py) * W + ox + px] = dark ? 25 : 230;
      }
    }
    const chroma = Buffer.alloc(cSize * 2, 128);
    for (let rep = 0; rep < 2; rep++) chunks.push(Buffer.from('FRAME\n', 'ascii'), y, chroma);
  }
  writeFileSync(FAKE_CAMERA_VIDEO, Buffer.concat(chunks));
}
