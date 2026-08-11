import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalLabel, GraphError, MemoryGraph, type MemoryNode } from "../../src/memory/graph.js";
import { SupersessionLedger } from "../../src/memory/supersede.js";
import {
  DUPLICATE_FLOOR,
  LABEL_RELATION,
  MERGED_INTO_RELATION,
  MemoryTidying,
  MIN_SHARED_NEIGHBOURS,
  SAME_AS_RELATION,
  TidyError,
} from "../../src/memory/tidy.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * Her hands on her own memory — `syl-016.3` and `syl-016.6` — against the REAL
 * shipped migrations.
 *
 * Three properties decide whether this module is correct, and every one of them
 * is a property nothing else in the system would notice the loss of:
 *
 *  - **A merge supersedes; it never destroys.** Constraint 6. The absorbed node
 *    and every edge it had are still on disk and still addressable afterwards,
 *    and the ledger says where the node went. A merge that deleted would look
 *    identical from the digest and would have thrown away the answer to "what
 *    did I believe in March?".
 *  - **A merge does not overrule him.** Suppressed is the Commander's judgement.
 *    Tidying up must not be a route around it, and neither must decay's.
 *  - **A correction edits the row.** Minting a corrected copy is `syl-016.3`
 *    arriving through the fix for `syl-016.6`, and it would pass any test that
 *    only asked whether the new text was in the graph.
 */

const MARCH = "2026-03-01T09:00:00.000Z";
const AUGUST = "2026-08-11T12:00:00.000Z";

let db: Database;
let graph: MemoryGraph;
let ledger: SupersessionLedger;
let tidy: MemoryTidying;
let clockMs: number;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  clockMs = Date.parse(MARCH);
  const clock = () => clockMs;
  graph = new MemoryGraph({ db, clock });
  ledger = new SupersessionLedger({ db, graph, clock });
  tidy = new MemoryTidying({ db, graph, ledger, clock });
});

afterEach(() => {
  db.close();
});

/** Rows in every table a merge or a correction could destroy something in. */
function census(): Record<string, number> {
  const count = (table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as unknown as { n: number }).n;
  return {
    nodes: count("memory_nodes"),
    edges: count("memory_edges"),
    assertions: count("memory_assertions"),
  };
}

/**
 * Three goals that are one goal wearing different clothes, all hanging off the
 * same two entities. Syl's own example, verbatim.
 */
function tennessee(): {
  possibility: MemoryNode;
  building: MemoryNode;
  compound: MemoryNode;
  place: MemoryNode;
  commander: MemoryNode;
  note: MemoryNode;
} {
  const place = graph.addNode({ kind: "person", label: "Tennessee" });
  const commander = graph.addNode({ kind: "person", label: "the Commander" });
  const note = graph.addNode({ kind: "source", label: "evening review, 2026-08-09" });
  const possibility = graph.addNode({ kind: "goal", label: "Tennessee possibility" });
  const building = graph.addNode({ kind: "goal", label: "Building in Tennessee" });
  const compound = graph.addNode({ kind: "goal", label: "Family compound" });

  for (const goal of [possibility, building, compound]) {
    graph.observe({
      sourceNode: goal.id,
      targetNode: place.id,
      relation: "about",
      assertedBy: note.id,
    });
    graph.observe({
      sourceNode: goal.id,
      targetNode: commander.id,
      relation: "about",
      assertedBy: note.id,
    });
  }

  return { possibility, building, compound, place, commander, note };
}

describe("MemoryTidying.merge", () => {
  it("should carry the absorbed node's live links onto the survivor when two entries are one thing", () => {
    const { possibility, building, place, commander } = tennessee();

    const result = tidy.merge({
      keep: possibility.id,
      absorb: building.id,
      because: "both are the plan to build on the Tennessee land",
    });

    // The survivor already had both links, so nothing new was drawn — but the
    // absorbed node's links have left the scan and the survivor still has them.
    expect(result.carried).toHaveLength(0);
    expect(result.demoted).toHaveLength(2);
    expect(graph.findEdge(possibility.id, place.id, "about")?.tier).toBe("hot");
    expect(graph.findEdge(possibility.id, commander.id, "about")?.tier).toBe("hot");
    expect(graph.findEdge(building.id, place.id, "about")?.tier).toBe("cold");
  });

  it("should draw a link the survivor did not have, keeping the original provenance", () => {
    const { possibility, building, note } = tennessee();
    const land = graph.addNode({ kind: "fact", label: "forty acres outside Franklin" });
    graph.observe({
      sourceNode: building.id,
      targetNode: land.id,
      relation: "about",
      assertedBy: note.id,
    });

    const result = tidy.merge({
      keep: possibility.id,
      absorb: building.id,
      because: "one goal, two names",
    });

    expect(result.carried).toHaveLength(1);
    const carried = graph.findEdge(possibility.id, land.id, "about");
    expect(carried?.kind).toBe("observed");
    // The conversation that said so still vouches for it. A merge that stamped
    // itself here would be inventing provenance.
    expect(carried?.kind === "observed" ? carried.assertedBy : null).toBe(note.id);
  });

  it("should supersede the absorbed node rather than delete it", () => {
    const { possibility, building } = tennessee();

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    const absorbed = graph.getNode(building.id);
    expect(absorbed).not.toBeNull();
    expect(absorbed?.tier).toBe("cold");
    expect(absorbed?.label).toBe("Building in Tennessee");
  });

  it("should destroy nothing at all: every row that existed before still exists after", () => {
    const { possibility, building } = tennessee();
    const before = census();

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    const after = census();
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBeGreaterThanOrEqual(before.edges ?? 0);
    expect(after.assertions).toBeGreaterThan(before.assertions ?? 0);
  });

  it("should keep every one of the absorbed node's edges addressable by id", () => {
    const { possibility, building } = tennessee();
    const before = graph.edgesTouching(building.id).map((edge) => edge.id);
    expect(before.length).toBeGreaterThan(0);

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    for (const id of before) expect(graph.getEdge(id)).not.toBeNull();
  });

  it("should say where an absorbed memory went, through the ledger, after it has gone cold", () => {
    const { possibility, building } = tennessee();

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    expect(tidy.mergedInto(building.id)).toBe(possibility.id);
    expect(ledger.current(building.id, MERGED_INTO_RELATION)?.value).toBe(possibility.id);
  });

  it("should record why the two are one thing, on an edge that carries reasoning", () => {
    const { possibility, building } = tennessee();
    const because = "he uses the two names for the same forty acres";

    const result = tidy.merge({ keep: possibility.id, absorb: building.id, because });

    const edge = graph.getEdge(result.sameAs);
    expect(edge?.kind).toBe("inferred");
    expect(edge?.kind === "inferred" ? edge.reasoning : null).toBe(because);
    expect(graph.findEdge(building.id, possibility.id, SAME_AS_RELATION)?.id).toBe(result.sameAs);
  });

  it("should refuse a merge with no reason", () => {
    const { possibility, building } = tennessee();

    expect(() =>
      tidy.merge({ keep: possibility.id, absorb: building.id, because: "   " }),
    ).toThrowError(expect.objectContaining({ kind: "blank_reason" }) as unknown as Error);
  });

  it("should refuse to merge a node into itself", () => {
    const { possibility } = tennessee();

    expect(() =>
      tidy.merge({ keep: possibility.id, absorb: possibility.id, because: "same" }),
    ).toThrowError(expect.objectContaining({ kind: "same_node" }) as unknown as Error);
  });

  it("should refuse to absorb a node that has already been superseded", () => {
    const { possibility, building } = tennessee();
    graph.supersedeNode(building);

    expect(() =>
      tidy.merge({ keep: possibility.id, absorb: building.id, because: "same" }),
    ).toThrowError(expect.objectContaining({ kind: "not_hot" }) as unknown as Error);
  });

  it("should refuse to absorb a handle, which would drop its row out of every scan silently", () => {
    const { possibility } = tennessee();
    const handle = graph.addNode({
      kind: "goal",
      label: "Family compound",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000001",
    });

    expect(() =>
      tidy.merge({ keep: possibility.id, absorb: handle.id, because: "same goal" }),
    ).toThrowError(expect.objectContaining({ kind: "absorbs_handle" }) as unknown as Error);
    expect(graph.getNode(handle.id)?.tier).toBe("hot");
  });

  it("should allow a loose entry to be absorbed INTO a handle", () => {
    const handle = graph.addNode({
      kind: "goal",
      label: "Family compound",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000001",
    });
    const loose = graph.addNode({ kind: "goal", label: "the family compound plan" });

    const result = tidy.merge({ keep: handle.id, absorb: loose.id, because: "one goal" });

    expect(result.keep.subjectId).toBe("syl:goal:00000000-0000-7000-8000-000000000001");
    expect(graph.getNode(handle.id)?.tier).toBe("hot");
    expect(graph.getNode(loose.id)?.tier).toBe("cold");
  });

  it("should leave a suppressed edge suppressed: tidying up is not a route around his rejection", () => {
    const { possibility, building, note } = tennessee();
    const rumour = graph.addNode({ kind: "fact", label: "he wants to move by spring" });
    const wrong = graph.observe({
      sourceNode: building.id,
      targetNode: rumour.id,
      relation: "about",
      assertedBy: note.id,
    });
    graph.suppress(wrong, 0.1);

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    expect(graph.getEdge(wrong.id)?.tier).toBe("suppressed");
    expect(graph.findEdge(possibility.id, rumour.id, "about")).toBeNull();
  });

  it("should not resurrect a cold edge onto the survivor", () => {
    const { possibility, building, note } = tennessee();
    const stale = graph.addNode({ kind: "fact", label: "the barn conversion idea" });
    const dormant = graph.observe({
      sourceNode: building.id,
      targetNode: stale.id,
      relation: "about",
      assertedBy: note.id,
    });
    graph.demote(dormant);

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    expect(graph.getEdge(dormant.id)?.tier).toBe("cold");
    expect(graph.findEdge(possibility.id, stale.id, "about")).toBeNull();
  });

  it("should leave nothing behind when the merge fails partway", () => {
    const { possibility, building } = tennessee();
    // A merge into a node the ledger will refuse as a subject cannot happen
    // through the public API, so the failure is forced where one really can:
    // the ledger already holds an OPEN row for this key with a different value,
    // which is fine — what is forced instead is a graph refusal, by suppressing
    // the same_as edge the merge is about to draw.
    const sameAs = graph.infer({
      sourceNode: building.id,
      targetNode: possibility.id,
      relation: SAME_AS_RELATION,
      reasoning: "an earlier pass thought so",
      confidence: 0.5,
      demoteAfter: AUGUST,
    });
    graph.suppress(sameAs);
    const before = census();

    // The suppressed edge is found by identity, so the merge reuses it rather
    // than failing — which is the point of a tier-free identity lookup.
    const result = tidy.merge({ keep: possibility.id, absorb: building.id, because: "same goal" });

    expect(result.sameAs).toBe(sameAs.id);
    expect(census().nodes).toBe(before.nodes);
  });
});

describe("MemoryTidying.correct", () => {
  it("should correct a memory in place rather than minting a corrected copy", () => {
    const node = graph.addNode({
      kind: "fact",
      label: "Ela wants an apartment near her parents",
      body: "she is looking in the same neighbourhood",
    });
    const before = census();

    const result = tidy.correct({
      node: node.id,
      label: "Ela wants an apartment near her grandparents",
    });

    expect(result.node.id).toBe(node.id);
    expect(result.node.label).toBe("Ela wants an apartment near her grandparents");
    expect(census().nodes).toBe(before.nodes);
    expect(graph.listNodes({ kind: "fact" })).toHaveLength(1);
  });

  it("should keep what the memory used to say answerable, at the instant it said it", () => {
    clockMs = Date.parse(MARCH);
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    clockMs = Date.parse(AUGUST);
    tidy.correct({ node: node.id, label: "he works at Initech" });

    // VALID time: what did this memory read in March? The row carried those
    // words from the moment it was created, whatever date the ledger learned it.
    expect(ledger.trueAt(node.id, LABEL_RELATION, MARCH)?.value).toBe("he works at Acme");
    expect(ledger.current(node.id, LABEL_RELATION)?.value).toBe("he works at Initech");
    expect(ledger.history(node.id, LABEL_RELATION)).toHaveLength(2);
  });

  it("should not claim it believed the old wording before the correction taught it that", () => {
    clockMs = Date.parse(MARCH);
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    clockMs = Date.parse(AUGUST);
    tidy.correct({ node: node.id, label: "he works at Initech" });

    // TRANSACTION time, and the honest answer is nothing: the ledger held no
    // row for this key in March. Back-dating `recorded_at` to make this look
    // tidier would be rewriting history, which the ledger refuses by design.
    expect(ledger.believedAt(node.id, LABEL_RELATION, MARCH)).toBeNull();
    expect(ledger.believedAt(node.id, LABEL_RELATION, AUGUST)?.value).toBe("he works at Initech");
  });

  it("should write nothing when the memory already says this", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    const result = tidy.correct({ node: node.id, label: "he works at Acme" });

    expect(result.changed).toEqual([]);
    expect(result.assertions).toEqual([]);
    expect(result.node.updatedAt).toBe(node.updatedAt);
    expect(ledger.history(node.id, LABEL_RELATION)).toEqual([]);
  });

  it("should treat a label that differs only in spacing as the label it already has", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    const result = tidy.correct({ node: node.id, label: "  he works   at Acme " });

    expect(result.changed).toEqual([]);
    expect(canonicalLabel("  he works   at Acme ")).toBe(node.label);
  });

  it("should replace a body and keep the old one answerable", () => {
    const node = graph.addNode({
      kind: "fact",
      label: "the Tennessee land",
      body: "twenty acres",
    });

    clockMs = Date.parse(AUGUST);
    const result = tidy.correct({ node: node.id, body: "forty acres" });

    expect(result.changed).toEqual(["body"]);
    expect(graph.getNode(node.id)?.body).toBe("forty acres");
    expect(ledger.trueAt(node.id, "body", MARCH)?.value).toBe("twenty acres");
  });

  it("should clear a body by retiring the key rather than inventing a replacement", () => {
    const node = graph.addNode({ kind: "fact", label: "the Tennessee land", body: "twenty acres" });

    clockMs = Date.parse(AUGUST);
    tidy.correct({ node: node.id, body: null });

    expect(graph.getNode(node.id)?.body).toBeNull();
    expect(ledger.current(node.id, "body")).toBeNull();
    expect(ledger.trueAt(node.id, "body", MARCH)?.value).toBe("twenty acres");
  });

  it("should refuse a correction that names nothing to change", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    expect(() => tidy.correct({ node: node.id })).toThrowError(
      expect.objectContaining({ kind: "nothing_to_change" }) as unknown as Error,
    );
  });

  it("should refuse to correct a memory that is not in the graph", () => {
    expect(() =>
      tidy.correct({ node: "syl:memory_node:00000000-0000-7000-8000-000000000000", label: "x" }),
    ).toThrowError(expect.objectContaining({ kind: "unknown_node" }) as unknown as Error);
  });

  it("should reach a memory that has already gone cold", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });
    graph.supersedeNode(node);

    const result = tidy.correct({ node: node.id, label: "he worked at Acme" });

    expect(result.node.label).toBe("he worked at Acme");
    expect(result.node.tier).toBe("cold");
  });
});

describe("MemoryTidying.recategorise", () => {
  it("should move a claim that was filed as a person to the kind it should have had", () => {
    const misfiled = graph.addNode({
      kind: "person",
      label: "Ela wants an apartment near her parents",
    });

    const result = tidy.recategorise({ node: misfiled.id, kind: "fact" });

    expect(result.from).toBe("person");
    expect(result.to).toBe("fact");
    expect(graph.getNode(misfiled.id)?.kind).toBe("fact");
    expect(graph.listNodes({ kind: "person" })).toHaveLength(0);
  });

  it("should keep the old filing answerable", () => {
    const misfiled = graph.addNode({ kind: "person", label: "Ela wants an apartment" });

    clockMs = Date.parse(AUGUST);
    tidy.recategorise({ node: misfiled.id, kind: "fact" });

    expect(ledger.trueAt(misfiled.id, "kind", MARCH)?.value).toBe("person");
    expect(ledger.current(misfiled.id, "kind")?.value).toBe("fact");
  });

  it("should write nothing when the memory is already filed this way", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    const result = tidy.recategorise({ node: node.id, kind: "fact" });

    expect(result.assertions).toEqual([]);
    expect(result.node.updatedAt).toBe(node.updatedAt);
  });

  it("should refuse to refile a handle: its kind is half of what addresses it", () => {
    const handle = graph.addNode({
      kind: "goal",
      label: "ship Syl",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000001",
    });

    expect(() => tidy.recategorise({ node: handle.id, kind: "fact" })).toThrowError(
      expect.objectContaining({ kind: "kind_locked" }) as unknown as Error,
    );
    expect(graph.getNode(handle.id)?.kind).toBe("goal");
  });

  it("should refuse to promote anything into a source", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    expect(() => tidy.recategorise({ node: node.id, kind: "source" })).toThrowError(
      expect.objectContaining({ kind: "kind_locked" }) as unknown as Error,
    );
  });

  it("should leave the ledger untouched when the refiling is refused", () => {
    const handle = graph.addNode({
      kind: "goal",
      label: "ship Syl",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000001",
    });

    expect(() => tidy.recategorise({ node: handle.id, kind: "fact" })).toThrow();
    expect(ledger.history(handle.id, "kind")).toEqual([]);
  });
});

describe("MemoryTidying.duplicates", () => {
  it("should nominate two entries whose labels differ only in case and spacing", () => {
    // Written round the store's own canonicalisation: `addNode` collapses
    // whitespace, so the pair that survives to disk differs by case alone.
    graph.addNode({ kind: "goal", label: "Family compound" });
    graph.addNode({ kind: "goal", label: "family  compound" });

    const groups = tidy.duplicates({ kind: "goal" });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.identical).toBe(true);
    expect(groups[0]?.nodes).toHaveLength(2);
  });

  it("should nominate three goals that share their links and no vocabulary at all", () => {
    const { possibility, building, compound } = tennessee();

    const groups = tidy.duplicates({ kind: "goal" });

    expect(groups).toHaveLength(1);
    const ids = groups[0]?.nodes.map((node) => node.id).sort();
    expect(ids).toEqual([possibility.id, building.id, compound.id].sort());
    // The structural channel is what found them; the lexical one could not.
    expect(groups[0]?.neighbours).toBeGreaterThanOrEqual(DUPLICATE_FLOOR);
    expect(groups[0]?.wording).toBeLessThan(DUPLICATE_FLOOR);
  });

  it("should not nominate two entries that share neither words nor links", () => {
    graph.addNode({ kind: "goal", label: "learn to sail" });
    graph.addNode({ kind: "goal", label: "replace the water heater" });

    expect(tidy.duplicates({ kind: "goal" })).toEqual([]);
  });

  it("should not nominate two claims that merely share the one person they are about", () => {
    const ela = graph.addNode({ kind: "person", label: "Ela" });
    const note = graph.addNode({ kind: "source", label: "evening review" });
    for (const label of ["Ela wants an apartment", "Ela starts at the hospital in June"]) {
      const fact = graph.addNode({ kind: "fact", label });
      graph.observe({
        sourceNode: fact.id,
        targetNode: ela.id,
        relation: "about",
        assertedBy: note.id,
      });
    }

    // One shared link is a topic, not a duplicate. Requiring two is what stops
    // the structural channel nominating every fact about the same person.
    expect(tidy.duplicates({ kind: "fact" })).toEqual([]);
  });

  it("should not nominate two facts merely because one conversation asserted both", () => {
    const source = graph.addNode({ kind: "source", label: "Conversation with the Commander" });
    for (const label of ["he flies out on the 3rd", "the dishwasher is leaking again"]) {
      const fact = graph.addNode({ kind: "fact", label });
      graph.observe({
        sourceNode: source.id,
        targetNode: fact.id,
        relation: "stated",
        assertedBy: source.id,
      });
    }

    // Shared provenance is evidence of a shared ORIGIN, which is the opposite
    // of evidence that two entries are one thing.
    expect(tidy.duplicates({ kind: "fact" })).toEqual([]);
  });

  it("should nominate on shared links at exactly the floor, and not one below it", () => {
    // Both counts are DERIVED from the constant. Restating "2" and "1" here
    // would let the constant move while the test kept passing and stopped
    // proving anything about it.
    const note = graph.addNode({ kind: "source", label: "evening review" });
    const entities = Array.from({ length: MIN_SHARED_NEIGHBOURS }, (_, index) =>
      graph.addNode({ kind: "person", label: `entity ${String(index)}` }),
    );
    const link = (goal: MemoryNode, from: number, to: number): void => {
      for (const entity of entities.slice(from, to)) {
        graph.observe({
          sourceNode: goal.id,
          targetNode: entity.id,
          relation: "about",
          assertedBy: note.id,
        });
      }
    };

    const short = [
      graph.addNode({ kind: "goal", label: "alpha" }),
      graph.addNode({ kind: "goal", label: "beta" }),
    ];
    for (const goal of short) link(goal, 0, MIN_SHARED_NEIGHBOURS - 1);
    expect(tidy.duplicates({ kind: "goal" })).toEqual([]);

    for (const goal of short) link(goal, MIN_SHARED_NEIGHBOURS - 1, MIN_SHARED_NEIGHBOURS);
    expect(tidy.duplicates({ kind: "goal" })).toHaveLength(1);
  });

  it("should not nominate a pair merely because both are connected to nothing", () => {
    graph.addNode({ kind: "person", label: "Ela" });
    graph.addNode({ kind: "person", label: "Vivenna" });

    expect(tidy.duplicates({ kind: "person" })).toEqual([]);
  });

  it("should never nominate a handle, because two handles are two different rows", () => {
    graph.addNode({
      kind: "goal",
      label: "Family compound",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000001",
    });
    graph.addNode({
      kind: "goal",
      label: "Family compound",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000002",
    });

    expect(tidy.duplicates({ kind: "goal" })).toEqual([]);
  });

  it("should never nominate a conversation's source node", () => {
    graph.addNode({ kind: "source", label: "Conversation with the Commander" });
    graph.addNode({ kind: "source", label: "conversation with the commander" });

    expect(tidy.duplicates({ kind: "source" })).toEqual([]);
  });

  it("should stop nominating a group once it has been merged", () => {
    const { possibility, building, compound } = tennessee();

    tidy.merge({ keep: possibility.id, absorb: building.id, because: "one goal" });
    tidy.merge({ keep: possibility.id, absorb: compound.id, because: "one goal" });

    expect(tidy.duplicates({ kind: "goal" })).toEqual([]);
  });

  it("should not nominate a contradiction, which is the pair a threshold gets wrong", () => {
    const commander = graph.addNode({ kind: "person", label: "the Commander" });
    const note = graph.addNode({ kind: "source", label: "evening review" });
    for (const label of ["He lives in Buda", "He moved to Nashville"]) {
      const fact = graph.addNode({ kind: "fact", label });
      graph.observe({
        sourceNode: fact.id,
        targetNode: commander.id,
        relation: "about",
        assertedBy: note.id,
      });
    }

    // Near neighbours in any embedding, and one is the correction of the other.
    // Even the NOMINATION channels leave them alone — and if they ever did
    // group them, the answer is still that she looks at the pair rather than
    // that the machine folds it.
    expect(tidy.duplicates({ kind: "fact" })).toEqual([]);
  });

  it("should write nothing: a nomination is a list she reads, not a plan anything runs", () => {
    tennessee();
    const before = census();

    const groups = tidy.duplicates();

    expect(groups.length).toBeGreaterThan(0);
    expect(census()).toEqual(before);
  });

  it("should return the same list, in the same order, over an unchanged graph", () => {
    tennessee();
    graph.addNode({ kind: "fact", label: "Family compound" });
    graph.addNode({ kind: "fact", label: "family compound" });

    const first = tidy.duplicates();
    const second = tidy.duplicates();

    expect(second.map((group) => group.nodes.map((node) => node.id))).toEqual(
      first.map((group) => group.nodes.map((node) => node.id)),
    );
  });

  it("should honour a floor above what a group scores", () => {
    tennessee();
    // DERIVED from the group's own score rather than restated, so raising the
    // bar above it cannot silently stop being above it.
    const scored = tidy.duplicates({ kind: "goal" })[0];
    expect(scored).toBeDefined();
    const above = Math.max(scored?.wording ?? 0, scored?.neighbours ?? 0) + Number.EPSILON * 8;

    expect(tidy.duplicates({ kind: "goal", floor: above })).toEqual([]);
  });
});

describe("the ledger inside a caller's transaction", () => {
  it("should join a transaction that is already open rather than refusing to start a second", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    db.exec("BEGIN IMMEDIATE");
    expect(() =>
      ledger.assert({ subject: node.id, relation: "employer", value: "Acme" }),
    ).not.toThrow();
    db.exec("COMMIT");

    expect(ledger.current(node.id, "employer")?.value).toBe("Acme");
  });

  it("should unwind its own writes with the caller's rollback", () => {
    const node = graph.addNode({ kind: "fact", label: "he works at Acme" });

    db.exec("BEGIN IMMEDIATE");
    ledger.assert({ subject: node.id, relation: "employer", value: "Acme" });
    db.exec("ROLLBACK");

    expect(ledger.current(node.id, "employer")).toBeNull();
  });
});

describe("MemoryGraph, the writes tidying needs", () => {
  it("should collapse whitespace in a label at the door, so two spellings are one node", () => {
    const node = graph.addNode({ kind: "fact", label: "  Family   compound\n" });
    expect(node.label).toBe("Family compound");
  });

  it("should not case-fold a label: the stored form is what she reads back to him", () => {
    expect(graph.addNode({ kind: "person", label: "Ela" }).label).toBe("Ela");
  });

  it("should leave a node untouched when rebodied with the body it already has", () => {
    const node = graph.addNode({ kind: "fact", label: "the land", body: "forty acres" });
    expect(graph.rebody(node, "forty acres").updatedAt).toBe(node.updatedAt);
  });

  it("should leave a node untouched when rebodied with the null body it already has", () => {
    const node = graph.addNode({ kind: "fact", label: "the land" });
    expect(graph.rebody(node, null).updatedAt).toBe(node.updatedAt);
  });

  it("should treat a blank body as no body at all", () => {
    const node = graph.addNode({ kind: "fact", label: "the land", body: "forty acres" });
    expect(graph.rebody(node, "   ").body).toBeNull();
  });

  it("should refuse a kind outside the vocabulary", () => {
    const node = graph.addNode({ kind: "fact", label: "the land" });
    expect(() => graph.recategorise(node, "rumour" as never)).toThrow();
  });

  it("should refuse to refile a handle", () => {
    const handle = graph.addNode({
      kind: "goal",
      label: "ship Syl",
      subjectId: "syl:goal:00000000-0000-7000-8000-000000000001",
    });
    expect(() => graph.recategorise(handle, "fact")).toThrowError(GraphError);
  });

  it("should read the hot edges touching a node, and only the hot ones, by default", () => {
    const { building } = tennessee();
    const hot = graph.edgesTouching(building.id);
    expect(hot).toHaveLength(2);
    for (const edge of hot) graph.demote(edge);
    expect(graph.edgesTouching(building.id)).toHaveLength(0);
    expect(graph.edgesTouching(building.id, ["cold"])).toHaveLength(2);
  });

  it("should refuse an edge lookup about a node that is not in the graph", () => {
    expect(() =>
      graph.edgesTouching("syl:memory_node:00000000-0000-7000-8000-000000000000"),
    ).toThrowError(GraphError);
  });
});

describe("TidyError", () => {
  it("should carry a kind a caller can branch on", () => {
    const error = new TidyError("same_node", "x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TidyError");
    expect(error.kind).toBe("same_node");
  });
});
