import type { FileEntry, Method } from '../core/container';
import type { CodecRequest, CodecResponse } from '../workers/messages';

export interface CodecProgress {
  phase: Method;
  done: number;
  total: number;
}

type Packed = Extract<CodecResponse, { type: 'packed' }>;
type Unpacked = Extract<CodecResponse, { type: 'unpacked' }>;

/** Runs one pack/unpack job in a fresh codec worker (terminated afterwards to free the model tables). */
function run<T extends CodecResponse>(req: CodecRequest, transfer: Transferable[], onProgress?: (p: CodecProgress) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/codec.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<CodecResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.({ phase: msg.phase, done: msg.done, total: msg.total });
        return;
      }
      worker.terminate();
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg as T);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'не удалось запустить упаковщик'));
    };
    worker.postMessage(req, transfer);
  });
}

export function packInWorker(
  files: FileEntry[],
  options: { method?: Method | 'auto'; linkBytesPerSecond: number },
  onProgress?: (p: CodecProgress) => void,
): Promise<Packed> {
  // Copies (no transfer): the sender keeps its files for a possible restart with other settings.
  return run<Packed>({ type: 'pack', id: 1, files, method: options.method ?? 'auto', linkBytesPerSecond: options.linkBytesPerSecond }, [], onProgress);
}

export function unpackInWorker(stream: Uint8Array, onProgress?: (p: CodecProgress) => void): Promise<Unpacked> {
  return run<Unpacked>({ type: 'unpack', id: 1, stream }, [stream.buffer], onProgress);
}
