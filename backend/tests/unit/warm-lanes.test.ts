import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import type { TurnOptions, TurnResult, TurnRunner } from "../../src/harness/session.js";
import { WARM_LANES, WarmLanes } from "../../src/harness/warm-lanes.js";
import { loadFixture, makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";
import { codeOf, importClosure } from "../helpers/source-scan.js";
import { BACKEND_SRC } from "../helpers/sql-tables.js";

/**
 * `syl-per1` — **the lane split**, which is the deliverable rather than the
 * persistence.
 *
 * Persistence is worth having and it is not free: it reintroduces a process to
 * supervise, a crash that costs more than a request, and contention. Those are
 * worth paying **where a person is waiting** and worth nothing at 03:00 in the
 * middle of the dream. So the question this file answers is not "does one
 * process serve many turns" — `persistent-session.test.ts` does that — but
 * **which turns are allowed near one**.
 *
 * The load-bearing case is the last `describe`. `runReaderTurn` must never
 * become persistent: its entire security property is a fresh, never-resumed,
 * tool-less, auto-memory-off process, and a warm reader session would let one
 * injected article reach every later read down the same pipe. That is asserted
 * structurally, not behaviourally — see there for why.
 */

const PONG = loadFixture("turn-pong");
const fakes: FakeClaude[] = [];
const routers: WarmLanes[] = [];

afterEach(async () => {
  for (const router of routers.splice(0)) await router.close();
  for (const fake of fakes.splice(0)) fake.cleanup();
});

/** A persistent fake: answers each frame as it lands, forever. */
function persistentFake(): FakeClaude {
  const created = makeFakeClaude({ turns: [{ lines: PONG }] });
  fakes.push(created);
  return created;
}

/** A router whose cold path is recorded rather than run. */
function router(options: { fallback?: TurnRunner; lanes?: Iterable<string> } = {}): {
  warm: WarmLanes;
  cold: TurnOptions[];
} {
  const cold: TurnOptions[] = [];
  const fallback: TurnRunner =
    options.fallback ??
    (async (_prompt, turnOptions) => {
      cold.push(turnOptions);
      return coldResult();
    });
  const warm = new WarmLanes({
    fallback,
    ...(options.lanes ? { lanes: options.lanes } : {}),
  });
  routers.push(warm);
  return { warm, cold };
}

function coldResult(): TurnResult {
  return {
    sessionId: "cold-session",
    text: "cold",
    spoken: "cold",
    costUsd: 0,
    numTurns: 1,
    contextTokens: 0,
    init: {
      kind: "init",
      sessionId: "cold-session",
      raw: {},
      model: "claude-haiku-4-5",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: [],
  };
}

describe("WarmLanes", () => {
  describe("which lanes are warm, and why exactly those", () => {
    it("should hold the Commander's lane warm, because that is where latency is felt", () => {
      expect([...WARM_LANES]).toEqual([LANES.commander]);
    });

    it("should keep the dream, extraction and digestion on the per-turn path", async () => {
      // Nobody is waiting on any of these, and isolation is worth more than the
      // seconds. The dream is also the most expensive thing Syl does, which is
      // exactly the reason people reach for a warm process — and the wrong one.
      const { warm, cold } = router();

      for (const lane of [LANES.consolidation, LANES.extraction, LANES.digestion]) {
        await warm.runner("hi", { lane });
      }

      expect(cold.map((options) => options.lane)).toEqual([
        LANES.consolidation,
        LANES.extraction,
        LANES.digestion,
      ]);
    });

    it("should route a turn that names NO lane to the per-turn path", async () => {
      // Absence must route cold. A reader turn sets no lane, and so does
      // anything else that forgot — the default has to be the one that costs
      // seconds rather than the one that shares a process.
      const { warm, cold } = router();

      await warm.runner("hi", {});

      expect(cold).toHaveLength(1);
      expect(warm.isWarm({})).toBe(false);
    });

    it("should route the Commander's lane to a persistent process", async () => {
      const f = persistentFake();
      const { warm, cold } = router();

      const first = await warm.runner("one", { lane: LANES.commander, claudeBin: f.bin });
      await warm.runner("two", {
        lane: LANES.commander,
        claudeBin: f.bin,
        resume: first.sessionId,
      });

      expect(cold).toHaveLength(0);
      // Two turns, one spawn. That is the whole bead.
      expect(f.invocations()).toHaveLength(1);
    });
  });

  describe("status — what the warm-lane precondition reads", () => {
    it("should report a warm lane cold before it has taken a turn", () => {
      const { warm } = router();

      expect(warm.status(LANES.commander)).toMatchObject({
        lane: LANES.commander,
        warm: false,
        turnsServed: 0,
      });
    });

    it("should report a lane that is not warm at all as undefined, not as cold", () => {
      // Two different answers to two different questions. "This lane never runs
      // warm" is a fact about the split; "this lane is warm but not started" is
      // a fact about a process. Collapsing them would have the face refuse the
      // dream lane for the wrong reason.
      const { warm } = router();

      expect(warm.status(LANES.consolidation)).toBeUndefined();
    });

    it("should report the session id and credential source once the lane is warm", async () => {
      const f = persistentFake();
      const { warm } = router();

      const first = await warm.runner("one", { lane: LANES.commander, claudeBin: f.bin });

      expect(warm.status(LANES.commander)).toMatchObject({
        warm: true,
        sessionId: first.sessionId,
        apiKeySource: "none",
        turnsServed: 1,
      });
    });

    it("should list every warm lane's status", () => {
      const { warm } = router();

      expect(warm.statuses().map((status) => status.lane)).toEqual([LANES.commander]);
    });
  });

  describe("lifecycle", () => {
    it("should leave no warm process behind after close", async () => {
      const f = persistentFake();
      const { warm } = router();
      await warm.runner("one", { lane: LANES.commander, claudeBin: f.bin });
      const pid = warm.status(LANES.commander)?.pid;
      expect(pid).toBeGreaterThan(0);

      await warm.close();

      expect(alive(pid)).toBe(false);
    });

    it("should fall back to the per-turn path once closed, rather than refusing a turn", async () => {
      // Shutdown must not turn into an outage. A turn arriving during teardown
      // is answered the slow way; a turn arriving during teardown that throws
      // is a failed reply to the Commander.
      const f = persistentFake();
      const { warm, cold } = router();
      await warm.runner("one", { lane: LANES.commander, claudeBin: f.bin });
      await warm.close();

      await warm.runner("two", { lane: LANES.commander, claudeBin: f.bin });

      expect(cold).toHaveLength(1);
    });
  });

  describe("the reader can never be warm, and it is held structurally", () => {
    // Behavioural proof is not enough here. "The router declines to warm the
    // reader" is a fact about today's routing table; what has to stay true is
    // that there is no PATH by which a reader turn could reach a persistent
    // process. Same argument, and same technique, as
    // `reader-containment.test.ts`.

    const READER = resolve(BACKEND_SRC, "harness/reader.ts");
    const PERSISTENT = resolve(BACKEND_SRC, "harness/persistent-session.ts");
    const WARM = resolve(BACKEND_SRC, "harness/warm-lanes.ts");

    it("should keep the persistent session outside the reader's import closure", () => {
      const reachable = importClosure(READER);

      expect(reachable).not.toContain(PERSISTENT);
      expect(reachable).not.toContain(WARM);
    });

    it("should give the reader no injectable runner to substitute one into", () => {
      // The reader calls `runTurn` by name. There is no seam, which is the
      // point: a quarantine you have to remember to switch on is not a
      // quarantine, and neither is one a caller can switch off.
      const code = codeOf(READER);

      expect(code).toContain("runTurn(prompt, turnOptions)");
      expect(code).not.toMatch(/(?<![A-Za-z0-9_])runner(?![A-Za-z0-9_])/u);
    });

    it("should route a reader-shaped turn cold even if one were driven through the router", async () => {
      // Defence in depth: the structural guards above are the real ones, but if
      // a future wiring mistake handed the router to the reader anyway, the
      // reader sets no lane — so it still spawns and dies.
      const { warm, cold } = router();

      await warm.runner("read this", { tools: "", strictMcpConfig: true });

      expect(cold).toHaveLength(1);
      expect(cold[0]?.tools).toBe("");
    });
  });
});

/** Is this pid still running? `signal 0` tests for existence without signalling. */
function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
