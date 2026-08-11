import { describe, expect, it } from "vitest";

import { describeCapability, NO_HANDS_YET } from "../../src/harness/capability.js";

/**
 * The third instance of one bug, and the first fix that cannot recur.
 *
 * Twice in one day an instruction outlived the capability it assumed, and both
 * times the failure was PROSE — she acted the instruction out instead of
 * failing. Auto-memory told her to keep a memory file after `--tools ""` took
 * the tools that needed: she emitted a fabricated `ls`. `SOUL.md` tells her she
 * owns his to-dos and his reminders before any verb for them exists: she says
 * "I've added that" and writes nothing.
 *
 * Opposite polarity, same shape, and neither is catchable by assertion because
 * the artefact is a sentence.
 *
 * The reflex fix is a line in `SOUL.md` saying she cannot act yet — and artanis
 * was right to refuse it, because that line goes stale the day the tools land
 * and becomes the fourth instance of the same bug. But the conclusion "wait for
 * the tools" leaves the Commander using her while she makes claims she cannot
 * keep, and an assistant that says it did something it did not is worse than
 * one that cannot.
 *
 * So neither hand-written line. **The capability sentence is DERIVED from the
 * surface that is actually attached**, which makes staleness unrepresentable:
 * there is no hand-written claim left to go out of date, in either direction,
 * ever. That is the difference between fixing the instance and closing the
 * class.
 */
describe("describeCapability", () => {
  it("should say plainly that she cannot act when no tool is attached", () => {
    const text = describeCapability([]);

    expect(text).toBe(NO_HANDS_YET);
    expect(text).not.toBe("");
  });

  it("should tell her to say so rather than claim the act, since prose is where this fails", () => {
    // The specific failure being prevented, in the Commander's own use: he
    // asked for a reminder in five minutes and she answered like an assistant
    // who had set one. The sentence has to pre-empt the claim, not merely
    // report the limitation, because the limitation alone still leaves "I've
    // added that to your list" as a fluent thing to say.
    const text = describeCapability([]);

    expect(text).toMatch(/say so/i);
    expect(text).toMatch(/cannot|can't|no way/i);
  });

  it("should never deny acting once a tool exists", () => {
    // The staleness direction that bit auto-memory, now impossible: the text is
    // a function of the surface, so it cannot go on denying a capability that
    // has arrived. Nobody has to remember to delete a line.
    const text = describeCapability(["create_reminder"]);

    expect(text).not.toBe(NO_HANDS_YET);
    expect(text).not.toMatch(/cannot|can't|no way to act/i);
  });

  it("should name every attached tool and invent none", () => {
    // Both directions of honesty in one assertion. A tool she is not told about
    // is a tool she will not use; a tool named but absent is the fabricated
    // `ls` again, one layer up.
    const attached = ["create_reminder", "add_todo", "list_todos"];

    const text = describeCapability(attached);

    for (const name of attached) expect(text).toContain(name);
    expect(text).not.toContain("search_web");
  });

  it("should hold the property for any surface, which is the point of deriving it", () => {
    // The class-level guarantee, stated as a property rather than as examples:
    // for EVERY surface, the text agrees with that surface. A hand-written line
    // can satisfy any finite set of examples and still be wrong tomorrow.
    const surfaces = [[], ["a"], ["a", "b"], ["create_reminder", "add_todo", "list_todos", "search"]];

    for (const surface of surfaces) {
      const text = describeCapability(surface);

      expect(text.trim(), `surface of ${surface.length}`).not.toBe("");
      for (const name of surface) expect(text, `surface of ${surface.length}`).toContain(name);
      // Empty surface and only an empty surface may say she cannot act.
      expect(/no way to act/i.test(text), `surface of ${surface.length}`).toBe(surface.length === 0);
    }
  });

  it("should not describe its own mechanism to her", () => {
    // She is not solemn about herself (`SOUL.md`). "Your tool surface is
    // currently empty" is a sentence about her construction; "you have no way
    // to act on any of it yet" is a sentence about her situation. The second is
    // the one a person says.
    const text = describeCapability([]);

    for (const leak of ["tool surface", "MCP", "--tools", "capability contributor", "configured"]) {
      expect(text.toLowerCase(), `leaks "${leak}"`).not.toContain(leak.toLowerCase());
    }
  });
});
