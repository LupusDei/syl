import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EDGE_IDENTITY_SQL,
  DEMOTE_SWEEP_SQL,
  GraphError,
  MemoryGraph,
  type InferredEdge,
  type MemoryEdge,
  type ObservedEdge,
} from "../../src/memory/graph.js";
import { newMemoryEdgeId, newMemoryNodeId, type MemoryTier } from "../../src/memory/schema.js";
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
 * The graph store, exercised against the REAL shipped migration.
 *
 * `0012_memory_core.sql` is the design; a test that built its own tables would
 * be testing a copy of it. Every assertion below therefore runs on the same
 * schema the service runs on, CHECKs, triggers, partial indexes and all.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const NOW_ISO = "2026-08-09T12:00:00.000Z";
const LATER_ISO = "2026-08-09T18:00:00.000Z";
const LATEST_ISO = "2026-08-10T18:00:00.000Z";

let db: Database;
let graph: MemoryGraph;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

/** The Commander, a goal, and the note that says he owns it. */
function trio(): { commander: string; goal: string; note: string } {
  return {
    commander: graph.addNode({ kind: "person", label: "the Commander" }).id,
    goal: graph.addNode({ kind: "goal", label: "ship Syl" }).id,
    note: graph.addNode({ kind: "source", label: "standup note, 2026-08-09" }).id,
  };
}

/** An inference between two fresh nodes, with everything its species requires. */
function inference(overrides: { relation?: string } = {}): InferredEdge {
  const { commander, goal } = trio();
  return graph.infer({
    sourceNode: commander,
    targetNode: goal,
    relation: overrides.relation ?? "cares_about",
    reasoning: "he mentions it in three of the last five evening reviews",
    confidence: 0.7,
    demoteAfter: LATER_ISO,
  });
}

/** An observation between two fresh nodes, with its provenance. */
function observation(overrides: { relation?: string } = {}): ObservedEdge {
  const { commander, goal, note } = trio();
  return graph.observe({
    sourceNode: commander,
    targetNode: goal,
    relation: overrides.relation ?? "owns",
    assertedBy: note,
  });
}

/** The query plan for a statement, as one lowercase string. */
function queryPlan(sql: string, ...parameters: readonly string[]): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => String((row as { detail: string }).detail))
    .join(" | ")
    .toLowerCase();
}

/** The `kind` of a thrown {@link GraphError}, or the error itself if it is not one. */
function kindOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof GraphError ? error.kind : error;
  }
  return "did not throw";
}

describe("MemoryGraph.addNode", () => {
  it("should write a node of every kind the vocabulary covers", () => {
    for (const kind of ["fact", "memory", "person", "source", "event", "goal", "decision"] as const) {
      const node = graph.addNode({ kind, label: `a ${kind}` });
      expect(node.kind).toBe(kind);
      expect(node.id.startsWith("syl:memory_node:")).toBe(true);
    }

    expect(graph.listNodes({ limit: 100 })).toHaveLength(7);
  });

  it("should land a new node in the hot tier, because a colder tier is only ever reached by a move", () => {
    expect(graph.addNode({ kind: "fact", label: "a fact" }).tier).toBe("hot");
  });

  it("should carry body, subject and stamps through unchanged", () => {
    const subjectId = "syl:goal:01991b2f-0000-7000-8000-0000000000cd";
    const node = graph.addNode({
      kind: "goal",
      label: "ship Syl",
      body: "the whole point",
      subjectId,
    });

    expect(node).toEqual({
      id: node.id,
      tier: "hot",
      kind: "goal",
      label: "ship Syl",
      body: "the whole point",
      subjectId,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
  });

  it("should refuse a blank label, whitespace of any kind included", () => {
    expect(kindOf(() => graph.addNode({ kind: "fact", label: "   " }))).toBe("blank_label");
    expect(kindOf(() => graph.addNode({ kind: "fact", label: "\n\t" }))).toBe("blank_label");
    expect(kindOf(() => graph.addNode({ kind: "fact", label: "" }))).toBe("blank_label");
  });

  it("should trim the label, so two labels that look identical on screen are identical", () => {
    expect(graph.addNode({ kind: "fact", label: "  a fact \n" }).label).toBe("a fact");
  });

  it("should refuse a kind outside the vocabulary", () => {
    expect(
      kindOf(() => graph.addNode({ kind: "vibe" as "fact", label: "a vibe" })),
    ).toBeInstanceOf(Error);
  });

  it("should refuse a subject that is not an id at all", () => {
    // The migration's CHECK would catch `goal-17`; catching it here is what
    // turns a SQLite constraint error into an explanation.
    expect(kindOf(() => graph.addNode({ kind: "goal", label: "x", subjectId: "goal-17" }))).toBe(
      "bad_subject",
    );
  });

  it("should treat an omitted body and subject as null rather than undefined", () => {
    const node = graph.addNode({ kind: "fact", label: "a fact" });

    expect(node.body).toBeNull();
    expect(node.subjectId).toBeNull();
  });
});

describe("MemoryGraph.getNode", () => {
  it("should return a node by id", () => {
    const written = graph.addNode({ kind: "person", label: "the Commander" });

    expect(graph.getNode(written.id)).toEqual(written);
  });

  it("should return null for an id that names nothing", () => {
    expect(graph.getNode(newMemoryNodeId())).toBeNull();
  });

  it("should find a node in any tier, because a node id is an identity lookup", () => {
    const node = graph.addNode({ kind: "fact", label: "an old fact" });
    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(node.id);

    expect(graph.getNode(node.id)?.tier).toBe("cold");
  });
});

describe("MemoryGraph.listNodes", () => {
  beforeEach(() => {
    graph.addNode({ kind: "person", label: "the Commander" });
    graph.addNode({ kind: "fact", label: "a fact" });
    const cold = graph.addNode({ kind: "fact", label: "a forgotten fact" });
    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(cold.id);
  });

  it("should read the hot tier only, because a list is a SCAN", () => {
    const labels = graph.listNodes().map((node) => node.label);

    expect(labels).not.toContain("a forgotten fact");
    expect(labels).toHaveLength(2);
  });

  it("should narrow to one kind on the second partition axis", () => {
    expect(graph.listNodes({ kind: "person" }).map((node) => node.label)).toEqual([
      "the Commander",
    ]);
  });

  it("should read a colder partition only when asked for it explicitly", () => {
    expect(graph.listNodes({ tier: "cold" }).map((node) => node.label)).toEqual([
      "a forgotten fact",
    ]);
  });

  it("should refuse a limit that is not a positive integer", () => {
    expect(kindOf(() => graph.listNodes({ limit: 0 }))).toBe("bad_limit");
    expect(kindOf(() => graph.listNodes({ limit: 1.5 }))).toBe("bad_limit");
  });

  it("should answer from the partitioned scan index rather than a table scan", () => {
    const plan = queryPlan(
      "SELECT id FROM memory_nodes WHERE tier = 'hot' AND kind = 'fact' ORDER BY updated_at DESC",
    );

    expect(plan).toContain("memory_nodes_scan_idx");
    expect(plan).not.toContain("scan memory_nodes");
  });
});

describe("MemoryGraph.nodesForSubject", () => {
  const subjectId = "syl:goal:01991b2f-0000-7000-8000-0000000000cd";

  it("should return every node about one operational row", () => {
    const a = graph.addNode({ kind: "goal", label: "ship Syl", subjectId });
    const b = graph.addNode({ kind: "decision", label: "stdio, not tmux", subjectId });
    graph.addNode({ kind: "fact", label: "unrelated" });

    expect(graph.nodesForSubject(subjectId).map((node) => node.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("should return nothing for a subject the graph knows nothing about", () => {
    expect(graph.nodesForSubject("syl:todo:01991b2f-0000-7000-8000-0000000000ee")).toEqual([]);
  });

  it("should span every tier, because a subject lookup is an identity lookup", () => {
    const node = graph.addNode({ kind: "goal", label: "an old goal", subjectId });
    db.prepare("UPDATE memory_nodes SET tier = 'suppressed' WHERE id = ?").run(node.id);

    expect(graph.nodesForSubject(subjectId).map((found) => found.tier)).toEqual(["suppressed"]);
  });

  it("should refuse a subject that is not an id", () => {
    expect(kindOf(() => graph.nodesForSubject("goal-17"))).toBe("bad_subject");
  });
});

describe("MemoryGraph.observe — the species that carries provenance", () => {
  it("should write an observed edge with its source", () => {
    const { commander, goal, note } = trio();

    const edge = graph.observe({
      sourceNode: commander,
      targetNode: goal,
      relation: "owns",
      assertedBy: note,
    });

    expect(edge).toEqual({
      id: edge.id,
      tier: "hot",
      kind: "observed",
      sourceNode: commander,
      targetNode: goal,
      relation: "owns",
      weight: 1,
      confidence: null,
      reasoning: null,
      assertedBy: note,
      demoteAfter: null,
      lastTouchedAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
  });

  it("should refuse an endpoint that is not a node", () => {
    const { commander, note } = trio();

    expect(
      kindOf(() =>
        graph.observe({
          sourceNode: commander,
          targetNode: newMemoryNodeId(),
          relation: "owns",
          assertedBy: note,
        }),
      ),
    ).toBe("unknown_node");
  });

  it("should refuse provenance that is not a node", () => {
    const { commander, goal } = trio();

    expect(
      kindOf(() =>
        graph.observe({
          sourceNode: commander,
          targetNode: goal,
          relation: "owns",
          assertedBy: newMemoryNodeId(),
        }),
      ),
    ).toBe("unknown_node");
  });

  it("should refuse an edge from a node to itself", () => {
    const { commander, note } = trio();

    expect(
      kindOf(() =>
        graph.observe({
          sourceNode: commander,
          targetNode: commander,
          relation: "knows",
          assertedBy: note,
        }),
      ),
    ).toBe("self_edge");
  });

  it("should refuse a blank relation", () => {
    const { commander, goal, note } = trio();

    expect(
      kindOf(() =>
        graph.observe({
          sourceNode: commander,
          targetNode: goal,
          relation: " \n ",
          assertedBy: note,
        }),
      ),
    ).toBe("blank_relation");
  });

  it("should refuse a weight outside (0, 1]", () => {
    const { commander, goal, note } = trio();
    const observe = (weight: number): ObservedEdge =>
      graph.observe({ sourceNode: commander, targetNode: goal, relation: "owns", assertedBy: note, weight });

    expect(kindOf(() => observe(0))).toBe("bad_weight");
    expect(kindOf(() => observe(1.5))).toBe("bad_weight");
    expect(observe(0.4).weight).toBe(0.4);
  });
});

describe("MemoryGraph.infer — the species that carries its reasoning", () => {
  it("should write an inferred edge with reasoning, confidence and a scheduled crossing", () => {
    const { commander, goal } = trio();

    const edge = graph.infer({
      sourceNode: commander,
      targetNode: goal,
      relation: "cares_about",
      reasoning: "he mentions it in three of the last five evening reviews",
      confidence: 0.7,
      demoteAfter: LATER_ISO,
    });

    expect(edge).toEqual({
      id: edge.id,
      tier: "hot",
      kind: "inferred",
      sourceNode: commander,
      targetNode: goal,
      relation: "cares_about",
      weight: 1,
      confidence: 0.7,
      reasoning: "he mentions it in three of the last five evening reviews",
      assertedBy: null,
      demoteAfter: LATER_ISO,
      lastTouchedAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
  });

  it("should refuse reasoning that is blank, whitespace of any kind included", () => {
    // The reasoning is what makes an inference auditable. Blank reasoning is
    // refused here rather than left to the CHECK, so the caller is told why.
    const { commander, goal } = trio();
    const infer = (reasoning: string): InferredEdge =>
      graph.infer({
        sourceNode: commander,
        targetNode: goal,
        relation: "cares_about",
        reasoning,
        confidence: 0.7,
        demoteAfter: LATER_ISO,
      });

    expect(kindOf(() => infer(""))).toBe("blank_reasoning");
    expect(kindOf(() => infer("   "))).toBe("blank_reasoning");
    expect(kindOf(() => infer("\n\t"))).toBe("blank_reasoning");
  });

  it("should trim the reasoning it stores", () => {
    const { commander, goal } = trio();

    const edge = graph.infer({
      sourceNode: commander,
      targetNode: goal,
      relation: "cares_about",
      reasoning: "  same three reviews \n",
      confidence: 0.7,
      demoteAfter: LATER_ISO,
    });

    expect(edge.reasoning).toBe("same three reviews");
  });

  it("should refuse a confidence outside (0, 1], because decay never arrives at zero", () => {
    const { commander, goal } = trio();
    const infer = (confidence: number): InferredEdge =>
      graph.infer({
        sourceNode: commander,
        targetNode: goal,
        relation: "cares_about",
        reasoning: "because the reviews say so",
        confidence,
        demoteAfter: LATER_ISO,
      });

    expect(kindOf(() => infer(0))).toBe("bad_confidence");
    expect(kindOf(() => infer(1.2))).toBe("bad_confidence");
    expect(infer(1).confidence).toBe(1);
  });

  it("should refuse a crossing instant that is not an Instant", () => {
    // Every hot inference must know when it next crosses the floor, or the
    // demotion sweep is incomplete by exactly the rows that forgot.
    const { commander, goal } = trio();

    expect(
      kindOf(() =>
        graph.infer({
          sourceNode: commander,
          targetNode: goal,
          relation: "cares_about",
          reasoning: "because the reviews say so",
          confidence: 0.7,
          demoteAfter: "2026-08-09T18:00:00+02:00",
        }),
      ),
    ).toBe("bad_instant");
  });

  it("should refuse an inference between a node and itself", () => {
    const { commander } = trio();

    expect(
      kindOf(() =>
        graph.infer({
          sourceNode: commander,
          targetNode: commander,
          relation: "is",
          reasoning: "a tautology is not an insight",
          confidence: 0.7,
          demoteAfter: LATER_ISO,
        }),
      ),
    ).toBe("self_edge");
  });
});

describe("edge identity is enforced by the store across every tier", () => {
  it("should refuse a second edge for the same pair and relation", () => {
    const edge = inference();

    expect(
      kindOf(() =>
        graph.infer({
          sourceNode: edge.sourceNode,
          targetNode: edge.targetNode,
          relation: edge.relation,
          reasoning: "rediscovered on the next reflection pass",
          confidence: 0.9,
          demoteAfter: LATER_ISO,
        }),
      ),
    ).toBe("duplicate_edge");
  });

  it("should refuse to recreate an edge the Commander suppressed, and say so", () => {
    // THE reason `suppressed` is a tier rather than a delete. Reflection runs
    // again tomorrow and will reach the same conclusion; the store is what
    // stops it landing.
    const edge = inference();
    graph.suppress(edge);

    let thrown: unknown;
    try {
      graph.infer({
        sourceNode: edge.sourceNode,
        targetNode: edge.targetNode,
        relation: edge.relation,
        reasoning: "rediscovered on the next reflection pass",
        confidence: 0.9,
        demoteAfter: LATER_ISO,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GraphError);
    expect((thrown as GraphError).kind).toBe("duplicate_edge");
    expect((thrown as GraphError).message).toContain("suppressed");
  });

  it("should refuse an inference that duplicates an observation of the same relation", () => {
    // The species is a property of an edge, not part of its identity.
    const edge = observation();

    expect(
      kindOf(() =>
        graph.infer({
          sourceNode: edge.sourceNode,
          targetNode: edge.targetNode,
          relation: edge.relation,
          reasoning: "the same relation, reached a different way",
          confidence: 0.5,
          demoteAfter: LATER_ISO,
        }),
      ),
    ).toBe("duplicate_edge");
  });

  it("should allow a second relation between the same pair", () => {
    const edge = observation({ relation: "owns" });

    expect(() =>
      graph.infer({
        sourceNode: edge.sourceNode,
        targetNode: edge.targetNode,
        relation: "cares_about",
        reasoning: "a different predicate is a different edge",
        confidence: 0.5,
        demoteAfter: LATER_ISO,
      }),
    ).not.toThrow();
  });
});

describe("MemoryGraph.findEdge — the identity lookup that must span every tier", () => {
  it("should find a hot edge by its identity", () => {
    const edge = inference();

    expect(graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation)).toEqual(edge);
  });

  it("should find a cold edge exactly as readily as a hot one", () => {
    // If a cold edge cannot be found, "demote, never prune" has silently
    // become "prune, slowly, while claiming otherwise".
    const edge = inference();
    const cold = graph.demote(edge);

    expect(graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation)).toEqual(cold);
  });

  it("should find a suppressed edge, which is why suppression is a tier and not a delete", () => {
    const edge = inference();
    const suppressed = graph.suppress(edge);

    expect(graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation)).toEqual(suppressed);
  });

  it("should return null when nothing relates the pair that way", () => {
    const edge = inference();

    expect(graph.findEdge(edge.sourceNode, edge.targetNode, "detests")).toBeNull();
  });

  it("should never mention the partition key in the statement it uses", () => {
    // Stated against the SQL itself. A `tier` predicate here would be invisible
    // at every other layer: every query would still return the right rows, and
    // cold edges would simply stop being found.
    expect(EDGE_IDENTITY_SQL.toLowerCase()).not.toContain("tier =");
    expect(EDGE_IDENTITY_SQL.toLowerCase()).not.toContain("tier in");
  });

  it("should be answered by the tier-free identity index, not by a scan", () => {
    const plan = queryPlan(EDGE_IDENTITY_SQL, newMemoryNodeId(), newMemoryNodeId(), "owns");

    expect(plan).toContain("memory_edges_identity_idx");
    expect(plan).not.toContain("scan memory_edges");
  });
});

describe("MemoryGraph.edgesBetween", () => {
  it("should return every relation joining a pair, in either direction", () => {
    const { commander, goal, note } = trio();
    const owns = graph.observe({
      sourceNode: commander,
      targetNode: goal,
      relation: "owns",
      assertedBy: note,
    });
    const blocks = graph.infer({
      sourceNode: goal,
      targetNode: commander,
      relation: "occupies",
      reasoning: "it is the first thing he raises every morning",
      confidence: 0.6,
      demoteAfter: LATER_ISO,
    });

    expect(graph.edgesBetween(commander, goal).map((edge) => edge.id).sort()).toEqual(
      [owns.id, blocks.id].sort(),
    );
  });

  it("should include cold and suppressed edges, because this is an identity lookup", () => {
    const edge = inference();
    graph.suppress(edge);

    expect(graph.edgesBetween(edge.sourceNode, edge.targetNode).map((found) => found.tier)).toEqual(
      ["suppressed"],
    );
  });

  it("should return nothing for a pair with no edges", () => {
    const { commander, note } = trio();

    expect(graph.edgesBetween(commander, note)).toEqual([]);
  });
});

describe("MemoryGraph.getEdge", () => {
  it("should return an edge by id, narrowed to its species", () => {
    const edge = inference();
    const found = graph.getEdge(edge.id);

    expect(found?.kind).toBe("inferred");
    expect(found).toEqual(edge);
  });

  it("should return null for an id that names nothing", () => {
    expect(graph.getEdge(newMemoryEdgeId())).toBeNull();
  });

  it("should refuse to hand back a row whose species does not carry what its species means", () => {
    // Only reachable with the CHECKs switched off, which is the point: if a row
    // like this ever exists, the store refuses to describe it rather than
    // handing out an inference with no reasoning.
    const { commander, goal } = trio();
    const id = newMemoryEdgeId();
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(
      `INSERT INTO memory_edges
         (id, tier, kind, source_node, target_node, relation, weight, confidence,
          reasoning, asserted_by, last_touched_at, demote_after, created_at, updated_at)
       VALUES (?, 'cold', 'inferred', ?, ?, 'owns', 1.0, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(id, commander, goal, NOW_ISO, NOW_ISO, NOW_ISO);
    db.exec("PRAGMA ignore_check_constraints = OFF");

    expect(kindOf(() => graph.getEdge(id))).toBe("corrupt_row");
  });
});

describe("MemoryGraph.neighbourhood", () => {
  /** A -> B -> C, all hot, plus a cold D hanging off A. */
  function chain(): { a: string; b: string; c: string; d: string } {
    const a = graph.addNode({ kind: "person", label: "A" }).id;
    const b = graph.addNode({ kind: "goal", label: "B" }).id;
    const c = graph.addNode({ kind: "fact", label: "C" }).id;
    const d = graph.addNode({ kind: "fact", label: "D" }).id;
    const note = graph.addNode({ kind: "source", label: "a note" }).id;

    graph.observe({ sourceNode: a, targetNode: b, relation: "owns", assertedBy: note });
    graph.observe({ sourceNode: b, targetNode: c, relation: "needs", assertedBy: note });
    const stale = graph.infer({
      sourceNode: a,
      targetNode: d,
      relation: "once_mentioned",
      reasoning: "a single passing mention months ago",
      confidence: 0.1,
      demoteAfter: LATER_ISO,
    });
    graph.demote(stale);

    return { a, b, c, d };
  }

  it("should return the immediate neighbours by default", () => {
    const { a, b } = chain();
    const hood = graph.neighbourhood(a);

    expect(hood.origin.id).toBe(a);
    expect(hood.nodes.map((node) => node.id).sort()).toEqual([a, b].sort());
    expect(hood.edges).toHaveLength(1);
  });

  it("should reach further when asked, following edges in both directions", () => {
    const { a, b, c } = chain();
    const hood = graph.neighbourhood(a, { depth: 2 });

    expect(hood.nodes.map((node) => node.id).sort()).toEqual([a, b, c].sort());
    expect(hood.edges).toHaveLength(2);
  });

  it("should traverse the hot tier only, because a traversal is a SCAN", () => {
    const { a, d } = chain();

    expect(graph.neighbourhood(a).nodes.map((node) => node.id)).not.toContain(d);
  });

  it("should walk the colder partitions only when asked for them explicitly", () => {
    const { a, d } = chain();
    const hood = graph.neighbourhood(a, { tiers: ["hot", "cold"] });

    expect(hood.nodes.map((node) => node.id)).toContain(d);
  });

  it("should reach a node from its incoming edges too", () => {
    const { b, a, c } = chain();

    expect(graph.neighbourhood(b).nodes.map((node) => node.id).sort()).toEqual([a, b, c].sort());
  });

  it("should return the origin alone at depth zero", () => {
    const { a } = chain();
    const hood = graph.neighbourhood(a, { depth: 0 });

    expect(hood.nodes.map((node) => node.id)).toEqual([a]);
    expect(hood.edges).toEqual([]);
  });

  it("should stop at the edge limit rather than walking the whole graph", () => {
    const { a } = chain();

    expect(graph.neighbourhood(a, { depth: 3, limit: 1 }).edges).toHaveLength(1);
  });

  it("should refuse an origin that is not a node", () => {
    expect(kindOf(() => graph.neighbourhood(newMemoryNodeId()))).toBe("unknown_node");
  });

  it("should refuse a depth or limit that is not a sane integer", () => {
    const { a } = chain();

    expect(kindOf(() => graph.neighbourhood(a, { depth: -1 }))).toBe("bad_depth");
    expect(kindOf(() => graph.neighbourhood(a, { depth: 1.5 }))).toBe("bad_depth");
    expect(kindOf(() => graph.neighbourhood(a, { limit: 0 }))).toBe("bad_limit");
  });

  it("should refuse a tier outside the partition vocabulary", () => {
    const { a } = chain();

    expect(
      kindOf(() => graph.neighbourhood(a, { tiers: ["warm" as MemoryTier] })),
    ).toBeInstanceOf(Error);
  });

  it("should not visit an edge twice when both endpoints are in the frontier", () => {
    const { a } = chain();

    expect(graph.neighbourhood(a, { depth: 3 }).edges).toHaveLength(2);
  });
});

describe("MemoryGraph.demote — the move that clears the stamp", () => {
  it("should move a hot edge to cold and null its scheduled crossing", () => {
    // Not optional. `memory_edges_demote_idx` is PARTIAL on `demote_after IS
    // NOT NULL` and says nothing about tier, so an edge demoted with its stamp
    // intact stays in that index forever.
    const edge = inference();
    const cold = graph.demote(edge);

    expect(cold.tier).toBe("cold");
    expect(cold.demoteAfter).toBeNull();
    expect(
      db.prepare("SELECT demote_after FROM memory_edges WHERE id = ?").get(edge.id),
    ).toEqual({ demote_after: null });
  });

  it("should keep the row's identity and history intact", () => {
    const edge = inference();
    const cold = graph.demote(edge);

    expect(cold.id).toBe(edge.id);
    expect(cold.createdAt).toBe(edge.createdAt);
    expect(cold.weight).toBe(edge.weight);
    expect(cold.reasoning).toBe(edge.reasoning);
  });

  it("should demote an observation too, which has no stamp to clear", () => {
    const edge = observation();

    expect(graph.demote(edge).tier).toBe("cold");
  });

  it("should refuse to demote an edge that is not in the hot tier", () => {
    const edge = inference();
    const cold = graph.demote(edge);

    expect(kindOf(() => graph.demote(cold))).toBe("not_hot");
  });

  it("should refuse an edge that is no longer in the store", () => {
    const edge = observation();
    graph.retract(edge);

    expect(kindOf(() => graph.demote(edge))).toBe("not_hot");
  });
});

describe("MemoryGraph.suppress — the Commander said this is wrong", () => {
  it("should move an edge to the suppressed tier and clear its stamp", () => {
    const edge = inference();
    const suppressed = graph.suppress(edge);

    expect(suppressed.tier).toBe("suppressed");
    expect(suppressed.demoteAfter).toBeNull();
  });

  it("should suppress an edge that is already cold", () => {
    const edge = inference();
    const cold = graph.demote(edge);

    expect(graph.suppress(cold).tier).toBe("suppressed");
  });

  it("should leave the edge findable by identity, so reflection cannot recreate it", () => {
    const edge = inference();
    graph.suppress(edge);

    expect(graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation)?.tier).toBe(
      "suppressed",
    );
  });

  it("should refuse to suppress what is already suppressed", () => {
    const edge = inference();
    const suppressed = graph.suppress(edge);

    expect(kindOf(() => graph.suppress(suppressed))).toBe("already_suppressed");
  });
});

describe("MemoryGraph.promote — reactivation, and what it must never reach", () => {
  it("should promote a cold inference back to hot with a fresh crossing", () => {
    const edge = inference();
    const cold = graph.demote(edge);

    const hot = graph.promote(cold as InferredEdge, { demoteAfter: LATEST_ISO, weight: 0.6 });

    expect(hot.tier).toBe("hot");
    expect(hot.demoteAfter).toBe(LATEST_ISO);
    expect(hot.weight).toBe(0.6);
    expect(hot.id).toBe(edge.id);
    expect(hot.createdAt).toBe(edge.createdAt);
  });

  it("should promote a cold observation, which needs no crossing at all", () => {
    const edge = observation();
    const cold = graph.demote(edge);

    const hot = graph.promote(cold as ObservedEdge);

    expect(hot.tier).toBe("hot");
    expect(hot.demoteAfter).toBeNull();
  });

  it("should refuse to promote a suppressed edge, whatever its weight has done", () => {
    // The Commander's judgement is not something reactivation gets to
    // overrule. The statement itself only matches a cold row, so a suppressed
    // one is not merely refused — it is not addressed.
    const edge = inference();
    const suppressed = graph.suppress(edge);

    expect(
      kindOf(() => graph.promote(suppressed as InferredEdge, { demoteAfter: LATEST_ISO })),
    ).toBe("not_cold");
    expect(graph.getEdge(edge.id)?.tier).toBe("suppressed");
  });

  it("should refuse to promote an edge that is already hot", () => {
    const edge = inference();

    expect(kindOf(() => graph.promote(edge, { demoteAfter: LATEST_ISO }))).toBe("not_cold");
  });

  it("should refuse a crossing instant that is not an Instant", () => {
    const edge = inference();
    const cold = graph.demote(edge);

    expect(
      kindOf(() => graph.promote(cold as InferredEdge, { demoteAfter: "tomorrow" })),
    ).toBe("bad_instant");
  });

  it("should refuse a reactivation weight outside (0, 1]", () => {
    const edge = inference();
    const cold = graph.demote(edge);

    expect(
      kindOf(() => graph.promote(cold as InferredEdge, { demoteAfter: LATEST_ISO, weight: 0 })),
    ).toBe("bad_weight");
  });

  it("should move last_touched_at forward, because the weight was just set", () => {
    const edge = inference();
    const cold = graph.demote(edge);
    const later = new MemoryGraph({ db, clock: fixedClock(Date.parse(LATER_ISO)) });

    expect(
      later.promote(cold as InferredEdge, { demoteAfter: LATEST_ISO }).lastTouchedAt,
    ).toBe(LATER_ISO);
  });
});

describe("MemoryGraph.unsuppress", () => {
  it("should return a suppressed edge to the cold tier, never straight to hot", () => {
    // Undoing the Commander's rejection does not re-assert relevance. The edge
    // becomes addressable by reactivation again; reactivation decides.
    const edge = inference();
    const suppressed = graph.suppress(edge);

    const cold = graph.unsuppress(suppressed);

    expect(cold.tier).toBe("cold");
    expect(cold.demoteAfter).toBeNull();
  });

  it("should refuse an edge that is not suppressed", () => {
    const edge = inference();

    expect(kindOf(() => graph.unsuppress(edge))).toBe("not_suppressed");
  });

  it("should keep the edge's id and reasoning through the round trip", () => {
    const edge = inference();
    const cold = graph.unsuppress(graph.suppress(edge));

    expect(cold.id).toBe(edge.id);
    expect((cold as InferredEdge).reasoning).toBe(edge.reasoning);
  });
});

describe("MemoryGraph.retract — the only delete, and it reaches one species", () => {
  it("should retract an observation, because a source can be wrong", () => {
    const edge = observation();

    graph.retract(edge);

    expect(graph.getEdge(edge.id)).toBeNull();
  });

  it("should refuse to retract an observation that is already gone", () => {
    const edge = observation();
    graph.retract(edge);

    expect(kindOf(() => graph.retract(edge))).toBe("no_such_observation");
  });

  it("should not touch an inferred row even when the type system is subverted", () => {
    // `retract` takes an ObservedEdge VALUE, so `graph.retract(inferredEdge)`
    // does not compile — that is the real guarantee. The cast below is what a
    // future `as any` would do, and the statement's own `kind = 'observed'`
    // predicate means it still cannot reach the row: the BEFORE DELETE trigger
    // is a backstop that never has to fire.
    const edge = inference();

    expect(kindOf(() => graph.retract(edge as unknown as ObservedEdge))).toBe(
      "no_such_observation",
    );
    expect(graph.getEdge(edge.id)).not.toBeNull();
  });

  it("should leave the demotion path as the only way an inference ever leaves the scan", () => {
    const edge = inference();

    expect(graph.demote(edge).tier).toBe("cold");
    expect(graph.getEdge(edge.id)).not.toBeNull();
  });
});

describe("MemoryGraph.demoteDueEdges — the nightly sweep, pinned", () => {
  it("should move every edge past its crossing instant, and only those", () => {
    const due = inference({ relation: "cares_about" });
    const notDue = graph.infer({
      sourceNode: due.targetNode,
      targetNode: due.sourceNode,
      relation: "occupies",
      reasoning: "still fresh",
      confidence: 0.9,
      demoteAfter: LATEST_ISO,
    });

    expect(graph.demoteDueEdges(LATER_ISO)).toBe(1);
    expect(graph.getEdge(due.id)?.tier).toBe("cold");
    expect(graph.getEdge(notDue.id)?.tier).toBe("hot");
  });

  it("should clear the stamp of everything it moves", () => {
    const edge = inference();
    graph.demoteDueEdges(LATER_ISO);

    expect(graph.getEdge(edge.id)?.demoteAfter).toBeNull();
  });

  it("should move nothing when nothing has crossed", () => {
    inference();

    expect(graph.demoteDueEdges(NOW_ISO)).toBe(0);
  });

  it("should refuse an instant it cannot parse", () => {
    expect(kindOf(() => graph.demoteDueEdges("2026-08-09"))).toBe("bad_instant");
  });

  it("should always clear the stamp in the statement itself", () => {
    // Pinned as text, because an UPDATE that moves the tier and leaves the
    // stamp behind is invisible until the demotion index has grown to hold the
    // whole history of the graph.
    expect(DEMOTE_SWEEP_SQL.toLowerCase()).toContain("demote_after = null");
    expect(DEMOTE_SWEEP_SQL.toLowerCase()).toContain("tier = 'cold'");
  });

  it("should be a range scan over the partial demotion index, never a table scan", () => {
    const plan = queryPlan(
      "SELECT id FROM memory_edges WHERE tier = 'hot' AND demote_after IS NOT NULL AND demote_after <= ?",
      LATER_ISO,
    );

    expect(plan).toContain("memory_edges_demote_idx");
    expect(plan).not.toContain("scan memory_edges");
  });
});

describe("the two species stay apart at the type level", () => {
  it("should narrow an edge read back from the store to exactly one species", () => {
    const inferred: MemoryEdge = inference();
    const observed: MemoryEdge = observation({ relation: "owns" });

    // The compiler is the assertion here: `reasoning` is a `string` on one
    // branch and `null` on the other, and `assertedBy` is the mirror image.
    if (inferred.kind !== "inferred") throw new Error("expected an inference");
    if (observed.kind !== "observed") throw new Error("expected an observation");

    expect(inferred.reasoning.length).toBeGreaterThan(0);
    expect(observed.assertedBy.startsWith("syl:memory_node:")).toBe(true);
  });
});
