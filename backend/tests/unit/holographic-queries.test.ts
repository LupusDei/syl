/**
 * The four query kernels: parity against the Python reference, then behaviour.
 *
 * The parity half uses the same fixture as `holographic-parity.test.ts` — a
 * five-fact corpus encoded by the real `holographic.py`, with `related`,
 * `probe`, `reason` and `contradict` scored by loops transcribed from the same
 * commit's `retrieval.py` with the SQL removed. The stored fact vectors are
 * Python's own bytes, so a mismatch here is this file's scoring, not inherited
 * encoder noise.
 *
 * The behaviour half asserts the properties the sweep actually depends on —
 * chiefly that `related` finds a link with NO shared keyword, which is the
 * entire reason this engine exists, and that the encoder is blind to synonyms,
 * which is the limitation that must never be forgotten.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HolographicError,
  encodeAtom,
  encodeFact,
  similarity,
} from "../../src/memory/holographic.js";
import {
  type HoloFact,
  contradict,
  encodeHoloFact,
  probe,
  reason,
  related,
} from "../../src/memory/holographic-queries.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "hrr-python.json"), "utf8"),
) as {
  corpus: { id: string; content: string; entities: string[]; trust: string; vector: string }[];
  related: { entity: string; results: { id: string; score: string }[] }[];
  probe: { entity: string; results: { id: string; score: string }[] }[];
  reason: { entities: string[]; results: { id: string; score: string }[] }[];
  contradict: {
    threshold: string;
    results: {
      a: string;
      b: string;
      entity_overlap: string;
      content_similarity: string;
      contradiction_score: string;
      shared_entities: string[];
    }[];
  }[];
};

function decodeVector(b64: string): Float64Array {
  const bytes = Buffer.from(b64, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(bytes.byteLength / 8);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat64(i * 8, false);
  return out;
}

function decodeScalar(hex: string): number {
  const bytes = Buffer.from(hex, "hex");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, false);
}

/**
 * The corpus with PYTHON's vectors, not ours. Deliberate: it isolates the
 * scoring loops under test from the encoder, which has its own parity file.
 */
const corpus: HoloFact[] = fixture.corpus.map((f) => ({
  id: f.id,
  content: f.content,
  entities: f.entities,
  trust: decodeScalar(f.trust),
  vector: decodeVector(f.vector),
}));

/** Two decades above the measured worst case, as in the encoder parity file. */
const SCORE_TOLERANCE = 1e-15;

describe("holographic query kernels — parity with retrieval.py", () => {
  it("should reproduce related() ranking and scores", () => {
    expect(fixture.related.length).toBeGreaterThan(0);
    for (const c of fixture.related) {
      const actual = related(corpus, c.entity, { limit: corpus.length });
      expect(
        actual.map((r) => r.id),
        `related(${c.entity}) order`,
      ).toEqual(c.results.map((r) => r.id));
      actual.forEach((r, i) => {
        expect(Math.abs(r.score - decodeScalar(c.results[i]!.score))).toBeLessThan(SCORE_TOLERANCE);
      });
    }
  });

  it("should reproduce probe() ranking and scores", () => {
    for (const c of fixture.probe) {
      const actual = probe(corpus, c.entity, { limit: corpus.length });
      expect(actual.map((r) => r.id), `probe(${c.entity}) order`).toEqual(
        c.results.map((r) => r.id),
      );
      actual.forEach((r, i) => {
        expect(Math.abs(r.score - decodeScalar(c.results[i]!.score))).toBeLessThan(SCORE_TOLERANCE);
      });
    }
  });

  it("should reproduce reason() ranking and scores, including the multi-entity conjunction", () => {
    const multi = fixture.reason.filter((c) => c.entities.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const c of fixture.reason) {
      const actual = reason(corpus, c.entities, { limit: corpus.length });
      expect(actual.map((r) => r.id), `reason(${c.entities.join("+")}) order`).toEqual(
        c.results.map((r) => r.id),
      );
      actual.forEach((r, i) => {
        expect(Math.abs(r.score - decodeScalar(c.results[i]!.score))).toBeLessThan(SCORE_TOLERANCE);
      });
    }
  });

  it("should reproduce contradict() pairs, rounded fields and order EXACTLY", () => {
    // The rounded fields are compared with `toBe`, not a tolerance: Python's
    // round is half-to-even on the exact decimal, and this port reimplements
    // that rather than approximating it. If the reimplementation is right the
    // values are identical doubles; a tolerance here would hide it being wrong.
    for (const c of fixture.contradict) {
      const threshold = decodeScalar(c.threshold);
      const actual = contradict(corpus, { threshold, limit: corpus.length ** 2 });
      expect(actual.length, `contradict(threshold=${threshold}) count`).toBe(c.results.length);
      actual.forEach((got, i) => {
        const want = c.results[i]!;
        expect(got.a).toBe(want.a);
        expect(got.b).toBe(want.b);
        expect(got.sharedEntities).toEqual(want.shared_entities);
        expect(got.entityOverlap).toBe(decodeScalar(want.entity_overlap));
        expect(got.contradictionScore).toBe(decodeScalar(want.contradiction_score));
        expect(Math.abs(got.contentSimilarity - decodeScalar(want.content_similarity))).toBeLessThan(
          1e-3,
        );
      });
    }
  });

  it("should score identically whether vectors come from Python or from this port", () => {
    // Closes the loop: the fixture proves our encoder matches Python's, and
    // this proves the kernels do not care which of the two produced the input.
    const ours = fixture.corpus.map((f) => encodeHoloFact({
      id: f.id,
      content: f.content,
      entities: f.entities,
      trust: decodeScalar(f.trust),
    }));
    const a = related(corpus, "Peppi", { limit: 5 });
    const b = related(ours, "Peppi", { limit: 5 });
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
    b.forEach((r, i) => expect(Math.abs(r.score - a[i]!.score)).toBeLessThan(1e-12));
  });
});

describe("holographic query kernels — behaviour", () => {
  /**
   * The property the whole engine exists for, stated as a test.
   *
   * These two facts share no content word at all: "Ada" appears in neither
   * content string, "octopus"/"kettle" and "trombone"/"glacier" have no token,
   * stem or synonym in common, and an embedding would place them nowhere near
   * each other. The only thing joining them is that the same entity occupies an
   * entity slot in both — pure structure. That is the link vector search
   * cannot produce and this engine can.
   */
  const structural: HoloFact[] = [
    encodeHoloFact({ id: "s1", content: "octopus kettle", entities: ["Ada"], trust: 1 }),
    encodeHoloFact({ id: "s2", content: "trombone glacier", entities: ["Ada"], trust: 1 }),
    encodeHoloFact({ id: "s3", content: "harpsichord meadow", entities: ["Grace"], trust: 1 }),
  ];

  it("should link facts with NO keyword and NO semantic overlap, via shared structure", () => {
    const ranked = related(structural, "Ada", { limit: 3 });
    expect(ranked.slice(0, 2).map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    expect(ranked[2]!.id).toBe("s3");
    // And the gap is real, not a rounding artefact of an arbitrary ordering.
    expect(ranked[1]!.score - ranked[2]!.score).toBeGreaterThan(0.05);
  });

  it("should be BLIND to synonyms, because it is a bag-of-words encoder", () => {
    // Documented limitation, asserted so nobody "fixes" the docs by deleting
    // the caveat. `car` and `automobile` are unrelated atoms; anyone who needs
    // this link needs an embedding, and this test is where they will find out.
    const cars: HoloFact[] = [
      encodeHoloFact({ id: "c1", content: "the car is red", entities: ["garage"], trust: 1 }),
      encodeHoloFact({ id: "c2", content: "the automobile is red", entities: ["garage"], trust: 1 }),
    ];
    const byCar = related(cars, "car", { limit: 2 });
    const carScore = byCar.find((r) => r.id === "c1")!.score;
    const autoScore = byCar.find((r) => r.id === "c2")!.score;
    expect(carScore).toBeGreaterThan(autoScore);
    // "automobile" scores at the noise floor — the encoder sees no relation.
    expect(Math.abs(autoScore - 0.5)).toBeLessThan(0.05);
  });

  it("should treat word order as irrelevant, the other half of bag-of-words", () => {
    // Same token multiset, opposite order. The vectors are equal to within
    // summation-order rounding (measured 1.8e-15 radians) — NOT bit-identical,
    // because floating-point addition is not associative and `bundle` sums the
    // phasors in token order. Asserting exact equality here is the mistake that
    // teaches the next person to reach for a tolerance everywhere else too.
    const forward = encodeFact("the deploy broke the backend", [], 256);
    const reversed = encodeFact("the backend broke the deploy", [], 256);
    let worst = 0;
    for (let i = 0; i < forward.length; i += 1) {
      worst = Math.max(worst, Math.abs(forward[i]! - reversed[i]!));
    }
    expect(worst).toBeLessThan(1e-13);
    expect(similarity(forward, reversed)).toBeCloseTo(1, 12);
  });

  describe("related", () => {
    it("should return every fact scored, capped at the limit, sorted descending", () => {
      const ranked = related(structural, "Ada", { limit: 2 });
      expect(ranked).toHaveLength(2);
      expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
    });

    it("should score an unknown entity at the noise floor for every fact", () => {
      const ranked = related(structural, "nobody-has-heard-of-this", { limit: 3 });
      for (const r of ranked) expect(Math.abs(r.score - 0.5)).toBeLessThan(0.05);
    });

    it("should throw when a fact vector does not match the requested dim", () => {
      const mismatched: HoloFact[] = [
        { id: "x", content: "x", entities: [], trust: 1, vector: encodeAtom("x", 64) },
      ];
      expect(() => related(mismatched, "x", { dim: 1024 })).toThrow(HolographicError);
      expect(() => related(mismatched, "x", { dim: 1024 })).toThrow(/64-dimensional/);
    });

    it("should return an empty list for an empty corpus rather than throwing", () => {
      expect(related([], "Ada")).toEqual([]);
    });

    it("should be case-insensitive in the entity name", () => {
      const lower = related(structural, "ada", { limit: 3 });
      const upper = related(structural, "ADA", { limit: 3 });
      expect(upper).toEqual(lower);
    });
  });

  describe("reason", () => {
    const joint: HoloFact[] = [
      encodeHoloFact({ id: "j1", content: "both", entities: ["Ada", "Grace"], trust: 1 }),
      encodeHoloFact({ id: "j2", content: "only ada", entities: ["Ada"], trust: 1 }),
      encodeHoloFact({ id: "j3", content: "only grace", entities: ["Grace"], trust: 1 }),
    ];

    /**
     * RED, declared in `tests/expected-failures.json` against syl-b97.
     *
     * This describes what `reason` is FOR — upstream calls it "compositional
     * reasoning that no embedding DB can do" — and it does not work, in this
     * port or in the Python original, which was verified digit-for-digit on
     * this exact corpus. Every fact scores 0.489-0.491; the spread is 0.002,
     * which is the noise floor.
     *
     * `related` on the same data separates by 0.30, so this is not a property
     * of the encoder, it is specific to the kernels that try to recover a
     * composed vector back out of a circular mean. See the bead for the root
     * cause and for why the sweep must not use this kernel yet.
     *
     * Kept RED rather than softened to `expect(ranked[0].id).toBe("j1")`, which
     * would pass today by a 0.002 margin and read as "conjunctive retrieval
     * works".
     */
    it("should rank the fact matching ALL entities above facts matching one, by a margin above the noise floor", () => {
      const ranked = reason(joint, ["Ada", "Grace"], { limit: 3 });
      expect(ranked[0]!.id).toBe("j1");
      expect(ranked[0]!.score - ranked[1]!.score).toBeGreaterThan(0.05);
    });

    /** RED, declared against syl-b97. See above. */
    it("should rank a fact that contains the queried entity above one that does not", () => {
      // j3 has Grace, j2 does not, and they are otherwise identical in shape —
      // one entity, two content tokens. Measured: j2 scores 0.5042 and j3
      // scores 0.4797, so the fact WITHOUT the entity wins.
      const ranked = reason(joint, ["Grace"], { limit: 3 });
      const grace = ranked.find((r) => r.id === "j3")!.score;
      const ada = ranked.find((r) => r.id === "j2")!.score;
      expect(grace).toBeGreaterThan(ada);
    });

    it("should use AND semantics: adding an absent entity must not raise a score", () => {
      // Structural, and therefore sound even while the scores themselves are
      // noise: min() over a superset can only go down.
      const one = reason(joint, ["Ada"], { limit: 3 }).find((r) => r.id === "j2")!.score;
      const two = reason(joint, ["Ada", "Grace"], { limit: 3 }).find((r) => r.id === "j2")!.score;
      expect(two).toBeLessThanOrEqual(one);
    });

    it("should throw on an empty entity list rather than scoring everything alike", () => {
      expect(() => reason(joint, [])).toThrow(HolographicError);
      expect(() => reason(joint, [])).toThrow(/at least one entity/);
    });

    it("should throw when a fact vector does not match the requested dim", () => {
      const mismatched: HoloFact[] = [
        { id: "x", content: "x", entities: [], trust: 1, vector: encodeAtom("x", 64) },
      ];
      expect(() => reason(mismatched, ["x"], { dim: 1024 })).toThrow(HolographicError);
    });
  });

  describe("contradict", () => {
    const pool: HoloFact[] = [
      encodeHoloFact({
        id: "p1",
        content: "the service restarts cleanly every time",
        entities: ["service"],
        trust: 1,
      }),
      encodeHoloFact({
        id: "p2",
        content: "wildly different words about nothing at all here",
        entities: ["service"],
        trust: 1,
      }),
      encodeHoloFact({ id: "p3", content: "unrelated topic", entities: ["kitchen"], trust: 1 }),
    ];

    it("should rest on a similarity that actually separates same content from different", () => {
      // The evidence that this kernel is usable while `probe` and `reason` are
      // not (syl-b97): contradict compares two fact vectors DIRECTLY, with no
      // unbinding, so it never touches the operation that loses the signal.
      // Measured against Python: 1.000 for identical content, 0.403 for
      // different content over the same entity.
      const a = encodeFact("the service restarts cleanly every time", ["service"], 1024);
      const b = encodeFact("the service restarts cleanly every time", ["service"], 1024);
      const c = encodeFact("wildly different words about nothing at all", ["service"], 1024);
      expect(similarity(a, b)).toBeCloseTo(1, 12);
      expect(similarity(a, c)).toBeLessThan(0.6);
    });

    it("should propose the pair sharing entities and nothing else", () => {
      const found = contradict(pool, { threshold: 0.0 });
      expect(found).toHaveLength(1);
      expect([found[0]!.a, found[0]!.b]).toEqual(["p1", "p2"]);
      expect(found[0]!.sharedEntities).toEqual(["service"]);
    });

    it("should return nothing when the threshold is above every pair's score", () => {
      expect(contradict(pool, { threshold: 1.1 })).toEqual([]);
    });

    it("should return nothing for fewer than two facts", () => {
      expect(contradict([pool[0]!], { threshold: 0 })).toEqual([]);
      expect(contradict([], { threshold: 0 })).toEqual([]);
    });

    it("should skip pairs with no entities at all, which cannot share a subject", () => {
      const anonymous: HoloFact[] = [
        encodeHoloFact({ id: "a1", content: "one", entities: [], trust: 1 }),
        encodeHoloFact({ id: "a2", content: "two", entities: [], trust: 1 }),
      ];
      expect(contradict(anonymous, { threshold: 0 })).toEqual([]);
    });

    it("should bound the O(n^2) scan with maxFacts, keeping the first entries", () => {
      const many: HoloFact[] = Array.from({ length: 6 }, (_, i) =>
        encodeHoloFact({
          id: `m${i}`,
          content: `distinct content number ${i} with its own words`,
          entities: ["shared"],
          trust: 1,
        }),
      );
      const all = contradict(many, { threshold: 0, limit: 100 });
      const capped = contradict(many, { threshold: 0, limit: 100, maxFacts: 3 });
      expect(all).toHaveLength(15); // 6 choose 2
      expect(capped).toHaveLength(3); // 3 choose 2
      for (const c of capped) {
        expect(["m0", "m1", "m2"]).toContain(c.a);
        expect(["m0", "m1", "m2"]).toContain(c.b);
      }
    });

    it("should round the reported fields to three decimals, half-to-even", () => {
      const found = contradict(pool, { threshold: 0.0 });
      for (const c of found) {
        expect(c.entityOverlap).toBe(Number(c.entityOverlap.toFixed(3)));
        expect(c.contradictionScore).toBe(Number(c.contradictionScore.toFixed(3)));
      }
      // 1/1 overlap on a single shared entity is exactly 1.
      expect(found[0]!.entityOverlap).toBe(1);
    });
  });

  describe("probe", () => {
    /**
     * RED, declared in `tests/expected-failures.json` against syl-b97.
     *
     * Measured, and identical in the Python original: s3 (which has Grace, not
     * Ada) scores 0.4976 and ranks FIRST, ahead of both facts that actually
     * carry Ada in their entity slot. Same root cause as `reason`.
     */
    it("should rank facts whose entity slot holds the probe above one that does not", () => {
      const ranked = probe(structural, "Ada", { limit: 3 });
      expect(ranked[2]!.id).toBe("s3");
      expect(ranked[1]!.score - ranked[2]!.score).toBeGreaterThan(0.05);
    });

    it("should throw when a fact vector does not match the requested dim", () => {
      const mismatched: HoloFact[] = [
        { id: "x", content: "x", entities: [], trust: 1, vector: encodeAtom("x", 64) },
      ];
      expect(() => probe(mismatched, "x", { dim: 1024 })).toThrow(HolographicError);
    });

    it("should weight by trust, so a distrusted fact cannot outrank a trusted twin", () => {
      const twins: HoloFact[] = [
        encodeHoloFact({ id: "t-high", content: "same words here", entities: ["Ada"], trust: 0.9 }),
        encodeHoloFact({ id: "t-low", content: "same words here", entities: ["Ada"], trust: 0.1 }),
      ];
      const ranked = probe(twins, "Ada", { limit: 2 });
      expect(ranked[0]!.id).toBe("t-high");
    });
  });

  describe("encodeHoloFact", () => {
    it("should attach a vector of the requested dimension and keep the other fields", () => {
      const f = encodeHoloFact({ id: "e", content: "hello", entities: ["Ada"], trust: 0.4 }, 128);
      expect(f.vector).toHaveLength(128);
      expect(f.id).toBe("e");
      expect(f.trust).toBe(0.4);
    });

    it("should default to the production dimension", () => {
      expect(encodeHoloFact({ id: "e", content: "hi", entities: [], trust: 1 }).vector).toHaveLength(
        1024,
      );
    });

    it("should be deterministic across calls, which is what makes caching safe", () => {
      const a = encodeHoloFact({ id: "e", content: "hi there", entities: ["X"], trust: 1 }, 64);
      const b = encodeHoloFact({ id: "e", content: "hi there", entities: ["X"], trust: 1 }, 64);
      expect(Array.from(b.vector)).toEqual(Array.from(a.vector));
    });
  });
});
