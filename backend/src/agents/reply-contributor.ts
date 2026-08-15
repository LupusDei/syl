import type { Contributor } from "../harness/turn-context.js";
import { fenceReplies, MAX_REPLY_BYTES, type AgentReply } from "./fencing.js";

/**
 * Fenced answers, bounded, as one contribution to her turn.
 *
 * ## Why this is not just `fenceReplies`
 *
 * `fencing.ts` makes ONE batch safe to read — attributed, per-reply capped, and
 * pre-empting an agent claiming to speak for the Commander. It says nothing
 * about how many answers there are, and it cannot: it is handed a batch and
 * fences what it is given.
 *
 * The budget in `turn-context.ts` is a promise about the SUM, and it is proven
 * over each contributor's DECLARED CEILING. A contributor with no ceiling turns
 * that proof into a decoration. Ten answers at the per-reply cap is 40 KB into
 * a 24 KB prompt — an injection by volume with nothing hostile in it, just a
 * fleet that had a busy afternoon.
 *
 * ## Where the answers land, and why
 *
 * Kind `reports`, which `CONTRIBUTOR_ORDER` places LAST — below her identity,
 * below `MEMORY_FENCE_END`, and below her tools. Two separate reasons, and both
 * are needed:
 *
 * - **Below the memory fence**, or `SOUL.md`'s own sentence ("everything after
 *   the fence is what you currently know about him") annexes whatever the
 *   treasurer said into what she knows about the Commander. That is
 *   `turn-context.ts`'s documented failure mode, with the stakes raised: a tool
 *   schema annexed into her memory is a confusing prompt; an answer annexed
 *   into her memory is another process's text becoming something she believes
 *   about him.
 * - **Last**, because `SOUL.md`'s rung 6 says a thing she read never moves up.
 *   An agent's answer is the one kind of read thing that must reach the lane
 *   that can act — that is the whole point of the verb — so it cannot be
 *   excluded the way a fetched page is. What it gets instead is the bottom.
 *
 * ## What being dropped here does and does not mean
 *
 * Dropping an answer from ONE TURN is not dropping it. Delivery to the
 * Commander goes through the outbox, which honours quiet hours and never
 * silently drops (CLAUDE.md constraint 4); this decides only what fits in front
 * of her at once. But she must be able to say so, so the omission is stated
 * rather than quiet — otherwise she summarises the half she was given and calls
 * it everything the fleet said.
 */

/**
 * The most this contributor will ever emit.
 *
 * Sized to hold **one answer at the per-reply cap, fenced, with the omission
 * note**. That is the floor: below it, a single long answer fits nowhere and
 * she is shown an omission note instead of the thing she asked for.
 * `tests/unit/reply-contributor.test.ts` asserts the floor still holds, so a
 * preamble that grows in `fencing.ts` fails there rather than in a turn.
 *
 * **Raised from 2,800 on 2026-08-15, on the Commander's instruction, after the
 * floor turned out to be the ceiling in practice.** A research answer about
 * which restaurants are safe for his coeliac five-year-old was truncated to fit
 * — and the cut kept the recommendations while removing the corrections,
 * because corrections come last. One of those corrections was that the top
 * recommendation appeared to have closed. See `MAX_REPLY_BYTES` in
 * `fencing.ts` for the full account.
 *
 * The docstring this replaces claimed "this takes 4,800 of it" directly above
 * `= 2_800`, and the budget table in `turn-context.ts` repeated the 4,800.
 * Nothing compared them, because the existing guard asks only whether the sum
 * FITS — and 2,800 fits exactly as well as 4,800 does. Fitting is not agreeing.
 * `tests/unit/budget-prose-matches-code.test.ts` now asserts the narrower
 * thing, so the next edit to either number fails in the test run of whoever
 * makes it.
 *
 * There is room: the declared contributors come to roughly 30,500 against a
 * `DEFAULT_CONTEXT_BUDGET_BYTES` of 100,000, so this reservation is affordable
 * several times over. `tests/unit/tool-surface-budget.test.ts` proves the sum
 * over the real constants and states what the ceiling would have to become —
 * a loud failure in the test run of whoever adds the next verb, rather than a
 * quiet one in a reply the Commander does not like.
 */
export const AGENT_REPLIES_MAX_BYTES = 20_000;

/** The id this track answers to in every budget report. */
export const AGENT_REPLIES_CONTRIBUTOR_ID = "agent-replies";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * What she is told about the answers there was no room for.
 *
 * Named, not "and others": she has to be able to turn it into a sentence for
 * him, and "the treasurer said two more things I have not read yet" is an
 * answer where a vague trailing note is a shrug.
 */
function omissionNote(count: number): string {
  return (
    `[${count} earlier ${count === 1 ? "answer is" : "answers are"} not shown here — there was ` +
    `not room for ${count === 1 ? "it" : "them"} alongside everything else in this turn. Say so ` +
    `if it matters; nothing has been lost.]`
  );
}

/**
 * A contribution that also says WHICH answers went into it.
 *
 * `kept` is additive on purpose — every existing caller reads `id`, `kind` and
 * `text` and is unaffected — and it exists because of a defect that is
 * invisible without it. The caller records what it showed her so it is never
 * shown twice; if it records the whole batch while this function dropped half
 * of it for room, the dropped half is marked seen and never arrives. That is
 * the omission note ("nothing has been lost") becoming a lie, and it is the
 * same silent-drop failure class as the bug `syl-j8fa` exists to fix.
 *
 * So the fitting decision and the record of what was surfaced come from ONE
 * place: this one. `agents/answers.ts` records `kept`, and nothing else.
 */
export type ReplyContribution<T extends AgentReply = AgentReply> = Contributor & {
  /** Exactly the answers that appear in `text`, in the order they appear. */
  readonly kept: readonly T[];
};

/**
 * Compose the answers she should see this turn, or nothing at all.
 *
 * @param replies oldest first — the order the exchange happened in, which is
 * the order she should read them in. When they do not all fit, the OLDEST are
 * dropped, because the newest answer is the one she asked about most recently.
 * @returns `undefined` when nobody has answered. Not a blank contributor: a
 * section that is present and empty reads to her as one that failed to load,
 * and `composeTurnContext` would drop it anyway.
 */
export function replyContributor<T extends AgentReply>(
  replies: readonly T[],
): ReplyContribution<T> | undefined {
  if (replies.length === 0) return undefined;

  const kept = fit(replies);
  const dropped = replies.length - kept.length;

  const fenced = fenceReplies(kept);
  const text = dropped === 0 ? fenced : `${fenced}\n\n${omissionNote(dropped)}`;

  return { id: AGENT_REPLIES_CONTRIBUTOR_ID, kind: "reports", text, kept };
}

/**
 * The newest suffix of `replies` that fits, keeping at least one.
 *
 * Grown from the newest end and re-fenced at each step rather than estimated:
 * `fenceReplies` owns its own preamble, its own separators and its own
 * truncation marker, and a size computed beside it is a second copy of that
 * arithmetic that goes stale the first time the preamble gains a sentence.
 * Batches are small — she asks, she does not broadcast — so the cost is
 * irrelevant beside getting the number wrong.
 *
 * Always keeps one. If even the newest answer will not fit, the right failure
 * is `composeTurnContext` throwing about a contributor that exceeded its own
 * declaration — which is what that check is for, and which is unreachable while
 * the floor asserted in the tests holds — rather than showing her an omission
 * note where the answer should be.
 */
function fit<T extends AgentReply>(replies: readonly T[]): readonly T[] {
  let kept: readonly T[] = replies.slice(-1);

  for (let start = replies.length - 2; start >= 0; start -= 1) {
    const candidate = replies.slice(start);
    const dropped = start;
    const note = dropped === 0 ? "" : `\n\n${omissionNote(dropped)}`;

    if (byteLength(fenceReplies(candidate)) + byteLength(note) > AGENT_REPLIES_MAX_BYTES) break;

    kept = candidate;
  }

  return kept;
}

/** The per-reply cap this module is sized against, re-exported so callers see one number. */
export { MAX_REPLY_BYTES };
