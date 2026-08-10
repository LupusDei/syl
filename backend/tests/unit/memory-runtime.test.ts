import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  modelSpec,
  type Embedder,
} from "../../src/memory/embed.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { StoreError, loadSqliteVec } from "../../src/memory/store.js";
import { fixedClock } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import {
  MemoryRuntime,
  MemoryRuntimeError,
  storeSemanticProposer,
} from "../../src/services/memory-runtime.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The seam that lets the memory epic be wired into `bootstrap` at all.
 *
 * Two things in this layer are expensive or fallible in a way the rest of the
 * service is not, and the runtime exists to keep both of them off the boot
 * path:
 *
 *  - **`vec0`** is a loadable native extension. It is fast, but it can be
 *    absent — `sqlite-vec` ships per-platform binaries as optional
 *    dependencies — and a `MemoryStore` constructor that threw inside
 *    `bootstrap` would take the whole service down with it. Syl holds
 *    reminder-delivery guarantees; losing search is not a reason to stop
 *    delivering reminders.
 *  - **the model** is several hundred megabytes of weights. `embed.ts` already
 *    defers that to the first `embedQuery`, so constructing an `Embedder` is
 *    free — and the tests below assert that building the whole runtime never
 *    calls the loader, because a wiring change that made it eager would be
 *    caught by nothing except a very slow `npm test`.
 *
 * Everything that is only prepared statements over the same handle —
 * `SupersessionLedger` — is built eagerly, because it can neither fail nor
 * block.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

let db: Database;
let graph: MemoryGraph;

function openMigrated(): Database {
  const handle = new DatabaseSync(IN_MEMORY, { allowExtension: true });
  applyPragmas(handle, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(handle, readMigrations(MIGRATIONS_DIR));
  return handle;
}

/** An embedder that answers instantly and never loads anything. */
function fakeEmbedder(vector: readonly number[] = unit(1)): Embedder & {
  readonly queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    model: modelSpec(DEFAULT_EMBEDDING_MODEL),
    dimensions: EMBEDDING_DIMENSIONS,
    embedQuery: async (text: string) => {
      queries.push(text);
      return [...vector];
    },
    embedDocuments: async (documents) => documents.map(() => [...vector]),
    device: async () => ({ device: "cpu", fellBack: false, reason: "a test" }),
  };
}

/** A unit vector of the production width, so cosine means what it says. */
function unit(...values: number[]): number[] {
  const padded = [
    ...values,
    ...(Array(Math.max(0, EMBEDDING_DIMENSIONS - values.length)).fill(0) as number[]),
  ];
  const magnitude = Math.sqrt(padded.reduce((sum, v) => sum + v * v, 0));
  return padded.map((v) => v / magnitude);
}

beforeEach(() => {
  db = openMigrated();
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

describe("MemoryRuntime — construction", () => {
  it("should build the ledger eagerly, because it is prepared statements and cannot fail", () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });

    const subject = graph.addNode({ kind: "fact", label: "the gutter" });
    const node = graph.addNode({ kind: "fact", label: "the gutter was replaced" });
    const result = runtime.ledger.assert({
      subject: subject.id,
      relation: "state",
      value: "replaced",
      valueNode: node.id,
    });

    expect(result.current.value).toBe("replaced");
    expect(result.unchanged).toBe(false);
  });

  it("should not touch the vec0 extension until the searchable half is asked for", () => {
    const loadExtension = vi.fn(() => "never");

    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW), loadExtension });

    expect(loadExtension).not.toHaveBeenCalled();
    expect(runtime.ready).toBe(false);
    expect(runtime.lastFailure).toBeNull();
  });

  it("should not load model weights even when the searchable half IS built", () => {
    // The whole point of the `loadExtractor` seam: a normal `npm test` must
    // never fetch several hundred megabytes, and neither must a boot.
    const loadExtractor = vi.fn(() => {
      throw new Error("a test must never load the model");
    });
    const runtime = new MemoryRuntime({
      db,
      graph,
      clock: fixedClock(NOW),
      embedderOptions: { loadExtractor },
    });

    const searchable = runtime.searchable();

    expect(searchable.embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(loadExtractor).not.toHaveBeenCalled();
  });

  it("should not throw at construction when vec0 cannot be loaded at all", () => {
    const loadExtension = (): never => {
      throw new StoreError("extension_unavailable", "no binary for this platform");
    };

    expect(() => new MemoryRuntime({ db, graph, loadExtension })).not.toThrow();
  });
});

describe("MemoryRuntime.searchable", () => {
  it("should build a store, a retriever, an embedder and a semantic proposer over one handle", () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });

    const searchable = runtime.searchable();

    expect(searchable.store.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(searchable.retriever).toBeDefined();
    expect(searchable.semantic).toBeDefined();
    expect(runtime.ready).toBe(true);
  });

  it("should memoise, so a second caller gets the same store rather than a second vec0 load", () => {
    const loadExtension = vi.fn((handle: Database) => loadSqliteVec(handle));
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW), loadExtension });

    const first = runtime.searchable();
    const second = runtime.searchable();

    expect(second.store).toBe(first.store);
    expect(second.retriever).toBe(first.retriever);
    expect(loadExtension).toHaveBeenCalledTimes(1);
  });

  it("should throw a MemoryRuntimeError naming the cause when vec0 is unavailable", () => {
    const runtime = new MemoryRuntime({
      db,
      graph,
      loadExtension: () => {
        throw new StoreError("extension_unavailable", "no binary for this platform");
      },
    });

    let thrown: unknown;
    try {
      runtime.searchable();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MemoryRuntimeError);
    expect((thrown as Error).message).toContain("no binary for this platform");
    expect(runtime.lastFailure).toBe(thrown);
    expect(runtime.ready).toBe(false);
  });

  it("should not memoise a failure, so a transient one does not poison the runtime forever", () => {
    let attempts = 0;
    const runtime = new MemoryRuntime({
      db,
      graph,
      loadExtension: (handle: Database) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return loadSqliteVec(handle);
      },
    });

    expect(() => runtime.searchable()).toThrow(MemoryRuntimeError);
    expect(runtime.searchable().store).toBeDefined();
    expect(runtime.ready).toBe(true);
  });
});

describe("MemoryRuntime.trySearchable", () => {
  it("should return the searchable half when it can be built", () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });

    expect(runtime.trySearchable()).toBe(runtime.searchable());
  });

  it("should return null rather than throw when vec0 is unavailable", () => {
    const runtime = new MemoryRuntime({
      db,
      graph,
      warn: () => undefined,
      loadExtension: () => {
        throw new Error("no vec0 here");
      },
    });

    expect(runtime.trySearchable()).toBeNull();
    expect(runtime.lastFailure).toBeInstanceOf(MemoryRuntimeError);
  });

  it("should say so once and not on every call, so a broken machine is not sixty lines an hour", () => {
    const warn = vi.fn();
    const runtime = new MemoryRuntime({
      db,
      graph,
      warn,
      loadExtension: () => {
        throw new Error("no vec0 here");
      },
    });

    runtime.trySearchable();
    runtime.trySearchable();
    runtime.trySearchable();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no vec0 here");
  });
});

describe("storeSemanticProposer", () => {
  it("should return the nodes nearest a seed, most similar first", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();

    const seed = graph.addNode({ kind: "fact", label: "the gutter was replaced" });
    const near = graph.addNode({ kind: "fact", label: "the roofer came on Tuesday" });
    const far = graph.addNode({ kind: "fact", label: "Ada prefers oat milk" });
    store.putVector(seed.id, unit(1));
    store.putVector(near.id, unit(0.9, 0.435));
    store.putVector(far.id, unit(0, 1));

    const proposer = storeSemanticProposer({ store, embedder: fakeEmbedder(unit(1)) });
    const hits = await proposer.near(seed, 5);

    expect(hits.map((hit) => hit.nodeId)).toEqual([near.id, far.id]);
    expect(hits[0]?.similarity).toBeGreaterThan(hits[1]?.similarity ?? 1);
  });

  it("should never propose the seed against itself", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();

    const seed = graph.addNode({ kind: "fact", label: "the gutter was replaced" });
    store.putVector(seed.id, unit(1));

    const proposer = storeSemanticProposer({ store, embedder: fakeEmbedder(unit(1)) });

    expect(await proposer.near(seed, 5)).toEqual([]);
  });

  it("should honour the limit after the seed has been removed, not before", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();

    const seed = graph.addNode({ kind: "fact", label: "seed" });
    store.putVector(seed.id, unit(1));
    for (let i = 0; i < 4; i += 1) {
      const node = graph.addNode({ kind: "fact", label: `neighbour ${String(i)}` });
      store.putVector(node.id, unit(1 - (i + 1) / 100, (i + 1) / 100));
    }

    const proposer = storeSemanticProposer({ store, embedder: fakeEmbedder(unit(1)) });

    expect(await proposer.near(seed, 2)).toHaveLength(2);
  });

  it("should reuse the seed's own stored vector rather than paying the model for one it has", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();
    const embedder = fakeEmbedder(unit(1));

    const seed = graph.addNode({ kind: "fact", label: "the gutter was replaced" });
    store.putVector(seed.id, unit(1));

    await storeSemanticProposer({ store, embedder }).near(seed, 3);

    // Zero model calls on the common path: a night sweeps up to 200 seeds, and
    // every one of them is already in the vector table.
    expect(embedder.queries).toEqual([]);
  });

  it("should embed the seed's own text when it has no vector yet", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();
    const embedder = fakeEmbedder(unit(1));

    const seed = graph.addNode({
      kind: "fact",
      label: "the gutter was replaced",
      body: "by the roofer, on Tuesday",
    });

    await storeSemanticProposer({ store, embedder }).near(seed, 3);

    expect(embedder.queries).toHaveLength(1);
    expect(embedder.queries[0]).toContain("the gutter was replaced");
    expect(embedder.queries[0]).toContain("by the roofer, on Tuesday");
  });

  it("should propose across kinds, because a fact relating to a person is the point", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();

    const seed = graph.addNode({ kind: "fact", label: "the gutter was replaced" });
    const person = graph.addNode({ kind: "person", label: "the roofer" });
    store.putVector(seed.id, unit(1));
    store.putVector(person.id, unit(0.99, 0.141));

    const hits = await storeSemanticProposer({ store, embedder: fakeEmbedder() }).near(seed, 5);

    expect(hits.map((hit) => hit.nodeId)).toEqual([person.id]);
  });

  it("should not reach into the cold partition, which the weight law has already judged", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();

    const seed = graph.addNode({ kind: "fact", label: "the gutter was replaced" });
    const cold = graph.addNode({ kind: "fact", label: "a thing long forgotten" });
    store.putVector(seed.id, unit(1));
    store.putVector(cold.id, unit(0.99, 0.141));
    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(cold.id);
    store.syncPartition(cold.id);

    const hits = await storeSemanticProposer({ store, embedder: fakeEmbedder() }).near(seed, 5);

    expect(hits).toEqual([]);
  });

  it("should return nothing when the store holds no vectors at all", async () => {
    const runtime = new MemoryRuntime({ db, graph, clock: fixedClock(NOW) });
    const { store } = runtime.searchable();
    const seed = graph.addNode({ kind: "fact", label: "alone" });

    expect(await storeSemanticProposer({ store, embedder: fakeEmbedder() }).near(seed, 5)).toEqual(
      [],
    );
  });
});
