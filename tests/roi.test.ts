import { describe, expect, it } from 'vitest';
import { downscaleFor, holdRoi, holdScale, pixelsPerModule, roiAround, type LocatedCode } from '../src/core/roi';

/** Axis-aligned code of version v at (x, y) with `ppm` pixels per module. */
function code(x: number, y: number, v: number, ppm: number): LocatedCode {
  const s = (v * 4 + 17) * ppm;
  return { points: [x, y, x + s, y, x + s, y + s, x, y + s], version: v };
}

describe('roiAround', () => {
  it('grows the bounding box by the margin and clamps it to the frame', () => {
    const r = roiAround([code(800, 300, 25, 4)], 1920, 1080, 0.25)!; // 468 px code
    expect(r).toEqual({ x: 683, y: 183, w: 702, h: 702 });
    const edge = roiAround([code(10, 10, 25, 4)], 1920, 1080)!;
    expect(edge.x).toBe(0);
    expect(edge.y).toBe(0);
  });

  it('covers several codes side by side', () => {
    const r = roiAround([code(100, 300, 20, 3), code(900, 320, 20, 3)], 1920, 1080, 0)!;
    expect(r.x).toBe(100);
    expect(r.x + r.w).toBe(900 + 97 * 3);
    expect(r.y).toBe(300);
  });

  it('returns null for no or degenerate codes and skips invalid points', () => {
    expect(roiAround([], 1920, 1080)).toBeNull();
    expect(roiAround([{ points: [5, 5, 5, 5, 5, 5, 5, 5], version: 3 }], 1920, 1080)).toBeNull();
    expect(roiAround([{ points: [NaN, 0, 100, 100, 300, 100, 300, 300], version: 3 }], 1920, 1080, 0)).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });
});

describe('downscaleFor', () => {
  it('estimates module size from corners and version', () => {
    expect(pixelsPerModule(code(0, 0, 25, 6))).toBeCloseTo(6, 6);
    expect(pixelsPerModule({ points: code(0, 0, 25, 6).points, version: 0 })).toBeNull();
  });

  it('scales large codes down to ~3.5 px per module, never up', () => {
    expect(downscaleFor([code(0, 0, 25, 7)])).toBeCloseTo(0.5, 6);
    expect(downscaleFor([code(0, 0, 25, 3)])).toBe(1);
    expect(downscaleFor([code(0, 0, 10, 30)])).toBe(0.3);
    expect(downscaleFor([])).toBe(1);
  });

  it('keeps the smallest code readable when several are visible', () => {
    expect(downscaleFor([code(0, 0, 25, 7), code(600, 0, 25, 5)])).toBeCloseTo(0.7, 6);
  });
});

describe('holdRoi / holdScale', () => {
  it('keeps the capture size constant while the detected corners jitter', () => {
    const sizes = new Set<string>();
    let roi = null as ReturnType<typeof holdRoi> | null;
    let scale = 1;
    for (let i = 0; i < 200; i++) {
      // A v40 code at ~5.2 px/module whose corners wobble by up to ±2 px.
      const j = ((i * 7919) % 5) - 2;
      const c = code(500 + j, 100 - j, 40, 5.2 + j * 0.003);
      roi = holdRoi(roi, roiAround([c], 1920, 1080)!, 1920, 1080);
      scale = holdScale(scale, downscaleFor([c]));
      sizes.add(`${Math.round(roi.w * scale)}x${Math.round(roi.h * scale)}`);
    }
    expect(sizes.size).toBe(1);
    // Never fewer pixels per module than asked for, and not much more.
    expect(scale).toBeGreaterThanOrEqual(3.5 / 5.2);
    expect(scale).toBeLessThan((3.5 / 5.2) * 1.1);
  });

  it('follows the code once it leaves the held region', () => {
    const a = holdRoi(null, roiAround([code(300, 200, 25, 4)], 1920, 1080)!, 1920, 1080);
    const moved = roiAround([code(700, 200, 25, 4)], 1920, 1080)!;
    const b = holdRoi(a, moved, 1920, 1080);
    expect(b).not.toEqual(a);
    expect(b.x).toBeLessThanOrEqual(moved.x);
    expect(b.x + b.w).toBeGreaterThanOrEqual(moved.x + moved.w);
    // A much smaller code (phone moved away) gets a tighter region, not the old big one.
    const far = roiAround([code(320, 220, 25, 2)], 1920, 1080)!;
    const c = holdRoi(a, far, 1920, 1080);
    expect(c.w * c.h).toBeLessThan(far.w * far.h * 1.25);
    expect(holdRoi(null, { x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('changes the scale only outside the band, rounding up to 1/16', () => {
    expect(holdScale(1, 0.64)).toBe(0.6875);
    expect(holdScale(0.6875, 0.66)).toBe(0.6875);
    expect(holdScale(0.6875, 0.7)).toBe(0.75); // needs more pixels: switch at once
    expect(holdScale(0.75, 0.5)).toBe(0.5);
    expect(holdScale(0.5, 1)).toBe(1);
  });
});
