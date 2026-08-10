import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Embedder } from "../../src/memory/embed.js";
import { MemoryGraph, type MemoryEdge } from "../../src/memory/graph.js";
import {
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_TRUST,
  FUSION_WEIGHTS,
  MAX_TRUST,
  MIN_TRUST,
  RETRIEVAL_CHANNELS,
  RetrievalError,
  Retriever,
  TRUST_STEP,
  decay,
  finalScore,
  fuse,
  normaliseKeyword,
  trustAfterFeedback,
} from "../../src/memory/retrieve.js";
import { MemoryStore, loadSqliteVec } from "../../src/memory/store.js";
import { fixedClock } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * Fusion, trust, decay and traversal — against the real migrations and the real
 * `vec0`, and against NO model.
 *
 * `embed.ts` already established the seam: the download lives behind
 * `loadExtractor`, and anything that needs real weights sits behind
 * `SYL_EMBED_LIVE=1`. The same rule holds here one layer up. The `Embedder`
 * interface is what `Retriever` depends on, so a hand-written one makes every
 * ranking assertion below exact instead of approximate — a fake embedder that
 * returns a chosen vector is not a weaker test than the real model, it is a
 * different and sharper one: it can prove that a cosine of 0.6 contributes
 * exactly 0.3 * 0.6, which no real model could ever be pinned to.
 *
 * What a fake CANNOT tell you is whether the ranking is any good on real text.
 * That is `memory-retrieve-live.test.ts`.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const DIMENSIONS = 4;

let db: Database;
let graph: MemoryGraph;
let store: MemoryStore;

function unit(...values: number[]): number[] {
  const padded = [...values, ...Array(Math.max(0, DIMENSIONS - values.length)).fill(0)];
  const magnitude = Math.sqrt(padded.reduce((sum, v) => sum + v * v, 0));
  return padded.map((v) => v / magnitude);
}

/**
 * An embedder that returns whatever the test says, and downloads nothing.
 *
 * Deliberately implements the same interface production uses, so a change to
 * `Embedder` breaks this rather than letting the two drift apart.
 */
function fakeEmbedder(query: number[]): Embedder {
  return {
    model: { id: "fake" } as Embedder["model"],
    dimensions: DIMENSIONS,
    embedQuery: async () => query,
    embedDocuments: async () => [],
    device: async () => ({ device: "cpu", fellBack: false, reason: "fake" }),
  };
}

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY, { allowExtension: true });
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  loadSqliteVec(db);
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  store = new MemoryStore({ db, dimensions: DIMENSIONS, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

function retriever(embedder?: Embedder): Retriever {
  const options = {
    db,
    store,
    graph,
    clock: fixedClock(NOW),
    ...(embedder === undefined ? {} : { embedder }),
  };
  return new Retriever(options);
}

describe("the fusion weights", () => {
  it("should be the three the bead fixes, summing to 1.0", () => {
    expect(FUSION_WEIGHTS).toEqual({ keyword: 0.4, overlap: 0.3, holographic: 0.3 });
    const total = RETRIEVAL_CHANNELS.reduce((sum, c) => sum + FUSION_WEIGHTS[c], 0);
    expect(total).toBeCloseTo(1, 12);
  });
});

describe("fuse", () => {
  it("should weight all three channels when all three contributed", () => {
    const fused = fuse({ keyword: 1, overlap: 1, holographic: 1 });
    expect(fused.relevance).toBeCloseTo(1, 12);
    expect(fused.ceiling).toBeCloseTo(1, 12);
    expect(fused.channels).toEqual(["keyword", "overlap", "holographic"]);
  });

  it("should let an absent channel contribute ZERO and NOT renormalise", () => {
    // The decision this test exists for. Renormalising would report 0.8/1.0 —
    // one weak vote reading as unanimity, and a score that means something
    // different from one query to the next.
    const fused = fuse({ keyword: 1, overlap: 1 });
    expect(fused.relevance).toBeCloseTo(0.7, 12);
    expect(fused.ceiling).toBeCloseTo(0.7, 12);
    expect(fused.channels).toEqual(["keyword", "overlap"]);
  });

  it("should distinguish a channel that found nothing from one that was absent", () => {
    // A present zero means "it looked"; an absent key means "it could not".
    const looked = fuse({ keyword: 1, overlap: 0 });
    const absent = fuse({ keyword: 1 });

    expect(looked.relevance).toBeCloseTo(absent.relevance, 12);
    expect(looked.ceiling).toBeCloseTo(0.7, 12);
    expect(absent.ceiling).toBeCloseTo(0.4, 12);
    expect(looked.channels).toEqual(["keyword", "overlap"]);
  });

  it("should leave the ORDERING of one query's candidates untouched by the missing weight", () => {
    // Why zero-contribution is safe: within a query every candidate loses the
    // same 0.3, so the only thing retrieval is actually for survives intact.
    const withHolo = [0.9, 0.4].map((k) => fuse({ keyword: k, holographic: 1 }).relevance);
    const without = [0.9, 0.4].map((k) => fuse({ keyword: k }).relevance);
    expect(withHolo[0]).toBeGreaterThan(withHolo[1] as number);
    expect(without[0]).toBeGreaterThan(without[1] as number);
  });

  it("should return a zero relevance and a zero ceiling when nothing contributed", () => {
    expect(fuse({})).toEqual({ relevance: 0, channels: [], ceiling: 0 });
  });

  it("should clamp a contribution outside [0, 1] rather than throw mid-ranking", () => {
    expect(fuse({ keyword: 1.0000001 }).relevance).toBeCloseTo(0.4, 12);
    expect(fuse({ keyword: -3 }).relevance).toBe(0);
    expect(fuse({ keyword: Number.NaN }).relevance).toBe(0);
  });

  it("should report channels in formula order regardless of insertion order", () => {
    expect(fuse({ holographic: 1, keyword: 1 }).channels).toEqual(["keyword", "holographic"]);
  });
});

describe("normaliseKeyword", () => {
  it("should score the best hit 1.0 and the rest a fraction of it", () => {
    // FTS5 negates BM25: more negative is better.
    expect(normaliseKeyword(-2, -2)).toBe(1);
    expect(normaliseKeyword(-1, -2)).toBeCloseTo(0.5, 12);
  });

  it("should score a lone hit 1.0, since there is nothing it could be worse than", () => {
    expect(normaliseKeyword(-0.0001, -0.0001)).toBe(1);
  });

  it("should yield zero when FTS5 found no signal at all", () => {
    expect(normaliseKeyword(-1, 0)).toBe(0);
    expect(normaliseKeyword(Number.NaN, -2)).toBe(0);
  });
});

describe("decay", () => {
  it("should halve a memory's weight after exactly one half-life", () => {
    expect(decay(DEFAULT_HALF_LIFE_MS)).toBeCloseTo(0.5, 12);
    expect(decay(2 * DEFAULT_HALF_LIFE_MS)).toBeCloseTo(0.25, 12);
    expect(decay(0)).toBe(1);
  });

  it("should approach zero asymptotically and never arrive", () => {
    // Same shape and same reason as the edge weight law: a memory that decayed
    // to exactly zero could never be brought back by anything.
    const ancient = decay(200 * DEFAULT_HALF_LIFE_MS);
    expect(ancient).toBeGreaterThan(0);
    expect(ancient).toBeLessThan(1e-50);
  });

  it("should never inflate a score when a clock skew puts a stamp in the future", () => {
    expect(decay(-1000)).toBe(1);
  });

  it("should refuse a half-life that is not a positive duration", () => {
    expect(() => decay(1000, 0)).toThrow(RetrievalError);
    expect(() => decay(1000, -5)).toThrow(/positive number of milliseconds/u);
  });
});

describe("trustAfterFeedback", () => {
  it("should nudge trust up on helpful", () => {
    expect(trustAfterFeedback(0.5, "helpful")).toBeCloseTo(0.55, 12);
  });

  it("should push trust down TWICE AS HARD on unhelpful", () => {
    // The asymmetry, stated the only way it is true everywhere: in log space
    // the down-step is exactly twice the up-step, at EVERY trust level.
    for (const trust of [0.9, 0.6, 0.3, 0.1]) {
      const up = Math.log(trustAfterFeedback(trust, "helpful") / trust);
      const down = Math.log(trustAfterFeedback(trust, "unhelpful") / trust);
      expect(down).toBeCloseTo(-2 * up, 12);
    }
  });

  it("should punish harder than it rewards by the same ratio at EVERY trust level", () => {
    // The geometric law's absolute ratio is constant — (1 - 1/s^2)/(s - 1) —
    // and independent of t. Measured at 1.7355:1 for s = 1.1.
    const ratios = [0.9, 0.6, 0.3, 0.1].map((trust) => {
      const up = trustAfterFeedback(trust, "helpful") - trust;
      const down = trust - trustAfterFeedback(trust, "unhelpful");
      return down / up;
    });
    for (const ratio of ratios) expect(ratio).toBeCloseTo(1.7355371900826446, 10);
  });

  it("should NOT be the linear form, which inverts the asymmetry at low trust", () => {
    // The tempting alternative, `t + s(1-t)` up and `t - 2s*t` down, is 2:1
    // only at t = 0.5. Computed here rather than described, because the failure
    // is not that it drifts — it REVERSES: at t = 0.1 it rewards more than it
    // punishes, which is the opposite of what was asked for.
    const s = 0.1;
    const linear = (t: number): number => (t - (t - 2 * s * t)) / (t + s * (1 - t) - t);

    expect(linear(0.9)).toBeCloseTo(18, 6);
    expect(linear(0.5)).toBeCloseTo(2, 6);
    expect(linear(0.1)).toBeLessThan(1); // punishes LESS than it rewards

    // The shipped law does no such thing at the same point.
    const up = trustAfterFeedback(0.1, "helpful") - 0.1;
    const down = 0.1 - trustAfterFeedback(0.1, "unhelpful");
    expect(down / up).toBeGreaterThan(1.7);
  });

  it("should never exceed the ceiling, so trust cannot inflate a relevance", () => {
    expect(trustAfterFeedback(MAX_TRUST, "helpful")).toBe(MAX_TRUST);
    expect(trustAfterFeedback(0.99, "helpful")).toBe(MAX_TRUST);
  });

  it("should never reach zero, so a memory can always be re-earned", () => {
    let trust = DEFAULT_TRUST;
    for (let i = 0; i < 100; i += 1) trust = trustAfterFeedback(trust, "unhelpful");
    expect(trust).toBe(MIN_TRUST);
    expect(trust).toBeGreaterThan(0);

    // And it climbs back out.
    expect(trustAfterFeedback(trust, "helpful")).toBeGreaterThan(MIN_TRUST);
  });

  it("should take about twice as many verdicts to recover as to fall", () => {
    let trust = DEFAULT_TRUST;
    let falls = 0;
    while (trust > MIN_TRUST) {
      trust = trustAfterFeedback(trust, "unhelpful");
      falls += 1;
    }
    let climbs = 0;
    while (trust < MAX_TRUST) {
      trust = trustAfterFeedback(trust, "helpful");
      climbs += 1;
    }
    expect(falls).toBe(15);
    expect(climbs).toBe(32);
  });

  it("should refuse a trust outside (0, 1]", () => {
    expect(() => trustAfterFeedback(0, "helpful")).toThrow(/pruning with extra steps/u);
    expect(() => trustAfterFeedback(1.5, "helpful")).toThrow(RetrievalError);
  });

  it("should refuse a verdict that is not one of the two", () => {
    expect(() => trustAfterFeedback(0.5, "meh" as never)).toThrow(/not a verdict/u);
  });

  it("should move by the declared step", () => {
    expect(TRUST_STEP).toBe(1.1);
    expect(trustAfterFeedback(0.4, "helpful")).toBeCloseTo(0.4 * 1.1, 12);
    expect(trustAfterFeedback(0.4, "unhelpful")).toBeCloseTo(0.4 / 1.21, 12);
  });
});

describe("finalScore", () => {
  it("should be the product of the three terms", () => {
    expect(finalScore(0.8, 0.5, 0.25)).toBeCloseTo(0.1, 12);
  });

  it("should be zeroed by nothing, since every term is bounded away from zero", () => {
    expect(finalScore(0.7, MIN_TRUST, decay(10 * DEFAULT_HALF_LIFE_MS))).toBeGreaterThan(0);
  });
});

describe("Retriever.retrieve", () => {
  it("should rank on keyword alone when there is no embedder and no entity", () => {
    return (async () => {
      const chicago = graph.addNode({
        kind: "memory",
        label: "Chicago",
        body: "chicago chicago chicago",
      });
      graph.addNode({ kind: "memory", label: "Denver", body: "a passing mention of chicago" });

      const result = await retriever().retrieve({ text: "chicago", depth: 0 });

      expect(result.channels).toEqual(["keyword"]);
      expect(result.ceiling).toBeCloseTo(0.4, 12);
      expect(result.entries[0]?.node.id).toBe(chicago.id);
      // Best hit, keyword only: 0.4 * 1.0 * DEFAULT_TRUST * decay(0).
      expect(result.entries[0]?.relevance).toBeCloseTo(0.4, 12);
      expect(result.entries[0]?.score).toBeCloseTo(0.4 * DEFAULT_TRUST, 12);
    })();
  });

  it("should add the overlap channel when an embedder is present", async () => {
    const node = graph.addNode({ kind: "memory", label: "Chicago" });
    store.putVector(node.id, unit(0.6, 0.8, 0, 0));

    const result = await retriever(fakeEmbedder(unit(1, 0, 0, 0))).retrieve({
      text: "chicago",
      depth: 0,
    });

    expect(result.channels).toEqual(["keyword", "overlap"]);
    expect(result.ceiling).toBeCloseTo(0.7, 12);
    // 0.4 * 1 (sole keyword hit) + 0.3 * 0.6 (the measured cosine).
    expect(result.entries[0]?.relevance).toBeCloseTo(0.4 + 0.3 * 0.6, 5);
    expect(result.entries[0]?.contributions.overlap).toBeCloseTo(0.6, 5);
  });

  it("should surface a memory the embedder finds and the keyword misses", async () => {
    // The whole reason to fuse: `automobile` shares no token with `car`.
    const semantic = graph.addNode({ kind: "memory", label: "the automobile" });
    store.putVector(semantic.id, unit(1, 0, 0, 0));

    const result = await retriever(fakeEmbedder(unit(1, 0, 0, 0))).retrieve({
      text: "car",
      depth: 0,
    });

    expect(result.entries.map((e) => e.node.id)).toEqual([semantic.id]);
    expect(result.entries[0]?.contributions.keyword).toBeUndefined();
    expect(result.entries[0]?.channels).toEqual(["overlap"]);
  });

  it("should add the holographic channel only when the query names an entity", async () => {
    const node = graph.addNode({ kind: "memory", label: "Chicago", body: "the trip" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    const subject = retriever(fakeEmbedder(unit(1, 0, 0, 0)));

    const without = await subject.retrieve({ text: "chicago", depth: 0 });
    expect(without.channels).toEqual(["keyword", "overlap"]);
    expect(without.ceiling).toBeCloseTo(0.7, 12);

    const with_ = await subject.retrieve({ text: "chicago", entities: ["Chicago"], depth: 0 });
    expect(with_.channels).toEqual(["keyword", "overlap", "holographic"]);
    expect(with_.ceiling).toBeCloseTo(1, 12);
    expect(with_.entries[0]?.contributions.holographic).toBeGreaterThan(0);
  });

  it("should not let a blank entity list open the holographic channel", async () => {
    graph.addNode({ kind: "memory", label: "Chicago" });
    const result = await retriever().retrieve({
      text: "chicago",
      entities: ["  ", ""],
      depth: 0,
    });
    expect(result.channels).toEqual(["keyword"]);
  });

  it("should rank a trusted memory above an equally relevant distrusted one", async () => {
    const trusted = graph.addNode({ kind: "memory", label: "chicago one" });
    const distrusted = graph.addNode({ kind: "memory", label: "chicago two" });

    const subject = retriever();
    for (let i = 0; i < 5; i += 1) subject.recordFeedback(distrusted.id, "unhelpful");

    const result = await subject.retrieve({ text: "chicago", depth: 0 });
    expect(result.entries[0]?.node.id).toBe(trusted.id);
    expect(result.entries[0]?.trust).toBe(DEFAULT_TRUST);
    expect(result.entries[1]?.node.id).toBe(distrusted.id);
    expect(result.entries[1]?.trust).toBeLessThan(DEFAULT_TRUST);
  });

  it("should rank a fresh memory above an equally relevant ancient one", async () => {
    const fresh = graph.addNode({ kind: "memory", label: "chicago one" });
    const ancient = graph.addNode({ kind: "memory", label: "chicago two" });
    const longAgo = new Date(NOW - 3 * DEFAULT_HALF_LIFE_MS).toISOString();
    db.prepare("UPDATE memory_nodes SET created_at = ?, updated_at = ? WHERE id = ?").run(
      longAgo,
      longAgo,
      ancient.id,
    );

    const result = await retriever().retrieve({ text: "chicago", depth: 0 });
    expect(result.entries[0]?.node.id).toBe(fresh.id);
    expect(result.entries[0]?.decay).toBeCloseTo(1, 12);
    expect(result.entries[1]?.decay).toBeCloseTo(0.125, 6);
  });

  it("should never return a memory the graph has moved out of the hot tier", async () => {
    const node = graph.addNode({ kind: "memory", label: "the Q1 plan" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(node.id);

    const result = await retriever(fakeEmbedder(unit(1, 0, 0, 0))).retrieve({
      text: "q1 plan",
      depth: 0,
    });
    expect(result.entries).toEqual([]);
  });

  it("should narrow to one node kind", async () => {
    graph.addNode({ kind: "memory", label: "chicago trip" });
    const person = graph.addNode({ kind: "person", label: "chicago jane" });

    const result = await retriever().retrieve({ text: "chicago", kind: "person", depth: 0 });
    expect(result.entries.map((e) => e.node.id)).toEqual([person.id]);
  });

  it("should honour its limit", async () => {
    for (let i = 0; i < 5; i += 1) graph.addNode({ kind: "memory", label: `chicago ${i}` });
    const result = await retriever().retrieve({ text: "chicago", limit: 2, depth: 0 });
    expect(result.entries).toHaveLength(2);
  });

  it("should return nothing, and no channels, for a query with no searchable token", async () => {
    graph.addNode({ kind: "memory", label: "chicago" });
    const result = await retriever().retrieve({ text: "  !!  ", depth: 0 });
    expect(result.entries).toEqual([]);
    expect(result.channels).toEqual([]);
    expect(result.ceiling).toBe(0);
  });

  it("should refuse limits that are not positive integers", async () => {
    await expect(retriever().retrieve({ text: "x", limit: 0 })).rejects.toThrow(RetrievalError);
    await expect(retriever().retrieve({ text: "x", depth: -1 })).rejects.toThrow(/depth/u);
    await expect(retriever().retrieve({ text: "x", candidates: 0 })).rejects.toThrow(
      RetrievalError,
    );
  });

  it("should break ties reproducibly rather than on channel proposal order", async () => {
    for (let i = 0; i < 4; i += 1) graph.addNode({ kind: "memory", label: "chicago" });
    const first = await retriever().retrieve({ text: "chicago", depth: 0 });
    const second = await retriever().retrieve({ text: "chicago", depth: 0 });
    expect(first.entries.map((e) => e.node.id)).toEqual(second.entries.map((e) => e.node.id));
  });
});

describe("retrieval as TRAVERSAL", () => {
  /** The Commander, a goal he cares about, and the note that said so. */
  function connected(): { commander: string; goal: string; note: string } {
    const commander = graph.addNode({ kind: "person", label: "the Commander" }).id;
    const goal = graph.addNode({ kind: "goal", label: "ship Syl" }).id;
    const note = graph.addNode({ kind: "source", label: "standup note" }).id;
    graph.observe({
      sourceNode: commander,
      targetNode: goal,
      relation: "cares_about",
      assertedBy: note,
    });
    return { commander, goal, note };
  }

  it("should return the neighbourhood, not only the entry points", async () => {
    // The question is never "find me this fact" — it is "what do I know about
    // this, and what does it touch".
    const { commander, goal } = connected();

    const result = await retriever().retrieve({ text: "Commander" });

    expect(result.entries.map((e) => e.node.id)).toEqual([commander]);
    expect(result.nodes.map((n) => n.id)).toContain(goal);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.relation).toBe("cares_about");
  });

  it("should reach further with more hops", async () => {
    const { commander, goal } = connected();
    const deadline = graph.addNode({ kind: "event", label: "the launch" }).id;
    graph.observe({
      sourceNode: goal,
      targetNode: deadline,
      relation: "due_at",
      assertedBy: commander,
    });

    const shallow = await retriever().retrieve({ text: "Commander", depth: 1 });
    const deep = await retriever().retrieve({ text: "Commander", depth: 2 });

    expect(shallow.nodes.map((n) => n.id)).not.toContain(deadline);
    expect(deep.nodes.map((n) => n.id)).toContain(deadline);
  });

  it("should walk nothing at depth zero, which is the plain search engine", async () => {
    connected();
    const result = await retriever().retrieve({ text: "Commander", depth: 0 });
    expect(result.edges).toEqual([]);
    expect(result.nodes).toHaveLength(result.entries.length);
  });

  it("should not walk from a cold edge", async () => {
    // The traversal is a SCAN, so it reads the hot tier — a dormant edge is
    // cheap to SKIP rather than merely cheap to rank.
    const { commander, goal, note } = connected();
    const edge = graph.findEdge(commander, goal, "cares_about");
    expect(edge).not.toBeNull();
    graph.demote(edge as MemoryEdge);

    const result = await retriever().retrieve({ text: "Commander" });
    expect(result.edges).toEqual([]);
    expect(result.nodes.map((n) => n.id)).not.toContain(goal);
    expect(result.nodes.map((n) => n.id)).not.toContain(note);
  });
});

describe("Retriever.recordFeedback", () => {
  it("should move trust and write the row that explains the move, as one thing", () => {
    const node = graph.addNode({ kind: "memory", label: "a memory" });
    const subject = retriever();

    const result = subject.recordFeedback(node.id, "unhelpful", "that was last quarter");

    expect(result.trustBefore).toBe(DEFAULT_TRUST);
    expect(result.trustAfter).toBeCloseTo(DEFAULT_TRUST / 1.21, 12);
    expect(subject.trustFor(node.id)).toBeCloseTo(result.trustAfter, 12);

    const ledger = subject.feedbackFor(node.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      verdict: "unhelpful",
      trustBefore: DEFAULT_TRUST,
      at: "2026-08-09T12:00:00.000Z",
    });
  });

  it("should keep the whole history, so a ranking can be explained", () => {
    const node = graph.addNode({ kind: "memory", label: "a memory" });
    const subject = retriever();
    subject.recordFeedback(node.id, "unhelpful");
    subject.recordFeedback(node.id, "helpful");
    subject.recordFeedback(node.id, "helpful");

    expect(subject.feedbackFor(node.id).map((f) => f.verdict)).toEqual([
      "unhelpful",
      "helpful",
      "helpful",
    ]);
  });

  it("should not refresh the memory's age, so being called wrong is not a boost", () => {
    // `updated_at` drives decay. Bumping it here would hand a memory he called
    // WRONG a fresh decay multiplier for saying so.
    const node = graph.addNode({ kind: "memory", label: "a memory" });
    const before = graph.getNode(node.id)?.updatedAt;
    retriever().recordFeedback(node.id, "unhelpful");
    expect(graph.getNode(node.id)?.updatedAt).toBe(before);
  });

  it("should reach a memory that has already gone cold", () => {
    // Being told a memory is wrong is a very common reason for it to have left
    // the hot tier; refusing the feedback that explains the demotion would be
    // backwards.
    const node = graph.addNode({ kind: "memory", label: "a memory" });
    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(node.id);

    const subject = retriever();
    expect(() => subject.recordFeedback(node.id, "unhelpful")).not.toThrow();
    expect(subject.trustFor(node.id)).toBeLessThan(DEFAULT_TRUST);
  });

  it("should refuse a node that is not in the graph", () => {
    let error: unknown;
    try {
      retriever().recordFeedback("syl:memory_node:00000000-0000-7000-8000-000000000001", "helpful");
    } catch (thrown) {
      error = thrown;
    }
    expect((error as RetrievalError).kind).toBe("unknown_node");
  });

  it("should refuse a verdict outside the two", () => {
    const node = graph.addNode({ kind: "memory", label: "a memory" });
    expect(() => retriever().recordFeedback(node.id, "sort of" as never)).toThrow(RetrievalError);
    // And nothing was written.
    expect(retriever().feedbackFor(node.id)).toEqual([]);
    expect(retriever().trustFor(node.id)).toBe(DEFAULT_TRUST);
  });

  it("should agree with the migration about a fresh memory's trust", () => {
    const node = graph.addNode({ kind: "memory", label: "a memory" });
    expect(retriever().trustFor(node.id)).toBe(DEFAULT_TRUST);
  });

  it("should return null trust for a node that does not exist", () => {
    expect(retriever().trustFor("syl:memory_node:00000000-0000-7000-8000-00000000000f")).toBeNull();
  });
});
