import type { Lane } from "./agent.js";
import type { TurnResult, TurnRunner } from "./session.js";

/**
 * **Summarisation INSIDE his thread — the remedy the Commander chose in
 * advance, taken on the night shift because it costs 104 seconds.**
 *
 * ## What was measured, and it is not what the bead assumed
 *
 * `syl-chzl.4.4`. Her face had never once answered a question: every `ask_syl`
 * in the log was a `face.ask.slow` against a 6,500ms deadline inside Runway's
 * hard 8s ceiling. Measured 2026-08-23 on **CLI 2.1.235**, against the real
 * binary, resuming his real lane (forked, so his thread was never touched), with
 * a prompt whose entire answer is the word `ACK`:
 *
 * ```
 * context 861,739 tokens   13844ms 23645ms 15729ms   first token 9147-15819ms
 * context  80,392 tokens    4283ms  4285ms  4135ms   first token 3525-3959ms
 * context   8,873 tokens    3308ms  9007ms 12432ms   first token 2644-2879ms
 * ```
 *
 * First token is the signal; the total-ms tail is teardown noise under fleet
 * load. **His lane carried 861,739 tokens and had never been compacted once in
 * thirteen days.** Nine seconds to the first token is not a slow turn, it is a
 * ceiling that cannot be reached from below however fast the harness is.
 *
 * The bead expected the bloat to be the conversation — "much of her personality
 * lives in that thread". It is a minority of it either way, but **the honest
 * unit is TOKENS, not bytes**, and the two disagree violently: base64 is
 * enormous on disk and comparatively cheap to the model. Of 861,739 tokens
 * (images taken at 1,300-2,000 each, the range for a render of this size):
 *
 * | what | tokens | bytes of the active chain |
 * |---|---|---|
 * | **his words and hers, together** | **31-33%** | 12% |
 * | her thinking blocks | 24-25% | 9% |
 * | tool results, text | 21-22% | 8% |
 * | `see_myself` images — 76 of them | 11-18% | **69%** |
 *
 * **Quote the token column.** The byte column is what a naive `du` on the
 * transcript shows and it overstates the pictures by a factor of four, which
 * would have understated his own conversation as a ninth of the thread when it
 * is nearer a third. Same remedy either way — that is why this is recorded
 * rather than acted on — but not the same fact about his ruling.
 *
 * The thread is still not mostly him, and it still holds 76 pictures she
 * looked at once that a tool result can never put down.
 *
 * ## Why the CLI's own `/compact` and not something of ours
 *
 * Verified live: sending `/compact` as an ordinary prompt in `-p
 * --input-format stream-json` mode works, emits a typed `compact_boundary`
 * frame, keeps the session id, and took **861,739 → 8,873 tokens** with the
 * follow-up turn at **2,920ms**. It is the vendor implementing the Commander's
 * remedy for us, inside the same session, with no second thread and no reset.
 *
 * Three things were rejected:
 *
 * - **`--autocompact <tokens>`.** The CLI's own trigger, and the tempting
 *   one-flag answer. It decides *when*, which means the 104-second compaction
 *   fires on whichever turn crosses the threshold — and that turn is eventually
 *   a face question. That is the exact failure being fixed, rearmed on a timer
 *   nobody controls. **We must own the timing**, which is the whole reason this
 *   module exists instead of a flag in `turnShapeArgs`.
 * - **A second thread beside his.** Refused by the Commander, 2026-08-11:
 *   *"much of her personality lives in that thread"*.
 * - **`reset`.** It deletes his conversation. No `Voice` in this project offers
 *   the method and {@link compactLane} is handed an `ask` and nothing else, so
 *   there is nothing here that could call one.
 *
 * ## Nothing is silently dropped, and that is structural rather than promised
 *
 * Compaction is lossy by construction, so constraint 4's ethos has to be paid
 * explicitly. It is, three ways, and none of them depends on anyone remembering:
 *
 * - **The transcript is append-only.** `/compact` writes a boundary frame into
 *   the same file; every byte before it is still on disk, in full, forever.
 * - **The summary names its own source.** The CLI's summary ends with the
 *   absolute path of the transcript it was made from — so the recovery route
 *   travels *inside* the thing that replaced the detail.
 * - **It is reported, not silent.** {@link CompactionOutcome} carries the before
 *   and after, the job writes them to the run ledger, and a compaction that did
 *   not shrink anything is a **failure** rather than a quiet no-op.
 *
 * ## And it is what stops the ratchet, without a second mechanism
 *
 * The 76 pinned images are the thread's largest single term, and there is no
 * way to un-pin a tool result once a turn has returned it. Compaction sweeps
 * them with everything else, which caps the ratchet at one night's accumulation
 * — about five images a day at her observed rate. Capping what one
 * `see_myself` may return is still worth doing (`syl-9fcr`), but it is
 * hygiene now rather than the fix.
 */

/**
 * What the CLI is asked, and it is the CLI's own slash command rather than a
 * prompt of ours.
 *
 * A prose instruction — "summarise this conversation and continue from the
 * summary" — would be a *behavioural* request: the model would comply by
 * writing a summary as its ANSWER, appending several thousand tokens to the
 * thread it was meant to shrink. `/compact` is a command the harness executes,
 * and it rewrites what the next turn replays. The difference is the same one
 * `--tools ""` makes against `--allowedTools`: a mechanism, not a request.
 */
export const COMPACT_PROMPT = "/compact";

/**
 * How large his lane may get before the next quiet window compacts it.
 *
 * Derived from the measurement above rather than picked. Context costs roughly
 * 7.5ms per thousand tokens above a ~2.5s floor, so 150,000 buys about 1.1s of
 * prefill — affordable inside a 6,500ms deadline that must also carry an MCP
 * round trip (`docs/CONTEXT.md` measured a tool-using warm turn at
 * 3,182-7,034ms at small context).
 *
 * It is a **night-time trigger**, so it has to leave room for a whole day's
 * growth on top: compaction lands the thread near 9,000 tokens, a heavy day
 * adds tens of thousands, and the budget is what decides whether that day's
 * accumulation is worth 104 seconds to sweep. Set it much lower and she
 * compacts every night for no gain; much higher and a bad day ends slow.
 */
export const COMMANDER_CONTEXT_BUDGET_TOKENS = 150_000;

/**
 * What the last turn on each lane actually cost to replay.
 *
 * **Reported by the CLI, never estimated by us.** The size that matters is the
 * one the API billed, and it is on every `result` frame; counting characters in
 * our own transcript would be a consistency check against our own model of the
 * conversation — precisely the shape `docs/CONTEXT.md` names as this project's
 * worst defect class. Reading the CLI's own number is the correspondence check.
 *
 * In memory, and deliberately: it is a fact about a live conversation, it is
 * re-learned by the next turn on the lane, and a stale value read off disk
 * after a restart is worse than no value — {@link whyNotCompact} refuses when
 * the size is unknown, which is the safe direction.
 */
export class LaneContextSizes {
  readonly #tokens = new Map<Lane, number>();

  /** What the last turn on `lane` replayed. Absent until a turn has run. */
  tokens(lane: Lane): number | undefined {
    return this.#tokens.get(lane);
  }

  /**
   * Discard what is known about a lane, so the next turn re-learns it.
   *
   * **Compaction is the reason this exists, and it was found by measurement
   * rather than reasoning.** A `/compact` turn reports NO usage at all — it is
   * the one turn whose `result` frame carries no `usage` block — so the
   * rewritten thread cannot report its own new size. Left alone, the lane would
   * keep the size it had *before* the sweep: still over budget, so the next
   * hour compacts again, and the one after that, all night. Each of those
   * reports a fictional saving from a stale `before` against an absent `after`.
   *
   * Forgetting is the honest state. `whyNotCompact` refuses on an unknown size,
   * so the lane simply waits for the next real turn to say how big it now is —
   * the safe direction, reached without inventing a number.
   */
  forget(lane: Lane): void {
    this.#tokens.delete(lane);
  }

  /**
   * Record a turn's reported context.
   *
   * A zero is discarded rather than stored. The CLI omits `usage` on some
   * frames, and "the CLI did not say" decoded to `0` would make a 861,739-token
   * lane look empty — an over-budget thread that silently stops being compacted,
   * which is the failure this whole module exists to end.
   */
  record(lane: Lane, tokens: number): void {
    if (tokens > 0) this.#tokens.set(lane, tokens);
  }
}

/**
 * Wrap a runner so every turn tells us what its lane now costs.
 *
 * Sits beside `recordHisWords` and `withMemoryIndex` in `index.ts`, and for the
 * same reason they do: **outside** the warm-lane router, so a warm turn is
 * measured exactly like a cold one. Wrapped round the router's *fallback*
 * instead, the Commander's own lane — the only one big enough to matter — would
 * be the one lane never measured.
 */
export function recordLaneContext(sizes: LaneContextSizes): (inner: TurnRunner) => TurnRunner {
  return (inner) => async (prompt, options) => {
    const result = await inner(prompt, options);
    if (options.lane !== undefined) sizes.record(options.lane, result.contextTokens);
    return result;
  };
}

/** What a caller knows about the lane when it asks whether to compact. */
export interface CompactionConditions {
  /** What the last turn replayed, or `undefined` if no turn has run yet. */
  readonly tokens: number | undefined;
  /** Whether the Commander is asleep. Compaction is a night job. */
  readonly inQuietHours: boolean;
  /** Whether a turn is already queued or running on the lane. */
  readonly busy: boolean;
}

/**
 * Why this is not the moment to compact — or `null` when it is.
 *
 * A reason string rather than a boolean so the run ledger records *which* gate
 * held, and so a night that never compacts is diagnosable without a debugger.
 * Every ambiguous answer is "do not": the same call `ops/deploy-gate.ts` makes,
 * for the same reason. Compaction is a 104-second turn on the thread the
 * Commander talks to, and the cost of waiting one more night is nothing.
 */
export function whyNotCompact(conditions: CompactionConditions): string | null {
  if (conditions.tokens === undefined) {
    return "the lane's context size is not known yet — no turn has reported one since boot";
  }
  if (conditions.tokens <= COMMANDER_CONTEXT_BUDGET_TOKENS) {
    return `the thread is within budget (${conditions.tokens.toLocaleString()} of ${COMMANDER_CONTEXT_BUDGET_TOKENS.toLocaleString()} tokens)`;
  }
  if (!conditions.inQuietHours) {
    // Quiet hours bound what may REACH him and never what may run — the dream
    // and the brief both run inside the window. This is the other use of the
    // window and it is legitimate: not "he must not be disturbed" but "nobody
    // is waiting on this lane", which is the condition a 104-second turn needs.
    return "it is not quiet hours, and a 104-second turn would hold his lane while he is awake";
  }
  if (conditions.busy) {
    return "the lane is busy — a turn of his own outranks housekeeping";
  }
  return null;
}

/** What a compaction did, for the run ledger and the log. */
export interface CompactionOutcome {
  readonly ok: boolean;
  /** Context the thread replayed before compaction. */
  readonly before: number;
  /**
   * Context after — **usually `undefined`, and that is not a failure.**
   *
   * A `/compact` turn's result frame carries no `usage` block, so the rewritten
   * thread does not report its own new size. Absent means "not stated"; the
   * next ordinary turn on the lane is what says how big it now is.
   */
  readonly after: number | undefined;
  readonly error: string | null;
}

export interface CompactLaneDeps {
  /** One turn on the lane. Deliberately the ONLY capability handed in. */
  readonly ask: (prompt: string) => Promise<TurnResult>;
  /** What the thread cost going in, so the outcome can report the saving. */
  readonly before: number;
}

/**
 * Compact one lane, in place, and report what it cost and what it saved.
 *
 * Never throws. A failed compaction is an operator's problem and must not fail
 * the job that hosts it — the hour this runs inside has its own work to do, and
 * a thread that is merely still large is not an incident.
 */
export async function compactLane(deps: CompactLaneDeps): Promise<CompactionOutcome> {
  let result: TurnResult;
  try {
    result = await deps.ask(COMPACT_PROMPT);
  } catch (error) {
    return {
      ok: false,
      before: deps.before,
      after: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // `undefined`, not `0`. MEASURED, not assumed: a `/compact` turn's result
  // frame carries no `usage` block at all, so the rewritten thread never
  // reports its own new size. Decoding that absence as a number would let
  // `describeCompaction` announce "861,739 → 0 tokens (861,739 saved)", which
  // is a fabricated saving stated with total confidence.
  const after = result.contextTokens > 0 ? result.contextTokens : undefined;

  // A compaction that ran and changed nothing is reported as a FAILURE, not as
  // a quiet success. Otherwise the lane stays over budget, the gate keeps
  // opening, and she spends 104 seconds every night achieving nothing — with a
  // green run record saying the housekeeping is being done.
  if (after !== undefined && after >= deps.before) {
    return {
      ok: false,
      before: deps.before,
      after,
      error: `compaction ran but the thread did not shrink (${deps.before.toLocaleString()} → ${after.toLocaleString()} tokens)`,
    };
  }

  return { ok: true, before: deps.before, after, error: null };
}

/**
 * One line for the run ledger. Never "done", and never a number it does not
 * have.
 *
 * The `after` is usually absent, because the compaction turn reports no usage —
 * so this says the thread was rewritten and that the next turn will report the
 * new size, rather than inventing one. A run record that overstates what it
 * knows is worse than a vaguer one that is true.
 */
export function describeCompaction(outcome: CompactionOutcome): string {
  if (!outcome.ok) return `Compaction failed: ${outcome.error ?? "unknown"}.`;
  const from = `${outcome.before.toLocaleString()} tokens`;
  const to =
    outcome.after === undefined
      ? "a size the compaction turn does not report; the next turn on this lane will"
      : `${outcome.after.toLocaleString()} tokens (${(outcome.before - outcome.after).toLocaleString()} saved)`;
  return (
    `Compacted his thread inside the same session, from ${from} to ${to}. ` +
    `Nothing was deleted: the full transcript is unchanged on disk and the ` +
    `summary names its own source.`
  );
}
