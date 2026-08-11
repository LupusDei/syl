import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationDigester,
  DIGESTION_EDGE_WEIGHT,
  DIGESTION_SAVEPOINT,
  DigestionStore,
  TURN_CONFIDENCE,
} from "../../src/memory/digest-apply.js";
import type { Digestion } from "../../src/memory/digest.js";
import { EXTRACTION_SAVEPOINT } from "../../src/memory/extract-apply.js";
import { PROSE_CONFIDENCE } from "../../src/memory/entities.js";
import { MemoryGraph, type MemoryNode } from "../../src/memory/graph.js";
import { RelationError } from "../../src/memory/relations.js";
import { newMemorySubjectId } from "../../src/memory/schema.js";
import { fixedClock } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  INTERACTIVE_CONVERSATION_ID,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The guarantee half of digestion: what the service does with a conclusion it
 * has been handed.
 *
 * Against the real migrations, because several of the properties under test are
 * facts about the schema rather than about this code — the `memory_edges`
 * CHECKs are what make "an inference carries its reasoning" true, and
 * `memory_edges_identity_idx` is what makes a second pass free.
 *
 * The clock is frozen (`syl-wh6`): a test that compares stored instants against
 * the real clock fails on a calendar boundary and looks exactly like flake.
 */

const NOW = Date.parse("2026-08-10T09:00:00.000Z");

let db: Database;
let graph: MemoryGraph;
let store: DigestionStore;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  // An in-memory database cannot do WAL, and this is a unit test rather than
  // an assertion about the production journal mode.
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  store = new DigestionStore({ db, graph, clock: fixedClock(NOW) });
});

/** The family as the extractor actually filed it on 2026-08-11. */
function family(): { readonly [name: string]: MemoryNode } {
  return {
    him: graph.addNode({ kind: "person", label: "Justin Martin", body: "The Commander." }),
    wife: graph.addNode({ kind: "person", label: "Ela — his wife", body: "His wife Ela." }),
    ela: graph.addNode({
      kind: "person",
      label: "Ela",
      body: "Ela wants an apartment back home.",
    }),
    son: graph.addNode({ kind: "person", label: "Rowan — his son", body: "His son Rowan." }),
    father: graph.addNode({
      kind: "person",
      label: 'Robert C. Martin ("Uncle Bob") — his father',
      body: "His father.",
    }),
    goal: graph.addNode({ kind: "goal", label: "Get out of debt", body: "His primary goal." }),
  };
}

interface EdgeRow {
  readonly kind: string;
  readonly relation: string;
  readonly confidence: number | null;
  readonly reasoning: string | null;
  readonly asserted_by: string | null;
  readonly demote_after: string | null;
  readonly weight: number;
  readonly tier: string;
}

function edgeRows(): EdgeRow[] {
  return db
    .prepare(
      "SELECT kind, relation, confidence, reasoning, asserted_by, demote_after, weight, tier " +
        "FROM memory_edges ORDER BY relation, id",
    )
    .all() as unknown as EdgeRow[];
}

function digestion(over: Partial<Digestion> = {}): Digestion {
  return { edges: [], same: [], instructionsFound: [], ...over };
}

describe("the species of every edge digestion writes", () => {
  it("should write INFERRED edges and never an observed one", () => {
    // The species column exists for exactly this and has never been used. An
    // edge Syl concluded must never become indistinguishable from something he
    // said, and `observed` is what "he said it" means everywhere else.
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });

    const rows = edgeRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.kind).toBe("inferred");
      expect(row.asserted_by).toBeNull();
    }
  });

  it("should never write the provenance relation, whatever it is handed", () => {
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });
    for (const row of edgeRows()) expect(row.relation).not.toBe("stated");
  });

  it("should give every edge its reasoning, its confidence and permission to die", () => {
    // Constraint 6, and Proposal A section 2: if she cannot say WHY two things
    // are connected we cannot audit it, prune it, or present it — and an edge
    // with no crossing instant is invisible to the nightly sweep forever.
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });

    for (const row of edgeRows()) {
      expect(row.reasoning).toBeTruthy();
      expect((row.reasoning ?? "").trim().length).toBeGreaterThan(0);
      expect(row.confidence).toBeGreaterThan(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
      expect(row.demote_after).not.toBeNull();
      expect(Date.parse(row.demote_after ?? "")).toBeGreaterThan(NOW);
      expect(row.weight).toBe(DIGESTION_EDGE_WEIGHT);
      expect(row.tier).toBe("hot");
    }
  });

  it("should quote what it read in the reasoning, so the edge can be audited", () => {
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });

    const spouse = edgeRows().find((row) => row.relation === "spouse_of");
    expect(spouse?.reasoning).toContain("his wife");
  });
});

describe("moving the live graph's relationships into the column", () => {
  it("should connect his wife, his son and his father by their own relations", () => {
    const nodes = family();
    const result = store.apply({ nodes: Object.values(nodes) });

    const relations = edgeRows().map((row) => row.relation);
    expect(relations).toContain("spouse_of");
    expect(relations).toContain("child_of");
    expect(relations).toContain("parent_of");
    expect(result.edgesWritten).toBe(3);
    expect(result.about).toBe(0);
  });

  it("should not connect a person it cannot name a relation for", () => {
    graph.addNode({ kind: "person", label: "Justin Martin", body: "The Commander." });
    graph.addNode({ kind: "person", label: "Ela — his colleague" });

    const result = store.apply({ nodes: graph.listNodes({ kind: "person", limit: 50 }) });

    expect(result.edgesWritten).toBe(0);
    expect(edgeRows()).toEqual([]);
  });
});

describe("resolving who is who", () => {
  it("should give the two Elas one identity, and stamp it on both rows", () => {
    const nodes = family();
    const result = store.apply({ nodes: Object.values(nodes) });

    const elas = db
      .prepare("SELECT subject_id FROM memory_nodes WHERE kind = 'person' AND label LIKE 'Ela%'")
      .all() as unknown as { subject_id: string | null }[];

    expect(elas).toHaveLength(2);
    expect(elas.every((row) => row.subject_id !== null)).toBe(true);
    expect(new Set(elas.map((row) => row.subject_id)).size).toBe(1);
    expect(result.nodesResolved).toBe(2);
  });

  it("should provably NOT merge the Commander with his father", () => {
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });

    const him = graph.getNode(nodes.him?.id ?? "");
    const father = graph.getNode(nodes.father?.id ?? "");

    // Whichever way resolution went, these two must not have arrived at one
    // identity. `null` on both is the correct outcome: neither has a twin.
    expect(him?.subjectId).toBeNull();
    expect(father?.subjectId).toBeNull();
  });

  it("should mint an identity in its own namespace, not reuse a node id", () => {
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });

    const stamped = graph.getNode(nodes.wife?.id ?? "");
    expect(stamped?.subjectId).toMatch(/^syl:memory_subject:/u);
  });

  it("should SURFACE rather than apply a merge it is not sure of", () => {
    graph.addNode({ kind: "person", label: "Ela — his wife" });
    graph.addNode({ kind: "person", label: "Ela — his colleague" });

    const result = store.apply({ nodes: graph.listNodes({ kind: "person", limit: 50 }) });

    expect(result.identitiesApplied).toBe(0);
    expect(result.proposalsRecorded).toBe(1);

    const open = store.openProposals();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("identity");
    expect(open[0]?.nodeIds).toHaveLength(2);
    expect(open[0]?.reasoning).toContain("Ela");
    expect(open[0]?.status).toBe("open");

    for (const node of graph.listNodes({ kind: "person", limit: 50 })) {
      expect(node.subjectId).toBeNull();
    }
  });

  it("should refuse to re-point a node that already claims a different identity", () => {
    const first = graph.addNode({ kind: "person", label: "Ela" });
    graph.setSubject(first, newMemorySubjectId());
    expect(() => graph.setSubject(first, newMemorySubjectId())).toThrow(/already claims identity/u);
  });
});

describe("idempotence, because this runs after every single turn", () => {
  it("should write nothing at all on a second identical pass", () => {
    const nodes = family();
    const first = store.apply({ nodes: Object.values(nodes) });
    const before = edgeRows();

    const second = store.apply({ nodes: graph.listNodes({ limit: 100 }) });

    expect(first.edgesWritten).toBeGreaterThan(0);
    expect(second.edgesWritten).toBe(0);
    expect(second.edgesSkipped).toBe(first.edgesWritten);
    expect(second.identitiesApplied).toBe(0);
    expect(second.changed).toBe(false);
    expect(edgeRows()).toEqual(before);
  });

  it("should not bump a resolved node's updated_at on a second pass", () => {
    // The strong form of idempotence: not merely "no new rows" but "no writes".
    // A statement that re-stamps the same identity every pass would make every
    // node look freshly touched, which reorders the working-memory projection.
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });
    const after = graph.getNode(nodes.wife?.id ?? "");

    store.apply({ nodes: graph.listNodes({ limit: 100 }) });

    expect(graph.getNode(nodes.wife?.id ?? "")?.updatedAt).toBe(after?.updatedAt);
  });

  it("should not re-create an edge the Commander already suppressed", () => {
    // Dedup spans every tier on purpose. `findEdge` is an identity lookup, so a
    // suppressed edge is found and skipped — otherwise every pass would
    // resurrect a connection he has already rejected.
    const nodes = family();
    store.apply({ nodes: Object.values(nodes) });

    const spouse = graph
      .listNodes({ kind: "person", limit: 50 })
      .flatMap((node) => graph.neighbourhood(node.id).edges)
      .find((edge) => edge.relation === "spouse_of");
    expect(spouse).toBeDefined();
    graph.suppress(spouse!, 0.001);

    const again = store.apply({ nodes: graph.listNodes({ limit: 100 }) });

    expect(again.edgesWritten).toBe(0);
    expect(
      (db.prepare("SELECT count(*) AS n FROM memory_edges WHERE relation = 'spouse_of'").get() as
        unknown as { n: number }).n,
    ).toBe(1);
  });

  it("should not record the same proposal twice", () => {
    graph.addNode({ kind: "person", label: "Ela — his wife" });
    graph.addNode({ kind: "person", label: "Ela — his colleague" });
    const nodes = graph.listNodes({ kind: "person", limit: 50 });

    store.apply({ nodes });
    store.apply({ nodes });

    expect(store.openProposals()).toHaveLength(1);
  });
});

describe("the write seam, where an unknown relation dies", () => {
  it("should reject a relation outside the vocabulary rather than storing it", () => {
    const nodes = family();
    expect(() =>
      store.apply({
        nodes: Object.values(nodes),
        // Bypassing `asDigestion` on purpose: the seam has to hold even when a
        // caller inside the service is the one that got it wrong.
        edges: [
          {
            sourceNode: nodes.wife?.id ?? "",
            targetNode: nodes.him?.id ?? "",
            relation: "married_to" as never,
            reasoning: "…",
            confidence: 0.5,
          },
        ],
      }),
    ).toThrow(RelationError);
  });

  it("should leave the graph untouched when one proposal is bad", () => {
    // All-or-nothing, in one savepoint. A partial digestion would leave edges
    // the caller was never told about.
    const nodes = family();
    try {
      store.apply({
        nodes: Object.values(nodes),
        edges: [
          {
            sourceNode: nodes.wife?.id ?? "",
            targetNode: nodes.him?.id ?? "",
            relation: "not_a_relation" as never,
            reasoning: "…",
            confidence: 0.5,
          },
        ],
      });
    } catch {
      // asserted below
    }

    expect(edgeRows()).toEqual([]);
    for (const node of graph.listNodes({ limit: 100 })) expect(node.subjectId).toBeNull();
  });
});

describe("the run ledger", () => {
  it("should record a run even when it wrote nothing", () => {
    // "We looked and there was nothing to connect" and "we never looked" are
    // different states, and only one of them is a bug.
    store.apply({ nodes: [] });

    const runs = store.recentRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.edgesWritten).toBe(0);
    expect(runs[0]?.windowNodes).toBe(0);
  });

  it("should say how much came from prose and how much from the turn", () => {
    const nodes = family();
    store.apply({
      nodes: Object.values(nodes),
      edges: [
        {
          sourceNode: nodes.goal?.id ?? "",
          targetNode: nodes.him?.id ?? "",
          relation: "about",
          reasoning: "The goal is his.",
          confidence: TURN_CONFIDENCE,
        },
      ],
    });

    const run = store.recentRuns(1)[0];
    expect(run?.proseEdges).toBe(3);
    expect(run?.turnEdges).toBe(1);
    expect(run?.edgesWritten).toBe(4);
  });

  it("should meter the escape hatch against what it actually wrote", () => {
    const nodes = family();
    const result = store.apply({
      nodes: Object.values(nodes),
      edges: [
        {
          sourceNode: nodes.goal?.id ?? "",
          targetNode: nodes.him?.id ?? "",
          relation: "about",
          reasoning: "The goal is his.",
          confidence: TURN_CONFIDENCE,
        },
      ],
    });

    expect(result.about).toBe(1);
    expect(store.recentRuns(1)[0]?.aboutEdges).toBe(1);
    expect(store.recentRuns(1)[0]?.aboutShare).toBeCloseTo(0.25, 10);
  });
});

describe("the confidences, which are the service's and never the model's", () => {
  it("should trust prose it read more than a connection a turn proposed", () => {
    // Prose is the extraction turn's own already-checked judgment, moved into a
    // column. A digestion turn's edge is a fresh conclusion drawn by a turn
    // reading attacker-influenceable text. Those are not equally good evidence.
    expect(PROSE_CONFIDENCE).toBeGreaterThan(TURN_CONFIDENCE);
    expect(TURN_CONFIDENCE).toBeGreaterThan(0);
  });
});

describe("digesting a conversation end to end", () => {
  it("should still connect what the labels say when the model turn fails", () => {
    // The whole reason the deterministic reader is the floor. A turn that times
    // out, returns prose, or is refused costs a logged miss; the connections
    // that were already written down still land.
    const nodes = family();
    const digester = new ConversationDigester({
      store,
      graph,
      run: () => Promise.reject(new Error("the CLI wedged")),
      log: () => undefined,
    });

    return digester
      .digest({ conversationId: INTERACTIVE_CONVERSATION_ID })
      .then((outcome) => {
        expect(outcome.status).toBe("missed");
        expect(outcome.result?.edgesWritten).toBe(3);
        expect(nodes.him).toBeDefined();
      });
  });

  it("should never reject, whatever goes wrong", async () => {
    family();
    const digester = new ConversationDigester({
      store,
      graph,
      run: () => {
        throw new Error("thrown synchronously, before any promise");
      },
      log: () => undefined,
    });

    await expect(digester.digest({ conversationId: INTERACTIVE_CONVERSATION_ID })).resolves
      .toBeDefined();
  });

  it("should apply the turn's edges alongside the ones read from prose", async () => {
    const nodes = family();
    const digester = new ConversationDigester({
      store,
      graph,
      run: (window) => {
        const goal = window.findIndex((node) => node.kind === "goal");
        const him = window.findIndex((node) => node.label === "Justin Martin");
        return Promise.resolve(
          digestion({
            edges: [
              { from: goal + 1, to: him + 1, relation: "about", why: "His own goal." },
            ],
          }),
        );
      },
      log: () => undefined,
    });

    const outcome = await digester.digest({ conversationId: INTERACTIVE_CONVERSATION_ID });

    expect(outcome.status).toBe("digested");
    expect(outcome.result?.edgesWritten).toBe(4);
    expect(edgeRows().map((row) => row.relation)).toContain("about");
    expect(nodes.goal).toBeDefined();
  });

  it("should SURFACE the turn's identity claims and never apply one", async () => {
    // Resolution proposes; only whole-name equality applies automatically. A
    // model's "these two are the same person" is exactly the judgment that must
    // be looked at rather than trusted — the Commander and his father share a
    // surname, and a wrong merge is not demotable the way a wrong edge is.
    const nodes = family();
    const digester = new ConversationDigester({
      store,
      graph,
      run: (window) => {
        const him = window.findIndex((node) => node.label === "Justin Martin");
        const father = window.findIndex((node) => node.label.startsWith("Robert"));
        return Promise.resolve(
          digestion({
            same: [{ nodes: [him + 1, father + 1], why: "Both are called Martin." }],
          }),
        );
      },
      log: () => undefined,
    });

    await digester.digest({ conversationId: INTERACTIVE_CONVERSATION_ID });

    const surfaced = store.openProposals().filter((p) => p.reasoning.includes("Martin"));
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.kind).toBe("identity");
    expect(surfaced[0]?.reasoning).toContain("digestion turn");

    expect(graph.getNode(nodes.him?.id ?? "")?.subjectId).toBeNull();
    expect(graph.getNode(nodes.father?.id ?? "")?.subjectId).toBeNull();
  });

  it("should rebuild the projection only when the graph actually moved", async () => {
    family();
    const onGraphChanged = vi.fn();
    const digester = new ConversationDigester({
      store,
      graph,
      run: () => Promise.resolve(digestion()),
      onGraphChanged,
      log: () => undefined,
    });

    await digester.digest({ conversationId: INTERACTIVE_CONVERSATION_ID });
    expect(onGraphChanged).toHaveBeenCalledTimes(1);

    await digester.digest({ conversationId: INTERACTIVE_CONVERSATION_ID });
    expect(onGraphChanged).toHaveBeenCalledTimes(1);
  });

  it("should skip the turn entirely when the window is too small to connect anything", async () => {
    graph.addNode({ kind: "person", label: "Justin Martin", body: "The Commander." });
    const run = vi.fn();
    const digester = new ConversationDigester({ store, graph, run, log: () => undefined });

    const outcome = await digester.digest({ conversationId: INTERACTIVE_CONVERSATION_ID });

    expect(run).not.toHaveBeenCalled();
    expect(outcome.status).toBe("declined");
    expect(store.recentRuns(1)[0]?.turnOutcome).toBe("skipped");
  });
});

describe("a third writer beside extraction and the dream", () => {
  it("should hold its own savepoint, not one another writer is already using", () => {
    // The concurrency that can actually happen here is NESTING, not racing:
    // `node:sqlite` is synchronous and the service is one process, so two
    // writers interleave at an `await`, between whole statements. What that
    // makes possible is one writer's apply running inside another's open
    // savepoint — and a SHARED NAME would then release the outer writer's
    // savepoint, committing half of somebody else's work. The names must differ.
    expect(DIGESTION_SAVEPOINT).not.toBe(EXTRACTION_SAVEPOINT);
  });

  it("should roll back with an enclosing transaction rather than committing out of it", () => {
    // The property that makes digestion safe to call from inside another
    // writer's unit of work: its savepoint releases into the enclosing
    // transaction and never commits it. If this were a bare BEGIN/COMMIT, an
    // extraction that failed after calling digestion would find its own facts
    // already durable.
    const nodes = family();

    db.exec("BEGIN");
    store.apply({ nodes: Object.values(nodes) });
    expect(edgeRows().length).toBe(3);
    db.exec("ROLLBACK");

    expect(edgeRows()).toEqual([]);
    expect(store.recentRuns(10)).toEqual([]);
  });

  it("should leave a rolled-back digestion invisible to the next pass", () => {
    // And the follow-on: after that rollback the graph is exactly as it was, so
    // the next digestion writes the same three edges rather than deciding they
    // already exist.
    const nodes = family();

    db.exec("BEGIN");
    store.apply({ nodes: Object.values(nodes) });
    db.exec("ROLLBACK");

    expect(store.apply({ nodes: Object.values(nodes) }).edgesWritten).toBe(3);
  });
});
