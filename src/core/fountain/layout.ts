// Rateless erasure code used for the one-way QR channel.
//
// The stream is cut into K blocks of `blockSize` bytes. Blocks are grouped into
// G "generations" of at most GENERATION_MAX blocks (sizes differ by at most one).
// Symbol ids are dealt round-robin over the generations:
//
//   generation g = id mod G,   local index j = floor(id / G)
//
// For j < size(g) the symbol is systematic: source block j of the generation,
// sent verbatim. For larger j it is a repair symbol: the XOR of a pseudo-random
// subset (each block with probability 1/2) of the generation's blocks.
//
// Why not LT / Raptor? A receiver that has lost a fraction p of the systematic
// frames is missing only U = p·K blocks; sparse LT repair symbols rarely touch
// those, so systematic LT needs 30-40 % extra frames at 10 % loss. Dense random
// rows always hit the missing blocks, and maximum-likelihood decoding (Gaussian
// elimination) needs on average only U + 1.6 repair symbols per generation —
// regardless of the loss rate. Generations bound the O(size²) decoding cost.

import { Prng, mix32 } from '../prng';

export const GENERATION_MAX = 1024;

/** Blocks are stored with a 4-byte aligned stride so XOR can work on 32-bit words. */
export function strideFor(blockSize: number): number {
  return (blockSize + 3) & ~3;
}

export function blockCount(totalLength: number, blockSize: number): number {
  return Math.max(1, Math.ceil(totalLength / blockSize));
}

export class Layout {
  readonly K: number;
  /** Number of generations. */
  readonly G: number;
  private readonly base: number;
  private readonly extra: number;

  constructor(K: number) {
    if (!Number.isInteger(K) || K < 1) throw new RangeError('K must be a positive integer');
    this.K = K;
    this.G = Math.ceil(K / GENERATION_MAX);
    this.base = Math.floor(K / this.G);
    this.extra = K % this.G;
  }

  size(g: number): number {
    return this.base + (g < this.extra ? 1 : 0);
  }

  /** Global index of the first block of generation g. */
  start(g: number): number {
    return g * this.base + Math.min(g, this.extra);
  }

  /** Generation containing global block b, and its index inside it. */
  locate(b: number): { g: number; local: number } {
    const bigSpan = this.extra * (this.base + 1);
    if (b < bigSpan) return { g: Math.floor(b / (this.base + 1)), local: b % (this.base + 1) };
    const r = b - bigSpan;
    return { g: this.extra + Math.floor(r / this.base), local: r % this.base };
  }

  generationOf(id: number): number {
    return id % this.G;
  }

  localIndexOf(id: number): number {
    return Math.floor(id / this.G);
  }
}

/**
 * Coefficient row of repair symbol `local` (>= size) in a generation of `size`
 * blocks: bit i set ⇔ block i is XOR-ed in. Never all-zero.
 */
export function repairCoefficients(g: number, local: number, size: number, out: Uint32Array): void {
  const words = (size + 31) >>> 5;
  const rng = new Prng(mix32(local) ^ mix32((g + 0x632be5ab) | 0));
  let any = 0;
  for (let w = 0; w < words; w++) {
    out[w] = rng.nextU32();
    any |= out[w];
  }
  const tail = size & 31;
  if (tail !== 0) {
    out[words - 1] &= (1 << tail) - 1;
    any = 0;
    for (let w = 0; w < words; w++) any |= out[w];
  }
  if (any === 0) {
    const bit = local % size;
    out[bit >>> 5] |= 1 << (bit & 31);
  }
}
