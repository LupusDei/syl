/**
 * Behaviour of the HRR algebra, independent of the Python reference.
 *
 * `holographic-parity.test.ts` proves this module computes the same numbers as
 * the original. This file proves the numbers mean what the module says they
 * mean — the algebraic laws, the error paths, and the documented limitations.
 * Parity alone would happily certify a faithful port of something useless.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIM,
  EMPTY_ATOM,
  HolographicError,
  ROLE_CONTENT,
  ROLE_ENTITY,
  SNR_WARN_THRESHOLD,
  bind,
  bundle,
  bytesToPhases,
  encodeAtom,
  encodeFact,
  encodeText,
  phasesToBytes,
  similarity,
  snrEstimate,
  tokenize,
  unbind,
} from "../../src/memory/holographic.js";

const TWO_PI = 2 * Math.PI;

/** Every phase must live in [0, 2pi); an escapee breaks unbind silently. */
function expectValidPhases(v: Float64Array): void {
  for (const p of v) {
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(TWO_PI);
  }
}

describe("encodeAtom", () => {
  it("should return a vector of the requested length with every phase in [0, 2pi)", () => {
    const v = encodeAtom("commander", 64);
    expect(v).toHaveLength(64);
    expectValidPhases(v);
  });

  it("should be deterministic — the same word always gives the same vector", () => {
    expect(Array.from(encodeAtom("peppi", 32))).toEqual(Array.from(encodeAtom("peppi", 32)));
  });

  it("should give quasi-orthogonal vectors to different words", () => {
    // The property the whole scheme rests on: unrelated symbols must not look
    // related, or every score is a coin flip.
    expect(Math.abs(similarity(encodeAtom("peppi"), encodeAtom("backend")))).toBeLessThan(0.1);
  });

  it("should be a PREFIX-stable truncation, so a smaller dim is the same vector cut short", () => {
    // Blocks are consumed in counter order, so dim only truncates. Worth
    // pinning: if it ever stopped holding, vectors stored at one dim would
    // silently stop comparing against vectors computed at another.
    const wide = encodeAtom("commander", 64);
    const narrow = encodeAtom("commander", 17);
    expect(Array.from(narrow)).toEqual(Array.from(wide).slice(0, 17));
  });

  it("should handle a dim that is not a multiple of the 16-value block size", () => {
    expect(encodeAtom("x", 17)).toHaveLength(17);
    expect(encodeAtom("x", 1)).toHaveLength(1);
  });

  it("should distinguish the empty string from other words rather than degenerating", () => {
    expect(Math.abs(similarity(encodeAtom("", 256), encodeAtom("a", 256)))).toBeLessThan(0.2);
    expectValidPhases(encodeAtom("", 256));
  });

  it("should not collide across the counter-block delimiter", () => {
    // Atoms are hashed as `${word}:${block}`. If "word" block 1 and "word:0"
    // block 0 produced the same digest input the two symbols would share half
    // their vector. They must not.
    expect(Math.abs(similarity(encodeAtom("word", 256), encodeAtom("word:0", 256)))).toBeLessThan(
      0.2,
    );
  });

  it("should throw on a dim that cannot produce a meaningful vector", () => {
    expect(() => encodeAtom("x", 0)).toThrow(HolographicError);
    expect(() => encodeAtom("x", -1)).toThrow(HolographicError);
    expect(() => encodeAtom("x", 1.5)).toThrow(/positive integer/);
  });

  it("should default to the production dimension", () => {
    expect(encodeAtom("x")).toHaveLength(DEFAULT_DIM);
  });
});

describe("bind", () => {
  it("should produce a vector dissimilar to both of its inputs", () => {
    const a = encodeAtom("peppi", 1024);
    const b = encodeAtom(ROLE_ENTITY, 1024);
    const bound = bind(a, b);
    expect(Math.abs(similarity(bound, a))).toBeLessThan(0.1);
    expect(Math.abs(similarity(bound, b))).toBeLessThan(0.1);
    expectValidPhases(bound);
  });

  it("should be commutative, because phase addition is", () => {
    const a = encodeAtom("a", 64);
    const b = encodeAtom("b", 64);
    expect(Array.from(bind(a, b))).toEqual(Array.from(bind(b, a)));
  });

  it("should be inverted exactly by unbind with the same key", () => {
    const a = encodeAtom("peppi", 256);
    const b = encodeAtom("backend", 256);
    expect(similarity(unbind(bind(a, b), b), a)).toBeCloseTo(1, 12);
  });

  it("should throw on mismatched lengths instead of silently truncating", () => {
    expect(() => bind(encodeAtom("a", 8), encodeAtom("b", 16))).toThrow(HolographicError);
    expect(() => bind(encodeAtom("a", 8), encodeAtom("b", 16))).toThrow(/equal length/);
  });

  it("should keep every result inside [0, 2pi) even when the sum wraps", () => {
    // The case that catches JavaScript's truncated `%`: a phase just below zero
    // must wrap UP to just below 2pi, not stay negative.
    const near = new Float64Array([TWO_PI - 1e-9, 0.1]);
    const delta = new Float64Array([0.5, 0]);
    expectValidPhases(bind(near, delta));
    expect(bind(near, delta)[0]).toBeLessThan(1);
  });
});

describe("unbind", () => {
  it("should recover the bound value from a two-item binding", () => {
    const key = encodeAtom("k", 128);
    const value = encodeAtom("v", 128);
    expect(similarity(unbind(bind(key, value), key), value)).toBeCloseTo(1, 12);
  });

  it("should return a phase in range when the difference goes negative", () => {
    const small = new Float64Array([0.1, 0.0]);
    const large = new Float64Array([1.0, 3.0]);
    const out = unbind(small, large);
    expectValidPhases(out);
    expect(out[0]).toBeGreaterThan(5);
  });

  it("should throw on mismatched lengths", () => {
    expect(() => unbind(encodeAtom("a", 8), encodeAtom("b", 9))).toThrow(HolographicError);
  });

  it("should give noise, not a match, when unbound with the wrong key", () => {
    const bound = bind(encodeAtom("k", 1024), encodeAtom("v", 1024));
    const wrong = unbind(bound, encodeAtom("other", 1024));
    expect(Math.abs(similarity(wrong, encodeAtom("v", 1024)))).toBeLessThan(0.1);
  });
});

describe("bundle", () => {
  it("should produce a vector similar to each of its inputs", () => {
    const a = encodeAtom("a", 1024);
    const b = encodeAtom("b", 1024);
    const merged = bundle(a, b);
    expect(similarity(merged, a)).toBeGreaterThan(0.5);
    expect(similarity(merged, b)).toBeGreaterThan(0.5);
    expectValidPhases(merged);
  });

  it("should return the input unchanged for a single vector", () => {
    const a = encodeAtom("solo", 64);
    expect(similarity(bundle(a), a)).toBeCloseTo(1, 12);
  });

  it("should lose similarity as more items are added — the capacity limit", () => {
    // Stated as a test because it is the failure people meet in production:
    // bundle enough and every query matches everything, weakly.
    const items = Array.from({ length: 40 }, (_, i) => encodeAtom(`item-${i}`, 1024));
    const few = similarity(bundle(items[0]!, items[1]!), items[0]!);
    const many = similarity(bundle(...items), items[0]!);
    expect(many).toBeLessThan(few);
  });

  it("should throw rather than return a scalar when given no vectors", () => {
    // Upstream returns numpy's `0.0` here, where every caller expects an array.
    expect(() => bundle()).toThrow(HolographicError);
    expect(() => bundle()).toThrow(/at least one vector/);
  });

  it("should throw on mismatched lengths", () => {
    expect(() => bundle(encodeAtom("a", 8), encodeAtom("b", 16))).toThrow(HolographicError);
  });

  it("should still return valid phases when inputs cancel to the origin", () => {
    // exp(i0) + exp(i*pi) sums to zero, where the angle is undefined. It must
    // not produce NaN, and no caller should read meaning into the value.
    const out = bundle(new Float64Array(8), new Float64Array(8).fill(Math.PI));
    expectValidPhases(out);
  });
});

describe("similarity", () => {
  it("should be 1 for a vector against itself", () => {
    expect(similarity(encodeAtom("x", 512), encodeAtom("x", 512))).toBeCloseTo(1, 15);
  });

  it("should be near 0 for unrelated vectors", () => {
    expect(Math.abs(similarity(encodeAtom("alpha", 1024), encodeAtom("omega", 1024)))).toBeLessThan(
      0.1,
    );
  });

  it("should be -1 for exactly anti-correlated vectors", () => {
    const a = new Float64Array(16);
    const b = new Float64Array(16).fill(Math.PI);
    expect(similarity(a, b)).toBeCloseTo(-1, 15);
  });

  it("should be symmetric, because cosine is even", () => {
    const a = encodeAtom("a", 256);
    const b = encodeAtom("b", 256);
    expect(similarity(a, b)).toBe(similarity(b, a));
  });

  it("should throw on mismatched lengths rather than comparing a prefix", () => {
    expect(() => similarity(encodeAtom("a", 8), encodeAtom("b", 9))).toThrow(HolographicError);
  });

  it("should throw on empty vectors rather than returning NaN", () => {
    // Upstream returns numpy's NaN. A NaN score sorts unpredictably, so it
    // could bury or float a candidate with no error anywhere.
    expect(() => similarity(new Float64Array(0), new Float64Array(0))).toThrow(HolographicError);
  });
});

describe("tokenize", () => {
  it("should lowercase, split on whitespace and strip surrounding punctuation", () => {
    expect(tokenize("Peppi runs the BACKEND.")).toEqual(["peppi", "runs", "the", "backend"]);
    expect(tokenize("(hello) [world]! {ok}?")).toEqual(["hello", "world", "ok"]);
  });

  it("should return nothing for empty or punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("...")).toEqual([]);
  });

  it("should treat Python's whitespace as whitespace and U+FEFF as a character", () => {
    // The five codepoints where JavaScript's \s and Python's str.split()
    // disagree. Getting these wrong changes the token set, and therefore the
    // vector, for text nobody would think to test.
    expect(tokenize("a\u001cb\u001dc\u0085d")).toEqual(["a", "b", "c", "d"]);
    // U+FEFF is whitespace to JavaScript and a character to Python, so it must
    // stay attached to its token.
    expect(tokenize("\ufeffbom")).toEqual(["\ufeffbom"]);
  });

  it("should keep internal punctuation, stripping only the ends", () => {
    expect(tokenize("well-known e.g. a.b.c")).toEqual(["well-known", "e.g", "a.b.c"]);
  });
});

describe("encodeText", () => {
  it("should encode a bag of words, similar to each of its own tokens", () => {
    const v = encodeText("deployment rollback", 1024);
    expect(similarity(v, encodeAtom("deployment", 1024))).toBeGreaterThan(0.4);
    expect(similarity(v, encodeAtom("rollback", 1024))).toBeGreaterThan(0.4);
  });

  it("should be BLIND to synonyms — the limitation, asserted so it is not forgotten", () => {
    // If this ever starts failing, someone has replaced the encoder with
    // something semantic and the module's documentation is now wrong.
    const car = encodeText("car", 1024);
    expect(Math.abs(similarity(car, encodeText("automobile", 1024)))).toBeLessThan(0.1);
  });

  it("should map anything that tokenises to nothing onto the reserved empty atom", () => {
    const empty = encodeAtom(EMPTY_ATOM, 64);
    expect(Array.from(encodeText("", 64))).toEqual(Array.from(empty));
    expect(Array.from(encodeText("   ", 64))).toEqual(Array.from(empty));
    expect(Array.from(encodeText("!!!", 64))).toEqual(Array.from(empty));
  });

  it("should throw on an invalid dim", () => {
    expect(() => encodeText("x", 0)).toThrow(HolographicError);
  });
});

describe("encodeFact", () => {
  it("should produce valid phases and depend on both content and entities", () => {
    const base = encodeFact("the backend restarted", ["backend"], 1024);
    expectValidPhases(base);
    expect(similarity(base, encodeFact("the backend restarted", ["peppi"], 1024))).toBeLessThan(
      0.999,
    );
    expect(similarity(base, encodeFact("something else entirely", ["backend"], 1024))).toBeLessThan(
      0.999,
    );
  });

  it("should be case-insensitive in entity names", () => {
    const lower = encodeFact("x", ["peppi"], 128);
    const upper = encodeFact("x", ["PEPPI"], 128);
    expect(Array.from(upper)).toEqual(Array.from(lower));
  });

  it("should accept a fact with no entities", () => {
    expectValidPhases(encodeFact("no entities here", [], 128));
  });

  it("should accept an empty content string", () => {
    expectValidPhases(encodeFact("", ["solo"], 128));
  });

  it("should reuse the reserved role atoms, so role queries can be constructed", () => {
    // Sanity on the contract the query kernels depend on: the roles are the
    // exported constants, not private strings.
    expect(ROLE_CONTENT).toBe("__hrr_role_content__");
    expect(ROLE_ENTITY).toBe("__hrr_role_entity__");
    expect(Math.abs(similarity(encodeAtom(ROLE_CONTENT), encodeAtom(ROLE_ENTITY)))).toBeLessThan(
      0.1,
    );
  });

  it("should throw on an invalid dim", () => {
    expect(() => encodeFact("x", [], -3)).toThrow(HolographicError);
  });
});

describe("phasesToBytes / bytesToPhases", () => {
  it("should round-trip a vector to float32 precision with the HRR1 prefix", () => {
    const phases = encodeAtom("round-trip", 64);
    const blob = phasesToBytes(phases, 64);
    expect(blob).toHaveLength(4 + 64 * 4);
    expect(Buffer.from(blob.subarray(0, 4)).toString("ascii")).toBe("HRR1");

    const back = bytesToPhases(blob, 64);
    expect(back).toHaveLength(64);
    for (let i = 0; i < 64; i += 1) {
      expect(Math.abs(back[i]! - phases[i]!)).toBeLessThan(1e-6);
    }
  });

  it("should write raw float64 at dim 1, where the two formats would be ambiguous", () => {
    const blob = phasesToBytes(encodeAtom("one", 1), 1);
    expect(blob).toHaveLength(8);
    expect(Buffer.from(blob.subarray(0, 4)).toString("ascii")).not.toBe("HRR1");
    expect(bytesToPhases(blob, 1)).toHaveLength(1);
  });

  it("should still read a legacy raw-float64 blob", () => {
    const phases = encodeAtom("legacy", 8);
    const legacy = new Uint8Array(8 * 8);
    const view = new DataView(legacy.buffer);
    for (let i = 0; i < 8; i += 1) view.setFloat64(i * 8, phases[i]!, true);
    expect(Array.from(bytesToPhases(legacy, 8))).toEqual(Array.from(phases));
  });

  it("should default the length to the vector's own when dim is omitted", () => {
    const blob = phasesToBytes(encodeAtom("implicit", 32));
    expect(bytesToPhases(blob)).toHaveLength(32);
  });

  it("should reject a dim that contradicts the vector's own length", () => {
    // `dim` picks the blob FORMAT; it is not an element count. Upstream ignores
    // the disagreement and writes a blob its own reader then refuses, so the
    // corruption only surfaces at read time, one layer away from the bug.
    expect(() => phasesToBytes(encodeAtom("x", 8), 16)).toThrow(HolographicError);
    expect(() => phasesToBytes(encodeAtom("x", 8), 16)).toThrow(/selects the blob format/);
    expect(() => phasesToBytes(encodeAtom("x", 8), 4)).toThrow(HolographicError);
  });

  it("should reject a blob whose length disagrees with the requested dim", () => {
    // Without this the blob would decode to a vector of the wrong length and
    // then score against everything as noise — an error that looks like a
    // result.
    const blob = phasesToBytes(encodeAtom("x", 8), 8);
    expect(() => bytesToPhases(blob, 16)).toThrow(HolographicError);
    expect(() => bytesToPhases(blob, 16)).toThrow(/bytes/);
  });

  it("should reject a truncated float32 payload", () => {
    const blob = phasesToBytes(encodeAtom("x", 8), 8);
    expect(() => bytesToPhases(blob.subarray(0, blob.length - 2))).toThrow(HolographicError);
  });

  it("should reject a prefixless blob that is not a whole number of float64s", () => {
    expect(() => bytesToPhases(new Uint8Array(7))).toThrow(/invalid byte length/);
  });

  it("should reject an 8-byte blob at dim 1 that is the wrong size", () => {
    expect(() => bytesToPhases(new Uint8Array(12), 1)).toThrow(HolographicError);
  });
});

describe("snrEstimate", () => {
  it("should be sqrt(dim / nItems)", () => {
    expect(snrEstimate(1024, 4)).toBe(16);
    expect(snrEstimate(1024, 256)).toBe(2);
  });

  it("should be infinite when nothing is stored", () => {
    expect(snrEstimate(1024, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(snrEstimate(1024, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("should cross the warning threshold exactly at nItems > dim / 4", () => {
    expect(snrEstimate(1024, 256)).toBe(SNR_WARN_THRESHOLD);
    expect(snrEstimate(1024, 257)).toBeLessThan(SNR_WARN_THRESHOLD);
  });
});
