// Runs the fountain decoder off the main thread: finishing a generation is a
// Gaussian back-substitution that may take a few hundred ms on a phone.
//
// Every new frame is also persisted (core/resume-store.ts), so a transfer cut
// short by a reload or crash — iOS Safari reloads background tabs under memory
// pressure — is rebuilt on the next start and simply continues.

import { openIdbResumeStore } from '../core/resume-idb';
import { ResumeRecorder } from '../core/resume-store';
import { TransferReceiver, type IngestKind } from '../core/transfer';
import type { ReceiverRequest, ReceiverResponse } from './messages';

const receiver = new TransferReceiver();
/** Null while storage is being opened, or for good where it is unavailable. */
let recorder: ResumeRecorder | null = null;
let lastStatusAt = 0;
let completedSent = false;

function post(msg: ReceiverResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

// Requests are handled strictly in order; while an asynchronous step runs
// (opening storage, restoring a transfer) later ones wait in the queue.
const queue: ReceiverRequest[] = [];
let busy = true;

function pump(): void {
  while (!busy && queue.length > 0) {
    const step = handle(queue.shift()!);
    if (step) {
      busy = true;
      void step.finally(() => {
        busy = false;
        pump();
      });
    }
  }
}

self.onmessage = (e: MessageEvent<ReceiverRequest>) => {
  queue.push(e.data);
  pump();
};

void openIdbResumeStore()
  .then((store) => {
    if (store) recorder = new ResumeRecorder(store, { onError: (err) => console.warn('Resume storage is off:', err) });
  })
  .catch(() => {})
  .finally(() => {
    busy = false;
    pump();
  });

function handle(msg: ReceiverRequest): Promise<void> | void {
  switch (msg.type) {
    case 'codes':
      return ingest(msg.codes, msg.now);
    case 'restore':
      return restore(msg.now);
    case 'reset': {
      const s = receiver.status;
      // A delivered transfer has nothing left to resume; an unfinished one stays stored.
      if (s && receiver.complete) void recorder?.forget(s.transferId);
      return clearSession();
    }
    case 'discard':
      void recorder?.forget(msg.transferId);
      if (receiver.status?.transferId === msg.transferId) clearSession();
      return;
    case 'delivered':
      void recorder?.forget(msg.transferId);
      return;
    case 'flush':
      void recorder?.flush();
      return;
    case 'close':
      return (recorder?.flush() ?? Promise.resolve()).catch(() => {}).finally(() => self.close());
  }
}

function clearSession(): void {
  receiver.reset();
  completedSent = false;
  post({ type: 'status', status: null, framesAccepted: 0, lastKind: null, started: false });
}

async function restore(now: number): Promise<void> {
  if (!recorder || receiver.status) return;
  const stored = await recorder.restoreLatest(receiver, now);
  if (!stored) return;
  if (receiver.complete) postComplete(); // everything had arrived; only the cleanup was missed
  else post({ type: 'restored', status: receiver.status!, framesAccepted: receiver.framesAccepted });
}

function postComplete(): void {
  completedSent = true;
  const status = receiver.status!;
  const stream = receiver.stream();
  // The stored frames stay until the page reports the files unpacked ('delivered'):
  // unpacking is the memory peak, and a tab killed there must find the data again.
  post({ type: 'complete', status, stream }, [stream.buffer]);
}

function ingest(codes: Uint8Array[], now: number): void {
  let lastKind: IngestKind | null = null;
  let started = false;
  for (const code of codes) {
    const outcome = receiver.ingest(code, now);
    lastKind = outcome.kind;
    if (outcome.started) {
      started = true;
      completedSent = false;
    }
    if (recorder && outcome.added.length > 0) {
      const s = receiver.status!;
      recorder.record(s, outcome.added, now - s.startedAt);
    }
  }
  if (receiver.complete && !completedSent) {
    postComplete();
    return;
  }
  // Throttle status updates; always report the start of a new transfer.
  const t = performance.now();
  if (started || t - lastStatusAt > 100) {
    lastStatusAt = t;
    post({ type: 'status', status: receiver.status, framesAccepted: receiver.framesAccepted, lastKind, started });
  }
}
