import { statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AGENT_REPLIES_MAX_BYTES } from "../../src/agents/reply-contributor.js";
import {
  assertContextBudget,
  DEFAULT_CONTEXT_BUDGET_BYTES,
  type ContributorBudget,
} from "../../src/harness/turn-context.js";
import { UNATTENDED_MAX_BYTES } from "../../src/jobs/unattended-contributor.js";
import { WORKING_MEMORY_MAX_BYTES } from "../../src/memory/working.js";
import { surfaceBytes, TOOLS } from "../../src/tools/schemas.js";

const soulBytes = statSync(new URL("../../../SOUL.md", import.meta.url)).size;

/**
 * The tool surface against the two rules it has to keep, neither of which was
 * checked by anything.
 *
 * The surface fits the budget **today** — it was 3,163 of 4,018 when this file
 * was written — and the fit was arithmetic in a channel message rather than an
 * assertion. That is the same shape as the stale build: correct now, silently
 * wrong later, and wrong in a way every other check still passes through. The
 * number moves whenever `SOUL.md` gains a paragraph or a verb gains a field, and
 * it is a promise between two tracks, which is exactly the kind of promise that
 * needs a test rather than a memory.
 *
 * **No figure in this comment is load-bearing and every one of them is stale.**
 * The assertions below compute from the live constants, deliberately; the
 * numbers here are only there to say what kind of quantity is being talked
 * about. The last measurement that mattered: `syl-8ys9.1.4` doubled
 * `how_has_he_been`'s `types` enum from seven health types to fourteen and moved
 * the surface by **100 bytes**, 18,909 to 19,009, against a capability slot of
 * 52,046 and 23,037 bytes of headroom above the 10% margin. So the ceiling did
 * not move, and a widening of that shape does not need it to — which is the
 * answer this file exists to hand over rather than have re-derived.
 */
describe("the tool surface", () => {
  it("should fit the capability slot with the rest of the turn in place", () => {
    // Measured the way the budget counts, not estimated: the slot is what is
    // left after the identity, the working-memory cap, and — since
    // `syl-014.3.3` — the room an agent's answer needs when one arrives.
    //
    // The reply slot is subtracted whether or not an agent has answered today.
    // A budget that only holds on the turns where nobody replied is not a
    // budget; it is a coincidence that fails on the first useful turn.
    const slot =
      DEFAULT_CONTEXT_BUDGET_BYTES -
      soulBytes -
      WORKING_MEMORY_MAX_BYTES -
      AGENT_REPLIES_MAX_BYTES -
      UNATTENDED_MAX_BYTES;

    expect(surfaceBytes()).toBeLessThanOrEqual(slot);
  });

  // A test asserting that the surface and `NO_HANDS_YET` cannot BOTH fit was
  // written here and deleted. They both fit — 3,163 + 592 against 4,018 — so it
  // asserted a numeric coincidence and called it a property. The thing it meant
  // to guard is structural and already held: `capabilityFromToolsOption`
  // returns one or the other and has no path that concatenates them, which
  // `capability.test.ts` covers by behaviour rather than by arithmetic.

  it("should leave the whole turn inside its ceiling, counted over the real constants", () => {
    // `assertContextBudget` is documented as being called "at boot and in a
    // unit test". Nothing called it with the REAL numbers — every existing call
    // uses invented ones — so the four contributors that actually exist had
    // never been added up anywhere, and the arithmetic that said they fit lived
    // in a plan document. Same shape as the stale build: right when written,
    // silently wrong later, and every other check still green.
    const real: ContributorBudget[] = [
      { id: "soul", kind: "identity", maxBytes: soulBytes },
      { id: "working-memory", kind: "memory", maxBytes: WORKING_MEMORY_MAX_BYTES },
      { id: "unattended-work", kind: "ledger", maxBytes: UNATTENDED_MAX_BYTES },
      { id: "tools", kind: "capability", maxBytes: surfaceBytes() },
      { id: "agent-replies", kind: "reports", maxBytes: AGENT_REPLIES_MAX_BYTES },
    ];

    expect(() => assertContextBudget(real)).not.toThrow();
  });

  it("should keep a margin worth having, not merely fit", () => {
    // The half nothing checked, and the one that went wrong. The budget's own
    // prose claimed ~2,950 bytes of margin while the real figure had fallen to
    // about 600 — `SOUL.md` and the surface had each grown by a thousand bytes
    // and every test still passed, because "does it fit" is true right up to
    // the moment it is not.
    //
    // A stated margin that nothing asserts is a comment. This makes the next
    // contributor's author read the paragraph rather than discover the number
    // in a reply.
    const declared =
      soulBytes +
      WORKING_MEMORY_MAX_BYTES +
      UNATTENDED_MAX_BYTES +
      surfaceBytes() +
      AGENT_REPLIES_MAX_BYTES;

    // THE MARGIN IS A FRACTION, NOT A CONSTANT — and it used to be 2,000.
    //
    // 2,000 was 8% of a 24,000 ceiling. At 40,000 it is 5%, and at whatever
    // comes next it is less again: a margin that does not scale with the thing
    // it protects stops being a margin without anybody changing it. That is the
    // same defect this file exists to catch — a constant that is really a
    // derived value — sitting inside the guard against it.
    //
    // A floor as well as a fraction, because on a small ceiling a percentage is
    // not enough room to write a sentence in.
    const margin = Math.max(2_000, Math.floor(DEFAULT_CONTEXT_BUDGET_BYTES / 10));

    // AND IT INSTRUCTS RATHER THAN MERELY REFUSING. artanis's point, and the
    // reason is measured: this constant has been set five times in two days,
    // and four of the five people who did the subtraction by hand got a number
    // that was stale before they finished. The next person should be handed the
    // answer, itemised, at the only moment anyone reads this — which is also
    // the only moment its derived nature is visible.
    //
    // Deliberately NOT auto-derived. A ceiling that grows to fit whatever is
    // put under it is not a budget. The test says what the number would have to
    // be; a person still has to decide to accept it.
    const shortfall = DEFAULT_CONTEXT_BUDGET_BYTES - declared - margin;
    expect(
      shortfall,
      shortfall >= 0
        ? "fits"
        : [
            `The turn does not fit. Set DEFAULT_CONTEXT_BUDGET_BYTES to at least ${String(declared + margin)}.`,
            `  SOUL.md            ${String(soulBytes)}`,
            `  working memory     ${String(WORKING_MEMORY_MAX_BYTES)}`,
            `  unattended         ${String(UNATTENDED_MAX_BYTES)}`,
            `  tool surface       ${String(surfaceBytes())}`,
            `  agent replies      ${String(AGENT_REPLIES_MAX_BYTES)}`,
            `  declared total     ${String(declared)}`,
            `  margin (10%)       ${String(margin)}`,
            `  ceiling now        ${String(DEFAULT_CONTEXT_BUDGET_BYTES)}`,
            `  short by           ${String(-shortfall)}`,
            "",
            "Raise it in the channel before the file — it has been set by five",
            "people in two days and collided twice.",
          ].join("\n"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("should require a reason on every verb that changes something", () => {
    // artanis's own rule, stated when the schemas shipped: "Every write takes
    // `because`, and it is REQUIRED... an optional field for the thing that
    // makes the feature trustworthy is a field that goes unfilled at 3am."
    //
    // It is the field the Commander's anticipation order rests on — "Dave's
    // birthday is Thursday, you mentioned him in March" is a gift and "I made
    // you a reminder" is not — and it was true of four verbs out of six.
    //
    // Guarded by SHAPE rather than by a list of names, so a seventh verb added
    // next month is covered without anyone remembering this file exists. A rule
    // that has to be re-applied by hand is the rule that was already missed.
    // The verbs that CHANGE NOTHING, and the only grounds for exemption. Both
    // are looks: one at what he has open, one at what she already knows.
    // Requiring a reason to look would teach her the field is decoration, and
    // a field she fills out of habit is worth nothing on the verbs where it is
    // load-bearing — which is every other one on this surface.
    //
    // `see_myself` and `recall` join it: looking at a render she already made,
    // or at what she already knows, changes nothing and spends nothing.
    // Requiring a reason to look at her own face would turn the one thing
    // `SOUL.md` tells her to do often into paperwork. `render_me` is a write
    // and carries `because` like the rest.
    // `how_has_he_been` joins them: looking at his body changes nothing and spends
    // nothing, and requiring a reason to look would make her check less often --
    // which is precisely when she is most likely to say something wrong about it.
    const reads = new Set(["whats_outstanding", "see_myself", "recall", "how_has_he_been"]);

    for (const tool of TOOLS) {
      if (reads.has(tool.name)) continue;

      const required = (tool.inputSchema as { required?: readonly string[] }).required ?? [];

      expect(required, `${tool.name} changes something and must say why`).toContain("because");
    }
  });

  it("should describe itself in terms of him, never of a store", () => {
    // Names and descriptions are personality, not documentation: a model infers
    // what it is FOR from its verbs. This is the cheap half of that — the half
    // a test can hold — so that the expensive half stays a judgement call made
    // by someone reading them aloud.
    for (const tool of TOOLS) {
      expect(tool.description.trim(), `${tool.name} has no description`).not.toBe("");

      // Deliberately no "GET": it matched "must not forGET a thing" on the
      // first run. A guard that fires on ordinary English gets softened the
      // second time it is inconvenient, and a softened guard is worse than an
      // absent one because it still reads as protection.
      for (const leak of ["API", "endpoint", "database", "SQL", "POST /", "HTTP"]) {
        expect(tool.description.toLowerCase(), `${tool.name} leaks "${leak}"`).not.toContain(
          leak.toLowerCase(),
        );
      }
    }
  });
});
