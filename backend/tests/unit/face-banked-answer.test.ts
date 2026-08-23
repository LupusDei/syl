import { describe, expect, it } from "vitest";

import {
  AnswerBank,
  BANKED_ANSWER_LIFETIME_MS,
  MAX_BANKED_SESSIONS,
  isSameQuestion,
  spokenBankedAnswer,
} from "../../src/face/banked-answer.js";

/**
 * The bank behind the promise `TOO_SLOW_LINE` makes.
 *
 * She says "ask me again and I will have it". Until `syl-chzl.4.5` that was a
 * lie every single time: the overrunning turn finished, produced a perfectly
 * good answer, and the ingress dropped it on the floor. This module is the
 * floor being taken away.
 *
 * Pure on purpose — no clock, no store, no I/O. Every instant is a parameter,
 * so the whole staleness model is exercised in microseconds and the ingress
 * test does not have to reason about wall time.
 */
describe("the answer bank", () => {
  const T0 = Date.parse("2026-08-23T18:00:00.000Z");

  const entry = (overrides: Partial<Parameters<AnswerBank["put"]>[1]> = {}) => ({
    question: "What is on today?",
    say: "Two things are due before lunch.",
    askedAt: T0,
    ...overrides,
  });

  describe("keeping an answer", () => {
    it("should hand back an answer banked a moment ago", () => {
      const bank = new AnswerBank();

      bank.put("rts_1", entry());

      expect(bank.peek("rts_1", T0 + 12_000)).toEqual(entry());
    });

    it("should know nothing about a session that never banked anything", () => {
      expect(new AnswerBank().peek("rts_nobody", T0)).toBeNull();
    });

    it("should keep one session's answer out of another session's reach", () => {
      // The load-bearing one. A banked answer is HIS answer, computed inside a
      // session he paid for and authenticated to; serving it to a second face
      // would hand one caller another caller's words.
      const bank = new AnswerBank();

      bank.put("rts_1", entry());

      expect(bank.peek("rts_2", T0 + 1_000)).toBeNull();
    });

    it("should hold only the newest answer for a session", () => {
      // One slot per session, deliberately. A queue of unheard answers would
      // serve him a backlog in the order it accumulated, which is the exact
      // non-sequitur this feature has to avoid.
      const bank = new AnswerBank();

      bank.put("rts_1", entry());
      bank.put("rts_1", entry({ question: "And tomorrow?", say: "Nothing yet." }));

      expect(bank.peek("rts_1", T0)?.question).toBe("And tomorrow?");
    });

    it("should let a caller take an answer exactly once", () => {
      // Take-once is what stops her saying the same banked answer on every
      // subsequent ask for the rest of the session.
      const bank = new AnswerBank();
      bank.put("rts_1", entry());

      expect(bank.take("rts_1", T0)).toEqual(entry());
      expect(bank.take("rts_1", T0)).toBeNull();
    });

    it("should let a caller drop an answer that has been superseded", () => {
      const bank = new AnswerBank();
      bank.put("rts_1", entry());

      bank.drop("rts_1");

      expect(bank.peek("rts_1", T0)).toBeNull();
    });

    it("should shrug off dropping a session it has never heard of", () => {
      expect(() => new AnswerBank().drop("rts_nobody")).not.toThrow();
    });
  });

  describe("staleness", () => {
    it("should still serve an answer inside its lifetime", () => {
      const bank = new AnswerBank();
      bank.put("rts_1", entry());

      expect(bank.peek("rts_1", T0 + BANKED_ANSWER_LIFETIME_MS - 1)).not.toBeNull();
    });

    it("should refuse an answer the moment its lifetime is up", () => {
      // Boundary, and exclusive: at exactly the lifetime the answer is gone.
      const bank = new AnswerBank();
      bank.put("rts_1", entry());

      expect(bank.peek("rts_1", T0 + BANKED_ANSWER_LIFETIME_MS)).toBeNull();
    });

    it("should measure the lifetime from when HE ASKED, not from when it landed", () => {
      // The bound is on the gap between his question and hearing its answer,
      // which is what actually disorients him. A turn that took thirty seconds
      // therefore gets sixty seconds of bank life and a fast one gets nearly
      // ninety — the right direction, because a slow turn's answer is already
      // older by the time it exists.
      const landedAt = T0 + 30_000;

      // Two banks rather than two reads of one, because the first read SWEEPS.
      // Reusing a bank here would pass for the wrong reason on the second
      // assertion and fail for the wrong reason on the first.
      const late = new AnswerBank();
      late.put("rts_1", entry({ askedAt: T0 }));
      expect(late.peek("rts_1", landedAt + 61_000)).toBeNull();

      const early = new AnswerBank();
      early.put("rts_1", entry({ askedAt: T0 }));
      expect(early.peek("rts_1", landedAt + 59_000)).not.toBeNull();
    });

    it("should make an expired answer disappear rather than linger", () => {
      // Not merely hidden from the reader: gone. A stale answer still sitting
      // in the map is an answer some later code path can find.
      const bank = new AnswerBank();
      bank.put("rts_1", entry());

      bank.peek("rts_1", T0 + BANKED_ANSWER_LIFETIME_MS);

      expect(bank.size()).toBe(0);
    });

    it("should sweep every session's expired answer, not only the one asked for", () => {
      // The map's only bound. Without this, one banked answer per face session
      // stays resident for the life of the process.
      const bank = new AnswerBank();
      bank.put("rts_1", entry());
      bank.put("rts_2", entry());

      bank.peek("rts_3", T0 + BANKED_ANSWER_LIFETIME_MS);

      expect(bank.size()).toBe(0);
    });

    it("should sweep on the way in as well as on the way out", () => {
      const bank = new AnswerBank();
      bank.put("rts_1", entry());

      bank.put("rts_2", entry({ askedAt: T0 + BANKED_ANSWER_LIFETIME_MS }));

      expect(bank.size()).toBe(1);
      expect(bank.peek("rts_1", T0 + BANKED_ANSWER_LIFETIME_MS)).toBeNull();
    });

    it("should never grow past its cap even if the clock stands still", () => {
      // Belt and braces on top of the sweep. The sweep bounds the map by
      // "sessions that overran in the last ninety seconds", which is already
      // small — but that is an ARGUMENT, and this is a structure.
      const bank = new AnswerBank();

      for (let n = 0; n <= MAX_BANKED_SESSIONS + 10; n += 1) {
        bank.put(`rts_${String(n)}`, entry({ askedAt: T0 + n }));
      }

      expect(bank.size()).toBe(MAX_BANKED_SESSIONS);
      // The oldest went first, so the answer most likely to still be wanted
      // is the one that survives.
      expect(bank.peek("rts_0", T0)).toBeNull();
      expect(bank.peek(`rts_${String(MAX_BANKED_SESSIONS + 10)}`, T0)).not.toBeNull();
    });
  });

  /**
   * Twenty seconds have passed and he may have moved on. An answer that
   * arrives with no referent reads as a non-sequitur, so she has to say what
   * it is an answer to — out loud, in her own voice, not as a status line.
   */
  describe("saying what it is an answer to", () => {
    it("should name his question before giving him the answer", () => {
      const said = spokenBankedAnswer(
        { question: "What is on today?", say: "Two things are due before lunch." },
        { stillWorking: false },
      );

      expect(said).toBe("You asked me what is on today — here it is. Two things are due before lunch.");
    });

    it("should say she is still on the newer one when a turn is running behind it", () => {
      const said = spokenBankedAnswer(
        { question: "What is on today?", say: "Two things are due before lunch." },
        { stillWorking: true },
      );

      expect(said).toContain("while I finish the new one");
      expect(said).toContain("Two things are due before lunch.");
    });

    it("should not read his punctuation back at him", () => {
      const said = spokenBankedAnswer(
        { question: "Did the deploy go out??  ", say: "It did." },
        { stillWorking: false },
      );

      expect(said).toBe("You asked me did the deploy go out — here it is. It did.");
    });

    it("should keep his own words rather than paraphrasing them", () => {
      const said = spokenBankedAnswer(
        { question: "when is the dentist", say: "Thursday at ten." },
        { stillWorking: false },
      );

      expect(said).toContain("when is the dentist");
    });

    it("should lower only the first letter, leaving names alone", () => {
      // "You asked me What is Grace doing" reads as a quotation; lowering the
      // whole thing would say "grace", which is a different word.
      const said = spokenBankedAnswer(
        { question: "What is Grace doing on Friday?", say: "Nothing yet." },
        { stillWorking: false },
      );

      expect(said).toContain("what is Grace doing on Friday");
    });

    it("should shorten a question too long to say back to him", () => {
      const rambling = `${"tell me about ".repeat(20)}the thing`;

      const said = spokenBankedAnswer(
        { question: rambling, say: "Here you go." },
        { stillWorking: false },
      );

      expect(said).toContain("…");
      expect(said).toContain("Here you go.");
      expect(said.indexOf("Here you go.")).toBeLessThan(220);

      // Clipped at a WORD BOUNDARY — half a word spoken aloud is gibberish.
      // Checked against the source rather than by shape: whatever she reads
      // back must be a whole-word prefix of what he actually said.
      const clipped = said.slice("You asked me ".length, said.indexOf("…"));
      expect(rambling.startsWith(clipped)).toBe(true);
      expect(rambling.charAt(clipped.length)).toBe(" ");
    });

    it("should collapse the whitespace a transcript brings with it", () => {
      const said = spokenBankedAnswer(
        { question: "what   is\n on\ttoday", say: "Two things." },
        { stillWorking: false },
      );

      expect(said).toBe("You asked me what is on today — here it is. Two things.");
    });

    it("should still have a referent when the question was nothing but punctuation", () => {
      // The ingress rejects an empty question, but "???" is not empty. She must
      // not say "You asked me  — here it is."
      const said = spokenBankedAnswer(
        { question: "???", say: "Two things." },
        { stillWorking: false },
      );

      expect(said).toBe("That last one you asked me — here it is. Two things.");
    });

    it("should sound like her rather than like a system message", () => {
      const said = spokenBankedAnswer(
        { question: "What is on today?", say: "Two things." },
        { stillWorking: false },
      );

      expect(said).not.toMatch(/cached|queued|banked|timed out|previous request|session/i);
    });
  });

  /**
   * Used for ONE cheap decision — did he repeat himself, in which case there is
   * no point burning a turn on it. Never used to gate whether the banked answer
   * is served, because speech transcription varies run to run and the case this
   * whole feature exists for is the one where he was TOLD to ask again and so
   * rephrased.
   */
  describe("telling a repeat from a new question", () => {
    it("should call a verbatim repeat a repeat", () => {
      expect(isSameQuestion("What is on today?", "What is on today?")).toBe(true);
    });

    it("should see through casing and punctuation", () => {
      expect(isSameQuestion("What is on today?", "what is on today")).toBe(true);
    });

    it("should see through the whitespace a transcript brings", () => {
      expect(isSameQuestion("what  is on\ttoday", "what is on today")).toBe(true);
    });

    it("should call a genuinely different question different", () => {
      expect(isSameQuestion("What is on today?", "When is the dentist?")).toBe(false);
    });

    it("should call a rephrasing different, which is why it never gates serving", () => {
      // Documenting the limit rather than pretending it is not there. A false
      // negative here costs one redundant turn; it must never cost the answer.
      expect(isSameQuestion("What is on today?", "So what have I got today?")).toBe(false);
    });

    it("should never call two empty questions the same", () => {
      expect(isSameQuestion("", "")).toBe(false);
      expect(isSameQuestion("???", "!!!")).toBe(false);
    });

    it("should keep letters outside ASCII", () => {
      expect(isSameQuestion("Où est Grace?", "où est grace")).toBe(true);
      expect(isSameQuestion("Où est Grace?", "où est Renarin")).toBe(false);
    });
  });
});
