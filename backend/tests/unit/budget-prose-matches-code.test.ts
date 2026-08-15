import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGENT_REPLIES_MAX_BYTES } from "../../src/agents/reply-contributor.js";
import { MAX_REPLY_BYTES } from "../../src/agents/fencing.js";

/**
 * **A budget written in prose must agree with the budget written in code.**
 *
 * `turn-context.ts` carries a markdown table of what each contributor is
 * allowed. Nothing compared that table to the constants, so the two drifted:
 * the table said agent replies got 4,800 bytes while `AGENT_REPLIES_MAX_BYTES`
 * enforced 2,800. The docstring on the constant ITSELF said "this takes 4,800
 * of it" directly above `= 2_800`.
 *
 * That is not a documentation nit, and it is worth writing down what it cost.
 * A research answer about which restaurants are safe for a five-year-old with
 * coeliac disease reached Syl truncated at the enforced number. **The cut kept
 * the recommendations and removed the corrections**, because corrections come
 * last — including a warning that the top recommendation appeared to have
 * closed. She noticed only because the cut landed mid-document; ending on a
 * clean sentence would have read as complete.
 *
 * The existing guard in `tool-surface-budget.test.ts` asks whether the sum
 * FITS. That is a different question, and it stayed true throughout: 2,800 fits
 * just as well as 4,800. Fitting is not agreeing.
 *
 * So this file asserts the narrower thing — that every number the prose
 * ATTRIBUTES to a contributor is the number that contributor actually enforces.
 * It reads the source as TEXT rather than importing it, because the claim under
 * test is about what a person reading the file is told.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const TURN_CONTEXT = readFileSync(join(here, "..", "..", "src", "harness", "turn-context.ts"), "utf8");

/**
 * Pull `| agent replies | ... | 4,800 | ... |` out of the budget tables.
 *
 * The tables are historical — each raise added another one — so a row name can
 * appear several times with different values, and only the LAST occurrence is a
 * claim about today. The earlier ones are a record of what the number used to
 * be, which must not be rewritten.
 */
function lastClaimedBudget(rowName: string): number | null {
  const rows = [...TURN_CONTEXT.matchAll(new RegExp(`\\|\\s*${rowName}\\s*\\|[^\\n]*`, "g"))];
  const last = rows.at(-1)?.[0];
  if (last === undefined) return null;

  // BY COLUMN, NOT BY "THE LAST NUMBER IN THE ROW". The first version of this
  // scan took the last number it could find and read `syl-014` in the why
  // column as a budget of 14 — a detector that failed for a reason unrelated to
  // the thing it was checking, which would have been mistaken for the drift it
  // is meant to find. The rows are `| contributor | before | after | why |`, so
  // the current value is the THIRD cell and nothing else is a candidate.
  const cells = last
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  const current = cells[2];
  if (current === undefined) return null;

  const digits = /^~?([\d,]+)$/.exec(current);
  if (digits === null || digits[1] === undefined) return null;
  const value = Number(digits[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

describe("the budget in the prose and the budget in the code", () => {
  it("should attribute to agent replies exactly what the contributor enforces", () => {
    const claimed = lastClaimedBudget("agent replies");

    expect(
      claimed,
      "no `| agent replies |` row found in turn-context.ts — if the row was renamed, rename it here too",
    ).not.toBeNull();

    expect(
      claimed,
      `turn-context.ts tells the reader agent replies get ${String(claimed)} bytes; ` +
        `reply-contributor.ts enforces ${String(AGENT_REPLIES_MAX_BYTES)}. ` +
        "Change the table and the constant together, or the next person sizes a reply against a number that is not real.",
    ).toBe(AGENT_REPLIES_MAX_BYTES);
  });

  it("should keep the track big enough for one whole answer, which is the point of it", () => {
    // The failure this whole file exists for was a SINGLE answer not fitting.
    // A track sized below one fenced reply cannot deliver one, however the
    // arithmetic is arranged — she gets an omission note where the answer was.
    expect(
      AGENT_REPLIES_MAX_BYTES,
      `the track (${String(AGENT_REPLIES_MAX_BYTES)}) must exceed one reply at its cap ` +
        `(${String(MAX_REPLY_BYTES)}), with room for the fence and the omission note`,
    ).toBeGreaterThan(MAX_REPLY_BYTES);
  });

  it("should have found a real table, so a broken scan cannot pass quietly", () => {
    // Both assertions above are vacuous if the regex matches nothing. This is
    // the same defect in miniature: a guard that cannot fail is not a guard.
    expect(TURN_CONTEXT).toContain("| agent replies |");
    expect(lastClaimedBudget("working memory")).toBeGreaterThan(0);
  });
});
