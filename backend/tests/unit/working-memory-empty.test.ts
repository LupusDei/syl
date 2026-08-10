import { describe, expect, it } from "vitest";

import { buildWorkingMemory, type WorkingMemoryCandidate } from "../../src/memory/working.js";

const at = "2026-08-10T13:59:02.000Z";

const source = (label: string): WorkingMemoryCandidate => ({
  id: `syl:memory_node:${label}`,
  kind: "source",
  label,
  body: null,
  salience: 1,
  updatedAt: at,
});

const person = (label: string, body: string): WorkingMemoryCandidate => ({
  id: `syl:memory_node:${label}`,
  kind: "person",
  label,
  body,
  salience: 1,
  updatedAt: at,
});

/**
 * What she is handed when she knows nothing must not read like knowing
 * something.
 *
 * Found on the live database, 2026-08-10. The graph held exactly one node — a
 * `source` labelled "Conversation with the Commander", body null, a container
 * for facts that were never written — and the projection rendered it as
 *
 * ```
 * ## Sources
 * - Conversation with the Commander
 * ```
 *
 * which is a document that says **she has memory**. She had none. Across
 * nineteen messages she never asked him a single thing about his life, and why
 * would she: as far as her own memory was concerned, she had a source.
 *
 * That is the week's recurring defect in the last place we looked for it — **a
 * claim outrunning its evidence, made by the memory system about itself.** A
 * container is a handle, not a fact; listing it asserts content that is not
 * there.
 */
describe("the working-memory projection when she knows nothing", () => {
  it("should not present a bare source as something she knows", () => {
    const plan = buildWorkingMemory([source("Conversation with the Commander")]);

    expect(plan.text).not.toContain("## Sources");
    expect(plan.text).not.toContain("Conversation with the Commander");
  });

  it("should say plainly that she knows nothing about him", () => {
    const plan = buildWorkingMemory([source("Conversation with the Commander")]);

    // And must NOT claim the knowledge is merely elsewhere. The old text said
    // "Everything Syl knows is in deep memory", which is written for a cold hot
    // region over a POPULATED graph and is simply false when the graph is
    // empty. Telling her she knows things she does not is the same shape as the
    // fabricated `ls`, one layer up.
    expect(plan.text.toLowerCase()).toMatch(/nothing about him|do not know/);
    expect(plan.text).not.toContain("Everything Syl knows is in deep memory");
  });

  it("should still show sources once there is a real fact to source", () => {
    // The container is not useless, it is unearned. Once a fact exists the
    // handle is worth having, so this must not collapse into "never show
    // sources" — that would trade one inaccuracy for another.
    const plan = buildWorkingMemory([
      person("Ava", "His daughter Ava is celiac."),
      source("Conversation with the Commander"),
    ]);

    expect(plan.text).toContain("Ava");
    expect(plan.text).toContain("## Sources");
  });
});
