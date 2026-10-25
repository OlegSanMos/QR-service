// DOM-free sender/receiver state machines that glue the container, fountain
// code, frame protocol and QR encoder together. The UI layers only deal with
// pixels and timing.

import { peekContainerInfo, type ContainerInfo } from './container';
import { FountainDecoder, type AddResult } from './fountain/decoder';
import { FountainEncoder } from './fountain/encoder';
import { blockCount } from './fountain/layout';
import { HEADER_SIZE, MAX_BLOCK_SIZE, buildFrame, parseFrame, type Frame } from './protocol';
import { QrEncoder, type QrMatrix } from './qr/encoder';
import { byteCapacity, type Ecc } from './qr/tables';

/** Fixed mask used for whitened frames (see protocol.ts). */
export const STREAM_MASK = 2;

export function blockSizeFor(version: number, ecc: Ecc): number {
  return Math.min(MAX_BLOCK_SIZE, byteCapacity(version, ecc) - HEADER_SIZE);
}

export function randomTransferId(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

export interface EncoderSettings {
  version: number;
  ecc: Ecc;
  /** 'auto' = spec mask selection (slow), otherwise a fixed mask. Defaults to STREAM_MASK. */
  mask?: 'auto' | number;
}

export class TransferEncoder {
  readonly transferId: number;
  readonly totalLength: number;
  readonly blockSize: number;
  readonly K: number;
  readonly qr: QrEncoder;
  private readonly fountain: FountainEncoder;

  constructor(stream: Uint8Array, settings: EncoderSettings, transferId = randomTransferId()) {
    const blockSize = blockSizeFor(settings.version, settings.ecc);
    if (blockSize < 8) throw new RangeError('QR version too small for the frame header');
    this.transferId = transferId >>> 0;
    this.totalLength = stream.length;
    this.blockSize = blockSize;
    this.fountain = new FountainEncoder(stream, blockSize);
    this.K = this.fountain.K;
    this.qr = new QrEncoder(settings.version, settings.ecc, { mask: settings.mask ?? STREAM_MASK });
  }

  frame(symbolId: number): Uint8Array {
    return buildFrame(
      { transferId: this.transferId, totalLength: this.totalLength, blockSize: this.blockSize, symbolId },
      (payload) => this.fountain.encodeInto(symbolId, payload),
    );
  }

  matrix(symbolId: number): QrMatrix {
    return this.qr.encode(this.frame(symbolId));
  }
}

// ---------------------------------------------------------------------------

export type IngestKind = 'foreign' | 'pending' | AddResult;

export interface IngestOutcome {
  kind: IngestKind;
  /** True when this frame started a new transfer session. */
  started: boolean;
}

export interface ReceiverStatus {
  transferId: number;
  totalLength: number;
  blockSize: number;
  K: number;
  /** Independent equations collected so far; the transfer completes at K. */
  rank: number;
  received: number;
  duplicates: number;
  startedAt: number;
  lastProgressAt: number;
  completedAt: number | null;
  info: ContainerInfo | null;
}

interface Session {
  header: Pick<Frame, 'transferId' | 'totalLength' | 'blockSize'>;
  decoder: FountainDecoder;
  duplicates: number;
  startedAt: number;
  lastSeenAt: number;
  lastProgressAt: number;
  completedAt: number | null;
  info: ContainerInfo | null;
}

/** A transfer we have seen once; it is only allocated after a second consistent frame. */
interface Candidate {
  frame: Frame;
  seenAt: number;
}

/** How much of the stream start is examined for the archive header (file list). */
const MAX_HEADER_PEEK = 256 * 1024;

/** After this long without frames from the current transfer, a new one may take over. */
const SWITCH_AFTER_MS = 2500;

export class TransferReceiver {
  private session: Session | null = null;
  private candidate: Candidate | null = null;

  /** Total QR codes that parsed as our protocol (including duplicates). */
  framesAccepted = 0;

  ingest(bytes: Uint8Array, now: number): IngestOutcome {
    const frame = parseFrame(bytes);
    if (!frame) return { kind: 'foreign', started: false };
    this.framesAccepted++;
    const s = this.session;
    if (s && frame.transferId === s.header.transferId) {
      if (frame.totalLength !== s.header.totalLength || frame.blockSize !== s.header.blockSize) {
        return { kind: 'foreign', started: false };
      }
      s.lastSeenAt = now;
      return { kind: this.feed(s, frame, now), started: false };
    }
    if (s && s.completedAt === null && now - s.lastSeenAt < SWITCH_AFTER_MS) {
      return { kind: 'foreign', started: false };
    }
    // A header is only trusted once two distinct frames agree on it: this keeps a
    // single misread code from making us allocate a multi-gigabyte buffer.
    const c = this.candidate;
    if (
      c &&
      c.frame.transferId === frame.transferId &&
      c.frame.totalLength === frame.totalLength &&
      c.frame.blockSize === frame.blockSize &&
      c.frame.symbolId !== frame.symbolId
    ) {
      this.candidate = null;
      const K = blockCount(frame.totalLength, frame.blockSize);
      const session: Session = {
        header: { transferId: frame.transferId, totalLength: frame.totalLength, blockSize: frame.blockSize },
        decoder: new FountainDecoder(K, frame.blockSize),
        duplicates: 0,
        startedAt: c.seenAt,
        lastSeenAt: now,
        lastProgressAt: now,
        completedAt: null,
        info: null,
      };
      this.session = session;
      this.feed(session, c.frame, now);
      return { kind: this.feed(session, frame, now), started: true };
    }
    this.candidate = { frame, seenAt: now };
    return { kind: 'pending', started: false };
  }

  private feed(s: Session, frame: Frame, now: number): AddResult {
    const result = s.decoder.addSymbol(frame.symbolId, frame.payload);
    if (result === 'duplicate') s.duplicates++;
    if (result === 'progress' || result === 'complete') {
      s.lastProgressAt = now;
      if (!s.info) s.info = this.peekInfo(s);
    }
    if (result === 'complete' && s.completedAt === null) s.completedAt = now;
    return result;
  }

  private peekInfo(s: Session): ContainerInfo | null {
    const parts: Uint8Array[] = [];
    let len = 0;
    // The archive header lists every file, so it may span several blocks.
    for (let b = 0; b < s.decoder.K && len < MAX_HEADER_PEEK; b++) {
      const block = s.decoder.getBlock(b);
      if (!block) break;
      parts.push(block);
      len += block.length;
    }
    if (len === 0) return null;
    const head = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      head.set(p, off);
      off += p.length;
    }
    return peekContainerInfo(head.subarray(0, Math.min(len, s.header.totalLength)));
  }

  get status(): ReceiverStatus | null {
    const s = this.session;
    if (!s) return null;
    return {
      transferId: s.header.transferId,
      totalLength: s.header.totalLength,
      blockSize: s.header.blockSize,
      K: s.decoder.K,
      rank: s.decoder.rank,
      received: s.decoder.received,
      duplicates: s.duplicates,
      startedAt: s.startedAt,
      lastProgressAt: s.lastProgressAt,
      completedAt: s.completedAt,
      info: s.info,
    };
  }

  get complete(): boolean {
    return this.session?.decoder.isComplete ?? false;
  }

  /** The reassembled container stream; only valid once `complete`. */
  stream(): Uint8Array {
    const s = this.session;
    if (!s || !s.decoder.isComplete) throw new Error('transfer is not complete');
    return s.decoder.getData(s.header.totalLength);
  }

  reset(): void {
    this.session = null;
    this.candidate = null;
    this.framesAccepted = 0;
  }
}
