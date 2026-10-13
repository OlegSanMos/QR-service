import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
import type { QrMatrix } from '../../src/core/qr/encoder';

const require = createRequire(import.meta.url);
const wasmBinary = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
prepareZXingModule({ overrides: { wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer } });

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Rasterises a QR matrix with a quiet zone at an integer scale. */
export function rasterize(matrix: QrMatrix, scale = 4, quiet = 4): RgbaImage {
  const total = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.modules[y * matrix.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + quiet) * scale + dy) * total;
        for (let dx = 0; dx < scale; dx++) {
          const p = (row + (x + quiet) * scale + dx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
        }
      }
    }
  }
  return { width: total, height: total, data };
}

export async function decodeAll(image: RgbaImage, options: ReaderOptions = {}): Promise<Uint8Array[]> {
  const results = await readBarcodes(image as unknown as ImageData, {
    formats: ['QRCode'],
    tryHarder: true,
    maxNumberOfSymbols: 8,
    ...options,
  });
  return results.filter((r) => r.isValid).map((r) => r.bytes);
}
