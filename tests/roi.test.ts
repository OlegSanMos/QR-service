import { describe, expect, it } from 'vitest';
import { downscaleFor, pixelsPerModule, roiAround, type LocatedCode } from '../src/core/roi';

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
