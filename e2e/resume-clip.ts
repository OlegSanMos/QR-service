// Fake-camera clip for the resume tests: 320×240 at 8 fps with one code per
// frame (8 codes/s), ~60 systematic symbols plus 8 repair ones, so a transfer
// takes ~8 s and the page can be reloaded halfway. Small on purpose: ~8 MB.

import { writeFileSync } from 'node:fs';
import { packFiles } from '../src/core/container';
import { TransferEncoder } from '../src/core/transfer';
import { RESUME_CAMERA_SOURCE, RESUME_CAMERA_VIDEO } from './paths';

const W = 320;
const H = 240;
const FPS = 8;
const PPM = 4;

export async function makeResumeClip(): Promise<void> {
  const lines = Array.from({ length: 90 }, (_, i) => `${i + 1}. Приём продолжается после перезагрузки — ${(i * 7919) % 10007}`);
  const text = lines.join('\n');
  writeFileSync(RESUME_CAMERA_SOURCE, text);
  // Stored uncompressed, so the transfer stays long enough to interrupt.
  const packed = await packFiles([{ name: 'resume.txt', mime: 'text/plain', data: new TextEncoder().encode(text) }], { method: 'store' });
  // The default, content-derived transfer id, as a real sender would use.
  const enc = new TransferEncoder(packed.stream, { version: 8, ecc: 'M' });
  const chunks: Buffer[] = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`, 'ascii')];
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  for (let id = 0; id < enc.K + 8; id++) {
    const { size, modules } = enc.matrix(id);
    const total = (size + 8) * PPM;
    const ox = Math.floor((W - total) / 2);
    const oy = Math.floor((H - total) / 2);
    const y = Buffer.alloc(W * H, 90);
    for (let py = 0; py < total; py++) {
      for (let px = 0; px < total; px++) {
        const mx = Math.floor(px / PPM) - 4;
        const my = Math.floor(py / PPM) - 4;
        const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx] === 1;
        y[(oy + py) * W + ox + px] = dark ? 25 : 230;
      }
    }
    chunks.push(Buffer.from('FRAME\n', 'ascii'), y, chroma);
  }
  writeFileSync(RESUME_CAMERA_VIDEO, Buffer.concat(chunks));
}
