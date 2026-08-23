import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mintAskSecret } from "../../src/face/ask-credential.js";
import {
  AskSylIngress,
  ASK_SYL_DEADLINE_MS,
  ASK_SYL_TOOL,
  ASK_SYL_TOOL_NAME,
  ASK_SYL_TIMEOUT_SECONDS,
  COLD_LANE_LINE,
  NOTHING_ASKED_LINE,
  STILL_THINKING_LINE,
  TOO_SLOW_LINE,
  TURN_FAILED_LINE,
  type FaceAnswerer,
} from "../../src/face/ask-syl.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import {
  RUNWAY_RPC_MAX_PARAMETERS,
  RUNWAY_RPC_MAX_TIMEOUT_SECONDS,
} from "../../src/face/runway-client.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * The ingress, and the eight-second ceiling that shapes all of it.
 *
 * Her warm turn is ~1,635ms; a cold spawn is ~7,450ms and the provider gives up
 * at 8 seconds. So the rules under test are: refuse a cold lane instantly
 * rather than gambling, bound the wait strictly inside the ceiling, and **never
 * return nothing** — every path here produces something she can say, because a
 * tool call that resolves to silence is a face that freezes mid-conversation.
 */
describe("AskSylIngress", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let now: number;
  const clock: Clock = () => now;

  let secret: string;

  beforeEach(() => {
    now = Date.parse("2026-08-21T12:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    sessions = new FaceSessionStore({ db: database.handle, clock });

    const minted = mintAskSecret();
    secret = minted.secret;
    sessions.open({
      id: "rts_1",
      avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
      credits: 2,
      dollars: 0.02,
      askSecretHash: minted.hash,
      askExpiresAt: now + 300_000,
    });
  });

  afterEach(() => {
    // Restored here rather than only in each test's `finally`: a test that
    // times out never reaches its own cleanup, and fake timers left installed
    // hang every test after it — which turns one red into five and hides which
    // one actually broke.
    vi.useRealTimers();
    database.close();
  });

  function ingress(
    overrides: Partial<ConstructorParameters<typeof AskSylIngress>[0]> = {},
  ): AskSylIngress {
    return new AskSylIngress({
      sessions,
      answer: () => Promise.resolve("Two things are due before lunch."),
      now: clock,
      log: () => undefined,
      ...overrides,
    });
  }

  const ask = (question = "What is on today?") => ({ sessionId: "rts_1", secret, question });

  describe("the tool declaration", () => {
    it("should declare exactly one tool named ask_syl", () => {
      expect(ASK_SYL_TOOL.name).toBe(ASK_SYL_TOOL_NAME);
      expect(ASK_SYL_TOOL.type).toBe("backend_rpc");
    });

    it("should stay inside the provider's limits, which it rejects a create for", () => {
      const tool = AskSylIngress.toolDefinition();

      expect(tool.timeoutSeconds).toBeLessThanOrEqual(RUNWAY_RPC_MAX_TIMEOUT_SECONDS);
      expect(tool.parameters.length).toBeLessThanOrEqual(RUNWAY_RPC_MAX_PARAMETERS);
      expect(ASK_SYL_TIMEOUT_SECONDS).toBe(8);
    });

    it("should keep our own deadline strictly inside the declared one", () => {
      // A handler that answers at 7.9s has done all the work and still produced
      // silence, because the provider stopped listening.
      expect(ASK_SYL_DEADLINE_MS).toBeLessThan(ASK_SYL_TIMEOUT_SECONDS * 1_000);
    });

    it("should forbid her face inventing anything about him", () => {
      // The durable half. Whatever else the description says about WHEN to
      // call, a face that makes something up about his life is the failure
      // that is hard to undo — she named it herself as her first hard rule.
      expect(ASK_SYL_TOOL.description).toMatch(/never invent/i);
    });

    it("should scope the call to LIVE things, not to every remark he makes", () => {
      // This assertion replaces one that required the phrase "never answer
      // from your own knowledge", and the replacement is the point rather
      // than a loosening.
      //
      // That wording was written before she had a knowledge base, when
      // forwarding everything was the only way she could be right. Once her
      // documents were attached it became the reason EVERY remark — including
      // a greeting — raced an 8-second ceiling against a turn measuring 3-7
      // seconds warm, so the Commander heard the timeout line whatever he
      // asked. A tool description is not documentation; it is the instruction
      // the model obeys, and it outranked her personality because it sits
      // nearer the decision.
      //
      // So the property now worth protecting is the opposite one: the
      // description must RESTRICT the call rather than demand it.
      expect(ASK_SYL_TOOL.description).toMatch(/only when/i);
      expect(ASK_SYL_TOOL.description).not.toMatch(/for every question/i);
    });
  });

  describe("answering", () => {
    it("should hand back what her turn said", async () => {
      const outcome = await ingress().ask(ask());

      expect(outcome).toEqual({ ok: true, say: "Two things are due before lunch." });
    });

    it("should pass the question through unchanged", async () => {
      const answer = vi.fn<FaceAnswerer>(() => Promise.resolve("Yes."));

      await ingress({ answer }).ask(ask("  Did the deploy go out?  "));

      expect(answer).toHaveBeenCalledWith({
        sessionId: "rts_1",
        question: "Did the deploy go out?",
      });
    });

    it("should mark the session as active, so the reaper does not cut her mid-answer", async () => {
      now += 60_000;

      await ingress().ask(ask());

      expect(sessions.get("rts_1")?.lastActivityAt).toBe("2026-08-21T12:01:00.000Z");
    });

    it("should mark it active BEFORE the turn runs, not after", async () => {
      // A six-second turn must not look idle for those six seconds.
      let activityDuringTurn: string | null = null;
      const answer: FaceAnswerer = () => {
        activityDuringTurn = sessions.get("rts_1")?.lastActivityAt ?? null;
        return Promise.resolve("Done.");
      };
      now += 60_000;

      await ingress({ answer }).ask(ask());

      expect(activityDuringTurn).toBe("2026-08-21T12:01:00.000Z");
    });
  });

  describe("authentication", () => {
    it("should refuse a call with the wrong credential", async () => {
      const outcome = await ingress().ask({
        sessionId: "rts_1",
        secret: mintAskSecret().secret,
        question: "What is on today?",
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.failure).toBe("unauthorised");
    });

    it("should refuse a call after the session has ended", async () => {
      sessions.settle({ id: "rts_1", ended: "closed", credits: 4, dollars: 0.04 });

      const outcome = await ingress().ask(ask());

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.failure).toBe("unauthorised");
    });

    it("should give an unauthorised caller nothing to say at all", async () => {
      const outcome = await ingress().ask({
        sessionId: "rts_1",
        secret: "junk",
        question: "What is on today?",
      });

      // Not even an apology. Somebody who has not proved they hold this
      // session's credential does not get to put words in her mouth.
      expect(outcome.ok === false && outcome.say).toBeUndefined();
    });

    it("should never run a turn for an unauthorised caller", async () => {
      const answer = vi.fn<FaceAnswerer>(() => Promise.resolve("Yes."));

      await ingress({ answer }).ask({ sessionId: "rts_1", secret: "junk", question: "Hello?" });

      expect(answer).not.toHaveBeenCalled();
    });

    it("should not mark an unknown session active", async () => {
      await ingress().ask({ sessionId: "rts_nobody", secret, question: "Hello?" });

      expect(sessions.get("rts_1")?.lastActivityAt).toBe("2026-08-21T12:00:00.000Z");
    });

    it("should log the internal reason while telling the caller nothing", async () => {
      const log = vi.fn();

      await ingress({ log }).ask({ sessionId: "rts_1", secret: "junk", question: "Hello?" });

      expect(log).toHaveBeenCalledWith(
        "face.ask.refused",
        expect.objectContaining({ reason: "malformed" }),
      );
    });
  });

  describe("a cold lane", () => {
    it("should refuse instantly rather than gambling ~7.5s against an 8s ceiling", async () => {
      const answer = vi.fn<FaceAnswerer>(() => Promise.resolve("Yes."));

      const outcome = await ingress({ answer, isLaneWarm: () => false }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "cold", say: COLD_LANE_LINE });
      expect(answer).not.toHaveBeenCalled();
    });

    it("should give her something sayable rather than a status code", async () => {
      expect(COLD_LANE_LINE).toMatch(/[.?!]$/);
      expect(COLD_LANE_LINE).not.toMatch(/error|failed|null|undefined/i);
    });

    it("should answer normally when the lane is warm", async () => {
      const outcome = await ingress({ isLaneWarm: () => true }).ask(ask());

      expect(outcome.ok).toBe(true);
    });

    it("should attempt the turn when no predicate was supplied", async () => {
      const answer = vi.fn<FaceAnswerer>(() => Promise.resolve("Yes."));

      await ingress({ answer }).ask(ask());

      expect(answer).toHaveBeenCalled();
    });
  });

  describe("a turn that overruns the ceiling", () => {
    it("should return something sayable rather than hanging", async () => {
      vi.useFakeTimers();
      try {
        // A turn that never settles at all — the worst case.
        const pending = ingress({ answer: () => new Promise<string>(() => undefined) }).ask(ask());

        await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);

        await expect(pending).resolves.toEqual({
          ok: false,
          failure: "slow",
          say: TOO_SLOW_LINE,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("should give up before the provider does", async () => {
      vi.useFakeTimers();
      try {
        let settled = false;
        const pending = ingress({ answer: () => new Promise<string>(() => undefined) })
          .ask(ask())
          .then((outcome) => {
            settled = true;
            return outcome;
          });

        await vi.advanceTimersByTimeAsync(ASK_SYL_TIMEOUT_SECONDS * 1_000);
        await pending;

        expect(settled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should let a turn that lands just inside the deadline through", async () => {
      vi.useFakeTimers();
      try {
        const answer: FaceAnswerer = () =>
          new Promise((resolve) => setTimeout(() => resolve("Just made it."), 1_635));

        const pending = ingress({ answer }).ask(ask());
        await vi.advanceTimersByTimeAsync(1_635);

        await expect(pending).resolves.toEqual({ ok: true, say: "Just made it." });
      } finally {
        vi.useRealTimers();
      }
    });

    it("should honour a deadline the caller chose", async () => {
      vi.useFakeTimers();
      try {
        const pending = ingress({
          deadlineMs: 100,
          answer: () => new Promise<string>(() => undefined),
        }).ask(ask());

        await vi.advanceTimersByTimeAsync(100);

        await expect(pending).resolves.toMatchObject({ failure: "slow" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("a turn that failed", () => {
    it("should say something rather than throwing into the RPC handler", async () => {
      const outcome = await ingress({
        answer: () => Promise.reject(new Error("the harness is wedged")),
      }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "failed", say: TURN_FAILED_LINE });
    });

    it("should treat an answer with no words in it as a failure, not as silence", async () => {
      const outcome = await ingress({ answer: () => Promise.resolve("   ") }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "failed", say: TURN_FAILED_LINE });
    });

    it("should say something when there was nothing to answer", async () => {
      const outcome = await ingress().ask(ask("   "));

      expect(outcome).toEqual({ ok: false, failure: "empty", say: NOTHING_ASKED_LINE });
    });
  });

  /**
   * The contract in the module header is "never rejects", and until `syl-chzl`
   * only the part of it *inside* the try block held. The credential check, the
   * `touch`, the warm-lane predicate and the logger all ran outside it, so a
   * locked database or a throwing seam became a rejected RPC handler — which is
   * the one thing the avatar's tool loop is not built to survive.
   *
   * These drive each seam to a throw and require a sentence anyway.
   */
  describe("a seam that throws rather than failing", () => {
    /** A store whose every method throws, as a locked database would. */
    function wedged(): FaceSessionStore {
      const boom = (): never => {
        throw new Error("database is locked");
      };
      return new Proxy(sessions, {
        get: () => boom,
      }) as unknown as FaceSessionStore;
    }

    it("should refuse rather than reject when the credential cannot be checked", async () => {
      const outcome = await ingress({ sessions: wedged() }).ask(ask());

      // FAIL CLOSED. A check that could not complete is not an authenticated
      // caller, so this is the ordinary refusal with nothing to say — never an
      // apology that tells a stranger the session is real.
      expect(outcome.ok).toBe(false);
      expect(outcome).not.toHaveProperty("say");
    });

    it("should say something rather than reject when marking the session active throws", async () => {
      const touch = vi.spyOn(sessions, "touch").mockImplementation(() => {
        throw new Error("database is locked");
      });

      const outcome = await ingress().ask(ask());

      expect(touch).toHaveBeenCalled();
      expect(outcome).toEqual({ ok: false, failure: "failed", say: TURN_FAILED_LINE });
    });

    it("should say something rather than reject when the warm-lane predicate throws", async () => {
      const outcome = await ingress({
        isLaneWarm: () => {
          throw new Error("the lane router is gone");
        },
      }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "failed", say: TURN_FAILED_LINE });
    });

    it("should say something rather than reject when the answerer throws synchronously", async () => {
      const outcome = await ingress({
        answer: () => {
          throw new Error("thrown, not rejected");
        },
      }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "failed", say: TURN_FAILED_LINE });
    });

    it("should still answer when the log sink itself throws", async () => {
      const outcome = await ingress({
        log: () => {
          throw new Error("the log file is gone");
        },
      }).ask(ask());

      expect(outcome).toEqual({ ok: true, say: "Two things are due before lunch." });
    });
  });

  /**
   * The compounding failure, measured on the Commander's own phone on
   * 2026-08-23: four `ask_syl` calls, four deadline misses, no answer ever
   * spoken.
   *
   * `ConversationService` serialises turns per conversation, and a turn we have
   * stopped waiting for **keeps running and keeps the queue**. So the second
   * question did not merely take as long as the first — it waited out the whole
   * of the first turn and then ran its own, which is a guaranteed miss. From
   * the log: turn one 10,049ms, turn two queued behind it and 7,789ms of its
   * own, turn three 29,852ms. Every abandoned turn also lands in his transcript
   * unspoken, growing the very thread whose length is making the turns slow.
   *
   * So a second question arriving while a turn is still running must be
   * answered from here, at once, with something true — never enqueued behind
   * the turn that is already too slow.
   */
  describe("a second question while her turn is still running", () => {
    it("should not start a second turn behind the one already running", async () => {
      const answer = vi.fn<FaceAnswerer>(() => new Promise<string>(() => undefined));
      const gate = ingress({ answer, deadlineMs: 50 });

      const first = gate.ask(ask("What is on my list?"));
      const second = await gate.ask(ask("Did you get that?"));

      expect(answer).toHaveBeenCalledTimes(1);
      expect(second.ok).toBe(false);
      await first;
    });

    it("should answer the second question at once rather than waiting out the first", async () => {
      vi.useFakeTimers();
      try {
        const gate = ingress({ answer: () => new Promise<string>(() => undefined) });
        const first = gate.ask(ask("What is on my list?"));

        // Not one tick of the deadline: the answer is already known.
        const second = await gate.ask(ask("Did you get that?"));

        expect(second).toEqual({ ok: false, failure: "busy", say: STILL_THINKING_LINE });

        await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
        await first;
      } finally {
        vi.useRealTimers();
      }
    });

    it("should stay closed until the abandoned turn actually settles, not until we stop waiting", async () => {
      vi.useFakeTimers();
      try {
        let finish: ((said: string) => void) | undefined;
        const answer = vi.fn<FaceAnswerer>(() =>
          finish === undefined
            ? new Promise<string>((resolve) => {
                finish = resolve;
              })
            : Promise.resolve("Here it is."),
        );
        const gate = ingress({ answer });

        const first = gate.ask(ask("What is on my list?"));
        await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
        await expect(first).resolves.toMatchObject({ failure: "slow" });

        // The deadline passed, so we are no longer waiting — but her turn is
        // still on the conversation's queue, and the next question would queue
        // behind it. THAT is what must not happen.
        await expect(gate.ask(ask("Anything?"))).resolves.toMatchObject({ failure: "busy" });
        expect(answer).toHaveBeenCalledTimes(1);

        finish?.("The first one, finally.");
        await vi.advanceTimersByTimeAsync(0);

        // Settled, so the next question runs a turn of its own.
        await expect(gate.ask(ask("Now?"))).resolves.toEqual({ ok: true, say: "Here it is." });
        expect(answer).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should reopen after a turn that failed, not only after one that answered", async () => {
      const answer = vi.fn<FaceAnswerer>(() => Promise.reject(new Error("the harness is wedged")));
      const gate = ingress({ answer });

      await expect(gate.ask(ask())).resolves.toMatchObject({ failure: "failed" });
      await expect(gate.ask(ask())).resolves.toMatchObject({ failure: "failed" });

      expect(answer).toHaveBeenCalledTimes(2);
    });

    it("should hold the gate per session, so one face cannot mute another", async () => {
      const minted = mintAskSecret();
      sessions.open({
        id: "rts_2",
        avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
        credits: 2,
        dollars: 0.02,
        askSecretHash: minted.hash,
        askExpiresAt: now + 300_000,
      });

      const answer = vi.fn<FaceAnswerer>(() => new Promise<string>(() => undefined));
      const gate = ingress({ answer, deadlineMs: 50 });

      const first = gate.ask(ask("What is on my list?"));
      const other = gate.ask({ sessionId: "rts_2", secret: minted.secret, question: "And me?" });

      await Promise.all([first, other]);
      expect(answer).toHaveBeenCalledTimes(2);
    });

    it("should tell the model it is busy rather than handing it an empty sentence", async () => {
      const gate = ingress({ answer: () => new Promise<string>(() => undefined), deadlineMs: 50 });
      const handlers = gate.handlerFor("rts_1", secret);

      const first = handlers[ASK_SYL_TOOL_NAME]?.({ question: "What is on my list?" });
      const second = await handlers[ASK_SYL_TOOL_NAME]?.({ question: "Did you get that?" });

      expect(second).toEqual({ ok: false, say: STILL_THINKING_LINE, failure: "busy" });
      await first;
    });
  });

  describe("the RPC handler map", () => {
    it("should expose exactly one method, under the declared tool name", () => {
      const handlers = ingress().handlerFor("rts_1", secret);

      expect(Object.keys(handlers)).toEqual([ASK_SYL_TOOL_NAME]);
    });

    it("should answer a call from the avatar's model", async () => {
      const handlers = ingress().handlerFor("rts_1", secret);

      const result = await handlers[ASK_SYL_TOOL_NAME]?.({ question: "What is on today?" });

      expect(result).toEqual({ ok: true, say: "Two things are due before lunch." });
    });

    it("should never reject, whatever the model sends", async () => {
      const handlers = ingress({
        answer: () => Promise.reject(new Error("boom")),
      }).handlerFor("rts_1", secret);

      await expect(handlers[ASK_SYL_TOOL_NAME]?.({})).resolves.toEqual(
        expect.objectContaining({ ok: false, say: NOTHING_ASKED_LINE }),
      );
      await expect(
        handlers[ASK_SYL_TOOL_NAME]?.({ question: 42 as unknown as string }),
      ).resolves.toEqual(expect.objectContaining({ ok: false }));
    });

    it("should refuse when bound to a credential that is not this session's", async () => {
      const handlers = ingress().handlerFor("rts_1", mintAskSecret().secret);

      const result = (await handlers[ASK_SYL_TOOL_NAME]?.({ question: "Hello?" })) ?? {};

      expect(result["ok"]).toBe(false);
      expect(result["say"]).toBe("");
    });

    it("should stop working the moment its session is settled", async () => {
      const handlers = ingress().handlerFor("rts_1", secret);
      expect((await handlers[ASK_SYL_TOOL_NAME]?.({ question: "Hi" }))?.["ok"]).toBe(true);

      sessions.settle({ id: "rts_1", ended: "reaped", credits: 4, dollars: 0.04 });

      expect((await handlers[ASK_SYL_TOOL_NAME]?.({ question: "Hi" }))?.["ok"]).toBe(false);
    });
  });
});
