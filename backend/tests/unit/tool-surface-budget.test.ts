import { statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AGENT_REPLIES_MAX_BYTES } from "../../src/agents/reply-contributor.js";
import {
  assertContextBudget,
  DEFAULT_CONTEXT_BUDGET_BYTES,
  type ContributorBudget,
} from "../../src/harness/turn-context.js";
import { WORKING_MEMORY_MAX_BYTES } from "../../src/memory/working.js";
import { surfaceBytes, TOOLS } from "../../src/tools/schemas.js";

const soulBytes = statSync(new URL("../../../SOUL.md", import.meta.url)).size;

/**
 * The tool surface against the two rules it has to keep, neither of which was
 * checked by anything.
 *
 * The surface fits the budget **today** — 3,163 of 4,018 — and the fit was
 * arithmetic in a channel message rather than an assertion. That is the same
 * shape as the stale build: correct now, silently wrong later, and wrong in a
 * way every other check still passes through. The number moves whenever
 * `SOUL.md` gains a paragraph or a verb gains a field, and it is a promise
 * between two tracks, which is exactly the kind of promise that needs a test
 * rather than a memory.
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
      DEFAULT_CONTEXT_BUDGET_BYTES - soulBytes - WORKING_MEMORY_MAX_BYTES - AGENT_REPLIES_MAX_BYTES;

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
      { id: "tools", kind: "capability", maxBytes: surfaceBytes() },
      { id: "agent-replies", kind: "reports", maxBytes: AGENT_REPLIES_MAX_BYTES },
    ];

    expect(() => assertContextBudget(real)).not.toThrow();
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
    const reads = new Set(["whats_outstanding", "recall"]);

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
