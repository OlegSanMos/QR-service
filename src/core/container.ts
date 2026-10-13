// The byte stream that is actually fountain-coded: a small metadata header
// followed by the (optionally deflate-compressed) file contents.
//
//   offset size field
//   0      1    container version (1)
//   1      1    flags: bit0 = payload is deflate-raw compressed
//   2      4    original file size (u32 LE)
//   6      4    CRC-32 of the original file
//   10     2    file name length N (u16 LE, UTF-8 bytes)
//   12     N    file name
//   12+N   1    MIME type length M
//   13+N   M    MIME type (ASCII)
//   13+N+M ...  payload

import { crc32 } from './crc32';
import { MAX_TOTAL_LENGTH } from './protocol';

const CONTAINER_VERSION = 1;
const FLAG_DEFLATE = 1;
const MAX_NAME_BYTES = 1024;
const MAX_MIME_BYTES = 255;

export interface FileDescriptor {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface PackedContainer {
  stream: Uint8Array;
  compressed: boolean;
}

export interface UnpackedContainer extends FileDescriptor {
  compressed: boolean;
}

/** MIME types whose contents are already compressed; deflate would only waste time. */
const INCOMPRESSIBLE = /^(image\/(jpeg|png|gif|webp|avif|heic|heif)|video\/|audio\/(mpeg|mp4|aac|ogg|opus|webm)|application\/(zip|gzip|x-7z-compressed|x-rar-compressed|x-bzip2|x-xz|zstd|pdf|vnd\.android\.package-archive))/;

function truncateUtf8(s: string, maxBytes: number): Uint8Array {
  const enc = new TextEncoder();
  let bytes = enc.encode(s);
  while (bytes.length > maxBytes) {
    s = s.slice(0, -1);
    bytes = enc.encode(s);
  }
  return bytes;
}

async function pipeThrough(data: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function compressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

export async function packContainer(file: FileDescriptor, options: { compress?: boolean } = {}): Promise<PackedContainer> {
  const { data } = file;
  if (data.length > MAX_TOTAL_LENGTH) throw new RangeError('file is larger than 4 GiB');
  let payload = data;
  let flags = 0;
  const wantCompress = (options.compress ?? true) && compressionSupported() && data.length > 64 && !INCOMPRESSIBLE.test(file.mime);
  if (wantCompress) {
    const deflated = await pipeThrough(data, new CompressionStream('deflate-raw'));
    if (deflated.length < data.length * 0.97) {
      payload = deflated;
      flags |= FLAG_DEFLATE;
    }
  }
  const name = truncateUtf8(file.name || 'file', MAX_NAME_BYTES);
  const mime = new TextEncoder().encode((file.mime || 'application/octet-stream').slice(0, MAX_MIME_BYTES));
  const headerLen = 13 + name.length + mime.length;
  if (headerLen + payload.length > MAX_TOTAL_LENGTH) throw new RangeError('file is larger than 4 GiB');
  const stream = new Uint8Array(headerLen + payload.length);
  const view = new DataView(stream.buffer);
  view.setUint8(0, CONTAINER_VERSION);
  view.setUint8(1, flags);
  view.setUint32(2, data.length, true);
  view.setUint32(6, crc32(data), true);
  view.setUint16(10, name.length, true);
  stream.set(name, 12);
  view.setUint8(12 + name.length, mime.length);
  stream.set(mime, 13 + name.length);
  stream.set(payload, headerLen);
  return { stream, compressed: (flags & FLAG_DEFLATE) !== 0 };
}

export interface ContainerInfo {
  name: string;
  mime: string;
  size: number;
  compressed: boolean;
}

/** Reads the metadata from the beginning of a (possibly partial) stream, or null if incomplete. */
export function peekContainerInfo(head: Uint8Array): ContainerInfo | null {
  if (head.length < 13 || head[0] !== CONTAINER_VERSION) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const nameLen = view.getUint16(10, true);
  if (head.length < 13 + nameLen) return null;
  const mimeLen = view.getUint8(12 + nameLen);
  if (head.length < 13 + nameLen + mimeLen) return null;
  const dec = new TextDecoder();
  return {
    name: dec.decode(head.subarray(12, 12 + nameLen)),
    mime: dec.decode(head.subarray(13 + nameLen, 13 + nameLen + mimeLen)),
    size: view.getUint32(2, true),
    compressed: (view.getUint8(1) & FLAG_DEFLATE) !== 0,
  };
}

export async function unpackContainer(stream: Uint8Array): Promise<UnpackedContainer> {
  const info = peekContainerInfo(stream);
  if (!info) throw new Error('повреждённый заголовок файла');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const expectedCrc = view.getUint32(6, true);
  const nameLen = view.getUint16(10, true);
  const mimeLen = view.getUint8(12 + nameLen);
  const payload = stream.subarray(13 + nameLen + mimeLen);
  let data: Uint8Array;
  if (info.compressed) {
    if (!compressionSupported()) throw new Error('браузер не поддерживает распаковку (DecompressionStream)');
    data = await pipeThrough(payload, new DecompressionStream('deflate-raw'));
  } else {
    data = payload.slice();
  }
  if (data.length !== info.size) throw new Error(`неверный размер: ${data.length} ≠ ${info.size}`);
  if (crc32(data) !== expectedCrc) throw new Error('контрольная сумма CRC-32 не совпала');
  return { name: info.name, mime: info.mime, data, compressed: info.compressed };
}
