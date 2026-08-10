import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemoryGraph,
  type InferredEdge,
  type ObservedEdge,
} from "../../src/memory/graph.js";
import {
  DEFAULT_WEIGHT_LAW,
  DAY_MS,
  EdgeWeights,
  WeightError,
  crossingInstant,
  dwellMs,
  effectiveWeight,
  reactivatedWeight,
  suppressedWeight,
  validateWeightLaw,
  type WeightLaw,
} from "../../src/memory/weights.js";
import { instant } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The weight law — `syl-005.3.2` — against the REAL shipped migration.
 *
 * Four forces, and every one of them has a way of being implemented so that it
 * looks right and silently is not. Each has a test below that goes red under
 * exactly that mistake:
 *
 *  1. **Reactivation jumps to a floor, it does not multiply.** A multiplicative
 *     boost on a decayed weight does nothing: `0.0001 * 2` is still invisible.
 *     Without a floor the asymptote is a one-way trip and the Commander's
 *     "promote it straight back" never happens — constraint 6 quietly becomes
 *     the pruning he rejected.
 *  2. **Decay is computed, never written.** Nothing here issues an `UPDATE`
 *     that recomputes a weight; the only sweep is the tier move.
 *  3. **Syl's own traversal must not lift an edge as far as the Commander's
 *     engagement does.** That is a safety property, not a tuning knob: equal
 *     boosts let her reinforce her own beliefs with no contact with reality.
 *  4. **Suppression falls faster than disuse.** A connection he was shown and
 *     rejected must not linger precisely because it was shown once.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const NOW_ISO = "2026-08-09T12:00:00.000Z";

let db: Database;
let graph: MemoryGraph;
let weights: EdgeWeights;
let clockMs: number;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  clockMs = NOW;
  const clock = () => clockMs;
  graph = new MemoryGraph({ db, clock });
  weights = new EdgeWeights({ graph, clock });
});

afterEach(() => {
  db.close();
});

/** Two nodes and an inference between them, at full strength as of `NOW`. */
function inference(weight = 1): InferredEdge {
  const commander = graph.addNode({ kind: "person", label: "the Commander" });
  const goal = graph.addNode({ kind: "goal", label: "ship Syl" });
  return graph.infer({
    sourceNode: commander.id,
    targetNode: goal.id,
    relation: "cares_about",
    reasoning: "he mentions it in three of the last five evening reviews",
    confidence: 0.7,
    weight,
    demoteAfter: crossingInstant(weight, clockMs),
  });
}

/** An observation, which never crosses the floor on its own. */
function observation(weight = 1): ObservedEdge {
  const commander = graph.addNode({ kind: "person", label: "the Commander" });
  const goal = graph.addNode({ kind: "goal", label: "ship Syl" });
  const note = graph.addNode({ kind: "source", label: "standup note" });
  return graph.observe({
    sourceNode: commander.id,
    targetNode: goal.id,
    relation: "owns",
    assertedBy: note.id,
    weight,
  });
}

// ── The law itself, as pure arithmetic ─────────────────────────────────────

describe("the default weight law", () => {
  it("should be self-consistent", () => {
    expect(() => validateWeightLaw(DEFAULT_WEIGHT_LAW)).not.toThrow();
  });

  it("should never let purely internal use reach where the Commander's engagement can", () => {
    // The asymmetry is structural, not a tuning choice: this is what stops Syl
    // reinforcing her own beliefs to certainty with no contact with reality.
    expect(DEFAULT_WEIGHT_LAW.touch.traversal.cap).toBeLessThan(
      DEFAULT_WEIGHT_LAW.touch.engagement.cap,
    );
    expect(DEFAULT_WEIGHT_LAW.touch.traversal.floor).toBeLessThan(
      DEFAULT_WEIGHT_LAW.touch.engagement.floor,
    );
    expect(DEFAULT_WEIGHT_LAW.touch.traversal.increment).toBeLessThan(
      DEFAULT_WEIGHT_LAW.touch.engagement.increment,
    );
  });

  it("should refuse a law whose reactivation floor is below the relevance floor", () => {
    // A reactivation that lands below the floor is a reactivation that demotes
    // on the next sweep — the one-way trip, wearing a floor's clothes.
    const broken: WeightLaw = {
      ...DEFAULT_WEIGHT_LAW,
      touch: {
        ...DEFAULT_WEIGHT_LAW.touch,
        traversal: { ...DEFAULT_WEIGHT_LAW.touch.traversal, floor: 0.001 },
      },
    };
    expect(() => validateWeightLaw(broken)).toThrow(WeightError);
  });

  it("should refuse a law in which internal traversal can reach as far as engagement", () => {
    const broken: WeightLaw = {
      ...DEFAULT_WEIGHT_LAW,
      touch: {
        ...DEFAULT_WEIGHT_LAW.touch,
        traversal: { ...DEFAULT_WEIGHT_LAW.touch.engagement },
      },
    };
    expect(() => validateWeightLaw(broken)).toThrow(/engagement/u);
  });

  it("should refuse a law whose suppression penalty leaves an edge above the floor", () => {
    const broken: WeightLaw = { ...DEFAULT_WEIGHT_LAW, suppressionPenalty: 0.9 };
    expect(() => validateWeightLaw(broken)).toThrow(WeightError);
  });
});

describe("effectiveWeight", () => {
  it("should return the stored weight when no time has passed", () => {
    expect(effectiveWeight(0.8, NOW_ISO, NOW)).toBeCloseTo(0.8, 12);
  });

  it("should halve the weight after one half-life", () => {
    const later = NOW + DEFAULT_WEIGHT_LAW.halfLifeMs;
    expect(effectiveWeight(0.8, NOW_ISO, later)).toBeCloseTo(0.4, 12);
  });

  it("should approach zero without ever arriving, however long the edge lies dormant", () => {
    // Constraint 6's asymptote, stated as arithmetic. A century of silence
    // still leaves a strictly positive, still-promotable weight — and IEEE 754
    // underflow to exactly 0.0 is the one way that quietly stops being true.
    const century = NOW + 365 * 100 * DAY_MS;
    const decayed = effectiveWeight(1, NOW_ISO, century);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    expect(Number.isFinite(decayed)).toBe(true);
  });

  it("should never grow a weight when the clock runs backwards", () => {
    // Clock skew must not be a reinforcement mechanism.
    expect(effectiveWeight(0.5, NOW_ISO, NOW - 30 * DAY_MS)).toBeCloseTo(0.5, 12);
  });

  it("should refuse a weight outside (0, 1]", () => {
    expect(() => effectiveWeight(0, NOW_ISO, NOW)).toThrow(WeightError);
    expect(() => effectiveWeight(1.5, NOW_ISO, NOW)).toThrow(WeightError);
  });

  it("should refuse a last-touched stamp that is not an RFC 3339 UTC instant", () => {
    expect(() => effectiveWeight(0.5, "2026-08-09T12:00:00+02:00", NOW)).toThrow(WeightError);
  });
});

describe("dwellMs and crossingInstant", () => {
  it("should place the crossing exactly where the decayed weight equals the floor", () => {
    const at = Date.parse(crossingInstant(1, NOW));
    expect(effectiveWeight(1, NOW_ISO, at)).toBeCloseTo(DEFAULT_WEIGHT_LAW.relevanceFloor, 6);
  });

  it("should give a full-strength inference a dwell of about one quarter", () => {
    const days = dwellMs(1) / DAY_MS;
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(95);
  });

  it("should schedule an immediate crossing for a weight already at or below the floor", () => {
    expect(crossingInstant(DEFAULT_WEIGHT_LAW.relevanceFloor, NOW)).toBe(instant(NOW));
    expect(crossingInstant(0.001, NOW)).toBe(instant(NOW));
  });

  it("should give a stronger edge a strictly longer dwell", () => {
    expect(dwellMs(1)).toBeGreaterThan(dwellMs(0.5));
    expect(dwellMs(0.5)).toBeGreaterThan(dwellMs(0.2));
  });

  it("should refuse a weight outside (0, 1]", () => {
    expect(() => crossingInstant(0, NOW)).toThrow(WeightError);
    expect(() => dwellMs(2)).toThrow(WeightError);
  });
});

describe("reactivatedWeight — the floor jump", () => {
  it("should JUMP a nearly-dead edge to the reactivation floor rather than scaling it", () => {
    // THE load-bearing assertion of this bead. A multiplicative boost would
    // leave 0.0001 at 0.0002 — invisible, below the relevance floor, and
    // demoted again on the very next sweep. The connection would stay
    // unreachable however often it were touched.
    const revived = reactivatedWeight(0.0001, "traversal");
    expect(revived).toBeGreaterThanOrEqual(DEFAULT_WEIGHT_LAW.touch.traversal.floor);
    expect(revived).toBeGreaterThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    // Specifically NOT a multiple of where it started.
    expect(revived / 0.0001).toBeGreaterThan(100);
  });

  it("should lift an edge strictly further on the Commander's engagement than on Syl's own traversal", () => {
    const internal = reactivatedWeight(0.0001, "traversal");
    const commander = reactivatedWeight(0.0001, "engagement");
    expect(commander).toBeGreaterThan(internal);
    expect(commander).toBeGreaterThan(DEFAULT_WEIGHT_LAW.touch.traversal.cap);
  });

  it("should cap purely internal use however many times Syl walks the edge", () => {
    // The safety property. Self-reinforcement has a ceiling; only contact with
    // the Commander gets an edge above it.
    let weight = DEFAULT_WEIGHT_LAW.minWeight;
    for (let i = 0; i < 1_000; i += 1) weight = reactivatedWeight(weight, "traversal");
    expect(weight).toBeLessThanOrEqual(DEFAULT_WEIGHT_LAW.touch.traversal.cap);
    expect(weight).toBeLessThan(1);
  });

  it("should let the Commander's engagement carry an edge past the internal cap to full strength", () => {
    let weight = DEFAULT_WEIGHT_LAW.minWeight;
    for (let i = 0; i < 10; i += 1) weight = reactivatedWeight(weight, "engagement");
    expect(weight).toBe(1);
  });

  it("should never lower a weight, so an internal traversal cannot demote what he strengthened", () => {
    const strong = 0.9;
    expect(reactivatedWeight(strong, "traversal")).toBe(strong);
  });

  it("should refuse a touch source outside the vocabulary", () => {
    expect(() => reactivatedWeight(0.5, "guessing" as "traversal")).toThrow(WeightError);
  });

  it("should refuse a weight outside (0, 1]", () => {
    expect(() => reactivatedWeight(0, "traversal")).toThrow(WeightError);
  });
});

describe("suppressedWeight — rejection falls faster than disuse", () => {
  it("should drop any edge below the relevance floor in a single step", () => {
    for (const weight of [1, 0.8, 0.5, 0.2, 0.06]) {
      expect(suppressedWeight(weight)).toBeLessThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    }
  });

  it("should cost more than the whole demotion horizon of mere disuse", () => {
    // "Falls faster" made checkable: the ageing one rejection applies at a
    // stroke is longer than the time an untouched full-strength edge takes to
    // reach the floor by itself.
    const equivalentAgeing =
      DEFAULT_WEIGHT_LAW.halfLifeMs * Math.log2(1 / DEFAULT_WEIGHT_LAW.suppressionPenalty);
    expect(equivalentAgeing).toBeGreaterThan(dwellMs(1));
  });

  it("should stay strictly positive however many times an edge is rejected", () => {
    // Suppression multiplies, and multiplication cannot reach zero — the mirror
    // image of reactivation, which jumps precisely because multiplication
    // cannot escape the asymptote either.
    let weight = 1;
    for (let i = 0; i < 500; i += 1) weight = suppressedWeight(weight);
    expect(weight).toBeGreaterThan(0);
  });

  it("should refuse a weight outside (0, 1]", () => {
    expect(() => suppressedWeight(0)).toThrow(WeightError);
  });
});

// ── The law applied to the store ───────────────────────────────────────────

describe("EdgeWeights.effective", () => {
  it("should report the stored weight for an edge touched just now", () => {
    expect(weights.effective(inference(0.6))).toBeCloseTo(0.6, 12);
  });

  it("should report a decayed weight once time has passed", () => {
    const edge = inference();
    clockMs = NOW + DEFAULT_WEIGHT_LAW.halfLifeMs;
    expect(weights.effective(edge)).toBeCloseTo(0.5, 9);
  });

  it("should never write while reading, because decay is computed and not stored", () => {
    // Consequence 2: a nightly UPDATE across every edge is enormous write
    // amplification for a pure function of two columns already on the row.
    const edge = inference();
    clockMs = NOW + 40 * DAY_MS;
    weights.effective(edge);
    const row = graph.getEdge(edge.id);
    expect(row?.weight).toBe(1);
    expect(row?.lastTouchedAt).toBe(NOW_ISO);
    expect(row?.updatedAt).toBe(NOW_ISO);
  });
});

describe("EdgeWeights.touch", () => {
  it("should raise a hot inference's weight and push its crossing further out", () => {
    const edge = inference(0.3);
    clockMs = NOW + DAY_MS;
    const touched = weights.touch(edge, "engagement") as InferredEdge;

    expect(touched.tier).toBe("hot");
    expect(touched.weight).toBeGreaterThan(edge.weight);
    expect(touched.lastTouchedAt).toBe(instant(clockMs));
    expect(Date.parse(touched.demoteAfter ?? "")).toBeGreaterThan(
      Date.parse(edge.demoteAfter ?? ""),
    );
  });

  it("should promote a cold edge straight back into the scan", () => {
    // Constraint 6's whole promise, end to end.
    const edge = inference();
    graph.demote(edge);
    const cold = graph.getEdge(edge.id) as InferredEdge;
    expect(cold.tier).toBe("cold");

    clockMs = NOW + 200 * DAY_MS;
    const revived = weights.touch(cold, "engagement") as InferredEdge;
    expect(revived.tier).toBe("hot");
    expect(revived.weight).toBeGreaterThanOrEqual(
      DEFAULT_WEIGHT_LAW.touch.engagement.floor,
    );
    expect(revived.demoteAfter).not.toBeNull();
  });

  it("should refuse to touch a suppressed edge, and leave the row exactly as it was", () => {
    // Reactivation may reach cold, never suppressed: the Commander's judgement
    // is not something Syl's own retrieval gets to overrule.
    const edge = inference();
    const suppressed = graph.suppress(edge);
    clockMs = NOW + DAY_MS;

    expect(() => weights.touch(suppressed, "engagement")).toThrow(WeightError);
    const after = graph.getEdge(edge.id);
    expect(after?.tier).toBe("suppressed");
    expect(after?.weight).toBe(suppressed.weight);
    expect(after?.lastTouchedAt).toBe(suppressed.lastTouchedAt);
  });

  it("should cap what Syl's own traversal can do to an edge, however often she walks it", () => {
    // The safety property, through the store rather than in the arithmetic.
    let edge: InferredEdge = inference(0.1);
    for (let i = 1; i <= 50; i += 1) {
      clockMs = NOW + i * DAY_MS;
      edge = weights.touch(edge, "traversal") as InferredEdge;
    }
    expect(edge.weight).toBeLessThanOrEqual(DEFAULT_WEIGHT_LAW.touch.traversal.cap);

    clockMs += DAY_MS;
    const engaged = weights.touch(edge, "engagement") as InferredEdge;
    expect(engaged.weight).toBeGreaterThan(DEFAULT_WEIGHT_LAW.touch.traversal.cap);
  });

  it("should refresh an observation without ever scheduling it a crossing", () => {
    // An observation is what a source said; it does not decay on a timer, and
    // giving it a `demote_after` would put it in the sweep's index forever.
    const edge = observation(0.4);
    clockMs = NOW + DAY_MS;
    const touched = weights.touch(edge, "engagement") as ObservedEdge;

    expect(touched.kind).toBe("observed");
    expect(touched.demoteAfter).toBeNull();
    expect(touched.weight).toBeGreaterThan(0.4);
    expect(touched.lastTouchedAt).toBe(instant(clockMs));
  });

  it("should refuse a touch source outside the vocabulary", () => {
    expect(() => weights.touch(inference(), "vibes" as "traversal")).toThrow(WeightError);
  });
});

describe("EdgeWeights.reject", () => {
  it("should move the edge to the suppressed tier and penalise its weight", () => {
    const edge = inference();
    clockMs = NOW + DAY_MS;
    const rejected = weights.reject(edge);

    expect(rejected.tier).toBe("suppressed");
    expect(rejected.weight).toBeLessThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    expect(rejected.weight).toBeGreaterThan(0);
  });

  it("should clear the crossing stamp, so a suppressed edge leaves the sweep's index", () => {
    const edge = inference();
    const rejected = weights.reject(edge) as InferredEdge;
    expect(rejected.demoteAfter).toBeNull();
    expect(weights.sweep(NOW + 400 * DAY_MS)).toBe(0);
  });

  it("should leave the edge findable by identity, so reflection cannot recreate it", () => {
    const edge = inference();
    weights.reject(edge);
    const found = graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation);
    expect(found?.id).toBe(edge.id);
    expect(found?.tier).toBe("suppressed");
  });

  it("should cost the Commander two deliberate acts to undo, and land it in cold", () => {
    const edge = inference();
    const rejected = weights.reject(edge);
    const restored = graph.unsuppress(rejected);
    expect(restored.tier).toBe("cold");

    clockMs = NOW + DAY_MS;
    const revived = weights.touch(restored, "engagement");
    expect(revived.tier).toBe("hot");
  });

  it("should refuse to reject an already-suppressed edge", () => {
    const edge = inference();
    const rejected = weights.reject(edge);
    expect(() => weights.reject(rejected)).toThrow();
  });
});

describe("EdgeWeights.sweep", () => {
  it("should leave an edge alone until its crossing instant has passed", () => {
    inference();
    expect(weights.sweep(NOW + 80 * DAY_MS)).toBe(0);
  });

  it("should demote an edge once it has crossed, and clear its stamp", () => {
    const edge = inference();
    clockMs = NOW + 200 * DAY_MS;
    expect(weights.sweep(clockMs)).toBe(1);

    const swept = graph.getEdge(edge.id) as InferredEdge;
    expect(swept.tier).toBe("cold");
    expect(swept.demoteAfter).toBeNull();
  });

  it("should never touch an observation, which has no scheduled crossing", () => {
    const edge = observation();
    clockMs = NOW + 4_000 * DAY_MS;
    expect(weights.sweep(clockMs)).toBe(0);
    expect(graph.getEdge(edge.id)?.tier).toBe("hot");
  });

  it("should refuse a sweep instant that is not an RFC 3339 UTC instant", () => {
    expect(() => weights.sweep(Number.NaN)).toThrow();
  });
});

describe("constraint 6, end to end", () => {
  it("should demote a forgotten connection and promote it straight back when it matters again", () => {
    const edge = inference();

    // Nothing touches it for a season.
    clockMs = NOW + 120 * DAY_MS;
    expect(weights.sweep(clockMs)).toBe(1);
    expect(graph.getEdge(edge.id)?.tier).toBe("cold");

    // Years pass. It is still there, still addressable by identity, and its
    // weight has decayed but has not reached zero.
    clockMs = NOW + 3_000 * DAY_MS;
    const dormant = graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation);
    expect(dormant).not.toBeNull();
    expect(weights.effective(dormant as InferredEdge)).toBeGreaterThan(0);

    // The Commander engages with it. One touch, and it is back in the scan at
    // a weight that buys it months — not a doubling of an invisible number.
    const revived = weights.touch(dormant as InferredEdge, "engagement") as InferredEdge;
    expect(revived.tier).toBe("hot");
    expect(revived.weight).toBeGreaterThan(DEFAULT_WEIGHT_LAW.touch.traversal.cap);
    expect(Date.parse(revived.demoteAfter ?? "")).toBeGreaterThan(clockMs + 60 * DAY_MS);
  });

  it("should never delete an inferred edge, whatever the weight law does to it", () => {
    const edge = inference();
    weights.reject(edge);
    expect(() =>
      db.prepare("DELETE FROM memory_edges WHERE id = ?").run(edge.id),
    ).toThrow(/never deleted/u);
    expect(graph.getEdge(edge.id)).not.toBeNull();
  });
});
