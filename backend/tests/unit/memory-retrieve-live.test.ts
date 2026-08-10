import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EMBEDDING_DIMENSIONS, createEmbedder, type Embedder } from "../../src/memory/embed.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { Retriever } from "../../src/memory/retrieve.js";
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
 * The only place retrieval QUALITY is measured, and it is opt-in.
 *
 *     SYL_EMBED_LIVE=1 npm test -w backend -- memory-retrieve-live
 *
 * `memory-retrieve.test.ts` proves the ARITHMETIC: that a cosine of 0.6
 * contributes exactly 0.3 * 0.6, that an absent channel is not renormalised
 * away, that trust falls twice as fast as it rises. A fake embedder is the
 * right tool for all of that and a sharper one than real weights, because the
 * numbers can be exact.
 *
 * What a fake structurally cannot tell you is whether the ranking is any
 * GOOD — whether fusing three channels actually finds the memory a person
 * meant when the words do not match. That needs the real model, and the real
 * model is a few hundred megabytes and a download, so it lives here and behind
 * the same `SYL_EMBED_LIVE` gate `memory-embed-live.test.ts` established. A
 * default `npm test` stays fast and offline.
 *
 * The corpus is deliberately tiny and deliberately adversarial: each query
 * shares NO content word with the memory it should find, so keyword search
 * cannot get there and only the vector channel can. That is the claim hybrid
 * retrieval makes, stated as something that can fail.
 */

const LIVE = process.env["SYL_EMBED_LIVE"] === "1";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

/** Six memories of the kind Syl would actually hold. */
const CORPUS: readonly { label: string; body: string }[] = [
  { label: "Standup note", body: "The Commander drives to the office on Tuesdays." },
  { label: "Kitchen", body: "He grinds beans by hand every morning before anything else." },
  { label: "Q3 planning", body: "The launch slipped to November because of the audit." },
  { label: "Health", body: "He swims a mile on Thursday evenings at the university pool." },
  { label: "Household", body: "The dog is called Peppi and dislikes the postman." },
  { label: "Finance", body: "The mortgage rate is fixed until 2029." },
];

/** Paraphrases that share no content word with their target. */
const PROBES: readonly { query: string; expect: string }[] = [
  { query: "What does he do with his automobile?", expect: "Standup note" },
  { query: "Tell me about his coffee routine.", expect: "Kitchen" },
  { query: "Which pet lives in the house?", expect: "Household" },
  { query: "What exercise does he get?", expect: "Health" },
];

let db: Database;
let graph: MemoryGraph;
let store: MemoryStore;
let retriever: Retriever;
let embedder: Embedder;

beforeAll(async () => {
  if (!LIVE) return;

  db = new DatabaseSync(IN_MEMORY, { allowExtension: true });
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  loadSqliteVec(db);

  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  store = new MemoryStore({ db, dimensions: EMBEDDING_DIMENSIONS, clock: fixedClock(NOW) });
  embedder = createEmbedder();
  retriever = new Retriever({ db, store, graph, embedder, clock: fixedClock(NOW) });

  const vectors = await embedder.embedDocuments(
    CORPUS.map((entry) => ({ text: entry.body, title: entry.label })),
  );
  CORPUS.forEach((entry, index) => {
    const node = graph.addNode({ kind: "memory", label: entry.label, body: entry.body });
    store.putVector(node.id, vectors[index] as number[]);
  });
}, 600_000);

afterAll(() => {
  if (LIVE) db.close();
});

describe.skipIf(!LIVE)("retrieval quality, on the real model", () => {
  it("should find the right memory from a paraphrase that shares no content word", async () => {
    // If this fails, hybrid retrieval is not buying what it claims to buy.
    const missed: string[] = [];
    for (const probe of PROBES) {
      const result = await retriever.retrieve({ text: probe.query, depth: 0, limit: 3 });
      if (result.entries[0]?.node.label !== probe.expect) {
        missed.push(`${probe.query} -> ${result.entries[0]?.node.label ?? "nothing"}`);
      }
    }
    expect(missed).toEqual([]);
  }, 600_000);

  it("should do strictly better than keyword search alone on those probes", async () => {
    // The comparison that justifies the second channel's existence and its
    // cost. Keyword-only is the same retriever with no embedder.
    const keywordOnly = new Retriever({ db, store, graph, clock: fixedClock(NOW) });

    let fused = 0;
    let keyword = 0;
    for (const probe of PROBES) {
      const a = await retriever.retrieve({ text: probe.query, depth: 0, limit: 3 });
      const b = await keywordOnly.retrieve({ text: probe.query, depth: 0, limit: 3 });
      if (a.entries[0]?.node.label === probe.expect) fused += 1;
      if (b.entries[0]?.node.label === probe.expect) keyword += 1;
    }

    expect(fused).toBe(PROBES.length);
    expect(fused).toBeGreaterThan(keyword);
  }, 600_000);

  it("should still beat the rest when the query DOES share the words", async () => {
    // The other direction: adding vectors must not cost precision on the easy
    // case that keyword already handled.
    const result = await retriever.retrieve({
      text: "mortgage rate fixed",
      depth: 0,
      limit: 3,
    });
    expect(result.entries[0]?.node.label).toBe("Finance");
    expect(result.entries[0]?.channels).toEqual(["keyword", "overlap"]);
  }, 600_000);

  it("should carry the holographic channel when an entity is named", async () => {
    const result = await retriever.retrieve({
      text: "the dog",
      entities: ["Household"],
      depth: 0,
      limit: 3,
    });
    expect(result.channels).toEqual(["keyword", "overlap", "holographic"]);
    expect(result.ceiling).toBeCloseTo(1, 12);
    expect(result.entries[0]?.node.label).toBe("Household");
  }, 600_000);
});
