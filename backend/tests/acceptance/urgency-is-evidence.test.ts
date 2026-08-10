import { describe, expect, it } from "vitest";

import { TOOLS } from "../../src/tools/schemas.js";

/**
 * Urgency has to be **evidence he gave**, not a field she filled in.
 *
 * `syl-j55` fixed the half that faces her: `remind_me` asks for
 * `urgentBecauseHeSaid` — his words, quoted — instead of `urgent: boolean`,
 * because a phrase can be checked against what he actually wrote and a boolean
 * cannot be checked against anything.
 *
 * **The half that enforces it does not exist**, and the obvious way to write it
 * is the wrong one. When the handler lands, `urgent: input.urgentBecauseHeSaid
 * !== undefined` is the one-liner that suggests itself, and it restores the
 * defect in full: the model satisfies a presence check by emitting any string.
 * Quoting his words is a safeguard only if something COMPARES them to what he
 * wrote. Otherwise it is a longer way of saying `true`.
 *
 * So this is declared RED against `syl-p8k`, deliberately, rather than left as
 * a note in a channel. The guard then exists **before** the handler and cannot
 * be forgotten while writing it — which is the exact shape of the failure that
 * bit us three times in one day: the check that was going to be added later.
 *
 * What it is defending is the Commander's sleep, which is the constraint most
 * likely to cost trust and the one place his anticipation order actually
 * collides with a rule. The safe answer is the default: absent, unverifiable or
 * unmatched all mean NOT urgent, and the failure mode is a reminder that waits
 * rather than a house woken at three.
 */
describe("urgency", () => {
  it("should be carried as his words rather than as her decision", () => {
    // The half that is already true, asserted so it cannot quietly revert to a
    // boolean under a later refactor. A field named for a decision invites one.
    const remind = TOOLS.find((tool) => tool.name === "remind_me");
    const properties = (remind?.inputSchema as { properties?: Record<string, { type?: string }> })
      .properties;

    expect(properties?.["urgent"], "a bare boolean is a decision, not evidence").toBeUndefined();
    expect(properties?.["urgentBecauseHeSaid"]?.type).toBe("string");
  });

  it("should reach the quiet-hours bypass only when his message actually contains those words", async () => {
    // RED until `syl-p8k`. The seam does not exist yet, and this names the
    // signature it has to have rather than describing what is there — a test
    // written against today's code would have to be rewritten to be useful,
    // and a test that asserts the current behaviour of a known defect is worse
    // than no test at all.
    const { verifyUrgency } = (await import("../../src/harness/urgency.js")) as {
      verifyUrgency: (quoted: string | undefined, hisMessage: string) => boolean;
    };

    // He said it: the bypass is his to grant.
    expect(verifyUrgency("wake me for this", "wake me for this one, whatever the hour")).toBe(true);

    // She decided it. Every one of these is a house woken at three by something
    // nobody asked to be woken for.
    expect(verifyUrgency(undefined, "remind me about Dave's birthday")).toBe(false);
    expect(verifyUrgency("", "remind me about Dave's birthday")).toBe(false);
    expect(verifyUrgency("true", "remind me about Dave's birthday")).toBe(false);
    expect(verifyUrgency("he would want this tonight", "remind me about Dave's birthday")).toBe(false);
  });
});
