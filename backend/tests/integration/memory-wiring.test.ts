import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DreamLog } from "../../src/memory/dream/log.js";
import type { Embedder } from "../../src/memory/embed.js";
import {
  GraphError,
  MemoryGraph,
  type InferredEdge,
  type MemoryNode,
  type ObservedEdge,
} from "../../src/memory/graph.js";
import { MemoryMetrics, isTrustFailure } from "../../src/memory/metrics.js";
import { Retriever } from "../../src/memory/retrieve.js";
import {
  newMemoryAssertionId,
  newMemoryEdgeId,
  newMemoryNodeId,
} from "../../src/memory/schema.js";
import { MemoryStore, loadSqliteVec } from "../../src/memory/store.js";
import { SupersessionLedger } from "../../src/memory/supersede.js";
import {
  DEFAULT_WEIGHT_LAW,
  EdgeWeights,
  WeightError,
  crossingInstant,
  effectiveWeight,
} from "../../src/memory/weights.js";
import { instant } from "../../src/services/clock.js";
import {
  MIGRATIONS_DIR,
  IN_MEMORY,
  applyMigrations,
  applyPragmas,
  readMigrations,
} from "../../src/services/database.js";
import { idType, isId, newId } from "../../src/services/id.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";

/**
 * `syl-005`, assembled.
 *
 * Every module below was built by a different agent in a different worktree,
 * each with a green unit suite, and until this file none of them had ever run
 * in the same process against the same database. Unit tests prove each part
 * works alone, which is exactly the condition under which a wiring bug hides:
 * the seam is the one surface no component's own tests can see.
 *
 * Two rules this file holds itself to.
 *
 *  - **One database, real migrations, real modules.** Nothing under test is
 *    mocked. The only stub is the embedder, because `embed.ts` established the
 *    seam (`loadExtractor`, `SYL_EMBED_LIVE`) precisely so a normal run never
 *    downloads several hundred megabytes of weights. A fake that returns a
 *    chosen vector also makes every ranking assertion exact rather than
 *    approximate.
 *  - **An acceptance test describes CORRECT behaviour.** Where the assembly is
 *    wrong, the test says what should happen and is declared in
 *    `tests/expected-failures.json` against a bead. It is never softened into
 *    a description of what the code does today.
 */

/** A width small enough to write vectors by hand and reason about the cosine. */
const DIMENSIONS = 4;

const NOW = Date.parse("2026-08-10T09:00:00.000Z");

/** The Commander's timezone, as an IANA name. Constraint 5. */
const TZ = "America/Chicago";

let db: Database;
/** Moved by the tests; every module reads the clock through this. */
let clockMs = NOW;
const clock = (): number => clockMs;

let graph: MemoryGraph;
let store: MemoryStore;
let weights: EdgeWeights;
let ledger: SupersessionLedger;
let dream: DreamLog;
let metrics: MemoryMetrics;

/** A unit vector of `DIMENSIONS` width, so `cosineFromL2` is exact. */
function unit(...values: number[]): number[] {
  const padded = [...values, ...Array(Math.max(0, DIMENSIONS - values.length)).fill(0)];
  const magnitude = Math.sqrt(padded.reduce((sum, v) => sum + v * v, 0));
  return padded.map((v) => v / magnitude);
}

/**
 * An embedder that downloads nothing and returns what the test says.
 *
 * It implements the production `Embedder` interface rather than a convenient
 * subset, so a change to that interface breaks this instead of letting the
 * fake and the real one drift apart.
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

function retriever(embedder?: Embedder): Retriever {
  return new Retriever({
    db,
    store,
    graph,
    clock,
    ...(embedder === undefined ? {} : { embedder }),
  });
}

/** A row count, so a test can say "this whole operation added nothing". */
function count(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
  return (row as unknown as { c: number }).c;
}

beforeEach(() => {
  clockMs = NOW;
  db = new DatabaseSync(IN_MEMORY, { allowExtension: true });
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  loadSqliteVec(db);

  graph = new MemoryGraph({ db, clock });
  store = new MemoryStore({ db, dimensions: DIMENSIONS, clock });
  weights = new EdgeWeights({ graph, clock });
  ledger = new SupersessionLedger({ db, graph, clock });
  dream = new DreamLog({ db, clock });
  metrics = new MemoryMetrics({ db, clock, random: () => 0 });
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// 6. The migrations, in order, on a fresh database
// ---------------------------------------------------------------------------

describe("the migration sequence, assembled from every worktree", () => {
  it("should number every migration exactly once, with no gaps", () => {
    // The regression test for `syl-jzc`. Two worktrees shipped a 0014 on the
    // same day and the merged tree could not open a database AT ALL — not one
    // failing test, every test, at the first line of its setup. The runner
    // already refuses the collision; what was missing is anything that says so
    // before somebody spends an afternoon on it.
    const migrations = readMigrations(MIGRATIONS_DIR);

    const versions = migrations.map((migration) => migration.version);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("should apply 0012 through the last memory migration in order on an empty database", () => {
    // A second connection, so this is a genuinely fresh apply rather than a
    // read of what `beforeEach` already did.
    const fresh = new DatabaseSync(IN_MEMORY, { allowExtension: true });
    try {
      applyPragmas(fresh, { busyTimeoutMs: 100, requireWal: false });
      const applied = applyMigrations(fresh, readMigrations(MIGRATIONS_DIR));

      const names = applied.map((row) => row.name);
      expect(names).toContain("memory_core");
      expect(names).toContain("dream_log");
      expect(names).toContain("supersession_ledger");
      expect(names).toContain("memory_retrieval");

      // Order, not merely presence: `memory_retrieval` adds a column to
      // `memory_nodes` and backfills the FTS index from it, so it cannot
      // precede the file that creates the table.
      const at = (name: string): number => names.indexOf(name);
      expect(at("memory_core")).toBeLessThan(at("dream_log"));
      expect(at("memory_core")).toBeLessThan(at("supersession_ledger"));
      expect(at("memory_core")).toBeLessThan(at("memory_retrieval"));
    } finally {
      fresh.close();
    }
  });

  it("should leave every table the memory modules read actually present", () => {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all()
        .map((row) => (row as unknown as { name: string }).name),
    );

    for (const table of [
      "memory_nodes",
      "memory_edges",
      "memory_nodes_fts",
      "memory_vector_reindex",
      "memory_feedback",
      "memory_assertions",
      "dream_sessions",
      "dream_turns",
      "dream_edge_reasoning",
      "dream_duplicate_edges",
      "dream_surfaced",
    ]) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it("should backfill the keyword index for nodes that were already in a database migrated only part-way", () => {
    // `memory_retrieval` ships the FTS5 index and its triggers, and a database
    // that already holds nodes gets NOTHING from a trigger — the rows are
    // already there. The backfill is what makes the migration correct on a
    // live database rather than only on an empty one, and it is invisible
    // today precisely because everything shipped on the same afternoon.
    const partial = new DatabaseSync(IN_MEMORY, { allowExtension: true });
    try {
      applyPragmas(partial, { busyTimeoutMs: 100, requireWal: false });
      const all = readMigrations(MIGRATIONS_DIR);
      const retrieval = all.findIndex((migration) => migration.name === "memory_retrieval");
      expect(retrieval).toBeGreaterThan(0);

      applyMigrations(partial, all.slice(0, retrieval));

      const early = new MemoryGraph({ db: partial, clock });
      const before = early.addNode({ kind: "fact", label: "peregrine", body: "it stoops" });

      applyMigrations(partial, all);

      const row = partial
        .prepare("SELECT COUNT(*) AS c FROM memory_nodes_fts WHERE node_id = ?")
        .get(before.id);
      expect((row as unknown as { c: number }).c).toBe(1);
    } finally {
      partial.close();
    }
  });

  it("should mint ids that round-trip through id.ts and back out of the database", () => {
    // `schema.ts` mints memory ids and `id.ts` owns the format. They are
    // separate modules and nothing forces them to agree; a prefix typo would
    // be caught by neither module's own tests.
    expect(isId(newMemoryNodeId(), "memory_node")).toBe(true);
    expect(isId(newMemoryEdgeId(), "memory_edge")).toBe(true);
    expect(isId(newMemoryAssertionId(), "memory_assertion")).toBe(true);
    expect(isId(newId("dream_session"), "dream_session")).toBe(true);

    // And the same holds for ids that have made a round trip through SQLite,
    // which is where a stray cast or a rewritten column would show up.
    const source = graph.addNode({ kind: "source", label: "the Commander" });
    const fact = graph.addNode({ kind: "fact", label: "ships on Thursdays" });
    const edge = graph.observe({
      sourceNode: source.id,
      targetNode: fact.id,
      relation: "asserts",
      assertedBy: source.id,
    });
    const assertion = ledger.assert({
      subject: fact.id,
      relation: "cadence",
      value: "Thursdays",
    });
    const session = dream.openSession({ tz: TZ, tokenCeiling: 1000 });

    expect(idType(fact.id)).toBe("memory_node");
    expect(idType(edge.id)).toBe("memory_edge");
    expect(idType(assertion.current.id)).toBe("memory_assertion");
    expect(idType(session.id)).toBe("dream_session");
  });
});

// ---------------------------------------------------------------------------
// 1. A memory's whole life
// ---------------------------------------------------------------------------

describe("a memory's whole life, on one database", () => {
  it("should carry one inference from written, through embedded, retrieved, engaged, decayed, cold, reactivated, to suppressed", async () => {
    // ── written ──────────────────────────────────────────────────────────
    const person = graph.addNode({ kind: "person", label: "Grace Hopper" });
    const fact = graph.addNode({
      kind: "fact",
      label: "compiler sabbatical",
      body: "Grace took a sabbatical to write a compiler",
    });

    const inference = graph.infer({
      sourceNode: person.id,
      targetNode: fact.id,
      relation: "worked_on",
      reasoning: "both appear in the same three journal entries",
      confidence: 0.7,
      weight: 0.4,
      demoteAfter: crossingInstant(0.4, clockMs),
    });
    expect(inference.tier).toBe("hot");

    // ── embedded ─────────────────────────────────────────────────────────
    store.putVector(person.id, unit(1, 0, 0, 0));
    store.putVector(fact.id, unit(0.6, 0.8, 0, 0));
    expect(store.hasVector(fact.id)).toBe(true);

    // ── retrieved ────────────────────────────────────────────────────────
    const found = await retriever(fakeEmbedder(unit(0.6, 0.8, 0, 0))).retrieve({
      text: "compiler sabbatical",
      depth: 1,
    });

    expect(found.channels).toEqual(["keyword", "overlap"]);
    expect(found.entries.map((entry) => entry.node.id)).toContain(fact.id);
    // Depth 1 from the entry point must walk the hot inference and reach the
    // person on the far side of it. This is the join that proves ranking and
    // traversal are wired to the same graph.
    expect(found.edges.map((edge) => edge.id)).toContain(inference.id);
    expect(found.nodes.map((node) => node.id)).toContain(person.id);

    // ── engaged ──────────────────────────────────────────────────────────
    const engaged = weights.touch(inference, "engagement") as InferredEdge;
    expect(engaged.weight).toBeGreaterThanOrEqual(DEFAULT_WEIGHT_LAW.touch.engagement.floor);
    expect(engaged.tier).toBe("hot");
    // Engagement rewrites the crossing instant in the same statement as the
    // weight. A stale stamp is how an edge just strengthened gets swept out
    // from under the caller.
    expect(engaged.demoteAfter).toBe(crossingInstant(engaged.weight, NOW));

    // ── decayed ──────────────────────────────────────────────────────────
    const crossing = Date.parse(engaged.demoteAfter as string);
    clockMs = crossing - 1;
    expect(weights.effective(engaged)).toBeGreaterThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    expect(weights.sweep()).toBe(0);

    // ── demoted ──────────────────────────────────────────────────────────
    clockMs = crossing + 1;
    expect(weights.sweep()).toBe(1);

    const cold = graph.getEdge(inference.id);
    expect(cold?.tier).toBe("cold");
    // The stamp is cleared as the row moves, or the partial demote index grows
    // to hold the whole graph and the hot path pays for all of history.
    expect((cold as InferredEdge).demoteAfter).toBeNull();
    // A cold edge leaves the SCAN, and only the scan.
    expect(graph.neighbourhood(fact.id).edges).toHaveLength(0);
    expect(graph.neighbourhood(fact.id, { tiers: ["cold"] }).edges).toHaveLength(1);

    // ── reactivated ──────────────────────────────────────────────────────
    const back = weights.touch(cold as InferredEdge, "engagement") as InferredEdge;
    expect(back.tier).toBe("hot");
    expect(back.weight).toBeGreaterThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    expect(back.reasoning).toBe("both appear in the same three journal entries");
    expect(graph.neighbourhood(fact.id).edges.map((edge) => edge.id)).toEqual([inference.id]);

    // ── suppressed ───────────────────────────────────────────────────────
    const rejected = weights.reject(back);
    expect(rejected.tier).toBe("suppressed");
    expect(rejected.weight).toBeLessThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    // And no amount of later use brings it back. That is the Commander's
    // judgement, and reflection does not get to overrule it implicitly.
    expect(() => weights.touch(rejected, "engagement")).toThrow(WeightError);
    expect(() => graph.promote(rejected as InferredEdge, { demoteAfter: instant(clockMs) })).toThrow(
      GraphError,
    );

    // Still there, all the way down. Nothing in that sequence deleted a row.
    expect(graph.findEdge(person.id, fact.id, "worked_on")?.id).toBe(inference.id);
  });

  it("should let feedback reach a memory that has already gone cold, without handing it a fresh decay multiplier", () => {
    const fact = graph.addNode({ kind: "fact", label: "stale claim" });
    const retrieve = retriever();

    graph.supersedeNode(fact);
    const cold = graph.getNode(fact.id) as MemoryNode;
    expect(cold.tier).toBe("cold");

    // Being told a memory is wrong is a very common reason for it to have left
    // the hot tier, so refusing the feedback that explains the demotion would
    // be backwards.
    const verdict = retrieve.recordFeedback(fact.id, "unhelpful", "he said it was out of date");
    expect(verdict.trustAfter).toBeLessThan(verdict.trustBefore);
    expect(retrieve.feedbackFor(fact.id)).toHaveLength(1);

    // `updated_at` must NOT move: trust is a judgement about a memory, not a
    // change to it, and bumping the stamp would reward it for being wrong.
    expect(graph.getNode(fact.id)?.updatedAt).toBe(cold.updatedAt);
  });

  it("should never argue a memory's trust down past the floor the column's CHECK would refuse", () => {
    // Two independent clamps that have to agree and do not know about each
    // other: `trustAfterFeedback` floors at MIN_TRUST in TypeScript, and the
    // column carries `CHECK (trust > 0.0 AND trust <= 1.0)` in SQL. If the
    // clamp were ever loosened the CHECK would start rejecting the write
    // mid-transaction — a piece of the Commander's feedback lost, from a code
    // path that looks like arithmetic.
    const fact = graph.addNode({ kind: "fact", label: "much disputed" });
    const retrieve = retriever();

    let last = 1;
    for (let i = 0; i < 60; i += 1) {
      last = retrieve.recordFeedback(fact.id, "unhelpful").trustAfter;
    }
    expect(last).toBeGreaterThan(0);
    expect(retrieve.trustFor(fact.id)).toBe(last);
    expect(retrieve.feedbackFor(fact.id)).toHaveLength(60);

    // And it can be earned back. A memory argued down to a score it can never
    // climb out of is pruning with extra steps.
    for (let i = 0; i < 60; i += 1) retrieve.recordFeedback(fact.id, "helpful");
    expect(retrieve.trustFor(fact.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The Commander's rule: demote, never prune
// ---------------------------------------------------------------------------

describe("demote-never-prune, end to end", () => {
  it("should keep an inferred edge findable BY IDENTITY after it falls below the floor, and let it be promoted back to a useful weight", () => {
    const a = graph.addNode({ kind: "person", label: "Ada" });
    const b = graph.addNode({ kind: "goal", label: "the Analytical Engine" });

    // Weak from birth: a confidence the reflection pass was not sure about.
    const weak = graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "wrote_notes_on",
      reasoning: "a single mention, unconfirmed",
      confidence: 0.2,
      weight: 0.1,
      demoteAfter: crossingInstant(0.1, clockMs),
    });

    // Far past the crossing, so the effective weight is genuinely below the
    // floor rather than merely scheduled to be.
    clockMs = NOW + 400 * 86_400_000;
    expect(effectiveWeight(weak.weight, weak.lastTouchedAt, clockMs)).toBeLessThan(
      DEFAULT_WEIGHT_LAW.relevanceFloor,
    );

    expect(weights.sweep()).toBe(1);
    const cold = graph.getEdge(weak.id) as InferredEdge;
    expect(cold.tier).toBe("cold");

    // ── findable by identity, on every path that claims to be one ────────
    expect(graph.getEdge(weak.id)?.id).toBe(weak.id);
    expect(graph.findEdge(a.id, b.id, "wrote_notes_on")?.id).toBe(weak.id);
    expect(graph.edgesBetween(a.id, b.id).map((edge) => edge.id)).toEqual([weak.id]);
    // And the reasoning survived the trip. An inference nobody can audit is a
    // rumour, cold or not.
    expect(cold.reasoning).toBe("a single mention, unconfirmed");
    expect(cold.confidence).toBe(0.2);

    // ── and it is NOT in any scan ────────────────────────────────────────
    expect(graph.neighbourhood(a.id).edges).toHaveLength(0);

    // ── promoted back to a weight that is actually useful ────────────────
    const revived = weights.touch(cold, "engagement") as InferredEdge;
    expect(revived.tier).toBe("hot");
    expect(revived.weight).toBeGreaterThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    // The whole point of `reactivatedWeight` being a JUMP and not a multiple:
    // a decayed edge must not be permanently unreachable however often it is
    // touched. Landing it back below the floor would demote it again on the
    // very next sweep — a one-way trip wearing a floor's clothes.
    expect(weights.effective(revived)).toBeGreaterThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
    expect(weights.sweep()).toBe(0);
    expect(graph.neighbourhood(a.id).edges.map((edge) => edge.id)).toEqual([weak.id]);
  });

  it("should refuse to delete an inferred edge even when the store is asked directly", () => {
    const a = graph.addNode({ kind: "person", label: "Ada" });
    const b = graph.addNode({ kind: "goal", label: "the Engine" });
    const inferred = graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "wrote_notes_on",
      reasoning: "why",
      confidence: 0.5,
      demoteAfter: crossingInstant(1, clockMs),
    });

    // `retract` takes an `ObservedEdge` value, so `retract(anInference)` does
    // not compile — the cast is what a future refactor's mistake would look
    // like, and the trigger is what has to catch it.
    expect(() => graph.retract(inferred as unknown as ObservedEdge)).toThrow(GraphError);
    expect(() => db.prepare("DELETE FROM memory_edges WHERE id = ?").run(inferred.id)).toThrow();
    expect(graph.getEdge(inferred.id)).not.toBeNull();
  });

  it("should never let the demotion sweep leave a stamp behind in the partial index", () => {
    // The failure this guards is invisible from outside: every query keeps
    // returning the right rows while `memory_edges_demote_idx` quietly grows
    // to hold the whole graph.
    const a = graph.addNode({ kind: "fact", label: "a" });
    const b = graph.addNode({ kind: "fact", label: "b" });
    const c = graph.addNode({ kind: "fact", label: "c" });

    graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "r",
      reasoning: "why",
      confidence: 0.5,
      weight: 0.1,
      demoteAfter: crossingInstant(0.1, clockMs),
    });
    graph.infer({
      sourceNode: b.id,
      targetNode: c.id,
      relation: "r",
      reasoning: "why",
      confidence: 0.5,
      weight: 0.1,
      demoteAfter: crossingInstant(0.1, clockMs),
    });

    clockMs = NOW + 400 * 86_400_000;
    expect(weights.sweep()).toBe(2);

    const stamped = db
      .prepare("SELECT COUNT(*) AS c FROM memory_edges WHERE demote_after IS NOT NULL")
      .get();
    expect((stamped as unknown as { c: number }).c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The cold/hot split across all three indexes at once
// ---------------------------------------------------------------------------

describe("the hot/cold split, across the B-tree, FTS5 and vec0 together", () => {
  /** Rows the FTS index is holding for a node, read directly. */
  function keywordRows(nodeId: string): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_nodes_fts WHERE node_id = ?")
      .get(nodeId);
    return (row as unknown as { c: number }).c;
  }

  /** The partition a vector is actually sitting in, read directly. */
  function vectorPartition(nodeId: string): { tier: string; kind: string } | null {
    const row = db.prepare("SELECT tier, kind FROM memory_vectors WHERE node_id = ?").get(nodeId);
    return row === undefined ? null : (row as unknown as { tier: string; kind: string });
  }

  it("should drop a superseded node out of ranked search on ALL THREE paths, and still resolve it by identity on all three", () => {
    const goal = newId("goal");
    const kept = graph.addNode({ kind: "fact", label: "kestrel", body: "a kestrel hovers" });
    const gone = graph.addNode({
      kind: "fact",
      label: "kestrel",
      body: "a kestrel migrates",
      subjectId: goal,
    });
    store.putVector(kept.id, unit(1, 0, 0, 0));
    store.putVector(gone.id, unit(1, 0, 0, 0));

    // Hot: present in every ranked path.
    expect(graph.listNodes({ kind: "fact" }).map((node) => node.id).sort()).toEqual(
      [kept.id, gone.id].sort(),
    );
    expect(store.searchKeyword("kestrel").map((hit) => hit.nodeId).sort()).toEqual(
      [kept.id, gone.id].sort(),
    );
    expect(store.searchVector(unit(1, 0, 0, 0)).map((hit) => hit.nodeId).sort()).toEqual(
      [kept.id, gone.id].sort(),
    );

    // The move. `supersedeNode` writes one UPDATE; the FTS index is maintained
    // by a TRIGGER and the vector table by APPLICATION CODE, and this is where
    // the two mechanisms have to agree without either knowing about the other.
    graph.supersedeNode(gone);

    // ── the B-tree: gone from the scan ───────────────────────────────────
    expect(graph.listNodes({ kind: "fact" }).map((node) => node.id)).toEqual([kept.id]);
    // ── FTS5: the trigger removed it ─────────────────────────────────────
    expect(keywordRows(gone.id)).toBe(0);
    expect(store.searchKeyword("kestrel").map((hit) => hit.nodeId)).toEqual([kept.id]);
    // ── vec0: the row has NOT moved yet, and ranked search is still right ─
    //
    // `vec0` refuses UPDATE on a partition key, so a tier move is a re-insert
    // and cannot be a trigger. The vector is therefore still sitting in the
    // hot partition — and the confirming join against the node is what makes
    // a hot search correct anyway. That is the seam.
    expect(vectorPartition(gone.id)?.tier).toBe("hot");
    expect(store.pendingReindex()).toBe(1);
    expect(store.searchVector(unit(1, 0, 0, 0)).map((hit) => hit.nodeId)).toEqual([kept.id]);

    // ── and by IDENTITY, on all three ────────────────────────────────────
    //
    // The B-tree has two identity paths and both must span every tier: by id,
    // and by the operational row the node is about. "What does the graph know
    // about this goal?" has to keep answering with the superseded node — that
    // is what a retired fact IS.
    expect(graph.getNode(gone.id)?.tier).toBe("cold");
    expect(graph.nodesForSubject(goal).map((node) => node.id)).toEqual([gone.id]);
    expect(store.vectorFor(gone.id)).not.toBeNull();
    expect(store.hasVector(gone.id)).toBe(true);
  });

  it("should find a cold node's vector in the cold partition once the queue the tier move filled has been drained", () => {
    const gone = graph.addNode({ kind: "fact", label: "kestrel" });
    store.putVector(gone.id, unit(1, 0, 0, 0));
    graph.supersedeNode(gone);

    // A cold KNN with an undrained queue would prune the still-hot vector away
    // and return nothing — and "nothing" reads as "there is nothing down
    // there", not as "the repair has not run". That is the worst possible
    // answer to give the cold-store audit, whose entire job is to prove that
    // nothing has become unreachable.
    expect(store.searchVector(unit(1, 0, 0, 0), { tier: "cold" }).map((h) => h.nodeId)).toEqual([
      gone.id,
    ]);
    expect(store.pendingReindex()).toBe(0);
    expect(vectorPartition(gone.id)?.tier).toBe("cold");
  });

  it("should put a node back into all three indexes when it comes back to hot", () => {
    const node = graph.addNode({ kind: "fact", label: "kestrel" });
    store.putVector(node.id, unit(1, 0, 0, 0));

    graph.supersedeNode(node);
    expect(keywordRows(node.id)).toBe(0);

    // Back to hot. There is no `promoteNode`, so this is the raw move the
    // triggers have to survive; what matters is that all three indexes agree
    // afterwards regardless of which door the tier change came through.
    db.prepare("UPDATE memory_nodes SET tier = 'hot' WHERE id = ?").run(node.id);
    store.drainReindexQueue();

    expect(keywordRows(node.id)).toBe(1);
    expect(store.searchKeyword("kestrel").map((hit) => hit.nodeId)).toEqual([node.id]);
    expect(store.searchVector(unit(1, 0, 0, 0)).map((hit) => hit.nodeId)).toEqual([node.id]);
    expect(vectorPartition(node.id)?.tier).toBe("hot");
  });

  it("should report the three indexes as reconciled after a demotion and a promotion have both been through", () => {
    const a = graph.addNode({ kind: "fact", label: "alpha" });
    const b = graph.addNode({ kind: "fact", label: "beta" });
    store.putVector(a.id, unit(1, 0, 0, 0));
    store.putVector(b.id, unit(0, 1, 0, 0));

    graph.supersedeNode(b);
    store.drainReindexQueue();

    const drift = store.reconcile();
    expect(drift.missingVectors).toEqual([]);
    expect(drift.orphanVectors).toEqual([]);
    expect(drift.stalePartitions).toEqual([]);
    expect(drift.missingKeyword).toEqual([]);
    expect(drift.orphanKeyword).toEqual([]);
    expect(drift.pendingReindex).toBe(0);
    expect(drift.clean).toBe(true);
  });

  it("should keep a suppressed EDGE out of every traversal while its endpoints stay fully searchable", () => {
    // Edges and nodes are partitioned separately and by different mechanisms.
    // Suppressing a connection must not quietly take the things it connects
    // out of search with it.
    const a = graph.addNode({ kind: "person", label: "Grace" });
    const b = graph.addNode({ kind: "fact", label: "compiler" });
    store.putVector(a.id, unit(1, 0, 0, 0));
    store.putVector(b.id, unit(0, 1, 0, 0));

    const edge = graph.observe({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "wrote",
      assertedBy: a.id,
    });
    graph.suppress(edge, 0.01);

    expect(graph.neighbourhood(a.id).edges).toHaveLength(0);
    expect(store.searchKeyword("compiler").map((hit) => hit.nodeId)).toEqual([b.id]);
    expect(store.searchVector(unit(0, 1, 0, 0)).map((hit) => hit.nodeId)).toContain(b.id);
    // Findable by identity, which is what stops the next reflection pass
    // recreating a connection the Commander already rejected.
    expect(graph.findEdge(a.id, b.id, "wrote")?.tier).toBe("suppressed");
  });
});

// ---------------------------------------------------------------------------
// 4. Supersession versus search
// ---------------------------------------------------------------------------

describe("supersession against every search path", () => {
  it("should stop returning the old value as current on every path, while believedAt still answers what was believed before", async () => {
    const subject = graph.addNode({ kind: "person", label: "the Commander" });
    const oldValue = graph.addNode({
      kind: "fact",
      label: "employer Aperture",
      body: "he works at Aperture",
    });

    store.putVector(oldValue.id, unit(1, 0, 0, 0));
    ledger.assert({
      subject: subject.id,
      relation: "employer",
      value: "Aperture",
      valueNode: oldValue.id,
    });

    const before = instant(clockMs);
    expect(ledger.current(subject.id, "employer")?.value).toBe("Aperture");
    expect(store.searchKeyword("Aperture").map((hit) => hit.nodeId)).toEqual([oldValue.id]);

    // ── the correction ───────────────────────────────────────────────────
    clockMs = NOW + 86_400_000;
    const newValue = graph.addNode({
      kind: "fact",
      label: "employer Black Mesa",
      body: "he works at Black Mesa",
    });
    store.putVector(newValue.id, unit(0, 1, 0, 0));

    const result = ledger.assert({
      subject: subject.id,
      relation: "employer",
      value: "Black Mesa",
      valueNode: newValue.id,
    });
    expect(result.unchanged).toBe(false);
    expect(result.superseded?.value).toBe("Aperture");

    // ── no search path returns the old value as current ──────────────────
    //
    // The ledger closing a row and the graph demoting the node carrying it are
    // one operation, and this is the assertion that they actually are: nothing
    // in the test called `supersedeNode`.
    expect(graph.getNode(oldValue.id)?.tier).toBe("cold");
    expect(store.searchKeyword("Aperture")).toEqual([]);
    expect(store.searchVector(unit(1, 0, 0, 0)).map((hit) => hit.nodeId)).not.toContain(
      oldValue.id,
    );
    expect(graph.listNodes({ kind: "fact" }).map((node) => node.id)).toEqual([newValue.id]);

    const retrieved = await retriever(fakeEmbedder(unit(1, 0, 0, 0))).retrieve({
      text: "employer Aperture",
      depth: 0,
    });
    expect(retrieved.entries.map((entry) => entry.node.id)).not.toContain(oldValue.id);

    // ── and the history is still an answer to a question ─────────────────
    expect(ledger.current(subject.id, "employer")?.value).toBe("Black Mesa");
    expect(ledger.believedAt(subject.id, "employer", before)?.value).toBe("Aperture");
    expect(ledger.history(subject.id, "employer").map((row) => row.value)).toEqual([
      "Aperture",
      "Black Mesa",
    ]);
    // The node itself is still reachable by identity: a superseded node is
    // what "what did I believe in March?" is answered out of.
    expect(graph.getNode(oldValue.id)?.label).toBe("employer Aperture");
    expect(store.vectorFor(oldValue.id)).not.toBeNull();
  });

  it("should not demote anything when the same value is asserted twice", () => {
    const subject = graph.addNode({ kind: "person", label: "the Commander" });
    const value = graph.addNode({ kind: "fact", label: "employer Aperture" });

    ledger.assert({
      subject: subject.id,
      relation: "employer",
      value: "Aperture",
      valueNode: value.id,
    });
    const again = ledger.assert({
      subject: subject.id,
      relation: "employer",
      value: "Aperture",
      valueNode: value.id,
    });

    expect(again.unchanged).toBe(true);
    expect(again.superseded).toBeNull();
    // Byte equality, and nothing moved. An idempotent restatement that quietly
    // demoted the node would take a live fact out of search for saying it
    // twice.
    expect(graph.getNode(value.id)?.tier).toBe("hot");
    expect(store.searchKeyword("Aperture").map((hit) => hit.nodeId)).toEqual([value.id]);
  });

  it("should take a retired fact out of search with no successor to replace it", () => {
    const subject = graph.addNode({ kind: "person", label: "the Commander" });
    const value = graph.addNode({ kind: "fact", label: "employer Aperture" });
    ledger.assert({
      subject: subject.id,
      relation: "employer",
      value: "Aperture",
      valueNode: value.id,
    });

    clockMs = NOW + 86_400_000;
    const retired = ledger.retire(subject.id, "employer");

    expect(retired.supersededAt).not.toBeNull();
    expect(retired.supersededBy).toBeNull();
    expect(ledger.current(subject.id, "employer")).toBeNull();
    expect(graph.getNode(value.id)?.tier).toBe("cold");
    expect(store.searchKeyword("Aperture")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. The dream log versus the graph
// ---------------------------------------------------------------------------

describe("a night of dreaming, against the graph it is about", () => {
  it("should write a whole night into the log and add NOTHING to the graph", () => {
    // Constraint 7. Get this wrong and the failure is not an error, it is a
    // slow poisoning: the next night's sweep seeds from last night's dream
    // rows, and the corpus contaminates itself with its own output.
    const a = graph.addNode({ kind: "person", label: "Grace" });
    const b = graph.addNode({ kind: "fact", label: "compiler" });

    const nodesBefore = count("memory_nodes");
    const edgesBefore = count("memory_edges");
    const syncBefore = count("sync_log");

    const session = dream.openSession({ tz: TZ, tokenCeiling: 50_000, night: "2026-08-09" });
    dream.startTurn(session.id, { phase: "sweep" });
    const reasoning = dream.recordReasoning({
      sessionId: session.id,
      turnIndex: 0,
      disposition: "rejected",
      sourceNode: a.id,
      targetNode: b.id,
      reasoning: "the only co-occurrence is a shared date",
      confidence: 0.2,
    });
    dream.recordSurfaced({
      sessionId: session.id,
      reasoningId: reasoning.id,
      summary: "Grace and the compiler keep turning up together",
    });
    dream.finishTurn(session.id, 0, { outcome: "success", tokensSpent: 1_200, costUsd: 0.04 });
    dream.closeSession(session.id, { outcome: "completed" });

    // Not one row. Every id above is opaque TEXT in the log, with no foreign
    // key in either direction.
    expect(count("memory_nodes")).toBe(nodesBefore);
    expect(count("memory_edges")).toBe(edgesBefore);
    // And a whole night adds nothing to the device feed: the dream log is the
    // Commander's instrument panel, not his phone's data.
    expect(count("sync_log")).toBe(syncBefore);
  });

  it("should have no foreign key in either direction between the dream tables and the graph", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as unknown as { name: string }).name);

    const dreamTables = tables.filter((name) => name.startsWith("dream_"));
    expect(dreamTables.length).toBeGreaterThan(0);

    for (const table of dreamTables) {
      const targets = db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => (row as unknown as { table: string }).table);
      for (const target of targets) {
        expect(target.startsWith("dream_")).toBe(true);
      }
    }

    // And nothing in the graph points back at the log, which is what lets 0012
    // be reshaped without a thought for 0013.
    for (const table of ["memory_nodes", "memory_edges", "memory_assertions"]) {
      const targets = db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => (row as unknown as { table: string }).table);
      for (const target of targets) {
        expect(target.startsWith("dream_")).toBe(false);
      }
    }
  });

  it("should read a night back through the metrics as what actually happened", () => {
    const a = graph.addNode({ kind: "person", label: "Grace" });
    const b = graph.addNode({ kind: "fact", label: "compiler" });
    const edge = graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "wrote",
      reasoning: "three journal entries",
      confidence: 0.8,
      demoteAfter: crossingInstant(1, clockMs),
    });

    const session = dream.openSession({ tz: TZ, tokenCeiling: 50_000, night: "2026-08-09" });
    dream.startTurn(session.id, { phase: "sweep" });
    dream.recordReasoning({
      sessionId: session.id,
      turnIndex: 0,
      disposition: "created",
      edgeId: edge.id,
      sourceNode: a.id,
      targetNode: b.id,
      tierAfter: "hot",
      reasoning: "three journal entries",
      confidence: 0.8,
    });
    const surfaced = dream.recordSurfaced({
      sessionId: session.id,
      edgeId: edge.id,
      summary: "Grace wrote the compiler",
    });
    dream.recordEngagement(surfaced.id, "engaged");
    dream.finishTurn(session.id, 0, { outcome: "success", tokensSpent: 2_000, costUsd: 0.08 });
    dream.closeSession(session.id, { outcome: "completed" });

    // The metrics are a DERIVED VIEW: they read the log and the graph and
    // write to neither. This is the join between them.
    const survival = metrics.survival();
    expect(survival.hasEvidence).toBe(true);
    expect(survival.cohorts.find((cohort) => cohort.night === "2026-08-09")?.created).toBe(1);
    expect(survival.cohorts.find((cohort) => cohort.night === "2026-08-09")?.surviving).toBe(1);
    expect(survival.vanished).toBe(0);

    const engagement = metrics.engagement();
    expect(engagement.surfaced).toBe(1);
    expect(engagement.engaged).toBe(1);

    const cost = metrics.costPerKeptEdge();
    expect(cost.tokensSpent).toBe(2_000);
    expect(cost.edgesCreated).toBe(1);
    expect(cost.edgesKept).toBe(1);

    // The store shape is read from the GRAPH, not from the log, so this is the
    // one number in the panel that a lying log cannot move.
    expect(metrics.storeShape().edges.inferred).toBe(1);
  });

  it("should see a demoted cohort in the metrics after the real sweep has moved it", () => {
    const a = graph.addNode({ kind: "person", label: "Grace" });
    const b = graph.addNode({ kind: "fact", label: "compiler" });
    const edge = graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "wrote",
      reasoning: "one weak mention",
      confidence: 0.2,
      weight: 0.1,
      demoteAfter: crossingInstant(0.1, clockMs),
    });

    const session = dream.openSession({ tz: TZ, tokenCeiling: 50_000, night: "2026-08-09" });
    dream.recordReasoning({
      sessionId: session.id,
      disposition: "created",
      edgeId: edge.id,
      sourceNode: a.id,
      targetNode: b.id,
      tierAfter: "hot",
      reasoning: "one weak mention",
    });
    dream.closeSession(session.id, { outcome: "completed" });

    clockMs = NOW + 400 * 86_400_000;
    expect(weights.sweep()).toBe(1);

    // Survival is computed by joining the log's cohort to the edge's tier in
    // the graph. Nothing told the metrics the sweep had run; they read it.
    const cohort = metrics.survival().cohorts.find((row) => row.night === "2026-08-09");
    expect(cohort?.created).toBe(1);
    expect(cohort?.surviving).toBe(0);
    expect(cohort?.demoted).toBe(1);
    expect(cohort?.missing).toBe(0);
  });

  it("should call a resurrected rejection a trust failure and not merely a broken lookup", () => {
    const a = graph.addNode({ kind: "person", label: "Grace" });
    const b = graph.addNode({ kind: "fact", label: "compiler" });
    const edge = graph.observe({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "wrote",
      assertedBy: a.id,
    });
    graph.suppress(edge, 0.01);

    const session = dream.openSession({ tz: TZ, tokenCeiling: 50_000, night: "2026-08-09" });
    dream.recordReasoning({
      sessionId: session.id,
      disposition: "created",
      edgeId: edge.id,
      sourceNode: a.id,
      targetNode: b.id,
      reasoning: "rediscovered the same pair",
    });
    dream.recordDuplicateEdgeInsert({
      sessionId: session.id,
      sourceNode: a.id,
      targetNode: b.id,
      existingEdgeId: edge.id,
      existingTier: "suppressed",
      note: "the identity lookup found it, and the sweep inserted anyway",
    });
    dream.closeSession(session.id, { outcome: "completed" });

    const alarm = metrics.invariantAlarm();
    expect(alarm.status).toBe("rejected_connection_resurrected");
    expect(alarm.severity).toBe("trust_failure");
    expect(isTrustFailure(alarm)).toBe(true);
    expect(alarm.suppressedResurrections).toHaveLength(1);
    // The store itself refuses the duplicate — the identity index is UNIQUE
    // across every partition — so a breach can only ever appear here, recorded
    // by the sweep that caught the refusal.
    expect(graph.edgesBetween(a.id, b.id)).toHaveLength(1);
    expect(alarm.storeEnforced).toBe(true);
  });

  it("should say `unproven` rather than `holds` when no dream has ever attempted an insertion", () => {
    // The distinction the whole observability surface turns on: zero breaches
    // out of zero attempts is not a healthy system, and a panel that reports
    // them the same way has failed at its only job.
    const alarm = metrics.invariantAlarm();
    expect(alarm.status).toBe("unproven");
    expect(alarm.severity).toBe("unknown");
    expect(alarm.insertionsAttempted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The wiring itself
// ---------------------------------------------------------------------------

describe("the memory epic, as wired into the running service", () => {
  /** Source files that mention a needle, excluding `src/memory` itself. */
  function callersOutsideMemory(needle: string): string[] {
    return sourceFiles(BACKEND_SRC)
      .filter((file) => !file.slice(BACKEND_SRC.length).startsWith("memory/"))
      .filter((file) => readFileSync(file, "utf8").includes(needle))
      .map((file) => file.slice(BACKEND_SRC.length))
      .sort();
  }

  /**
   * **The `syl-vls` shape, a third time.**
   *
   * Every module of this epic has a green unit suite and no call site. The
   * thing that is missing is a line in `bootstrap`, which is precisely what no
   * test of a component can see — the same failure as "the agent was
   * constructed nowhere and called from nowhere", and the reason that bug got
   * a wiring test rather than another unit test.
   *
   * Declared in `tests/expected-failures.json` against `syl-63n`.
   */
  it("should be constructed somewhere in the service, not only in its own tests", () => {
    expect(callersOutsideMemory("new MemoryGraph(")).not.toEqual([]);
    expect(callersOutsideMemory("new MemoryStore(")).not.toEqual([]);
    expect(callersOutsideMemory("new Retriever(")).not.toEqual([]);
  });

  /**
   * A connection can only be granted extension loading at CONSTRUCTION —
   * `node:sqlite` offers no way to turn it on afterwards. So a service that
   * opens its database without `allowExtension: true` can never load `vec0`,
   * however the store is wired in later, and vector search would simply be
   * absent on the running service while every unit test passed: the tests open
   * their own connection and pass the flag.
   *
   * Declared in `tests/expected-failures.json` against `syl-63n`.
   */
  it("should open the service database with extension loading allowed, or vec0 can never be loaded into it", () => {
    const bootstrap = readFileSync(`${BACKEND_SRC}index.ts`, "utf8");
    const open = /openDatabase\(\{[^}]*\}\)/s.exec(bootstrap);
    expect(open).not.toBeNull();
    expect(open?.[0]).toContain("allowExtension");
  });
});
