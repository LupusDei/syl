import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryGraph } from "../../src/memory/graph.js";
import {
  asHandle,
  handle,
  HANDLE_FIELDS,
  PROJECTION_FIELDS,
  ProjectionError,
  projectGoal,
  projectInto,
  projectSource,
  reconcileProjections,
  toProjection,
  type NodeProjection,
  type ProjectionHandle,
} from "../../src/memory/projection.js";
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
 * The four-field projection contract (`syl-005.1.4`), against the real
 * migrations — including `memory_nodes_handle_idx` from `0017`, which is what
 * makes "one handle per row" a fact about the database.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const NOW_ISO = "2026-08-09T12:00:00.000Z";
const LATER = Date.parse("2026-08-09T18:00:00.000Z");

const GOAL_ID = "syl:goal:01991b2f-0000-7000-8000-0000000000cd";
const SOURCE_ID = "syl:source:01991b2f-0000-7000-8000-0000000000ce";

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
    return error instanceof ProjectionError ? error.kind : `not a ProjectionError: ${String(error)}`;
  }
  return "did not throw";
}

describe("the projection contract", () => {
  it("should be exactly { id, type, label, ref } — no status, no dates, no counts", () => {
    // The payload type itself, asserted structurally. A `NodeProjection` with
    // a fifth field would fail to satisfy this exact-keys check, so the
    // contract cannot be widened without this test going red.
    const projection: NodeProjection = {
      id: "syl:memory_node:01991b2f-0000-7000-8000-0000000000aa",
      type: "goal",
      label: "ship Syl",
      ref: GOAL_ID,
    };

    expect(Object.keys(projection).sort()).toEqual([...PROJECTION_FIELDS].sort());
    expect(PROJECTION_FIELDS).toHaveLength(4);
    expect([...HANDLE_FIELDS].every((field) => PROJECTION_FIELDS.includes(field))).toBe(true);
  });

  it("should make carrying mutable life-model state a COMPILE error, not a review catch", () => {
    // A `Goal` row, exactly as `shared/types.ts` defines one. The whole failure
    // this bead exists for is `status` being copied in here, drifting when the
    // row changes, and NOTHING erroring.
    const goal = {
      type: "goal",
      label: "ship Syl",
      ref: GOAL_ID,
      status: "active",
    } as const;

    // @ts-expect-error `status` is not part of the contract. If this line ever
    // starts compiling, the four-field contract has become a convention again.
    const rejected = (): ProjectionHandle => handle(goal);

    // The runtime half, for a cast or a JSON round-trip that gets past tsc.
    expect(kindOf(rejected)).toBe("extra_field");
  });

  it("should refuse extra fields at runtime rather than quietly dropping them", () => {
    const smuggled = JSON.parse(
      `{"type":"goal","label":"ship Syl","ref":"${GOAL_ID}","targetDate":"2026-12-31"}`,
    ) as unknown;

    const error = kindOf(() => asHandle(smuggled));

    expect(error).toBe("extra_field");
    // Dropping the field silently would let a caller believe it was stored.
    expect(() => asHandle(smuggled)).toThrow(/targetDate/u);
  });

  it("should refuse a type outside the graph's vocabulary", () => {
    expect(kindOf(() => asHandle({ type: "todo", label: "x", ref: GOAL_ID }))).toBe("bad_type");
  });

  it("should refuse a blank label and a ref that addresses nothing", () => {
    expect(kindOf(() => asHandle({ type: "goal", label: "  ", ref: GOAL_ID }))).toBe("blank_label");
    expect(kindOf(() => asHandle({ type: "goal", label: "x", ref: "goal-17" }))).toBe("bad_ref");
  });

  it("should refuse anything that is not an object at all", () => {
    expect(kindOf(() => asHandle(null))).toBe("extra_field");
    expect(kindOf(() => asHandle("syl:goal:x"))).toBe("extra_field");
  });
});

describe("the projectors", () => {
  it("should project a goal as its title and its id, and nothing else", () => {
    expect(projectGoal({ id: GOAL_ID, title: "ship Syl" })).toEqual({
      type: "goal",
      label: "ship Syl",
      ref: GOAL_ID,
    });
  });

  it("should project a source as its title, falling back to the canonical URL", () => {
    const base = { id: SOURCE_ID, canonicalUrl: "https://example.com/a" };

    expect(projectSource({ ...base, title: "An Article" }).label).toBe("An Article");
    expect(projectSource({ ...base, title: null }).label).toBe("https://example.com/a");
  });
});

describe("projectInto", () => {
  it("should create a handle the first time it sees a row", () => {
    const projected = projectInto(graph, projectGoal({ id: GOAL_ID, title: "ship Syl" }));

    expect(projected.outcome).toBe("created");
    expect(projected.projection).toEqual({
      id: projected.projection.id,
      type: "goal",
      label: "ship Syl",
      ref: GOAL_ID,
    });
    expect(graph.getNode(projected.projection.id)?.subjectId).toBe(GOAL_ID);
  });

  it("should never write the free-text body, which is where this rule would die", () => {
    // `CreateNodeInput` has a `body` column and `body: JSON.stringify(goal)`
    // type-checks perfectly. The writer here has no way to reach it.
    const projected = projectInto(graph, projectGoal({ id: GOAL_ID, title: "ship Syl" }));

    expect(graph.getNode(projected.projection.id)?.body).toBeNull();
  });

  it("should rename rather than fork when the row's title moves", () => {
    const first = projectInto(graph, projectGoal({ id: GOAL_ID, title: "ship Syl" }));
    const later = new MemoryGraph({ db, clock: fixedClock(LATER) });

    const second = projectInto(later, projectGoal({ id: GOAL_ID, title: "ship Syl 1.0" }));

    expect(second.outcome).toBe("relabelled");
    expect(second.projection.id).toBe(first.projection.id);
    expect(graph.nodesForSubject(GOAL_ID)).toHaveLength(1);
  });

  it("should refuse a handle that broke the contract before it reaches the graph", () => {
    expect(
      kindOf(() =>
        projectInto(graph, { type: "goal", label: "ship Syl", ref: GOAL_ID, count: 3 } as never),
      ),
    ).toBe("extra_field");
    expect(graph.nodesForSubject(GOAL_ID)).toEqual([]);
  });

  it("should keep one handle per (ref, kind) as a DATABASE fact, not a code path", () => {
    projectInto(graph, projectGoal({ id: GOAL_ID, title: "ship Syl" }));

    // Going round `projectInto` entirely, the way a second call site or a
    // concurrent regeneration would.
    expect(() => graph.addNode({ kind: "goal", label: "ship Syl", subjectId: GOAL_ID })).toThrow(
      /UNIQUE/u,
    );
  });

  it("should leave room for the graph to know many things about one row", () => {
    // The handle index is partial on the kinds a projector mints. Many
    // memories about one goal is the normal, intended state of the graph.
    projectInto(graph, projectGoal({ id: GOAL_ID, title: "ship Syl" }));
    graph.addNode({ kind: "memory", label: "he was tired of it", subjectId: GOAL_ID });
    graph.addNode({ kind: "memory", label: "he was proud of it", subjectId: GOAL_ID });

    expect(graph.nodesForSubject(GOAL_ID)).toHaveLength(3);
  });
});

describe("toProjection", () => {
  it("should reduce a node to the four fields and nothing more", () => {
    const node = graph.addNode({
      kind: "goal",
      label: "ship Syl",
      body: "should not escape",
      subjectId: GOAL_ID,
    });

    expect(toProjection(node)).toEqual({
      id: node.id,
      type: "goal",
      label: "ship Syl",
      ref: GOAL_ID,
    });
  });

  it("should refuse a node that is a handle for nothing", () => {
    expect(kindOf(() => toProjection(graph.addNode({ kind: "fact", label: "loose" })))).toBe(
      "bad_ref",
    );
  });
});

describe("reconcileProjections", () => {
  const life = (): readonly ProjectionHandle[] => [
    projectGoal({ id: GOAL_ID, title: "ship Syl" }),
    projectSource({ id: SOURCE_ID, title: "An Article", canonicalUrl: "https://example.com/a" }),
  ];

  it("should create every handle on a first run", () => {
    const result = reconcileProjections(graph, life());

    expect(result).toMatchObject({ created: 2, relabelled: 0, unchanged: 0, changed: true });
    expect(result.nodes.map((node) => node.projection.ref)).toEqual([GOAL_ID, SOURCE_ID]);
  });

  it("should be IDEMPOTENT — run twice on an unchanged life model, nothing moves", () => {
    reconcileProjections(graph, life());
    const before = graph.nodesForSubject(GOAL_ID);

    // A later clock, so a stray write would be visible as a bumped stamp
    // rather than hidden by a frozen one.
    const later = new MemoryGraph({ db, clock: fixedClock(LATER) });
    const second = reconcileProjections(later, life());

    expect(second).toMatchObject({ created: 0, relabelled: 0, unchanged: 2, changed: false });
    expect(graph.nodesForSubject(GOAL_ID)).toEqual(before);
    expect(graph.nodesForSubject(GOAL_ID)[0]?.updatedAt).toBe(NOW_ISO);
  });

  it("should report only what actually moved when one row was renamed", () => {
    reconcileProjections(graph, life());

    const result = reconcileProjections(graph, [
      projectGoal({ id: GOAL_ID, title: "ship Syl 1.0" }),
      projectSource({ id: SOURCE_ID, title: "An Article", canonicalUrl: "https://example.com/a" }),
    ]);

    expect(result).toMatchObject({ created: 0, relabelled: 1, unchanged: 1, changed: true });
  });

  it("should take an empty life model without writing anything", () => {
    expect(reconcileProjections(graph, [])).toMatchObject({
      created: 0,
      relabelled: 0,
      unchanged: 0,
      changed: false,
    });
    expect(graph.listNodes()).toEqual([]);
  });

  it("should stop on a handle that breaks the contract rather than skipping it", () => {
    expect(
      kindOf(() =>
        reconcileProjections(graph, [
          ...life(),
          { type: "goal", label: "another", ref: GOAL_ID, status: "active" } as never,
        ]),
      ),
    ).toBe("extra_field");
  });
});
