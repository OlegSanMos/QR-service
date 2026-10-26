import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prng } from '../src/core/prng';
import { openIdbResumeStore } from '../src/core/resume-idb';
import {
  MemoryResumeStore,
  ResumeRecorder,
  saveSendPosition,
  sendStartId,
  type KeyValueStorage,
  type ResumeStore,
  type TransferKey,
} from '../src/core/resume-store';
import { TransferEncoder, TransferReceiver, blockSizeFor, transferIdFor } from '../src/core/transfer';

function randomBytes(n: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  return new Uint8Array(n).map(() => rng.nextU32() & 0xff);
}

/** A transfer of ~30 blocks (v5-L: 91 bytes per frame). */
function makeEncoder(seed = 1, size = 2700): { stream: Uint8Array; enc: TransferEncoder } {
  const stream = randomBytes(size, seed);
  return { stream, enc: new TransferEncoder(stream, { version: 5, ecc: 'L' }) };
}

/** Feeds frames into a receiver and records what it adds, the way the receiver worker does. */
function receive(rx: TransferReceiver, recorder: ResumeRecorder, frames: Uint8Array[], now: number): void {
  for (const f of frames) {
    const { added } = rx.ingest(f, now);
    if (added.length) recorder.record(rx.status!, added, now - rx.status!.startedAt);
  }
}

function key(id: number): TransferKey {
  return { transferId: id, totalLength: 1000, blockSize: 91 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deterministic transfer id', () => {
  it('depends only on the stream and the block size', () => {
    const a = randomBytes(5000, 1);
    expect(transferIdFor(a, 100)).toBe(transferIdFor(a.slice(), 100));
    expect(transferIdFor(a, 100)).not.toBe(transferIdFor(a, 101));
    const b = a.slice();
    b[4321] ^= 1;
    expect(transferIdFor(a, 100)).not.toBe(transferIdFor(b, 100));
    expect(transferIdFor(a, 100)).not.toBe(transferIdFor(a.subarray(0, 4999), 100));
  });

  it('is what the encoder uses by default, so a restarted sender sends identical frames', () => {
    const stream = randomBytes(3000, 2);
    const first = new TransferEncoder(stream, { version: 10, ecc: 'M' });
    const again = new TransferEncoder(stream.slice(), { version: 10, ecc: 'M' });
    expect(first.transferId).toBe(transferIdFor(stream, blockSizeFor(10, 'M')));
    expect(again.transferId).toBe(first.transferId);
    expect(Array.from(again.frame(7))).toEqual(Array.from(first.frame(7)));
    expect(new TransferEncoder(stream, { version: 11, ecc: 'M' }).transferId).not.toBe(first.transferId);
    expect(new TransferEncoder(stream, { version: 10, ecc: 'M' }, 42).transferId).toBe(42);
  });

  it('practically never collides for different content', () => {
    const ids = new Set<number>();
    for (let i = 0; i < 5000; i++) ids.add(transferIdFor(randomBytes(64, i + 1), 200));
    expect(ids.size).toBe(5000);
  });
});

describe('TransferReceiver.added', () => {
  it('reports the confirming pair, then each new frame; never duplicates or frames after completion', () => {
    const { enc } = makeEncoder();
    const rx = new TransferReceiver();
    const f0 = enc.frame(0);
    const f1 = enc.frame(1);
    expect(rx.ingest(f0, 0).added).toEqual([]);
    const start = rx.ingest(f1, 1);
    expect(start.started).toBe(true);
    expect(start.added).toEqual([f0, f1]);
    expect(rx.ingest(enc.frame(1), 2).added).toEqual([]); // duplicate
    const f2 = enc.frame(2);
    expect(rx.ingest(f2, 3).added).toEqual([f2]);
    let id = 3;
    while (!rx.complete) rx.ingest(enc.frame(id++), 4);
    expect(rx.ingest(enc.frame(id++), 5)).toMatchObject({ kind: 'complete', added: [] });
    expect(rx.ingest(new TextEncoder().encode('hello'), 6).added).toEqual([]);
  });

  it('backdate() moves the session start back', () => {
    const { enc } = makeEncoder();
    const rx = new TransferReceiver();
    rx.ingest(enc.frame(0), 1000);
    rx.ingest(enc.frame(1), 1010);
    rx.backdate(600);
    expect(rx.status!.startedAt).toBe(400);
  });
});

describe('MemoryResumeStore', () => {
  it('appends batches, keeps metadata, reads frames back in order and deletes', async () => {
    const store = new MemoryResumeStore();
    const a = [new Uint8Array([1, 2]), new Uint8Array([3])];
    await store.append(key(7), a, 500, 1000);
    await store.append(key(7), [new Uint8Array([4])], 300, 2000);
    await store.append(key(8), [new Uint8Array([9])], 100, 1500);
    a[0][0] = 99; // the store keeps its own copy
    expect(await store.list()).toEqual([
      { ...key(7), frames: 3, createdAt: 1000, updatedAt: 2000, elapsedMs: 500 },
      { ...key(8), frames: 1, createdAt: 1500, updatedAt: 1500, elapsedMs: 100 },
    ]);
    const read: number[][] = [];
    await store.read(7, (frames) => read.push(...frames.map((f) => Array.from(f))));
    expect(read).toEqual([[1, 2], [3], [4]]);
    await store.delete(7);
    expect((await store.list()).map((t) => t.transferId)).toEqual([8]);
    await store.delete(12345); // unknown ids are fine
  });

  it('starts over when the same id comes with another frame format', async () => {
    const store = new MemoryResumeStore();
    await store.append(key(7), [new Uint8Array([1])], 0, 1);
    await store.append({ ...key(7), blockSize: 50 }, [new Uint8Array([2])], 0, 2);
    expect((await store.list())[0]).toMatchObject({ blockSize: 50, frames: 1, createdAt: 2 });
  });
});

describe('ResumeRecorder', () => {
  it('writes frames in batches, not per frame', async () => {
    vi.useFakeTimers();
    const store = new MemoryResumeStore();
    const append = vi.spyOn(store, 'append');
    const recorder = new ResumeRecorder(store, { flushIntervalMs: 400 });
    const { enc } = makeEncoder();
    const rx = new TransferReceiver();
    for (let id = 0; id < 10; id++) {
      receive(rx, recorder, [enc.frame(id)], id * 30);
      await vi.advanceTimersByTimeAsync(30);
    }
    // The first new frames were recorded at t = 30 ms, so the batch is due at 430 ms.
    await vi.advanceTimersByTimeAsync(129);
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await recorder.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1]).toHaveLength(10);
    expect((await store.list())[0]).toMatchObject({ transferId: enc.transferId, frames: 10, elapsedMs: 270 });
  });

  it('rebuilds an interrupted transfer from the stored frames, which then completes', async () => {
    const store = new MemoryResumeStore();
    const { stream, enc } = makeEncoder(3);
    // First run: 40 % frame loss, interrupted halfway through.
    const before = new TransferReceiver();
    const first = new ResumeRecorder(store, { clock: () => 1 });
    const rng = new Prng(9);
    let id = 0;
    while (before.status === null || before.status.rank < enc.K / 2) {
      const f = enc.frame(id++);
      if (rng.nextFloat() >= 0.4) receive(before, first, [f, f], 5000 + id * 50); // duplicates are not stored
    }
    await first.flush();
    const was = before.status!;

    // After the "reload": a new recorder and receiver on the same store.
    const after = new TransferReceiver();
    const second = new ResumeRecorder(store);
    const stored = await second.restoreLatest(after, 100);
    expect(stored).toMatchObject({ transferId: enc.transferId, frames: was.received, elapsedMs: 5000 + id * 50 - was.startedAt });
    const now = after.status!;
    expect(now).toMatchObject({ transferId: was.transferId, K: was.K, rank: was.rank, received: was.received, info: was.info });
    expect(now.startedAt).toBe(100 - stored!.elapsedMs);
    expect(after.complete).toBe(false);

    // The sender continues with later symbols and the receiver completes.
    while (!after.complete) receive(after, second, [enc.frame(id++)], 200);
    expect(Array.from(after.stream())).toEqual(Array.from(stream));
    await second.forget(enc.transferId);
    expect(await store.list()).toEqual([]);
  });

  it('keeps only the most recent unfinished transfers', async () => {
    const store = new MemoryResumeStore();
    let clock = 0;
    const recorder = new ResumeRecorder(store, { maxTransfers: 2, clock: () => ++clock });
    const ids: number[] = [];
    for (let seed = 1; seed <= 3; seed++) {
      const { enc } = makeEncoder(seed);
      ids.push(enc.transferId);
      receive(new TransferReceiver(), recorder, [enc.frame(0), enc.frame(1), enc.frame(2)], 0);
      await recorder.flush();
    }
    expect((await store.list()).map((t) => t.transferId)).toEqual([ids[2], ids[1]]);
    // Restoring also prunes, and picks the most recently updated transfer.
    await store.append({ transferId: 5, totalLength: 10, blockSize: 5 }, [], 0, 0);
    const rx = new TransferReceiver();
    expect(await new ResumeRecorder(store).restoreLatest(rx, 0)).toMatchObject({ transferId: ids[2] });
    expect((await store.list()).map((t) => t.transferId)).toEqual([ids[2], ids[1]]);
  });

  it('restores nothing from an empty store and drops unusable records', async () => {
    const store = new MemoryResumeStore();
    const rx = new TransferReceiver();
    expect(await new ResumeRecorder(store).restoreLatest(rx, 0)).toBeNull();
    await store.append(key(77), [new TextEncoder().encode('not a frame'), new Uint8Array(106)], 0, 1);
    expect(await new ResumeRecorder(store).restoreLatest(rx, 0)).toBeNull();
    expect(rx.status).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('switches persistence off after a storage error without disturbing reception', async () => {
    const broken: ResumeStore = {
      list: () => Promise.reject(new Error('gone')),
      append: () => Promise.reject(new DOMException('full', 'QuotaExceededError')),
      read: () => Promise.reject(new Error('gone')),
      delete: () => Promise.resolve(),
    };
    const errors: unknown[] = [];
    const recorder = new ResumeRecorder(broken, { onError: (e) => errors.push(e) });
    const { enc } = makeEncoder();
    const rx = new TransferReceiver();
    receive(rx, recorder, [enc.frame(0), enc.frame(1)], 0);
    await recorder.flush();
    expect(recorder.enabled).toBe(false);
    expect(errors).toHaveLength(1);
    receive(rx, recorder, [enc.frame(2)], 10); // ignored, no throw
    await recorder.flush();
    await recorder.forget(enc.transferId);
    expect(rx.status!.rank).toBe(3);
    expect(errors).toHaveLength(1);

    const fresh = new TransferReceiver();
    expect(await new ResumeRecorder(broken).restoreLatest(fresh, 0)).toBeNull();
    expect(fresh.status).toBeNull();
  });

  it('a failing read leaves no half-restored session behind', async () => {
    const store = new MemoryResumeStore();
    const { enc } = makeEncoder();
    await store.append(enc, [enc.frame(0), enc.frame(1), enc.frame(2)], 0, 1);
    const flaky: ResumeStore = {
      list: () => store.list(),
      append: (...args) => store.append(...args),
      delete: (id) => store.delete(id),
      read: async (id, onFrames) => {
        await store.read(id, onFrames); // replays everything, then fails
        throw new Error('connection lost');
      },
    };
    const rx = new TransferReceiver();
    expect(await new ResumeRecorder(flaky).restoreLatest(rx, 0)).toBeNull();
    expect(rx.status).toBeNull();
  });

  it('IndexedDB backend reports itself unavailable where there is no IndexedDB', async () => {
    expect(await openIdbResumeStore()).toBeNull();
  });
});

describe('sender resume position', () => {
  function fakeStorage(): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it('continues right after the last symbol shown, per transfer', () => {
    const storage = fakeStorage();
    expect(sendStartId(storage, 0xabc)).toBe(0);
    saveSendPosition(storage, 0xabc, 41);
    saveSendPosition(storage, 0xdef, 1000);
    saveSendPosition(storage, 0xabc, 57);
    expect(sendStartId(storage, 0xabc)).toBe(58);
    expect(sendStartId(storage, 0xdef)).toBe(1001);
    expect(sendStartId(storage, 0x123)).toBe(0);
  });

  it('remembers a bounded number of transfers, most recent first', () => {
    const storage = fakeStorage();
    for (let id = 1; id <= 40; id++) saveSendPosition(storage, id, id * 10);
    expect(sendStartId(storage, 40)).toBe(401);
    expect(sendStartId(storage, 25)).toBe(251);
    expect(sendStartId(storage, 24)).toBe(0);
  });

  it('survives broken or missing storage', () => {
    const storage = fakeStorage();
    storage.data.set('qr-air.send-positions', '{oops');
    expect(sendStartId(storage, 1)).toBe(0);
    saveSendPosition(storage, 1, 5);
    expect(sendStartId(storage, 1)).toBe(6);
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(sendStartId(throwing, 1)).toBe(0);
    expect(() => saveSendPosition(throwing, 1, 5)).not.toThrow();
    expect(sendStartId(null, 1)).toBe(0);
  });
});
