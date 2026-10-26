// Context-mixing compressor ("QCM"), from the PAQ family that holds most
// compression-ratio records. Every bit of the input is predicted by several
// context models; a gated neural network (two mixers selected by different
// contexts) combines their predictions, two adaptive probability maps refine
// the result and a binary arithmetic coder turns it into bits.
//
// Design constraints for this project:
//  * Bit-exact on every JS engine: the sender (e.g. Chrome) and the receiver
//    (e.g. Safari) must compute identical probabilities, so the model uses
//    integer arithmetic only — no Math.exp/Math.log at runtime.
//  * Fast enough to pay for itself: the QR channel moves ~10-60 KB/s, so the
//    coder has to run at ~1 MB/s; heavier models (cmix, neural/LLM coders)
//    compress a few % better but at kilobytes per second, which would make a
//    transfer slower, not faster.
//
// Models: order 0, 1, 2, 3, 4, 6, a word model (unigram and bigram of the
// current/previous word, letters incl. UTF-8 multibyte), a sparse model for
// binary records and a match model for long repeats. Hashed contexts live in
// 16-slot buckets addressed once per nibble, so a byte costs two cache misses
// per model instead of eight.

const SQUASH_T = [
  1, 2, 3, 6, 10, 16, 27, 45, 73, 120, 194, 310, 488, 747, 1101, 1546, 2047, 2549, 2994, 3348, 3607, 3785, 3901, 3975, 4022, 4050,
  4068, 4079, 4085, 4089, 4092, 4093, 4094,
];

/** 1/(1+e^-x) with x scaled by 256 (±2047) and the result by 4096. Integer-only. */
export function squash(d: number): number {
  if (d > 2047) return 4095;
  if (d < -2047) return 1;
  const w = d & 127;
  const i = (d >> 7) + 16;
  return (SQUASH_T[i] * (128 - w) + SQUASH_T[i + 1] * w + 64) >> 7;
}

/** Inverse of squash: ln(p/(1-p)) for 12-bit p, scaled by 256. */
export const STRETCH = new Int16Array(4096);
{
  let pi = 0;
  for (let x = -2047; x <= 2047; x++) {
    const v = squash(x);
    for (let i = pi; i <= v; i++) STRETCH[i] = x;
    pi = v + 1;
  }
  for (let i = pi; i < 4096; i++) STRETCH[i] = 2047;
}

/** Adaptation rate of the probability counters: ~1/(n+1.5) until the limit. */
const DT = new Int32Array(1024);
for (let i = 0; i < 1024; i++) DT[i] = Math.floor(16384 / (i + i + 3));

// Counter cell: high 22 bits = P(bit=1), low 10 bits = number of updates (capped).
const COUNTER_INIT = 0x80000000;

function counterUpdate(t: Uint32Array, i: number, y: number, limit: number): void {
  const v = t[i];
  const n = v & 1023;
  const err = ((y << 22) - (v >>> 10)) >> 3;
  let nv = v + (Math.imul(err, DT[n]) & 0xfffffc00);
  nv = n < limit ? nv + 1 : (nv & 0xfffffc00) | limit;
  t[i] = nv >>> 0;
}

/** Number of hashed context models (each a table of 16-slot nibble buckets). */
const HASHED = 8;
/** Mixer inputs: order0, order1, HASHED hashed models, match, bias. */
const INPUTS = HASHED + 4;

const MATCH_MIN = 6;
const MATCH_MAX = 65535;

/** Table sizes grow with the input (both sides know its length), capped for phones. */
function tableBits(length: number): number {
  let bits = 16;
  while (bits < 21 && 1 << (bits - 2) < length) bits++;
  return bits;
}

function hash2(a: number, b: number): number {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

function apmTable(n: number): Uint16Array {
  const row = new Uint16Array(33);
  for (let j = 0; j < 33; j++) row[j] = squash((j - 16) * 128) * 16;
  const t = new Uint16Array(n * 33);
  for (let i = 0; i < n; i++) t.set(row, i * 33);
  return t;
}

const LIMITS = Int32Array.of(255, 127, 31, 31, 31, 31, 31, 31);
const MIXER_RATE = 40;
const APM_RATE = 7;

/**
 * The shared bit predictor: encoder and decoder feed it the same bits.
 * Written as one flat object with typed arrays and manually inlined mixers,
 * counters and APMs — this is the hot loop (~10 model lookups per bit).
 */
class Predictor {
  private readonly buf: Uint8Array;
  private pos = 0;

  private c0 = 1; // partial byte with a leading 1
  private bitPos = 0;
  private nib = 1; // partial nibble with a leading 1
  private c4 = 0; // last 4 bytes
  private c8 = 0; // bytes 5..8 back
  private word = 0;
  private word1 = 0;

  private readonly t0 = new Uint32Array(256).fill(COUNTER_INIT);
  private readonly t1 = new Uint32Array(65536).fill(COUNTER_INIT);
  /** All hashed models in one array: model k occupies [k << bits, (k + 1) << bits). */
  private readonly t: Uint32Array;
  private readonly bits: number;
  private readonly shift: number;
  private readonly ctxHash = new Uint32Array(HASHED);
  /** Absolute index of each model's current 16-slot bucket. */
  private readonly bucket = new Int32Array(HASHED);

  private readonly matchTable: Int32Array;
  private readonly matchShift: number;
  private matchPtr = 0;
  private matchLen = 0;
  private expected = -1;
  private readonly matchCounters = new Uint32Array(64).fill(COUNTER_INIT);
  private matchSlot = -1;

  private readonly x = new Int32Array(INPUTS);
  private readonly w1 = new Int32Array(256 * INPUTS).fill(1 << 13);
  private readonly w2 = new Int32Array(2048 * INPUTS).fill(1 << 13);
  private w1o = 0;
  private w2o = 0;
  private pr1 = 2048;
  private pr2 = 2048;
  private readonly a1 = apmTable(256);
  private readonly a2 = apmTable(65536);
  private a1i = 0;
  private a2i = 0;
  private o1 = 0;
  pr = 2048;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.bits = tableBits(buf.length);
    this.shift = 32 - this.bits;
    this.t = new Uint32Array(HASHED << this.bits).fill(COUNTER_INIT);
    const mbits = Math.max(12, this.bits - 2);
    this.matchShift = 32 - mbits;
    this.matchTable = new Int32Array(1 << mbits);
    this.byteContexts();
    this.predict();
  }

  /** Called after each byte: refreshes every context hash and the match state. */
  private byteContexts(): void {
    const c4 = this.c4;
    const c8 = this.c8;
    const h = this.ctxHash;
    h[0] = hash2(c4 & 0xffff, 2);
    h[1] = hash2(c4 & 0xffffff, 3);
    h[2] = hash2(c4, 4);
    h[3] = hash2(c4, (c8 & 0xffff) | 0x60000);
    h[4] = hash2(this.word, 0x77);
    h[5] = hash2(this.word, this.word1 + 0x99);
    h[6] = hash2(c4 & 0xff00ff00, 0x5a); // sparse: bytes 2 and 4 back (records, 16/32-bit data)
    h[7] = hash2(c4 & 0xffff0000, (c8 & 0xff) | 0xa00); // bytes 3,4,5 back, skipping the last two
    this.selectBuckets(0);

    const buf = this.buf;
    const pos = this.pos;
    if (pos > 0) {
      if (this.matchLen > 0 && buf[this.matchPtr] === buf[pos - 1]) {
        this.matchPtr++;
        if (this.matchLen < MATCH_MAX) this.matchLen++;
      } else {
        this.matchLen = 0;
      }
    }
    if (pos >= MATCH_MIN) {
      const mh = hash2(c4, c8 & 0xffff) >>> this.matchShift;
      if (this.matchLen === 0) {
        const cand = this.matchTable[mh];
        if (cand > 0) {
          let len = 0;
          while (len < 64 && cand - 1 - len >= 0 && buf[cand - 1 - len] === buf[pos - 1 - len]) len++;
          if (len >= MATCH_MIN) {
            this.matchLen = len;
            this.matchPtr = cand;
          }
        }
      }
      this.matchTable[mh] = pos;
    }
    this.expected = this.matchLen > 0 ? buf[this.matchPtr] : -1;
  }

  /** Picks the 16-slot bucket of every hashed model for the current nibble. */
  private selectBuckets(salt: number): void {
    const bits = this.bits;
    const shift = this.shift;
    const h = this.ctxHash;
    const b = this.bucket;
    for (let k = 0; k < HASHED; k++) b[k] = (k << bits) + ((((h[k] + salt) >>> 0) >>> shift) & ~15);
  }

  private predict(): void {
    const x = this.x;
    const t = this.t;
    const b = this.bucket;
    const nib = this.nib;
    const c0 = this.c0;
    x[0] = STRETCH[this.t0[c0] >>> 20];
    const o1 = ((this.c4 & 0xff) << 8) | c0;
    this.o1 = o1;
    x[1] = STRETCH[this.t1[o1] >>> 20];
    x[2] = STRETCH[t[b[0] + nib] >>> 20];
    x[3] = STRETCH[t[b[1] + nib] >>> 20];
    x[4] = STRETCH[t[b[2] + nib] >>> 20];
    x[5] = STRETCH[t[b[3] + nib] >>> 20];
    x[6] = STRETCH[t[b[4] + nib] >>> 20];
    x[7] = STRETCH[t[b[5] + nib] >>> 20];
    x[8] = STRETCH[t[b[6] + nib] >>> 20];
    x[9] = STRETCH[t[b[7] + nib] >>> 20];

    // Match model: confidence that the next bit equals the predicted one.
    let lenBucket = 0;
    this.matchSlot = -1;
    const e = this.expected;
    if (e >= 0 && (e + 256) >> (8 - this.bitPos) === c0) {
      const bit = (e >> (7 - this.bitPos)) & 1;
      const len = this.matchLen;
      const lb = len < 16 ? len : len < 64 ? 16 + ((len - 16) >> 2) : len < 512 ? 28 + ((len - 64) >> 7) : 31;
      const slot = lb * 2 + bit;
      this.matchSlot = slot;
      const st = STRETCH[this.matchCounters[slot] >>> 20];
      x[10] = bit ? st : -st;
      lenBucket = len < 16 ? 1 : len < 32 ? 2 : 3;
    } else {
      x[10] = 0;
      if (e >= 0) this.expected = -1; // mismatch: no more predictions this byte
    }
    x[11] = 256;

    // Two mixers (weight sets selected by different contexts), averaged in the stretched domain.
    const w1 = this.w1;
    const w2 = this.w2;
    const o = c0 * INPUTS;
    const p = ((lenBucket << 9) | (((this.c4 & 0xff) >> 7) << 8) | c0) * INPUTS;
    this.w1o = o;
    this.w2o = p;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < INPUTS; i++) {
      const xi = x[i];
      s1 += xi * w1[o + i];
      s2 += xi * w2[p + i];
    }
    let d1 = Math.floor(s1 / 65536);
    let d2 = Math.floor(s2 / 65536);
    d1 = d1 > 2047 ? 2047 : d1 < -2047 ? -2047 : d1;
    d2 = d2 > 2047 ? 2047 : d2 < -2047 ? -2047 : d2;
    this.pr1 = squash(d1);
    this.pr2 = squash(d2);
    const pm = squash((d1 + d2) >> 1);

    // Two APM/SSE stages: by partial byte, and by partial byte + previous byte.
    const s = STRETCH[pm] + 2048;
    const lo = s >> 7;
    const wt = s & 127;
    const half = wt >> 6;
    const b1 = c0 * 33 + lo;
    const b2 = o1 * 33 + lo;
    this.a1i = b1 + half;
    this.a2i = b2 + half;
    const a1 = this.a1;
    const a2 = this.a2;
    const p1 = (a1[b1] * (128 - wt) + a1[b1 + 1] * wt) >> 11;
    const p2 = (a2[b2] * (128 - wt) + a2[b2 + 1] * wt) >> 11;
    const pr = (pm * 2 + p1 + p2 * 5 + 4) >> 3;
    this.pr = pr < 1 ? 1 : pr > 4095 ? 4095 : pr;
  }

  update(y: number): void {
    const nib = this.nib;
    const t = this.t;
    const b = this.bucket;

    // Probability counters (see counterUpdate), inlined for the hashed models.
    counterUpdate(this.t0, this.c0, y, 1023);
    counterUpdate(this.t1, this.o1, y, 1023);
    const target = y << 22;
    for (let k = 0; k < HASHED; k++) {
      const i = b[k] + nib;
      const v = t[i];
      const n = v & 1023;
      const lim = LIMITS[k];
      let nv = v + (Math.imul((target - (v >>> 10)) >> 3, DT[n]) & 0xfffffc00);
      nv = n < lim ? nv + 1 : (nv & 0xfffffc00) | lim;
      t[i] = nv >>> 0;
    }
    if (this.matchSlot >= 0) {
      const bit = (this.expected >> (7 - this.bitPos)) & 1;
      counterUpdate(this.matchCounters, this.matchSlot, y === bit ? 1 : 0, 1023);
    }

    // Mixer training.
    const x = this.x;
    const w1 = this.w1;
    const w2 = this.w2;
    const o = this.w1o;
    const p = this.w2o;
    const e1 = ((y << 12) - this.pr1) * MIXER_RATE;
    const e2 = ((y << 12) - this.pr2) * MIXER_RATE;
    for (let i = 0; i < INPUTS; i++) {
      const xi = x[i];
      w1[o + i] += (xi * e1 + 0x8000) >> 16;
      w2[p + i] += (xi * e2 + 0x8000) >> 16;
    }

    // APM training.
    const g = (y << 16) + (y << APM_RATE) - y - y;
    const a1 = this.a1;
    const a2 = this.a2;
    a1[this.a1i] += (g - a1[this.a1i]) >> APM_RATE;
    a2[this.a2i] += (g - a2[this.a2i]) >> APM_RATE;

    this.c0 = (this.c0 << 1) | y;
    this.nib = (nib << 1) | y;
    this.bitPos++;
    if (this.bitPos === 8) {
      const c = this.c0 & 0xff;
      this.buf[this.pos++] = c;
      this.c8 = ((this.c8 << 8) | (this.c4 >>> 24)) >>> 0;
      this.c4 = ((this.c4 << 8) | c) >>> 0;
      // Words: ASCII letters (case-folded) and any byte of a UTF-8 multibyte letter.
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c >= 128) {
        const lc = c >= 65 && c <= 90 ? c + 32 : c;
        this.word = (Math.imul(this.word ^ lc, 0x01000193) + 1) >>> 0;
      } else if (this.word !== 0) {
        this.word1 = this.word;
        this.word = 0;
      }
      this.c0 = 1;
      this.nib = 1;
      this.bitPos = 0;
      this.byteContexts();
    } else if (this.bitPos === 4) {
      this.nib = 1;
      this.selectBuckets(Math.imul(this.c0, 0x2f0f3a35));
    }
    this.predict();
  }
}

/** `written` (compressor only): compressed bytes produced so far. */
export type ProgressCallback = (done: number, total: number, written: number) => void;

const PROGRESS_STEP = 1 << 16;

/** Compresses `data`; the caller must store `data.length` to decompress. */
export function cmCompress(data: Uint8Array, onProgress?: ProgressCallback): Uint8Array {
  const n = data.length;
  let out = new Uint8Array(Math.max(1024, (n >> 1) + 64));
  let o = 0;
  const put = (b: number): void => {
    if (o === out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[o++] = b;
  };
  // The predictor keeps its own copy of the history (its buffer doubles as the match source).
  const p = new Predictor(new Uint8Array(n));
  let x1 = 0;
  let x2 = 0xffffffff;
  for (let i = 0; i < n; i++) {
    const c = data[i];
    for (let j = 7; j >= 0; j--) {
      const y = (c >> j) & 1;
      const xmid = x1 + Math.floor((x2 - x1) * p.pr / 4096);
      if (y) x2 = xmid;
      else x1 = xmid + 1;
      p.update(y);
      while (((x1 ^ x2) & 0xff000000) === 0) {
        put(x2 >>> 24);
        x1 = (x1 << 8) >>> 0;
        x2 = ((x2 << 8) | 255) >>> 0;
      }
    }
    if (onProgress && (i & (PROGRESS_STEP - 1)) === PROGRESS_STEP - 1) onProgress(i + 1, n, o);
  }
  // Flush enough bytes that the decoder never reads past the end.
  put(x1 >>> 24);
  put((x1 >>> 16) & 255);
  put((x1 >>> 8) & 255);
  put(x1 & 255);
  onProgress?.(n, n, o);
  return out.slice(0, o);
}

export function cmDecompress(comp: Uint8Array, length: number, onProgress?: ProgressCallback): Uint8Array {
  const out = new Uint8Array(length);
  const p = new Predictor(out);
  let x1 = 0;
  let x2 = 0xffffffff;
  let x = 0;
  let ip = 0;
  const next = (): number => (ip < comp.length ? comp[ip++] : 0);
  for (let i = 0; i < 4; i++) x = ((x << 8) | next()) >>> 0;
  for (let i = 0; i < length; i++) {
    for (let j = 0; j < 8; j++) {
      const xmid = x1 + Math.floor((x2 - x1) * p.pr / 4096);
      const y = x <= xmid ? 1 : 0;
      if (y) x2 = xmid;
      else x1 = xmid + 1;
      p.update(y);
      while (((x1 ^ x2) & 0xff000000) === 0) {
        x1 = (x1 << 8) >>> 0;
        x2 = ((x2 << 8) | 255) >>> 0;
        x = ((x << 8) | next()) >>> 0;
      }
    }
    if (onProgress && (i & (PROGRESS_STEP - 1)) === PROGRESS_STEP - 1) onProgress(i + 1, length, ip);
  }
  onProgress?.(length, length, ip);
  return out;
}
