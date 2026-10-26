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
  /** The tight region from the last time the code was found (`rect` is widened after misses). */
  home: Rect;
}

export const MAX_TRACKS = 4;
const MISSES_TO_DROP = 4;
/**
 * Margin around a tracked code: a fraction of its side, but at most a few
 * modules. The sender leaves 12 modules between neighbouring symbols (two quiet
 * zones and a gap); a crop reaching the neighbour's finder patterns makes ZXing
 * try wrong combinations (at v25 a 0.2 margin is 23 modules: 21/30 decodes at
 * 3 px/module instead of 26/30). Six modules plus `holdRoi` slack still covers
 * hand shake between frames at 30-60 fps.
 */
const TRACK_MARGIN = 0.2;
const TRACK_PAD_MODULES = 6;
/** After a miss the next crop is widened by this much (code sides) per edge, so a code that moved is found again. */
const MISS_WIDEN = 0.15;

function trackMargin(code: LocatedCode): number {
  if (code.version < 1 || code.version > 40) return TRACK_MARGIN;
  return Math.min(TRACK_MARGIN, TRACK_PAD_MODULES / (code.version * 4 + 17));
}

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

function widen(r: Rect, by: number, frameW: number, frameH: number): Rect {
  const d = Math.ceil(Math.max(0, by));
  const x0 = Math.max(0, r.x - d);
  const y0 = Math.max(0, r.y - d);
  const x1 = Math.min(frameW, r.x + r.w + d);
  const y1 = Math.min(frameH, r.y + r.h + d);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
        // Maybe too blurry for the downscale, or the code moved out of the tight
        // crop: give the next attempt more pixels and a wider view.
        source.scale = Math.min(1, source.scale * 1.5);
        source.rect = widen(source.home, source.side * MISS_WIDEN * source.misses, this.frameW, this.frameH);
        if (source.misses >= MISSES_TO_DROP) this.tracks = this.tracks.filter((t) => t !== source);
      }
      return;
    }
    let sourceFound = false;
    for (const code of found) {
      const g = geometry(code);
      const rect = roiAround([code], this.frameW, this.frameH, trackMargin(code));
      if (!rect || !Number.isFinite(g.side) || g.side <= 0) continue;
      // The same code: the region it was decoded from (unless what was found there
      // is a neighbour that the crop reached into), or a track whose centre is close.
      const near = (t: Track): boolean => Math.hypot(t.cx - g.cx, t.cy - g.cy) < Math.max(t.side, g.side) * 0.6;
      let track = source && found.length === 1 && near(source) ? source : undefined;
      if (!track) {
        let best = Infinity;
        for (const t of this.tracks) {
          const d = Math.hypot(t.cx - g.cx, t.cy - g.cy);
          if (near(t) && d < best) {
            best = d;
            track = t;
          }
        }
      }
      if (!track) {
        if (this.tracks.length >= MAX_TRACKS) continue;
        const r = holdRoi(null, rect, this.frameW, this.frameH);
        track = { id: this.nextId++, rect: r, home: r, scale: holdScale(1, downscaleFor([code])), misses: 0, cx: g.cx, cy: g.cy, side: g.side, lastJob: 0, ppm: 0 };
        this.tracks.push(track);
      } else {
        // Stable size and scale while the code stays inside: see holdRoi/holdScale.
        track.rect = track.home = holdRoi(track.home, rect, this.frameW, this.frameH);
        track.scale = holdScale(track.scale, downscaleFor([code]));
      }
      if (track === source) sourceFound = true;
      track.ppm = pixelsPerModule(code) ?? track.ppm;
      track.misses = 0;
      track.cx = g.cx;
      track.cy = g.cy;
      track.side = g.side;
    }
    // The crop found only a neighbour: back to this code's own tight region
    // instead of staying wide (and finding the neighbour again).
    if (source && !sourceFound && this.tracks.includes(source)) source.rect = source.home;
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

  /**
   * Areas a full-frame probe should blank out: every tracked code with two
   * modules around it. The tracks read those codes anyway, and a probe that
   * still sees them finds a neighbouring code less reliably (seen with two
   * stacked codes: probes returned only the top one for half a second).
   */
  masks(): Rect[] {
    return this.tracks.map((t) => {
      const half = t.side / 2 + (t.ppm > 0 ? 2 * t.ppm : t.side * 0.04);
      const x0 = Math.max(0, Math.floor(t.cx - half));
      const y0 = Math.max(0, Math.floor(t.cy - half));
      const x1 = Math.min(this.frameW, Math.ceil(t.cx + half));
      const y1 = Math.min(this.frameH, Math.ceil(t.cy + half));
      return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
    });
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
