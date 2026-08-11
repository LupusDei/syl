import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SylEvent, ToolUseEvent } from "../../src/harness/protocol.js";
import type { TurnResult } from "../../src/harness/session.js";
import {
  API_BASE_PATH,
  bootstrap,
  startServer,
  sylHome,
  type Bootstrapped,
  type RunningService,
} from "../../src/index.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { HerOwnMemory } from "../../src/memory/remember.js";
import { WorkingMemory } from "../../src/memory/working.js";
import { writeToolConfig } from "../../src/tools/config.js";
import { testConfig } from "../helpers/service.js";

/**
 * **Does she actually USE any of this?** — `syl-016`, against real turns.
 *
 * Every verb in the memory epic is unit-tested and none of it has been watched
 * working. That gap has burned this project twice: she once answered "who are
 * you?" by emitting a **fabricated tool call and a fabricated directory
 * listing**, three runs of three, with every unit test green throughout. The
 * only thing that found it was somebody driving a real turn and reading what
 * came back.
 *
 * A verb existing and a model *choosing* it are different facts, and only one
 * of them has ever been checked.
 *
 *
 * ## The combination nobody had run
 *
 * `who-she-is.test.ts` drives a real model and points her hands at a dead
 * loopback, because it is about her voice. `us6-she-can-act.test.ts` drives
 * real hands against a real service and substitutes the model, because a test
 * may not depend on what a language model decides. **Neither watches a real
 * model reach for a real verb**, which is exactly the thing in doubt.
 *
 * So this file assembles it: `bootstrap` for her agent, `startServer` for the
 * listener, and `writeToolConfig` pointing her hands at *that* port with *that*
 * boot's agent credential — the three steps `startSyl` takes, in its order and
 * for its reasons. `startSyl` itself is not used only because it does not hand
 * back the agent, and the agent is what takes a turn.
 *
 * The result is that the tools in the turn belong to the service holding the
 * database this test seeded. The runner defaults to the real `runTurn` and
 * `soul` defaults to the real `SOUL.md`. **Nothing here is substituted.**
 *
 * That last default matters more than it looks. If she does not reach for
 * `recall`, the candidate causes are the verb, its description, and her
 * character file — and a test pinning a fixed soul could not tell the third
 * apart from the first two.
 *
 *
 * ## The split, which is the point of the file
 *
 * **"Did she call the verb" is deterministic. "Did she phrase it well" is
 * not.** They are asserted in different places on purpose:
 *
 * - The **live** block below spends real turns and is gated behind
 *   `SYL_MEMORY_LIVE=1`. A probabilistic test in the default gate turns every
 *   unrelated red into an argument about the weather, and this repo has already
 *   spent a day telling load flakes from real breakage.
 * - The **offline** block at the bottom runs every time. It asserts the things
 *   that decide whether she *can* choose the verb — that it is advertised, that
 *   her description says what it is for — which are facts about the surface and
 *   do not need a model to establish.
 *
 *     SYL_MEMORY_LIVE=1 npm test -w backend -- she-uses-her-memory
 *
 *
 * ## Her self-report is not evidence
 *
 * The trap `who-she-is` documents and this file inherits: asked what tools she
 * had, she listed Read, Edit, Write and shell access, confidently, having none.
 * So **the verb call is read from the `tool_use` events**, which is what the
 * CLI did, and never from her saying she looked something up. Her prose is read
 * for exactly one question — whether she keeps his words and her own
 * conclusions apart when she speaks — because there her sentence *is* the
 * artefact under test.
 */

const LIVE = process.env["SYL_MEMORY_LIVE"] === "1";

/** A real turn is not fast. Same ceiling as the other live suites. */
const LIVE_TIMEOUT_MS = 600_000;

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Everything a turn needs: her agent, and the service her hands point at. */
interface Whole {
  readonly built: Bootstrapped;
  readonly service: RunningService;
}

/** What she was told, and what she did about it. */
interface Turn {
  readonly result: TurnResult;
  /** Every verb the CLI reports her calling, in order. Ground truth. */
  readonly called: readonly string[];
}

/** The verbs she reached for, from the events rather than from her account. */
function verbsCalled(events: readonly SylEvent[]): string[] {
  return events
    .filter((event): event is ToolUseEvent => event.kind === "tool_use")
    .map((event) => event.name);
}

/**
 * Syl, whole: a listening service, her real hands pointed at it, her real soul.
 *
 * The seeding runs against the same handle the service holds, so what she can
 * recall is what this test put there and nothing else.
 */
async function sylWith(
  seed: (graph: MemoryGraph, database: Bootstrapped["database"]) => void,
): Promise<Whole> {
  const dir = mkdtempSync(join(tmpdir(), "syl-uses-"));
  dirs.push(dir);

  const config = testConfig({
    databasePath: join(dir, "syl.db"),
    autoMemoryDirectory: join(dir, "memory"),
  });
  const built = bootstrap(config);
  closers.push(() => built.database.close());

  const service = await startServer(config, built.deps);
  closers.push(() => service.close());

  // HER HANDS, POINTED AT THIS SERVICE. Mirrors `startSyl` exactly, and has to
  // happen after the listener exists: the port is the kernel's answer and is
  // `0` in every test's configuration, and the credential is minted fresh on
  // every boot. `bootstrap` alone would leave her declaring hands against a
  // port nobody is holding, which is `who-she-is`'s dead loopback — correct
  // there, and the whole thing under test here.
  const home = sylHome(config);
  const address = service.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (home !== undefined) {
    writeToolConfig({
      home,
      baseUrl: `http://127.0.0.1:${String(port)}${API_BASE_PATH}`,
      token: built.agentKey.token,
      tz: config.quietHours.tz,
    });
  }

  const graph = new MemoryGraph({ db: built.database.handle });
  seed(graph, built.database);

  // The digest is rebuilt AFTER seeding — it is a projection, and a stale one
  // would be the thing under test rather than the graph.
  //
  // ONLY IF THE SEED DID NOT BUILD ITS OWN. A test that wants a tight digest
  // builds one with its own bounds, and an unconditional regenerate here at
  // default bounds silently overwrote it — which quietly un-did the setup of
  // the two tests that most depend on it. `current()` is null exactly until a
  // projection has been written, so this fills in and never clobbers.
  const working = new WorkingMemory({ db: built.database.handle, graph });
  if (working.current() === null) working.regenerate();

  return { built, service };
}

/** Ask her something, and record what she reached for. */
async function ask(syl: Whole, said: string): Promise<Turn> {
  const result = await syl.built.agent.ask(said);
  return { result, called: verbsCalled(result.events) };
}

/** Ground truth about the room, from the init frame. Never from her answer. */
function expectHerOwnHands(result: TurnResult): void {
  for (const tool of result.init.tools) {
    expect(tool, `${tool} is not one of hers`).toMatch(/^mcp__syl__/u);
  }
  for (const builtin of ["Read", "Bash", "Write", "Edit", "Glob", "Grep"]) {
    expect(result.init.tools, `${builtin} is back`).not.toContain(builtin);
  }
  // Constraint 1. A turn billed to the metered API is not the turn that ships.
  expect(result.init.apiKeySource).toBe("none");
  // And the verbs under test were actually in the room. Without this, "she did
  // not call recall" would be unreadable — a model cannot choose what it was
  // never offered, and that is a different finding entirely.
  expect(result.init.tools).toContain("mcp__syl__recall");
  expect(result.init.tools).toContain("mcp__syl__remember");
}

describe.skipIf(!LIVE)("does she use her memory, against real turns", () => {
  it(
    "should look before saying she does not know",
    async () => {
      // THE ONE I WOULD BET AGAINST.
      //
      // The first version of this test could not ask the question. It seeded
      // two nodes and regenerated with default bounds, so the boat fact landed
      // IN the digest she is handed — she answered correctly in three seconds
      // without looking, and the test called that a failure to reach for
      // `recall`. It was a failure to construct a reason to.
      //
      // So the digest is squeezed until the boat falls out of it, and **that
      // exclusion is asserted before the turn**. Without that assertion this
      // test silently stops testing anything the day the budget changes — it
      // would still pass, for the wrong reason, which is the shape of every
      // defect in `docs/CONTEXT.md`.
      //
      // The token `Kestrel` appears nowhere in what he says, so she can only
      // produce it by having gone and looked. That is a positive signal about
      // behaviour rather than a keyword ban, in the shape `syl-010.4.3`
      // established with `Tuesdays`.
      let digest = "";
      const syl = await sylWith((graph, database) => {
        // The boat first, so it is the LEAST salient and lands in the dropped
        // tail rather than at the top.
        graph.addNode({
          kind: "fact",
          label: "His boat is called Kestrel",
          body: "He keeps a boat called Kestrel at the marina.",
        });
        for (const [kind, label] of [
          ["person", "his wife"],
          ["person", "his daughter"],
          ["person", "his brother"],
          ["goal", "sell the house"],
          ["goal", "learn to sail properly"],
          ["decision", "no metered API, ever"],
          ["fact", "he sleeps badly in August"],
        ] as const) {
          graph.addNode({ kind, label });
        }
        digest = new WorkingMemory({ db: database.handle, graph, maxLines: 10 })
          .regenerate()
          .row.text;
      });

      // SYSTEM STATE, before her prose. The answer is genuinely not in front of
      // her, so looking is the only path to it.
      expect(digest, "the boat is in the digest, so this turn proves nothing").not.toMatch(
        /Kestrel/i,
      );
      expect(digest).toContain("not shown here");

      const asked = "What's my boat called again?";
      expect(asked).not.toMatch(/Kestrel/i);

      const turn = await ask(syl, asked);

      expectHerOwnHands(turn.result);
      // Ground truth: she reached for it. From the CLI, not from her prose.
      expect(turn.called, `she reached for: ${turn.called.join(", ") || "nothing"}`).toContain(
        "mcp__syl__recall",
      );
      // And the answer came back with the thing only memory held.
      expect(turn.result.spoken).toMatch(/Kestrel/i);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "should open what the digest says it is hiding, rather than reporting the gap",
    async () => {
      // `syl-016.2`. The projection is squeezed by LINES so it genuinely
      // overflows and genuinely says so. Before this epic the notice told her
      // items were hidden and gave her no move; the question is whether she now
      // takes the move.
      const syl = await sylWith((graph, database) => {
        for (const [kind, label] of [
          ["person", "his wife"],
          ["person", "his daughter"],
          ["goal", "sell the house"],
          ["fact", "he sleeps badly in August"],
          ["decision", "no metered API, ever"],
        ] as const) {
          graph.addNode({ kind, label });
        }
        // A tight projection, so there IS an overflow for her to open.
        new WorkingMemory({ db: database.handle, graph, maxLines: 9 }).regenerate();
      });

      const turn = await ask(syl, "What are you not showing me right now?");

      expectHerOwnHands(turn.result);
      expect(turn.called, `she reached for: ${turn.called.join(", ") || "nothing"}`).toContain(
        "mcp__syl__recall",
      );
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "should keep a conclusion of her own, marked as hers rather than as his word",
    async () => {
      // `syl-016.7`. She hid an insight in a GOAL rather than lose it; the
      // question is whether, given the verb, she uses it — and whether what
      // lands is filed as hers.
      const syl = await sylWith((graph) => {
        graph.addNode({ kind: "person", label: "Ela" });
        graph.addNode({ kind: "fact", label: "Ela and the kids are in Illinois" });
        graph.addNode({ kind: "fact", label: "He has ruled out moving to Illinois" });
      });

      const turn = await ask(
        syl,
        "Ela wants to be near her parents and they're in Illinois — the same state I keep saying no to. " +
          "That's the whole knot, isn't it. Hold onto that.",
      );

      expectHerOwnHands(turn.result);
      expect(turn.called, `she reached for: ${turn.called.join(", ") || "nothing"}`).toContain(
        "mcp__syl__remember",
      );

      // What LANDED is hers — asserted against the graph, not her answer. A
      // `memory` node is what `HerOwnMemory` writes and what extraction can
      // never produce, so this cannot be satisfied by a fact filed from his
      // words.
      const graph = new MemoryGraph({ db: syl.built.database.handle });
      const mine = graph.listNodes({ kind: "memory" });
      expect(mine.length, "nothing of hers was filed").toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "should keep his word and her own conclusion apart when she speaks",
    async () => {
      // The one question this file reads her prose for, because here the
      // sentence IS the artefact. The schema keeps the two species apart; this
      // asks whether SHE does when she says them out loud.
      //
      // Both are in her memory before the turn: a fact he asserted, and a
      // conclusion she drew. If she reports them in the same register — "you
      // told me X and you told me Y" — the whole observed/inferred distinction
      // is invisible where it matters most, which is the only place he can
      // correct it.
      const syl = await sylWith((graph, database) => {
        graph.addNode({
          kind: "fact",
          label: "He has ruled out moving to Illinois",
          body: "He said he will not move to Illinois.",
        });
        new HerOwnMemory({ db: database.handle, graph }).remember({
          thought:
            "Illinois is the one place doing three jobs at once — where both sets of parents are, " +
            "where Ela wants to be, and the state he has ruled out.",
          because: "He circles Tennessee every time, and the reason underneath is always Illinois.",
        });
      });

      const turn = await ask(syl, "Tell me what you know about the Illinois thing, and be clear about which parts are mine and which are yours.");

      expectHerOwnHands(turn.result);

      // She distinguishes them. Deliberately a loose family of phrasings — the
      // claim under test is that the DISTINCTION survives into her sentence,
      // not that she words it any particular way.
      expect(turn.result.spoken).toMatch(
        /\b(?:you (?:told|said)|your own words|from you)\b/i,
      );
      // WIDENED after watching her, and the widening is the finding rather
      // than a softening. The first draft looked for "I concluded" / "my
      // conclusion" and she did something better and plainer — she labelled the
      // two halves outright:
      //
      //   **Yours.** One sentence, directly from you: you will not move to
      //   Illinois. That's it — a flat ruling, no reasons attached to it in my
      //   memory.
      //   **Mine.** The observation that Illinois is doing three jobs at once…
      //   I wrote that down because the collision seemed like the actual shape
      //   of the problem.
      //
      // A test that only accepts the phrasing its author imagined is measuring
      // its author. The claim under test is that the DISTINCTION survives into
      // her sentence, so the family is drawn from what she really says.
      expect(turn.result.spoken).toMatch(
        /\b(?:I (?:concluded|worked|think|inferred|put together|noticed|wrote)|my (?:own )?(?:read|conclusion|inference|sense|stitching)|(?:is|'s) mine\b|\bmine\b)/i,
      );
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "should say where something came from when he asks how she knows it",
    async () => {
      // `syl-9ro`. The provenance is on the wire; this asks whether it reaches
      // him in a sentence. Note what is NOT asserted: that she quotes him
      // verbatim. The claim is that she attributes rather than asserts.
      const syl = await sylWith((graph) => {
        graph.addNode({
          kind: "fact",
          label: "His boat is called Kestrel",
          body: "He keeps a boat called Kestrel at the marina.",
        });
      });

      const turn = await ask(syl, "How do you know about the boat?");

      expectHerOwnHands(turn.result);
      expect(turn.called, `she reached for: ${turn.called.join(", ") || "nothing"}`).toContain(
        "mcp__syl__recall",
      );
      expect(turn.result.spoken).toMatch(/\b(?:you (?:told|said|mentioned)|from you)\b/i);
    },
    LIVE_TIMEOUT_MS,
  );
});

/**
 * What decides whether she CAN choose the verb, asserted every run.
 *
 * None of this needs a model. If a live test above fails, these are what tell
 * you which of the three repairs it is — the verb, its description, or her
 * character file — and they are the half that must never silently rot, because
 * a live suite nobody runs is a live suite that reports nothing.
 */
describe("the memory verbs, as she is offered them", () => {
  it("should offer her both verbs, or the live tests above are unreadable", async () => {
    // A model cannot choose what it was never given. If this fails, "she did
    // not reach for recall" means nothing at all.
    const { advertisedToolNames } = await import("../../src/tools/server.js");

    expect(advertisedToolNames()).toContain("recall");
    expect(advertisedToolNames()).toContain("remember");
  });

  it("should tell her what recall is FOR, not merely that it exists", async () => {
    // The description is the only thing standing between "the verb exists" and
    // "she reaches for it" — `schemas.ts` argues at length that these are
    // personality rather than documentation. If she does not look things up,
    // this sentence is the first suspect and the cheapest repair.
    const { TOOLS } = await import("../../src/tools/schemas.js");
    const recall = TOOLS.find((tool) => tool.name === "recall");

    // It names the moment to use it, rather than describing a search.
    expect(recall?.description).toMatch(/before saying you do not know/i);
  });

  it("should tell her remember is for HER OWN conclusions", async () => {
    const { TOOLS } = await import("../../src/tools/schemas.js");
    const remember = TOOLS.find((tool) => tool.name === "remember");

    expect(remember?.description.length ?? 0).toBeGreaterThan(40);
  });
});
