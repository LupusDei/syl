import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphError, MemoryGraph } from "../../src/memory/graph.js";
import { MEMORY_NODE_KINDS } from "../../src/memory/schema.js";
import {
  buildWorkingMemory,
  toCandidate,
  WORKING_MEMORY_EMPTY,
  WORKING_MEMORY_MAX_BYTES,
  WORKING_MEMORY_MAX_LINES,
  WORKING_MEMORY_NOTE,
  WORKING_MEMORY_SECTIONS,
  WORKING_MEMORY_TITLE,
  WorkingMemory,
  WorkingMemoryOverflowError,
  type WorkingMemoryCandidate,
} from "../../src/memory/working.js";
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
 * Working memory (`syl-005.5.1`) — a PROJECTION of the graph's hot region.
 *
 * Two properties carry the bead and each has its own block below: it fits a
 * budget it is never allowed to exceed silently, and it is regenerated rather
 * than accumulated.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const NOW_ISO = "2026-08-09T12:00:00.000Z";
const LATER = Date.parse("2026-08-10T12:00:00.000Z");
const LATER_ISO = "2026-08-10T12:00:00.000Z";
const DEMOTE_AT = "2026-08-11T00:00:00.000Z";

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

function candidate(overrides: Partial<WorkingMemoryCandidate> = {}): WorkingMemoryCandidate {
  return {
    id: "syl:memory_node:01991b2f-0000-7000-8000-00000000000a",
    kind: "fact",
    label: "a fact",
    body: null,
    salience: 1,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

/** `count` candidates that differ only where the ranking looks. */
function many(count: number, overrides: Partial<WorkingMemoryCandidate> = {}): WorkingMemoryCandidate[] {
  return Array.from({ length: count }, (_unused, index) =>
    candidate({
      id: `syl:memory_node:01991b2f-0000-7000-8000-${String(index).padStart(12, "0")}`,
      label: `fact number ${String(index)}`,
      salience: count - index,
      ...overrides,
    }),
  );
}

describe("buildWorkingMemory", () => {
  it("should distil the hot region into sections, most salient first", () => {
    const plan = buildWorkingMemory([
      candidate({ id: "syl:memory_node:1", kind: "goal", label: "ship Syl", salience: 5 }),
      candidate({
        id: "syl:memory_node:2",
        kind: "person",
        label: "the Commander",
        body: "calls Syl by name",
        salience: 9,
      }),
    ]);

    expect(plan.text).toContain(WORKING_MEMORY_TITLE);
    expect(plan.text).toContain("## People");
    expect(plan.text).toContain("- the Commander — calls Syl by name");
    expect(plan.text).toContain("## Goals");
    expect(plan.text).toContain("- ship Syl");
    expect(plan.included).toEqual(["syl:memory_node:2", "syl:memory_node:1"]);
    expect(plan.dropped).toEqual([]);
  });

  it("should say what it is, in the text, so a turn cannot mistake it for a store", () => {
    expect(buildWorkingMemory([]).text).toContain(WORKING_MEMORY_NOTE);
    expect(WORKING_MEMORY_NOTE).toMatch(/projection/u);
    expect(WORKING_MEMORY_NOTE).toMatch(/overwritten/u);
  });

  it("should say something rather than nothing when the hot region is empty", () => {
    const plan = buildWorkingMemory([]);

    expect(plan.text).toContain(WORKING_MEMORY_EMPTY);
    expect(plan.included).toEqual([]);
    expect(plan.bytes).toBeGreaterThan(0);
  });

  it("should stay inside the budget it must be loadable within", () => {
    const plan = buildWorkingMemory(many(400, { body: "x".repeat(300) }));

    expect(plan.bytes).toBeLessThanOrEqual(WORKING_MEMORY_MAX_BYTES);
    expect(plan.lines).toBeLessThanOrEqual(WORKING_MEMORY_MAX_LINES);
    expect(Buffer.byteLength(plan.text, "utf8")).toBe(plan.bytes);
  });

  it("should NAME what did not fit rather than dropping it silently", () => {
    // The auto-memory index cliff (`syl-03d`) in one assertion: past a limit
    // the thing stops being loaded and nothing says so. Here it says so.
    const plan = buildWorkingMemory(many(400));

    expect(plan.dropped.length).toBeGreaterThan(0);
    expect(plan.text).toContain(`…and ${String(plan.dropped.length)} more`);
    expect(plan.included).toHaveLength(400 - plan.dropped.length);
  });

  it("should drop the LEAST salient tail, never the most salient head", () => {
    const plan = buildWorkingMemory(many(400));
    const first = many(400)[0];

    expect(plan.included[0]).toBe(first?.id);
    expect(plan.dropped).toContain(many(400)[399]?.id);
  });

  it("should be deterministic — the same input renders the same bytes", () => {
    const shuffled = [...many(30)].reverse();

    expect(buildWorkingMemory(many(30)).text).toBe(buildWorkingMemory(shuffled).text);
  });

  it("should break salience ties totally, so two runs cannot reorder", () => {
    const flat = many(10, { salience: 1 });

    expect(buildWorkingMemory(flat).included).toEqual(buildWorkingMemory([...flat].reverse()).included);
  });

  it("should truncate an entry rather than let one node eat the budget", () => {
    const plan = buildWorkingMemory([candidate({ body: "y".repeat(5_000) })]);

    expect(plan.text).toContain("…");
    expect(plan.bytes).toBeLessThanOrEqual(WORKING_MEMORY_MAX_BYTES);
  });

  it("should honour a caller's tighter budget", () => {
    const plan = buildWorkingMemory(many(50), { maxBytes: 600, maxLines: 12 });

    expect(plan.bytes).toBeLessThanOrEqual(600);
    expect(plan.lines).toBeLessThanOrEqual(12);
    expect(plan.dropped.length).toBeGreaterThan(0);
  });

  it("should have a section for every node kind, so nothing hot is unrenderable", () => {
    // A new kind added to `MEMORY_NODE_KINDS` with no section here would be
    // selected into the projection and then rendered nowhere — hot, chosen,
    // and invisible, with nothing failing.
    const kinds = WORKING_MEMORY_SECTIONS.map((section) => section.kind);

    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual([...MEMORY_NODE_KINDS].sort());
    expect(
      buildWorkingMemory(kinds.map((kind, index) => candidate({ id: `n${String(index)}`, kind })))
        .dropped,
    ).toEqual([]);
  });
});

describe("WorkingMemory.regenerate", () => {
  const working = (clock = fixedClock(NOW)): WorkingMemory =>
    new WorkingMemory({ db, graph: new MemoryGraph({ db, clock }), clock });

  it("should build the projection from the graph's hot region", () => {
    const commander = graph.addNode({ kind: "person", label: "the Commander" });
    const goal = graph.addNode({ kind: "goal", label: "ship Syl" });
    graph.observe({
      sourceNode: commander.id,
      targetNode: goal.id,
      relation: "owns",
      assertedBy: commander.id,
    });

    const result = working().regenerate();

    expect(result.changed).toBe(true);
    expect(result.row.text).toContain("the Commander");
    expect(result.row.text).toContain("ship Syl");
    expect(result.row.included).toBe(2);
    expect(result.row.generatedAt).toBe(NOW_ISO);
  });

  it("should be IDEMPOTENT — run twice on an unchanged graph and nothing changes", () => {
    graph.addNode({ kind: "person", label: "the Commander" });
    const first = working().regenerate();

    // A day later. A projection that rewrote itself unconditionally would move
    // `generated_at` here, and "the graph moved" would stop being detectable.
    const second = working(fixedClock(LATER)).regenerate();

    expect(second.changed).toBe(false);
    expect(second.row).toEqual(first.row);
    expect(second.row.generatedAt).toBe(NOW_ISO);
  });

  it("should carry no timestamp inside the text, which is what makes that possible", () => {
    graph.addNode({ kind: "person", label: "the Commander" });

    expect(working().regenerate().row.text).not.toContain(NOW_ISO);
  });

  it("should rewrite when the graph actually moves", () => {
    const node = graph.addNode({ kind: "person", label: "the Commander" });
    working().regenerate();

    const later = new MemoryGraph({ db, clock: fixedClock(LATER) });
    later.relabel(node, "Justin");
    const second = working(fixedClock(LATER)).regenerate();

    expect(second.changed).toBe(true);
    expect(second.row.text).toContain("Justin");
    expect(second.row.generatedAt).toBe(LATER_ISO);
  });

  it("should NEVER accumulate — the table holds exactly one row, by CHECK", () => {
    graph.addNode({ kind: "person", label: "the Commander" });
    working().regenerate();
    graph.addNode({ kind: "goal", label: "ship Syl" });
    working(fixedClock(LATER)).regenerate();

    const rows = db.prepare("SELECT count(*) AS n FROM working_memory").get() as unknown as {
      n: number;
    };
    expect(rows.n).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO working_memory (id, text, digest, bytes, lines, included, dropped, generated_at) " +
            "VALUES (2, 'x', 'd', 1, 1, 0, 0, ?)",
        )
        .run(NOW_ISO),
    ).toThrow(/CHECK/u);
  });

  it("should forget what left the hot region, because it is rebuilt and not appended to", () => {
    const a = graph.addNode({ kind: "person", label: "the Commander" });
    const b = graph.addNode({ kind: "fact", label: "an old fact" });
    graph.observe({ sourceNode: a.id, targetNode: b.id, relation: "knew", assertedBy: a.id });
    working().regenerate();

    db.prepare("UPDATE memory_nodes SET tier = 'cold' WHERE id = ?").run(b.id);
    const second = working(fixedClock(LATER)).regenerate();

    expect(second.changed).toBe(true);
    expect(second.row.text).not.toContain("an old fact");
  });

  it("should refuse to store a projection over budget rather than let it go dark", () => {
    graph.addNode({ kind: "person", label: "x".repeat(400) });
    // A ceiling under the size of the header alone: the builder cannot fit it,
    // so the store is the thing that has to refuse.
    const tiny = new WorkingMemory({ db, graph, maxBytes: 10, clock: fixedClock(NOW) });

    expect(() => tiny.regenerate()).toThrow(WorkingMemoryOverflowError);
    expect(tiny.current()).toBeNull();
  });

  it("should refuse a scan limit below one", () => {
    const bad = new WorkingMemory({ db, graph, scanLimit: 0 });

    expect(() => bad.regenerate()).toThrow(GraphError);
  });
});

describe("WorkingMemory.preamble", () => {
  it("should be empty before the first regeneration rather than throwing", () => {
    const working = new WorkingMemory({ db, graph, clock: fixedClock(NOW) });

    expect(working.current()).toBeNull();
    expect(working.preamble()).toBe("");
  });

  it("should hand back exactly the stored text, ready to prepend to a turn", () => {
    graph.addNode({ kind: "person", label: "the Commander" });
    const working = new WorkingMemory({ db, graph, clock: fixedClock(NOW) });
    const result = working.regenerate();

    expect(working.preamble()).toBe(result.row.text);
    expect(Buffer.byteLength(working.preamble(), "utf8")).toBeLessThanOrEqual(
      WORKING_MEMORY_MAX_BYTES,
    );
  });

  it("should survive a demotion sweep having emptied the hot tier", () => {
    const a = graph.addNode({ kind: "person", label: "the Commander" });
    const b = graph.addNode({ kind: "goal", label: "ship Syl" });
    graph.infer({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "cares about",
      reasoning: "he says so",
      confidence: 0.9,
      demoteAfter: DEMOTE_AT,
    });
    const working = new WorkingMemory({ db, graph, clock: fixedClock(NOW) });
    working.regenerate();

    graph.demoteDueEdges("2026-08-12T00:00:00.000Z");
    const after = new WorkingMemory({ db, graph, clock: fixedClock(LATER) }).regenerate();

    expect(after.row.text).toContain("the Commander");
    expect(after.plan.dropped).toEqual([]);
  });
});

describe("toCandidate", () => {
  it("should carry a salient node across without inventing anything", () => {
    const node = graph.addNode({ kind: "person", label: "the Commander", body: "he is busy" });
    const salient = graph.listSalientNodes();

    expect(salient[0]).toBeDefined();
    expect(toCandidate(salient[0] as never)).toEqual({
      id: node.id,
      kind: "person",
      label: "the Commander",
      body: "he is busy",
      salience: 0,
      updatedAt: NOW_ISO,
    });
  });
});

/**
 * The budget, raised from 4,000 to 32,000 bytes on the Commander's order
 * (2026-08-11, `syl-ulf`). He accepted the extra per-turn cost explicitly:
 * "I'm fine with it burning extra tokens... if it ever gets too expensive we
 * can start rolling that back."
 *
 * The FIRST test here is the cheap one and it is not the point. The second is:
 * `0019`'s `CHECK (bytes > 0 AND bytes <= 4096)` is a SCHEMA backstop, so
 * raising the constant alone leaves a code path that fits 32,000 bytes and a
 * database that refuses to store them. That failure would not appear in any
 * test that only reads the constant — it appears on the first real projection
 * that grows past 4 KB, in production, as a write error on a path whose whole
 * job is to never go silently dark.
 */
describe("working memory — the raised budget", () => {
  it("should carry a budget of 32,000 bytes across at least 400 lines", () => {
    expect(WORKING_MEMORY_MAX_BYTES).toBe(32_000);
    expect(WORKING_MEMORY_MAX_LINES).toBeGreaterThanOrEqual(400);
  });

  it("should PERSIST a projection larger than the old 4,096-byte schema backstop", () => {
    // 120 nodes of ~160 chars each is ~19 KB of entries: comfortably past the
    // old ceiling and comfortably inside the new one, so this asserts the
    // migration rather than the arithmetic.
    for (let i = 0; i < 120; i += 1) {
      graph.addNode({
        kind: "fact",
        label: `fact number ${String(i)}`,
        body: `a body long enough to matter, repeated to fill the entry budget ${"x".repeat(90)}`,
      });
    }

    const working = new WorkingMemory({ db, graph, clock: fixedClock(NOW) });
    const result = working.regenerate();

    expect(result.row.bytes).toBeGreaterThan(4096);
    expect(result.row.bytes).toBeLessThanOrEqual(WORKING_MEMORY_MAX_BYTES);
    expect(working.preamble()).toBe(result.row.text);

    const stored = db.prepare("SELECT bytes FROM working_memory WHERE id = 1").get() as {
      bytes: number;
    };
    expect(stored.bytes).toBe(result.row.bytes);
  });

  it("should admit far more entries than the old budget could hold", () => {
    for (let i = 0; i < 120; i += 1) {
      graph.addNode({ kind: "fact", label: `fact number ${String(i)}`, body: "short body" });
    }

    const working = new WorkingMemory({ db, graph, clock: fixedClock(NOW) });
    const result = working.regenerate();

    // The old 4,000-byte budget admitted 23 entries against the live graph.
    expect(result.plan.included.length).toBeGreaterThan(60);
  });
});
