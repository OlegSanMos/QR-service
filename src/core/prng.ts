// Deterministic PRNG shared by sender and receiver. Both sides must derive the
// exact same pseudo-random choices from a symbol id, so only 32-bit integer
// arithmetic (Math.imul, >>>) is used.
//
// Note: the generator must be non-linear over GF(2). A linear one such as
// xorshift would make every random coefficient row a linear function of a
// 32-bit seed, so the rows would span at most 32 dimensions and a generation
// of more than 32 blocks could never be solved.

/** Murmur3 finaliser: a cheap, well-mixed 32-bit hash. */
export function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** mulberry32 (Tommy Ettinger): 32-bit state, non-linear output, passes PractRand to 2^32. */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = mix32(seed);
  }

  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1) with 32-bit resolution. */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }
}
