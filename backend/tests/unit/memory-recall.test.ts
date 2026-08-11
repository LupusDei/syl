import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DreamLog } from "../../src/memory/dream/log.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { MemoryMetrics } from "../../src/memory/metrics.js";
import { Retriever } from "../../src/memory/retrieve.js";
import { MemoryStore, loadSqliteVec } from "../../src/memory/store.js";
import { EdgeWeights } from "../../src/memory/weights.js";
import { WorkingMemory } from "../../src/memory/working.js";
import { ApiFailure } from "../../src/routes/envelope.js";
import {
  buildRecall,
  DEFAULT_RECALL_LIMIT,
  MAX_RECALL_ENTITIES,
  MAX_RECALL_LIMIT,
  MAX_RECALL_QUERY_CHARS,
  recallBounds,
  type MemoryViews,
  type RecallBounds,
} from "../../src/routes/memory.js";
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
 * `GET /memory/recall` — **the verb she asked for about herself.**
 *
 * > "I have no tool in my hands to search, query or traverse any of it — I can
 * > read the printout and nothing else. So the honest answer to 'can you see
 * > the connections' is that I can't even see the nodes. I see a summary
 * > someone else chose for me." — Syl, 2026-08-11
 *
 * Four properties carry `syl-016.1` and `syl-016.2`, and each has a block
 * below. None of them is "search works" — `memory-retrieve.test.ts` owns that,
 * and a second copy of it here would be testing somebody else's module:
 *
 * 1. **Every answer carries ids.** This is the whole point. Every other verb in
 *    `syl-016` acts on an id, and before this route there was no way for her to
 *    obtain one. A recall that returned prose would be a nicer printout and
 *    would fix nothing.
 * 2. **A match and a neighbour are different claims.** `retrieve()` returns
 *    entry points AND the neighbourhood, and its own header warns that a caller
 *    reading only `entries` has used a search engine and left the graph on the
 *    table. Both come back, labelled, because "this answers you" and "this
 *    touches something that does" must not read the same.
 * 3. **"I found nothing" and "I could not look" are different sentences.** A
 *    machine with no `vec0` must refuse audibly rather than return an empty
 *    list, or she tells him he never mentioned his brother.
 * 4. **No question opens the overflow, and it is not a search.** `syl-016.2`:
 *    the digest counts what it hid and would not name it. What was left out is
 *    a fact about the projection's own salience ranking, and no query text
 *    reproduces it — so this reaches it through that same ranking.
 */

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const DIMENSIONS = 4;

let db: Database;
let graph: MemoryGraph;
let store: MemoryStore;

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

/**
 * The views the route reads, built the way `bootstrap` builds them.
 *
 * `recall` defaults to a real `Retriever` with **no embedder**, which is not a
 * shortcut: it is the two-channel configuration the fusion kernels are
 * explicitly written for, and it makes the ceiling assertions below exact.
 * `search: false` is the machine with no `vec0` at all.
 */
function views(
  options: { readonly search?: boolean; readonly maxLines?: number } = {},
): MemoryViews {
  const clock = fixedClock(NOW);
  const retriever = new Retriever({ db, store, graph, clock });
  return {
    graph,
    weights: new EdgeWeights({ graph, clock }),
    metrics: new MemoryMetrics({ db, clock }),
    dreams: new DreamLog({ db, clock }),
    // Bounded by LINES rather than bytes when a test wants an overflow. The
    // byte budget has a floor — the note alone is 200-odd bytes and
    // `regenerate` refuses a projection over budget even with nothing admitted
    // — so squeezing it that way would test the overflow guard instead of the
    // overflow.
    working: new WorkingMemory({
      db,
      graph,
      clock,
      ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    }),
    recall: () => (options.search === false ? null : retriever),
  };
}

function bounds(overrides: Partial<RecallBounds> = {}): RecallBounds {
  return { query: null, kind: null, entities: [], limit: DEFAULT_RECALL_LIMIT, ...overrides };
}

/** A request, as far as `recallBounds` reads one. */
function requestWith(query: Record<string, unknown>): Parameters<typeof recallBounds>[0] {
  return { query } as Parameters<typeof recallBounds>[0];
}

// ---------------------------------------------------------------------------
// 1 & 2. Asking a question
// ---------------------------------------------------------------------------

describe("recall, asked a question", () => {
  it("should hand back the nodes it found WITH their ids", async () => {
    // The bead in one assertion. Every other verb in this epic acts on an id,
    // and the only way she could obtain one before this was not at all.
    const roofer = graph.addNode({ kind: "person", label: "the roofer", body: "replaced the gutter" });

    const view = await buildRecall(views(), bounds({ query: "roofer" }), NOW);

    expect(view.mode).toBe("search");
    expect(view.asked).toBe("roofer");
    expect(view.found.map((node) => node.id)).toContain(roofer.id);
    expect(view.found[0]?.label).toBe("the roofer");
    expect(view.found[0]?.body).toBe("replaced the gutter");
  });

  it("should tell a match apart from something the match merely touches", async () => {
    // `retrieve()`'s own header: a caller that reads only `entries` has used a
    // search engine and left the graph on the table. Both come back — and they
    // are labelled, because they are different claims about her knowledge.
    const roofer = graph.addNode({ kind: "person", label: "the roofer" });
    const gutter = graph.addNode({ kind: "event", label: "the storm in March" });
    const said = graph.addNode({ kind: "source", label: "a March conversation" });
    graph.observe({
      sourceNode: roofer.id,
      targetNode: gutter.id,
      relation: "involved_in",
      assertedBy: said.id,
    });

    const view = await buildRecall(views(), bounds({ query: "roofer" }), NOW);

    const byId = new Map(view.found.map((node) => [node.id, node]));
    expect(byId.get(roofer.id)?.origin).toBe("matched");
    expect(byId.get(gutter.id)?.origin).toBe("connected");
    // The ranked one first: what best answers her is what she reads first.
    expect(view.found[0]?.id).toBe(roofer.id);
  });

  it("should carry the connections themselves, with the reasoning on an inference", async () => {
    // The two species stay apart on the wire, exactly as `MemoryEdgeView` keeps
    // them: Syl's own speculation and a source's assertion must not be readable
    // through one field.
    const roofer = graph.addNode({ kind: "person", label: "the roofer" });
    const goal = graph.addNode({ kind: "goal", label: "sell the house" });
    graph.infer({
      sourceNode: roofer.id,
      targetNode: goal.id,
      relation: "relates_to",
      reasoning: "He called the roofer the week he first mentioned selling.",
      confidence: 0.6,
      weight: 0.7,
      demoteAfter: "2026-09-11T12:00:00.000Z",
    });

    const view = await buildRecall(views(), bounds({ query: "roofer" }), NOW);

    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]?.kind).toBe("inferred");
    expect(view.connections[0]?.reasoning).toContain("the week he first mentioned selling");
  });

  it("should say which channels searched and which could not, and cap the score honestly", async () => {
    // The fusion weights are never renormalised, so a two-channel answer caps
    // at 0.7 — and a caller comparing a score to a fixed threshold has to be
    // told that. Reporting 0.7 as though it were out of 1.0 is the "manufactured
    // confidence" `retrieve.ts` refuses.
    graph.addNode({ kind: "memory", label: "the roofer" });

    const view = await buildRecall(views(), bounds({ query: "roofer" }), NOW);

    expect(view.channels).toEqual(["keyword"]);
    expect(view.ceiling).toBeCloseTo(0.4, 12);
    expect(view.explanation).toContain("Searched by: keyword");
    expect(view.explanation).toContain("NOT searched by: overlap, holographic");
    // And it says how to buy the missing one back, since that channel's absence
    // is the caller's own choice rather than a property of the machine.
    expect(view.explanation).toContain("name the people or things it is about");
  });

  it("should never claim there is nothing more, because ranking does not count what it passed", async () => {
    // `more: 0` here would be a statement about the whole store that ranking is
    // in no position to make. `null` says "not counted", which is true.
    for (let i = 0; i < 5; i += 1) graph.addNode({ kind: "memory", label: `roofer ${String(i)}` });

    const view = await buildRecall(views(), bounds({ query: "roofer", limit: 2 }), NOW);

    expect(view.found.filter((node) => node.origin === "matched")).toHaveLength(2);
    expect(view.more).toBeNull();
    expect(view.explanation).toContain("does not say how much more there is");
  });

  it("should answer an empty-handed search without pretending it did not look", async () => {
    graph.addNode({ kind: "memory", label: "the roofer" });

    const view = await buildRecall(views(), bounds({ query: "submarine" }), NOW);

    expect(view.found).toEqual([]);
    expect(view.explanation).toContain("Nothing matched on any channel");
  });

  it("should narrow to one kind when asked", async () => {
    graph.addNode({ kind: "person", label: "roofer jane" });
    graph.addNode({ kind: "memory", label: "roofer invoice" });

    const view = await buildRecall(views(), bounds({ query: "roofer", kind: "person" }), NOW);

    expect(view.found.every((node) => node.kind === "person")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. What a machine with no search must say
// ---------------------------------------------------------------------------

describe("recall on a machine whose searchable half did not assemble", () => {
  it("should refuse audibly rather than answer that she knows nothing", async () => {
    // The failure this guard exists for: `sqlite-vec` ships its binaries as
    // per-platform OPTIONAL dependencies, so "absent" is a state `npm install`
    // reports success for. An empty list here would have her telling him he
    // never mentioned his brother.
    graph.addNode({ kind: "person", label: "his brother" });

    await expect(
      buildRecall(views({ search: false }), bounds({ query: "brother" }), NOW),
    ).rejects.toBeInstanceOf(ApiFailure);

    const failure = await buildRecall(views({ search: false }), bounds({ query: "brother" }), NOW)
      .then(() => null)
      .catch((error: unknown) => error as ApiFailure);

    expect(failure?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(failure?.message).toContain("cannot be searched");
    // A sentence she can say, and one that tells her what still works.
    expect(failure?.message).toContain("can still be opened without a question");
  });

  it("should still open the overflow, which needs no vector search at all", async () => {
    // Worth asserting rather than assuming: the two modes have different
    // dependencies, and the degraded machine keeps the one that reaches the
    // items her digest is actively hiding from her.
    graph.addNode({ kind: "person", label: "his brother" });

    const view = await buildRecall(views({ search: false, maxLines: 9 }), bounds(), NOW);

    expect(view.mode).toBe("not_shown");
  });
});

// ---------------------------------------------------------------------------
// 4. Opening the overflow — `syl-016.2`
// ---------------------------------------------------------------------------

describe("recall, asked nothing", () => {
  /** More hot nodes than a deliberately tiny projection can hold. */
  function crowd(): void {
    graph.addNode({ kind: "person", label: "the Commander", body: "calls Syl by name" });
    graph.addNode({ kind: "person", label: "his wife" });
    graph.addNode({ kind: "goal", label: "sell the house" });
    graph.addNode({ kind: "fact", label: "he sleeps badly in August" });
    graph.addNode({ kind: "decision", label: "no metered API, ever" });
  }

  it("should return exactly what the digest could not fit, with their ids", async () => {
    crowd();
    const memory = views({ maxLines: 9 });
    const digest = memory.working.regenerate();

    const view = await buildRecall(memory, bounds(), NOW);

    expect(view.mode).toBe("not_shown");
    expect(view.asked).toBeNull();
    expect(view.found.map((node) => node.id)).toEqual(digest.plan.dropped);
    expect(view.found.every((node) => node.id !== "")).toBe(true);
    // Not a search, and it says so — the distinction matters because "what is
    // being kept from me" is a question no query text can answer.
    expect(view.explanation).toContain("NOT a search");
  });

  it("should say what KIND of thing was left out, not merely how many", async () => {
    // The whole of `syl-016.2`. A bare count told her she was deciding with a
    // known gap and gave her nothing to weigh: ten dropped sources and ten
    // dropped people are not the same situation.
    crowd();
    const memory = views({ maxLines: 9 });

    const view = await buildRecall(memory, bounds(), NOW);

    expect(view.byKind.length).toBeGreaterThan(0);
    expect(view.byKind.reduce((sum, entry) => sum + entry.count, 0)).toBe(
      memory.working.overflow({ limit: 1000 }).total,
    );
  });

  it("should open one kind of the overflow while still reporting its whole shape", async () => {
    // She reads "2 people, 1 fact" and asks for the people. Narrowing must not
    // make the rest of the omission invisible — that would be the original
    // defect with an extra step.
    crowd();
    const memory = views({ maxLines: 9 });
    const whole = memory.working.overflow({ limit: 1000 });

    const view = await buildRecall(memory, bounds({ kind: "person" }), NOW);

    expect(view.found.every((node) => node.kind === "person")).toBe(true);
    expect(view.byKind).toEqual(whole.byKind);
  });

  it("should count what the limit held back, because this set IS finite and known", async () => {
    // The opposite of the search case, and deliberately so. Here the answer is
    // countable, so `null` would be a shrug where a number exists.
    crowd();
    const memory = views({ maxLines: 9 });
    const whole = memory.working.overflow({ limit: 1000 });

    const view = await buildRecall(memory, bounds({ limit: 1 }), NOW);

    expect(view.found).toHaveLength(1);
    expect(view.more).toBe(whole.total - 1);
  });

  it("should be empty and honest when the digest is hiding nothing", async () => {
    graph.addNode({ kind: "person", label: "the Commander" });

    const view = await buildRecall(views(), bounds(), NOW);

    expect(view.found).toEqual([]);
    expect(view.more).toBe(0);
    expect(view.byKind).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

describe("recallBounds", () => {
  it("should treat an absent question and a blank one as the same intent", () => {
    // A model with nothing to search for sends one or the other depending on
    // how it was feeling. Making the empty string a validation error would be a
    // refusal she has no way to interpret.
    expect(recallBounds(requestWith({})).query).toBeNull();
    expect(recallBounds(requestWith({ q: "" })).query).toBeNull();
    expect(recallBounds(requestWith({ q: "   " })).query).toBeNull();
  });

  it("should trim a question rather than search on its whitespace", () => {
    expect(recallBounds(requestWith({ q: "  the roofer " })).query).toBe("the roofer");
  });

  it("should refuse a repeated question rather than pick one", () => {
    expect(() => recallBounds(requestWith({ q: ["a", "b"] }))).toThrow(ApiFailure);
  });

  it("should refuse a question longer than it will search on", () => {
    const long = "a".repeat(MAX_RECALL_QUERY_CHARS + 1);
    expect(() => recallBounds(requestWith({ q: long }))).toThrow(ApiFailure);
  });

  it("should refuse a kind that is not one, naming the ones that are", () => {
    let thrown: ApiFailure | null = null;
    try {
      recallBounds(requestWith({ kind: "roofer" }));
    } catch (error) {
      thrown = error as ApiFailure;
    }

    expect(thrown?.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(thrown?.toApiError())).toContain("person");
  });

  it("should accept entity names comma-separated or repeated, since a caller cannot know which", () => {
    expect(recallBounds(requestWith({ about: "Dave, the roofer" })).entities).toEqual([
      "Dave",
      "the roofer",
    ]);
    expect(recallBounds(requestWith({ about: ["Dave", "the roofer"] })).entities).toEqual([
      "Dave",
      "the roofer",
    ]);
  });

  it("should bound how many entity names it will carry", () => {
    const many = Array.from({ length: MAX_RECALL_ENTITIES + 5 }, (_u, i) => `name${String(i)}`);
    expect(recallBounds(requestWith({ about: many })).entities).toHaveLength(MAX_RECALL_ENTITIES);
  });

  it("should refuse a limit outside what it will serve rather than quietly clamping it", () => {
    // `countParam`'s rule: a value read as something else hands back an answer
    // to a question nobody asked, under a label that says otherwise.
    expect(() => recallBounds(requestWith({ limit: "0" }))).toThrow(ApiFailure);
    expect(() =>
      recallBounds(requestWith({ limit: String(MAX_RECALL_LIMIT + 1) })),
    ).toThrow(ApiFailure);
    expect(recallBounds(requestWith({})).limit).toBe(DEFAULT_RECALL_LIMIT);
  });
});
