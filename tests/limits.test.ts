import { describe, expect, it } from 'vitest';
import { autoDisplayFps, expectedLinkBytesPerSecond, robustCodesPerSecond, snapRefreshHz } from '../src/core/limits';

describe('auto mode', () => {
  it('picks a display rate that works for both 30 and 60 fps cameras', () => {
    // 60 Hz: every 3rd refresh (20 codes/s) — 30/s would starve 30 fps cameras, 15/s wastes 60 fps ones.
    expect(autoDisplayFps(60)).toBe(20);
    expect(autoDisplayFps(120)).toBeGreaterThanOrEqual(17);
    expect(autoDisplayFps(120)).toBeLessThanOrEqual(24);
    expect(robustCodesPerSecond(20, 60)).toBeGreaterThan(robustCodesPerSecond(30, 60));
    expect(robustCodesPerSecond(20, 60)).toBeGreaterThan(robustCodesPerSecond(12, 60));
  });

  it('estimates a realistic link speed', () => {
    const bps = expectedLinkBytesPerSecond(25, 'L', 1, 20, 60);
    expect(bps).toBeGreaterThan(15_000);
    expect(bps).toBeLessThan(30_000);
  });

  it('snaps measured refresh rates', () => {
    expect(snapRefreshHz(59.7)).toBe(60);
    expect(snapRefreshHz(119.2)).toBe(120);
    expect(snapRefreshHz(91)).toBe(90);
    expect(snapRefreshHz(37)).toBe(37);
  });
});
