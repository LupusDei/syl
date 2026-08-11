import { describe, expect, it } from "vitest";

import { verifyUrgency } from "../../src/harness/urgency.js";

/**
 * `syl-p8k` — the half of the urgency fix that does the checking.
 *
 * `tests/acceptance/urgency-is-evidence.test.ts` states the property: the
 * quiet-hours bypass is his to grant and hers to relay. This file is the same
 * property at the grain the function is actually written in — what counts as
 * "his words", and every way a quote can fail to be them.
 *
 * The asymmetry is the whole design and is worth restating where the cases
 * live: too strict costs a reminder that waits until morning, too lax costs his
 * house at three. So every doubtful case below resolves to `false`.
 */
describe("verifyUrgency", () => {
  describe("what it accepts", () => {
    it("should accept a quote that is a contiguous run of his own words", () => {
      expect(verifyUrgency("wake me for this", "wake me for this one, whatever the hour")).toBe(
        true,
      );
    });

    it("should accept his whole message, quoted back unchanged", () => {
      const said = "Ping me tonight even if I am asleep.";
      expect(verifyUrgency(said, said)).toBe(true);
    });

    it("should forgive case, because she is quoting speech and not a string", () => {
      expect(verifyUrgency("WAKE ME TONIGHT", "wake me tonight, I mean it")).toBe(true);
    });

    it("should forgive punctuation on either side of the words", () => {
      expect(verifyUrgency("wake me — tonight!", "Wake me, tonight; I do not care how late")).toBe(
        true,
      );
    });

    it("should forgive the spacing between his words", () => {
      expect(verifyUrgency("wake  me\ttonight", "wake me tonight")).toBe(true);
    });

    it("should find the quote in the middle of a longer message", () => {
      expect(
        verifyUrgency(
          "whatever the hour",
          "I need the deploy checked, whatever the hour, and I mean it",
        ),
      ).toBe(true);
    });
  });

  describe("what it refuses", () => {
    it("should refuse an absent quote — the ordinary case, and the default", () => {
      expect(verifyUrgency(undefined, "remind me about Dave's birthday")).toBe(false);
    });

    it("should refuse an empty quote", () => {
      expect(verifyUrgency("", "remind me about Dave's birthday")).toBe(false);
    });

    it("should refuse a quote that is only punctuation, which normalises to nothing", () => {
      // Otherwise "!!!" would normalise to the empty string, and the empty
      // string is a substring of everything — a presence check with extra
      // steps, which is the exact defect this function exists to close.
      expect(verifyUrgency("!!!", "remind me about Dave's birthday")).toBe(false);
    });

    it("should refuse a word she wrote rather than one he did", () => {
      expect(verifyUrgency("true", "remind me about Dave's birthday")).toBe(false);
      expect(verifyUrgency("urgent", "remind me about Dave's birthday")).toBe(false);
    });

    it("should refuse her paraphrase of what he meant", () => {
      // The case that matters most: plausible, well-intentioned, and a house
      // woken at three for a friend's birthday nobody asked to be woken for.
      expect(verifyUrgency("he would want this tonight", "remind me about Dave's birthday")).toBe(
        false,
      );
    });

    it("should refuse his words in the wrong order", () => {
      // She is quoting him, not summarising him. A bag of words that happens to
      // be his is not a phrase he said.
      expect(verifyUrgency("tonight me wake", "wake me tonight")).toBe(false);
    });

    it("should refuse his words with one of hers inserted", () => {
      expect(verifyUrgency("wake me up tonight", "wake me tonight")).toBe(false);
    });

    it("should refuse a quote that only shares a word ending", () => {
      // Boundary-respecting, so a quote is matched as WORDS. "wake" must not be
      // found inside "awaken", or the match is a spelling coincidence.
      expect(verifyUrgency("wake", "do not awaken me")).toBe(false);
    });

    it("should refuse a quote longer than anything he said", () => {
      expect(verifyUrgency("wake me tonight whatever the hour", "wake me tonight")).toBe(false);
    });

    it("should refuse everything when he said nothing at all", () => {
      // The unverifiable case. Nothing to compare against is not permission —
      // a turn with no message of his behind it grants nothing.
      expect(verifyUrgency("wake me tonight", "")).toBe(false);
    });
  });
});
