// Packing and unpacking run here: context-mixing compression processes about
// a megabyte per second and would otherwise freeze the page.

import { packFiles, unpackContainer, type PackProgress } from '../core/container';
import type { CodecRequest, CodecResponse } from './messages';

function post(msg: CodecResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function progress(id: number): (p: PackProgress) => void {
  let last = 0;
  return (p) => {
    const t = performance.now();
    if (t - last < 100 && p.done < p.total) return;
    last = t;
    post({ type: 'progress', id, phase: p.phase, done: p.done, total: p.total });
  };
}

self.onmessage = async (e: MessageEvent<CodecRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'pack') {
      const remembered = msg.remembered ?? {};
      const r = await packFiles(msg.files, {
        method: msg.method,
        linkBytesPerSecond: msg.linkBytesPerSecond,
        onProgress: progress(msg.id),
        rememberedMethod: (key) => (Object.hasOwn(remembered, key) ? remembered[key] : undefined),
      });
      post({ type: 'packed', id: msg.id, stream: r.stream, method: r.method, totalSize: r.totalSize, candidates: r.candidates, key: r.key }, [r.stream.buffer]);
    } else {
      const r = await unpackContainer(msg.stream, progress(msg.id));
      // Each file is a view into one buffer; copy so every file can be transferred on its own.
      const files = r.files.map((f) => ({ name: f.name, mime: f.mime, data: f.data.slice() }));
      post({ type: 'unpacked', id: msg.id, files, method: r.method }, files.map((f) => f.data.buffer));
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
