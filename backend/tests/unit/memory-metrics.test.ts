import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { MemoryGraph, type InferredEdge } from "../../src/memory/graph.js";
import { DreamLog, type DreamSession } from "../../src/memory/dream/log.js";
import { DreamSweep } from "../../src/memory/dream/sweep.js";
import {
  IGNORED_AFTER_MS,
  MemoryMetrics,
  MetricsError,
  REACTIVATION_VERDICT_NIGHTS,
  isInvariantBroken,
  isTrustFailure,
  rateOf,
} from "../../src/memory/metrics.js";
import { instant, type Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/** 2026-08-09T04:30Z — 23:30 on the 8th in Chicago, which is when Syl dreams. */
const NOW = Date.UTC(2026, 7, 9, 4, 30, 0, 0);
const CHICAGO = "America/Chicago";
const TONIGHT = "2026-08-08";
const DAY_MS = 24 * 60 * 60_000;
const CEILING = 4_000_000;

function steppingClock(start = NOW): Clock & { advance(ms: number): void } {
  let at = start;
  const clock = (() => at) as Clock & { advance(ms: number): void };
  clock.advance = (ms) => {
    at += ms;
  };
  return clock;
}

let database: SylDatabase;
let clock: ReturnType<typeof steppingClock>;
let graph: MemoryGraph;
let log: DreamLog;
let metrics: MemoryMetrics;

beforeEach(() => {
  database = openDatabase({ path: IN_MEMORY });
  clock = steppingClock();
  graph = new MemoryGraph({ db: database.handle, clock });
  log = new DreamLog({ db: database.handle, clock });
  metrics = new MemoryMetrics({ db: database.handle, clock, random: () => 0 });
});

afterEach(() => {
  database.close();
});

// ---------------------------------------------------------------------------
// Fixtures. Everything is built through the real stores against the real
// migrations, so a schema change breaks these rather than sliding past them.
// ---------------------------------------------------------------------------

let labelSeq = 0;

function node(kind: "fact" | "person" | "goal" | "event" | "source" = "fact"): string {
  labelSeq += 1;
  return graph.addNode({ kind, label: `${kind} ${labelSeq}` }).id;
}

interface InferOptions {
  readonly weight?: number;
  readonly confidence?: number;
  /** Defaults to a day out, i.e. comfortably above the floor. */
  readonly demoteAfter?: string;
  readonly relation?: string;
}

function infer(a: string, b: string, options: InferOptions = {}): InferredEdge {
  return graph.infer({
    sourceNode: a,
    targetNode: b,
    relation: options.relation ?? "resembles",
    reasoning: "both showed up in the same week and share a shape",
    confidence: options.confidence ?? 0.8,
    weight: options.weight ?? 0.9,
    demoteAfter: options.demoteAfter ?? instant(clock() + DAY_MS),
  });
}

function observe(a: string, b: string, source: string): void {
  graph.observe({ sourceNode: a, targetNode: b, relation: "mentioned_in", assertedBy: source });
}

function session(night = TONIGHT): DreamSession {
  return log.openSession({ tz: CHICAGO, tokenCeiling: CEILING, night });
}

/** A night that created `edges` and demoted `demoted`, logged the way a dream would. */
function nightOfDreaming(options: {
  readonly night?: string;
  readonly edges?: readonly InferredEdge[];
  readonly demoted?: number;
  readonly tokens?: number;
  readonly costUsd?: number;
}): DreamSession {
  const opened = session(options.night ?? TONIGHT);
  const turn = log.startTurn(opened.id, { phase: "judge" });
  for (const edge of options.edges ?? []) {
    log.recordReasoning({
      sessionId: opened.id,
      turnIndex: turn.turnIndex,
      disposition: "created",
      edgeId: edge.id,
      sourceNode: edge.sourceNode,
      targetNode: edge.targetNode,
      tierAfter: "hot",
      reasoning: edge.reasoning,
      confidence: edge.confidence,
    });
  }
  log.finishTurn(opened.id, turn.turnIndex, {
    outcome: "success",
    tokensSpent: options.tokens ?? 0,
    costUsd: options.costUsd ?? 0,
  });
  log.recordCounts(opened.id, {
    edgesCreated: options.edges?.length ?? 0,
    edgesDemoted: options.demoted ?? 0,
  });
  log.closeSession(opened.id, { outcome: "completed" });
  return log.session(opened.id) as DreamSession;
}

// ---------------------------------------------------------------------------
// The rate type. Every ratio in this module goes through it, so the
// "meaningless zero" failure is prevented in one place rather than eight.
// ---------------------------------------------------------------------------

describe("rateOf: a ratio that refuses to read as zero when there is nothing to divide", () => {
  it("should compute the ratio when there is something to divide", () => {
    const rate = rateOf(3, 4, "nothing was surfaced");
    expect(rate.value).toBeCloseTo(0.75);
    expect(rate.numerator).toBe(3);
    expect(rate.denominator).toBe(4);
    expect(rate.undefinedBecause).toBeNull();
  });

  it("should report null, never zero, when the denominator is zero", () => {
    const rate = rateOf(0, 0, "nothing was surfaced");
    expect(rate.value).toBeNull();
    expect(rate.value).not.toBe(0);
    expect(rate.undefinedBecause).toBe("nothing was surfaced");
  });

  it("should distinguish a genuine zero from an absent one", () => {
    const genuine = rateOf(0, 10, "nothing was surfaced");
    expect(genuine.value).toBe(0);
    expect(genuine.undefinedBecause).toBeNull();
  });

  it("should refuse a negative or non-integer count rather than publish nonsense", () => {
    expect(() => rateOf(-1, 4, "why")).toThrow(MetricsError);
    expect(() => rateOf(1, 1.5, "why")).toThrow(MetricsError);
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.3 — the state of the store.
// ---------------------------------------------------------------------------

describe("store shape", () => {
  it("should count nodes by tier and kind, and edges by species", () => {
    const a = node("person");
    const b = node("goal");
    const source = node("source");
    infer(a, b);
    observe(a, source, source);

    const shape = metrics.storeShape();

    expect(shape.nodes.total).toBe(3);
    expect(shape.nodes.byTier.hot).toBe(3);
    expect(shape.nodes.byKind).toContainEqual({ tier: "hot", kind: "person", count: 1 });
    expect(shape.edges.total).toBe(2);
    expect(shape.edges.inferred).toBe(1);
    expect(shape.edges.observed).toBe(1);
  });

  it("should split inferred edges into active, dormant and suppressed", () => {
    const a = node();
    const b = node();
    const c = node();
    const d = node();
    infer(a, b);
    graph.demote(infer(b, c));
    graph.suppress(infer(c, d));

    const shape = metrics.storeShape();

    expect(shape.edges.active).toBe(1);
    expect(shape.edges.dormant).toBe(1);
    expect(shape.edges.suppressed).toBe(1);
  });

  it("should build a weight histogram over inferred edges, because its shape is the health of the engine", () => {
    const a = node();
    const b = node();
    const c = node();
    infer(a, b, { weight: 0.05 });
    infer(b, c, { weight: 0.08 });
    infer(a, c, { weight: 0.95 });

    const histogram = metrics.storeShape().inferredWeights;

    expect(histogram.total).toBe(3);
    expect(histogram.buckets).toHaveLength(10);
    expect(histogram.buckets[0]?.count).toBe(2);
    expect(histogram.buckets[9]?.count).toBe(1);
    // Two of three piled at the bottom: the dream generating noise nothing confirms.
    expect(histogram.bottomHeavy.value).toBeCloseTo(2 / 3);
  });

  it("should refuse to call an empty store healthy: no inferred edges means no histogram verdict, not a clean one", () => {
    const histogram = metrics.storeShape().inferredWeights;

    expect(histogram.total).toBe(0);
    expect(histogram.bottomHeavy.value).toBeNull();
    expect(histogram.bottomHeavy.undefinedBecause).toMatch(/no inferred edges/i);
  });

  it("should count supersessions from the log rather than guessing at them", () => {
    const opened = session();
    log.recordCounts(opened.id, { nodesSuperseded: 4 });
    log.closeSession(opened.id, { outcome: "completed" });

    expect(metrics.storeShape().supersessions).toBe(4);
  });

  it("should report the store's size on disk", () => {
    expect(metrics.storeShape().databaseBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.3 — survival: insight or noise.
// ---------------------------------------------------------------------------

describe("survival rate", () => {
  it("should report, per cohort night, the fraction of created edges still above the floor", () => {
    const a = node();
    const b = node();
    const c = node();
    const kept = infer(a, b);
    const lost = infer(b, c);
    nightOfDreaming({ edges: [kept, lost] });
    graph.demote(lost);

    const report = metrics.survival();
    const cohort = report.cohorts.find((entry) => entry.night === TONIGHT);

    expect(cohort?.created).toBe(2);
    expect(cohort?.surviving).toBe(1);
    expect(cohort?.demoted).toBe(1);
    expect(cohort?.rate.value).toBeCloseTo(0.5);
    expect(cohort?.nightsAgo).toBe(0);
  });

  it("should count an edge that has crossed the floor as lost even before the sweep has moved it", () => {
    const a = node();
    const b = node();
    const crossed = infer(a, b, { demoteAfter: instant(clock() + 60_000) });
    nightOfDreaming({ edges: [crossed] });

    clock.advance(2 * 60_000);
    const cohort = metrics.survival().cohorts[0];

    // Still tier 'hot' — the nightly sweep has not run. It has crossed all the
    // same, and a metric that read the tier stamp would call it alive.
    expect(graph.getEdge(crossed.id)?.tier).toBe("hot");
    expect(cohort?.surviving).toBe(0);
    expect(cohort?.crossedUnswept).toBe(1);
    expect(metrics.survival().basis).toBe("scheduled_crossing");
  });

  it("should count a suppressed edge as lost, and separately, because he said no rather than time passing", () => {
    const a = node();
    const b = node();
    const rejected = infer(a, b);
    nightOfDreaming({ edges: [rejected] });
    graph.suppress(rejected);

    const cohort = metrics.survival().cohorts[0];

    expect(cohort?.suppressed).toBe(1);
    expect(cohort?.surviving).toBe(0);
  });

  it("should raise `missing` when an inferred edge has vanished from the graph, which constraint 6 forbids", () => {
    const a = node();
    const b = node();
    const edge = infer(a, b);
    nightOfDreaming({ edges: [edge] });
    // Only a raw statement can do this; the store's trigger refuses an inferred
    // delete outright. That is exactly why the metric has to be able to notice
    // it if some future path ever gets round the trigger.
    database.handle
      .prepare("UPDATE memory_edges SET kind = 'observed', asserted_by = source_node, confidence = NULL, reasoning = NULL, demote_after = NULL WHERE id = ?")
      .run(edge.id);
    database.handle.prepare("DELETE FROM memory_edges WHERE id = ?").run(edge.id);

    const report = metrics.survival();

    expect(report.cohorts[0]?.missing).toBe(1);
    expect(report.vanished).toBe(1);
  });

  it("should say it has no evidence rather than report a survival rate of zero", () => {
    const report = metrics.survival();

    expect(report.hasEvidence).toBe(false);
    expect(report.overall.value).toBeNull();
    expect(report.overall.undefinedBecause).toMatch(/no edges/i);
  });

  it("should refuse a window that is not a positive whole number of nights", () => {
    expect(() => metrics.survival({ nights: 0 })).toThrow(MetricsError);
    expect(() => metrics.survival({ nights: 2.5 })).toThrow(MetricsError);
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.3 / syl-005.6.4 — reactivation: the evidence for demote-never-prune.
// ---------------------------------------------------------------------------

describe("reactivation rate", () => {
  function reactivate(edge: InferredEdge, sessionId: string, why: string): void {
    graph.promote(graph.getEdge(edge.id) as InferredEdge, {
      demoteAfter: instant(clock() + DAY_MS),
      weight: 0.8,
    });
    log.recordReasoning({
      sessionId,
      disposition: "reactivated",
      edgeId: edge.id,
      sourceNode: edge.sourceNode,
      targetNode: edge.targetNode,
      tierBefore: "cold",
      tierAfter: "hot",
      reasoning: why,
    });
  }

  it("should count cold-to-hot rediscoveries and say what triggered each", () => {
    const a = node();
    const b = node();
    const edge = infer(a, b);
    graph.demote(edge);
    const opened = session();
    reactivate(edge, opened.id, "the sweep re-proposed it from today's memories");
    log.recordCounts(opened.id, { edgesDemoted: 4 });
    log.closeSession(opened.id, { outcome: "completed" });

    const report = metrics.reactivation();

    expect(report.reactivated).toBe(1);
    expect(report.demoted).toBe(4);
    expect(report.rate.value).toBeCloseTo(0.25);
    expect(report.triggers[0]?.reasoning).toMatch(/re-proposed/);
  });

  it("should say plainly that reactivation never happens once months of demotions have produced none", () => {
    for (let index = 0; index < REACTIVATION_VERDICT_NIGHTS; index += 1) {
      const day = new Date(Date.UTC(2026, 0, 1) + index * DAY_MS).toISOString().slice(0, 10);
      const opened = session(day);
      log.recordCounts(opened.id, { edgesDemoted: 10 });
      log.closeSession(opened.id, { outcome: "completed" });
    }

    const report = metrics.reactivation();

    expect(report.verdict.kind).toBe("never_reactivated");
    expect(report.verdict.headline).toMatch(/never/i);
    expect(report.verdict.headline).toMatch(/bought/i);
  });

  it("should blame the broken lookup rather than the absence of anything worth reactivating when the invariant is breached", () => {
    const opened = session();
    log.recordDuplicateEdgeInsert({
      sessionId: opened.id,
      sourceNode: node(),
      targetNode: node(),
      existingEdgeId: "syl:memory_edge:01988f1a-0000-7000-8000-000000000001",
      existingTier: "cold",
    });
    log.recordCounts(opened.id, { edgesDemoted: 10 });
    log.closeSession(opened.id, { outcome: "completed" });

    const report = metrics.reactivation();

    expect(report.verdict.kind).toBe("reactivation_may_be_broken");
    expect(report.verdict.headline).toMatch(/duplicat/i);
  });

  it("should not deliver a verdict at all when nothing has ever been demoted", () => {
    const opened = session();
    log.closeSession(opened.id, { outcome: "completed" });

    const report = metrics.reactivation();

    expect(report.verdict.kind).toBe("nothing_demoted_yet");
    expect(report.rate.value).toBeNull();
  });

  it("should say there have been no dreams at all rather than report zeroes as a finding", () => {
    const report = metrics.reactivation();

    expect(report.verdict.kind).toBe("no_dreams_yet");
    expect(report.nights).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.3 — engagement.
// ---------------------------------------------------------------------------

describe("engagement", () => {
  function surface(edgeId: string | null, sessionId: string): number {
    return log.recordSurfaced({ sessionId, edgeId, summary: "these two look related" }).id;
  }

  it("should split what he acted on, ignored and rejected", () => {
    const opened = session();
    const engaged = surface(null, opened.id);
    const rejected = surface(null, opened.id);
    surface(null, opened.id);
    log.recordEngagement(engaged, "engaged");
    log.recordEngagement(rejected, "rejected");

    const report = metrics.engagement();

    expect(report.surfaced).toBe(3);
    expect(report.engaged).toBe(1);
    expect(report.rejected).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.answered).toBe(2);
    expect(report.engagedRate.value).toBeCloseTo(0.5);
  });

  it("should treat a connection he never answered as ignored once it has gone stale, so silence is measurable", () => {
    const opened = session();
    surface(null, opened.id);

    clock.advance(IGNORED_AFTER_MS + 1);
    const report = metrics.engagement();

    expect(report.ignored).toBe(1);
    expect(report.agedIntoIgnored).toBe(1);
    expect(report.pending).toBe(0);
    expect(report.answered).toBe(1);
  });

  it("should break engagement down by the class of connection, which is what says stop generating a class", () => {
    const a = node();
    const b = node();
    const c = node();
    const liked = infer(a, b, { relation: "resembles" });
    const ignored = infer(b, c, { relation: "co_occurs_with" });
    const opened = session();
    log.recordEngagement(surface(liked.id, opened.id), "engaged");
    log.recordEngagement(surface(ignored.id, opened.id), "ignored");

    const byRelation = metrics.engagement().byRelation;

    expect(byRelation.find((row) => row.relation === "resembles")?.engagedRate.value).toBe(1);
    expect(byRelation.find((row) => row.relation === "co_occurs_with")?.engagedRate.value).toBe(0);
  });

  it("should report no rate rather than a zero one when nothing has been surfaced", () => {
    const report = metrics.engagement();

    expect(report.hasEvidence).toBe(false);
    expect(report.engagedRate.value).toBeNull();
    expect(report.engagedRate.undefinedBecause).toMatch(/nothing/i);
  });

  it("should report no rate when everything surfaced is still awaiting a verdict", () => {
    const opened = session();
    surface(null, opened.id);

    const report = metrics.engagement();

    expect(report.answered).toBe(0);
    expect(report.engagedRate.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.3 — cost per kept edge.
// ---------------------------------------------------------------------------

describe("cost per kept edge", () => {
  it("should divide what was spent by what survived", () => {
    const a = node();
    const b = node();
    const c = node();
    const kept = infer(a, b);
    const lost = infer(b, c);
    nightOfDreaming({ edges: [kept, lost], tokens: 1000, costUsd: 2 });
    graph.demote(lost);

    const report = metrics.costPerKeptEdge();

    expect(report.tokensSpent).toBe(1000);
    expect(report.edgesKept).toBe(1);
    expect(report.tokensPerKeptEdge.value).toBe(1000);
    expect(report.usdPerKeptEdge.value).toBeCloseTo(2);
  });

  it("should never report a night that kept nothing as free", () => {
    const a = node();
    const b = node();
    const lost = infer(a, b);
    nightOfDreaming({ edges: [lost], tokens: 900_000, costUsd: 12 });
    graph.demote(lost);

    const report = metrics.costPerKeptEdge();

    expect(report.keptNothing).toBe(true);
    expect(report.tokensPerKeptEdge.value).toBeNull();
    expect(report.tokensPerKeptEdge.undefinedBecause).toMatch(/unbounded, not zero/i);
  });

  it("should declare the figure understated when a turn was killed before it could report its usage", () => {
    const opened = session();
    const turn = log.startTurn(opened.id, { phase: "judge" });
    log.finishTurn(opened.id, turn.turnIndex, { outcome: "timeout", error: "killed at 10m" });
    log.closeSession(opened.id, { outcome: "failed" });

    const report = metrics.costPerKeptEdge();

    expect(report.understated).toBe(true);
    expect(report.timedOutTurns).toBe(1);
  });

  it("should trend per night rather than only in aggregate", () => {
    const a = node();
    const b = node();
    nightOfDreaming({ night: "2026-08-06", edges: [infer(a, b)], tokens: 500 });
    nightOfDreaming({ night: "2026-08-07", edges: [infer(b, node())], tokens: 300 });

    const report = metrics.costPerKeptEdge();

    expect(report.perNight.map((entry) => entry.night)).toEqual(["2026-08-07", "2026-08-06"]);
    expect(report.perNight[0]?.tokensSpent).toBe(300);
  });

  it("should report nothing spent as no figure, not as a cost of zero", () => {
    const report = metrics.costPerKeptEdge();

    expect(report.tokensPerKeptEdge.value).toBeNull();
    expect(report.understated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.4 — THE INVARIANT ALARM. The most important number in the surface.
// ---------------------------------------------------------------------------

describe("the invariant alarm", () => {
  function breach(existingTier: "hot" | "cold" | "suppressed" | null): void {
    const opened = session();
    log.recordDuplicateEdgeInsert({
      sessionId: opened.id,
      sourceNode: node(),
      targetNode: node(),
      existingEdgeId: "syl:memory_edge:01988f1a-0000-7000-8000-00000000000f",
      existingTier,
    });
    log.recordReasoning({
      sessionId: opened.id,
      disposition: "rejected",
      sourceNode: node(),
      targetNode: node(),
      reasoning: "not a real connection",
    });
    log.closeSession(opened.id, { outcome: "completed" });
  }

  it("should refuse to call an untested invariant proven: zero breaches with zero dreams is unproven, not healthy", () => {
    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.status).toBe("unproven");
    expect(alarm.severity).toBe("unknown");
    expect(alarm.headline).toMatch(/never been exercised|no dream/i);
    expect(isInvariantBroken(alarm)).toBe(false);
  });

  it("should report that it holds once a dream has actually exercised the identity lookup", () => {
    const opened = session();
    const a = node();
    const b = node();
    const edge = infer(a, b);
    log.recordReasoning({
      sessionId: opened.id,
      disposition: "created",
      edgeId: edge.id,
      sourceNode: a,
      targetNode: b,
      reasoning: "worth keeping",
    });
    log.closeSession(opened.id, { outcome: "completed" });

    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.status).toBe("holds");
    expect(alarm.severity).toBe("ok");
    expect(alarm.total).toBe(0);
  });

  it("should name a cold breach as the cold-partition lookup being broken", () => {
    breach("cold");

    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.status).toBe("cold_lookup_broken");
    expect(alarm.severity).toBe("critical");
    expect(alarm.byExistingTier.cold).toBe(1);
    expect(alarm.coldLookupFailures).toHaveLength(1);
    expect(isInvariantBroken(alarm)).toBe(true);
    expect(isTrustFailure(alarm)).toBe(false);
  });

  it("should report a suppressed breach as a TRUST FAILURE, in its own status and its own severity", () => {
    breach("suppressed");

    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.status).toBe("rejected_connection_resurrected");
    expect(alarm.severity).toBe("trust_failure");
    expect(alarm.suppressedResurrections).toHaveLength(1);
    expect(alarm.headline).toMatch(/rejected/i);
    expect(isTrustFailure(alarm)).toBe(true);
  });

  it("should never let a cold breach mask a suppressed one: the trust failure wins the status and keeps its own list", () => {
    breach("cold");
    breach("cold");
    breach("suppressed");

    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.total).toBe(3);
    expect(alarm.status).toBe("rejected_connection_resurrected");
    expect(alarm.severity).toBe("trust_failure");
    // Both bugs stay separately visible; neither is a filter someone has to
    // remember to apply.
    expect(alarm.suppressedResurrections).toHaveLength(1);
    expect(alarm.coldLookupFailures).toHaveLength(2);
    expect(alarm.headline).toMatch(/rejected/i);
  });

  it("should call a hot breach an outright broken check rather than a partition-blind one", () => {
    breach("hot");

    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.status).toBe("cold_lookup_broken");
    expect(alarm.brokenOutright).toHaveLength(1);
    expect(alarm.byExistingTier.hot).toBe(1);
  });

  it("should still count a breach whose tier was never recorded", () => {
    breach(null);

    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.total).toBe(1);
    expect(alarm.byExistingTier.unrecorded).toBe(1);
    expect(isInvariantBroken(alarm)).toBe(true);
  });

  it("should record that the store itself refuses a duplicate, so silence means the sweep swallowed the refusal", () => {
    const alarm = metrics.coldStoreAudit().alarm;

    expect(alarm.storeEnforced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.4 — the shape of the cold store.
// ---------------------------------------------------------------------------

describe("cold store shape", () => {
  it("should count what is down there and how old the oldest of it is", () => {
    const a = node();
    const b = node();
    const c = node();
    graph.demote(infer(a, b));
    clock.advance(3 * DAY_MS);
    graph.demote(infer(b, c));
    clock.advance(DAY_MS);

    const shape = metrics.coldStoreAudit().shape;

    expect(shape.edges).toBe(2);
    expect(shape.inferred).toBe(2);
    expect(shape.oldestAgeMs).toBe(4 * DAY_MS);
    expect(shape.timeInCold?.maxMs).toBe(4 * DAY_MS);
  });

  it("should derive when an edge entered cold from the stamp the move itself wrote", () => {
    const a = node();
    const b = node();
    const edge = infer(a, b);
    clock.advance(DAY_MS);
    graph.demote(edge);
    const enteredAt = instant(clock());
    clock.advance(DAY_MS);

    const shape = metrics.coldStoreAudit().shape;

    expect(shape.enteredBasis).toBe("moved_at");
    expect(shape.oldestEnteredAt).toBe(enteredAt);
  });

  it("should report the crossing rate per night and the net growth of the cold set", () => {
    nightOfDreaming({ night: "2026-08-06", demoted: 12 });
    nightOfDreaming({ night: "2026-08-07", demoted: 8 });

    const shape = metrics.coldStoreAudit().shape;

    expect(shape.crossingRatePerNight.value).toBeCloseTo(10);
    expect(shape.growthPerNight[0]).toMatchObject({ night: "2026-08-07", demoted: 8, net: 8 });
  });

  it("should report no crossing rate rather than a rate of zero when no night has run", () => {
    const shape = metrics.coldStoreAudit().shape;

    expect(shape.edges).toBe(0);
    expect(shape.oldestAgeMs).toBeNull();
    expect(shape.timeInCold).toBeNull();
    expect(shape.crossingRatePerNight.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syl-005.6.4 — the sample only he can judge.
// ---------------------------------------------------------------------------

describe("cold sample", () => {
  function fillCold(count: number): void {
    const hub = node();
    for (let index = 0; index < count; index += 1) {
      graph.demote(infer(hub, node(), { relation: `relation_${index}` }));
      clock.advance(60_000);
    }
  }

  it("should hand back cold edges with the reasoning that justified them, and both endpoint labels", () => {
    fillCold(1);

    const sample = metrics.coldSample(5);

    expect(sample).toHaveLength(1);
    expect(sample[0]?.reasoning).toMatch(/same week/);
    expect(sample[0]?.sourceLabel).toMatch(/fact/);
    expect(sample[0]?.targetLabel).toMatch(/fact/);
    expect(sample[0]?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("should return every cold edge when there are fewer than asked for, and never a hot one", () => {
    fillCold(2);
    infer(node(), node());

    const sample = metrics.coldSample(10);

    expect(sample).toHaveLength(2);
    expect(sample.every((edge) => edge.tier === "cold")).toBe(true);
  });

  it("should return a bounded handful of distinct edges when there are more than asked for", () => {
    fillCold(12);

    const sample = metrics.coldSample(4);

    expect(sample).toHaveLength(4);
    expect(new Set(sample.map((edge) => edge.id)).size).toBe(4);
  });

  it("should return nothing at all when the cold store is empty", () => {
    expect(metrics.coldSample(5)).toEqual([]);
  });

  it("should refuse a sample size that is not a positive whole number", () => {
    expect(() => metrics.coldSample(0)).toThrow(MetricsError);
    expect(() => metrics.coldSample(-3)).toThrow(MetricsError);
    expect(() => metrics.coldSample(1.5)).toThrow(MetricsError);
  });
});

// ---------------------------------------------------------------------------
// The whole surface, in one read.
// ---------------------------------------------------------------------------

describe("the full report", () => {
  it("should assemble every metric in one pass with the instant it was taken", () => {
    const a = node();
    const b = node();
    nightOfDreaming({ edges: [infer(a, b)], tokens: 100 });

    const report = metrics.report();

    expect(report.generatedAt).toBe(instant(NOW));
    expect(report.store.edges.inferred).toBe(1);
    expect(report.survival.cohorts).toHaveLength(1);
    expect(report.cold.alarm.status).toBe("holds");
    expect(report.engagement.surfaced).toBe(0);
  });

  it("should lead with the alarm, so the number that matters most is not buried", () => {
    const report = metrics.report();

    expect(Object.keys(report)[0]).toBe("alarm");
    expect(report.alarm).toBe(report.cold.alarm);
  });

  it("should read nothing and write nothing into the other store", () => {
    const a = node();
    const b = node();
    nightOfDreaming({ edges: [infer(a, b)] });
    const before = {
      nodes: database.handle.prepare("SELECT COUNT(*) AS c FROM memory_nodes").get(),
      edges: database.handle.prepare("SELECT COUNT(*) AS c FROM memory_edges").get(),
      sessions: database.handle.prepare("SELECT COUNT(*) AS c FROM dream_sessions").get(),
      reasoning: database.handle.prepare("SELECT COUNT(*) AS c FROM dream_edge_reasoning").get(),
    };

    metrics.report();
    metrics.coldSample(3);

    expect(database.handle.prepare("SELECT COUNT(*) AS c FROM memory_nodes").get()).toEqual(before.nodes);
    expect(database.handle.prepare("SELECT COUNT(*) AS c FROM memory_edges").get()).toEqual(before.edges);
    expect(database.handle.prepare("SELECT COUNT(*) AS c FROM dream_sessions").get()).toEqual(before.sessions);
    expect(database.handle.prepare("SELECT COUNT(*) AS c FROM dream_edge_reasoning").get()).toEqual(before.reasoning);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE NIGHTLY SWEEP MUST RECORD.
//
// Both describe what the SYSTEM must do, not what this module does. They were
// declared RED in `tests/expected-failures.json` while the dream did not run,
// and `backend/src/memory/dream/sweep.ts` (syl-005.4.2) is what made them pass:
// the sweep writes to BOTH stores as it works, and neither store writes to the
// other, so constraint 7 is untouched.
//
// They drive the real sweep against the real graph and the real log. Nothing
// here is stubbed, because the failure they exist to catch — an engine that
// changes the graph and tells the log nothing — is invisible to any test that
// writes the log rows by hand.
// ---------------------------------------------------------------------------

describe("what the nightly sweep must record", () => {
  it("should report tonight's floor crossings from the sweep that actually moved the edges", () => {
    const opened = session();
    const sweep = new DreamSweep({ graph, log, clock });
    const hub = node();
    for (let index = 0; index < 3; index += 1) {
      infer(hub, node(), {
        relation: `crosses_${index}`,
        demoteAfter: instant(clock() + 60_000),
      });
    }
    clock.advance(2 * 60_000);

    const moved = sweep.demote(opened.id);
    log.closeSession(opened.id, { outcome: "completed" });

    // The count is the `changes` the demotion statement already returned, so
    // recording it is free — and without it the growth of the cold set is
    // invisible however fast it grows.
    expect(moved).toBe(3);
    expect(metrics.coldStoreAudit().shape.edges).toBe(3);

    const tonight = metrics
      .coldStoreAudit()
      .shape.growthPerNight.find((entry) => entry.night === TONIGHT);

    expect(tonight?.demoted).toBe(3);
  });

  it("should see the edges the reflection engine actually wrote into the graph", () => {
    const opened = session();
    const sweep = new DreamSweep({ graph, log, clock });
    const a = node();
    const b = node();

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate: {
        sourceNode: a < b ? a : b,
        targetNode: a < b ? b : a,
        relation: "resembles",
        kernel: "related",
        symmetric: true,
        score: 0.82,
        existing: null,
      },
      verdict: {
        disposition: "created",
        reasoning: "both showed up in the same week and share a shape",
        confidence: 0.8,
      },
    });
    log.closeSession(opened.id, { outcome: "completed" });

    // Every edge the engine writes leaves a reasoning row saying why and on
    // which night, so survival, cost per kept edge and the astrology rate all
    // have something to read.
    const report = metrics.survival();

    expect(metrics.storeShape().edges.inferred).toBe(1);
    expect(report.hasEvidence).toBe(true);
    expect(report.cohorts.find((cohort) => cohort.night === TONIGHT)?.created).toBe(1);
  });
});
