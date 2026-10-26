// A second fake-camera clip: the sender shows two codes side by side (like the
// "2 кода на экране" mode: quiet zones plus a 4-module gap) and changes them
// 30 times a second, filmed at 60 fps. Every 7th code is missing to exercise
// fountain recovery.

import { writeFileSync } from 'node:fs';
import { packFiles } from '../src/core/container';
import { Prng } from '../src/core/prng';
import { TransferEncoder } from '../src/core/transfer';
import { MULTI_CAMERA_SOURCE, MULTI_CAMERA_VIDEO } from './paths';

const W = 640;
const H = 360;
const CODES = 2;
const PPM = 3;

export async function makeMultiCodeClip(): Promise<void> {
  const rng = new Prng(11);
  const data = new Uint8Array(30_000).map(() => rng.nextU32() & 255);
  writeFileSync(MULTI_CAMERA_SOURCE, data);
  const packed = await packFiles([{ name: 'multi.bin', mime: 'application/octet-stream', data }], { method: 'store' });
  const enc = new TransferEncoder(packed.stream, { version: 10, ecc: 'M' }, 0x00e2e002);
  const symbols = enc.K * 2 + 12;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F60:1 Ip A1:1 C420jpeg\n`, 'ascii');
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const chunks: Buffer[] = [header];
  for (let first = 0; first < symbols; first += CODES) {
    const y = Buffer.alloc(W * H, 90);
    for (let c = 0; c < CODES; c++) {
      const id = first + c;
      if (id % 7 === 3) continue; // this code was not captured cleanly: show a blank canvas
      const { size, modules } = enc.matrix(id);
      const total = (size + 8) * PPM;
      const gap = 4 * PPM; // the sender leaves 4 extra modules between codes
      const ox = Math.floor((W - total * CODES - gap * (CODES - 1)) / 2) + c * (total + gap);
      const oy = Math.floor((H - total) / 2);
      for (let py = 0; py < total; py++) {
        for (let px = 0; px < total; px++) {
          const mx = Math.floor(px / PPM) - 4;
          const my = Math.floor(py / PPM) - 4;
          const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx] === 1;
          y[(oy + py) * W + ox + px] = dark ? 25 : 230;
        }
      }
    }
    for (let rep = 0; rep < 2; rep++) chunks.push(Buffer.from('FRAME\n', 'ascii'), y, chroma);
  }
  writeFileSync(MULTI_CAMERA_VIDEO, Buffer.concat(chunks));
}
