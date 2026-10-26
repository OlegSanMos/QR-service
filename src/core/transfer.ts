// DOM-free sender/receiver state machines that glue the container, fountain
// code, frame protocol and QR encoder together. The UI layers only deal with
// pixels and timing.

import { peekContainerInfo, type ContainerInfo } from './container';
import { crc32 } from './crc32';
import { FountainDecoder, type AddResult } from './fountain/decoder';
import { FountainEncoder } from './fountain/encoder';
import { blockCount } from './fountain/layout';
import { mix32 } from './prng';
import { HEADER_SIZE, MAX_BLOCK_SIZE, buildFrame, parseFrame, type Frame } from './protocol';
import { QrEncoder, type QrMatrix } from './qr/encoder';
import { byteCapacity, type Ecc } from './qr/tables';

/** Fixed mask used for whitened frames (see protocol.ts). */
export const STREAM_MASK = 2;

export function blockSizeFor(version: number, ecc: Ecc): number {
  return Math.min(MAX_BLOCK_SIZE, byteCapacity(version, ecc) - HEADER_SIZE);
}

/**
 * Transfer id derived from the container stream and the block size. Sending the
 * same file with the same settings again (e.g. after the sender page was
 * reloaded) yields the same id, so a receiver keeps the progress it already has;
 * the frames are then byte-for-byte compatible. Different content gets a
 * different id except for a 2^-32 chance.
 */
export function transferIdFor(stream: Uint8Array, blockSize: number): number {
  return mix32(crc32(stream) ^ mix32((stream.length + Math.imul(blockSize, 0x9e3779b1)) | 0));
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

  /** `transferId` defaults to the content-derived `transferIdFor(stream, blockSize)`. */
  constructor(stream: Uint8Array, settings: EncoderSettings, transferId?: number) {
    const blockSize = blockSizeFor(settings.version, settings.ecc);
    if (blockSize < 8) throw new RangeError('QR version too small for the frame header');
    this.transferId = (transferId ?? transferIdFor(stream, blockSize)) >>> 0;
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
  /**
   * Raw frames (exactly as passed to `ingest`) that this call added to the
   * unfinished session as new symbols, duplicates excluded: the frame itself,
   * or the confirming pair when a session starts. Replaying every such frame
   * into a fresh receiver rebuilds the session's decoding progress.
   */
  added: Uint8Array[];
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
  /** Leading blocks known so far, and how many stream bytes the last header peek examined. */
  prefixBlocks: number;
  peekedBytes: number;
}

/** A transfer we have seen once; it is only allocated after a second consistent frame. */
interface Candidate {
  frame: Frame;
  bytes: Uint8Array;
  seenAt: number;
}

/**
 * How much of the stream start is examined for the archive header (file list):
 * tens of thousands of files with long paths. Past that the list is simply not
 * shown until the transfer completes.
 */
const MAX_HEADER_PEEK = 8 * 1024 * 1024;
/** A header that did not fit is parsed again only once this much more of it has arrived. */
const PEEK_GROWTH = 1.25;

/** After this long without frames from the current transfer, a new one may take over. */
const SWITCH_AFTER_MS = 2500;

export class TransferReceiver {
  private session: Session | null = null;
  private candidate: Candidate | null = null;

  /** Total QR codes that parsed as our protocol (including duplicates). */
  framesAccepted = 0;

  ingest(bytes: Uint8Array, now: number): IngestOutcome {
    const frame = parseFrame(bytes);
    if (!frame) return { kind: 'foreign', started: false, added: [] };
    this.framesAccepted++;
    const s = this.session;
    if (s && frame.transferId === s.header.transferId) {
      if (frame.totalLength !== s.header.totalLength || frame.blockSize !== s.header.blockSize) {
        return { kind: 'foreign', started: false, added: [] };
      }
      s.lastSeenAt = now;
      const wasComplete = s.completedAt !== null;
      const kind = this.feed(s, frame, now);
      return { kind, started: false, added: wasComplete || kind === 'duplicate' ? [] : [bytes] };
    }
    if (s && s.completedAt === null && now - s.lastSeenAt < SWITCH_AFTER_MS) {
      return { kind: 'foreign', started: false, added: [] };
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
        prefixBlocks: 0,
        peekedBytes: 0,
      };
      this.session = session;
      this.feed(session, c.frame, now);
      return { kind: this.feed(session, frame, now), started: true, added: [c.bytes, bytes] };
    }
    this.candidate = { frame, bytes, seenAt: now };
    return { kind: 'pending', started: false, added: [] };
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
    // The archive header lists every file, so it may span many blocks; only the
    // known prefix of the stream can be parsed.
    let n = s.prefixBlocks;
    while (n < s.decoder.K && s.decoder.hasBlock(n)) n++;
    s.prefixBlocks = n;
    const limit = Math.min(s.header.totalLength, MAX_HEADER_PEEK);
    const len = Math.min(n * s.header.blockSize, limit);
    // Parsing starts from scratch each time: with thousands of files, wait until
    // noticeably more of the header is there instead of re-parsing every frame.
    if (len <= s.peekedBytes || (len < s.peekedBytes * PEEK_GROWTH && len < limit)) return null;
    s.peekedBytes = len;
    const head = new Uint8Array(Math.ceil(len / s.header.blockSize) * s.header.blockSize);
    for (let b = 0; b * s.header.blockSize < len; b++) head.set(s.decoder.getBlock(b)!, b * s.header.blockSize);
    return peekContainerInfo(head.subarray(0, len));
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

  /**
   * Moves the session's start back by `ms`: the receiving time spent before the
   * session was rebuilt from stored frames, so elapsed time and average speed
   * carry over.
   */
  backdate(ms: number): void {
    if (this.session) this.session.startedAt -= ms;
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
