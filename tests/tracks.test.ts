import { describe, expect, it } from 'vitest';
import type { LocatedCode } from '../src/core/roi';
import { CodeTracker, MAX_TRACKS } from '../src/core/tracks';

function code(x: number, y: number, v = 25, ppm = 5): LocatedCode {
  const s = (v * 4 + 17) * ppm;
  return { points: [x, y, x + s, y, x + s, y + s, x, y + s], version: v };
}

describe('CodeTracker', () => {
  it('creates one track per code found by a full-frame probe', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(100, 200), code(1000, 210)], null);
    expect(t.all.length).toBe(2);
    expect(t.all[0].rect.x).toBeLessThan(t.all[1].rect.x);
    expect(t.all[0].scale).toBeCloseTo(0.75, 5); // 5 px/module → 3.5 needs 0.7, rounded up to 1/16 steps
  });

  it('follows a moving code instead of adding a track', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(100, 200)], null);
    const id = t.all[0].id;
    t.update([code(140, 230)], id);
    t.update([code(180, 260)], null); // probe sees it too
    expect(t.all.length).toBe(1);
    expect(t.all[0].id).toBe(id);
    expect(t.all[0].cx).toBeGreaterThan(400);
  });

  it('hands out jobs round-robin so every code is decoded equally often', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(0, 0), code(700, 0), code(0, 500), code(700, 500)], null);
    const served = new Map<number, number>();
    for (let frame = 0; frame < 100; frame++) for (const job of t.jobs(2)) served.set(job.id, (served.get(job.id) ?? 0) + 1);
    expect([...served.values()]).toEqual([50, 50, 50, 50]);
  });

  it('drops a track after repeated misses and boosts its resolution meanwhile', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(100, 100, 25, 7)], null);
    const id = t.all[0].id;
    expect(t.all[0].scale).toBeCloseTo(0.5, 5);
    expect(t.all[0].ppm).toBeCloseTo(7, 5);
    t.update([], id);
    expect(t.all[0].scale).toBeCloseTo(0.75, 5);
    t.update([], null); // a probe that sees nothing does not count against tracks
    t.update([], id);
    t.update([], id);
    expect(t.all.length).toBe(1);
    t.update([], id);
    expect(t.all.length).toBe(0);
  });

  it('never tracks more than MAX_TRACKS codes and merges duplicates', () => {
    const t = new CodeTracker(4000, 4000);
    t.update(Array.from({ length: 6 }, (_, i) => code(i * 650, 0)), null);
    expect(t.all.length).toBe(MAX_TRACKS);
    // Two tracks that end up on the same code are merged.
    const t2 = new CodeTracker(1920, 1080);
    t2.update([code(100, 100)], null);
    t2.update([code(500, 100)], null);
    expect(t2.all.length).toBe(2);
    t2.update([code(350, 100)], t2.all[0].id); // the first one drifts onto the second
    expect(t2.all.length).toBe(1);
  });

  it('does not drag a track onto the neighbour its crop reached into', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(100, 100), code(800, 100)], null);
    const [a, b] = t.all.map((x) => x.id);
    const tight = { ...t.all[0].rect };
    t.update([], a); // a miss widens the first crop…
    expect(t.all[0].rect.w).toBeGreaterThan(tight.w);
    // …and it returned only the second code.
    t.update([code(805, 102)], a);
    expect(t.all.map((x) => x.id)).toEqual([a, b]);
    expect(t.all[0].rect).toEqual(tight); // back to its own region, not wide again
    expect(t.all[0].cx).toBeCloseTo(100 + (117 * 5) / 2, 0);
    expect(t.all[1].cx).toBeCloseTo(805 + (117 * 5) / 2, 0);
  });

  it('reports the bounding box of all codes', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(100, 200), code(1000, 200)], null);
    const b = t.bounds()!;
    expect(b.x).toBeCloseTo(100, 0);
    expect(b.w).toBeCloseTo(900 + 117 * 5, 0);
  });
});

describe('CodeTracker margins', () => {
  it('keeps the crop within a few modules of the code, clear of a neighbour 12 modules away', () => {
    const ppm = 4;
    const t = new CodeTracker(1920, 1080);
    t.update([code(400, 300, 25, ppm)], null);
    const r = t.all[0].rect;
    const side = 117 * ppm;
    for (const pad of [400 - r.x, 300 - r.y, r.x + r.w - (400 + side), r.y + r.h - (300 + side)]) {
      expect(pad / ppm).toBeGreaterThanOrEqual(5);
      expect(pad / ppm).toBeLessThan(12);
    }
  });

  it('widens the crop after a miss so a code that moved is found again', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(400, 300)], null);
    const id = t.all[0].id;
    const before = { ...t.all[0].rect };
    t.update([], id);
    const after = t.all[0].rect;
    expect(after.x).toBeLessThan(before.x);
    expect(after.w).toBeGreaterThan(before.w + 0.25 * 117 * 5);
    // The next hit tightens it again.
    t.update([code(410, 305)], id);
    expect(t.all[0].rect.w).toBeLessThan(after.w);
  });
});

describe('CodeTracker probe masks', () => {
  it('blanks each tracked code with two modules around it, but not its neighbour', () => {
    const t = new CodeTracker(1920, 1080);
    const ppm = 4;
    const side = 117 * ppm;
    const gap = 12 * ppm; // quiet zones plus the sender's gap
    t.update([code(100, 100, 25, ppm), code(100 + side + gap, 100, 25, ppm)], null);
    const [a, b] = t.masks();
    expect(a.x).toBeCloseTo(100 - 2 * ppm, 0);
    expect(a.w).toBeCloseTo(side + 4 * ppm, 0);
    expect(a.x + a.w).toBeLessThan(b.x); // the masks do not touch
    expect(b.x).toBeGreaterThan(100 + side);
  });
});

describe('CodeTracker stability', () => {
  it('keeps a track rectangle and scale steady under corner jitter', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(400, 300)], null);
    const first = { ...t.all[0].rect };
    const scale = t.all[0].scale;
    for (let i = 0; i < 20; i++) t.update([code(400 + (i % 3) - 1, 300 + (i % 2))], t.all[0].id);
    expect(t.all[0].rect).toEqual(first);
    expect(t.all[0].scale).toBe(scale);
  });
});
