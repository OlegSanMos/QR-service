// IndexedDB backend of the receiver's ResumeStore (see resume-store.ts).
//
//   transfers  key transferId         → StoredTransfer
//   frames     key [transferId, seq]  → one batch of frames; seq = number of frames
//                                       of the transfer stored before it
//
// A batch is packed into one buffer plus a list of frame lengths: far cheaper to
// write and to clone than a list of small arrays.

import { appendedMeta, sameTransfer, type ResumeStore, type StoredTransfer, type TransferKey } from './resume-store';

const DB_NAME = 'qr-air-resume';
const DB_VERSION = 1;
const TRANSFERS = 'transfers';
const FRAMES = 'frames';
/** Batches per read transaction: bounds memory while replaying a large transfer. */
const READ_PAGE = 64;
const OPEN_TIMEOUT_MS = 3000;

interface FrameBatch {
  transferId: number;
  seq: number;
  lengths: Uint32Array;
  data: Uint8Array;
}

function framesOf(transferId: number, fromSeq = 0): IDBKeyRange {
  return IDBKeyRange.bound([transferId, fromSeq], [transferId, Infinity]);
}

function pack(transferId: number, seq: number, frames: Uint8Array[]): FrameBatch {
  const lengths = new Uint32Array(frames.length);
  let total = 0;
  frames.forEach((f, i) => {
    lengths[i] = f.length;
    total += f.length;
  });
  const data = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    data.set(f, off);
    off += f.length;
  }
  return { transferId, seq, lengths, data };
}

function unpack(batch: FrameBatch): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let off = 0;
  for (const n of batch.lengths) {
    frames.push(batch.data.subarray(off, off + n));
    off += n;
  }
  return frames;
}

/** Resolves when the transaction commits, rejects when it fails or aborts. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

/** Opens the database; null where IndexedDB is missing, refuses or never answers. */
function openDatabase(timeoutMs: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null): void => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    // Some Safari versions leave the first open request unanswered.
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TRANSFERS)) db.createObjectStore(TRANSFERS, { keyPath: 'transferId' });
        if (!db.objectStoreNames.contains(FRAMES)) db.createObjectStore(FRAMES, { keyPath: ['transferId', 'seq'] });
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
    } catch {
      finish(null); // e.g. SecurityError where storage is disabled
    }
  });
}

class IdbResumeStore implements ResumeStore {
  private db: IDBDatabase | null = null;

  constructor(db: IDBDatabase) {
    this.adopt(db);
  }

  async list(): Promise<StoredTransfer[]> {
    let rows: StoredTransfer[] = [];
    await this.transact([TRANSFERS], 'readonly', (tx) => {
      const req = tx.objectStore(TRANSFERS).getAll();
      req.onsuccess = () => (rows = req.result as StoredTransfer[]);
    });
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  append(key: TransferKey, frames: Uint8Array[], elapsedMs: number, now: number): Promise<void> {
    const batch = pack(key.transferId, 0, frames);
    return this.transact([TRANSFERS, FRAMES], 'readwrite', (tx) => {
      const transfers = tx.objectStore(TRANSFERS);
      const batches = tx.objectStore(FRAMES);
      const get = transfers.get(key.transferId);
      get.onsuccess = () => {
        let old = get.result as StoredTransfer | undefined;
        if (old && !sameTransfer(old, key)) {
          batches.delete(framesOf(key.transferId)); // another transfer under the same id: start over
          old = undefined;
        }
        batches.put({ ...batch, seq: old?.frames ?? 0 });
        transfers.put(appendedMeta(old, key, frames.length, elapsedMs, now));
      };
    });
  }

  async read(transferId: number, onFrames: (frames: Uint8Array[]) => void): Promise<void> {
    let from = 0;
    for (;;) {
      let rows: FrameBatch[] = [];
      await this.transact([FRAMES], 'readonly', (tx) => {
        const req = tx.objectStore(FRAMES).getAll(framesOf(transferId, from), READ_PAGE);
        req.onsuccess = () => (rows = req.result as FrameBatch[]);
      });
      for (const row of rows) onFrames(unpack(row));
      if (rows.length < READ_PAGE) return;
      from = rows[rows.length - 1].seq + 1;
    }
  }

  delete(transferId: number): Promise<void> {
    return this.transact([TRANSFERS, FRAMES], 'readwrite', (tx) => {
      tx.objectStore(TRANSFERS).delete(transferId);
      tx.objectStore(FRAMES).delete(framesOf(transferId));
    });
  }

  private adopt(db: IDBDatabase): void {
    this.db = db;
    const drop = (): void => {
      if (this.db === db) this.db = null;
    };
    db.onclose = drop;
    db.onversionchange = () => {
      db.close();
      drop();
    };
  }

  private async connection(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const db = await openDatabase(OPEN_TIMEOUT_MS);
    if (!db) throw new Error('IndexedDB is unavailable');
    this.adopt(db);
    return db;
  }

  /**
   * Runs one transaction. Safari drops the connection after the app has spent a
   * while in the background, so on failure the database is reopened and the
   * transaction retried once (a full disk is not worth a retry).
   */
  private async transact(names: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let db: IDBDatabase | null = null;
      try {
        db = await this.connection();
        const tx = db.transaction(names, mode);
        const done = committed(tx);
        done.catch(() => {}); // observed below; avoids an unhandled rejection if `body` throws
        body(tx);
        await done;
        return;
      } catch (err) {
        if (attempt > 0 || (err instanceof DOMException && err.name === 'QuotaExceededError')) throw err;
        if (db && this.db === db) {
          this.db = null;
          db.close();
        }
      }
    }
  }
}

/** The IndexedDB-backed store, or null where IndexedDB cannot be used (some private modes, disabled storage). */
export async function openIdbResumeStore(timeoutMs = OPEN_TIMEOUT_MS): Promise<ResumeStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDatabase(timeoutMs);
  return db ? new IdbResumeStore(db) : null;
}
