// Resumable transfers.
//
// Receiver: every new frame of a transfer is appended to a ResumeStore (IndexedDB
// in the app, see resume-idb.ts; in memory in tests), a batch every
// FLUSH_INTERVAL_MS rather than a transaction per frame. After a reload or crash
// the most recent unfinished transfer is rebuilt by replaying its frames into a
// fresh TransferReceiver: decoding does not depend on timing, so the replay
// restores exactly the progress that was stored.
//
// Sender: the last symbol id shown for each transfer is kept in localStorage, so
// restarting the same transfer continues where it stopped instead of repeating
// symbols the receiver already has.

import type { TransferReceiver } from './transfer';

/** Identifies a transfer and the format of its frames. */
export interface TransferKey {
  transferId: number;
  totalLength: number;
  blockSize: number;
}

export interface StoredTransfer extends TransferKey {
  /** Number of frames stored. */
  frames: number;
  /** Wall-clock times (Date.now()) of the first and the latest write. */
  createdAt: number;
  updatedAt: number;
  /** Receiving time the stored frames took, so elapsed time and speed survive a restore. */
  elapsedMs: number;
}

/** Frame log of unfinished transfers. Any method may reject (quota, private mode, lost connection). */
export interface ResumeStore {
  /** Stored transfers, most recently updated first. */
  list(): Promise<StoredTransfer[]>;
  /** Appends raw frames to a transfer, creating it if needed, atomically with its metadata. */
  append(key: TransferKey, frames: Uint8Array[], elapsedMs: number, now: number): Promise<void>;
  /** Passes the stored frames to `onFrames` in the order they were appended, a batch at a time. */
  read(transferId: number, onFrames: (frames: Uint8Array[]) => void): Promise<void>;
  /** Removes a transfer and all of its frames; a no-op for unknown ids. */
  delete(transferId: number): Promise<void>;
}

/** True when `stored` holds frames of the same transfer as `key` (not just the same id). */
export function sameTransfer(stored: StoredTransfer, key: TransferKey): boolean {
  return stored.totalLength === key.totalLength && stored.blockSize === key.blockSize;
}

/** Metadata after appending `count` frames to `old` (undefined for a new transfer). */
export function appendedMeta(old: StoredTransfer | undefined, key: TransferKey, count: number, elapsedMs: number, now: number): StoredTransfer {
  return {
    transferId: key.transferId,
    totalLength: key.totalLength,
    blockSize: key.blockSize,
    frames: (old?.frames ?? 0) + count,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    elapsedMs: Math.max(old?.elapsedMs ?? 0, elapsedMs),
  };
}

function newestFirst(a: StoredTransfer, b: StoredTransfer): number {
  return b.updatedAt - a.updatedAt;
}

/** In-memory ResumeStore for tests (and the reference behaviour for other backends). */
export class MemoryResumeStore implements ResumeStore {
  private readonly transfers = new Map<number, { meta: StoredTransfer; batches: Uint8Array[][] }>();

  async list(): Promise<StoredTransfer[]> {
    return [...this.transfers.values()].map((t) => ({ ...t.meta })).sort(newestFirst);
  }

  async append(key: TransferKey, frames: Uint8Array[], elapsedMs: number, now: number): Promise<void> {
    let entry = this.transfers.get(key.transferId);
    if (entry && !sameTransfer(entry.meta, key)) entry = undefined;
    const batches = entry?.batches ?? [];
    batches.push(frames.map((f) => f.slice()));
    this.transfers.set(key.transferId, { meta: appendedMeta(entry?.meta, key, frames.length, elapsedMs, now), batches });
  }

  async read(transferId: number, onFrames: (frames: Uint8Array[]) => void): Promise<void> {
    for (const batch of this.transfers.get(transferId)?.batches ?? []) onFrames(batch.map((f) => f.slice()));
  }

  async delete(transferId: number): Promise<void> {
    this.transfers.delete(transferId);
  }
}

// ---- receiver: batching, cleanup, restore -------------------------------------

/** Pending frames are written at most this long after they arrived. */
export const FLUSH_INTERVAL_MS = 400;
/** Unfinished transfers kept for resuming; older ones are deleted. */
export const MAX_STORED_TRANSFERS = 2;

export interface RecorderOptions {
  flushIntervalMs?: number;
  maxTransfers?: number;
  /** Wall clock for StoredTransfer timestamps. */
  clock?: () => number;
  /** Called once, on the first storage error (after which persistence is off). */
  onError?: (err: unknown) => void;
}

interface PendingBatch {
  key: TransferKey;
  frames: Uint8Array[];
  elapsedMs: number;
}

/**
 * Persists what a TransferReceiver collects: batches the new frames into the
 * store, drops finished transfers, keeps only the most recent unfinished ones
 * and rebuilds the latest after a restart. Storage errors never reach the
 * caller: after the first one persistence switches off and reception simply
 * goes on without resume.
 */
export class ResumeRecorder {
  private readonly flushIntervalMs: number;
  private readonly maxTransfers: number;
  private readonly clock: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly pending = new Map<number, PendingBatch>();
  /** Transfers written since start; the first write of a new one prunes old ones. */
  private readonly written = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Store operations run one at a time, in call order. */
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly store: ResumeStore,
    options: RecorderOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.maxTransfers = options.maxTransfers ?? MAX_STORED_TRANSFERS;
    this.clock = options.clock ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /** False once a storage error switched persistence off. */
  get enabled(): boolean {
    return !this.failed;
  }

  /** Queues frames a receiver added to transfer `key`; written within the flush interval. */
  record(key: TransferKey, frames: Uint8Array[], elapsedMs: number): void {
    if (this.failed || frames.length === 0) return;
    let batch = this.pending.get(key.transferId);
    if (!batch) {
      batch = { key: { transferId: key.transferId, totalLength: key.totalLength, blockSize: key.blockSize }, frames: [], elapsedMs };
      this.pending.set(key.transferId, batch);
    }
    batch.frames.push(...frames);
    batch.elapsedMs = elapsedMs;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  /** Writes the pending frames now; resolves once they are stored (or dropped after an error). */
  flush(): Promise<void> {
    this.cancelTimer();
    for (const batch of this.pending.values()) {
      void this.run(async () => {
        await this.store.append(batch.key, batch.frames, batch.elapsedMs, this.clock());
        if (!this.written.has(batch.key.transferId)) {
          this.written.add(batch.key.transferId);
          await this.prune();
        }
      }, undefined);
    }
    this.pending.clear();
    return this.run(async () => {}, undefined, true);
  }

  /** Forgets a transfer that was completed or discarded: pending frames and everything stored. */
  forget(transferId: number): Promise<void> {
    this.pending.delete(transferId);
    this.written.delete(transferId);
    // Deleting is still worth trying after an error: it may free the space that ran out.
    return this.run(() => this.store.delete(transferId), undefined, true);
  }

  /**
   * Replays the most recently updated stored transfer into `receiver`, which
   * must be idle, and returns its metadata; null when there is nothing (usable)
   * to resume. Also deletes transfers beyond the most recent `maxTransfers`.
   */
  async restoreLatest(receiver: TransferReceiver, now: number): Promise<StoredTransfer | null> {
    const restored = await this.run(async () => {
      const stored = await this.store.list();
      await this.prune(stored);
      const latest = stored[0];
      if (!latest) return null;
      await this.store.read(latest.transferId, (frames) => {
        for (const bytes of frames) receiver.ingest(bytes, now);
      });
      if (receiver.status?.transferId !== latest.transferId) {
        await this.store.delete(latest.transferId); // nothing usable in it
        return null;
      }
      receiver.backdate(latest.elapsedMs);
      this.written.add(latest.transferId);
      return latest;
    }, null);
    // A failed or useless replay must not leave a half-built session behind.
    if (!restored) receiver.reset();
    return restored;
  }

  private async prune(stored?: StoredTransfer[]): Promise<void> {
    const all = stored ?? (await this.store.list());
    for (const old of all.slice(this.maxTransfers)) await this.store.delete(old.transferId);
  }

  /** Queues a store operation; a failure switches persistence off instead of propagating. */
  private run<T>(job: () => Promise<T>, fallback: T, evenIfFailed = false): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.failed && !evenIfFailed) return fallback;
      try {
        return await job();
      } catch (err) {
        this.fail(err);
        return fallback;
      }
    });
    this.queue = result;
    return result;
  }

  private fail(err: unknown): void {
    if (!this.failed) this.onError(err);
    this.failed = true;
    this.pending.clear();
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---- sender: where to continue a restarted transfer ----------------------------

const SEND_POSITIONS_KEY = 'qr-air.send-positions';
/** Transfers whose position is remembered; the oldest are forgotten. */
const SEND_POSITIONS_MAX = 16;

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** [transferId, last symbol id shown], most recent first. */
function readPositions(storage: KeyValueStorage): [number, number][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(SEND_POSITIONS_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is [number, number] => Array.isArray(e) && e.length === 2 && Number.isInteger(e[0]) && Number.isInteger(e[1]) && e[1] >= 0,
  );
}

/**
 * Symbol id to start `transferId` from: right after the last one shown, so a
 * restart finishes the systematic pass (ids below K) or carries on with repair
 * symbols, which help every receiver. 0 for a transfer never shown.
 */
export function sendStartId(storage: KeyValueStorage | null, transferId: number): number {
  try {
    const entry = storage ? readPositions(storage).find(([id]) => id === transferId) : undefined;
    return entry ? entry[1] + 1 : 0;
  } catch {
    return 0;
  }
}

/** Remembers the last symbol id shown for `transferId`. */
export function saveSendPosition(storage: KeyValueStorage | null, transferId: number, lastShownId: number): void {
  if (!storage) return;
  try {
    const others = readPositions(storage).filter(([id]) => id !== transferId);
    storage.setItem(SEND_POSITIONS_KEY, JSON.stringify([[transferId, lastShownId], ...others].slice(0, SEND_POSITIONS_MAX)));
  } catch {
    // storage unavailable or full: a restart simply begins at symbol 0
  }
}
