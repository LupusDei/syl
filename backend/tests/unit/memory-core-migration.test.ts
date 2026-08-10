import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  newMemoryEdgeId,
  newMemoryNodeId,
  type MemoryEdgeSpecies,
  type MemoryTier,
} from "../../src/memory/schema.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The memory core, exercised against the real migrations rather than a
 * hand-built schema.
 *
 * `backend/tests/integration/schema-completeness.test.ts` exists because unit
 * tests that build their own schema cannot see a migration that never shipped.
 * The same trap applies here in a nastier form: the whole point of this bead is
 * the *shape* of the shipped table, so a test that creates its own tables would
 * be testing a copy of the design instead of the design.
 */

let db: Database;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
});

afterEach(() => {
  db.close();
});

const NOW = "2026-08-09T12:00:00.000Z";
const LATER = "2026-08-09T18:00:00.000Z";

/** Insert a node, returning its id. */
function addNode(
  overrides: Partial<{
    id: string;
    tier: MemoryTier;
    kind: string;
    label: string;
    body: string | null;
    subjectId: string | null;
    createdAt: string;
    updatedAt: string;
  }> = {},
): string {
  const id = overrides.id ?? newMemoryNodeId();
  db.prepare(
    `INSERT INTO memory_nodes
       (id, tier, kind, label, body, subject_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.tier ?? "hot",
    overrides.kind ?? "fact",
    overrides.label ?? "a fact",
    overrides.body ?? null,
    overrides.subjectId ?? null,
    overrides.createdAt ?? NOW,
    overrides.updatedAt ?? NOW,
  );
  return id;
}

interface EdgeFields {
  id: string;
  tier: MemoryTier;
  kind: MemoryEdgeSpecies;
  sourceNode: string;
  targetNode: string;
  relation: string;
  weight: number;
  confidence: number | null;
  reasoning: string | null;
  assertedBy: string | null;
  lastTouchedAt: string;
  demoteAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Insert an edge, returning its id.
 *
 * Overrides are read with `in` rather than `??`, because half the cases below
 * are "this nullable column is explicitly NULL" and `null ?? fallback` would
 * silently hand back the fallback — a helper that quietly ignores the very
 * thing a test is asserting about.
 */
function addEdge(
  fields: Partial<EdgeFields> & Pick<EdgeFields, "sourceNode" | "targetNode">,
): string {
  const pick = <K extends keyof EdgeFields>(key: K, fallback: EdgeFields[K]): EdgeFields[K] =>
    key in fields ? (fields[key] as EdgeFields[K]) : fallback;

  const id = pick("id", newMemoryEdgeId());
  const kind = pick("kind", "inferred");
  const inferred = kind === "inferred";
  const tier = pick("tier", "hot");

  db.prepare(
    `INSERT INTO memory_edges
       (id, tier, kind, source_node, target_node, relation, weight, confidence,
        reasoning, asserted_by, last_touched_at, demote_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tier,
    kind,
    fields.sourceNode,
    fields.targetNode,
    pick("relation", "relates_to"),
    pick("weight", 0.5),
    pick("confidence", inferred ? 0.7 : null),
    pick("reasoning", inferred ? "both appear in the same standup note" : null),
    pick("assertedBy", null),
    pick("lastTouchedAt", NOW),
    pick("demoteAfter", inferred && tier === "hot" ? LATER : null),
    pick("createdAt", NOW),
    pick("updatedAt", NOW),
  );
  return id;
}

/** The query plan for a statement, as one lowercase string. */
function queryPlan(sql: string, ...parameters: readonly string[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters);
  return rows
    .map((row) => String((row as { detail: string }).detail))
    .join(" | ")
    .toLowerCase();
}

describe("0012_memory_core — the tables exist and are STRICT", () => {
  it("should create memory_nodes and memory_edges, and nothing else", () => {
    // Applied to version 12 ONLY, on its own database. The `memory_` namespace
    // is shared — 0014 adds an FTS5 index, a feedback ledger and a reindex
    // queue — so asking the fully-migrated database what is in it stopped
    // being a question about 0012 the moment a second migration touched the
    // namespace. Scoping the setup keeps the assertion exact rather than
    // loosening it to `arrayContaining`, which would no longer notice 0012
    // growing a table nobody meant to add.
    const scoped = new DatabaseSync(IN_MEMORY);
    applyPragmas(scoped, { busyTimeoutMs: 100, requireWal: false });
    applyMigrations(
      scoped,
      readMigrations(MIGRATIONS_DIR).filter((migration) => migration.version <= 12),
    );

    const names = scoped
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    scoped.close();

    // Containment, not equality. This file is about the SHAPE of 0012's two
    // tables, and an exact list also asserted that no LATER migration may add a
    // `memory_*` table — a claim it was not making on purpose and cannot
    // support. `0016_supersession_ledger.sql` adds `memory_assertions`, and the
    // retrieval work adds more; each arrival would fail this line in a file its
    // author had no other business in, which is the same rot the migration-count
    // literal in `schema-completeness.test.ts` was already changed to avoid.
    expect(names).toEqual(expect.arrayContaining(["memory_edges", "memory_nodes"]));
  });

  it("should refuse a value of the wrong storage class, because the tables are STRICT", () => {
    // A blob is the honest probe. STRICT converts anything it can convert
    // losslessly — a bound `7` lands in a TEXT column as "7" — so a number
    // would prove nothing about the declaration.
    expect(() => addNode({ label: new Uint8Array([1, 2, 3]) as unknown as string })).toThrow();
  });
});

describe("memory_nodes", () => {
  it("should accept a well-formed node of every kind it covers", () => {
    for (const kind of ["fact", "memory", "person", "source", "event", "goal", "decision"]) {
      expect(() => addNode({ kind, label: `a ${kind}` })).not.toThrow();
    }
    expect(db.prepare("SELECT count(*) AS n FROM memory_nodes").get()).toEqual({ n: 7 });
  });

  it("should refuse a node id from another namespace", () => {
    // `syl:goal:<uuid>` already addresses a row in the operational `goals`
    // table. A memory node of kind `goal` minting the same prefix would make a
    // dangling reference unreadable.
    expect(() => addNode({ id: "syl:goal:01991b2f-0000-7000-8000-0000000000ab" })).toThrow();
  });

  it("should refuse a kind outside the vocabulary", () => {
    expect(() => addNode({ kind: "vibe" })).toThrow();
  });

  it("should refuse a tier outside the partition vocabulary", () => {
    expect(() => addNode({ tier: "warm" as MemoryTier })).toThrow();
  });

  it("should refuse a blank label, whitespace of any kind included", () => {
    expect(() => addNode({ label: "   " })).toThrow();
    expect(() => addNode({ label: "\n\t" })).toThrow();
  });

  it("should default a new node into the hot partition", () => {
    const id = newMemoryNodeId();
    db.prepare(
      "INSERT INTO memory_nodes (id, kind, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "person", "the Commander", NOW, NOW);

    expect(db.prepare("SELECT tier FROM memory_nodes WHERE id = ?").get(id)).toEqual({
      tier: "hot",
    });
  });

  it("should let a node point at the operational row it is about", () => {
    const subject = "syl:goal:01991b2f-0000-7000-8000-0000000000cd";
    const id = addNode({ kind: "goal", label: "ship Syl", subjectId: subject });

    expect(db.prepare("SELECT subject_id FROM memory_nodes WHERE id = ?").get(id)).toEqual({
      subject_id: subject,
    });
  });

  it("should refuse a subject that is not an id at all", () => {
    expect(() => addNode({ subjectId: "goal-17" })).toThrow();
  });
});

describe("memory_edges — the two species", () => {
  let a: string;
  let b: string;
  let source: string;

  beforeEach(() => {
    a = addNode({ kind: "person", label: "the Commander" });
    b = addNode({ kind: "goal", label: "ship Syl" });
    source = addNode({ kind: "source", label: "standup note, 2026-08-09" });
  });

  it("should accept an observed edge that carries its provenance", () => {
    const id = addEdge({
      kind: "observed",
      sourceNode: a,
      targetNode: b,
      relation: "owns",
      assertedBy: source,
      weight: 1,
    });

    expect(db.prepare("SELECT asserted_by, kind FROM memory_edges WHERE id = ?").get(id)).toEqual({
      asserted_by: source,
      kind: "observed",
    });
  });

  it("should refuse an observed edge with no provenance", () => {
    // "Asserted by a source" is what makes it observed. Without the source it
    // is an inference wearing the wrong label.
    expect(() =>
      addEdge({ kind: "observed", sourceNode: a, targetNode: b, assertedBy: null }),
    ).toThrow();
  });

  it("should refuse an inferred edge with no reasoning", () => {
    // The reasoning is mandatory. An inference nobody can audit is a rumour.
    expect(() => addEdge({ sourceNode: a, targetNode: b, reasoning: null })).toThrow();
  });

  it("should refuse an inferred edge whose reasoning is only whitespace", () => {
    // Tabs and newlines specifically. SQLite's one-argument `trim` strips
    // SPACES ONLY, so the obvious `length(trim(reasoning)) > 0` lets "\n"
    // through and "mandatory" quietly becomes "mandatory-ish".
    expect(() => addEdge({ sourceNode: a, targetNode: b, reasoning: "  \n " })).toThrow();
    expect(() => addEdge({ sourceNode: a, targetNode: b, reasoning: "\t" })).toThrow();
    expect(() => addEdge({ sourceNode: a, targetNode: b, reasoning: "" })).toThrow();
  });

  it("should refuse an inferred edge with no confidence", () => {
    expect(() => addEdge({ sourceNode: a, targetNode: b, confidence: null })).toThrow();
  });

  it("should refuse to mix the species: provenance on an inference", () => {
    expect(() => addEdge({ sourceNode: a, targetNode: b, assertedBy: source })).toThrow();
  });

  it("should refuse to mix the species: reasoning on an observation", () => {
    expect(() =>
      addEdge({
        kind: "observed",
        sourceNode: a,
        targetNode: b,
        assertedBy: source,
        reasoning: "because I said so",
      }),
    ).toThrow();
  });

  it("should refuse a confidence of zero, because decay never arrives there", () => {
    // Constraint 6: confidence decays asymptotically toward zero and never
    // reaches it, so a dormant edge can always be promoted back. A stored zero
    // would be an edge that has genuinely died.
    expect(() => addEdge({ sourceNode: a, targetNode: b, confidence: 0 })).toThrow();
    expect(() => addEdge({ sourceNode: a, targetNode: b, confidence: 1.2 })).toThrow();
  });

  it("should refuse a weight of zero or more than one", () => {
    expect(() => addEdge({ sourceNode: a, targetNode: b, weight: 0 })).toThrow();
    expect(() => addEdge({ sourceNode: a, targetNode: b, weight: 1.4 })).toThrow();
  });

  it("should refuse an edge from a node to itself", () => {
    expect(() => addEdge({ sourceNode: a, targetNode: a })).toThrow();
  });

  it("should refuse an edge whose endpoint is not a node", () => {
    expect(() =>
      addEdge({ sourceNode: a, targetNode: "syl:memory_node:01991b2f-0000-7000-8000-00000000ffff" }),
    ).toThrow();
  });

  it("should refuse a hot inferred edge with no scheduled floor crossing", () => {
    // Every hot inferred edge must know when it crosses the floor, or the
    // demotion sweep is incomplete and the hot partition grows forever.
    expect(() => addEdge({ sourceNode: a, targetNode: b, demoteAfter: null })).toThrow();
  });

  it("should allow a cold inferred edge with no scheduled crossing", () => {
    expect(() =>
      addEdge({ tier: "cold", sourceNode: a, targetNode: b, demoteAfter: null }),
    ).not.toThrow();
  });

  it("should refuse a scheduled crossing on an observed edge", () => {
    // Observed edges do not decay: they are what a source said. They leave the
    // hot partition only by an explicit move, never on a timer.
    expect(() =>
      addEdge({
        kind: "observed",
        sourceNode: a,
        targetNode: b,
        assertedBy: source,
        demoteAfter: LATER,
      }),
    ).toThrow();
  });
});

describe("edge identity spans every partition", () => {
  let a: string;
  let b: string;

  beforeEach(() => {
    a = addNode({ kind: "person", label: "the Commander" });
    b = addNode({ kind: "goal", label: "ship Syl" });
  });

  it("should refuse a second edge for the same pair and relation, even in a colder tier", () => {
    // The silent-duplication failure syl-005.4.2 exists to prevent, made
    // structural: a cold or suppressed edge is still in the way.
    addEdge({ tier: "cold", sourceNode: a, targetNode: b, relation: "owns", demoteAfter: null });

    expect(() => addEdge({ tier: "hot", sourceNode: a, targetNode: b, relation: "owns" })).toThrow();
  });

  it("should still allow a different relation between the same pair", () => {
    addEdge({ sourceNode: a, targetNode: b, relation: "owns" });

    expect(() => addEdge({ sourceNode: a, targetNode: b, relation: "blocked_by" })).not.toThrow();
  });

  it("should find a suppressed edge by identity, so it is never silently recreated", () => {
    addEdge({
      tier: "suppressed",
      sourceNode: a,
      targetNode: b,
      relation: "owns",
      demoteAfter: null,
    });

    const found = db
      .prepare("SELECT tier FROM memory_edges WHERE source_node = ? AND target_node = ?")
      .all(a, b);

    expect(found).toEqual([{ tier: "suppressed" }]);
  });

  it("should return every tier for a pair in one keyed lookup", () => {
    const c = addNode({ kind: "fact", label: "a third thing" });
    addEdge({ tier: "hot", sourceNode: a, targetNode: b, relation: "owns" });
    addEdge({ tier: "cold", sourceNode: a, targetNode: c, relation: "owns", demoteAfter: null });

    const tiers = db
      .prepare("SELECT tier FROM memory_edges WHERE source_node = ? ORDER BY tier")
      .all(a)
      .map((row) => (row as { tier: string }).tier);

    expect(tiers).toEqual(["cold", "hot"]);
  });

  it("should answer the identity lookup from a tier-free index, not a scan", () => {
    // THE load-bearing assertion of this bead. If the pair lookup ever falls
    // back to a scan, "demote, never prune" quietly becomes "prune, slowly,
    // while claiming otherwise" — the cost of finding a cold edge grows with
    // the whole accumulated history of the graph.
    //
    // Either tier-free index serves it; SQLite picks between them on estimates
    // and the choice is not the property under test. That neither of them
    // mentions `tier` is, and the next test asserts it against the DDL.
    const plan = queryPlan(
      "SELECT id FROM memory_edges WHERE source_node = ? AND target_node = ?",
      a,
      b,
    );

    expect(plan).toMatch(/index memory_edges_(identity|reverse)_idx/u);
    expect(plan).not.toContain("scan memory_edges");
  });

  it("should answer the reverse traversal from an index too", () => {
    const plan = queryPlan("SELECT id FROM memory_edges WHERE target_node = ?", b);

    expect(plan).toContain("memory_edges_reverse_idx");
    expect(plan).not.toContain("scan memory_edges");
  });

  it("should not let the partition key into either identity index", () => {
    // Stated against the schema itself, because this is the property a future
    // "let's add tier to that index, it'll be faster" would destroy — and it
    // would destroy it invisibly, since every query would still return the
    // right rows.
    const indexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND name IN ('memory_edges_identity_idx', 'memory_edges_reverse_idx')
          ORDER BY name`,
      )
      .all()
      .map((row) => row as { name: string; sql: string });

    expect(indexes.map((index) => index.name)).toEqual([
      "memory_edges_identity_idx",
      "memory_edges_reverse_idx",
    ]);
    for (const index of indexes) {
      expect(index.sql.toLowerCase()).not.toContain("tier");
    }
    expect(indexes[0]?.sql.toLowerCase()).toContain("(source_node, target_node, relation)");
    expect(indexes[0]?.sql.toLowerCase()).toContain("unique");
  });
});

describe("the partition key prunes the scan", () => {
  it("should rank hot edges from the partitioned index", () => {
    const plan = queryPlan(
      "SELECT id FROM memory_edges WHERE tier = 'hot' AND source_node = ? ORDER BY weight DESC",
      newMemoryNodeId(),
    );

    expect(plan).toContain("memory_edges_rank_idx");
    expect(plan).not.toContain("scan memory_edges");
  });

  it("should find the edges due for demotion without touching the rest", () => {
    // The nightly sweep is a range scan over exactly the edges that have
    // crossed the floor. There is no UPDATE across every edge, ever.
    const plan = queryPlan(
      "SELECT id FROM memory_edges WHERE tier = 'hot' AND demote_after IS NOT NULL AND demote_after <= ?",
      LATER,
    );

    expect(plan).toContain("memory_edges_demote_idx");
    expect(plan).not.toContain("scan memory_edges");
  });

  it("should keep observed edges out of the demotion index entirely", () => {
    const sql = String(
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_edges_demote_idx'").get() as {
          sql: string;
        }
      ).sql,
    ).toLowerCase();

    expect(sql).toContain("(tier, demote_after)");
    expect(sql).toContain("where demote_after is not null");
  });
});

describe("demotion moves a row between partitions and loses nothing", () => {
  it("should keep the edge addressable after it crosses the floor", () => {
    const a = addNode({ kind: "person", label: "the Commander" });
    const b = addNode({ kind: "goal", label: "ship Syl" });
    const id = addEdge({ sourceNode: a, targetNode: b, relation: "owns", weight: 0.02 });

    const moved = db
      .prepare(
        `UPDATE memory_edges SET tier = 'cold', demote_after = NULL, updated_at = ?
         WHERE tier = 'hot' AND demote_after IS NOT NULL AND demote_after <= ?`,
      )
      .run(LATER, LATER);

    expect(moved.changes).toBe(1);
    expect(
      db.prepare("SELECT id, tier, weight FROM memory_edges WHERE source_node = ?").get(a),
    ).toEqual({ id, tier: "cold", weight: 0.02 });
  });

  it("should promote the same row back on reactivation, id and history intact", () => {
    const a = addNode({ kind: "person", label: "the Commander" });
    const b = addNode({ kind: "goal", label: "ship Syl" });
    const id = addEdge({
      tier: "cold",
      sourceNode: a,
      targetNode: b,
      relation: "owns",
      weight: 0.02,
      demoteAfter: null,
    });

    db.prepare(
      `UPDATE memory_edges SET tier = 'hot', weight = ?, last_touched_at = ?, demote_after = ?, updated_at = ?
       WHERE source_node = ? AND target_node = ? AND relation = ?`,
    ).run(0.6, LATER, LATER, LATER, a, b, "owns");

    expect(db.prepare("SELECT id, tier, created_at FROM memory_edges WHERE id = ?").get(id)).toEqual(
      { id, tier: "hot", created_at: NOW },
    );
  });
});

describe("nothing inferred is ever deleted", () => {
  it("should refuse to delete an inferred edge", () => {
    const a = addNode({ kind: "person", label: "the Commander" });
    const b = addNode({ kind: "goal", label: "ship Syl" });
    const id = addEdge({ sourceNode: a, targetNode: b });

    expect(() => db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id)).toThrow(
      /never deleted/u,
    );
    expect(db.prepare("SELECT count(*) AS n FROM memory_edges").get()).toEqual({ n: 1 });
  });

  it("should allow an observed edge to be retracted", () => {
    // An observation can be withdrawn: the source was wrong, or the Commander
    // asked for something to be forgotten outright. An inference cannot,
    // because reflection would only rediscover it.
    const a = addNode({ kind: "person", label: "the Commander" });
    const b = addNode({ kind: "goal", label: "ship Syl" });
    const source = addNode({ kind: "source", label: "a note" });
    const id = addEdge({ kind: "observed", sourceNode: a, targetNode: b, assertedBy: source });

    expect(() => db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id)).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM memory_edges").get()).toEqual({ n: 0 });
  });

  it("should refuse to delete a node an edge still references", () => {
    const a = addNode({ kind: "person", label: "the Commander" });
    const b = addNode({ kind: "goal", label: "ship Syl" });
    addEdge({ sourceNode: a, targetNode: b });

    expect(() => db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(a)).toThrow();
  });
});
