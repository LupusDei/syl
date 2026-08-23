import { describe, expect, it } from "vitest";

import { AskSylIngress } from "../../src/face/ask-syl.js";

/**
 * **SHE IS SYL. Nothing we hand her may say otherwise.**
 *
 * ## The contradiction we authored
 *
 * `syl-chzl.4.10`. Her personality on Runway opens *"You are Syl."* The tool we
 * gave her was called **`ask_syl`** and described as *"Ask Syl's own mind."* So
 * we told her, in the same context, that she IS Syl and that there is a separate
 * Syl she should go and consult.
 *
 * Her transcript shows her trying to hold both at once. Session `b547219a`:
 *
 * > "I'll check with **Syl** about your tasks for today. …
 * >  I'm **Syl**, powered by Runway."
 *
 * Third person and first person about the same entity, seconds apart.
 *
 * The ask tool's description also contained the line *"say you are checking
 * before you call, so he knows **which of you** he is talking to"* — which does
 * not merely imply a second Syl, it states outright that there are two of her
 * and invites him to keep track of which one is speaking. That sentence was
 * written to be helpful and it is the most explicit instruction to fragment in
 * the whole prompt.
 *
 * ## Why a tool description and not the personality
 *
 * Established by `57bde0e` and written down in `ask-syl.ts`: **a tool
 * description is not documentation, it is the instruction the model obeys, and
 * it outranks the personality because it sits nearer the decision.** One
 * sentence about when to call a tool overrode her whole character once already.
 * That is exactly why an identity contradiction in *this* location is worth more
 * than the same words anywhere else.
 *
 * ## THE INVARIANT, NOT THE WORDING
 *
 * These tests assert the fact — nothing she is handed refers to Syl in the third
 * person, or to a second party she defers to. They deliberately do not assert
 * today's sentences. The strings will be tuned; the invariant must not move.
 */

/** Everything the model is shown: names, descriptions, and parameter descriptions. */
function everythingSheIsTold(): { readonly where: string; readonly text: string }[] {
  const tools = AskSylIngress.toolDefinitions();

  // Non-vacuity. A definitions list that came back empty would make every loop
  // below iterate zero times and pass by having nothing to check — the
  // meaningless green this project rewrote a rule about.
  expect(tools.length).toBeGreaterThan(1);

  return tools.flatMap((tool) => [
    { where: `${tool.name} (name)`, text: tool.name },
    { where: `${tool.name} (description)`, text: tool.description },
    ...tool.parameters.map((parameter) => ({
      where: `${tool.name}.${parameter.name} (description)`,
      text: parameter.description,
    })),
  ]);
}

describe("the tools she is given", () => {
  it("should never name Syl, because she is Syl", () => {
    // THE ASSERTION. `ask_syl` and "Ask Syl's own mind" would both have failed
    // here on the day they were written.
    for (const { where, text } of everythingSheIsTold()) {
      expect(
        text,
        `${where} names Syl. She IS Syl — a tool that names her is a tool that tells her ` +
          `there are two of her, in the one place that outranks her personality`,
      ).not.toMatch(/\bsyl\b/i);
    }
  });

  it("should never tell her there is more than one of her", () => {
    // "so he knows which of you he is talking to" — ours, written to be helpful,
    // and the most explicit instruction to fragment in the whole prompt.
    for (const { where, text } of everythingSheIsTold()) {
      expect(text.toLowerCase(), `${where} splits her in two`).not.toContain("which of you");
      expect(text.toLowerCase(), `${where} splits her in two`).not.toContain("one of you");
    }
  });

  it("should never name a third party she reports to or defers to", () => {
    // The heartbeat said "Tell the server the Commander just said something."
    // There is no server in her world; there is her, and him. Naming our
    // implementation to her is the same class of mistake as naming a second Syl,
    // and it arrived by the same route — a description written for a reader
    // rather than for the model that obeys it.
    for (const { where, text } of everythingSheIsTold()) {
      const lowered = text.toLowerCase();
      expect(lowered, `${where} names the server to her`).not.toContain("the server");
      expect(lowered, `${where} names the backend to her`).not.toContain("the backend");
      expect(lowered, `${where} names her own brain as a separate thing`).not.toContain(
        "main brain",
      );
    }
  });

  it("should still say the things that stop her forwarding everything", () => {
    // **The properties the current descriptions EARNED, kept.** `57bde0e` cut
    // her from forwarding every remark — including "hello" — against an
    // 8-second ceiling. A rewrite for identity that lost those would trade one
    // defect for the one that came before it.
    const [memory, heartbeat] = AskSylIngress.toolDefinitions();
    const asked = (memory?.description ?? "").toLowerCase();

    expect(asked).toContain("only");
    // The live categories, which are the whole point of calling out at all.
    for (const live of ["to-dos", "reminders", "today"]) {
      expect(asked, `the live categories no longer mention ${live}`).toContain(live);
    }
    // And the refusals, which are what made her fast.
    expect(asked).toContain("do not call");
    expect(asked, "she is no longer told her documents answer who he is").toMatch(
      /document|remember|know/,
    );

    // The heartbeat must still be invisible, or she narrates her own bookkeeping.
    expect((heartbeat?.description ?? "").toLowerCase()).toContain("never mention");
  });

  it("should keep the two tools distinguishable, so neither collapses into the other", () => {
    const tools = AskSylIngress.toolDefinitions();
    const names = tools.map((tool) => tool.name);

    // Runway requires unique names within a session, and a rename is exactly
    // where two tools quietly become one.
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      // The provider's own pattern. A name that fails it is rejected at
      // session-create, which is a face that never opens.
      expect(name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    }
  });
});
