// QR recognition with ZXing-C++ compiled to WebAssembly. Several of these run in
// parallel; the WASM binary is bundled locally so the app works fully offline.

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { DecodeRequest, DecodeResponse, DetectedQuad } from './messages';

function post(msg: DecodeResponse): void {
  self.postMessage(msg);
}

const ready = prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
  fireImmediately: true,
});
ready.then(
  () => post({ type: 'ready' }),
  (err: unknown) => post({ type: 'error', id: -1, message: `ZXing не загрузился: ${String(err)}` }),
);

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, image, maxSymbols } = e.data;
  const t0 = performance.now();
  try {
    await ready;
    const results = await readBarcodes(image, {
      formats: ['QRCode'],
      tryHarder: false,
      tryRotate: false,
      tryInvert: false,
      tryDownscale: true,
      maxNumberOfSymbols: maxSymbols,
      returnErrors: true,
    });
    const codes: Uint8Array[] = [];
    const quads: DetectedQuad[] = [];
    for (const r of results) {
      if (r.isValid) codes.push(r.bytes);
      const p = r.position;
      quads.push({
        valid: r.isValid,
        points: [p.topLeft.x, p.topLeft.y, p.topRight.x, p.topRight.y, p.bottomRight.x, p.bottomRight.y, p.bottomLeft.x, p.bottomLeft.y],
        version: Number.parseInt(r.version, 10) || 0,
      });
    }
    post({ type: 'result', id, codes, quads, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
