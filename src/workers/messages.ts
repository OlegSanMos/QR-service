import type { Ecc } from '../core/qr/tables';
import type { IngestKind, ReceiverStatus } from '../core/transfer';

// ---- sender: main ⇄ encode worker -------------------------------------------

export type EncodeRequest =
  | { type: 'init'; epoch: number; stream: Uint8Array; version: number; ecc: Ecc; transferId: number }
  | { type: 'frames'; epoch: number; firstId: number; count: number };

export interface RenderedFrame {
  symbolId: number;
  /** RGBA pixels, one pixel per module, including the quiet zone. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
}

export type EncodeResponse =
  | { type: 'ready'; epoch: number; K: number; G: number; blockSize: number; size: number }
  | { type: 'frames'; epoch: number; frames: RenderedFrame[]; ms: number }
  | { type: 'error'; epoch: number; message: string };

// ---- receiver: main ⇄ decode workers ------------------------------------------

export interface DecodeRequest {
  type: 'decode';
  id: number;
  image: ImageData;
  maxSymbols: number;
}

export interface DetectedQuad {
  valid: boolean;
  /** x0,y0,x1,y1,x2,y2,x3,y3 in image coordinates. */
  points: number[];
  /** QR version (1-40), 0 if unknown. */
  version: number;
}

export type DecodeResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; codes: Uint8Array[]; quads: DetectedQuad[]; ms: number }
  | { type: 'error'; id: number; message: string };

// ---- receiver: main ⇄ fountain (receiver) worker -------------------------------

export type ReceiverRequest = { type: 'codes'; codes: Uint8Array[]; now: number } | { type: 'reset' };

export type ReceiverResponse =
  | { type: 'status'; status: ReceiverStatus | null; framesAccepted: number; lastKind: IngestKind | null; started: boolean }
  | { type: 'complete'; status: ReceiverStatus; stream: Uint8Array };

// ---- both sides: main ⇄ codec worker (packing / unpacking archives) ------------

export type CodecRequest =
  | {
      type: 'pack';
      id: number;
      files: { name: string; mime: string; data: Uint8Array }[];
      method: 'auto' | 'store' | 'deflate' | 'cm';
      linkBytesPerSecond: number;
    }
  | { type: 'unpack'; id: number; stream: Uint8Array };

export type CodecResponse =
  | { type: 'progress'; id: number; phase: 'store' | 'deflate' | 'cm'; done: number; total: number }
  | {
      type: 'packed';
      id: number;
      stream: Uint8Array;
      method: 'store' | 'deflate' | 'cm';
      totalSize: number;
      candidates: { method: string; size: number; ms: number; cost: number; aborted?: boolean }[];
    }
  | { type: 'unpacked'; id: number; files: { name: string; mime: string; data: Uint8Array }[]; method: 'store' | 'deflate' | 'cm' }
  | { type: 'error'; id: number; message: string };
