import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import { bootstrap, sylHome, type Bootstrapped } from "../../src/index.js";
import { IN_MEMORY, INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { turnFilePath } from "../../src/tools/config.js";
import {
  flagValue,
  loadFixture,
  makeFakeClaude,
  type FakeClaude,
  type FakeClaudeInvocation,
  type FakeClaudeTurn,
} from "../helpers/fake-claude.js";
import { codeOf } from "../helpers/source-scan.js";
import { silentRunner, testConfig } from "../helpers/service.js";
import { BACKEND_SRC } from "../helpers/sql-tables.js";

/**
 * `syl-u72z` — **the wiring**, which is the whole of the change and none of the
 * risk.
 *
 * `syl-per1` built `WarmLanes` and deliberately did not construct it, on the
 * sound grounds that putting the Commander's live conversation onto a
 * long-lived subprocess deserves its own commit. That left the third instance
 * of this epic's recurring defect: a component that is complete, unit-tested,
 * and reached by nothing. `face.start()`/`face.stop()` was the second.
 *
 * So this file does not test `WarmLanes` — `warm-lanes.test.ts` does — it tests
 * that the **service** uses it, and that the five things which were true of the
 * per-turn path are still true now that a process outlives a turn:
 *
 *  1. both runner wrappers still apply, to warm turns exactly as to cold ones;
 *  2. shutdown actually ends the process, on the path a shutdown really takes;
 *  3. the per-turn deadline still fires, so a wedged process cannot wedge the lane;
 *  4. `apiKeySource === "none"` is asserted PER TURN, not once at spawn;
 *  5. the reader lane stays COLD.
 *
 * Every turn here spawns a real fake `claude`, because the questions are about
 * processes and a stubbed runner cannot answer any of them.
 */

const PONG = loadFixture("turn-pong");

/** The same capture with the rail moved off the subscription. */
const PONG_ON_A_KEY = PONG.map((line) =>
  line.includes('"subtype":"init"')
    ? line.replace(/"apiKeySource":"[^"]*"/u, '"apiKeySource":"ANTHROPIC_API_KEY"')
    : line,
);

interface Booted {
  readonly built: Bootstrapped;
  readonly fake: FakeClaude;
  readonly home: string;
}

const booted: Booted[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const one of booted.splice(0)) {
    await one.built.warmLanes.close();
    one.built.database.close();
    one.fake.cleanup();
  }
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/**
 * Stop the broker one step past the gates, without touching a network.
 *
 * `startSession` STARTS the warm-up, then runs the cold gate, the ceiling and
 * the avatar check — and only after all three does it construct a
 * `RunwayClient` and make an HTTP call. An empty avatar id is therefore a probe
 * that reaches exactly as far as the gates and no further: a suite must never
 * depend on whether the machine running it has `RUNWAYML_API_SECRET` set.
 *
 * The warm-up is no longer awaited in front of them, so a test that wants the
 * turn's OUTCOME has to wait for it — see `vi.waitFor` below.
 */
function stopAtTheAvatar(): void {
  vi.stubEnv("SYL_FACE_AVATAR_ID", "");
}

const NO_AVATAR = /No avatar is configured/u;

/**
 * A real bootstrap over a real store, answering through a real fake `claude`.
 *
 * **No `runner` override**, which is the point: that seam is what every other
 * suite uses, and it routes past the warm lane entirely. A test that took it
 * could not see the wiring it is here to check.
 */
function boot(turns: readonly FakeClaudeTurn[] = [{ lines: PONG }]): Booted {
  const dir = mkdtempSync(join(tmpdir(), "syl-warm-wiring-"));
  homes.push(dir);
  const fake = makeFakeClaude({ turns });
  const config = testConfig({
    databasePath: join(dir, "syl.db"),
    autoMemoryDirectory: join(dir, "memory"),
    attachmentDir: join(dir, "attachments"),
  });
  const built = bootstrap(config, {
    turn: { claudeBin: fake.bin, timeoutMs: 5_000 },
    soul: "You are Syl, under test.",
  });
  const one: Booted = { built, fake, home: sylHome(config) as string };
  booted.push(one);
  return one;
}

/** Say something to her, and wait for the turn to settle. */
async function sayToHer(one: Booted, text: string): Promise<void> {
  const chat = one.built.deps.chat;
  chat.accept(chat.append({ conversationId: INTERACTIVE_CONVERSATION_ID, role: "user", text }));
  await chat.idle();
}

/**
 * The spawns that are HIS CONVERSATION, named rather than counted.
 *
 * `--permission-mode bypassPermissions` is the commander lane opting in, and it
 * is the one thing `runReaderTurn` structurally cannot carry — so this filter is
 * also what makes the reader visible as everything it excludes.
 */
function hisSpawns(fake: FakeClaude): FakeClaudeInvocation[] {
  return fake
    .invocations()
    .filter((spawn) => flagValue(spawn.argv, "--permission-mode") === "bypassPermissions");
}

/** Every spawn that is not his conversation. The reader is in here. */
function otherSpawns(fake: FakeClaude): FakeClaudeInvocation[] {
  return fake
    .invocations()
    .filter((spawn) => flagValue(spawn.argv, "--permission-mode") !== "bypassPermissions");
}

describe("the Commander's lane is wired to the warm path", () => {
  it("should serve his second turn from the process his first spawned", async () => {
    // The measurement this whole change exists for: a follow-up turn costs
    // ~1.4s against 5.5-9.7s for a fresh spawn, and Runway's tool ceiling is
    // 8s hard. One process is not an optimisation here, it is the difference
    // between her answering and her being silent.
    const one = boot();

    await sayToHer(one, "Bill me right.");
    await sayToHer(one, "Second thing.");

    expect(hisSpawns(one.fake)).toHaveLength(1);
    // Both frames went down the one still-open stdin.
    const frames = (hisSpawns(one.fake)[0]?.stdin ?? "").trimEnd().split("\n");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain("Bill me right.");
    expect(frames[1]).toContain("Second thing.");
  });

  it("should report the lane warm once it has taken a turn, which is what the face reads", async () => {
    const one = boot();
    expect(one.built.warmLanes.status(LANES.commander)?.warm).toBe(false);

    await sayToHer(one, "Hello.");

    const status = one.built.warmLanes.status(LANES.commander);
    expect(status?.warm).toBe(true);
    expect(status?.turnsServed).toBe(1);
    expect(status?.apiKeySource).toBe("none");
  });
});

describe("1. the wrappers still apply, to warm turns exactly as to cold ones", () => {
  it("should still write down what he said when the turn ran warm", async () => {
    // `recordHisWords` is the only evidence `harness/urgency.ts` has that a
    // phrase she quotes is a phrase he wrote — the single structural protection
    // on his sleep. A wrapper that applied to cold turns and not warm ones
    // would repeal it silently, with no line of code mentioning quiet hours.
    const one = boot();

    await sayToHer(one, "Remind me about the roof.");

    expect(readFileSync(turnFilePath(one.home), "utf8")).toBe("Remind me about the roof.");
  });

  it("should keep EVERY wrapper outside the router, so none can hold on half the turns", () => {
    // Asserted on the composition rather than on a behaviour, because the
    // failure it guards is an ORDERING one: `WarmLanes` takes a `fallback`
    // precisely so the wrappers sit outside it and cover warm and cold alike.
    // Wrap the fallback instead and every warm turn slips past them, which no
    // single-turn test can see — the wrapped path still works perfectly.
    //
    // `recordLaneContext` joined the stack for `syl-chzl.4.4` and belongs to
    // the same argument, sharpened: the Commander's lane is the WARM one and
    // the only thread ever large enough for compaction to matter. Measured
    // round the fallback, the one lane the measurement exists for would be the
    // one lane never measured — and `whyNotCompact` refuses on an unknown size,
    // so the nightly sweep would simply never happen, silently, with nothing
    // red. That is the worst version of this failure yet: not a guarantee
    // holding on half the turns, but a guarantee that never fires at all.
    const source = codeOf(resolve(BACKEND_SRC, "index.ts")).replace(/\s+/gu, "");

    expect(source).toContain(
      "runner:recordLaneContext(laneSizes)(withMemoryIndex(recordHisWords(options.runner??warmLanes.runner)))",
    );
  });

  it("should never wrap the router's FALLBACK, which is where each of these would hide", () => {
    // The mistake the composition above prevents, stated as its own check so
    // that a future edit which moves a wrapper inward goes red for the right
    // reason rather than merely failing a string match.
    const source = codeOf(resolve(BACKEND_SRC, "index.ts")).replace(/\s+/gu, "");

    for (const wrapper of ["recordHisWords", "withMemoryIndex", "recordLaneContext"]) {
      expect(source).not.toContain(`fallback:${wrapper}`);
    }
  });
});

describe("2. shutdown ends the process — a resident claude must not outlive the service", () => {
  it("should leave no warm claude behind when the service closes", async () => {
    const one = boot();
    await sayToHer(one, "Hello.");

    const pid = one.built.warmLanes.status(LANES.commander)?.pid;
    expect(pid).toBeDefined();
    expect(() => process.kill(pid as number, 0)).not.toThrow();

    await one.built.warmLanes.close();

    expect(() => process.kill(pid as number, 0)).toThrow();
  });

  it("should be reached by the real shutdown path, not merely be callable", () => {
    // The bead's own warning, and this epic's recurring defect: `WarmLanes`
    // exposes `close()` and `face` exposed `start()`/`stop()`, and for weeks
    // nothing called either. A method nobody invokes is not a lifecycle.
    const source = codeOf(resolve(BACKEND_SRC, "index.ts")).replace(/\s+/gu, "");

    expect(source).toContain("awaitwarmLanes.close()");
  });
});

describe("3. the per-turn deadline still fires, so a wedged process cannot wedge the lane", () => {
  it("should kill a warm turn that produces nothing and let the next one through", async () => {
    // Alive, holding its pipes, producing nothing — indistinguishable from busy
    // except by the clock. On a per-turn process the death of the process ended
    // it; on a warm one only the deadline does.
    const one = boot([{ lines: [], hang: true }]);
    const chat = one.built.deps.chat;

    // The timeout is 5s from `boot`, so this is bounded; a wedged lane that was
    // never killed would sit here for the ten-minute default instead.
    one.built.deps.chat.accept(
      chat.append({ conversationId: INTERACTIVE_CONVERSATION_ID, role: "user", text: "Anything?" }),
    );
    await chat.idle();

    const page = one.built.deps.messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
    const assistant = page.items.filter((message) => message.role === "assistant");
    // A failed turn is a MESSAGE, never silence — `conversation-service.ts`.
    expect(assistant.length).toBeGreaterThan(0);
    // And the lane is free again, rather than held by a process nobody killed.
    expect(one.built.warmLanes.status(LANES.commander)?.busy).toBe(false);
  }, 20_000);
});

describe("4. apiKeySource is asserted PER TURN, not once at spawn", () => {
  it("should fail the turn that discovers a key, not bill quietly for hours", async () => {
    // The one worry a long-lived process genuinely introduces against
    // non-negotiable constraint 3. The CLI re-emits `init` every turn, so the
    // guard can run on every turn — and this proves it does rather than
    // trusting the handshake it did minutes ago.
    const one = boot([{ lines: PONG }, { lines: PONG_ON_A_KEY }]);

    await sayToHer(one, "First.");
    expect(one.built.warmLanes.status(LANES.commander)?.apiKeySource).toBe("none");

    await sayToHer(one, "Second.");

    const page = one.built.deps.messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
    const said = page.items.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
    expect(said).toMatch(/could not|trouble|failed|error/iu);
    // And the process that resolved the wrong credential is gone, rather than
    // left serving the next turn.
    expect(one.built.warmLanes.status(LANES.commander)?.warm).toBe(false);
  }, 20_000);
});

/**
 * `syl-chzl.2.3` (T007), and the third "built but never wired" this change went
 * looking for.
 *
 * `FaceRuntimeOptions` has declared `isLaneWarm` and `laneRail` since
 * `syl-chzl.2.2`, each with a doc comment naming `WarmLanes.status(commander)`
 * as its value — and `index.ts` passed neither, because there was no
 * `WarmLanes` to ask. So in the live service the cold-lane refusal never fired
 * and the per-turn rail check on a face turn never ran. They arrive here, and
 * they had to arrive WITH the warmer: the predicate alone would refuse every
 * face, since the lane is cold until something warms it.
 */
describe("warming the lane at the moment his face opens", () => {
  it("should start a warming turn on a cold lane and let the open past without waiting for it", async () => {
    // **The twenty seconds.** Two real opens on 2026-08-23 logged
    // `lane.warm.taken` at 20,559ms and 22,369ms with the Runway create
    // following half a second later, because the open AWAITED the turn. The
    // turn cannot be made cheap — a lane goes warm only by taking one, and
    // what makes it slow is the cold context ingestion that makes it warm
    // afterwards — so it is started here and judged after READY instead.
    stopAtTheAvatar();
    const one = boot();
    expect(one.built.warmLanes.status(LANES.commander)?.warm).toBe(false);

    // Past the cold gate, stopped at the avatar — so the gate did not refuse a
    // lane that something was already being done about.
    await expect(one.built.deps.face.broker.startSession()).rejects.toThrow(NO_AVATAR);

    // And the turn is real rather than merely started: it lands, and the lane
    // is warm — just not on the open's critical path.
    await vi.waitFor(
      () => {
        expect(one.built.warmLanes.status(LANES.commander)?.warm).toBe(true);
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(hisSpawns(one.fake)).toHaveLength(1);
  }, 20_000);

  it("should not refuse the open early merely because the warming turn died", async () => {
    // The gate is not weakened, it is asked later — after READY, when the turn
    // has had the create and the whole poll to finish in. Refusing here would
    // put us straight back to a serial warm, because "has it finished yet" at
    // this instant is always no.
    //
    // The refusal ITSELF is asserted where it can be reached without a network:
    // `face-session-broker.test.ts`, "should still refuse when the warm-up
    // finished and the lane is cold anyway", which also pins that the row we
    // already paid Runway for is settled rather than left looking live.
    stopAtTheAvatar();
    const one = boot([{ lines: [], die: 1 }]);

    await expect(one.built.deps.face.broker.startSession()).rejects.toThrow(NO_AVATAR);

    await vi.waitFor(
      () => {
        expect(hisSpawns(one.fake)).toHaveLength(1);
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(one.built.warmLanes.status(LANES.commander)?.warm).toBe(false);
  }, 20_000);

  it("should leave no trace of the warming turn anywhere he can see", async () => {
    // Three constraints from the bead, asserted together because they are one
    // idea: a turn taken to keep a pipe warm is not a thought she had.
    stopAtTheAvatar();
    const one = boot();

    await expect(one.built.deps.face.broker.startSession()).rejects.toThrow(NO_AVATAR);

    // Not a message — nothing was appended, so nothing was pushed to his phone
    // and nothing appears in the app.
    expect(one.built.deps.messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 50 }).items).toEqual(
      [],
    );
    // Not a run — the allowance bounding how often she may speak is counted
    // over runs of the heartbeat job, and a keep-warm must not spend from it.
    expect(one.built.database.handle.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({
      n: 0,
    });
    // And not his words. `recordHisWords` is what buys a quiet-hours bypass;
    // a warmer that claimed it could wake his house at three with its own
    // prompt.
    expect(() => readFileSync(turnFilePath(one.home), "utf8")).toThrow();
  }, 20_000);

  it("should not gate the face on warmth at all when a caller supplied its own runner", () => {
    // There is then no warm process for anything to be warm ABOUT, so "no" is
    // not the honest answer — the question does not apply. Answering "no" would
    // refuse every face in every suite that injects a runner, which is most of
    // them.
    stopAtTheAvatar();
    const built = bootstrap(testConfig({ databasePath: IN_MEMORY }), { runner: silentRunner });

    try {
      return expect(built.deps.face.broker.startSession()).rejects.toThrow(NO_AVATAR);
    } finally {
      built.database.close();
    }
  });
});

describe("5. the reader lane stays COLD", () => {
  it("should spawn the reader its own process, never the Commander's warm one", async () => {
    // `runReaderTurn`'s security property IS the process: fresh, never resumed,
    // tool-less, auto-memory off. A warm reader is a quarantine with a door in
    // it — one injected article would reach every later read down the pipe.
    // Held twice: `reader.ts` imports `runTurn` directly, and the router keys on
    // a lane a reader turn never sets. This is that, after the wiring.
    const one = boot();

    await sayToHer(one, "My daughter Grace starts school in September.");

    const readers = otherSpawns(one.fake);
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      // Its own pid, not his.
      expect(reader.pid).not.toBe(hisSpawns(one.fake)[0]?.pid);
      // No tools, and one frame only — a session that answers once and dies.
      expect(flagValue(reader.argv, "--tools")).toBe("");
      expect(reader.argv).not.toContain("--resume");
    }
  }, 20_000);
});
