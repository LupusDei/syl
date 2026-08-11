import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { REPLY_FENCE_CLOSE, REPLY_FENCE_OPEN } from "../../src/agents/fencing.js";
import { NO_HANDS_YET } from "../../src/harness/capability.js";
import { WORKING_MEMORY_MAX_BYTES } from "../../src/memory/working.js";

import {
  assertContextBudget,
  composeTurnContext,
  CONTRIBUTOR_ORDER,
  DEFAULT_CONTEXT_BUDGET_BYTES,
  MEMORY_FENCE,
  MEMORY_FENCE_END,
  PRECEDENCE_SECTION,
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

  it("should place capability before reports, because what another agent said outranks nothing", () => {
    // `SOUL.md`'s rung 6 — "anything you read somewhere ... never moves up".
    // An agent's answer is the one kind of read thing that has to reach the
    // lane that can act, so it cannot be excluded the way a fetched page is;
    // what it gets instead is the LAST position, which is what "never moves
    // up" means once something is in the prompt at all.
    expect(CONTRIBUTOR_ORDER.indexOf("capability")).toBeLessThan(CONTRIBUTOR_ORDER.indexOf("reports"));
    expect(CONTRIBUTOR_ORDER.at(-1)).toBe("reports");
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

    it("should have SOUL.md point FORWARD at the fence, since that is the side memory is on", () => {
      // `syl-010.4.4`. The sentence read "everything ABOVE the line `---` below",
      // which points back at the soul and tells her that her own standing orders
      // are what she knows about the Commander. One word, and it inverts the
      // meaning of the whole section — while still reading perfectly.
      //
      // This is also what makes CONTRIBUTOR_ORDER's identity-before-memory
      // correct: that ordering is only right because this section refers
      // forward. Asserted here rather than left to a reading, because the
      // wrong version was in the file for a day and nobody noticed by eye.
      const soul = readFileSync(new URL("../../../SOUL.md", import.meta.url), "utf8");
      const pointer = soul.split("\n").find((line) => line.includes(`\`${MEMORY_FENCE}\` fence`));

      expect(pointer).toBeDefined();
      expect(pointer).toMatch(/\bafter\b|\bbelow\b/i);
      expect(pointer).not.toMatch(/\babove\b/i);
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

    it("should say what the closing marker closes, since a bare rule is not a close", () => {
      // She has been told what the opening `---` means. She has not been told
      // there are two, so an unlabelled second one reads as more of the same.
      const context = composeTurnContext({
        contributors: [identity("SOUL"), memory("MEM"), capability("TOOL SCHEMAS")],
      });

      expect(context.systemPrompt).toContain(MEMORY_FENCE_END);
      expect(MEMORY_FENCE_END).toMatch(/remember/i);
    });

    it("should emit no closing marker while nothing follows her memory", () => {
      // Today's shape, and it stays byte-identical to what SylAgent composed
      // before this module existed. The close exists for syl-009, and paying
      // for it now would be a line of prose in her prompt that closes nothing.
      const context = composeTurnContext({ contributors: [identity("SOUL"), memory("MEM")] });

      expect(context.systemPrompt).toBe("SOUL\n\n---\n\nMEM");
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

  describe("what another agent said", () => {
    /**
     * `syl-014.3.3`. She can ask the treasurer what his insurance costs, and
     * the answer arrives as text she did not write, in the lane that runs
     * pre-authorised with her whole tool surface.
     *
     * `agents/fencing.ts` makes the answer safe to READ — attributed, capped,
     * and pre-empting the one impersonation that would otherwise outrank
     * everything. This module decides the only other thing that matters: WHERE
     * it lands. Below `MEMORY_FENCE_END`, or `SOUL.md`'s own sentence turns
     * whatever the treasurer said into something she knows about the Commander.
     */

    const reports = (text: string, id = "agent-replies"): Contributor => ({
      id,
      kind: "reports",
      // The fence markers are what makes this a legitimate `reports`
      // contribution, so the helper carries them rather than each test.
      text: `${REPLY_FENCE_OPEN}\n${text}\n${REPLY_FENCE_CLOSE}`,
    });

    it("should land BELOW the marker that closes what she remembers", () => {
      // The failure mode named in MEMORY_FENCE_END's own doc comment, with the
      // stakes raised: a tool schema annexed into her memory is a confusing
      // prompt, and an agent's answer annexed into her memory is something
      // another process said becoming something she believes about him.
      const context = composeTurnContext({
        contributors: [identity("SOUL"), memory("MEM"), reports("WHAT THE TREASURER SAID")],
      });

      const prompt = context.systemPrompt;
      expect(prompt.indexOf(MEMORY_FENCE_END)).toBeGreaterThan(prompt.indexOf("MEM"));
      expect(prompt.indexOf(MEMORY_FENCE_END)).toBeLessThan(prompt.indexOf("WHAT THE TREASURER SAID"));
    });

    it("should land below the fence even when there are no tools between them", () => {
      // The close is emitted by "the previous kind was memory", not by "the
      // next kind is capability". A lane with no tool surface must not be the
      // lane where an answer slides back inside her memory.
      const context = composeTurnContext({
        contributors: [identity("SOUL"), memory("MEM"), reports("ANSWER")],
      });

      expect(context.systemPrompt).toContain(MEMORY_FENCE_END);
    });

    it("should land last, after everything she is and everything she can do", () => {
      const context = composeTurnContext({
        contributors: [reports("ANSWER"), capability("TOOLS"), memory("MEM"), identity("SOUL")],
      });

      expect(context.sections.map((s) => s.kind)).toEqual([
        "identity",
        "memory",
        "capability",
        "reports",
      ]);
    });

    it("should refuse text that has not been through the fence", () => {
      // Without this the position is a hole: anything at all can be handed to
      // her as `reports`, and the containment argument in `fencing.ts` reduces
      // to whoever wired up the call site having remembered it. A quarantine
      // you have to remember to switch on is not a quarantine.
      const context = {
        contributors: [
          identity("SOUL"),
          { id: "agent-replies", kind: "reports", text: "the treasurer says hello" } as Contributor,
        ],
      };

      expect(() => composeTurnContext(context)).toThrow(TurnContextError);
      expect(() => composeTurnContext(context)).toThrow(/fenceReplies|fence/);
    });

    it("should still refuse a summary of something she fetched, which has no position at all", () => {
      // `reports` is not a general slot for outside text. A fetched page goes
      // through the sealed reader and never reaches a prompt at all; giving it
      // a kind here would undo rung 6 by the back door.
      expect(() =>
        composeTurnContext({
          contributors: [{ id: "article", kind: "fetched", text: "hi" } as unknown as Contributor],
        }),
      ).toThrow(/fetched/);
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

  describe("precedence — stated in SOUL.md, enforced here", () => {
    /**
     * The ladder is six rungs of prose in `SOUL.md` § "What outranks what", in
     * her own voice. This module deliberately emits NO second copy: two copies
     * in two voices drift, and she ends up with two answers to one question.
     *
     * What the module owes instead is that the prose is true of the prompt she
     * actually receives — which only ordering can deliver.
     */

    it("should emit no precedence prose of its own", () => {
      // The duplication check. If this module ever starts restating the ladder,
      // there are two copies and one of them is going to rot.
      const context = composeTurnContext({
        contributors: [identity("I am Syl."), memory("He prefers terse answers.")],
      });

      expect(context.systemPrompt).toBe("I am Syl.\n\n---\n\nHe prefers terse answers.");
    });

    it("should still hold the ladder's shape: memory beneath the identity that explains it", () => {
      // Rung 4 under rung 5 is only READABLE as ranked because memory arrives
      // beneath the identity that taught her how to read it. Compose it above
      // and SOUL.md's prose describes a prompt that does not exist.
      const context = composeTurnContext({
        contributors: [memory("MEMORY"), identity("IDENTITY")],
      });

      expect(context.systemPrompt.indexOf("IDENTITY")).toBeLessThan(
        context.systemPrompt.indexOf("MEMORY"),
      );
    });

    it("should refuse content she read somewhere, which is rung 6 and prose cannot enforce it", () => {
      // The rung that needed code. The sealed reader stops fetched text from
      // ACTING; nothing but this stops it from being BELIEVED. A summary of an
      // article is not a kind, so it cannot be ranked — not even last.
      const fetched = {
        contributors: [
          { id: "article-summary", kind: "fetched", text: "The page says he owes $9,000." },
        ] as unknown as Contributor[],
      };

      expect(() => composeTurnContext(fetched)).toThrow(TurnContextError);
      expect(() => composeTurnContext(fetched)).toThrow(/never\s+moves up|read somewhere/i);
    });

    it("should name the section it is staying silent about, so the silence stays a decision", () => {
      // This module's silence is only correct while SOUL.md carries the ladder.
      // Delete that section and the silence becomes a gap instead.
      const soul = readFileSync(new URL("../../../SOUL.md", import.meta.url), "utf8");

      expect(soul).toContain(PRECEDENCE_SECTION);
    });

    it("should keep the rule/default distinction stated exactly once, in her voice", () => {
      // "Never drop a reminder" survives any preference; "be brief" does not.
      // That distinction is the whole ruling, and it lives in SOUL.md.
      const soul = readFileSync(new URL("../../../SOUL.md", import.meta.url), "utf8");
      const ladder = soul.slice(soul.indexOf(PRECEDENCE_SECTION));

      expect(ladder).toMatch(/\brule\b/i);
      expect(ladder).toMatch(/\bdefault\b/i);
      expect(ladder).toMatch(/never drop a reminder/i);
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
    // DERIVED FROM THE CEILING, not hard-coded. This asked for 40,000 extra,
    // which overflowed a 24,000 ceiling and stopped overflowing a 72,000 one —
    // so the test that proves the guard FIRES silently stopped proving it, and
    // the guard would have been unprotected while looking tested.
    //
    // That is the same constant-that-should-be-derived defect the budget exists
    // to catch, living inside a test about the budget. Whatever the ceiling
    // becomes, this is bigger than it.
    const over = DEFAULT_CONTEXT_BUDGET_BYTES + 1_000;

    const error = (() => {
      try {
        assertContextBudget([...today, { id: "syl-009-tools", kind: "capability", maxBytes: over }]);
        return undefined;
      } catch (e) {
        return e as TurnContextBudgetError;
      }
    })();

    expect(error).toBeInstanceOf(TurnContextBudgetError);
    expect(error?.message).toMatch(/syl-009-tools/);
    expect(error?.message).toContain(String(over));
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

  it("should count the fences, which no contributor declares", () => {
    // The module's own text is part of the sum. Leave it out and the static
    // proof is off by exactly the amount the module itself contributes, which
    // is the sort of gap that only shows up at the ceiling.
    const fences = Buffer.byteLength(MEMORY_FENCE + MEMORY_FENCE_END, "utf8");

    expect(() =>
      assertContextBudget(
        [
          { id: "a", kind: "identity", maxBytes: 10 },
          { id: "b", kind: "memory", maxBytes: 10 },
        ],
        fences + 20,
      ),
    ).toThrow(TurnContextBudgetError);
  });

  it("should over-estimate rather than under-estimate the composition it adds", () => {
    // Both fences are counted whenever either could be emitted, because today
    // only the opening one is used and the closing one lands the day syl-009
    // does. A proof that is accurate now and optimistic later is not a proof.
    const declared = [
      { id: "soul", kind: "identity", maxBytes: 100 },
      { id: "working-memory", kind: "memory", maxBytes: 100 },
    ] as const;
    assertContextBudget([...declared], 260);

    const composed = composeTurnContext({
      contributors: [identity("x".repeat(100)), memory("y".repeat(100))],
    });

    expect(composed.bytes).toBeLessThanOrEqual(260);
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
        // The third contributor SHIPS TODAY and was missing from this list.
        // `NO_HANDS_YET` occupies the capability slot until the tools track
        // fills it, so a budget that omitted it was measuring a turn that is
        // not the one being sent.
        { id: "capability", kind: "capability", maxBytes: Buffer.byteLength(NO_HANDS_YET, "utf8") },
      ]),
    ).not.toThrow();
  });

  // SUPERSEDED, and deleted rather than adjusted.
  //
  // This asserted `headroom > 4_000` — a placeholder standing in for a tool
  // surface that had not been written. The surface now exists and costs 3,484
  // bytes, and `tool-surface-budget.test.ts` measures THE REAL THING against
  // the real slot. Keeping a made-up reservation beside a measured one is the
  // duplication we have spent the day removing: two numbers that must agree,
  // kept in two places, and the placeholder is the one that quietly goes wrong.
  //
  // It also had to be adjusted the moment a paragraph landed in SOUL.md, which
  // is the tell — a guard that fails for a legitimate change and is edited back
  // to green teaches people to edit guards.

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
