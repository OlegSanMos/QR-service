// Fast QR Code encoder specialised for streaming: every frame of a transfer uses
// the same version and ECC level, so everything that does not depend on the
// payload (function patterns, module placement order, mask bitmaps) is built
// once per version and reused. Only byte mode is supported, which is all the
// binary transport needs.

import {
  type Ecc,
  ECC_CODEWORDS_PER_BLOCK,
  ECC_FORMAT_BITS,
  ECC_ORDINAL,
  MAX_VERSION,
  MIN_VERSION,
  NUM_ERROR_CORRECTION_BLOCKS,
  alignmentPatternPositions,
  byteCapacity,
  numDataCodewords,
  numRawDataModules,
  qrSize,
} from './tables';

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic over x^8 + x^4 + x^3 + x^2 + 1 (0x11D)

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial coefficients (highest degree first, leading 1 omitted), as logs. */
const divisorLogCache = new Map<number, Int16Array>();

function reedSolomonDivisorLogs(degree: number): Int16Array {
  let cached = divisorLogCache.get(degree);
  if (cached) return cached;
  const poly = new Uint8Array(degree);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMul(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  cached = new Int16Array(degree);
  for (let j = 0; j < degree; j++) cached[j] = poly[j] === 0 ? -1 : GF_LOG[poly[j]];
  divisorLogCache.set(degree, cached);
  return cached;
}

function reedSolomonRemainder(
  data: Uint8Array,
  start: number,
  len: number,
  divisorLogs: Int16Array,
  out: Uint8Array,
): void {
  const degree = divisorLogs.length;
  out.fill(0, 0, degree);
  for (let i = 0; i < len; i++) {
    const factor = data[start + i] ^ out[0];
    out.copyWithin(0, 1, degree);
    out[degree - 1] = 0;
    if (factor !== 0) {
      const lf = GF_LOG[factor];
      for (let j = 0; j < degree; j++) {
        const dl = divisorLogs[j];
        if (dl >= 0) out[j] ^= GF_EXP[dl + lf];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-version template

interface Template {
  readonly version: number;
  readonly size: number;
  /** Function patterns (finders, timing, alignment, version info, dark module). Format area is light. */
  readonly base: Uint8Array;
  /** Indices (y * size + x) of data modules in placement (zigzag) order. */
  readonly order: Int32Array;
  /** maskBits[m][i] === 1 when mask m inverts module order[i]. */
  readonly maskBits: readonly Uint8Array[];
  /** Module indices for the 15 format bits, first and second copy. */
  readonly formatPos1: Int32Array;
  readonly formatPos2: Int32Array;
}

const templateCache = new Map<number, Template>();

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError('mask');
  }
}

function buildTemplate(version: number): Template {
  const size = qrSize(version);
  const base = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);
  const set = (x: number, y: number, dark: boolean): void => {
    base[y * size + x] = dark ? 1 : 0;
    isFunction[y * size + x] = 1;
  };

  // Timing patterns
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns with separators
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Alignment patterns
  const align = alignmentPatternPositions(version);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Format information area (reserved; filled per mask) + the always-dark module
  const formatPos1 = new Int32Array(15);
  const formatPos2 = new Int32Array(15);
  for (let i = 0; i <= 5; i++) formatPos1[i] = i * size + 8;
  formatPos1[6] = 7 * size + 8;
  formatPos1[7] = 8 * size + 8;
  formatPos1[8] = 8 * size + 7;
  for (let i = 9; i < 15; i++) formatPos1[i] = 8 * size + (14 - i);
  for (let i = 0; i < 8; i++) formatPos2[i] = 8 * size + (size - 1 - i);
  for (let i = 8; i < 15; i++) formatPos2[i] = (size - 15 + i) * size + 8;
  for (let i = 0; i < 15; i++) {
    base[formatPos1[i]] = 0;
    isFunction[formatPos1[i]] = 1;
    base[formatPos2[i]] = 0;
    isFunction[formatPos2[i]] = 1;
  }
  set(8, size - 8, true);
  // Version information (BCH(18,6))
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Zigzag data placement order
  const order = new Int32Array(numRawDataModules(version));
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!isFunction[y * size + x]) order[k++] = y * size + x;
      }
    }
  }
  if (k !== order.length) throw new Error(`QR template mismatch for version ${version}`);

  const maskBits: Uint8Array[] = [];
  for (let m = 0; m < 8; m++) {
    const bits = new Uint8Array(order.length);
    for (let i = 0; i < order.length; i++) {
      const idx = order[i];
      bits[i] = maskApplies(m, idx % size, Math.floor(idx / size)) ? 1 : 0;
    }
    maskBits.push(bits);
  }

  return { version, size, base, order, maskBits, formatPos1, formatPos2 };
}

function getTemplate(version: number): Template {
  let t = templateCache.get(version);
  if (!t) {
    t = buildTemplate(version);
    templateCache.set(version, t);
  }
  return t;
}

function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// ---------------------------------------------------------------------------
// Penalty score (ISO/IEC 18004 §7.8.3), same algorithm as Nayuki's reference.

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const runHistory = new Int32Array(7);

function historyAdd(run: number, size: number): void {
  if (runHistory[0] === 0) run += size; // light border before the first run
  runHistory.copyWithin(1, 0, 6);
  runHistory[0] = run;
}

function historyCount(): number {
  const n = runHistory[1];
  const core =
    n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
  return (
    (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
    (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
  );
}

function historyTerminate(color: number, run: number, size: number): number {
  if (color) {
    historyAdd(run, size);
    run = 0;
  }
  run += size; // light border after the last run
  historyAdd(run, size);
  return historyCount();
}

export function penaltyScore(m: Uint8Array, size: number): number {
  let result = 0;
  // Rows
  for (let y = 0; y < size; y++) {
    let color = 0;
    let run = 0;
    runHistory.fill(0);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const c = m[row + x];
      if (c === color) {
        run++;
        if (run === 5) result += PENALTY_N1;
        else if (run > 5) result++;
      } else {
        historyAdd(run, size);
        if (!color) result += historyCount() * PENALTY_N3;
        color = c;
        run = 1;
      }
    }
    result += historyTerminate(color, run, size) * PENALTY_N3;
  }
  // Columns
  for (let x = 0; x < size; x++) {
    let color = 0;
    let run = 0;
    runHistory.fill(0);
    for (let y = 0; y < size; y++) {
      const c = m[y * size + x];
      if (c === color) {
        run++;
        if (run === 5) result += PENALTY_N1;
        else if (run > 5) result++;
      } else {
        historyAdd(run, size);
        if (!color) result += historyCount() * PENALTY_N3;
        color = c;
        run = 1;
      }
    }
    result += historyTerminate(color, run, size) * PENALTY_N3;
  }
  // 2x2 blocks of the same color
  let dark = 0;
  for (let y = 0; y < size - 1; y++) {
    const r0 = y * size;
    const r1 = r0 + size;
    for (let x = 0; x < size - 1; x++) {
      const c = m[r0 + x];
      if (c === m[r0 + x + 1] && c === m[r1 + x] && c === m[r1 + x + 1]) result += PENALTY_N2;
    }
  }
  for (let i = 0; i < m.length; i++) dark += m[i];
  // Dark/light balance
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

// ---------------------------------------------------------------------------

export interface QrEncoderOptions {
  /** 'auto' evaluates all 8 masks (spec behaviour); a number forces that mask. */
  mask?: 'auto' | number;
}

/** A rendered symbol: `modules[y * size + x] === 1` means dark. */
export interface QrMatrix {
  readonly size: number;
  readonly modules: Uint8Array;
  readonly mask: number;
}

export class QrEncoder {
  readonly version: number;
  readonly ecc: Ecc;
  readonly size: number;
  /** Max bytes per symbol. */
  readonly capacity: number;

  private readonly template: Template;
  private readonly mask: 'auto' | number;
  private readonly dataCodewords: Uint8Array;
  private readonly rawCodewords: Uint8Array;
  private readonly bits: Uint8Array;
  private readonly work: Uint8Array;
  private readonly best: Uint8Array;
  private readonly eccScratch: Uint8Array;
  private readonly divisorLogs: Int16Array;
  private readonly numBlocks: number;
  private readonly blockEccLen: number;
  private readonly numShortBlocks: number;
  private readonly shortBlockLen: number;
  private readonly formatByMask: Int32Array;

  constructor(version: number, ecc: Ecc, options: QrEncoderOptions = {}) {
    if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
      throw new RangeError(`QR version must be ${MIN_VERSION}..${MAX_VERSION}`);
    }
    const mask = options.mask ?? 'auto';
    if (mask !== 'auto' && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) throw new RangeError('mask must be 0..7');
    this.version = version;
    this.ecc = ecc;
    this.mask = mask;
    this.template = getTemplate(version);
    this.size = this.template.size;
    this.capacity = byteCapacity(version, ecc);

    const e = ECC_ORDINAL[ecc];
    this.numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][version];
    this.blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][version];
    const rawCw = Math.floor(numRawDataModules(version) / 8);
    this.numShortBlocks = this.numBlocks - (rawCw % this.numBlocks);
    this.shortBlockLen = Math.floor(rawCw / this.numBlocks);
    this.divisorLogs = reedSolomonDivisorLogs(this.blockEccLen);

    this.dataCodewords = new Uint8Array(numDataCodewords(version, ecc));
    this.rawCodewords = new Uint8Array(rawCw);
    this.bits = new Uint8Array(this.template.order.length);
    this.work = new Uint8Array(this.size * this.size);
    this.best = new Uint8Array(this.size * this.size);
    this.eccScratch = new Uint8Array(this.numBlocks * this.blockEccLen);
    this.formatByMask = new Int32Array(8);
    for (let m = 0; m < 8; m++) this.formatByMask[m] = formatBits(ecc, m);
  }

  /** Encodes `data` (≤ capacity bytes) into a new module matrix. */
  encode(data: Uint8Array): QrMatrix {
    this.buildDataCodewords(data);
    this.addEccAndInterleave();
    const { order } = this.template;
    const raw = this.rawCodewords;
    const bits = this.bits;
    const rawBits = raw.length * 8;
    for (let i = 0; i < order.length; i++) {
      bits[i] = i < rawBits ? (raw[i >>> 3] >>> (7 - (i & 7))) & 1 : 0;
    }

    if (this.mask !== 'auto') {
      this.render(this.mask, this.best);
      return { size: this.size, modules: this.best.slice(), mask: this.mask };
    }
    let bestMask = 0;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      this.render(m, this.work);
      const score = penaltyScore(this.work, this.size);
      if (score < bestScore) {
        bestScore = score;
        bestMask = m;
        this.best.set(this.work);
      }
    }
    return { size: this.size, modules: this.best.slice(), mask: bestMask };
  }

  private render(mask: number, out: Uint8Array): void {
    const { base, order, maskBits, formatPos1, formatPos2 } = this.template;
    out.set(base);
    const mb = maskBits[mask];
    const bits = this.bits;
    for (let i = 0; i < order.length; i++) out[order[i]] = bits[i] ^ mb[i];
    const fb = this.formatByMask[mask];
    for (let i = 0; i < 15; i++) {
      const bit = (fb >>> i) & 1;
      out[formatPos1[i]] = bit;
      out[formatPos2[i]] = bit;
    }
  }

  private buildDataCodewords(data: Uint8Array): void {
    if (data.length > this.capacity) {
      throw new RangeError(`payload ${data.length} B exceeds QR v${this.version}-${this.ecc} capacity ${this.capacity} B`);
    }
    const out = this.dataCodewords;
    out.fill(0);
    let bitPos = 0;
    const put = (value: number, n: number): void => {
      for (let i = n - 1; i >= 0; i--) {
        if ((value >>> i) & 1) out[bitPos >>> 3] |= 0x80 >>> (bitPos & 7);
        bitPos++;
      }
    };
    put(0b0100, 4); // byte mode
    put(data.length, this.version <= 9 ? 8 : 16);
    // The header is 12 or 20 bits long, so payload bytes always start at a nibble boundary.
    let byteIdx = bitPos >>> 3;
    for (let i = 0; i < data.length; i++) {
      out[byteIdx] |= data[i] >>> 4;
      out[byteIdx + 1] = (data[i] & 0x0f) << 4;
      byteIdx++;
    }
    bitPos += data.length * 8;
    const capacityBits = out.length * 8;
    bitPos += Math.min(4, capacityBits - bitPos); // terminator (zeros)
    bitPos = (bitPos + 7) & ~7;
    for (let i = bitPos >>> 3, pad = 0xec; i < out.length; i++, pad ^= 0xec ^ 0x11) out[i] = pad;
  }

  private addEccAndInterleave(): void {
    const data = this.dataCodewords;
    const out = this.rawCodewords;
    const { numBlocks, blockEccLen, numShortBlocks, shortBlockLen } = this;
    const shortDataLen = shortBlockLen - blockEccLen;
    const eccAll = this.eccScratch;
    const tmp = new Uint8Array(blockEccLen);
    const blockStart = new Int32Array(numBlocks);
    for (let b = 0, k = 0; b < numBlocks; b++) {
      const len = shortDataLen + (b < numShortBlocks ? 0 : 1);
      blockStart[b] = k;
      reedSolomonRemainder(data, k, len, this.divisorLogs, tmp);
      eccAll.set(tmp, b * blockEccLen);
      k += len;
    }
    let o = 0;
    // Data codewords, interleaved; long blocks have one extra codeword at the end.
    for (let i = 0; i <= shortDataLen; i++) {
      for (let b = 0; b < numBlocks; b++) {
        if (i === shortDataLen && b < numShortBlocks) continue;
        out[o++] = data[blockStart[b] + i];
      }
    }
    for (let i = 0; i < blockEccLen; i++) {
      for (let b = 0; b < numBlocks; b++) out[o++] = eccAll[b * blockEccLen + i];
    }
    if (o !== out.length) throw new Error('interleave length mismatch');
  }
}
