import { statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_BUDGET_BYTES } from "../../src/harness/turn-context.js";
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
    // left after the identity and the working-memory cap.
    const slot = DEFAULT_CONTEXT_BUDGET_BYTES - soulBytes - WORKING_MEMORY_MAX_BYTES;

    expect(surfaceBytes()).toBeLessThanOrEqual(slot);
  });

  // A test asserting that the surface and `NO_HANDS_YET` cannot BOTH fit was
  // written here and deleted. They both fit — 3,163 + 592 against 4,018 — so it
  // asserted a numeric coincidence and called it a property. The thing it meant
  // to guard is structural and already held: `capabilityFromToolsOption`
  // returns one or the other and has no path that concatenates them, which
  // `capability.test.ts` covers by behaviour rather than by arithmetic.

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
    const reads = new Set(["whats_outstanding"]);

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
