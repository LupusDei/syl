import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mintAskSecret } from "../../src/face/ask-credential.js";
import {
  AskSylIngress,
  ASK_SYL_DEADLINE_MS,
  COLD_LANE_LINE,
  STILL_THINKING_LINE,
  TOO_SLOW_LINE,
  TURN_FAILED_LINE,
  type FaceAnswerer,
} from "../../src/face/ask-syl.js";
import { BANKED_ANSWER_LIFETIME_MS } from "../../src/face/banked-answer.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * `syl-chzl.4.5` — the ingress keeping the promise it makes.
 *
 * `TOO_SLOW_LINE` says "ask me again and I will have it", and until this bead
 * she never did: the overrun turn finished, produced a good answer, and the
 * ingress dropped it on the floor. Fourteen asks out of fourteen on 2026-08-23
 * and her face had never once answered a question.
 *
 * These tests live in a file of their own rather than in `face-ask-syl.test.ts`
 * because two agents were editing that file at once. The properties from
 * `a9dae98` — the ingress never rejects, and a second question is refused
 * rather than queued — are re-asserted at the bottom, because this work sits
 * directly on top of them and must not undo either.
 */
describe("AskSylIngress, and the answer it banks", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let now: number;
  const clock: Clock = () => now;

  let secret: string;

  beforeEach(() => {
    now = Date.parse("2026-08-23T18:00:00.000Z");
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
      askExpiresAt: now + 3_600_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  type Overrides = Partial<ConstructorParameters<typeof AskSylIngress>[0]>;

  function ingress(overrides: Overrides = {}): AskSylIngress {
    return new AskSylIngress({
      sessions,
      answer: () => Promise.resolve("Two things are due before lunch."),
      now: clock,
      log: () => undefined,
      ...overrides,
    });
  }

  const ask = (question = "What is on today?") => ({ sessionId: "rts_1", secret, question });

  interface Deferred {
    readonly promise: Promise<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }

  /** A turn whose landing this test controls to the millisecond. */
  function deferred(): Deferred {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A rejection nobody has subscribed to yet must not fail the run before the
    // ingress attaches its own handler.
    promise.catch(() => undefined);
    return { promise, resolve, reject };
  }

  /**
   * An answerer that hands out queued turns, one per call, then a default.
   *
   * Thunks rather than promises, so a turn that is never reached is never
   * CREATED — an eagerly built rejected promise nobody consumes is an unhandled
   * rejection that fails the whole file for an unrelated reason.
   */
  function answersInOrder(...turns: readonly (() => Promise<string>)[]): FaceAnswerer {
    let next = 0;
    return () => {
      const turn = turns[next];
      next += 1;
      return turn === undefined ? Promise.resolve("Nothing more.") : turn();
    };
  }

  /**
   * An ingress whose FIRST turn this test controls, plus the turns after it.
   *
   * `first` must be resolved by the test, or nothing settles and every later
   * ask reads as busy rather than as whatever the test meant to assert.
   */
  function withSlowFirstTurn(
    overrides: Overrides = {},
    ...rest: readonly (() => Promise<string>)[]
  ): {
    readonly subject: AskSylIngress;
    readonly first: Deferred;
    readonly answer: ReturnType<typeof vi.fn<FaceAnswerer>>;
  } {
    const first = deferred();
    const answer = vi.fn<FaceAnswerer>(answersInOrder(() => first.promise, ...rest));
    return { subject: ingress({ answer, ...overrides }), first, answer };
  }

  /**
   * Drive one ask past the deadline, then land the turn behind it.
   *
   * The exact sequence from his phone: she says the too-slow line at 6.5s, and
   * the turn she abandoned finishes some seconds later with a real answer.
   */
  async function overrunThenLand(
    subject: AskSylIngress,
    turn: Deferred,
    question: string,
    answer: string,
    landsAfterMs = 4_000,
  ): Promise<void> {
    const pending = subject.ask({ sessionId: "rts_1", secret, question });
    await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
    await expect(pending).resolves.toMatchObject({ failure: "slow", say: TOO_SLOW_LINE });

    now += landsAfterMs;
    turn.resolve(answer);
    await vi.advanceTimersByTimeAsync(0);
  }

  describe("the promise she makes when she runs out of time", () => {
    it("should have the answer ready when he asks again, as she said she would", async () => {
      vi.useFakeTimers();
      const { subject, first, answer } = withSlowFirstTurn();

      await overrunThenLand(subject, first, "What is on today?", "Two things are due before lunch.");

      now += 6_000;
      const second = await subject.ask(ask("What is on today?"));

      expect(second).toEqual({
        ok: true,
        banked: true,
        say: "You asked me what is on today — here it is. Two things are due before lunch.",
      });
      // And she did NOT start a second turn to do it.
      expect(answer).toHaveBeenCalledTimes(1);
    });

    it("should answer from the bank well inside the ceiling, not at the deadline", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      // Real timers from here: if serving the bank waited on anything at all,
      // this hangs and the test times out rather than passing slowly.
      vi.useRealTimers();
      const startedAt = Date.now();
      const second = await subject.ask(ask("What is on today?"));

      expect(second.ok).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it("should say what the answer is an answer to", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "When is the dentist?", "Thursday at ten.");

      const second = await subject.ask(ask("When is the dentist?"));

      // Up to ninety seconds have passed and he may have moved on. An answer
      // with no referent reads as a non-sequitur.
      expect(second.ok === true && second.say).toContain("You asked me when is the dentist");
      expect(second.ok === true && second.say).toContain("Thursday at ten.");
    });

    it("should serve a banked answer exactly once", async () => {
      vi.useFakeTimers();
      const { subject, first, answer } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      await subject.ask(ask("What is on today?"));
      const third = await subject.ask(ask("What is on today?"));

      // The second repeat gets a real turn, not the same sentence again.
      expect(third).toEqual({ ok: true, say: "Nothing more." });
      expect(answer).toHaveBeenCalledTimes(2);
    });

    it("should bank nothing when the turn landed in time and he actually heard it", async () => {
      const answer = vi.fn<FaceAnswerer>(answersInOrder(() => Promise.resolve("Two things.")));
      const subject = ingress({ answer });

      const first = await subject.ask(ask("What is on today?"));
      const second = await subject.ask(ask("What is on today?"));

      expect(first).toEqual({ ok: true, say: "Two things." });
      // A fresh turn, with no preface — she is not replaying what he just heard.
      expect(second).toEqual({ ok: true, say: "Nothing more." });
      expect(answer).toHaveBeenCalledTimes(2);
    });

    it("should bank nothing when the overrun turn came back with no words", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();

      const pending = subject.ask(ask());
      await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
      await pending;
      first.resolve("   ");
      await vi.advanceTimersByTimeAsync(0);

      // "Here it is" about an empty sentence is worse than the apology.
      expect(await subject.ask(ask())).toEqual({ ok: true, say: "Nothing more." });
    });

    it("should bank nothing when the overrun turn failed outright", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();

      const pending = subject.ask(ask());
      await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
      await pending;
      first.reject(new Error("the harness is wedged"));
      await vi.advanceTimersByTimeAsync(0);

      expect(await subject.ask(ask())).toEqual({ ok: true, say: "Nothing more." });
    });
  });

  describe("staleness", () => {
    it("should let a banked answer expire rather than serve it against a later moment", async () => {
      vi.useFakeTimers();
      const { subject, first, answer } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      now += BANKED_ANSWER_LIFETIME_MS;
      vi.useRealTimers();
      const second = await subject.ask(ask("What is on today?"));

      // Gone cleanly: a fresh turn, not a stale answer wearing a preface.
      expect(second).toEqual({ ok: true, say: "Nothing more." });
      expect(answer).toHaveBeenCalledTimes(2);
    });

    it("should still serve it a minute later, which is inside a single exchange", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      now += 60_000;
      vi.useRealTimers();

      expect(await subject.ask(ask("What is on today?"))).toMatchObject({ banked: true });
    });
  });

  /**
   * The credential rules on `/face` are unchanged and load-bearing. A banked
   * answer is HIS answer, computed inside a session he paid for; serving it to
   * anyone who has not proved they hold that session's credential would be the
   * worst available way to leak it.
   */
  describe("who may be served a banked answer", () => {
    it("should give a stranger nothing, banked answer or not", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things are due before lunch.");
      vi.useRealTimers();

      const outcome = await subject.ask({
        sessionId: "rts_1",
        secret: mintAskSecret().secret,
        question: "What is on today?",
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.failure).toBe("unauthorised");
      // Not even an apology, and certainly not his answer.
      expect(outcome.ok === false && outcome.say).toBeUndefined();
      expect(JSON.stringify(outcome)).not.toContain("due before lunch");
    });

    it("should never serve one session's answer to another session", async () => {
      vi.useFakeTimers();
      const other = mintAskSecret();
      sessions.open({
        id: "rts_2",
        avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
        credits: 2,
        dollars: 0.02,
        askSecretHash: other.hash,
        askExpiresAt: now + 3_600_000,
      });
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things are due before lunch.");
      vi.useRealTimers();

      const outcome = await subject.ask({
        sessionId: "rts_2",
        secret: other.secret,
        question: "What is on today?",
      });

      expect(outcome).toEqual({ ok: true, say: "Nothing more." });
    });

    it("should stop serving a banked answer once the session has ended", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      vi.useRealTimers();

      sessions.settle({ id: "rts_1", ended: "closed", credits: 4, dollars: 0.04 });
      const outcome = await subject.ask(ask("What is on today?"));

      // `syl-chzl.4.6` landed the ending path this test was written against, so
      // the refusal now has a sentence — `expired`, and she says the time is
      // up. THE INVARIANT THIS TEST EXISTS FOR IS UNCHANGED and is the line
      // below: whatever she says, it is not the stale answer.
      expect(outcome).toMatchObject({ ok: false, failure: "expired" });
      expect(JSON.stringify(outcome)).not.toContain("Two things.");
    });

    it("should stop serving a banked answer once the credential has expired", async () => {
      // THE ENDING BEATS A STALE ANSWER, and this is where that is decided.
      //
      // `syl-chzl.4.6` adds a path that ends a session when the PROVIDER's cap
      // passes. The question it raises is whether a banked answer waiting at
      // that moment could still be spoken into a session that is already over.
      //
      // It cannot, and the reason is ordering rather than coincidence: the
      // bank is read strictly AFTER `verifyAskCredential`, which refuses both a
      // settled row and an expired `askExpiresAt`. So the bank sits behind the
      // credential gate and inherits the session's lifetime for free. Nothing
      // in `AskSylIngress` needs to sequence the two checks by hand.
      //
      // What the ending path must do is expire the CREDENTIAL — settle the row
      // or move `askExpiresAt` back — rather than only speaking its line. This
      // test is here so that requirement is written down as an assertion and
      // not as an assumption.
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      vi.useRealTimers();

      // The provider's cap passes. The row is still open; only the credential
      // has run out.
      now += 3_600_000;
      const outcome = await subject.ask(ask("What is on today?"));

      // The prediction in the comment above held exactly: the bank sits behind
      // `verifyAskCredential`, so `syl-chzl.4.6` needed no hand-sequencing to
      // make the ending win. What changed is only that the refusal now SAYS
      // something — the ending line, never the banked answer.
      expect(outcome).toMatchObject({ ok: false, failure: "expired" });
      expect(JSON.stringify(outcome)).not.toContain("Two things.");
    });
  });

  /**
   * He was told to ask again, so he rephrases. Any matcher tight enough to be
   * safe produces a false negative on exactly that, which is why the match
   * decides only whether to BURN A TURN and never whether to serve.
   */
  describe("when he asks something different instead of repeating himself", () => {
    it("should run the new question rather than answering the old one over it", async () => {
      const answer = vi.fn<FaceAnswerer>(answersInOrder(() => Promise.resolve("Two things.")));
      const subject = ingress({ answer });
      await subject.ask(ask("What is on today?"));

      const second = await subject.ask(ask("When is the dentist?"));

      // The best outcome by some distance: he asked something, she answered
      // THAT, at once. The bank is a fallback and never a substitute.
      expect(second).toEqual({ ok: true, say: "Nothing more." });
      expect(answer).toHaveBeenLastCalledWith({
        sessionId: "rts_1",
        question: "When is the dentist?",
      });
    });

    it("should fall back to the banked answer when the new question overruns too", async () => {
      vi.useFakeTimers();
      const second = deferred();
      const { subject, first } = withSlowFirstTurn({}, () => second.promise);
      await overrunThenLand(subject, first, "What is on today?", "Two things are due before lunch.");

      const pending = subject.ask(ask("When is the dentist?"));
      await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
      const outcome = await pending;

      // Real words instead of a second apology, and honest about the new one.
      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.say).toContain("Two things are due before lunch.");
      expect(outcome.ok === true && outcome.say).toContain("while I finish the new one");
    });

    it("should drop the old answer once a newer question has been answered", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn({}, () => Promise.resolve("Thursday at ten."));
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      vi.useRealTimers();

      // He asks something else and hears a real answer to it.
      expect(await subject.ask(ask("When is the dentist?"))).toEqual({
        ok: true,
        say: "Thursday at ten.",
      });

      // The unheard answer is now water under the bridge. Serving it after she
      // has successfully answered something newer IS the non-sequitur.
      expect(await subject.ask(ask("What is on today?"))).toEqual({
        ok: true,
        say: "Nothing more.",
      });
    });

    it("should replace the bank with the newer question's answer when that overruns", async () => {
      vi.useFakeTimers();
      const second = deferred();
      const { subject, first } = withSlowFirstTurn({}, () => second.promise);
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      const pending = subject.ask(ask("When is the dentist?"));
      await vi.advanceTimersByTimeAsync(ASK_SYL_DEADLINE_MS);
      await pending;
      now += 3_000;
      second.resolve("Thursday at ten.");
      await vi.advanceTimersByTimeAsync(0);

      vi.useRealTimers();
      const third = await subject.ask(ask("When is the dentist?"));

      expect(third.ok === true && third.say).toContain("Thursday at ten.");
      expect(third.ok === true && third.say).not.toContain("Two things.");
    });
  });

  describe("when she cannot produce new words at all", () => {
    it("should serve a banked answer rather than saying she is not awake yet", async () => {
      vi.useFakeTimers();
      let warm = true;
      const { subject, first } = withSlowFirstTurn({ isLaneWarm: () => warm });
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      vi.useRealTimers();

      warm = false;
      const outcome = await subject.ask(ask("What is on today?"));

      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.say).toContain("Two things.");
    });

    it("should still say she is not awake yet when there is nothing banked", async () => {
      const outcome = await ingress({ isLaneWarm: () => false }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "cold", say: COLD_LANE_LINE });
    });

    it("should serve a banked answer rather than an apology when the new turn fails", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn({}, () =>
        Promise.reject(new Error("the harness is wedged")),
      );
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      vi.useRealTimers();

      const outcome = await subject.ask(ask("When is the dentist?"));

      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.say).toContain("Two things.");
    });

    it("should still apologise for a failed turn when there is nothing banked", async () => {
      const outcome = await ingress({
        answer: () => Promise.reject(new Error("the harness is wedged")),
      }).ask(ask());

      expect(outcome).toEqual({ ok: false, failure: "failed", say: TURN_FAILED_LINE });
    });
  });

  /**
   * `a9dae98` established these and this work sits directly on top of them.
   * Re-asserted here so a regression is attributed to the bank rather than
   * found three files away.
   */
  describe("the properties this must not undo", () => {
    it("should still refuse a second question instantly rather than queueing it", async () => {
      vi.useFakeTimers();
      const { subject } = withSlowFirstTurn();
      void subject.ask(ask("What is on today?"));
      await vi.advanceTimersByTimeAsync(1);

      const second = await subject.ask(ask("When is the dentist?"));

      expect(second).toEqual({ ok: false, failure: "busy", say: STILL_THINKING_LINE });
    });

    it("should still never reject, even when the store is wedged and something is banked", async () => {
      vi.useFakeTimers();
      const { subject, first } = withSlowFirstTurn();
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      vi.useRealTimers();

      const boom = (): never => {
        throw new Error("database is locked");
      };
      const wedged = new Proxy(sessions, { get: () => boom }) as unknown as FaceSessionStore;
      const outcome = await ingress({ sessions: wedged }).ask(ask());

      expect(outcome).toMatchObject({ ok: false, failure: "unauthorised" });
    });

    it("should serve past the in-flight gate only for a question he repeated", async () => {
      // A turn is running on something NEWER. Telling him she is still on it is
      // the honest answer — she has not abandoned the question in front of the
      // banked one. A repeat of the banked one is different: she has that.
      vi.useFakeTimers();
      const running = deferred();
      const { subject, first } = withSlowFirstTurn({}, () => running.promise);
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      void subject.ask(ask("When is the dentist?"));
      await vi.advanceTimersByTimeAsync(1);

      expect(await subject.ask(ask("And on Friday?"))).toMatchObject({ failure: "busy" });
      expect(await subject.ask(ask("What is on today?"))).toMatchObject({ banked: true });
    });
  });

  describe("what the log shows", () => {
    it("should record that an abandoned turn landed and was kept", async () => {
      vi.useFakeTimers();
      const log = vi.fn();
      const { subject, first } = withSlowFirstTurn({ log });
      await overrunThenLand(subject, first, "What is on today?", "Two things.");

      expect(log).toHaveBeenCalledWith(
        "face.ask.banked",
        expect.objectContaining({ sessionId: "rts_1" }),
      );
    });

    it("should record that a banked answer was served, and how old it was", async () => {
      vi.useFakeTimers();
      const log = vi.fn();
      const { subject, first } = withSlowFirstTurn({ log });
      await overrunThenLand(subject, first, "What is on today?", "Two things.");
      now += 5_000;
      vi.useRealTimers();

      await subject.ask(ask("What is on today?"));

      expect(log).toHaveBeenCalledWith(
        "face.ask.served_banked",
        expect.objectContaining({ sessionId: "rts_1", ageMs: 9_000 }),
      );
    });
  });
});
