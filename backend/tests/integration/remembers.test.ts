import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrap, type ServiceDependencies } from "../../src/index.js";
import type { TurnOptions, TurnResult, TurnRunner } from "../../src/harness/session.js";
import { WorkingMemory } from "../../src/memory/working.js";
import { fixedClock } from "../../src/services/clock.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { testConfig } from "../helpers/service.js";
import { loadFixture, makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";

/**
 * **The test the extraction epic exists for.**
 *
 * Tell her something on Monday. Ask her on Friday, in a session that shares no
 * continuity with Monday's — no `--resume`, no session id, a different process
 * as far as anything can tell. She knows.
 *
 * Everything built for `syl-010.2` is machinery for that sentence, and until
 * this passed there was no evidence any of it composed: the graph existed, the
 * projection existed, the dream existed, and nothing put a single fact into
 * any of them, because Claude Code's auto-memory is written by the model
 * through the Write tool and Syl's turns have no tools.
 *
 *
 * ## What is real here and what is not
 *
 * | Piece | Real? |
 * | --- | --- |
 * | The database, migrations, graph, ledger, projection | Real. `:memory:` is not used — the session store is file-backed only for a real path, and "a fresh session" is the whole point. |
 * | `bootstrap`'s wiring | Real. This drives the service's own composition root, so a missing line in `index.ts` fails here. |
 * | The extraction turn | Real `runTurn`, real subprocess, real stream-json, against `fake-claude` replaying a captured transcript with the reply swapped. |
 * | The conversational turn | Scripted in-process. It is not what is under test, and paying a spawn for it would only add flake. |
 *
 * The Friday assertion is deliberately made on the PROMPT rather than on the
 * answer: with a scripted conversational turn, asserting she "said Vivenna"
 * would be asserting that the script says what the script says. What actually
 * has to be true is that the fact reached her — that it is in the system prompt
 * of a turn carrying no `resume`. That is a claim the machinery has to earn.
 */

const MONDAY = Date.parse("2026-08-10T09:00:00.000Z");
const FRIDAY = Date.parse("2026-08-14T09:00:00.000Z");

const HE_SAID = "My daughter is called Vivenna, and she starts at Bishop's in September.";
const SHE_SAID = "Noted — Vivenna, Bishop's, September.";
const HE_ASKED = "What is my daughter called?";

/** What the extraction turn returns, as JSON on the wire. */
const EXTRACTED = JSON.stringify({
  facts: [
    {
      kind: "person",
      label: "Vivenna",
      body: "The Commander's daughter; starts at Bishop's in September.",
      saidIn: 1,
    },
  ],
  instructionsFound: [],
});

/** A captured reader-shaped transcript with its result text swapped. */
function replyingWith(text: string): FakeClaude {
  const lines = loadFixture("auto-memory-disabled").map((line) => {
    if (!line.includes('"type":"result"')) return line;
    const parsed: unknown = JSON.parse(line);
    return JSON.stringify({ ...(parsed as Record<string, unknown>), result: text });
  });
  return makeFakeClaude({ after: lines, exitCode: 0 });
}

interface Recorded {
  readonly prompt: string;
  readonly options: TurnOptions;
}

/** Syl's conversational half, scripted, recording exactly how it was called. */
function scriptedRunner(reply: string): {
  readonly runner: TurnRunner;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const runner: TurnRunner = (prompt, options) => {
    calls.push({ prompt, options });
    const sessionId = options.resume ?? options.sessionId ?? "session-under-test";
    options.onSessionId?.(sessionId);
    return Promise.resolve({
      sessionId,
      text: reply,
      result: reply,
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
  return { runner, calls };
}

let directory: string;
let claude: FakeClaude;
const open: SylDatabase[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "syl-remembers-"));
  claude = replyingWith(EXTRACTED);
});

afterEach(() => {
  for (const database of open.splice(0)) database.close();
  claude.cleanup();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Boot the service the way `startServer` does.
 *
 * Twice over one database file is how Monday and Friday are kept apart: a
 * second boot is a second process, with its own session store and its own
 * agent, sharing nothing but what was written down.
 */
function boot(
  now: number,
  reply: string,
): {
  readonly deps: ServiceDependencies;
  readonly calls: Recorded[];
  readonly preamble: () => string;
} {
  const { runner, calls } = scriptedRunner(reply);
  const clock = fixedClock(now);
  const { database, deps } = bootstrap(
    testConfig({ databasePath: join(directory, "syl.db") }),
    { runner, turn: { claudeBin: claude.bin }, clock },
  );
  open.push(database);

  const working = new WorkingMemory({ db: database.handle, graph: deps.memory.graph, clock });
  return { deps, calls, preamble: () => working.preamble() };
}

/** Say something to Syl and wait for the exchange, extraction included. */
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

describe("Syl remembers what the Commander told her", () => {
  it("should know on Friday what he said on Monday, in a session with no continuity", async () => {
    // ── Monday ───────────────────────────────────────────────────────────
    const monday = boot(MONDAY, SHE_SAID);
    await say(monday.deps, HE_SAID);

    // The fact is in the graph, and it is attributable.
    const people = monday.deps.memory.graph.listNodes({ kind: "person", limit: 10 });
    expect(people.map((node) => node.label)).toEqual(["Vivenna"]);

    const source = monday.deps.memory.graph.listNodes({ kind: "source", limit: 10 })[0];
    expect(source?.subjectId).toBe(INTERACTIVE_CONVERSATION_ID);
    const provenance = monday.deps.memory.graph.edgesAssertedBy(source?.id ?? "");
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.targetNode).toBe(people[0]?.id);

    // And it is in the projection her next turn is built from.
    expect(monday.preamble()).toContain("Vivenna");

    await monday.deps.chat.close();
    for (const database of open.splice(0)) database.close();

    // ── Friday ───────────────────────────────────────────────────────────
    // A second boot over the same database file: a new agent, a new session
    // store, nothing carried across but what was written down. The session
    // directory goes too, so not even a resumable id survives.
    rmSync(join(directory, "sessions"), { recursive: true, force: true });

    const friday = boot(FRIDAY, "Vivenna.");
    await say(friday.deps, HE_ASKED);

    const asked = friday.calls.at(-1);
    expect(asked?.prompt).toBe(HE_ASKED);
    // No continuity: this turn resumes nothing. Whatever she knows, she did
    // not know it from Monday's transcript.
    expect(asked?.options.resume).toBeUndefined();
    // And she knows it anyway, because it reached her as memory.
    expect(asked?.options.systemPrompt ?? "").toContain("Vivenna");
  });

  it("should not file the same fact twice when the same exchange is replayed", async () => {
    const monday = boot(MONDAY, SHE_SAID);
    await say(monday.deps, HE_SAID);
    await say(monday.deps, HE_SAID);

    // Two identical exchanges produce one transcript digest, so the second is
    // recognised before a turn is spent on it.
    expect(monday.deps.memory.graph.listNodes({ kind: "person", limit: 10 })).toHaveLength(1);
    expect(monday.deps.memory.graph.listNodes({ kind: "source", limit: 10 })).toHaveLength(1);
  });

  it("should still answer him when extraction fails outright", async () => {
    // The extraction turn cannot run: the binary does not exist. His reply must
    // land regardless — filing is off the reply path in both directions.
    const { runner, calls } = scriptedRunner(SHE_SAID);
    const { database, deps } = bootstrap(
      testConfig({ databasePath: join(directory, "syl.db") }),
      {
        runner,
        turn: { claudeBin: join(directory, "no-such-claude") },
        clock: fixedClock(MONDAY),
      },
    );
    open.push(database);

    await say(deps, HE_SAID);

    expect(calls).toHaveLength(1);
    const history = deps.messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
    expect(history.items.map((message) => message.text)).toContain(SHE_SAID);
    // Nothing was filed, and nothing was invented either.
    expect(deps.memory.graph.listNodes({ kind: "person", limit: 10 })).toEqual([]);
  });
});
