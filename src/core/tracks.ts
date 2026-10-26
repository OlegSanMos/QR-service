// Per-code tracking for screens that show several QR codes at once. Each
// visible code gets its own small region of interest that is decoded on its
// own (one code per decoder call, codes in parallel workers) instead of one
// big region covering all of them, which is both slower and makes ZXing group
// finder patterns of neighbouring codes. Full-frame probes discover new codes.

import { downscaleFor, holdRoi, holdScale, pixelsPerModule, roiAround, type LocatedCode, type Rect } from './roi';

export interface Track {
  readonly id: number;
  rect: Rect;
  /** Resize factor for decoding (≈3.5 px per module). */
  scale: number;
  /** Consecutive decodes of this track that found nothing. */
  misses: number;
  /** Centre and side length of the code, camera-frame pixels. */
  cx: number;
  cy: number;
  side: number;
  /** Order in which tracks were last handed out (round-robin fairness). */
  lastJob: number;
  /** Camera pixels per module of this code (for framing hints). */
  ppm: number;
}

export const MAX_TRACKS = 4;
const MISSES_TO_DROP = 4;
/**
 * Margin around a tracked code, in code sides. Enough for hand shake between
 * frames at 30-60 fps, small enough to keep the neighbouring code's finder
 * patterns out (they would make ZXing try wrong combinations).
 */
const TRACK_MARGIN = 0.2;

function geometry(code: LocatedCode): { cx: number; cy: number; side: number } {
  const p = code.points;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < 4; i++) {
    cx += p[i * 2];
    cy += p[i * 2 + 1];
  }
  cx /= 4;
  cy /= 4;
  let side = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    side += Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
  }
  return { cx, cy, side: side / 4 };
}

export class CodeTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private jobCounter = 0;

  constructor(
    public frameW: number,
    public frameH: number,
  ) {}

  get all(): readonly Track[] {
    return this.tracks;
  }

  reset(frameW = this.frameW, frameH = this.frameH): void {
    this.tracks = [];
    this.frameW = frameW;
    this.frameH = frameH;
  }

  /**
   * Tracks to decode for the next camera frame, least recently served first,
   * at most `slots` of them (one per idle decoder).
   */
  jobs(slots: number): Track[] {
    const order = [...this.tracks].sort((a, b) => a.lastJob - b.lastJob).slice(0, Math.max(0, slots));
    for (const t of order) t.lastJob = ++this.jobCounter;
    return order;
  }

  /**
   * Feeds the codes decoded from one region. `trackId` is the track that region
   * belonged to, or null for a full-frame probe (which never counts as a miss).
   */
  update(found: LocatedCode[], trackId: number | null): void {
    const source = trackId === null ? undefined : this.tracks.find((t) => t.id === trackId);
    if (found.length === 0) {
      if (source) {
        source.misses++;
        // Maybe too blurry for the downscale: give the next attempts more pixels.
        source.scale = Math.min(1, source.scale * 1.5);
        if (source.misses >= MISSES_TO_DROP) this.tracks = this.tracks.filter((t) => t !== source);
      }
      return;
    }
    for (const code of found) {
      const g = geometry(code);
      const rect = roiAround([code], this.frameW, this.frameH, TRACK_MARGIN);
      if (!rect || !Number.isFinite(g.side) || g.side <= 0) continue;
      // The same code: the region it was decoded from, or a track whose centre is close.
      let track = source && found.length === 1 ? source : undefined;
      if (!track) {
        let best = Infinity;
        for (const t of this.tracks) {
          const d = Math.hypot(t.cx - g.cx, t.cy - g.cy);
          if (d < Math.max(t.side, g.side) * 0.6 && d < best) {
            best = d;
            track = t;
          }
        }
      }
      if (!track) {
        if (this.tracks.length >= MAX_TRACKS) continue;
        track = { id: this.nextId++, rect: holdRoi(null, rect, this.frameW, this.frameH), scale: holdScale(1, downscaleFor([code])), misses: 0, cx: g.cx, cy: g.cy, side: g.side, lastJob: 0, ppm: 0 };
        this.tracks.push(track);
      } else {
        // Stable size and scale while the code stays inside: see holdRoi/holdScale.
        track.rect = holdRoi(track.rect, rect, this.frameW, this.frameH);
        track.scale = holdScale(track.scale, downscaleFor([code]));
      }
      track.ppm = pixelsPerModule(code) ?? track.ppm;
      track.misses = 0;
      track.cx = g.cx;
      track.cy = g.cy;
      track.side = g.side;
    }
    this.dedupe();
  }

  /** Two tracks that drifted onto the same code: keep the older one. */
  private dedupe(): void {
    const kept: Track[] = [];
    for (const t of this.tracks) {
      if (!kept.some((k) => Math.hypot(k.cx - t.cx, k.cy - t.cy) < Math.max(k.side, t.side) * 0.5)) kept.push(t);
    }
    this.tracks = kept;
  }

  /** Bounding box of all tracked codes (for the orientation hint), or null. */
  bounds(): Rect | null {
    if (this.tracks.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of this.tracks) {
      x0 = Math.min(x0, t.cx - t.side / 2);
      y0 = Math.min(y0, t.cy - t.side / 2);
      x1 = Math.max(x1, t.cx + t.side / 2);
      y1 = Math.max(y1, t.cy + t.side / 2);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}
