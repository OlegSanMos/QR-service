// Region-of-interest tracking for the receiver. Once a code has been found, the
// next camera frames only need the area around it, scaled down so that a module
// is ~3.5 pixels: decoding a few hundred thousand pixels instead of a full
// 1920×1080 frame is what lets a phone keep up with a 60 fps camera.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LocatedCode {
  /** Corner points x0,y0,…,x3,y3 in camera-frame coordinates. */
  points: number[];
  /** QR version (1-40), or 0 if unknown. */
  version: number;
}

/** Bounding box of the codes grown by `margin` × its larger side (room for hand shake), clamped to the frame. */
export function roiAround(codes: LocatedCode[], frameW: number, frameH: number, margin = 0.35): Rect | null {
  if (codes.length === 0 || frameW <= 0 || frameH <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of codes) {
    for (let i = 0; i < 4; i++) {
      const x = c.points[i * 2];
      const y = c.points[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  const pad = Math.max(maxX - minX, maxY - minY) * margin;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(frameW, Math.ceil(maxX + pad));
  const y1 = Math.min(frameH, Math.ceil(maxY + pad));
  if (x1 - x0 < 16 || y1 - y0 < 16) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Camera pixels per QR module, from the detected corners and the symbol version. */
export function pixelsPerModule(code: LocatedCode): number | null {
  if (code.version < 1 || code.version > 40) return null;
  const p = code.points;
  let side = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    side += Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
  }
  const ppm = side / 4 / (code.version * 4 + 17);
  return Number.isFinite(ppm) && ppm > 0 ? ppm : null;
}

/** Downscale factor (≤ 1) that brings the smallest module of the codes to about `target` pixels. */
export function downscaleFor(codes: LocatedCode[], target = 3.5, minScale = 0.3): number {
  let smallest = Infinity;
  for (const c of codes) {
    const ppm = pixelsPerModule(c);
    if (ppm !== null) smallest = Math.min(smallest, ppm);
  }
  if (!Number.isFinite(smallest)) return 1;
  return Math.min(1, Math.max(minScale, target / smallest));
}
