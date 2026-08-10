import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMBEDDING_DIMENSIONS } from "../../src/memory/embed.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { vectorTableDdl } from "../../src/memory/schema.js";
import {
  DEFAULT_SEARCH_LIMIT,
  KEYWORD_TABLE,
  MemoryStore,
  StoreError,
  VECTOR_IDENTITY_SQL,
  VECTOR_TABLE,
  cosineFromL2,
  decodeEmbedding,
  encodeEmbedding,
  keywordQuery,
  loadSqliteVec,
  sqliteVecPath,
} from "../../src/memory/store.js";
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
 * The hybrid store, against the REAL shipped migrations and the REAL `vec0`
 * extension.
 *
 * Nothing here is stubbed. `0018_memory_retrieval.sql` is where the FTS5
 * triggers live and `vectorTableDdl()` is where the partition key lives, so a
 * test that built its own tables would be testing a copy of both decisions —
 * the same argument `memory-core-migration.test.ts` makes, and the reason the
 * partition-key assertions below are worth anything.
 *
 * No model is loaded. Embeddings here are hand-written unit vectors, which is
 * all the store needs: it stores bytes and ranks distances, and whether those
 * bytes came from EmbeddingGemma is `memory-embed-live.test.ts`'s question.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const DIMENSIONS = 4;

let db: Database;
let graph: MemoryGraph;
let store: MemoryStore;

/** A unit vector of the test width, so `cosineFromL2` means what it says. */
function unit(...values: number[]): number[] {
  const padded = [...values, ...Array(Math.max(0, DIMENSIONS - values.length)).fill(0)];
  const magnitude = Math.sqrt(padded.reduce((sum, v) => sum + v * v, 0));
  return padded.map((v) => v / magnitude);
}

function openMigrated(): Database {
  const handle = new DatabaseSync(IN_MEMORY, { allowExtension: true });
  applyPragmas(handle, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(handle, readMigrations(MIGRATIONS_DIR));
  loadSqliteVec(handle);
  return handle;
}

beforeEach(() => {
  db = openMigrated();
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  store = new MemoryStore({ db, dimensions: DIMENSIONS, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

/** Move a node between tiers. `MemoryGraph` has no node demotion yet (syl-005.3.3). */
function setTier(nodeId: string, tier: string): void {
  db.prepare(`UPDATE memory_nodes SET tier = ? WHERE id = ?`).run(tier, nodeId);
}

describe("sqliteVecPath", () => {
  it("should resolve the loadable extension for the platform it is running on", () => {
    expect(sqliteVecPath()).toMatch(/vec0\.(dylib|so|dll)$/u);
  });

  it("should name the platform when sqlite-vec ships no binary for it", () => {
    // The optional-dependency trap: npm installs nothing and reports success,
    // so the bare resolution error never mentions the platform.
    let error: unknown;
    try {
      sqliteVecPath("aix", "mips");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe("extension_unavailable");
    expect((error as StoreError).message).toContain("aix-mips");
    expect((error as StoreError).message).toContain("OPTIONAL");
  });
});

describe("loadSqliteVec", () => {
  it("should load vec0 into a connection opened with allowExtension", () => {
    const handle = new DatabaseSync(IN_MEMORY, { allowExtension: true });
    expect(loadSqliteVec(handle)).toMatch(/vec0\./u);
    expect(handle.prepare("SELECT vec_version() AS v").get()).toMatchObject({
      v: expect.stringContaining("0.1"),
    });
    handle.close();
  });

  it("should refuse a connection that was not opened with allowExtension", () => {
    // The point of the message: node:sqlite offers no way to grant this later,
    // so the fix is at the OPEN and nowhere else.
    const handle = new DatabaseSync(IN_MEMORY);
    expect(() => loadSqliteVec(handle)).toThrow(/allowExtension: true/u);
    handle.close();
  });

  it("should close extension loading again even when the load fails", () => {
    const handle = new DatabaseSync(IN_MEMORY, { allowExtension: true });
    expect(() => loadSqliteVec(handle, "/nonexistent/vec0.dylib")).toThrow(StoreError);
    // Still off: a failed load must not leave the door open either.
    expect(() => handle.loadExtension(sqliteVecPath())).toThrow();
    handle.close();
  });
});

describe("cosineFromL2", () => {
  it("should recover the cosine for the measured vec0 pair", () => {
    // Verified against vec0 0.1.9: [1,0,0,0] vs [0.6,0.8,0,0] returns this
    // distance, and the cosine of that pair is 0.6.
    //
    // 7 places and not 12, and the gap is the whole point: the identity
    // cos = 1 - d^2/2 is EXACT in real arithmetic, and vec0 stores float32, so
    // what comes back is 0.6000000095790412. ~1e-8 of quantisation, which is
    // eight orders of magnitude below any weight in the fusion formula and
    // cannot reorder two candidates that are not already tied.
    expect(cosineFromL2(0.8944271802902222)).toBeCloseTo(0.6, 7);
    expect(cosineFromL2(0)).toBe(1);
  });

  it("should clamp an anti-correlated match to zero rather than let it subtract", () => {
    // d = 2 is the antipode: cos = -1. A negative contribution would let one
    // channel take away what two others voted for.
    expect(cosineFromL2(2)).toBe(0);
    expect(cosineFromL2(3)).toBe(0);
  });

  it("should refuse a distance that is not a finite non-negative number", () => {
    expect(() => cosineFromL2(Number.NaN)).toThrow(StoreError);
    expect(() => cosineFromL2(-1)).toThrow(/non-negative/u);
  });
});

describe("encodeEmbedding", () => {
  it("should round-trip a vector through little-endian float32", () => {
    const values = unit(1, 2, 3, 4);
    const decoded = decodeEmbedding(encodeEmbedding(values, DIMENSIONS));
    expect(decoded).toHaveLength(DIMENSIONS);
    decoded.forEach((value, index) => expect(value).toBeCloseTo(values[index] as number, 6));
  });

  it("should write little-endian regardless of the platform's byte order", () => {
    // 1.0 as float32 is 0x3F800000; little-endian puts 0x3F last.
    const bytes = encodeEmbedding([1, 0, 0, 0], DIMENSIONS);
    expect([...bytes.slice(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3f]);
  });

  it("should refuse the wrong width", () => {
    expect(() => encodeEmbedding([1, 0, 0], DIMENSIONS)).toThrow(/corrupt store/u);
  });

  it("should refuse a non-finite value and name the dimension", () => {
    expect(() => encodeEmbedding([1, Number.NaN, 0, 0], DIMENSIONS)).toThrow(/dimension 1/u);
  });

  it("should refuse a blob that is not a whole number of float32 values", () => {
    expect(() => decodeEmbedding(new Uint8Array(6))).toThrow(StoreError);
  });
});

describe("keywordQuery", () => {
  it("should turn ordinary text into quoted phrases joined by OR", () => {
    expect(keywordQuery("Chicago trip")).toBe('"chicago" OR "trip"');
  });

  it("should neutralise FTS5 operators rather than let them run", () => {
    // Raw, `NEAR` and `-notes` and the colon are a PROGRAM. Quoted, they are
    // three words nobody has to have escaped correctly.
    expect(keywordQuery("syl-005: NEAR review -notes")).toBe(
      '"syl" OR "005" OR "near" OR "review" OR "notes"',
    );
  });

  it("should return null when there is no searchable token at all", () => {
    // Distinct from "no rows matched": the channel is unavailable, not empty.
    expect(keywordQuery("   ?! ")).toBeNull();
    expect(keywordQuery("")).toBeNull();
  });
});

describe("MemoryStore construction", () => {
  it("should create the vector table from vectorTableDdl, partition key and all", () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(VECTOR_TABLE) as unknown as { sql: string };

    expect(row.sql).toContain("tier text partition key");
    expect(row.sql).toContain("kind text partition key");
    expect(row.sql).toContain(`embedding float[${DIMENSIONS}]`);
    // The decision arrived through schema.ts and by no other route.
    expect(row.sql.replace(/\s+/gu, " ")).toBe(
      vectorTableDdl({ table: VECTOR_TABLE, dimensions: DIMENSIONS })
        .replace(/\s+/gu, " ")
        .replace(/\s*;$/u, ""),
    );
  });

  it("should default to the width embed.ts owns rather than hardcoding one", () => {
    const handle = openMigrated();
    const wide = new MemoryStore({ db: handle });
    expect(wide.dimensions).toBe(EMBEDDING_DIMENSIONS);
    handle.close();
  });

  it("should accept an existing vector table of the same shape", () => {
    expect(() => new MemoryStore({ db, dimensions: DIMENSIONS })).not.toThrow();
  });

  it("should refuse an existing vector table built at a different width", () => {
    const handle = openMigrated();
    handle.exec(vectorTableDdl({ table: VECTOR_TABLE, dimensions: 8 }));

    let error: unknown;
    try {
      new MemoryStore({ db: handle, dimensions: DIMENSIONS });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe("table_mismatch");
    expect((error as StoreError).message).toContain("wrong neighbours");
    handle.close();
  });

  it("should refuse a database that has not been migrated", () => {
    const handle = new DatabaseSync(IN_MEMORY, { allowExtension: true });
    loadSqliteVec(handle);
    expect(() => new MemoryStore({ db: handle, dimensions: DIMENSIONS })).toThrow(
      new RegExp(KEYWORD_TABLE, "u"),
    );
    handle.close();
  });

  it("should explain a missing vec0 rather than pass the raw SQL error through", () => {
    const handle = new DatabaseSync(IN_MEMORY);
    applyPragmas(handle, { busyTimeoutMs: 100, requireWal: false });
    applyMigrations(handle, readMigrations(MIGRATIONS_DIR));

    let error: unknown;
    try {
      new MemoryStore({ db: handle, dimensions: DIMENSIONS });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as StoreError).kind).toBe("extension_unavailable");
    expect((error as StoreError).message).toContain("loadSqliteVec");
    handle.close();
  });
});

describe("the FTS5 keyword index", () => {
  it("should index a node the moment it is written, with no help from the store", () => {
    // Maintained by TRIGGERS, in the writing transaction. `MemoryGraph` knows
    // nothing about the index and does not have to.
    const node = graph.addNode({ kind: "memory", label: "Chicago trip", body: "flew out Tuesday" });
    expect(store.searchKeyword("chicago").map((hit) => hit.nodeId)).toEqual([node.id]);
    expect(store.searchKeyword("tuesday").map((hit) => hit.nodeId)).toEqual([node.id]);
  });

  it("should hold hot rows only, so demotion removes a node from keyword search", () => {
    // FTS5 has no partition key, so this IS the partitioning. A cold node stays
    // reachable by identity and leaves the scan entirely.
    const node = graph.addNode({ kind: "memory", label: "Chicago trip" });
    setTier(node.id, "cold");

    expect(store.searchKeyword("chicago")).toEqual([]);
    expect(graph.getNode(node.id)?.tier).toBe("cold");
  });

  it("should put a node back into keyword search when it is promoted again", () => {
    const node = graph.addNode({ kind: "memory", label: "Chicago trip" });
    setTier(node.id, "cold");
    setTier(node.id, "hot");
    expect(store.searchKeyword("chicago").map((hit) => hit.nodeId)).toEqual([node.id]);
  });

  it("should follow an edit to a node's text", () => {
    const node = graph.addNode({ kind: "memory", label: "Chicago trip" });
    db.prepare("UPDATE memory_nodes SET label = ? WHERE id = ?").run("Denver trip", node.id);

    expect(store.searchKeyword("chicago")).toEqual([]);
    expect(store.searchKeyword("denver").map((hit) => hit.nodeId)).toEqual([node.id]);
  });

  it("should not re-index a node merely because its trust moved", () => {
    // The trigger is `AFTER UPDATE OF tier, label, body` precisely so feedback
    // does not re-tokenise a whole body. Observable as the row surviving intact.
    const node = graph.addNode({ kind: "memory", label: "Chicago trip" });
    db.prepare("UPDATE memory_nodes SET trust = ? WHERE id = ?").run(0.5, node.id);
    expect(store.searchKeyword("chicago").map((hit) => hit.nodeId)).toEqual([node.id]);
    expect(
      db.prepare(`SELECT count(*) AS c FROM ${KEYWORD_TABLE}`).get(),
    ).toMatchObject({ c: 1 });
  });
});

describe("MemoryStore.searchKeyword", () => {
  it("should rank a better match first", () => {
    const chicago = graph.addNode({
      kind: "memory",
      label: "Chicago",
      body: "chicago chicago chicago",
    });
    graph.addNode({ kind: "memory", label: "Denver", body: "one mention of chicago" });

    const hits = store.searchKeyword("chicago");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.nodeId).toBe(chicago.id);
    // BM25 is negated: more negative is better, so best-first is ascending.
    expect(hits[0]?.bm25).toBeLessThan(hits[1]?.bm25 as number);
  });

  it("should narrow to one node kind on the secondary partition axis", () => {
    graph.addNode({ kind: "memory", label: "the Chicago trip" });
    const person = graph.addNode({ kind: "person", label: "Chicago Jane" });

    expect(store.searchKeyword("chicago", { kind: "person" }).map((h) => h.nodeId)).toEqual([
      person.id,
    ]);
  });

  it("should return nothing for a tier the index does not hold", () => {
    graph.addNode({ kind: "memory", label: "Chicago trip" });
    expect(store.searchKeyword("chicago", { tier: "cold" })).toEqual([]);
  });

  it("should return nothing rather than throw for text with no searchable token", () => {
    graph.addNode({ kind: "memory", label: "Chicago trip" });
    expect(store.searchKeyword("!!!")).toEqual([]);
  });

  it("should refuse a limit that is not a positive integer", () => {
    expect(() => store.searchKeyword("chicago", { limit: 0 })).toThrow(StoreError);
    expect(() => store.searchKeyword("chicago", { limit: 1.5 })).toThrow(/at least 1/u);
  });

  it("should honour its limit", () => {
    for (let i = 0; i < 5; i += 1) graph.addNode({ kind: "memory", label: `chicago ${i}` });
    expect(store.searchKeyword("chicago", { limit: 2 })).toHaveLength(2);
    expect(DEFAULT_SEARCH_LIMIT).toBeGreaterThan(2);
  });
});

describe("MemoryStore.searchVector", () => {
  it("should return nearest first, with the cosine recovered from the distance", () => {
    const near = graph.addNode({ kind: "fact", label: "near" });
    const far = graph.addNode({ kind: "fact", label: "far" });
    store.putVector(near.id, unit(1, 0, 0, 0));
    store.putVector(far.id, unit(0, 1, 0, 0));

    const hits = store.searchVector(unit(1, 0, 0, 0));
    expect(hits.map((hit) => hit.nodeId)).toEqual([near.id, far.id]);
    expect(hits[0]?.similarity).toBeCloseTo(1, 5);
    expect(hits[1]?.similarity).toBeCloseTo(0, 5);
  });

  it("should prune on the tier partition key rather than filter after reading", () => {
    const hot = graph.addNode({ kind: "fact", label: "hot" });
    const cold = graph.addNode({ kind: "fact", label: "cold" });
    store.putVector(hot.id, unit(1, 0, 0, 0));
    setTier(cold.id, "cold");
    store.putVector(cold.id, unit(1, 0, 0, 0));

    expect(store.searchVector(unit(1, 0, 0, 0)).map((h) => h.nodeId)).toEqual([hot.id]);
    // Addressable, never scanned: an explicit tier finds it again.
    expect(store.searchVector(unit(1, 0, 0, 0), { tier: "cold" }).map((h) => h.nodeId)).toEqual([
      cold.id,
    ]);
  });

  it("should narrow on the secondary partition axis too", () => {
    const fact = graph.addNode({ kind: "fact", label: "a fact" });
    const person = graph.addNode({ kind: "person", label: "a person" });
    store.putVector(fact.id, unit(1, 0, 0, 0));
    store.putVector(person.id, unit(1, 0, 0, 0));

    expect(store.searchVector(unit(1, 0, 0, 0), { kind: "person" }).map((h) => h.nodeId)).toEqual([
      person.id,
    ]);
  });

  it("should refuse a query vector of the wrong width", () => {
    expect(() => store.searchVector([1, 0, 0])).toThrow(/corrupt store/u);
  });

  it("should refuse a limit that is not a positive integer", () => {
    expect(() => store.searchVector(unit(1, 0, 0, 0), { limit: -1 })).toThrow(StoreError);
  });

  it("should return nothing when no vector has been written", () => {
    expect(store.searchVector(unit(1, 0, 0, 0))).toEqual([]);
  });
});

describe("MemoryStore.putVector", () => {
  it("should write into the partition the node is actually in", () => {
    const node = graph.addNode({ kind: "person", label: "the Commander" });
    store.putVector(node.id, unit(1, 0, 0, 0));

    expect(db.prepare(VECTOR_IDENTITY_SQL).get(node.id)).toMatchObject({
      tier: "hot",
      kind: "person",
    });
  });

  it("should replace an existing vector rather than duplicate the node", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    store.putVector(node.id, unit(0, 1, 0, 0));

    expect(db.prepare(`SELECT count(*) AS c FROM ${VECTOR_TABLE}`).get()).toMatchObject({ c: 1 });
    expect(store.vectorFor(node.id)?.[1]).toBeCloseTo(1, 5);
  });

  it("should refuse a node that is not in the graph", () => {
    let error: unknown;
    try {
      store.putVector("syl:memory_node:00000000-0000-7000-8000-000000000001", unit(1, 0, 0, 0));
    } catch (thrown) {
      error = thrown;
    }
    expect((error as StoreError).kind).toBe("unknown_node");
  });

  it("should leave the old vector in place when the new one is unusable", () => {
    // The write is one atomic step, so a rejected replacement cannot erase a
    // vector that cost a model call.
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    expect(() => store.putVector(node.id, [1, 0, 0])).toThrow(StoreError);
    expect(store.vectorFor(node.id)?.[0]).toBeCloseTo(1, 5);
  });

  it("should work inside a transaction the caller already opened", () => {
    // A node and its vector are one thing; the store must not break a caller's
    // own transaction by trying to BEGIN inside it.
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    db.exec("BEGIN IMMEDIATE");
    store.putVector(node.id, unit(1, 0, 0, 0));
    db.exec("COMMIT");
    expect(store.hasVector(node.id)).toBe(true);
  });
});

describe("MemoryStore identity lookups", () => {
  it("should not mention tier in the identity SQL", () => {
    // Pinned as text. A `tier` predicate here would work perfectly and quietly
    // stop returning cold vectors — "prune, slowly, while claiming otherwise".
    expect(VECTOR_IDENTITY_SQL).not.toContain("tier =");
    expect(VECTOR_IDENTITY_SQL).toContain("node_id = ?");
  });

  it("should fetch a cold node's vector exactly as cheaply as a hot one", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");
    store.syncPartition(node.id);

    expect(store.hasVector(node.id)).toBe(true);
    expect(store.vectorFor(node.id)?.[0]).toBeCloseTo(1, 5);
  });

  it("should fetch a suppressed node's vector too", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "suppressed");
    store.syncPartition(node.id);
    expect(store.hasVector(node.id)).toBe(true);
  });

  it("should return null for a node that has no vector", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    expect(store.vectorFor(node.id)).toBeNull();
    expect(store.hasVector(node.id)).toBe(false);
  });

  it("should let a vector be written for a node that is already cold", () => {
    // Re-embedding superseded history is legitimate; a tier predicate on the
    // write path would refuse it as "unknown node".
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    setTier(node.id, "cold");
    expect(() => store.putVector(node.id, unit(1, 0, 0, 0))).not.toThrow();
    expect(db.prepare(VECTOR_IDENTITY_SQL).get(node.id)).toMatchObject({ tier: "cold" });
  });
});

describe("MemoryStore.syncPartition", () => {
  it("should move a vector after its node has been demoted", () => {
    // vec0 0.1.9 refuses UPDATE on a partition key column outright, so this is
    // a re-insert and there is no version of it that is not.
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");

    expect(store.syncPartition(node.id)).toBe(true);
    expect(db.prepare(VECTOR_IDENTITY_SQL).get(node.id)).toMatchObject({ tier: "cold" });
    expect(store.searchVector(unit(1, 0, 0, 0))).toEqual([]);
  });

  it("should be a no-op when the partition already agrees", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    expect(store.syncPartition(node.id)).toBe(false);
  });

  it("should report false rather than throw for a node with no vector", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    expect(store.syncPartition(node.id)).toBe(false);
  });

  it("should refuse a node that is not in the graph", () => {
    expect(() =>
      store.syncPartition("syl:memory_node:00000000-0000-7000-8000-000000000009"),
    ).toThrow(StoreError);
  });

  it("should preserve the embedding across the move", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    const values = unit(1, 2, 3, 4);
    store.putVector(node.id, values);
    setTier(node.id, "cold");
    store.syncPartition(node.id);

    store.vectorFor(node.id)?.forEach((value, index) =>
      expect(value).toBeCloseTo(values[index] as number, 6),
    );
  });
});

describe("MemoryStore.removeVector", () => {
  it("should drop a vector and report that it did", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    expect(store.removeVector(node.id)).toBe(true);
    expect(store.hasVector(node.id)).toBe(false);
  });

  it("should report false when there was nothing to remove", () => {
    expect(store.removeVector("syl:memory_node:00000000-0000-7000-8000-00000000000a")).toBe(false);
  });

  it("should reach a cold vector, because retraction is an identity path", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");
    store.syncPartition(node.id);
    expect(store.removeVector(node.id)).toBe(true);
  });
});

describe("a superseded node leaving the ranked path", () => {
  /**
   * The seam between `syl-005.2.2` and `syl-005.3.3`, settled here rather than
   * discovered at merge.
   *
   * The ledger moves a superseded node hot -> cold. If ranked search still
   * returns it, Syl answers with what the Commander believed in March as though
   * it were current — the exact failure the ledger exists to prevent, arriving
   * through the search index, with nothing failing and no log line.
   */
  it("should drop a superseded node from keyword search on the tier update alone", () => {
    // `AFTER UPDATE OF tier, label, body` fires on a tier-ONLY update: the OF
    // list names columns that may appear in the SET clause, not columns that
    // all must. Asserted because assuming it is how the index quietly keeps a
    // superseded node.
    const node = graph.addNode({ kind: "memory", label: "the Q1 plan" });
    expect(store.searchKeyword("q1")).toHaveLength(1);

    setTier(node.id, "cold");
    expect(store.searchKeyword("q1")).toEqual([]);
  });

  it("should drop a superseded node from vector search even before the vector moves", () => {
    // The window this closes: vec0 0.1.9 cannot UPDATE a partition key column,
    // so a vector does NOT follow its node between tiers on its own. Without
    // the confirming join, the stale hot vector is returned.
    const current = graph.addNode({ kind: "fact", label: "current" });
    const superseded = graph.addNode({ kind: "fact", label: "superseded" });
    store.putVector(current.id, unit(0, 1, 0, 0));
    store.putVector(superseded.id, unit(1, 0, 0, 0));

    setTier(superseded.id, "cold");

    // Deliberately NOT drained: the vector is still sitting in the hot partition.
    expect(store.pendingReindex()).toBe(1);
    expect(db.prepare(VECTOR_IDENTITY_SQL).get(superseded.id)).toMatchObject({ tier: "hot" });

    expect(store.searchVector(unit(1, 0, 0, 0)).map((h) => h.nodeId)).toEqual([current.id]);
  });

  it("should not let a cold search under-report because the repair has not run", () => {
    // The direction that fails SILENTLY. The confirming join makes a hot search
    // correct with a stale vector by dropping it; a cold search would instead
    // return nothing, and "nothing there" is indistinguishable from "not
    // repaired yet" — which would hand the cold-store audit a spurious
    // unreachability finding. So a non-hot search drains first.
    const node = graph.addNode({ kind: "fact", label: "the March belief" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");

    // Deliberately NOT drained by the test.
    expect(store.pendingReindex()).toBe(1);
    expect(store.searchVector(unit(1, 0, 0, 0), { tier: "cold" }).map((h) => h.nodeId)).toEqual([
      node.id,
    ]);
    expect(store.pendingReindex()).toBe(0);
  });

  it("should keep a superseded node reachable by identity, so history stays answerable", () => {
    // "What did I believe in March?" — the ledger's history is write-only if
    // this stops being true.
    const node = graph.addNode({ kind: "fact", label: "the March belief" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");
    store.drainReindexQueue();

    expect(graph.getNode(node.id)?.tier).toBe("cold");
    expect(store.vectorFor(node.id)?.[0]).toBeCloseTo(1, 5);
    expect(store.searchVector(unit(1, 0, 0, 0), { tier: "cold" }).map((h) => h.nodeId)).toEqual([
      node.id,
    ]);
  });

  it("should make a revived node searchable again with no re-embedding", () => {
    // The failure that (a)-only would have: a node promoted back stays
    // invisible because nothing re-inserted it. Both indexes recover.
    const node = graph.addNode({ kind: "memory", label: "the Q1 plan" });
    store.putVector(node.id, unit(1, 0, 0, 0));

    setTier(node.id, "cold");
    store.drainReindexQueue();
    expect(store.searchKeyword("q1")).toEqual([]);
    expect(store.searchVector(unit(1, 0, 0, 0))).toEqual([]);

    setTier(node.id, "hot");
    store.drainReindexQueue();
    expect(store.searchKeyword("q1").map((h) => h.nodeId)).toEqual([node.id]);
    expect(store.searchVector(unit(1, 0, 0, 0)).map((h) => h.nodeId)).toEqual([node.id]);
  });
});

describe("MemoryStore.drainReindexQueue", () => {
  it("should be filled by the tier change itself, with nothing to call", () => {
    // The guarantee is the service's, not the caller's: `supersedeNode` does a
    // tier UPDATE and owes nothing else.
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    expect(store.pendingReindex()).toBe(0);

    setTier(node.id, "cold");
    expect(store.pendingReindex()).toBe(1);
  });

  it("should move every queued vector and empty the queue", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");

    expect(store.drainReindexQueue()).toBe(1);
    expect(store.pendingReindex()).toBe(0);
    expect(db.prepare(VECTOR_IDENTITY_SQL).get(node.id)).toMatchObject({ tier: "cold" });
  });

  it("should not queue an update that changed no partition column", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    db.prepare("UPDATE memory_nodes SET tier = 'hot' WHERE id = ?").run(node.id);
    expect(store.pendingReindex()).toBe(0);
  });

  it("should clear a queued node that has no vector rather than retry it forever", () => {
    const node = graph.addNode({ kind: "fact", label: "never embedded" });
    setTier(node.id, "cold");

    expect(store.drainReindexQueue()).toBe(0);
    expect(store.pendingReindex()).toBe(0);
  });

  it("should refuse a limit that is not a positive integer", () => {
    expect(() => store.drainReindexQueue(0)).toThrow(StoreError);
  });
});

describe("MemoryStore.reconcile", () => {
  it("should report clean when both indexes agree with the graph", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));

    const drift = store.reconcile();
    expect(drift.clean).toBe(true);
    expect(drift).toMatchObject({
      missingVectors: [],
      orphanVectors: [],
      stalePartitions: [],
      missingKeyword: [],
      orphanKeyword: [],
    });
  });

  it("should name a hot node that has no vector", () => {
    // The failure a trigger would have prevented and cannot: an embedding is
    // not derivable in SQL, so this is the only thing that catches it.
    const node = graph.addNode({ kind: "fact", label: "never embedded" });
    const drift = store.reconcile();
    expect(drift.missingVectors).toEqual([node.id]);
    expect(drift.clean).toBe(false);
  });

  it("should name a vector whose partition its node has left", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    setTier(node.id, "cold");

    const drift = store.reconcile();
    expect(drift.stalePartitions).toEqual([
      { nodeId: node.id, vector: { tier: "hot", kind: "fact" }, node: { tier: "cold", kind: "fact" } },
    ]);
    // And syncPartition is the repair.
    store.syncPartition(node.id);
    expect(store.reconcile().stalePartitions).toEqual([]);
  });

  it("should name a vector whose node is gone", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    store.putVector(node.id, unit(1, 0, 0, 0));
    db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(node.id);

    const drift = store.reconcile();
    expect(drift.orphanVectors).toEqual([node.id]);
  });

  it("should bound every list so an audit over a large graph reports a sample", () => {
    for (let i = 0; i < 5; i += 1) graph.addNode({ kind: "fact", label: `fact ${i}` });
    expect(store.reconcile(2).missingVectors).toHaveLength(2);
    expect(() => store.reconcile(0)).toThrow(StoreError);
  });
});

describe("the trust column", () => {
  it("should default a new node to 0.8, which is unjudged rather than certain", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    expect(db.prepare("SELECT trust FROM memory_nodes WHERE id = ?").get(node.id)).toMatchObject({
      trust: 0.8,
    });
  });

  it("should refuse a stored zero, which would be a memory that can never recover", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });
    expect(() =>
      db.prepare("UPDATE memory_nodes SET trust = 0.0 WHERE id = ?").run(node.id),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE memory_nodes SET trust = 1.5 WHERE id = ?").run(node.id),
    ).toThrow();
  });
});
