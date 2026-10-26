import { Layout, repairCoefficients, strideFor } from './layout';

export type AddResult = 'duplicate' | 'redundant' | 'progress' | 'complete';

const NONE = 0;
/** Slot holds the final value of its block. */
const UNIT = 1;
/** Slot holds a reduced equation whose lowest set coefficient is this column. */
const PIVOT = 2;

/**
 * Incremental Gaussian elimination over GF(2) for one generation.
 *
 * Invariant: the equation stored for column c has no coefficient below c, so a
 * new equation is reduced by scanning its set bits from low to high. Once the
 * rank reaches `size`, back-substitution (high to low) turns every slot into the
 * final block value — in place, so no extra copy of the data is ever made.
 */
class GenerationDecoder {
  readonly size: number;
  private readonly words: number;
  private readonly sw: number;
  /** size × sw words; slot c = block c (UNIT) or the data of pivot equation c. */
  readonly data: Uint32Array;
  private readonly state: Uint8Array;
  private coef: (Uint32Array | null)[] | null;
  rank = 0;
  complete = false;

  constructor(size: number, strideWords: number, storage: Uint32Array) {
    this.size = size;
    this.words = (size + 31) >>> 5;
    this.sw = strideWords;
    this.data = storage;
    this.state = new Uint8Array(size);
    this.coef = new Array(size).fill(null);
  }

  isKnown(local: number): boolean {
    return this.state[local] === UNIT;
  }

  addSystematic(local: number, payload: Uint32Array): boolean {
    if (this.complete || this.state[local] === UNIT) return false;
    const sw = this.sw;
    const slot = local * sw;
    if (this.state[local] === NONE) {
      this.data.set(payload, slot);
      this.state[local] = UNIT;
      this.rank++;
      this.finishIfFull();
      return true;
    }
    // A repair equation occupies this column. The unit equation is the better pivot,
    // so take its place and re-insert the displaced equation reduced by it.
    const oldCoef = this.coef![local]!;
    const oldData = this.data.slice(slot, slot + sw);
    for (let k = 0; k < sw; k++) oldData[k] ^= payload[k];
    oldCoef[local >>> 5] ^= 1 << (local & 31);
    this.data.set(payload, slot);
    this.state[local] = UNIT;
    this.coef![local] = null;
    // Rank is unchanged by the swap itself; the displaced equation may add one.
    const added = this.insert(oldCoef, oldData);
    this.finishIfFull();
    return added;
  }

  addRepair(coef: Uint32Array, payload: Uint32Array): boolean {
    if (this.complete) return false;
    const added = this.insert(coef, payload);
    this.finishIfFull();
    return added;
  }

  /** Reduces (coef, d) against the stored equations; stores it if independent. Mutates both. */
  private insert(coef: Uint32Array, d: Uint32Array): boolean {
    const { sw, words, state, data } = this;
    const store = this.coef!;
    for (let w = 0; w < words; w++) {
      while (coef[w] !== 0) {
        const low = coef[w] & -coef[w];
        const c = (w << 5) + 31 - Math.clz32(low);
        const st = state[c];
        if (st === NONE) {
          let unit = (coef[w] ^ low) === 0; // int32 compare: `low` is negative for bit 31
          for (let k = w + 1; unit && k < words; k++) unit = coef[k] === 0;
          data.set(d, c * sw);
          if (unit) {
            state[c] = UNIT;
          } else {
            state[c] = PIVOT;
            store[c] = coef;
          }
          this.rank++;
          return true;
        }
        const slot = c * sw;
        for (let k = 0; k < sw; k++) d[k] ^= data[slot + k];
        if (st === UNIT) {
          coef[w] ^= low;
        } else {
          const p = store[c]!;
          for (let k = w; k < words; k++) coef[k] ^= p[k];
        }
      }
    }
    return false;
  }

  private finishIfFull(): void {
    if (this.rank < this.size || this.complete) return;
    const { sw, words, state, data } = this;
    const store = this.coef!;
    for (let c = this.size - 1; c >= 0; c--) {
      if (state[c] !== PIVOT) continue;
      const coef = store[c]!;
      const slot = c * sw;
      coef[c >>> 5] ^= 1 << (c & 31);
      for (let w = c >>> 5; w < words; w++) {
        let bits = coef[w];
        while (bits !== 0) {
          const low = bits & -bits;
          const j = (w << 5) + 31 - Math.clz32(low);
          bits ^= low;
          const src = j * sw;
          for (let k = 0; k < sw; k++) data[slot + k] ^= data[src + k];
        }
      }
      state[c] = UNIT;
      store[c] = null;
    }
    this.coef = null;
    this.complete = true;
  }
}

/** Receiver side of the code described in layout.ts. */
export class FountainDecoder {
  readonly K: number;
  readonly blockSize: number;
  readonly layout: Layout;
  private readonly strideWords: number;
  private readonly blocks: Uint32Array;
  private readonly gens: GenerationDecoder[];
  private readonly seen = new Set<number>();
  private rankSum = 0;
  private completeGens = 0;
  private readonly coefScratchWords: number;

  /** Distinct symbols accepted (duplicates excluded). */
  received = 0;

  constructor(K: number, blockSize: number) {
    this.K = K;
    this.blockSize = blockSize;
    this.layout = new Layout(K);
    this.strideWords = strideFor(blockSize) >>> 2;
    this.blocks = new Uint32Array(K * this.strideWords);
    this.gens = [];
    for (let g = 0; g < this.layout.G; g++) {
      const start = this.layout.start(g) * this.strideWords;
      const size = this.layout.size(g);
      this.gens.push(new GenerationDecoder(size, this.strideWords, this.blocks.subarray(start, start + size * this.strideWords)));
    }
    this.coefScratchWords = (this.layout.size(0) + 31) >>> 5;
  }

  /** Number of independent equations collected; the transfer completes at K. */
  get rank(): number {
    return this.rankSum;
  }

  get isComplete(): boolean {
    return this.completeGens === this.layout.G;
  }

  addSymbol(id: number, payload: Uint8Array): AddResult {
    if (this.isComplete) return 'complete';
    if (this.seen.has(id)) return 'duplicate';
    this.seen.add(id);
    this.received++;
    const g = this.layout.generationOf(id);
    const gen = this.gens[g];
    if (gen.complete) return 'redundant';
    const local = this.layout.localIndexOf(id);
    const d = new Uint32Array(this.strideWords);
    new Uint8Array(d.buffer).set(payload.subarray(0, this.blockSize));
    const before = gen.rank;
    let added: boolean;
    if (local < gen.size) {
      added = gen.addSystematic(local, d);
    } else {
      const coef = new Uint32Array(this.coefScratchWords);
      repairCoefficients(g, local, gen.size, coef);
      added = gen.addRepair(coef, d);
    }
    this.rankSum += gen.rank - before;
    if (gen.complete) this.completeGens++;
    if (this.isComplete) return 'complete';
    return added ? 'progress' : 'redundant';
  }

  /** Reassembles the first `length` bytes of the source once complete. */
  getData(length: number): Uint8Array {
    if (!this.isComplete) throw new Error('decoding is not complete');
    const out = new Uint8Array(length);
    const bytes = new Uint8Array(this.blocks.buffer, this.blocks.byteOffset, this.blocks.byteLength);
    const stride = this.strideWords * 4;
    for (let b = 0, off = 0; b < this.K && off < length; b++, off += this.blockSize) {
      const n = Math.min(this.blockSize, length - off);
      out.set(bytes.subarray(b * stride, b * stride + n), off);
    }
    return out;
  }

  /** A copy of source block b if it is already known (e.g. to read metadata early). */
  hasBlock(b: number): boolean {
    const { g, local } = this.layout.locate(b);
    return this.gens[g].isKnown(local);
  }

  getBlock(b: number): Uint8Array | null {
    const { g, local } = this.layout.locate(b);
    if (!this.gens[g].isKnown(local)) return null;
    const stride = this.strideWords * 4;
    return new Uint8Array(this.blocks.buffer, this.blocks.byteOffset + b * stride, this.blockSize).slice();
  }
}
