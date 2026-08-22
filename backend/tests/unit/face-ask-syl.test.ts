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

    it("should tell the model to ask her rather than answer for her", () => {
      expect(ASK_SYL_TOOL.description).toMatch(/never answer from your own knowledge/i);
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
