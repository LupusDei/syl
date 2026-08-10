import { describe, expect, it } from "vitest";

import {
  alarmIsUnmissable,
  alarmPresentation,
  coldSampleStateOf,
  describeRate,
  edgeStyle,
  emptyStateOf,
  formatWeight,
  layoutNodes,
  MIN_OPACITY,
  rankEdges,
  type ColdSampleEdge,
  type ColdShapeView,
  type InvariantAlarm,
  type MemoryEdgeView,
  type MemoryGraphView,
  type MemoryNodeView,
  type Rate,
  type WeightLawView,
} from "../../src/features/memory/memory-model";

/**
 * The judgement the memory viewer makes, tested without a DOM.
 *
 * Three requirements are being pinned here, and every one of them is a way this
 * surface could look correct and quietly lie:
 *
 * 1. a `null` rate must never become `0%` or a zeroed bar;
 * 2. `unproven` must never read as a passing check, and a trust failure must
 *    never be collapsible into a generic error count;
 * 3. the two species must differ by stroke SHAPE, not only by colour.
 */

const LAW: WeightLawView = {
  halfLifeMs: 21 * 86_400_000,
  relevanceFloor: 0.05,
  traversalCap: 0.5,
  engagementCap: 1,
};

function rate(overrides: Partial<Rate> = {}): Rate {
  return { numerator: 3, denominator: 4, value: 0.75, undefinedBecause: null, ...overrides };
}

function alarm(overrides: Partial<InvariantAlarm> = {}): InvariantAlarm {
  return {
    status: "unproven",
    severity: "unknown",
    headline: "UNPROVEN: no dream has ever inserted an edge.",
    total: 0,
    byExistingTier: { hot: 0, cold: 0, suppressed: 0, unrecorded: 0 },
    insertionsAttempted: 0,
    ...overrides,
  };
}

function node(id: string, overrides: Partial<MemoryNodeView> = {}): MemoryNodeView {
  return {
    id,
    tier: "hot",
    kind: "fact",
    label: `node ${id}`,
    body: null,
    subjectId: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function edge(id: string, overrides: Partial<MemoryEdgeView> = {}): MemoryEdgeView {
  return {
    id,
    kind: "inferred",
    tier: "hot",
    sourceNode: "a",
    targetNode: "b",
    relation: "relates_to",
    storedWeight: 0.8,
    effectiveWeight: 0.8,
    confidence: 0.7,
    reasoning: "Both slipped the same week.",
    assertedBy: null,
    demoteAfter: "2026-11-09T00:00:00.000Z",
    lastTouchedAt: "2026-08-09T00:00:00.000Z",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    origin: "hot_region",
    ...overrides,
  };
}

describe("describeRate", () => {
  it("should give a percentage when there was something to divide", () => {
    const reading = describeRate(rate());

    expect(reading.known).toBe(true);
    expect(reading.text).toBe("75%");
    expect(reading.fraction).toBeCloseTo(0.75);
    expect(reading.counts).toBe("3 of 4");
  });

  it("should refuse to turn a null into a zero, and say why instead", () => {
    // The whole reason `metrics.ts` uses null. "0% rejected" out of nothing
    // surfaced reads as excellent news and means nothing at all.
    const reading = describeRate(
      rate({
        numerator: 0,
        denominator: 0,
        value: null,
        undefinedBecause: "nothing has been surfaced to him yet, so there is no engagement rate",
      }),
    );

    expect(reading.known).toBe(false);
    expect(reading.fraction).toBeNull();
    expect(reading.text).toContain("nothing has been surfaced");
    expect(reading.text).not.toContain("0%");
  });

  it("should still say something honest when a null arrives with no reason attached", () => {
    // Only reachable from a malformed payload. It must not silently become 0%.
    const reading = describeRate(
      rate({ numerator: 0, denominator: 0, value: null, undefinedBecause: null }),
    );

    expect(reading.known).toBe(false);
    expect(reading.text).toContain("not a rate of zero");
  });
});

describe("alarmPresentation", () => {
  it("should never render `unproven` as a passing check", () => {
    // Zero breaches with zero attempts is an absence of evidence. A green tick
    // here is the exact lie the status was invented to prevent.
    const presentation = alarmPresentation(alarm({ status: "unproven" }));

    expect(presentation.tone).not.toBe("ok");
    expect(presentation.label).toBe("UNPROVEN");
    expect(presentation.broken).toBe(false);
    expect(presentation.dismissible).toBe(false);
    expect(presentation.guidance).toContain("no evidence either way");
  });

  it("should give a resurrected rejection its own word, not a louder critical", () => {
    const presentation = alarmPresentation(
      alarm({
        status: "rejected_connection_resurrected",
        severity: "trust_failure",
        total: 1,
        byExistingTier: { hot: 0, cold: 0, suppressed: 1, unrecorded: 0 },
        insertionsAttempted: 9,
      }),
    );

    expect(presentation.trustFailure).toBe(true);
    expect(presentation.label).toBe("TRUST FAILURE");
    expect(presentation.broken).toBe(true);
    expect(presentation.dismissible).toBe(false);
  });

  it("should keep the cold-lookup bug distinct from a trust failure", () => {
    const presentation = alarmPresentation(
      alarm({ status: "cold_lookup_broken", severity: "critical", total: 2, insertionsAttempted: 9 }),
    );

    expect(presentation.broken).toBe(true);
    expect(presentation.trustFailure).toBe(false);
    expect(presentation.label).toBe("BREACHED");
  });

  it("should let only a proven-holding invariant be quiet", () => {
    const holds = alarmPresentation(alarm({ status: "holds", severity: "ok", insertionsAttempted: 40 }));

    expect(holds.tone).toBe("ok");
    expect(holds.dismissible).toBe(true);
    expect(alarmIsUnmissable(alarm({ status: "holds", severity: "ok" }))).toBe(false);
    expect(alarmIsUnmissable(alarm({ status: "unproven" }))).toBe(true);
  });
});

describe("edgeStyle", () => {
  it("should distinguish the two species by stroke shape, not only by colour", () => {
    // Colour alone fails for a colour-blind reader and fails again in a
    // greyscale screenshot, and this picture will end up in both.
    const inferred = edgeStyle(edge("e1", { kind: "inferred" }), LAW);
    const observed = edgeStyle(
      edge("e2", { kind: "observed", reasoning: null, confidence: null, assertedBy: "src" }),
      LAW,
    );

    expect(inferred.dash).not.toBeNull();
    expect(observed.dash).toBeNull();
    expect(inferred.tone).not.toBe(observed.tone);
    expect(inferred.species).toBe("inferred");
    expect(observed.species).toBe("observed");
  });

  it("should make a decayed edge visibly fainter and thinner than a fresh one", () => {
    const strong = edgeStyle(edge("e1", { effectiveWeight: 0.95 }), LAW);
    const faint = edgeStyle(edge("e2", { effectiveWeight: 0.02 }), LAW);

    expect(faint.strokeWidth).toBeLessThan(strong.strokeWidth);
    expect(faint.opacity).toBeLessThan(strong.opacity);
    // Still drawn. An edge nothing can see is an edge that may as well have
    // been pruned, which is the thing the Commander overruled.
    expect(faint.opacity).toBeGreaterThanOrEqual(MIN_OPACITY);
    expect(faint.belowFloor).toBe(true);
    expect(strong.belowFloor).toBe(false);
  });

  it("should keep an edge's species after the Commander suppresses it", () => {
    // The record of having said no is worth seeing, and it is still a guess.
    const style = edgeStyle(edge("e1", { tier: "suppressed", effectiveWeight: 0.01 }), LAW);

    expect(style.species).toBe("inferred");
    expect(style.dash).not.toBeNull();
    expect(style.tone).toBe("muted");
  });
});

describe("layoutNodes", () => {
  it("should place nothing for an empty graph rather than throwing", () => {
    expect(layoutNodes([], []).size).toBe(0);
  });

  it("should be deterministic, so a reject does not reshuffle the picture", () => {
    // A force layout moves every node whenever any node changes, which takes
    // the edge he is about to judge out from under the cursor.
    const nodes = [node("c"), node("a"), node("b")];
    const edges = [edge("e1", { sourceNode: "a", targetNode: "b" })];

    const first = layoutNodes(nodes, edges);
    const second = layoutNodes([...nodes].reverse(), edges);

    expect([...first.keys()].sort()).toEqual([...second.keys()].sort());
    expect(first.get("a")).toEqual(second.get("a"));
    expect(first.get("c")).toEqual(second.get("c"));
  });

  it("should put the busiest node nearer the middle than a leaf", () => {
    const nodes = [node("hub"), node("leaf1"), node("leaf2"), node("lonely")];
    const edges = [
      edge("e1", { sourceNode: "hub", targetNode: "leaf1" }),
      edge("e2", { sourceNode: "hub", targetNode: "leaf2" }),
    ];

    const placed = layoutNodes(nodes, edges, { width: 1000, height: 1000 });
    const hub = placed.get("hub");
    const lonely = placed.get("lonely");
    const distance = (point: { x: number; y: number } | undefined): number =>
      point === undefined ? Infinity : Math.hypot(point.x - 500, point.y - 500);

    expect(distance(hub)).toBeLessThanOrEqual(distance(lonely));
  });

  it("should centre a single node rather than flinging it at a ring", () => {
    const placed = layoutNodes([node("only")], [], { width: 800, height: 600 });

    expect(placed.get("only")).toEqual({ x: 400, y: 300 });
  });
});

describe("emptyStateOf", () => {
  function view(overrides: Partial<MemoryGraphView> = {}): MemoryGraphView {
    return {
      generatedAt: "2026-08-10T02:00:00.000Z",
      scope: {
        tier: "hot",
        nodeSeeds: 40,
        edgeBudget: 200,
        nights: 7,
        seedsUsed: 0,
        edgesReturned: 0,
        edgeBudgetExhausted: false,
        nightsReturned: 0,
        moreNights: false,
        dreamHasEverRun: false,
        explanation: "The hot region plus the last 7 nights.",
      },
      law: LAW,
      nodes: [],
      edges: [],
      nights: [],
      superseded: [],
      ...overrides,
    };
  }

  it("should say plainly that nothing is wrong when no dream has ever run", () => {
    // This is the state he will actually see first, and "no data" must not
    // look like "broken".
    const empty = emptyStateOf(view());

    expect(empty.reason).toBe("no_dream_yet");
    expect(empty.headline).toContain("nothing is wrong");
    expect(empty.body).toContain("reporting an empty store");
  });

  it("should tell a quiet window apart from an unstarted engine", () => {
    const empty = emptyStateOf(
      view({ scope: { ...view().scope, dreamHasEverRun: true, nightsReturned: 3 } }),
    );

    expect(empty.reason).toBe("window_quiet");
  });

  it("should flag an empty hot region after dreams have run as worth a look", () => {
    const empty = emptyStateOf(view({ scope: { ...view().scope, dreamHasEverRun: true } }));

    expect(empty.reason).toBe("dreams_ran_but_graph_empty");
    expect(empty.body).toContain("survival rate");
  });

  it("should report a populated graph as not empty at all", () => {
    expect(emptyStateOf(view({ nodes: [node("a")], edges: [edge("e1")] })).reason).toBe("not_empty");
  });
});

describe("coldSampleStateOf", () => {
  function shape(overrides: Partial<ColdShapeView> = {}): ColdShapeView {
    return {
      edges: 0,
      inferred: 0,
      observed: 0,
      oldestEnteredAt: null,
      oldestAgeMs: null,
      timeInCold: null,
      enteredBasis: "moved_at",
      growthPerNight: [],
      crossingRatePerNight: rate({ numerator: 0, denominator: 0, value: null, undefinedBecause: "no night has run" }),
      ...overrides,
    };
  }

  function coldEdge(): ColdSampleEdge {
    return {
      id: "cold-1",
      tier: "cold",
      relation: "reminds_of",
      sourceNode: "n1",
      targetNode: "n2",
      sourceLabel: "A",
      targetLabel: "B",
      weight: 0.03,
      confidence: 0.4,
      reasoning: "Both were about promises the system could not keep.",
      enteredColdAt: "2026-07-01T00:00:00.000Z",
      ageMs: 1_000,
    };
  }

  it("should say nothing has decayed yet rather than implying the store is clean", () => {
    // The trap. Early on there are no cold edges because nothing has had time
    // to cross the floor, and that renders as the same blank panel as a store
    // that has been swept.
    const state = coldSampleStateOf(shape(), []);

    expect(state.reason).toBe("nothing_cold_yet");
    expect(state.headline).toContain("crossed the relevance floor");
    expect(state.body).toContain("not a clean store");
  });

  it("should tell an observation-only cold set apart from an empty one", () => {
    const state = coldSampleStateOf(shape({ edges: 3, observed: 3 }), []);

    expect(state.reason).toBe("only_observed_cold");
    expect(state.body).toContain("carries no reasoning");
  });

  it("should call an empty sample over dormant inferences a fault in the audit", () => {
    // The numbers say there is something down there and the sample is drawn
    // from exactly that set, so silence here is a bug rather than evidence.
    const state = coldSampleStateOf(shape({ edges: 4, inferred: 4 }), []);

    expect(state.reason).toBe("sample_missing");
    expect(state.body).toContain("fault in");
  });

  it("should get out of the way when there is something to read", () => {
    const state = coldSampleStateOf(shape({ edges: 1, inferred: 1 }), [coldEdge()]);

    expect(state.reason).toBe("has_sample");
  });
});

describe("rankEdges and formatWeight", () => {
  it("should put inferences first, because they are the thing under judgement", () => {
    const ranked = rankEdges([
      edge("observed", { kind: "observed", effectiveWeight: 1, reasoning: null, assertedBy: "s" }),
      edge("weak", { effectiveWeight: 0.1 }),
      edge("strong", { effectiveWeight: 0.9 }),
    ]);

    expect(ranked.map((row) => row.id)).toEqual(["strong", "weak", "observed"]);
  });

  it("should never round a live weight down to a flat zero", () => {
    // `0.00` reads as gone, and nothing in this system is ever gone.
    expect(formatWeight(0.0004)).toBe("<0.01");
    expect(formatWeight(0.42)).toBe("0.42");
  });
});
