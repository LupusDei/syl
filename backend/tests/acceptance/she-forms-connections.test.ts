import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TurnOptions, TurnResult, TurnRunner } from "../../src/harness/session.js";
import { bootstrap, type ServiceDependencies } from "../../src/index.js";
import { DreamJudge } from "../../src/memory/dream/judge.js";
import { DreamSweep } from "../../src/memory/dream/sweep.js";
import { WorkingMemory } from "../../src/memory/working.js";
import { fixedClock } from "../../src/services/clock.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { loadFixture, makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";
import { testConfig } from "../helpers/service.js";

/**
 * **The five bars for `syl-zdf` — digestion, and the connections it makes.**
 *
 * All five describe CORRECT behaviour and all five are RED as written. They are
 * declared in `tests/expected-failures.json` against `syl-zdf.1` and come out of
 * that file one at a time as the work lands. None of them may be softened into
 * asserting what the code does today.
 *
 * This file exists because of how `syl-005` closed. Five of its sub-epics —
 * including `syl-005.4 Dreaming` — are marked complete, while the epic's entire
 * thesis sits at zero: measured on the live graph on 2026-08-11, 30 nodes, 29
 * edges, every one of them `relation='stated'` provenance from a single hub,
 * and **zero** edges between any two real memories. `expected-failures.json`
 * contained no test asserting that an entity ever links to an entity, so there
 * was nothing red to stop them closing green. That absence is the defect these
 * five tests repair.
 *
 *
 * ## Why these assert OUTCOMES and import nothing that does not exist
 *
 * Every assertion here is made against the DATABASE after driving the real
 * write path. Nothing imports a digestion module, because vitest cannot
 * *collect* a file whose imports do not resolve — the file would not fail, it
 * would vanish, and the run would look smaller rather than broken. That is the
 * same silent-shrink failure `scripts/check-workspace-deps.mjs` exists to
 * prevent, and it would be a poor way to hold the line on tests that are
 * supposed to stay visibly red.
 *
 * It also means these go green without being rewritten. A test that has to be
 * edited to pass is a test that was measuring the implementation.
 *
 *
 * ## What is real here
 *
 * `bootstrap` — the service's own composition root — a file-backed database,
 * the real migrations, the real graph, and a real extraction subprocess against
 * `fake-claude`. The conversational half is scripted in-process: it is not what
 * is under test and paying a spawn for it would only add flake. Same division
 * as `tests/integration/remembers.test.ts`, for the same reasons.
 */

const NOW = Date.parse("2026-08-10T09:00:00.000Z");

const HE_SAID =
  "My wife Ela and I have two children: Rowan, my son, and Isla, my daughter. " +
  "I am head of engineering at 6lock, and getting out of debt is my primary goal.";
const SHE_SAID = "Noted — Ela, Rowan, Isla, 6lock, and the debt.";

/**
 * What extraction returns on the wire today: typed nodes, and **no relations
 * between them**. The five person/goal nodes below are exactly the shape the
 * live graph is in — note that the relationship is carried in the LABEL TEXT
 * (`"— his wife"`), which is the defect stated as data. The information is not
 * missing; it is in the one place nothing can query.
 */
const EXTRACTED = JSON.stringify({
  facts: [
    { kind: "person", label: "Justin Martin", body: "The Commander.", saidIn: 1 },
    { kind: "person", label: "Ela — his wife", body: "His wife Ela.", saidIn: 1 },
    // The duplicate, as it actually happened: a second mention of one person,
    // extracted under a different label. Both are `person`, neither carries a
    // `subject_id`, and nothing has ever noticed they are the same woman.
    { kind: "person", label: "Ela", body: "Ela wants an apartment back home.", saidIn: 1 },
    { kind: "person", label: "Rowan — his son", body: "His son Rowan.", saidIn: 1 },
    { kind: "person", label: "Isla — his daughter", body: "His daughter Isla.", saidIn: 1 },
    { kind: "goal", label: "Get out of debt", body: "His primary goal, urgent.", saidIn: 1 },
    {
      kind: "fact",
      label: "Head of engineering at 6lock",
      body: "He is head of engineering at 6lock.",
      saidIn: 1,
    },
  ],
  instructionsFound: [],
});

function replyingWith(text: string): FakeClaude {
  const lines = loadFixture("auto-memory-disabled").map((line) => {
    if (!line.includes('"type":"result"')) return line;
    const parsed: unknown = JSON.parse(line);
    return JSON.stringify({ ...(parsed as Record<string, unknown>), result: text });
  });
  return makeFakeClaude({ after: lines, exitCode: 0 });
}

function scriptedRunner(reply: string): TurnRunner {
  return (_prompt: string, options: TurnOptions) => {
    const sessionId = options.resume ?? options.sessionId ?? "session-under-test";
    options.onSessionId?.(sessionId);
    return Promise.resolve({
      sessionId,
      text: reply,
      spoken: reply,
      costUsd: 0,
      numTurns: 1,
      init: {
        kind: "init",
        sessionId,
        raw: {},
        model: "test",
        apiKeySource: "none",
        mcpServers: [],
        tools: [],
        capabilities: [],
        autoMemoryPath: undefined,
      },
      events: [],
    } satisfies TurnResult);
  };
}

let directory: string;
let claude: FakeClaude;
const open: SylDatabase[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "syl-connections-"));
  claude = replyingWith(EXTRACTED);
});

afterEach(() => {
  for (const database of open.splice(0)) database.close();
  claude.cleanup();
  rmSync(directory, { recursive: true, force: true });
});

function boot(): { readonly deps: ServiceDependencies; readonly database: SylDatabase } {
  const clock = fixedClock(NOW);
  const { database, deps } = bootstrap(
    testConfig({ databasePath: join(directory, "syl.db") }),
    { runner: scriptedRunner(SHE_SAID), turn: { claudeBin: claude.bin }, clock },
  );
  open.push(database);
  return { deps, database };
}

async function say(deps: ServiceDependencies, text: string): Promise<void> {
  deps.chat.accept(
    deps.chat.append({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      clientId: null,
      role: "user",
      text,
    }),
  );
  await deps.chat.idle();
}

interface EdgeRow {
  readonly relation: string;
  readonly kind: string;
  readonly source_label: string;
  readonly target_label: string;
}

/** Every edge in the graph, with both endpoints resolved to their labels. */
function edges(database: SylDatabase): EdgeRow[] {
  return database.handle
    .prepare(
      `SELECT e.relation, e.kind,
              s.label AS source_label, t.label AS target_label, s.kind AS source_kind,
              t.kind AS target_kind
         FROM memory_edges e
         JOIN memory_nodes s ON s.id = e.source_node
         JOIN memory_nodes t ON t.id = e.target_node`,
    )
    .all() as unknown as EdgeRow[];
}

describe("she forms connections — the five bars for digestion (syl-zdf)", () => {
  /**
   * BAR 1. The dandelion, stated as a test.
   *
   * Not "an edge exists" — 29 of those exist and they are all the same edge.
   * This asks for an edge between two REAL memories that is not provenance.
   */
  it("should connect a person to another person by a typed relation", async () => {
    const { deps, database } = boot();
    await say(deps, HE_SAID);

    const between = edges(database).filter(
      (e) => e.relation !== "stated" && e.source_label !== "Conversation with the Commander",
    );

    expect(between.length).toBeGreaterThan(0);
    expect(between.map((e) => e.relation)).toContain("spouse_of");
  });

  /**
   * BAR 2. Identity.
   *
   * `memory_nodes.subject_id` exists and `extract-apply.ts` says "Deliberately
   * no subjectId", so it has never been populated on this path. The live
   * consequence was two `person` nodes for one wife, where the newer one
   * evicted the richer one from working memory.
   *
   * The second assertion is the trap that is already in the live data: the
   * Commander and his father share a surname. Resolution must not merge them.
   */
  it("should resolve two mentions of one person to one identity, without merging two people", async () => {
    const { deps, database } = boot();
    await say(deps, HE_SAID);

    // Deliberately agnostic about HOW: resolution may merge the two rows into
    // one node or leave two rows sharing an identity. Both are correct; only
    // "two people who are the same person" is not. Asserting the row count
    // would be asserting an implementation this test has no business choosing.
    const elas = database.handle
      .prepare("SELECT subject_id FROM memory_nodes WHERE kind = 'person' AND label LIKE 'Ela%'")
      .all() as unknown as { subject_id: string | null }[];

    expect(elas.length).toBeGreaterThan(0);
    expect(elas.every((row) => row.subject_id !== null)).toBe(true);
    expect(new Set(elas.map((row) => row.subject_id)).size).toBe(1);
  });

  /**
   * BAR 3. The one that was actually costing him something.
   *
   * Measured on 2026-08-11 at the old 4,000-byte budget: 23 admitted, 7
   * dropped, and the seven were his own name, his wife, his son, his daughter,
   * where he lives, his job title and what his company does. Uncle Bob survived
   * because he was more recent.
   *
   * Asserted at a deliberately TIGHT budget rather than the production one, so
   * it tests the eviction RULE rather than today's node count — the rule is
   * what has to hold when the graph is fifty thousand nodes and the budget
   * binds again.
   */
  it("should never evict a person or a goal in favour of a more recent fact", async () => {
    const { deps, database } = boot();
    await say(deps, HE_SAID);

    const working = new WorkingMemory({
      db: database.handle,
      graph: deps.memory.graph,
      clock: fixedClock(NOW),
      maxBytes: 1_400,
    });
    const text = working.regenerate().row.text;

    expect(text).toContain("Ela");
    expect(text).toContain("Rowan");
    expect(text).toContain("Isla");
    expect(text).toContain("Get out of debt");
  });

  /**
   * BAR 4. The ranking signal itself.
   *
   * `SALIENCE_SQL` sums incident hot-edge weights. Measured on the live graph:
   * the hub scored 29 and **every other node scored exactly 1**. A constant
   * primary sort key is not a sort key — admission fell through to the recency
   * tiebreaker, which is the direct cause of Bar 3.
   */
  it("should rank memories by something that actually varies", async () => {
    const { deps } = boot();
    await say(deps, HE_SAID);

    // Asked through the production ranker rather than by reimplementing
    // SALIENCE_SQL here. A test that copies the query it is checking passes
    // whenever the copy is self-consistent, which is not the property wanted.
    const ranked = deps.memory.graph
      .listSalientNodes(200)
      .filter((node) => node.kind !== "source");
    const bands = new Set(ranked.map((node) => node.salience));

    expect(ranked.length).toBeGreaterThan(1);
    expect(bands.size).toBeGreaterThan(1);
  });

  /**
   * BAR 5. The dream, which has never inserted an edge.
   *
   * `dream_sessions` has zero rows: the nightly job was wired to a clock on
   * 2026-08-10 and its only run was correctly skipped as outside the window. So
   * this is not a regression — it is a claim the epic made and never evidenced.
   *
   * Measured cause, by running the real kernels against the real graph:
   * `related()` proposes 0 candidates because `entitiesOf()` derives its probes
   * from edges and every node's only edge is provenance, so all 30 yield the
   * same constant probe. The dream cannot bootstrap itself out of a dandelion —
   * which is precisely why digestion has to come first.
   */
  it("should insert at least one inferred edge that survives a night", async () => {
    const { deps, database } = boot();
    await say(deps, HE_SAID);

    // Assembled the way `buildDreamJudge` does, minus the semantic proposer:
    // `trySearchable()` needs `vec0` and, on first use, a model, and a night
    // that cannot run for want of an extension is not the claim under test.
    // The two structural kernels are the half that is supposed to work today.
    const clock = fixedClock(NOW);
    const judge = new DreamJudge({
      sweep: new DreamSweep({
        graph: deps.memory.graph,
        log: deps.memory.dreams,
        weights: deps.memory.weights,
        clock,
      }),
      log: deps.memory.dreams,
      clock,
      runTurn: scriptedRunner(SHE_SAID),
      requireEmptyToolSurface: false,
    });
    await judge.dream({ night: "2026-08-10", tz: "America/Chicago" });

    const inferred = database.handle
      .prepare("SELECT count(*) AS n FROM memory_edges WHERE kind = 'inferred'")
      .get() as unknown as { n: number };

    expect(inferred.n).toBeGreaterThan(0);
  });
});
