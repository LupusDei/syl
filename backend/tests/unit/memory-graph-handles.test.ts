import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphError, MemoryGraph, SALIENCE_SQL } from "../../src/memory/graph.js";
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
 * The three reads and writes the projection layer needed from the graph,
 * exercised against the REAL shipped migrations — `0012_memory_core.sql` for
 * the tables and `0015_working_memory.sql` for the handle uniqueness.
 *
 * A hand-built schema would test a copy of the design rather than the design.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const NOW_ISO = "2026-08-09T12:00:00.000Z";
const LATER = Date.parse("2026-08-09T18:00:00.000Z");
const LATER_ISO = "2026-08-09T18:00:00.000Z";
const DEMOTE_AT = "2026-08-10T00:00:00.000Z";

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

function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof GraphError ? error.kind : `not a GraphError: ${String(error)}`;
  }
  return "did not throw";
}

describe("MemoryGraph.relabel", () => {
  it("should rename a node and stamp it", () => {
    const node = graph.addNode({ kind: "goal", label: "ship Syl" });
    const later = new MemoryGraph({ db, clock: fixedClock(LATER) });

    const renamed = later.relabel(node, "ship Syl 1.0");

    expect(renamed.label).toBe("ship Syl 1.0");
    expect(renamed.updatedAt).toBe(LATER_ISO);
    expect(renamed.id).toBe(node.id);
  });

  it("should refuse a blank label — whitespace of any kind included", () => {
    const node = graph.addNode({ kind: "goal", label: "ship Syl" });

    expect(kindOf(() => graph.relabel(node, "\n\t "))).toBe("blank_label");
    expect(graph.getNode(node.id)?.label).toBe("ship Syl");
  });

  it("should touch NOTHING when the label is already what was asked for", () => {
    // The idempotence of the whole projection layer rests on this: a
    // regeneration over an unchanged life model must not bump `updated_at`,
    // or "nothing changed" becomes indistinguishable from "everything was
    // rewritten with the same values".
    const node = graph.addNode({ kind: "goal", label: "ship Syl" });
    const later = new MemoryGraph({ db, clock: fixedClock(LATER) });

    const same = later.relabel(node, "ship Syl");

    expect(same.updatedAt).toBe(NOW_ISO);
    expect(same).toEqual(node);
  });

  it("should refuse a node that is no longer in the store", () => {
    const node = graph.addNode({ kind: "fact", label: "gone" });
    db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(node.id);

    expect(kindOf(() => graph.relabel(node, "still here?"))).toBe("unknown_node");
  });
});

describe("MemoryGraph.listSalientNodes", () => {
  it("should rank hot nodes by the weight of the hot edges touching them", () => {
    const hub = graph.addNode({ kind: "person", label: "the Commander" });
    const near = graph.addNode({ kind: "goal", label: "ship Syl" });
    const far = graph.addNode({ kind: "fact", label: "a loose fact" });
    graph.observe({
      sourceNode: hub.id,
      targetNode: near.id,
      relation: "owns",
      assertedBy: hub.id,
      weight: 1,
    });

    expect(graph.listSalientNodes().map((node) => node.id)).toEqual([hub.id, near.id, far.id]);
  });

  it("should rank an unconnected hot node rather than dropping it", () => {
    const lonely = graph.addNode({ kind: "fact", label: "nothing points at this" });

    // The claim is that a node nothing points at is still RETURNED — it was
    // never "salience is literally zero". Since `syl-zdf.6` salience is edge
    // weight plus a floor set by kind, so an isolated node scores its floor
    // rather than nothing; asserting the exact number here would be asserting
    // the floor table twice.
    const ranked = graph.listSalientNodes();
    expect(ranked.map((node) => node.id)).toEqual([lonely.id]);
    expect(ranked[0]?.salience).toBeGreaterThanOrEqual(0);
  });

  it("should rank a person above a passing fact of equal connectedness", () => {
    // The eviction that `syl-ulf` measured, as a unit: at equal degree — which
    // on the live graph meant EVERY node, since the only edge anyone had was
    // provenance — a person must outrank a fact, or the projection drops the
    // people and keeps whatever was said most recently.
    const fact = graph.addNode({ kind: "fact", label: "a passing remark" });
    const person = graph.addNode({ kind: "person", label: "Ela" });

    const ranked = graph.listSalientNodes();
    expect(ranked.map((node) => node.id)).toEqual([person.id, fact.id]);
  });

  it("should not count cold edges, because a scan must not pay for history", () => {
    const a = graph.addNode({ kind: "person", label: "the Commander" });
    const b = graph.addNode({ kind: "goal", label: "ship Syl" });
    const edge = graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "cares about",
      reasoning: "he keeps mentioning it",
      confidence: 0.8,
      demoteAfter: DEMOTE_AT,
      weight: 1,
    });
    // Measured as a DIFFERENCE rather than against a literal, which is what
    // "a cold edge contributes nothing" actually claims. A literal baseline
    // silently becomes an assertion about the kind floor as well, and then
    // breaks for a reason that has nothing to do with cold edges.
    const before = graph.listSalientNodes().map((node) => node.salience);
    graph.demote(edge);
    const after = graph.listSalientNodes().map((node) => node.salience);

    expect(after).toEqual(before.map((salience) => salience - 1));
  });

  it("should exclude anything that is not hot", () => {
    const hot = graph.addNode({ kind: "fact", label: "current" });
    const cold = graph.addNode({ kind: "fact", label: "set aside" });
    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(cold.id);

    expect(graph.listSalientNodes().map((node) => node.id)).toEqual([hot.id]);
  });

  it("should refuse a limit below one", () => {
    expect(kindOf(() => graph.listSalientNodes(0))).toBe("bad_limit");
  });

  it("should avoid the OR-join whose cost is quadratic in a graph that never shrinks", () => {
    expect(SALIENCE_SQL).toContain("UNION ALL");
    expect(SALIENCE_SQL).not.toMatch(/source_node = n\.id OR/u);
  });
});

describe("MemoryGraph.edgesAssertedBy", () => {
  it("should return every observation one node asserted", () => {
    const source = graph.addNode({ kind: "source", label: "an article" });
    const a = graph.addNode({ kind: "fact", label: "a claim" });
    const b = graph.addNode({ kind: "fact", label: "another claim" });
    const first = graph.observe({
      sourceNode: source.id,
      targetNode: a.id,
      relation: "says",
      assertedBy: source.id,
    });
    const second = graph.observe({
      sourceNode: source.id,
      targetNode: b.id,
      relation: "says",
      assertedBy: source.id,
    });

    expect(graph.edgesAssertedBy(source.id).map((edge) => edge.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("should never return an inference, which has no asserter by construction", () => {
    const source = graph.addNode({ kind: "source", label: "an article" });
    const a = graph.addNode({ kind: "fact", label: "a claim" });
    graph.infer({
      sourceNode: source.id,
      targetNode: a.id,
      relation: "hints at",
      reasoning: "the tone",
      confidence: 0.4,
      demoteAfter: DEMOTE_AT,
    });

    expect(graph.edgesAssertedBy(source.id)).toEqual([]);
  });

  it("should span every tier, so a forget reaches what decay set aside", () => {
    const source = graph.addNode({ kind: "source", label: "an article" });
    const a = graph.addNode({ kind: "fact", label: "a claim" });
    const edge = graph.observe({
      sourceNode: source.id,
      targetNode: a.id,
      relation: "says",
      assertedBy: source.id,
    });
    graph.demote(edge);

    expect(graph.edgesAssertedBy(source.id).map((found) => found.tier)).toEqual(["cold"]);
  });

  it("should return nothing for a node that has asserted nothing", () => {
    expect(graph.edgesAssertedBy(graph.addNode({ kind: "fact", label: "quiet" }).id)).toEqual([]);
  });
});
