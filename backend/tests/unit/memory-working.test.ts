import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphError, MemoryGraph } from "../../src/memory/graph.js";
import { MEMORY_NODE_KINDS } from "../../src/memory/schema.js";
import {
  buildWorkingMemory,
  toCandidate,
  WORKING_MEMORY_EMPTY,
  WORKING_MEMORY_EXCLUDED_KINDS,
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
    //
    // Deliberately sized to overflow the REAL production budget rather than a
    // caller-supplied one — this asserts the cliff at the ceiling that actually
    // ships. 400 stopped overflowing when the budget went 4,000 -> 32,000
    // (`syl-ulf`); the count has to track the budget or the test quietly stops
    // testing anything, which is the same class of rot the expected-failures
    // gate exists to catch.
    const plan = buildWorkingMemory(many(1_200));

    expect(plan.dropped.length).toBeGreaterThan(0);
    expect(plan.text).toContain(`…and ${String(plan.dropped.length)} more`);
    expect(plan.included).toHaveLength(1_200 - plan.dropped.length);
  });

  it("should say what KIND was left out, not merely how many — `syl-016.2`", () => {
    // Her complaint, verbatim: "It says there are ten more items it isn't
    // showing me." A bare count tells her she is deciding with a known gap and
    // gives her nothing to weigh — ten dropped sources and ten dropped people
    // are not remotely the same situation, and she could not tell which.
    const plan = buildWorkingMemory(
      [
        ...many(4, { kind: "person" }),
        ...many(3, { kind: "fact", salience: 0.5 }),
      ].map((entry, index) => ({ ...entry, id: `syl:memory_node:${String(index)}` })),
      { maxLines: 9 },
    );

    expect(plan.dropped.length).toBeGreaterThan(0);
    // Named in the plural where there is more than one, singular where there is
    // one: she reads this out, and "3 memory" is a schema leaking into it.
    expect(plan.text).toMatch(/not shown here: \d+ (person|people|fact|facts)/u);
  });

  it("should tell her how to open what it is hiding, now that she can", () => {
    // An omission count with no way to reach it is worse than a shorter list.
    // This line was "Search deep memory for anything specific" for months while
    // she had no tool that could — an instruction outliving its capability,
    // which is the failure this project keeps catching in prose.
    //
    // Sized to overflow the REAL budget, like its two siblings above. 400
    // stopped overflowing when the budget went 4,000 -> 32,000 (`syl-ulf`), so
    // this asserted the notice on a plan that no longer had one. A test whose
    // fixture drifts under the thing it measures stops measuring it silently.
    const plan = buildWorkingMemory(many(1_200));

    expect(plan.text).toContain("recall");
  });

  it("should size the notice it will really print, not one from a count", () => {
    // The budget is measured against the rendered text, and the notice now
    // varies with what was dropped. A trial render sized from a count and a
    // final render printed from a list would be two answers to one question,
    // and the budget would silently be the wrong one.
    const plan = buildWorkingMemory(many(400));

    expect(plan.bytes).toBe(Buffer.byteLength(plan.text, "utf8"));
    expect(plan.bytes).toBeLessThanOrEqual(WORKING_MEMORY_MAX_BYTES);
  });

  it("should drop the LEAST salient tail, never the most salient head", () => {
    const plan = buildWorkingMemory(many(1_200));
    const first = many(1_200)[0];

    expect(plan.included[0]).toBe(first?.id);
    expect(plan.dropped).toContain(many(1_200)[1_199]?.id);
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

  it("should account for every node kind — rendered or deliberately excluded", () => {
    // A new kind added to `MEMORY_NODE_KINDS` with no section here would be
    // selected into the projection and then rendered nowhere — hot, chosen,
    // and invisible, with nothing failing. `syl-024.2` adds the second half:
    // a kind may instead be excluded ON PURPOSE, and that has to be DECLARED
    // rather than achieved by leaving it out of the list, which looks
    // identical from here and is the same silent invisibility.
    const kinds = WORKING_MEMORY_SECTIONS.map((section) => section.kind);
    const excluded = [...WORKING_MEMORY_EXCLUDED_KINDS];

    expect(new Set(kinds).size).toBe(kinds.length);
    // Disjoint: a kind that is both rendered and excluded is two answers to
    // one question, and which one wins would depend on where you read.
    expect(kinds.filter((kind) => excluded.includes(kind))).toEqual([]);
    expect([...kinds, ...excluded].sort()).toEqual([...MEMORY_NODE_KINDS].sort());
    expect(
      buildWorkingMemory(kinds.map((kind, index) => candidate({ id: `n${String(index)}`, kind })))
        .dropped,
    ).toEqual([]);
  });
});

/**
 * `syl-024.2` — namespacing, not isolation.
 *
 * The first attempt kept her self-findings out of "what do I know about him" by
 * refusing to give them edges. That works, in the sense that a node nothing
 * points at is absent from every projection — including the ones that should
 * have it. Her diagnosis: *"a render note should be absent from 'what do I know
 * about Justin' because the query excludes it, not because it's connected to
 * nothing."*
 *
 * So the test that carries the bead asserts BOTH halves in one place. Either
 * alone is satisfied by the version this replaces: absence alone is what
 * isolation gave, and reachability alone is what it gave up.
 */
describe("a self-finding is namespaced, not isolated", () => {
  it("should be absent from the projection about him and still reachable by traversal", () => {
    const commander = graph.addNode({ kind: "person", label: "the Commander" });
    const order = graph.addNode({ kind: "instruction", label: "she is allowed to be funny" });
    const self = graph.addNode({
      kind: "self",
      label: "she keeps reaching for the engineer's voice",
      body: "asked who she was, she described this codebase",
    });
    // The three edges the Commander asked for by name: to his person node, to
    // an instruction, and to a fact about his life.
    const fact = graph.addNode({ kind: "fact", label: "he works late" });
    for (const target of [commander.id, order.id, fact.id]) {
      graph.observe({
        sourceNode: self.id,
        targetNode: target,
        relation: "about",
        assertedBy: commander.id,
      });
    }

    const memory = new WorkingMemory({ db, graph, clock: fixedClock(NOW) });
    const result = memory.regenerate();

    // Absent — by the WHERE clause, not by eviction. It is not in the text, not
    // admitted, and not in the overflow either: a notice reading "1 note about
    // myself" would hand back exactly what the filter removed.
    expect(result.row.text).not.toContain("engineer's voice");
    expect(result.plan.included).not.toContain(self.id);
    expect(result.plan.dropped).not.toContain(self.id);
    expect(memory.overflow({ limit: 1_000 }).items.map((item) => item.id)).not.toContain(self.id);
    expect(memory.overflow({ limit: 1_000 }).byKind.map((entry) => entry.kind)).not.toContain(
      "self",
    );

    // And reachable. Every edge survives, in the hot tier, from his side.
    const around = graph.neighbourhood(commander.id);
    expect(around.nodes.map((node) => node.id)).toContain(self.id);
    expect(graph.edgesTouching(self.id)).toHaveLength(3);
    expect(graph.getNode(self.id)?.tier).toBe("hot");
  });

  it("should still answer with what he told her — an instruction is his, not hers", () => {
    // The filter is one kind wide. `instruction` is something he SAID, so it
    // belongs in the answer to what she knows about him; excluding both
    // together would be the isolation bug wearing the new vocabulary.
    graph.addNode({ kind: "instruction", label: "he prefers renders with a face" });
    graph.addNode({ kind: "self", label: "her renders keep drifting off-model" });

    const text = new WorkingMemory({ db, graph, clock: fixedClock(NOW) }).regenerate().row.text;

    expect(text).toContain("## Standing orders");
    expect(text).toContain("he prefers renders with a face");
    expect(text).not.toContain("off-model");
  });

  it("should rank a standing order above the anchors, and a self-finding below them", () => {
    // The floor is what stops a standing order being evicted by whatever was
    // said this morning — the failure measured on his own family (`syl-ulf`).
    // Ranking is only half of it; admission is `syl-024.3`.
    graph.addNode({ kind: "instruction", label: "be funny" });
    graph.addNode({ kind: "person", label: "the Commander" });
    graph.addNode({ kind: "self", label: "she reaches for the engineer's voice" });
    graph.addNode({ kind: "fact", label: "he works late" });

    // No edges anywhere, so each node scores exactly its kind floor.
    const scored = new Map(graph.listSalientNodes().map((node) => [node.kind, node.salience]));

    expect(scored.get("instruction")).toBeGreaterThan(scored.get("person") ?? 0);
    expect(scored.get("self")).toBeLessThan(scored.get("person") ?? 0);
    expect(scored.get("self")).toBeGreaterThan(scored.get("fact") ?? 0);
  });
});

describe("WorkingMemory.overflow", () => {
  /**
   * A projection squeezed by LINES rather than bytes.
   *
   * The byte budget has a floor — the note alone is 200-odd bytes, and
   * `regenerate` refuses a projection over budget even with nothing admitted —
   * so squeezing that way would exercise the overflow *guard* instead of the
   * overflow.
   */
  const working = (): WorkingMemory =>
    new WorkingMemory({ db, graph, clock: fixedClock(NOW), maxLines: 9 });

  function crowd(): void {
    graph.addNode({ kind: "person", label: "the Commander" });
    graph.addNode({ kind: "person", label: "his wife" });
    graph.addNode({ kind: "goal", label: "sell the house" });
    graph.addNode({ kind: "fact", label: "he sleeps badly in August" });
    graph.addNode({ kind: "decision", label: "no metered API, ever" });
  }

  it("should be exactly what the projection could not fit", () => {
    // The property that makes this trustworthy: one admission rule, in one
    // function, producing both the text she reads and the list she can open.
    // A stored list of dropped ids would be a second answer to the same
    // question, going stale the moment the graph moved.
    crowd();
    const memory = working();
    const plan = memory.regenerate().plan;

    const overflow = memory.overflow({ limit: 1_000 });

    expect(overflow.items.map((item) => item.id)).toEqual(plan.dropped);
    expect(overflow.total).toBe(plan.dropped.length);
  });

  it("should carry the ids, because an id is what every other verb needs", () => {
    crowd();

    for (const item of working().overflow({ limit: 1_000 }).items) {
      expect(item.id).toMatch(/^syl:memory_node:/u);
      expect(item.label).not.toBe("");
    }
  });

  it("should count the overflow by kind, in the order the sections run", () => {
    crowd();

    const overflow = working().overflow({ limit: 1_000 });
    const order = overflow.byKind.map((entry) => entry.kind);

    expect(overflow.byKind.reduce((sum, entry) => sum + entry.count, 0)).toBe(overflow.total);
    expect(order).toEqual(
      WORKING_MEMORY_SECTIONS.map((section) => section.kind).filter((kind) => order.includes(kind)),
    );
    // No zero rows: a kind that was not dropped is not part of the omission.
    expect(overflow.byKind.every((entry) => entry.count > 0)).toBe(true);
  });

  it("should narrow to one kind while still reporting the whole omission", () => {
    // She reads "2 people, 1 fact" and asks for the people. Narrowing must not
    // make the rest invisible — that is the original defect with an extra step.
    crowd();
    const memory = working();

    const people = memory.overflow({ kind: "person", limit: 1_000 });

    expect(people.items.every((item) => item.kind === "person")).toBe(true);
    expect(people.matched).toBe(people.items.length);
    expect(people.total).toBe(memory.overflow({ limit: 1_000 }).total);
    expect(people.byKind).toEqual(memory.overflow({ limit: 1_000 }).byKind);
  });

  it("should report how many a limit held back, rather than looking complete", () => {
    crowd();
    const memory = working();
    const whole = memory.overflow({ limit: 1_000 });

    const first = memory.overflow({ limit: 1 });

    expect(first.items).toHaveLength(1);
    expect(first.matched).toBe(whole.total);
  });

  it("should be empty when the projection is hiding nothing", () => {
    graph.addNode({ kind: "person", label: "the Commander" });

    const overflow = new WorkingMemory({ db, graph, clock: fixedClock(NOW) }).overflow();

    expect(overflow.items).toEqual([]);
    expect(overflow.total).toBe(0);
    expect(overflow.byKind).toEqual([]);
  });

  it("should not need the projection to have been regenerated first", () => {
    // A brand-new install has no stored row at all. Recomputing from the graph
    // means the overflow is answerable before the first night has ever run.
    crowd();

    expect(working().overflow({ limit: 1_000 }).total).toBeGreaterThan(0);
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
      // A `person` scores its kind floor with no edges at all (`syl-zdf.6`).
      salience: 3,
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
