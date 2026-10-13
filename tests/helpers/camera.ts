import type { QrMatrix } from '../../src/core/qr/encoder';
import type { RgbaImage } from './zxing';

export interface CameraOptions {
  width: number;
  height: number;
  /** Camera pixels per QR module (fractional is fine). */
  pixelsPerModule: number;
  /** Rotation in degrees. */
  rotation?: number;
  /** Additive uniform noise amplitude (0..255). */
  noise?: number;
  /** Box blur radius in pixels. */
  blur?: number;
  /** Low/high luminance of dark/light modules (screen contrast as seen by the camera). */
  dark?: number;
  light?: number;
  seed?: number;
}

/** Renders a QR matrix as a camera would roughly see a phone screen: rotated, resampled, blurred, noisy. */
export function photograph(matrix: QrMatrix, o: CameraOptions): RgbaImage {
  const { width, height, pixelsPerModule: ppm } = o;
  const dark = o.dark ?? 30;
  const light = o.light ?? 220;
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const angle = ((o.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = width / 2;
  const cy = height / 2;
  const gray = new Float32Array(width * height);
  const module = (mx: number, my: number): number => {
    const x = Math.floor(mx) - quiet;
    const y = Math.floor(my) - quiet;
    if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return light;
    return matrix.modules[y * matrix.size + x] ? dark : light;
  };
  // 2x2 supersampling approximates the sensor integrating over each pixel.
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let acc = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const dx = px + sx - cx;
        const dy = py + sy - cy;
        const u = (cos * dx + sin * dy) / ppm + total / 2;
        const v = (-sin * dx + cos * dy) / ppm + total / 2;
        acc += module(u, v);
      }
      gray[py * width + px] = acc / 4;
    }
  }
  let img = gray;
  const r = o.blur ?? 0;
  if (r > 0) {
    const tmp = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < width) { s += img[y * width + xx]; n++; }
        }
        tmp[y * width + x] = s / n;
      }
    }
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < height) { s += tmp[yy * width + x]; n++; }
        }
        out[y * width + x] = s / n;
      }
    }
    img = out;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = (o.seed ?? 1) >>> 0 || 1;
  const noise = o.noise ?? 0;
  for (let i = 0; i < width * height; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const n = noise ? (((seed >>> 0) / 4294967296) * 2 - 1) * noise : 0;
    const v = img[i] + n;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
