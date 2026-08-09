/**
 * Holographic Reduced Representations (HRR) with phase encoding.
 *
 * ## Provenance and licence
 *
 * A line-by-line port of Nous Research's Hermes holographic memory provider:
 *
 *   https://github.com/NousResearch/hermes-agent
 *   plugins/memory/holographic/holographic.py
 *   commit 7a450ca5ce4682a0b20ecc31eca04af6cbd78206
 *   MIT License — Copyright (c) 2025 Nous Research
 *
 * MIT requires the copyright notice and permission notice to be retained in
 * copies and substantial portions. The full upstream licence text is kept
 * verbatim at `backend/src/memory/HERMES-LICENSE.txt`; this header is the
 * attribution pointer to it. Do not remove either.
 *
 * ## What this is
 *
 * A vector symbolic architecture. Each concept is a vector of angles in
 * [0, 2pi). Three algebraic operations:
 *
 *   bind   — circular convolution (phase addition)    — associates two concepts
 *   unbind — circular correlation (phase subtraction)  — retrieves a bound value
 *   bundle — superposition (circular mean)             — merges concepts
 *
 * Atoms come from SHA-256, so representations are identical across processes,
 * machines and languages. That is what makes this port verifiable rather than
 * merely plausible — see `tests/unit/holographic-parity.test.ts`, which asserts
 * against vectors captured from the Python original.
 *
 * ## What it is NOT — read this before reaching for it
 *
 * **This is a bag-of-words encoder. It captures compositional structure and
 * entity roles, not meaning.** `car` and `automobile` hash to unrelated atoms
 * and are therefore orthogonal to it; so are `bug` and `defect`, `ship` and
 * `release`. It will return silence where a reader expecting semantics would
 * expect a match.
 *
 * **It complements embeddings. It does not replace them.** What it buys that
 * embeddings structurally cannot is the opposite direction: it finds links with
 * no keyword and no semantic overlap at all, because it answers questions about
 * *structural role* — "which facts have this entity in the entity slot" — via
 * algebra rather than distance. Use both; use neither alone.
 *
 * Zero model calls, zero network, no embedding model, no training. Pure
 * computation, no I/O — deliberately, so the numerical bugs (which are the only
 * kind this layer has) are testable without a store. Same argument the wire
 * codec makes in `harness/protocol.ts`.
 *
 * ## Floating point
 *
 * `encodeAtom`, `bind`, `unbind`, `snrEstimate` and the serialisation pair are
 * bit-for-bit identical to numpy: they use only integer arithmetic, IEEE
 * add/sub/mul/div/sqrt and a remainder, all of which are correctly rounded and
 * therefore reproducible across languages.
 *
 * `bundle` and `similarity` call sin/cos/atan2. Those are not specified to be
 * correctly rounded, and V8's implementations are not numpy's, so they agree to
 * within a few ulp rather than exactly. The parity test measures the divergence
 * instead of assuming it. See that file for the numbers.
 *
 * References:
 *   Plate (1995) — Holographic Reduced Representations
 *   Gayler (2004) — Vector Symbolic Architectures answer Jackendoff's challenges
 */

import { createHash } from "node:crypto";

/** The phase circle. `2 * Math.PI` is exact — a power-of-two scaling of PI. */
const TWO_PI = 2.0 * Math.PI;

/** Production dimension, and the upstream default. */
export const DEFAULT_DIM = 1024;

/** Marker prefix on float32 vector blobs. Upstream's `_FLOAT32_BLOB_PREFIX`. */
const FLOAT32_BLOB_PREFIX = new Uint8Array([0x48, 0x52, 0x52, 0x31]); // "HRR1"

/** Reserved atom standing for "the content slot" of a fact. */
export const ROLE_CONTENT = "__hrr_role_content__";
/** Reserved atom standing for "an entity slot" of a fact. */
export const ROLE_ENTITY = "__hrr_role_entity__";
/** Reserved atom returned when text tokenises to nothing. */
export const EMPTY_ATOM = "__hrr_empty__";

/**
 * Signal-to-noise below this means retrieval errors are likely. Upstream logs a
 * warning here; a pure module returns the number and lets the caller decide.
 */
export const SNR_WARN_THRESHOLD = 2.0;

/** Thrown when an argument cannot produce a meaningful vector. */
export class HolographicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HolographicError";
  }
}

/**
 * numpy's `remainder` for doubles, which is Python's `%` and NOT JavaScript's.
 *
 * JS `%` is truncated (it takes the sign of the dividend); numpy floors (it
 * takes the sign of the divisor). Getting this wrong maps every phase that
 * lands just below zero to a negative angle, which silently breaks unbind for
 * roughly half of all inputs while every vector still *looks* plausible.
 *
 * This mirrors numpy's own two-step algorithm — `fmod`, then a single
 * correction add — rather than the idiomatic `((x % b) + b) % b`. The idiomatic
 * form re-reduces after the add, so a tiny negative `x % b` that rounds up to
 * exactly `b` becomes `0` here and stays `b` in numpy. One ulp of input, a full
 * 2pi of output.
 */
function npMod(a: number, b: number): number {
  const m = a % b;
  if (m === 0) {
    // numpy returns copysign(0, b); every divisor here is +2pi.
    return 0;
  }
  if (m < 0 !== b < 0) {
    return m + b;
  }
  return m;
}

function assertDim(dim: number): void {
  if (!Number.isInteger(dim) || dim < 1) {
    throw new HolographicError(`dim must be a positive integer, got ${dim}`);
  }
}

function assertSameLength(a: Float64Array, b: Float64Array, op: string): void {
  if (a.length !== b.length) {
    throw new HolographicError(
      `${op} needs vectors of equal length, got ${a.length} and ${b.length}`,
    );
  }
}

/**
 * Deterministic phase vector for a symbol, via SHA-256 counter blocks.
 *
 * Hashing rather than a seeded RNG is what makes atoms reproducible across
 * languages: `sha256("peppi:0")` is the same 32 bytes everywhere, while every
 * language's Mersenne Twister seeding differs.
 *
 * Each digest yields 16 little-endian uint16 values, each scaled to [0, 2pi).
 * Blocks are consumed until `dim` values exist, then truncated.
 *
 * Bit-for-bit identical to the Python original: `value * (2pi / 65536)` is a
 * single correctly rounded multiply by a constant that is itself exact.
 */
export function encodeAtom(word: string, dim: number = DEFAULT_DIM): Float64Array {
  assertDim(dim);

  const VALUES_PER_BLOCK = 16;
  const scale = TWO_PI / 65536.0;
  const blocks = Math.ceil(dim / VALUES_PER_BLOCK);
  const phases = new Float64Array(dim);

  let out = 0;
  for (let block = 0; block < blocks && out < dim; block += 1) {
    const digest = createHash("sha256").update(`${word}:${block}`, "utf8").digest();
    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
    for (let i = 0; i < VALUES_PER_BLOCK && out < dim; i += 1) {
      phases[out] = view.getUint16(i * 2, /* littleEndian */ true) * scale;
      out += 1;
    }
  }

  return phases;
}

/**
 * Circular convolution — element-wise phase addition. Associates two concepts.
 *
 * The result is quasi-orthogonal to both inputs, which is the point: a bound
 * pair is a new symbol, not a blend of its parts.
 */
export function bind(a: Float64Array, b: Float64Array): Float64Array {
  assertSameLength(a, b, "bind");
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = npMod(a[i]! + b[i]!, TWO_PI);
  }
  return out;
}

/**
 * Circular correlation — element-wise phase subtraction. Retrieves a bound
 * value: `unbind(bind(a, b), a)` recovers `b` up to superposition noise.
 */
export function unbind(memory: Float64Array, key: Float64Array): Float64Array {
  assertSameLength(memory, key, "unbind");
  const out = new Float64Array(memory.length);
  for (let i = 0; i < memory.length; i += 1) {
    out[i] = npMod(memory[i]! - key[i]!, TWO_PI);
  }
  return out;
}

/**
 * Superposition — the circular mean of the inputs' unit phasors. The result is
 * similar to every input, and holds about sqrt(dim) items before similarity
 * degrades. `snrEstimate` is how you check that.
 *
 * Upstream accepts zero vectors and returns a scalar `0.0` where every caller
 * expects an array — an unreachable path in Hermes that would be a shapeless
 * crash later here. We throw instead.
 *
 * This module diverges from the original in exactly three places, all of them
 * inputs the original mishandles rather than computes: `bundle()` with no
 * vectors (scalar where an array is expected), `similarity` on empty vectors
 * (NaN, which sorts unpredictably), and `phasesToBytes` with a `dim` that
 * contradicts the vector length (a blob its own reader rejects). Every case
 * that produces a NUMBER produces the original's number.
 *
 * Antipodal inputs (`bundle(0, pi)`) cancel to the origin, where the angle is
 * undefined and the answer is decided by rounding residue. Do not read meaning
 * into that case in either implementation.
 */
export function bundle(...vectors: readonly Float64Array[]): Float64Array {
  const first = vectors[0];
  if (first === undefined) {
    throw new HolographicError("bundle needs at least one vector");
  }
  const dim = first.length;
  for (const v of vectors) {
    assertSameLength(first, v, "bundle");
  }

  // Accumulate the complex sum left to right, matching numpy's sequential
  // reduction over axis 0. exp(i*v) is (cos v, sin v) exactly: numpy computes
  // exp(real)*cos(imag), and exp(0) is exactly 1.0.
  const re = new Float64Array(dim);
  const im = new Float64Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) {
      re[i]! += Math.cos(v[i]!);
      im[i]! += Math.sin(v[i]!);
    }
  }

  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i += 1) {
    out[i] = npMod(Math.atan2(im[i]!, re[i]!), TWO_PI);
  }
  return out;
}

/**
 * numpy's pairwise summation, reproduced.
 *
 * Not decoration: over 1024 terms, naive left-to-right accumulation drifts by
 * roughly sqrt(n) more rounding error than this does, and the whole reason to
 * care is that `similarity` differences of 1e-15 are what separate two
 * candidate pairs the sweep has to rank. Matching numpy's blocking also keeps
 * this port's divergence from the original at ulp scale rather than letting it
 * accumulate.
 *
 * Mirrors `pairwise_sum_DOUBLE` in numpy's `loops.c.src`: eight accumulators
 * within a 128-element block, recursive halving above it.
 */
function pairwiseSum(values: Float64Array, start: number, n: number): number {
  const PW_BLOCKSIZE = 128;

  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i += 1) {
      res += values[start + i]!;
    }
    return res;
  }

  if (n <= PW_BLOCKSIZE) {
    const r = [
      values[start]!,
      values[start + 1]!,
      values[start + 2]!,
      values[start + 3]!,
      values[start + 4]!,
      values[start + 5]!,
      values[start + 6]!,
      values[start + 7]!,
    ];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let k = 0; k < 8; k += 1) {
        r[k]! += values[start + i + k]!;
      }
    }
    // Association matters and must not be "simplified": numpy folds the eight
    // accumulators as ((r0+r1)+(r2+r3)) + ((r4+r5)+(r6+r7)).
    const lo = r[0]! + r[1]! + (r[2]! + r[3]!);
    const hi = r[4]! + r[5]! + (r[6]! + r[7]!);
    let res = lo + hi;
    for (; i < n; i += 1) {
      res += values[start + i]!;
    }
    return res;
  }

  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(values, start, n2) + pairwiseSum(values, start + n2, n - n2);
}

/**
 * Phase cosine similarity in [-1, 1]. 1 for identical vectors, near 0 for
 * unrelated ones, -1 for anti-correlated ones.
 *
 * Upstream returns NaN on empty input (numpy's mean of nothing). We throw:
 * a NaN score sorts unpredictably and would quietly bury or float a candidate.
 */
export function similarity(a: Float64Array, b: Float64Array): number {
  assertSameLength(a, b, "similarity");
  if (a.length === 0) {
    throw new HolographicError("similarity needs a non-empty vector");
  }
  const cosines = new Float64Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    cosines[i] = Math.cos(a[i]! - b[i]!);
  }
  return pairwiseSum(cosines, 0, cosines.length) / cosines.length;
}

/**
 * Python's `str.split()` with no argument: split on runs of whitespace,
 * discarding leading and trailing empties.
 *
 * The character class is Python's, not JavaScript's. They differ in both
 * directions — Python treats U+001C..U+001F and U+0085 as whitespace and
 * JavaScript does not; JavaScript treats U+FEFF as whitespace and Python does
 * not. Five codepoints nobody thinks about, and each one silently changes the
 * token set and therefore the vector.
 */
const PYTHON_WHITESPACE =
  /[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** The characters `encode_text` strips from both ends of a token. */
const STRIP_CHARS = new Set([...".,!?;:\"'()[]{}"]);

function stripPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && STRIP_CHARS.has(token[start]!)) start += 1;
  while (end > start && STRIP_CHARS.has(token[end - 1]!)) end -= 1;
  return token.slice(start, end);
}

/**
 * Tokenise exactly as `encode_text` does: lowercase, split on Python
 * whitespace, strip surrounding punctuation, drop what is left empty.
 *
 * Exported because the sweep needs to explain *why* a candidate scored the way
 * it did, and "these were the tokens" is most of that explanation.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(PYTHON_WHITESPACE)
    .map(stripPunctuation)
    .filter((t) => t.length > 0);
}

/**
 * Bag-of-words encoding: the bundle of one atom per token.
 *
 * Bag-of-words is the honest description and the honest limitation. Word order
 * is discarded, so "the deploy broke the backend" and "the backend broke the
 * deploy" encode identically. Synonyms are unrelated atoms.
 *
 * Text that tokenises to nothing returns the reserved `__hrr_empty__` atom, so
 * empty facts are all mutually identical rather than randomly scattered.
 */
export function encodeText(text: string, dim: number = DEFAULT_DIM): Float64Array {
  assertDim(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return encodeAtom(EMPTY_ATOM, dim);
  }
  return bundle(...tokens.map((t) => encodeAtom(t, dim)));
}

/**
 * Structured encoding of a fact: its content bound to the content role, each
 * entity bound to the entity role, everything bundled.
 *
 * This is what makes role queries possible —
 * `unbind(fact, bind(entity, ROLE_ENTITY))` approximates the content vector
 * only when that entity really occupies an entity slot.
 *
 * Entities are lowercased; content is lowercased downstream by `encodeText`.
 * Duplicate entities are bundled twice, which strengthens them — upstream
 * behaviour, preserved deliberately so callers dedupe if they mean to.
 */
export function encodeFact(
  content: string,
  entities: readonly string[],
  dim: number = DEFAULT_DIM,
): Float64Array {
  assertDim(dim);
  const roleContent = encodeAtom(ROLE_CONTENT, dim);
  const roleEntity = encodeAtom(ROLE_ENTITY, dim);

  const components: Float64Array[] = [bind(encodeText(content, dim), roleContent)];
  for (const entity of entities) {
    components.push(bind(encodeAtom(entity.toLowerCase(), dim), roleEntity));
  }
  return bundle(...components);
}

/**
 * Serialise a phase vector for storage: `"HRR1"` then little-endian float32.
 *
 * float32 halves the blob and keeps ample precision for phase similarity — a
 * phase is only meaningful to about 1e-7 radians here anyway.
 *
 * At dim 1 the prefixed float32 blob and a raw float64 blob are both 8 bytes,
 * so the format would be undecidable; upstream writes raw float64 in that case
 * and this does too.
 *
 * Byte order is little-endian, matching numpy's native `tobytes()` on every
 * platform either implementation runs on. A big-endian producer would write
 * blobs neither side can read; that assumption is upstream's and is inherited.
 *
 * `dim` selects the FORMAT, it does not select how many elements are written —
 * upstream always serialises the whole array and uses `dim` purely for the
 * collision check above. Passing a `dim` that disagrees with the vector's own
 * length is therefore meaningless, and upstream silently writes a blob that its
 * own reader then rejects. We throw at write time instead, where the caller can
 * still see which vector was wrong.
 */
export function phasesToBytes(phases: Float64Array, dim?: number): Uint8Array {
  if (dim !== undefined && dim !== phases.length) {
    throw new HolographicError(
      `phasesToBytes got dim=${dim} for a ${phases.length}-element vector; ` +
        "dim selects the blob format and must match the vector's own length",
    );
  }
  const n = phases.length;
  const float32BlobBytes = FLOAT32_BLOB_PREFIX.length + n * 4;
  const float64Bytes = n * 8;

  if (float32BlobBytes === float64Bytes) {
    const out = new Uint8Array(float64Bytes);
    const view = new DataView(out.buffer);
    for (let i = 0; i < n; i += 1) {
      view.setFloat64(i * 8, phases[i]!, true);
    }
    return out;
  }

  const out = new Uint8Array(float32BlobBytes);
  out.set(FLOAT32_BLOB_PREFIX, 0);
  const view = new DataView(out.buffer, FLOAT32_BLOB_PREFIX.length);
  for (let i = 0; i < n; i += 1) {
    view.setFloat32(i * 4, phases[i]!, true);
  }
  return out;
}

function hasFloat32Prefix(data: Uint8Array): boolean {
  if (data.length < FLOAT32_BLOB_PREFIX.length) return false;
  for (let i = 0; i < FLOAT32_BLOB_PREFIX.length; i += 1) {
    if (data[i] !== FLOAT32_BLOB_PREFIX[i]) return false;
  }
  return true;
}

function readFloat32Payload(data: Uint8Array): Float64Array {
  const payloadBytes = data.length - FLOAT32_BLOB_PREFIX.length;
  if (payloadBytes % 4 !== 0) {
    throw new HolographicError(
      `HRR float32 vector blob has invalid payload byte length: ${payloadBytes}`,
    );
  }
  const n = payloadBytes / 4;
  const view = new DataView(data.buffer, data.byteOffset + FLOAT32_BLOB_PREFIX.length, payloadBytes);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function readFloat64(data: Uint8Array): Float64Array {
  if (data.length % 8 !== 0) {
    throw new HolographicError(`HRR legacy vector blob has invalid byte length: ${data.length}`);
  }
  const n = data.length / 8;
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = view.getFloat64(i * 8, true);
  }
  return out;
}

/**
 * Deserialise a phase vector, accepting both the prefixed float32 format and
 * the legacy raw-float64 one. Values are widened back to float64 so downstream
 * algebra keeps float64 behaviour.
 *
 * Passing `dim` is what lets a malformed blob be rejected instead of silently
 * decoding to a vector of the wrong length — which would then score against
 * everything and rank as noise rather than as an error.
 */
export function bytesToPhases(data: Uint8Array, dim?: number): Float64Array {
  if (dim !== undefined) {
    assertDim(dim);
    const float32BlobBytes = FLOAT32_BLOB_PREFIX.length + dim * 4;
    const float64Bytes = dim * 8;

    if (float32BlobBytes === float64Bytes) {
      // dim === 1. `phasesToBytes` never writes a prefixed blob here, so an
      // 8-byte blob is legacy float64 even if it opens with "HRR1".
      if (data.length === float64Bytes) return readFloat64(data);
      throw new HolographicError(
        `HRR legacy vector blob has ${data.length} bytes; expected ${float64Bytes} (float64) for dim=${dim}`,
      );
    }

    if (hasFloat32Prefix(data) && data.length === float32BlobBytes) {
      return readFloat32Payload(data);
    }
    if (data.length === float64Bytes) return readFloat64(data);
    if (hasFloat32Prefix(data)) {
      const payloadLen = data.length - FLOAT32_BLOB_PREFIX.length;
      throw new HolographicError(
        `HRR vector blob has ${data.length} bytes (${payloadLen} payload bytes after the float32 prefix); ` +
          `expected ${float32BlobBytes} (prefixed float32) or ${float64Bytes} (legacy float64) for dim=${dim}`,
      );
    }
    throw new HolographicError(
      `HRR legacy vector blob has ${data.length} bytes; expected ${float64Bytes} (float64) for dim=${dim}`,
    );
  }

  if (hasFloat32Prefix(data)) return readFloat32Payload(data);
  return readFloat64(data);
}

/**
 * Signal-to-noise estimate for a bundle: `sqrt(dim / nItems)`, infinite when
 * nothing is stored.
 *
 * Below `SNR_WARN_THRESHOLD` (which is `nItems > dim / 4`) retrieval errors
 * become likely — the bundle is past capacity and unbinding returns noise that
 * still looks like a vector. Callers that bundle unbounded sets must check this
 * or they will read confident nonsense.
 *
 * Bit-for-bit identical to the original: division and sqrt are both correctly
 * rounded by IEEE-754.
 */
export function snrEstimate(dim: number, nItems: number): number {
  if (nItems <= 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(dim / nItems);
}
