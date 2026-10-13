// Analytical model of the screen → camera channel (see docs/THEORY.md).
//
// A code shown for T_d = 1/f_d seconds is fully on screen only after the display
// has scanned it out (t_s) and until the next code starts scanning in. A camera
// frame gives a clean image only if its whole exposure + rolling-shutter readout
// window (τ) fits inside that interval. Camera frames start every T_c = 1/f_c with
// a random phase relative to the display, so the probability that a given code is
// captured cleanly at least once is
//
//   P = clamp((T_d − t_s − τ) / T_c, 0, 1)
//
// and the rate of distinct codes received is N = f_d · P. N grows with f_d while
// P = 1 and falls afterwards, so the optimum is at T_d = T_c + t_s + τ:
//
//   N_max = 1 / (T_c + t_s + τ)

import { HEADER_SIZE } from './protocol';
import { byteCapacity, type Ecc } from './qr/tables';
import { blockSizeFor } from './transfer';

export interface ChannelParams {
  /** QR codes changed per second on the sender. */
  displayFps: number;
  /** Panel refresh rate (Hz). */
  refreshHz: number;
  /** Fraction of the refresh period during which the code area is being re-drawn (0..1). */
  scanFraction: number;
  /** Camera frames per second. */
  cameraFps: number;
  /** Exposure + rolling-shutter readout over the code area, ms. */
  shutterMs: number;
  /** Camera frames per second the receiver can actually run through the decoder (∞ = all). */
  decodeFps: number;
}

export const DEFAULT_CHANNEL: ChannelParams = {
  displayFps: 15,
  refreshHz: 60,
  scanFraction: 0.6,
  cameraFps: 30,
  shutterMs: 20,
  decodeFps: Infinity,
};

/** Display rates achievable with vsync: refresh / n. */
export function achievableFps(target: number, refreshHz: number): number {
  const n = Math.max(1, Math.round(refreshHz / Math.max(0.1, target)));
  return refreshHz / n;
}

/** Probability that one displayed code is captured cleanly at least once. */
export function captureProbability(p: ChannelParams): number {
  const Td = 1 / p.displayFps;
  const ts = p.scanFraction / p.refreshHz;
  const tau = p.shutterMs / 1000;
  const Tc = 1 / p.cameraFps;
  const prob = Math.min(1, Math.max(0, (Td - ts - tau) / Tc));
  const decodeShare = Math.min(1, p.decodeFps / p.cameraFps);
  return prob * decodeShare;
}

/** Distinct codes (per on-screen position) received per second. */
export function uniqueCodesPerSecond(p: ChannelParams): number {
  return Math.min(p.displayFps, p.refreshHz) * captureProbability(p);
}

/** The display rate that maximises distinct codes per second, snapped to refresh/n. */
export function optimalDisplayFps(p: Omit<ChannelParams, 'displayFps'>): number {
  let best = 1;
  let bestRate = -1;
  for (let n = 1; n <= 60; n++) {
    const fps = p.refreshHz / n;
    const rate = uniqueCodesPerSecond({ ...p, displayFps: fps });
    if (rate > bestRate + 1e-9) {
      bestRate = rate;
      best = fps;
    }
  }
  return best;
}

/** Upper bound of distinct codes per second for a given camera/display (continuous optimum). */
export function maxUniqueCodesPerSecond(p: Omit<ChannelParams, 'displayFps'>): number {
  const raw = 1 / (1 / p.cameraFps + p.scanFraction / p.refreshHz + p.shutterMs / 1000);
  return raw * Math.min(1, p.decodeFps / p.cameraFps);
}

export interface ThroughputEstimate {
  /** File bytes carried by one QR code. */
  payloadPerCode: number;
  /** QR byte capacity incl. frame header. */
  qrBytes: number;
  codesPerSecond: number;
  /** Useful bytes per second (protocol header and fountain overhead excluded). */
  bytesPerSecond: number;
}

/** Fountain reception overhead used in estimates (measured: +2 symbols per generation, ≈1-3 % multi-generation). */
export const FOUNTAIN_EFFICIENCY = 0.99;

export function estimateThroughput(version: number, ecc: Ecc, codesPerScreen: number, p: ChannelParams): ThroughputEstimate {
  const payloadPerCode = blockSizeFor(version, ecc);
  const codesPerSecond = uniqueCodesPerSecond(p) * codesPerScreen;
  return {
    payloadPerCode,
    qrBytes: byteCapacity(version, ecc),
    codesPerSecond,
    bytesPerSecond: payloadPerCode * codesPerSecond * FOUNTAIN_EFFICIENCY,
  };
}

/** Camera pixels per module needed for reliable detection (Nyquist ×2 plus margin for blur/perspective). */
export const MIN_PIXELS_PER_MODULE = 3;

/** Largest QR version a camera can resolve when the code spans `codePixels` camera pixels. */
export function maxResolvableVersion(codePixels: number, pixelsPerModule = MIN_PIXELS_PER_MODULE): number {
  const modules = Math.floor(codePixels / pixelsPerModule) - 8; // minus the 4+4 quiet zone
  return Math.max(0, Math.min(40, Math.floor((modules - 17) / 4)));
}

export const PROTOCOL_LIMITS = {
  /** totalLength is a u32. */
  maxStreamBytes: 0xffffffff,
  headerBytes: HEADER_SIZE,
} as const;
