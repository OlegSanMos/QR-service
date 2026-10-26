import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL, captureProbability, worstPhaseCapture } from '../src/core/limits';
import { peekSymbolId } from '../src/core/protocol';
import { TransferEncoder } from '../src/core/transfer';

const cam60 = { ...DEFAULT_CHANNEL, cameraFps: 60, shutterMs: 10 };
const cam30 = { ...DEFAULT_CHANNEL, cameraFps: 30, shutterMs: 20 };

describe('worstPhaseCapture (camera locked to the screen refresh)', () => {
  it('30 changes/s on a 60 Hz screen loses every code at some phases of a 60 fps camera', () => {
    // On average 80 % of the codes are caught (random-phase model)…
    expect(captureProbability({ ...cam60, displayFps: 30 })).toBeCloseTo(0.8, 2);
    // …but the phase drifts slowly, so for a while NONE are: periodic stalls.
    expect(worstPhaseCapture({ ...cam60, displayFps: 30 })).toBe(0);
  });

  it('20 changes/s (3 camera frames per code) is safe at every phase', () => {
    expect(worstPhaseCapture({ ...cam60, displayFps: 20 })).toBe(1);
    expect(worstPhaseCapture({ ...cam60, displayFps: 15 })).toBe(1);
    expect(worstPhaseCapture({ ...cam30, displayFps: 15 })).toBe(1);
    expect(worstPhaseCapture({ ...cam30, displayFps: 12 })).toBe(1);
  });

  it('a code per refresh is never captured, and 24/s on 60 Hz is only partly safe', () => {
    expect(worstPhaseCapture({ ...cam60, displayFps: 60 })).toBe(0);
    const w24 = worstPhaseCapture({ ...cam60, displayFps: 24 });
    expect(w24).toBeGreaterThan(0.3); // the 3-refresh codes always get through
    expect(w24).toBeLessThan(1);
  });

  it('a faster panel shortens the redraw and can make 30/s safe', () => {
    expect(worstPhaseCapture({ ...cam60, refreshHz: 120, displayFps: 30 })).toBe(1);
  });
});

describe('sender rate seen by the receiver', () => {
  it('peekSymbolId reads the symbol id without parsing the payload', () => {
    const enc = new TransferEncoder(new Uint8Array(3000).fill(7), { version: 10, ecc: 'L' }, 5);
    expect(peekSymbolId(enc.frame(0))).toBe(0);
    expect(peekSymbolId(enc.frame(123456))).toBe(123456);
    expect(peekSymbolId(new TextEncoder().encode('https://example.com/some/long/link'))).toBeNull();
  });
});
