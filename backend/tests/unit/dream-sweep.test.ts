import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DreamLog, type DreamSession } from "../../src/memory/dream/log.js";
import {
  CANDIDATE_KERNELS,
  CONTRADICT_RELATION,
  DreamSweep,
  RELATED_RELATION,
  SweepError,
  startOfLocalDay,
  type SweepCandidate,
} from "../../src/memory/dream/sweep.js";
import { MemoryGraph, type InferredEdge, type MemoryEdge } from "../../src/memory/graph.js";
import { EdgeWeights } from "../../src/memory/weights.js";
import { instant, type Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * Tier 1: the nightly sweep. `syl-005.4.2`.
 *
 * Everything runs against the real migrations and the real stores. The point of
 * this suite is the seams the bead calls out — the identity check that must span
 * every partition, the reactivation that must not become a duplicate, and the
 * counters that make a night readable afterwards — and every one of those is a
 * property of the store rather than of our types.
 */

// The kernels are mocked as passthroughs so the suite can assert on WHICH ones
// the sweep reaches for. `reason` and `probe` do not discriminate (syl-b97);
// wiring them in would feed the ranker noise dressed as signal, so "never
// called" is a behaviour worth a test rather than a comment.
vi.mock("../../src/memory/holographic-queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/holographic-queries.js")>();
  return {
    ...actual,
    related: vi.fn(actual.related),
    contradict: vi.fn(actual.contradict),
    reason: vi.fn(actual.reason),
    probe: vi.fn(actual.probe),
  };
});

const kernels = await import("../../src/memory/holographic-queries.js");

/** 2026-08-09T04:30Z — 23:30 on the 8th in Chicago, which is when Syl dreams. */
const NOW = Date.UTC(2026, 7, 9, 4, 30, 0, 0);
const CHICAGO = "America/Chicago";
const TONIGHT = "2026-08-08";
const CEILING = 4_000_000;
const DAY_MS = 24 * 60 * 60_000;

function steppingClock(start = NOW): Clock & { advance(ms: number): void; set(at: number): void } {
  let at = start;
  const clock = (() => at) as Clock & { advance(ms: number): void; set(at: number): void };
  clock.advance = (ms) => {
    at += ms;
  };
  clock.set = (to) => {
    at = to;
  };
  return clock;
}

let database: SylDatabase;
let clock: ReturnType<typeof steppingClock>;
let graph: MemoryGraph;
let weights: EdgeWeights;
let log: DreamLog;
let sweep: DreamSweep;
let opened: DreamSession;

beforeEach(() => {
  vi.mocked(kernels.related).mockClear();
  vi.mocked(kernels.contradict).mockClear();
  vi.mocked(kernels.reason).mockClear();
  vi.mocked(kernels.probe).mockClear();

  database = openDatabase({ path: IN_MEMORY });
  clock = steppingClock();
  graph = new MemoryGraph({ db: database.handle, clock });
  weights = new EdgeWeights({ graph, clock });
  log = new DreamLog({ db: database.handle, clock });
  sweep = new DreamSweep({ graph, log, weights, clock });
  opened = log.openSession({ tz: CHICAGO, tokenCeiling: CEILING, night: TONIGHT });
});

afterEach(() => {
  database.close();
});

let labelSeq = 0;

function node(label?: string, body?: string): string {
  labelSeq += 1;
  return graph.addNode({
    kind: "fact",
    label: label ?? `fact ${labelSeq}`,
    body: body ?? null,
  }).id;
}

function person(label: string): string {
  return graph.addNode({ kind: "person", label }).id;
}

function observe(a: string, b: string, relation = "mentions"): void {
  graph.observe({ sourceNode: a, targetNode: b, relation, assertedBy: sourceNode() });
}

let sourceCache: string | null = null;
function sourceNode(): string {
  sourceCache ??= graph.addNode({ kind: "source", label: "the Commander" }).id;
  return sourceCache;
}

beforeEach(() => {
  sourceCache = null;
  labelSeq = 0;
});

function infer(a: string, b: string, relation = RELATED_RELATION): InferredEdge {
  return graph.infer({
    sourceNode: a,
    targetNode: b,
    relation,
    reasoning: "an earlier night thought these belonged together",
    confidence: 0.7,
    weight: 0.9,
    demoteAfter: instant(clock() + DAY_MS),
  });
}

function run(): ReturnType<DreamSweep["run"]> {
  return sweep.run({ sessionId: opened.id, night: TONIGHT, tz: CHICAGO });
}

function candidateFor(a: string, b: string): SweepCandidate {
  return {
    sourceNode: a < b ? a : b,
    targetNode: a < b ? b : a,
    relation: RELATED_RELATION,
    kernel: "related",
    symmetric: true,
    score: 0.9,
    existing: null,
  };
}

// ---------------------------------------------------------------------------
// Seeding from the day
// ---------------------------------------------------------------------------

describe("DreamSweep.run: seeding", () => {
  it("should seed from the day rather than the whole past", async () => {
    clock.set(NOW - 40 * DAY_MS);
    const ancient = node("a thing from last month");
    clock.set(NOW);
    const today = node("a thing from today");

    const report = await run();

    expect(report.seeds.map((seed) => seed.id)).toContain(today);
    expect(report.seeds.map((seed) => seed.id)).not.toContain(ancient);
  });

  it("should propose nothing when the day added nothing", async () => {
    clock.set(NOW - 40 * DAY_MS);
    node("old one");
    node("old two");
    clock.set(NOW);

    const report = await run();

    expect(report.seeds).toEqual([]);
    expect(report.candidates).toEqual([]);
  });

  it("should bound the seed set, because the day is not a promise about size", async () => {
    for (let index = 0; index < 6; index += 1) node(`today ${index}`);
    const bounded = new DreamSweep({ graph, log, weights, clock, limits: { seedLimit: 2 } });

    const report = await bounded.run({ sessionId: opened.id, night: TONIGHT, tz: CHICAGO });

    expect(report.seeds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Which kernels may propose
// ---------------------------------------------------------------------------

describe("DreamSweep.run: the kernels it is allowed to use", () => {
  it("should never call reason or probe, which do not discriminate (syl-b97)", async () => {
    const ada = person("Ada");
    const one = node("the roof leaked");
    const two = node("the gutter was replaced");
    observe(one, ada);
    observe(two, ada);

    await run();

    expect(kernels.reason).not.toHaveBeenCalled();
    expect(kernels.probe).not.toHaveBeenCalled();
  });

  it("should declare only the kernels that discriminate", () => {
    expect([...CANDIDATE_KERNELS]).not.toContain("reason");
    expect([...CANDIDATE_KERNELS]).not.toContain("probe");
    expect([...CANDIDATE_KERNELS]).toContain("related");
    expect([...CANDIDATE_KERNELS]).toContain("contradict");
  });

  it("should propose a structural link that shares no keyword with its seed", async () => {
    const ada = person("Ada");
    const older = node("the roof leaked", "water came through the ceiling");
    observe(older, ada);
    clock.advance(60_000);
    const seed = node("the gutter was replaced", "new downpipe fitted");
    observe(seed, ada);

    const report = await run();

    expect(kernels.related).toHaveBeenCalled();
    const pair = report.candidates.find(
      (candidate) =>
        candidate.kernel === "related" &&
        [candidate.sourceNode, candidate.targetNode].includes(older) &&
        [candidate.sourceNode, candidate.targetNode].includes(seed),
    );
    expect(pair).toBeDefined();
    expect(pair?.relation).toBe(RELATED_RELATION);
  });

  it("should ask contradict for pairs that talk about the same things", async () => {
    const ada = person("Ada");
    const older = node("the backend restarts cleanly");
    observe(older, ada);
    clock.advance(60_000);
    const seed = node("nothing about restarting ever works here at all");
    observe(seed, ada);

    const report = await run();

    expect(kernels.contradict).toHaveBeenCalled();
    for (const candidate of report.candidates) {
      if (candidate.kernel === "contradict") {
        expect(candidate.relation).toBe(CONTRADICT_RELATION);
      }
    }
  });

  it("should take proposals from an embedding proposer as well", async () => {
    clock.set(NOW - 40 * DAY_MS);
    const older = node("an old memory nothing structural connects");
    clock.set(NOW);
    const seed = node("tonight's memory");

    const semantic = new DreamSweep({
      graph,
      log,
      weights,
      clock,
      semantic: {
        near: async () => [{ nodeId: older, similarity: 0.91 }],
      },
    });
    const report = await semantic.run({ sessionId: opened.id, night: TONIGHT, tz: CHICAGO });

    const pair = report.candidates.find((candidate) => candidate.kernel === "embedding");
    expect(pair).toBeDefined();
    expect([pair?.sourceNode, pair?.targetNode].sort()).toEqual([older, seed].sort());
  });

  it("should never propose a node against itself", async () => {
    const seed = node("only one thing happened today");
    const semantic = new DreamSweep({
      graph,
      log,
      weights,
      clock,
      semantic: { near: async () => [{ nodeId: seed, similarity: 1 }] },
    });

    const report = await semantic.run({ sessionId: opened.id, night: TONIGHT, tz: CHICAGO });

    expect(report.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The demotion pass, and telling the log about it
// ---------------------------------------------------------------------------

describe("DreamSweep.demote", () => {
  it("should record tonight's floor crossings on the session that made them", () => {
    const hub = node();
    for (let index = 0; index < 3; index += 1) {
      graph.infer({
        sourceNode: hub,
        targetNode: node(),
        relation: `crosses_${index}`,
        reasoning: "due to cross",
        confidence: 0.5,
        weight: 0.5,
        demoteAfter: instant(clock() + 60_000),
      });
    }
    clock.advance(2 * 60_000);

    const moved = sweep.demote(opened.id);

    expect(moved).toBe(3);
    expect(log.session(opened.id)?.edgesDemoted).toBe(3);
  });

  it("should clear the crossing stamp on every edge it moves", () => {
    const edge = graph.infer({
      sourceNode: node(),
      targetNode: node(),
      relation: "crosses",
      reasoning: "due to cross",
      confidence: 0.5,
      weight: 0.5,
      demoteAfter: instant(clock() + 60_000),
    });
    clock.advance(2 * 60_000);

    sweep.demote(opened.id);

    const after = graph.getEdge(edge.id) as InferredEdge;
    expect(after.tier).toBe("cold");
    expect(after.demoteAfter).toBeNull();
  });

  it("should report zero, and say so, when nothing crossed", () => {
    infer(node(), node());

    expect(sweep.demote(opened.id)).toBe(0);
    expect(log.session(opened.id)?.edgesDemoted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The identity check, which must span every partition
// ---------------------------------------------------------------------------

describe("DreamSweep: the identity check spans every tier", () => {
  it("should see a cold edge when it re-proposes one", async () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    graph.demote(existing);

    const found = sweep.identityOf(candidateFor(a, b));

    expect(found?.id).toBe(existing.id);
    expect(found?.tier).toBe("cold");
  });

  it("should see a suppressed edge when it re-proposes one", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    graph.suppress(existing);

    expect(sweep.identityOf(candidateFor(a, b))?.tier).toBe("suppressed");
  });

  it("should match a symmetric relation written the other way round", () => {
    const a = node("first");
    const b = node("second");
    const existing = graph.infer({
      sourceNode: b,
      targetNode: a,
      relation: RELATED_RELATION,
      reasoning: "written the other way round",
      confidence: 0.6,
      weight: 0.9,
      demoteAfter: instant(clock() + DAY_MS),
    });

    expect(sweep.identityOf(candidateFor(a, b))?.id).toBe(existing.id);
  });
});

// ---------------------------------------------------------------------------
// Applying a verdict
// ---------------------------------------------------------------------------

describe("DreamSweep.applyVerdict", () => {
  it("should write a new edge carrying its reasoning, and log the same reasoning", () => {
    const a = node("first");
    const b = node("second");

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "both are about the same leak", confidence: 0.8 },
    });

    const edge = graph.getEdge(applied.edge?.id ?? "") as InferredEdge;
    expect(edge.kind).toBe("inferred");
    expect(edge.reasoning).toBe("both are about the same leak");
    expect(edge.tier).toBe("hot");
    expect(edge.demoteAfter).not.toBeNull();

    const rows = log.reasoningOf(opened.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.disposition).toBe("created");
    expect(rows[0]?.edgeId).toBe(edge.id);
    expect(rows[0]?.tierAfter).toBe("hot");
    expect(log.session(opened.id)?.edgesCreated).toBe(1);
  });

  it("should keep a rejection, because the refusals are what make the rate readable", () => {
    const a = node("first");
    const b = node("second");

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "rejected", reasoning: "same person, nothing else in common" },
    });

    const rows = log.reasoningOf(opened.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.disposition).toBe("rejected");
    expect(rows[0]?.edgeId).toBeNull();
    expect(graph.edgesBetween(a, b)).toEqual([]);
    expect(log.session(opened.id)?.candidatesJudged).toBe(1);
    expect(log.session(opened.id)?.edgesCreated).toBe(0);
  });

  it("should reactivate a dormant edge rather than insert a second one", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    graph.demote(existing);
    clock.advance(DAY_MS);

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "the dream found this again", confidence: 0.8 },
    });

    expect(applied.disposition).toBe("reactivated");
    expect(applied.edge?.id).toBe(existing.id);
    expect(applied.edge?.tier).toBe("hot");
    expect(graph.edgesBetween(a, b)).toHaveLength(1);
    expect(log.session(opened.id)?.edgesReactivated).toBe(1);
    expect(log.session(opened.id)?.edgesCreated).toBe(0);
    expect(log.duplicatesOf(opened.id)).toEqual([]);
  });

  it("should lift a reactivated edge to the law's floor rather than scale it", () => {
    const a = node("first");
    const b = node("second");
    const existing = graph.infer({
      sourceNode: a,
      targetNode: b,
      relation: RELATED_RELATION,
      reasoning: "an old faint thought",
      confidence: 0.4,
      weight: 0.06,
      demoteAfter: instant(clock() + 60_000),
    });
    clock.advance(2 * 60_000);
    sweep.demote(opened.id);
    clock.advance(90 * DAY_MS);

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "rediscovered", confidence: 0.8 },
    });

    expect(applied.edge?.weight).toBeGreaterThanOrEqual(weights.law.touch.traversal.floor);
    expect(applied.edge?.id).toBe(existing.id);
  });

  it("should refuse to resurrect a connection the Commander rejected", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    weights.reject(existing);

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "the dream wants this back", confidence: 0.9 },
    });

    expect(applied.disposition).toBe("rejected");
    expect(graph.getEdge(existing.id)?.tier).toBe("suppressed");
    const rows = log.reasoningOf(opened.id);
    expect(rows[0]?.tierBefore).toBe("suppressed");
    expect(rows[0]?.reasoning).toContain("suppressed");
  });

  it("should suppress an existing edge when the judgment says it is wrong", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "suppressed", reasoning: "this was a coincidence, not a connection" },
    });

    expect(applied.edge?.tier).toBe("suppressed");
    expect(graph.getEdge(existing.id)?.tier).toBe("suppressed");
    expect(log.session(opened.id)?.edgesSuppressed).toBe(1);
  });

  it("should refuse to suppress a connection that does not exist", () => {
    const a = node("first");
    const b = node("second");

    expect(() =>
      sweep.applyVerdict({
        sessionId: opened.id,
        candidate: candidateFor(a, b),
        verdict: { disposition: "suppressed", reasoning: "nothing is here to suppress" },
      }),
    ).toThrow(SweepError);
  });

  it("should refuse a verdict that cannot say why", () => {
    const a = node("first");
    const b = node("second");

    expect(() =>
      sweep.applyVerdict({
        sessionId: opened.id,
        candidate: candidateFor(a, b),
        verdict: { disposition: "created", reasoning: "   " },
      }),
    ).toThrow(SweepError);
    expect(graph.edgesBetween(a, b)).toEqual([]);
  });

  it("should leave the counters agreeing with the rows underneath them", () => {
    const a = node("first");
    const b = node("second");
    const c = node("third");

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "a real one", confidence: 0.8 },
    });
    sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, c),
      verdict: { disposition: "rejected", reasoning: "not a real one" },
    });

    expect(log.reconcile(opened.id).agrees).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The zero invariant: what the sweep does when the store refuses a duplicate
// ---------------------------------------------------------------------------

/**
 * A graph whose pair lookup lies, which is the bug the invariant exists to
 * catch: a check that misses a dormant edge because it asked the wrong
 * question. The store still refuses the insert — `memory_edges_identity_idx` is
 * UNIQUE across every partition — so the breach can only ever appear in the
 * dream log, put there by the sweep.
 *
 * A `Proxy` rather than `Object.create`: `MemoryGraph`'s state lives in private
 * fields, and a method called on a prototype-linked object is not an instance,
 * so every real call would throw before reaching the store.
 */
function graphWithBlindIdentity(realGraph: MemoryGraph, blindTo: () => boolean): MemoryGraph {
  return new Proxy(realGraph, {
    get(target, property) {
      if (property === "edgesBetween") {
        return (...args: Parameters<MemoryGraph["edgesBetween"]>) =>
          blindTo() ? [] : target.edgesBetween(...args);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("DreamSweep: when the store refuses a duplicate", () => {
  it("should record the breach rather than swallow it", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    graph.demote(existing);

    let blind = true;
    const blindSweep = new DreamSweep({
      graph: graphWithBlindIdentity(graph, () => blind),
      log,
      weights,
      clock,
    });

    const applied = blindSweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "a rediscovery a broken lookup missed" },
    });
    blind = false;

    const breaches = log.duplicatesOf(opened.id);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.existingEdgeId).toBe(existing.id);
    expect(breaches[0]?.existingTier).toBe("cold");
    expect(breaches[0]?.insertedEdgeId).toBeNull();
    expect(log.session(opened.id)?.duplicateEdgeInserts).toBe(1);
    expect(applied.duplicateRecorded).toBe(true);
    expect(graph.edgesBetween(a, b)).toHaveLength(1);
  });

  it("should distinguish a suppressed clash, which is a trust failure and not a bug", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    weights.reject(existing);

    let blind = true;
    const blindSweep = new DreamSweep({
      graph: graphWithBlindIdentity(graph, () => blind),
      log,
      weights,
      clock,
    });

    blindSweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "the dream tried to bring back a rejection" },
    });
    blind = false;

    const breaches = log.duplicatesOf(opened.id);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.existingTier).toBe("suppressed");
    expect(breaches[0]?.note).toContain("rejected");
    expect(graph.getEdge(existing.id)?.tier).toBe("suppressed");
  });

  it("should still reactivate the edge it collided with, so the night is not lost", () => {
    const a = node("first");
    const b = node("second");
    const existing = infer(a, b);
    graph.demote(existing);

    let blind = true;
    const blindSweep = new DreamSweep({
      graph: graphWithBlindIdentity(graph, () => blind),
      log,
      weights,
      clock,
    });

    const applied = blindSweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: { disposition: "created", reasoning: "a rediscovery a broken lookup missed" },
    });
    blind = false;

    expect(applied.disposition).toBe("reactivated");
    expect(graph.getEdge(existing.id)?.tier).toBe("hot");
  });
});

// ---------------------------------------------------------------------------
// Constraint 7: the log is telemetry ABOUT the graph, never written INTO it
// ---------------------------------------------------------------------------

describe("DreamSweep: the log is not memory", () => {
  it("should never put a dream id into the graph", async () => {
    const ada = person("Ada");
    const one = node("the roof leaked");
    const two = node("the gutter was replaced");
    observe(one, ada);
    observe(two, ada);

    const report = await run();
    for (const candidate of report.candidates) {
      sweep.applyVerdict({
        sessionId: opened.id,
        candidate,
        verdict: { disposition: "created", reasoning: "judged real", confidence: 0.8 },
      });
    }

    const nodeRows = database.handle
      .prepare("SELECT id, label, body, subject_id FROM memory_nodes")
      .all() as unknown as { id: string; label: string; body: string | null; subject_id: string | null }[];
    for (const row of nodeRows) {
      expect(JSON.stringify(row)).not.toContain(opened.id);
      expect(JSON.stringify(row)).not.toContain("dream_session");
    }

    const edgeRows = database.handle
      .prepare("SELECT id, reasoning, asserted_by FROM memory_edges")
      .all() as unknown as { id: string; reasoning: string | null; asserted_by: string | null }[];
    for (const row of edgeRows) {
      expect(row.id.startsWith("syl:memory_edge:")).toBe(true);
      expect(JSON.stringify(row)).not.toContain(opened.id);
    }
  });

  it("should record what it proposed on the session, not in the graph", async () => {
    const ada = person("Ada");
    const one = node("the roof leaked");
    observe(one, ada);
    clock.advance(60_000);
    const two = node("the gutter was replaced");
    observe(two, ada);

    const report = await run();

    expect(log.session(opened.id)?.candidatesProposed).toBe(report.candidates.length);
  });
});

// ---------------------------------------------------------------------------
// The local day boundary
// ---------------------------------------------------------------------------

describe("startOfLocalDay", () => {
  it("should resolve a calendar date in a zone to the instant that day began", () => {
    expect(startOfLocalDay("2026-08-08", CHICAGO)).toBe(Date.UTC(2026, 7, 8, 5, 0, 0, 0));
  });

  it("should follow the zone across a DST boundary rather than a fixed offset", () => {
    // 2026-11-01 is the US fall-back: Chicago is UTC-5 before it and UTC-6 after.
    expect(startOfLocalDay("2026-10-31", CHICAGO)).toBe(Date.UTC(2026, 9, 31, 5, 0, 0, 0));
    expect(startOfLocalDay("2026-11-02", CHICAGO)).toBe(Date.UTC(2026, 10, 2, 6, 0, 0, 0));
  });

  it("should refuse a fixed offset, which is a property of an instant and not of a place", () => {
    expect(() => startOfLocalDay("2026-08-08", "+05:00")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A candidate carries what the judgment needs
// ---------------------------------------------------------------------------

describe("DreamSweep.run: what a candidate carries", () => {
  it("should annotate a candidate with the edge that already joins the pair", async () => {
    const ada = person("Ada");
    const older = node("the roof leaked");
    observe(older, ada);
    clock.advance(60_000);
    const seed = node("the gutter was replaced");
    observe(seed, ada);
    const existing = infer(older < seed ? older : seed, older < seed ? seed : older);
    graph.demote(existing);

    const report = await run();

    const pair = report.candidates.find(
      (candidate) =>
        [candidate.sourceNode, candidate.targetNode].includes(older) &&
        [candidate.sourceNode, candidate.targetNode].includes(seed) &&
        candidate.relation === RELATED_RELATION,
    );
    expect(pair?.existing?.id).toBe(existing.id);
    expect(pair?.existing?.tier).toBe("cold");
  });

  it("should not propose the same pair twice from two kernels", async () => {
    const ada = person("Ada");
    const older = node("the backend restarts cleanly");
    observe(older, ada);
    clock.advance(60_000);
    const seed = node("nothing about restarting works");
    observe(seed, ada);

    const report = await run();

    const keys = report.candidates.map(
      (candidate) => `${candidate.sourceNode}|${candidate.targetNode}|${candidate.relation}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("should bound how many candidates one night hands to the judgment", async () => {
    const ada = person("Ada");
    for (let index = 0; index < 8; index += 1) {
      const created = node(`thing ${index}`);
      observe(created, ada);
    }
    const bounded = new DreamSweep({
      graph,
      log,
      weights,
      clock,
      limits: { maxCandidates: 3 },
    });

    const report = await bounded.run({ sessionId: opened.id, night: TONIGHT, tz: CHICAGO });

    expect(report.candidates.length).toBeLessThanOrEqual(3);
  });
});

describe("DreamSweep: a candidate the graph cannot carry", () => {
  it("should not let one bad candidate end the night", () => {
    const a = node("first");
    const gone = "syl:memory_node:00000000-0000-4000-8000-000000000000";

    expect(() =>
      sweep.applyVerdict({
        sessionId: opened.id,
        candidate: { ...candidateFor(a, gone), sourceNode: a, targetNode: gone },
        verdict: { disposition: "created", reasoning: "an endpoint that is not there" },
      }),
    ).toThrow(SweepError);
  });
});

/** Keeps the unused-import checker honest about the type-only import. */
export type { MemoryEdge };
