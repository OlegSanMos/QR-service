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
    const t2 = new CodeTracker(1920, 1080);
    t2.update([code(100, 100)], null);
    t2.update([code(600, 100)], null);
    // Both tracks report the same code (e.g. the first one drifted onto the second).
    t2.update([code(600, 100)], t2.all[0].id);
    expect(t2.all.length).toBe(1);
  });

  it('reports the bounding box of all codes', () => {
    const t = new CodeTracker(1920, 1080);
    t.update([code(100, 200), code(1000, 200)], null);
    const b = t.bounds()!;
    expect(b.x).toBeCloseTo(100, 0);
    expect(b.w).toBeCloseTo(900 + 117 * 5, 0);
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
