import { Layout, blockCount, repairCoefficients, strideFor } from './layout';

export class FountainEncoder {
  readonly K: number;
  readonly blockSize: number;
  readonly layout: Layout;
  private readonly strideWords: number;
  private readonly words: Uint32Array;
  private readonly acc: Uint32Array;
  private readonly accBytes: Uint8Array;
  private readonly coef: Uint32Array;

  constructor(data: Uint8Array, blockSize: number) {
    if (!Number.isInteger(blockSize) || blockSize < 1) throw new RangeError('blockSize must be positive');
    this.blockSize = blockSize;
    const stride = strideFor(blockSize);
    this.strideWords = stride >>> 2;
    this.K = blockCount(data.length, blockSize);
    this.layout = new Layout(this.K);
    const bytes = new Uint8Array(this.K * stride);
    for (let b = 0; b < this.K; b++) {
      const start = b * blockSize;
      bytes.set(data.subarray(start, Math.min(start + blockSize, data.length)), b * stride);
    }
    this.words = new Uint32Array(bytes.buffer);
    this.acc = new Uint32Array(this.strideWords);
    this.accBytes = new Uint8Array(this.acc.buffer);
    this.coef = new Uint32Array((this.layout.size(0) + 31) >>> 5);
  }

  /** Writes the `blockSize`-byte symbol `id` into `out` at `offset`. */
  encodeInto(id: number, out: Uint8Array, offset = 0): void {
    const { layout, words, acc, strideWords: sw } = this;
    const g = layout.generationOf(id);
    const local = layout.localIndexOf(id);
    const size = layout.size(g);
    const start = layout.start(g);
    if (local < size) {
      const base = (start + local) * sw;
      out.set(new Uint8Array(words.buffer, base * 4, this.blockSize), offset);
      return;
    }
    repairCoefficients(g, local, size, this.coef);
    acc.fill(0);
    const nWords = (size + 31) >>> 5;
    for (let w = 0; w < nWords; w++) {
      let bits = this.coef[w];
      while (bits !== 0) {
        const low = bits & -bits;
        const i = (w << 5) + 31 - Math.clz32(low);
        bits ^= low;
        const base = (start + i) * sw;
        for (let k = 0; k < sw; k++) acc[k] ^= words[base + k];
      }
    }
    out.set(this.accBytes.subarray(0, this.blockSize), offset);
  }

  encode(id: number): Uint8Array {
    const out = new Uint8Array(this.blockSize);
    this.encodeInto(id, out);
    return out;
  }
}
