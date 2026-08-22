import { afterEach, describe, expect, it } from "vitest";

import {
  ConcurrentTurnError,
  PersistentSession,
  SessionDiedError,
} from "../../src/harness/persistent-session.js";
import { TurnTimeoutError, type TurnOptions } from "../../src/harness/session.js";
import type { SylEvent } from "../../src/harness/protocol.js";
import {
  flagValue,
  loadFixture,
  makeFakeClaude,
  type FakeClaude,
  type FakeClaudeConfig,
} from "../helpers/fake-claude.js";

/**
 * `syl-per1` — **one process, many turns**, for the lane where latency is felt.
 *
 * ## The measurement this exists for
 *
 * Re-measured on CLI 2.1.226 and again here on 2026-08-22: a `result` arrives
 * with **stdin still open**, and further frames can be sent down the same
 * process against the same session id. The per-turn path pays a fresh spawn
 * every time; the warm path does not.
 *
 * ## The three costs, which the bead says must be DESIGNED and not stumbled into
 *
 * A persistent process reintroduces exactly what one-process-per-turn was
 * praised for avoiding. Each has its own `describe` below, and each of those is
 * the proof rather than the intention:
 *
 * 1. **A process to supervise** — who notices it died, what restarts it, and
 *    what becomes of the turn that was in flight.
 * 2. **A crash costing more than one turn** — a lost process must not be a lost
 *    conversation.
 * 3. **Backpressure** — turns arrive while one is running.
 *
 * ## What was measured today, because it decided two design questions
 *
 * - **The CLI emits no `init` frame until a user frame arrives.** Held stdin
 *   idle for 30s against a spawned process: nothing. So there is no free
 *   pre-warm — a lane becomes warm by *taking a turn*, and `warm` in
 *   {@link PersistentSession.status} is therefore derived from having seen an
 *   init rather than from having a pid.
 * - **The CLI emits a FRESH init frame per turn**, 4-6ms after each frame,
 *   carrying `apiKeySource` every time. That is why the subscription-rails
 *   guard is a per-turn check here and not a start-up one: a long-lived process
 *   asserting once and trusting for hours was the risk, and the wire format
 *   turns out to remove it.
 */

const PONG = loadFixture("turn-pong");

/** The `turn-pong` capture, split into the two halves a warm turn needs. */
const CAPTURED_INIT = PONG.find((line) => line.includes('"subtype":"init"'));
const AFTER_INIT = PONG.filter((line) => !line.includes('"subtype":"init"'));

if (CAPTURED_INIT === undefined) throw new Error("turn-pong fixture has no init frame");

const INIT_LINE: string = CAPTURED_INIT;

/** One complete turn as the persistent CLI emits it: a fresh init, then the rest. */
function turnLines(): string[] {
  return [INIT_LINE, ...AFTER_INIT];
}

const fakes: FakeClaude[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
});

function fake(config: FakeClaudeConfig): FakeClaude {
  const created = makeFakeClaude(config);
  fakes.push(created);
  return created;
}

/** A fake that answers every frame with a complete turn, forever. */
function persistent(config: FakeClaudeConfig = {}): FakeClaude {
  return fake({ turns: [{ lines: turnLines() }], ...config });
}

const sessions: PersistentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

function session(lane = "commander", options: { idleMs?: number } = {}): PersistentSession {
  const created = new PersistentSession({ lane, ...options });
  sessions.push(created);
  return created;
}

/** Every test overrides the binary; nothing here may reach the real CLI. */
function options(f: FakeClaude, extra: TurnOptions = {}): TurnOptions {
  return { claudeBin: f.bin, lane: "commander", ...extra };
}

describe("PersistentSession", () => {
  describe("one process, many turns", () => {
    it("should serve a second turn from the same process it spawned for the first", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f));
      const second = await warm.run("two", options(f, { resume: first.sessionId }));

      // ONE spawn, TWO turns. This is the whole point of the bead: the second
      // turn pays no process startup.
      expect(f.invocations()).toHaveLength(1);
      expect(second.text).toBe(first.text);
      expect(warm.status().turnsServed).toBe(2);
    });

    it("should keep the same session id across turns on one process", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f));
      const second = await warm.run("two", options(f, { resume: first.sessionId }));

      expect(second.sessionId).toBe(first.sessionId);
      // And the id the caller was handed is the one the process was spawned
      // under — not one learned from the transcript after the fact.
      expect(flagValue(f.invocations()[0]?.argv ?? [], "--session-id")).toBe(first.sessionId);
    });

    it("should send each turn as its own user frame down the still-open stdin", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("line one\nline two", options(f));
      await warm.run("second prompt", options(f, { resume: first.sessionId }));

      const frames = (f.invocation()?.stdin ?? "").trimEnd().split("\n");
      expect(frames).toHaveLength(2);
      // JSON.stringify escapes the embedded newline, so a multi-line prompt is
      // still one wire line. Two frames means two turns, not one malformed one.
      expect(JSON.parse(frames[0] ?? "null")).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "line one\nline two" }] },
      });
      expect(JSON.parse(frames[1] ?? "null")).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "second prompt" }] },
      });
    });

    it("should give each turn only its own events, not the whole process transcript", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f));
      const second = await warm.run("two", options(f, { resume: first.sessionId }));

      // A warm process accumulates; a turn must not. Left unpartitioned, turn
      // five would relay turn one's prose as part of its answer.
      expect(second.events).toHaveLength(first.events.length);
      expect(second.events.filter((event) => event.kind === "result")).toHaveLength(1);
    });

    it("should surface this turn's events to onEvent in arrival order", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f));
      const seen: SylEvent["kind"][] = [];
      const second = await warm.run(
        "two",
        options(f, { resume: first.sessionId, onEvent: (event) => seen.push(event.kind) }),
      );

      expect(seen).toContain("init");
      expect(seen.at(-1)).toBe("result");
      expect(seen).toEqual(second.events.map((event) => event.kind));
    });

    it("should announce the session id before the spawn, so a crash cannot strand a conversation", async () => {
      const f = persistent();
      const warm = session();
      const announced: string[] = [];
      let announcedBeforeSpawn = false;

      await warm.run(
        "one",
        options(f, {
          onSessionId: (id) => {
            announcedBeforeSpawn = f.invocations().length === 0;
            announced.push(id);
          },
        }),
      );

      expect(announcedBeforeSpawn).toBe(true);
      expect(announced).toHaveLength(1);
    });

    it("should announce the live session id on a warm turn too, so the store stays correct", async () => {
      const f = persistent();
      const warm = session();
      const first = await warm.run("one", options(f));
      const announced: string[] = [];

      await warm.run(
        "two",
        options(f, { resume: first.sessionId, onSessionId: (id) => announced.push(id) }),
      );

      expect(announced).toEqual([first.sessionId]);
    });
  });

  describe("billing safety — the guard a long-lived process makes MORE important", () => {
    it("should strip ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the child", async () => {
      // Non-negotiable constraint 3 (adj-t64m9). The per-turn path strips it
      // every few seconds; this one strips it once and lives for hours.
      const f = persistent();
      const warm = session();
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-reach-the-child";
      process.env["ANTHROPIC_AUTH_TOKEN"] = "should-not-reach-the-child";

      try {
        await warm.run("one", options(f));
        expect(f.invocation()?.sawApiKey).toBe(false);
        expect(f.invocation()?.sawAuthToken).toBe(false);
      } finally {
        delete process.env["ANTHROPIC_API_KEY"];
        delete process.env["ANTHROPIC_AUTH_TOKEN"];
      }
    });

    it("should re-assert apiKeySource on EVERY turn, not once at spawn", async () => {
      // The CLI emits a fresh init per turn (measured 2026-08-22), so this is a
      // check against a new frame rather than against a remembered one. A
      // process that started clean and later resolved a key fails the turn that
      // discovers it, instead of billing quietly for hours.
      const clean = turnLines();
      const keyed = turnLines().map((line) =>
        line.replace('"apiKeySource":"none"', '"apiKeySource":"ANTHROPIC_API_KEY"'),
      );
      const f = persistent({ turns: [{ lines: clean }, { lines: keyed }] });
      const warm = session();

      const first = await warm.run("one", options(f));
      expect(first.init.apiKeySource).toBe("none");

      await expect(
        warm.run("two", options(f, { resume: first.sessionId })),
      ).rejects.toThrow(/subscription auth/i);
    });

    it("should destroy the process when a turn resolves the wrong credential", async () => {
      const keyed = turnLines().map((line) =>
        line.replace('"apiKeySource":"none"', '"apiKeySource":"ANTHROPIC_API_KEY"'),
      );
      const f = persistent({ turns: [{ lines: keyed }] });
      const warm = session();

      await expect(warm.run("one", options(f))).rejects.toThrow(/subscription auth/i);

      // Not left running: a process billing to the metered API must not be
      // available to serve the next turn.
      expect(warm.status().warm).toBe(false);
    });
  });

  describe("lanes — a persistent process must not blur them", () => {
    it("should refuse a turn belonging to a different lane", async () => {
      const f = persistent();
      const warm = session("commander");

      await expect(warm.run("one", options(f, { lane: "consolidation" }))).rejects.toThrow(
        /lane/i,
      );
      expect(f.invocations()).toHaveLength(0);
    });

    it("should refuse a turn that names no lane at all", async () => {
      const f = persistent();
      const warm = session("commander");

      await expect(warm.run("one", { claudeBin: f.bin })).rejects.toThrow(/lane/i);
    });
  });

  describe("cost 1 — a process to supervise", () => {
    it("should fail the in-flight turn when the process dies mid-turn, rather than hanging", async () => {
      const f = persistent({ turns: [{ lines: [INIT_LINE], die: 7 }] });
      const warm = session();

      await expect(warm.run("one", options(f, { timeoutMs: 30_000 }))).rejects.toThrow(
        SessionDiedError,
      );
    });

    it("should report the exit code on a mid-turn death, so the cause is legible", async () => {
      const f = persistent({ turns: [{ lines: [INIT_LINE], die: 7 }] });
      const warm = session();

      await expect(warm.run("one", options(f, { timeoutMs: 30_000 }))).rejects.toThrow(/7/);
    });

    it("should respawn transparently on the next turn after the process died", async () => {
      // Death BETWEEN turns is the case the user must never see: the next turn
      // notices, spawns again, and resumes the same conversation.
      const f = persistent({ turns: [{ lines: turnLines() }, { lines: [INIT_LINE], die: 1 }, { lines: turnLines() }] });
      const warm = session();

      const first = await warm.run("one", options(f));
      await expect(
        warm.run("two", options(f, { resume: first.sessionId, timeoutMs: 30_000 })),
      ).rejects.toThrow(SessionDiedError);

      const third = await warm.run("three", options(f, { resume: first.sessionId }));

      expect(f.invocations()).toHaveLength(2);
      expect(third.text).toBe(first.text);
    });

    it("should report itself cold once the process is gone", async () => {
      const f = persistent({ turns: [{ lines: turnLines() }, { lines: [INIT_LINE], die: 1 }] });
      const warm = session();

      const first = await warm.run("one", options(f));
      expect(warm.status().warm).toBe(true);

      await expect(
        warm.run("two", options(f, { resume: first.sessionId, timeoutMs: 30_000 })),
      ).rejects.toThrow(SessionDiedError);
      expect(warm.status().warm).toBe(false);
      expect(warm.status().pid).toBeUndefined();
    });

    it("should kill a wedged process and throw TurnTimeoutError, so it cannot wedge the lane forever", async () => {
      // A wedged persistent process is indistinguishable from a busy one except
      // by the clock — the watchdog only knows about the SERVICE. So the turn's
      // own deadline is what tells them apart, and it takes the process with it:
      // a late result arriving during someone else's turn is worse than a
      // respawn.
      const f = persistent({ turns: [{ hang: true }] });
      const warm = session();

      await expect(warm.run("one", options(f, { timeoutMs: 300 }))).rejects.toThrow(
        TurnTimeoutError,
      );
      expect(warm.status().warm).toBe(false);
    });

    it("should serve the next turn from a fresh process after a wedged one was killed", async () => {
      const f = persistent({ turns: [{ hang: true }] });
      const warm = session();
      await expect(warm.run("one", options(f, { timeoutMs: 300 }))).rejects.toThrow(
        TurnTimeoutError,
      );

      const healthy = persistent();
      const after = await warm.run("two", options(healthy));

      expect(after.text).toBe("PONG");
    });

    it("should reap a process that has been idle too long", async () => {
      const f = persistent();
      const warm = session("commander", { idleMs: 120 });

      await warm.run("one", options(f));
      expect(warm.status().warm).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(warm.status().warm).toBe(false);
    });

    it("should not reap a process that is mid-turn, however long the turn takes", async () => {
      // The reaper measures idleness, not age. A turn doing real work for
      // minutes is not idle, and killing it would be the reaper inventing the
      // very failure it exists to prevent.
      const f = persistent({ turns: [{ lines: turnLines(), delayMs: 400 }] });
      const warm = session("commander", { idleMs: 100 });

      const result = await warm.run("one", options(f, { timeoutMs: 30_000 }));

      expect(result.text).toBe("PONG");
    });

    it("should leave no child behind after close", async () => {
      const f = persistent();
      const warm = session();
      await warm.run("one", options(f));
      const pid = warm.status().pid;
      expect(pid).toBeDefined();

      await warm.close();

      expect(warm.status().warm).toBe(false);
      expect(alive(pid)).toBe(false);
    });

    it("should refuse a turn after close rather than silently spawning again", async () => {
      const f = persistent();
      const warm = session();
      await warm.close();

      await expect(warm.run("one", options(f))).rejects.toThrow(/closed/i);
    });
  });

  describe("cost 2 — a crash must not cost the conversation", () => {
    it("should resume the stored conversation when it respawns", async () => {
      const f = persistent({ turns: [{ lines: turnLines() }, { lines: [INIT_LINE], die: 1 }, { lines: turnLines() }] });
      const warm = session();

      const first = await warm.run("one", options(f));
      await expect(
        warm.run("two", options(f, { resume: first.sessionId, timeoutMs: 30_000 })),
      ).rejects.toThrow(SessionDiedError);
      await warm.run("three", options(f, { resume: first.sessionId }));

      // The second spawn carries --resume, not a new --session-id. That is the
      // whole difference between losing a request and losing a conversation.
      const respawn = f.invocations()[1];
      expect(flagValue(respawn?.argv ?? [], "--resume")).toBe(first.sessionId);
      expect(flagValue(respawn?.argv ?? [], "--session-id")).toBeUndefined();
    });

    it("should surface a resume failure in the shape SylAgent's stale-session recovery recognises", async () => {
      // Reuse that mechanism, do not invent a second one. `SylAgent` matches on
      // the message, so a warm process that cannot resume must fail the same
      // way the per-turn path does.
      // Not a persistent fake: a CLI that cannot resume exits before it reads
      // stdin, which is the whole shape of the failure.
      const f = fake({
        ignoreStdin: true,
        exitCode: 1,
        stderr: "No conversation found with session ID: dead-session",
      });
      const warm = session();

      await expect(
        warm.run("one", options(f, { resume: "dead-session", timeoutMs: 30_000 })),
      ).rejects.toThrow(/no conversation found/i);
    });

    it("should start a fresh process when the caller asks for a conversation this one is not on", async () => {
      // What `SylAgent.reset()` looks like from here: the stored id was
      // unusable, so the next turn arrives with no `resume` at all. Feeding it
      // to the existing process would silently continue the conversation the
      // caller just threw away.
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f));
      await warm.run("two", options(f));

      expect(f.invocations()).toHaveLength(2);
      expect(flagValue(f.invocations()[1]?.argv ?? [], "--session-id")).not.toBe(first.sessionId);
    });
  });

  describe("cost 3 — backpressure, without a second queue", () => {
    it("should refuse a concurrent turn rather than interleaving two on one process", async () => {
      // NOT a queue. `SylAgent` already serialises per lane and
      // `ConversationService` per conversation; a queue here could disagree
      // with those, and two locks over one session id is the bug agent.ts warns
      // about wearing a hat. This is the assertion that they are doing their
      // job — an interleave becomes loud and immediate instead of a corrupted
      // transcript.
      const f = persistent({ turns: [{ lines: turnLines(), delayMs: 300 }] });
      const warm = session();

      const first = warm.run("one", options(f, { timeoutMs: 30_000 }));
      await expect(warm.run("two", options(f, { timeoutMs: 30_000 }))).rejects.toThrow(
        ConcurrentTurnError,
      );

      await first;
    });

    it("should not let a refused concurrent turn put a frame on the wire", async () => {
      const f = persistent({ turns: [{ lines: turnLines(), delayMs: 300 }] });
      const warm = session();

      const first = warm.run("one", options(f, { timeoutMs: 30_000 }));
      await expect(warm.run("two", options(f, { timeoutMs: 30_000 }))).rejects.toThrow(
        ConcurrentTurnError,
      );
      await first;

      // Exactly one frame reached the process. An interleaved second frame is
      // what would corrupt the transcript.
      expect((f.invocation()?.stdin ?? "").trimEnd().split("\n")).toHaveLength(1);
    });

    it("should report busy while a turn is running and idle once it settles", async () => {
      const f = persistent({ turns: [{ lines: turnLines(), delayMs: 200 }] });
      const warm = session();

      const running = warm.run("one", options(f, { timeoutMs: 30_000 }));
      expect(warm.status().busy).toBe(true);
      await running;
      expect(warm.status().busy).toBe(false);
    });

    it("should release the lane after a failed turn, not wedge it", async () => {
      const f = persistent({ turns: [{ lines: [INIT_LINE], die: 3 }] });
      const warm = session();

      await expect(warm.run("one", options(f, { timeoutMs: 30_000 }))).rejects.toThrow(
        SessionDiedError,
      );

      expect(warm.status().busy).toBe(false);
    });
  });

  describe("the spawn fingerprint — a warm process cannot serve a shape it was not spawned for", () => {
    it("should respawn when the system prompt changes, since a live process cannot be re-flagged", async () => {
      // `SylAgent` composes the system prompt fresh every turn, and the nightly
      // consolidation rewrites the memory projection inside it. A warm process
      // holds whatever it was spawned with, so reusing it would serve
      // yesterday's identity under today's flags — silently, with nothing to
      // fail.
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f, { systemPrompt: "you are Syl" }));
      await warm.run(
        "two",
        options(f, { resume: first.sessionId, systemPrompt: "you are Syl. He is at the dentist." }),
      );

      expect(f.invocations()).toHaveLength(2);
      expect(flagValue(f.invocations()[1]?.argv ?? [], "--append-system-prompt")).toBe(
        "you are Syl. He is at the dentist.",
      );
      // Same conversation, new process: it resumes rather than starting over.
      expect(flagValue(f.invocations()[1]?.argv ?? [], "--resume")).toBe(first.sessionId);
    });

    it("should reuse the process when nothing about the turn's shape moved", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f, { systemPrompt: "you are Syl" }));
      await warm.run("two", options(f, { resume: first.sessionId, systemPrompt: "you are Syl" }));

      expect(f.invocations()).toHaveLength(1);
    });

    it("should respawn when the tool surface changes", async () => {
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f, { tools: "" }));
      await warm.run("two", options(f, { resume: first.sessionId, tools: "Read" }));

      expect(f.invocations()).toHaveLength(2);
      expect(flagValue(f.invocations()[1]?.argv ?? [], "--tools")).toBe("Read");
    });
  });

  describe("status — what the warm-lane precondition reads", () => {
    it("should report cold before any turn has been taken", () => {
      const warm = session();

      expect(warm.status()).toMatchObject({
        lane: "commander",
        warm: false,
        busy: false,
        turnsServed: 0,
      });
      expect(warm.status().sessionId).toBeUndefined();
      expect(warm.status().apiKeySource).toBeUndefined();
    });

    it("should report warm, the session id and the credential source after a turn", async () => {
      // `syl-chzl.2.2` refuses to open a face unless all three are right. A
      // spawned process is NOT enough — measured 2026-08-22, the CLI emits no
      // init until a frame arrives, so a lane becomes warm by taking a turn.
      const f = persistent();
      const warm = session();

      const first = await warm.run("one", options(f));

      expect(warm.status()).toMatchObject({
        lane: "commander",
        warm: true,
        busy: false,
        sessionId: first.sessionId,
        apiKeySource: "none",
        turnsServed: 1,
      });
      expect(warm.status().pid).toBeGreaterThan(0);
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
