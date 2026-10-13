// Runs the fountain decoder off the main thread: finishing a generation is a
// Gaussian back-substitution that may take a few hundred ms on a phone.

import { TransferReceiver, type IngestKind } from '../core/transfer';
import type { ReceiverRequest, ReceiverResponse } from './messages';

const receiver = new TransferReceiver();
let lastStatusAt = 0;
let completedSent = false;

function post(msg: ReceiverResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = (e: MessageEvent<ReceiverRequest>) => {
  const msg = e.data;
  if (msg.type === 'reset') {
    receiver.reset();
    completedSent = false;
    post({ type: 'status', status: null, framesAccepted: 0, lastKind: null, started: false });
    return;
  }
  let lastKind: IngestKind | null = null;
  let started = false;
  for (const code of msg.codes) {
    const outcome = receiver.ingest(code, msg.now);
    lastKind = outcome.kind;
    if (outcome.started) {
      started = true;
      completedSent = false;
    }
  }
  if (receiver.complete && !completedSent) {
    completedSent = true;
    const stream = receiver.stream();
    post({ type: 'complete', status: receiver.status!, stream }, [stream.buffer]);
    return;
  }
  // Throttle status updates; always report the start of a new transfer.
  const now = performance.now();
  if (started || now - lastStatusAt > 100) {
    lastStatusAt = now;
    post({ type: 'status', status: receiver.status, framesAccepted: receiver.framesAccepted, lastKind, started });
  }
};
