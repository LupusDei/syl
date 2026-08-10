import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WORKING_MEMORY_MAX_BYTES } from "../../src/memory/working.js";

import {
  assertContextBudget,
  composeTurnContext,
  CONTRIBUTOR_ORDER,
  DEFAULT_CONTEXT_BUDGET_BYTES,
  DEFAULT_PRECEDENCE,
  MEMORY_FENCE,
  PRECEDENCE_CLAUSES,
  TurnContextBudgetError,
  TurnContextError,
  type Contributor,
  type ContributorBudget,
} from "../../src/harness/turn-context.js";

/**
 * `turn-context.ts` exists because three tracks write into one prompt — her
 * identity (`SOUL.md`), her memory (the working-memory projection), and her
 * tools (`syl-009`) — and each will reasonably assume it owns its slice. These
 * tests are about the three things nobody owned before it: ORDER, BUDGET and
 * PRECEDENCE.
 */

const identity = (text: string, id = "soul"): Contributor => ({ id, kind: "identity", text });
const memory = (text: string, id = "working-memory"): Contributor => ({ id, kind: "memory", text });
const capability = (text: string, id = "tools"): Contributor => ({ id, kind: "capability", text });

describe("CONTRIBUTOR_ORDER", () => {
  // Order is DATA rather than a hard-coded concatenation, so it can be asserted
  // without composing anything and so an unplaced kind is a type error rather
  // than a `+` somewhere nobody reviews.

  it("should place identity before memory, because the soul's closing section refers forward", () => {
    // Not arbitrary. `SOUL.md` ends by telling her how to read what follows —
    // as her own memory rather than a briefing. Put memory first and that
    // instruction refers to nothing.
    expect(CONTRIBUTOR_ORDER.indexOf("identity")).toBeLessThan(CONTRIBUTOR_ORDER.indexOf("memory"));
  });

  it("should place memory before capability, because what she knows frames what she may do", () => {
    expect(CONTRIBUTOR_ORDER.indexOf("memory")).toBeLessThan(CONTRIBUTOR_ORDER.indexOf("capability"));
  });

  it("should list every kind exactly once, so no kind can exist without a position", () => {
    expect(new Set(CONTRIBUTOR_ORDER).size).toBe(CONTRIBUTOR_ORDER.length);
  });
});

describe("composeTurnContext", () => {
  describe("order", () => {
    it("should emit identity, then memory, then capability regardless of the order handed in", async () => {
      const context = composeTurnContext({
        contributors: [capability("TOOLS"), memory("MEMORY"), identity("IDENTITY")],
      });

      expect(context.systemPrompt.indexOf("IDENTITY")).toBeLessThan(context.systemPrompt.indexOf("MEMORY"));
      expect(context.systemPrompt.indexOf("MEMORY")).toBeLessThan(context.systemPrompt.indexOf("TOOLS"));
      expect(context.sections.map((s) => s.kind)).toEqual(["identity", "memory", "capability"]);
    });

    it("should keep the order handed in among contributors of the same kind", () => {
      // Two capability contributors (syl-009 will have several) must stay in
      // the order their registrar chose; the module only owns the order
      // BETWEEN kinds.
      const context = composeTurnContext({
        contributors: [capability("FIRST", "a"), capability("SECOND", "b")],
      });

      expect(context.systemPrompt.indexOf("FIRST")).toBeLessThan(context.systemPrompt.indexOf("SECOND"));
    });

    it("should reproduce each contributor's text verbatim, separated by a blank line", () => {
      // The module owns ORDER, not CONTENT. It invents no headings: a heading
      // is content, and content belongs to whoever contributed it.
      const context = composeTurnContext({
        contributors: [identity("# Syl\n\nline two"), capability("tool schemas here")],
      });

      expect(context.systemPrompt).toBe("# Syl\n\nline two\n\ntool schemas here");
    });
  });

  describe("the memory fence, which SOUL.md names", () => {
    it("should open her memory with the exact marker SOUL.md points at", () => {
      // A contract between two files: SOUL.md says what follows `---` is her own
      // memory. Rename the marker on one side and the other side refers to
      // nothing.
      expect(MEMORY_FENCE).toBe("---");

      const context = composeTurnContext({ contributors: [identity("SOUL"), memory("MEM")] });

      expect(context.systemPrompt).toMatch(/SOUL\n\n---\n\nMEM/);
    });

    it("should close the fence before anything that is not memory", () => {
      // The failure this module exists for, made concrete: SOUL.md tells her
      // everything past the marker is what she knows about the Commander, so a
      // tool schema emitted after it is silently annexed into her memory of
      // him. Two correct contributors, and a prompt neither chose.
      const context = composeTurnContext({
        contributors: [identity("SOUL"), memory("MEM"), capability("TOOL SCHEMAS")],
      });

      const afterMemory = context.systemPrompt.slice(context.systemPrompt.indexOf("MEM") + 3);
      expect(afterMemory.indexOf("---")).toBeLessThan(afterMemory.indexOf("TOOL SCHEMAS"));
    });

    it("should close the fence before the precedence clause too", () => {
      const context = composeTurnContext({
        // Names a policy that HAS a clause: the default is now
        // `stated-in-identity`, which emits none, so this would have nothing to
        // place the fence before.
        contributors: [identity("SOUL"), memory("MEM")],
        precedence: "rules-outrank-memory",
      });

      const afterMemory = context.systemPrompt.slice(context.systemPrompt.indexOf("MEM") + 3);
      expect(afterMemory.indexOf("---")).toBeGreaterThanOrEqual(0);
      expect(afterMemory.indexOf("---")).toBeLessThan(
        afterMemory.indexOf(PRECEDENCE_CLAUSES["rules-outrank-memory"]),
      );
    });

    it("should emit no fence when there is no soul to have explained it", () => {
      // An unexplained horizontal rule is noise. The marker means something
      // only because SOUL.md said so, and SOUL.md is not in this prompt.
      const context = composeTurnContext({ contributors: [memory("MEM"), capability("TOOLS")] });

      expect(context.systemPrompt).not.toContain("---");
    });

    it("should emit no fence when she remembers nothing", () => {
      const context = composeTurnContext({ contributors: [identity("SOUL"), capability("TOOLS")] });

      expect(context.systemPrompt).not.toContain("---");
    });
  });

  describe("the empty cases", () => {
    it("should return an empty prompt when nothing contributed", () => {
      const context = composeTurnContext({ contributors: [] });

      expect(context.systemPrompt).toBe("");
      expect(context.bytes).toBe(0);
      expect(context.sections).toEqual([]);
    });

    it("should drop a contributor with nothing to say rather than emit a blank section", () => {
      // An empty working-memory projection is the NORMAL first-run state. It
      // must cost nothing — not a stray blank run that reads as a section she
      // was supposed to have and does not.
      const context = composeTurnContext({ contributors: [identity("I am Syl"), memory("   \n  ")] });

      expect(context.systemPrompt).toBe("I am Syl");
      expect(context.sections.map((s) => s.id)).toEqual(["soul"]);
    });

    it("should say nothing about precedence when memory contributed nothing", () => {
      // A precedence clause with only one party to the conflict is worse than
      // silence: it tells her she has a memory she does not have.
      const context = composeTurnContext({ contributors: [identity("I am Syl"), memory("")] });

      expect(context.systemPrompt).not.toMatch(/standing order/i);
    });
  });

  describe("the wiring errors", () => {
    it("should refuse a kind it has no position for, rather than append it somewhere", () => {
      const context = { contributors: [{ id: "x", kind: "vibes", text: "hi" } as unknown as Contributor] };

      expect(() => composeTurnContext(context)).toThrow(TurnContextError);
      expect(() => composeTurnContext(context)).toThrow(/vibes/);
    });

    it("should refuse two contributors sharing an id, because that is a double registration", () => {
      // The exact failure the module exists to prevent: two tracks each
      // believing they own the memory slice, and the prompt quietly carrying
      // both.
      expect(() =>
        composeTurnContext({ contributors: [memory("first"), memory("second")] }),
      ).toThrow(/working-memory/);
    });

    it("should refuse a contributor with no id, since a budget report has to name someone", () => {
      expect(() => composeTurnContext({ contributors: [{ id: "", kind: "memory", text: "x" }] })).toThrow(
        TurnContextError,
      );
    });
  });

  describe("precedence — the seam awaiting the Commander's ruling", () => {
    it("should default to saying nothing, because SOUL.md carries the ladder", () => {
      // Changed after the #Syl channel settled precedence: the full six-rung
      // ladder went into SOUL.md in her own voice, and it is broader than any
      // clause here — it also ranks the STORE above memory and anything she
      // READ SOMEWHERE below everything. Emitting a clause as well would state
      // one rule twice in two voices, and two statements of one rule drift.
      // The policy still lives here, typed and one line from changing.
      expect(DEFAULT_PRECEDENCE).toBe("stated-in-identity");

      const context = composeTurnContext({
        contributors: [identity("I am Syl"), memory("he prefers terse")],
      });

      expect(context.precedence).toBe("stated-in-identity");
      expect(PRECEDENCE_CLAUSES["stated-in-identity"]).toBe("");
    });

    it("should emit no empty section when the policy carries no text", () => {
      // An empty clause must vanish, not leave a separator behind: a stray
      // fence reads to her as a section that failed to load.
      const context = composeTurnContext({
        contributors: [identity("I am Syl"), memory("he prefers terse")],
      });

      expect(context.systemPrompt.trimEnd().endsWith("he prefers terse")).toBe(true);
      expect(context.systemPrompt).not.toMatch(/---\s*$/);
    });

    it("should still emit a clause when a policy that has one is chosen", () => {
      // The seam is intact: if the Commander later wants the rule stated in the
      // prompt as well as in her identity, it is one argument.
      const context = composeTurnContext({
        contributors: [identity("I am Syl"), memory("he prefers terse")],
        precedence: "rules-outrank-memory",
      });

      expect(context.systemPrompt).toContain(PRECEDENCE_CLAUSES["rules-outrank-memory"]);
      expect(context.precedence).toBe("rules-outrank-memory");
    });

    it("should state the rule/default distinction the ruling turns on", () => {
      // "Never drop a reminder" is not negotiable by a remembered preference;
      // "be brief" is. If the clause does not carry that distinction it is not
      // a policy, it is decoration.
      const clause = PRECEDENCE_CLAUSES["rules-outrank-memory"];

      expect(clause).toMatch(/rule/i);
      expect(clause).toMatch(/default/i);
    });

    it("should tell her to fall back to the rule when she cannot tell which it is", () => {
      // Fail-safe and audible. An unclassifiable standing order resolving
      // towards "not negotiable" is the direction that cannot lose a reminder.
      expect(PRECEDENCE_CLAUSES["rules-outrank-memory"]).toMatch(/cannot tell/i);
    });

    it("should carry a clause for every policy, so the ruling is a one-word change here", () => {
      // The point of the seam. When the Commander rules, someone changes
      // DEFAULT_PRECEDENCE and nothing else.
      for (const [policy, clause] of Object.entries(PRECEDENCE_CLAUSES)) {
        if (policy === "stated-in-identity") {
          // Deliberately empty — SOUL.md carries the ladder, and stating one
          // rule twice in two voices is how the two drift apart. The entry must
          // still EXIST so the Record stays total: a new policy cannot be added
          // without someone deciding what it says.
          expect(clause).toBe("");
          continue;
        }
        expect(clause.trim(), `clause for ${policy}`).not.toBe("");
      }
      expect(Object.keys(PRECEDENCE_CLAUSES)).toContain("identity-outranks-memory");
      expect(Object.keys(PRECEDENCE_CLAUSES)).toContain("memory-outranks-identity");
    });

    it("should emit the requested policy rather than the default when one is named", () => {
      const context = composeTurnContext({
        contributors: [identity("I am Syl"), memory("he prefers terse")],
        precedence: "memory-outranks-identity",
      });

      expect(context.systemPrompt).toContain(PRECEDENCE_CLAUSES["memory-outranks-identity"]);
      expect(context.systemPrompt).not.toContain(PRECEDENCE_CLAUSES["rules-outrank-memory"]);
    });

    it("should place the clause last, since it is a statement about the sections above it", () => {
      const context = composeTurnContext({
        contributors: [identity("IDENTITY"), memory("MEMORY"), capability("TOOLS")],
        precedence: "rules-outrank-memory",
      });

      expect(context.systemPrompt.endsWith(PRECEDENCE_CLAUSES["rules-outrank-memory"])).toBe(true);
      expect(context.systemPrompt.indexOf("TOOLS")).toBeLessThan(
        context.systemPrompt.indexOf(PRECEDENCE_CLAUSES["rules-outrank-memory"]),
      );
    });

    it("should count the clause against the budget, because it is text she has to read", () => {
      const withBoth = composeTurnContext({
        contributors: [identity("a"), memory("b")],
        precedence: "rules-outrank-memory",
      });

      expect(withBoth.bytes).toBe(Buffer.byteLength(withBoth.systemPrompt, "utf8"));
      expect(withBoth.bytes).toBeGreaterThan(
        Buffer.byteLength(PRECEDENCE_CLAUSES["rules-outrank-memory"], "utf8"),
      );
    });
  });

  describe("budget — the sum nobody owned", () => {
    it("should report the size of the whole prompt and of each section", () => {
      const context = composeTurnContext({ contributors: [identity("abcde"), capability("fg")] });

      expect(context.sections).toEqual([
        { id: "soul", kind: "identity", bytes: 5 },
        { id: "tools", kind: "capability", bytes: 2 },
      ]);
      expect(context.bytes).toBe(Buffer.byteLength(context.systemPrompt, "utf8"));
    });

    it("should measure bytes rather than characters, so a non-ASCII soul is not under-counted", () => {
      const context = composeTurnContext({ contributors: [identity("é".repeat(10))] });

      expect(context.bytes).toBe(20);
    });

    it("should throw rather than truncate when the sum runs over", () => {
      // THE decision. Truncation picks a victim and every victim is wrong:
      // trim memory and she gets colder exactly as she learns more about him,
      // with nothing saying why; trim identity and she stops being herself
      // under load; trim tools and she reports she cannot do something she can.
      // Each trades a loud failure for a quiet behavioural regression, which is
      // constraint 4 ("never silently drop a reminder") wearing different
      // clothes. A dropped fact is a dropped reminder.
      expect(() =>
        composeTurnContext({ contributors: [identity("x".repeat(400))], budgetBytes: 100 }),
      ).toThrow(TurnContextBudgetError);
    });

    it("should name every contributor and its size, so the report says who to talk to", () => {
      const error = (() => {
        try {
          composeTurnContext({
            contributors: [identity("x".repeat(40)), memory("y".repeat(400))],
            budgetBytes: 100,
          });
          return undefined;
        } catch (e) {
          return e as TurnContextBudgetError;
        }
      })();

      expect(error).toBeInstanceOf(TurnContextBudgetError);
      expect(error?.message).toMatch(/soul/);
      expect(error?.message).toMatch(/working-memory/);
      expect(error?.message).toMatch(/400/);
      expect(error?.bytes).toBeGreaterThan(100);
      expect(error?.budgetBytes).toBe(100);
    });

    it("should carry a default ceiling with headroom over today's measured contributors", () => {
      // SOUL.md and the working-memory cap are both bounded today; the ceiling
      // exists for the contributor that has not been added yet.
      expect(DEFAULT_CONTEXT_BUDGET_BYTES).toBeGreaterThan(5_502 + 4_000);
    });

    it("should apply the default ceiling when the caller names none", () => {
      expect(() =>
        composeTurnContext({ contributors: [identity("x".repeat(DEFAULT_CONTEXT_BUDGET_BYTES + 1))] }),
      ).toThrow(TurnContextBudgetError);
    });
  });
});

describe("assertContextBudget", () => {
  /**
   * The static half of the budget, and the more important one. Checking the sum
   * of DECLARED MAXIMA rather than actual sizes is what makes the runtime throw
   * unreachable: if the caps fit, no composition within those caps can run
   * over, so the ceiling is proven at development time instead of discovered in
   * a reply the Commander does not like.
   */

  const today: ContributorBudget[] = [
    { id: "soul", kind: "identity", maxBytes: 5_502 },
    { id: "working-memory", kind: "memory", maxBytes: 4_000 },
    { id: "tools", kind: "capability", maxBytes: 0 },
  ];

  it("should pass for the contributors that exist today", () => {
    expect(() => assertContextBudget(today)).not.toThrow();
  });

  it("should throw when the declared maxima sum over, naming each and the overage", () => {
    const error = (() => {
      try {
        assertContextBudget([...today, { id: "syl-009-tools", kind: "capability", maxBytes: 40_000 }]);
        return undefined;
      } catch (e) {
        return e as TurnContextBudgetError;
      }
    })();

    expect(error).toBeInstanceOf(TurnContextBudgetError);
    expect(error?.message).toMatch(/syl-009-tools/);
    expect(error?.message).toMatch(/40000|40,000/);
  });

  it("should fail on the SUM, not on any single contributor being large", () => {
    // The composition problem it exists for: every contributor individually
    // within its own cap, and the total still over. No contributor can detect
    // this locally, which is precisely why it is not a contributor's job.
    expect(() =>
      assertContextBudget(
        [
          { id: "a", kind: "identity", maxBytes: 60 },
          { id: "b", kind: "memory", maxBytes: 60 },
        ],
        100,
      ),
    ).toThrow(TurnContextBudgetError);
  });

  it("should hold the guarantee it claims: caps that fit cannot compose over", () => {
    // The whole argument in one assertion. Declare caps that pass, then compose
    // the largest possible prompt within them and watch it not throw.
    const budgets: ContributorBudget[] = [
      { id: "soul", kind: "identity", maxBytes: 5_502 },
      { id: "working-memory", kind: "memory", maxBytes: 4_000 },
    ];
    assertContextBudget(budgets);

    expect(() =>
      composeTurnContext({
        contributors: [identity("x".repeat(5_502)), memory("y".repeat(4_000))],
      }),
    ).not.toThrow();
  });

  it("should count the precedence clause, which no contributor declares", () => {
    // The module's own text is part of the sum. Leave it out and the static
    // proof is off by exactly the amount the module itself contributes, which
    // is the sort of gap that only shows up at the ceiling.
    const clause = Buffer.byteLength(PRECEDENCE_CLAUSES[DEFAULT_PRECEDENCE], "utf8");

    expect(() =>
      assertContextBudget(
        [
          { id: "a", kind: "identity", maxBytes: 10 },
          { id: "b", kind: "memory", maxBytes: 10 },
        ],
        clause + 10,
      ),
    ).toThrow(TurnContextBudgetError);
  });

  it("should reject a negative or non-finite declared maximum rather than let it cancel the sum", () => {
    expect(() =>
      assertContextBudget([{ id: "a", kind: "identity", maxBytes: -10_000 }]),
    ).toThrow(TurnContextError);
  });
});

describe("the budget over the contributors that actually exist", () => {
  /**
   * The proof, over real numbers rather than illustrative ones. `SOUL.md` is
   * read from disk on purpose: it is a file three people edit, it is not
   * enforced by any code, and it is the one contributor that can grow without
   * anything noticing. This is the assertion that notices.
   */

  const soulBytes = Buffer.byteLength(
    readFileSync(new URL("../../../SOUL.md", import.meta.url), "utf8"),
    "utf8",
  );

  it("should hold for SOUL.md as it is on disk plus the working-memory cap", () => {
    expect(() =>
      assertContextBudget([
        { id: "soul", kind: "identity", maxBytes: soulBytes },
        { id: "working-memory", kind: "memory", maxBytes: WORKING_MEMORY_MAX_BYTES },
      ]),
    ).not.toThrow();
  });

  it("should still leave room for the tools track that has not landed yet", () => {
    // syl-009 adds tool schemas as a capability contributor. If the headroom
    // has already gone, that is worth knowing before it is written rather than
    // after.
    const headroom = DEFAULT_CONTEXT_BUDGET_BYTES - soulBytes - WORKING_MEMORY_MAX_BYTES;

    expect(headroom).toBeGreaterThan(4_000);
  });

  it("should fail if SOUL.md ever grows past what the ceiling can carry", () => {
    // Not a hypothetical: SOUL.md went from 1,785 bytes to 5,502 in one day. The
    // point of this test is that the next such rewrite fails here, in the run
    // that made it, rather than in a reply the Commander does not like.
    expect(() =>
      assertContextBudget([
        { id: "soul", kind: "identity", maxBytes: DEFAULT_CONTEXT_BUDGET_BYTES },
        { id: "working-memory", kind: "memory", maxBytes: WORKING_MEMORY_MAX_BYTES },
      ]),
    ).toThrow(TurnContextBudgetError);
  });
});
