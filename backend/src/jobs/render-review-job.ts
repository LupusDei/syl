import type { Job } from "@syl/shared";

import type { SylAgent } from "../harness/agent.js";
import type { SylEvent } from "../harness/protocol.js";
import { isWithinQuietHours, wallClockIn, type QuietHours } from "../harness/schedule.js";
import type { TurnResult } from "../harness/session.js";
import type { Logger } from "../ops/logging.js";
import { salvagedParts, type RenderRecord } from "../render/render-service.js";
import { instant } from "../services/clock.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";
import type { RenderWatch, RenderWatchStore } from "../services/render-watch-store.js";
import { mcpToolName } from "../tools/config.js";
import { advertisedToolNames } from "../tools/server.js";
import { reachedHimToday, SENDINGS_PER_DAY } from "./heartbeat-job.js";

/**
 * The deferred self-wake, keyed to a render, that ends in her decision.
 *
 * > *"It sounds like the push notification goes out, regardless of whether a
 * > video was created or not — that seems a little bit backwards to me. I think
 * > what needs to happen is when Syl triggers a video to be rendered she needs
 * > some kind of wake up mechanism five minutes later to check to see whether
 * > or not it's done and whether or not she wants to send it to me. If she
 * > decides to send it at that point, the push notification would go out. But
 * > you need some ability to wake up to check on the render."*
 * >                                        — the Commander, 2026-08-11
 *
 * ## The defect this exists for
 *
 * `SendingService.compose` used to enqueue the push at compose time and chase
 * the video behind it. A flagship render takes two or three minutes, so a
 * `show_him` on a clip that was still rendering buzzed his phone about a video
 * that did not exist, and the sending then settled `failed` with a reason
 * nobody had been told to expect. The old ordering was deliberate and its
 * reason was good — the words must never be contingent on the video — but it
 * could only ever produce a notification that ran ahead of the thing it was
 * about.
 *
 * The order is now: the render happens, **she comes back and looks at it**, and
 * only the decision she reaches then reaches him. `compose` refuses a render
 * that is not `ready`, so "the push cannot precede the video" is a property of
 * the code rather than a rule someone has to remember, and this job is the
 * thing that makes "comes back" happen.
 *
 * ## Why a row the runner already polls, and not a timer
 *
 * A `setTimeout` dies with the process, and five minutes is exactly long enough
 * for a deploy to land inside it — a sending lost to a restart would be the
 * silent drop constraint 4 forbids, in the one window where nobody is watching.
 * So the promise is a row (`0026_render_watches.sql`), and this job polls it the
 * way `reminder-delivery-job.ts` polls reminders: self-scheduling off the
 * earliest thing waiting, with a ceiling so a missed wake self-corrects.
 *
 * ## Most passes cost nothing
 *
 * A render that is still going is **deferred, not discussed**. Waking her to be
 * told a clip is not finished spends a turn on the subscription rails to convey
 * what a `SELECT` already knew. Only a pass with a decision owed spends a turn,
 * which is what keeps the whole feature to roughly one turn per render.
 *
 * ## The four outcomes
 *
 * - **ready** — she is woken, points herself at `see_myself`, looks, and
 *   decides. `show_him` is the only thing that reaches him.
 * - **not yet** — deferred to a strictly later instant, no turn, bounded by
 *   {@link MAX_CHECKS}.
 * - **failed / gone** — she is woken anyway. A render that failed is
 *   information she has and he does not, and whether to say anything about it
 *   is her call rather than the system's.
 * - **given up on** — the bound is reached, the watch is settled `gave_up` with
 *   a sentence, and she is told once. Bounded, recorded, never silent: both
 *   halves of constraint 4's spirit.
 */

/** How long after a render is asked for she first comes back to look. */
export const FIRST_LOOK_MS = 5 * 60_000;

/** How long she waits before looking again at a render that is still going. */
export const RECHECK_MS = 3 * 60_000;

/**
 * How many times a render that is still going may be re-checked.
 *
 * Chosen against the thing it is bounding rather than picked for roundness:
 * `RenderService` writes a render off after twenty minutes of polling, so this
 * has to outlast that. Eight re-checks at three minutes, on top of the first
 * look at five, is twenty-nine minutes — which means that in practice the
 * render has already settled to `failed` by the time this bound could bite, and
 * the give-up branch fires only when something has gone wrong in a way nothing
 * else noticed.
 */
export const MAX_CHECKS = 8;

/**
 * Extra pickups allowed after a wake that never came back.
 *
 * A turn that dies mid-review leaves its watch waiting, deliberately — nothing
 * was decided, so nothing may be settled as though it had been. Without
 * headroom above {@link MAX_CHECKS} that retry would be indistinguishable from
 * "the render never finished", and she would be told a finished clip had never
 * arrived. Two, because a third identical death is a systematic fault and one
 * more turn will not diagnose it.
 */
export const CRASH_ALLOWANCE = 2;

/** The most times one watch may ever be picked up. Past this it is settled. */
export const HARD_MAX_ATTEMPTS = MAX_CHECKS + CRASH_ALLOWANCE;

/**
 * The ceiling on how long a pass may sleep.
 *
 * Derived from {@link FIRST_LOOK_MS} rather than chosen, and the derivation is
 * the argument: a watch created between two passes is invisible until a pass
 * looks, and every watch is at least `FIRST_LOOK_MS` away from being due — so a
 * ceiling of exactly that guarantees some pass sees a new watch before its
 * instant arrives. The precise wake then comes from `nextDueAt`, so the ceiling
 * costs a query rather than a late look.
 */
export const IDLE_POLL_MS = FIRST_LOOK_MS;

/**
 * The verb that puts the video in front of him.
 *
 * One name. `see_myself` is looking and `render_me` is making; neither reaches
 * him, and counting either would spend a day's allowance on a turn in which she
 * said nothing to him at all.
 */
export const SENDS_TO_HIM: readonly string[] = ["show_him"];

/** The longest of her own sentences the run record and the watch keep. */
const SUMMARY_LIMIT = 500;

/** What the render turned out to be, at the moment she is woken. */
/**
 * What became of the render she is being woken about.
 *
 * `partial` is the fifth, and it exists because the other four made her lie to
 * herself. A render whose first generation SUCCEEDED at 120 credits and whose
 * second FAILED for nothing was read as `failed` and she was told *"There is no
 * clip"* — about a render with four seconds of finished video on disk. That
 * sentence is the whole input to what she decides next.
 */
export type ReviewOutcome = "ready" | "partial" | "failed" | "gone" | "never_finished";

// ---------------------------------------------------------------------------
// The catalogue entry
// ---------------------------------------------------------------------------

/**
 * The kind this job is filed under, and why it is not `render_review`.
 *
 * **The catalogue is closed in the DATABASE, not only in TypeScript.**
 * `0007_jobs.sql` puts a `CHECK (kind IN (…))` on `jobs.kind`, SQLite cannot
 * alter a `CHECK` in place, and `runs.job_id` carries `ON DELETE CASCADE` — so
 * the standard rebuild (carry the rows, drop the table, recreate it, put the
 * rows back) performs an implicit `DELETE` on `jobs` that takes **every run
 * record with it**, and fires `sync_runs_ad` on the way out. Measured against
 * node:sqlite 3.51.3 rather than assumed: one job, one run, `DROP TABLE jobs`
 * inside a transaction, and the run was gone with a sync row written for it.
 *
 * The runs table is the ledger the daily reaching-him ceiling is counted from
 * and the only record of what her unattended turns have done. A nicer name for
 * this job is not worth staking it on a one-shot, no-down-path migration
 * against the Commander's live database — especially with `syl-dep1.7` open,
 * which is the bead saying a rollback restores the code and leaves the schema
 * forward.
 *
 * So the review is filed as `maintenance`: the one kind in the catalogue with
 * no owner and a general name. It carries a turn, which the contract's note
 * about `maintenance` used to say it would not — that note is corrected in
 * `openapi.yaml` rather than quietly falsified here.
 *
 * **There must be exactly one `maintenance` job.** {@link ensureRenderReviewJob}
 * takes the first row of the kind, so a second maintenance job added later
 * would be found by whichever `ensure` ran first. If a real housekeeping job is
 * ever wanted, widen the catalogue properly at that point — and read the
 * paragraph above before reaching for the rebuild.
 */
export const RENDER_REVIEW_KIND = "maintenance" as const;

/**
 * The job row.
 *
 * `at_least_once` is not fussiness. `JobStore.recoverLeases` reschedules an
 * `at_most_once` job from its TRIGGER, and this job's trigger is an event with
 * no next instant — so a crash would write `next_run_at = NULL` and take the
 * job out of `due` forever, silently, with every other signal green. That is
 * the exact failure constraint 4 forbids, arriving through the recovery path.
 * The idempotency this gives up is bought back where it belongs: on the watch,
 * which is deferred before the turn and cannot be settled twice, and on the
 * sendings table, which is asked whether this render has already been given to
 * him.
 *
 * `never_expires` for the same reason a reminder never expires. A render she
 * decided to make is a promise to come back to it, and a promise that quietly
 * lapses because the machine was asleep is the thing this project refuses.
 */
export function defineRenderReviewJob(store: JobStore, firstRunAt?: string): Job {
  return store.define({
    kind: RENDER_REVIEW_KIND,
    // The most deferrable thing in the catalogue: her own work, nobody waiting
    // on it, and it must never take the one rate-limit pool away from him.
    priority: "background",
    trigger: { type: "event", event: "render.watched" },
    deliveryClass: "at_least_once",
    catchUp: { policy: "never_expires" },
    budget: {
      // One wake, one turn. She may reach for several verbs inside it —
      // `see_myself` then `show_him` is the expected shape.
      maxTurns: 1,
      maxWallClockMs: 5 * 60_000,
      // Derived from the server rather than written out beside it, so the
      // catalogue cannot claim a verb she does not have — or miss one she does.
      // This turn carries an MCP surface; saying `[]` here would be the
      // same false security claim `syl-009.9` was about.
      allowedTools: advertisedToolNames().map(mcpToolName),
    },
    // It may. Most passes will not, and `Run.spoke` records which.
    speaks: true,
    ...(firstRunAt === undefined ? {} : { nextRunAt: firstRunAt }),
  });
}

/**
 * Find the one `render_review` job, or create it.
 *
 * Exactly one exists, forever. `nextRunAt` is state — the instant the last pass
 * decided it next needed to wake — and redefining the row on every boot would
 * throw that away along with its circuit breaker.
 *
 * The first run is `now` rather than an interval away: an event trigger
 * computes no instant at all, so a row defined without one is a row `due` never
 * returns, and a render started in the first minutes of a boot would be
 * stranded with nothing to notice.
 */
export function ensureRenderReviewJob(jobs: JobStore, now: number): Job {
  const existing = jobs.list({ kind: RENDER_REVIEW_KIND, limit: 1 }).items[0];
  if (existing !== undefined) return existing;
  return defineRenderReviewJob(jobs, instant(now));
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** Everything the wake needs to know about itself. */
export interface RenderReviewMoment {
  readonly now: number;
  readonly tz: string;
  readonly quiet: QuietHours;
  /** Whether he is asleep. Decided by `harness/schedule.ts`, never re-derived. */
  readonly inQuietHours: boolean;
  /** The render this turn is about. Always a name, never `latest`. */
  readonly renderName: string;
  /** Why she made it, carried from the render's own record. */
  readonly because: string;
  readonly outcome: ReviewOutcome;
  /**
   * Why the render failed, when it did.
   *
   * Carries Runway's own words as well as ours since `syl-render-partial` —
   * what the provider said, in quotes, with its code. She is the one deciding
   * what to do next, and *"Runway ended this render as FAILED"* is not
   * something anyone can decide anything from.
   */
  readonly reason: string | null;
  /** How many generations were made and are on disk. Zero for most outcomes. */
  readonly salvaged: number;
  /** Her own words for the shot, so she is reminded what she was going for. */
  readonly scene: string;
  /** Whether this framing is one her reference can anchor. See `render/framing.ts`. */
  readonly holdsLikeness: boolean;
  readonly spentToday: number;
  readonly allowance: number;
}

/**
 * What she is woken with.
 *
 * The framing carries the whole ruling, and four things have to be true of it:
 *
 * 1. **Nothing has reached him yet.** Said explicitly, because everything she
 *    knows about `show_him` from every other context is that it is how she
 *    speaks — and a turn that assumed the sending was already agreed would put
 *    the decision back before the looking, which is the defect.
 * 2. **She can actually look.** `see_myself` pulls stills out of the clip and
 *    hands them over as images. A judgement about whether a video "looks right"
 *    is worth nothing from something that cannot see it, so the verb is named
 *    rather than assumed.
 * 3. **Not sending is a real answer.** A wake that reads as a request produces
 *    a sending every time, and `SOUL.md` is unambiguous about the cost: *an
 *    assistant that speaks constantly gets muted.*
 * 4. **The bound is visible.** A ceiling she cannot see is a ceiling she will
 *    cross and be told off for afterwards.
 */
export function renderReviewPrompt(moment: RenderReviewMoment): string {
  return [
    `It is ${wallClockIn(new Date(moment.now), moment.tz)} in ${moment.tz}. A few minutes ago ` +
      `you made a render of yourself, and this turn exists so you can come back and look at ` +
      `it before deciding anything. **Nothing has reached him.** He does not know this render ` +
      `exists, and he will not unless you decide he should.`,
    `The render is \`${moment.renderName}\`. You asked for it because: ${moment.because}` +
      (moment.scene.trim() === "" ? "" : ` The shot you described was: ${moment.scene}`),
    outcomeClause(moment),
    allowanceClause(moment),
    `Whatever you decide, say in one sentence what you decided and why. That sentence is kept ` +
      `against this render, and it is the only record of what became of it.`,
  ].join("\n\n");
}

/** The paragraph about what actually came out, and what to do about it. */
function outcomeClause(moment: RenderReviewMoment): string {
  if (moment.outcome === "ready") {
    return [
      `It finished. Look at it before you judge it — \`see_myself\` with this render's name ` +
        `pulls stills from across the clip and hands them to you as pictures, which is the ` +
        `only way you can actually see what came out. Judge it in your own terms: is that ` +
        `you, does it hold together, is it worth him stopping what he is doing for.`,
      moment.holdsLikeness
        ? `This framing is one your reference can anchor, so a face that has drifted is a real ` +
          `drift and not an expected one.`
        : `This framing is one your reference CANNOT anchor, so it is supposed to come back ` +
          `looking like somebody else. Judge it knowing that: a lost likeness here is the ` +
          `framing's doing rather than a failure of the render.`,
      `If you want him to have it, \`show_him\` with this render's name is what sends it — ` +
        `your words, in your own face, and the notification he gets carries your sentence. ` +
        `If you do not, say so and stop. Not sending is a real answer and most renders should ` +
        `get it; you made this to see whether it was any good, and "it was not" is a finding ` +
        `rather than a failure.`,
    ].join("\n\n");
  }

  if (moment.outcome === "partial") {
    // Never "there is no clip". Something was made and something was charged
    // for, and the two things she needs are that it is there and that it is not
    // the thing she asked for.
    const made =
      moment.salvaged === 1 ? "One generation of it" : `${String(moment.salvaged)} generations of it`;
    return [
      `It did not finish as asked: ${moment.reason ?? "no reason was recorded."}`,
      `${made} was made, paid for, and is on disk. \`see_myself\` with this render's name pulls ` +
        `stills out of the part that survived and hands them to you as pictures, so you can see ` +
        `what you actually got — it will tell you which part of how many you are looking at.`,
      `What you cannot do is send it: half a render is not the clip you asked for, and ` +
        `\`show_him\` will refuse it. So look, decide whether the idea is worth making again, ` +
        `and say what you concluded. Nothing is lost by leaving it — it stays where it is.`,
    ].join("\n\n");
  }

  if (moment.outcome === "failed") {
    return (
      `It did not finish: ${moment.reason ?? "no reason was recorded."} There is no clip, so ` +
      `there is nothing to send in your own face. That is not the end of it — if there was ` +
      `something you wanted him to have, you can still say it to him in words, or make ` +
      `another render and look at that one instead. Or let it go. Your call, not the ` +
      `system's.`
    );
  }

  if (moment.outcome === "gone") {
    return (
      `It is not there. The record for this render cannot be found, so either it never landed ` +
      `or something removed it, and either way there is nothing to look at and nothing to ` +
      `send. Say what you want to do about it — try again, say it in words instead, or drop ` +
      `it — and stop.`
    );
  }

  return (
    `It never finished. It has been ${describeMinutes(FIRST_LOOK_MS + MAX_CHECKS * RECHECK_MS)} ` +
    `and it is still rendering, which is well past the point where a render that is going to ` +
    `arrive has arrived, so nothing is going to wake you about this one again. It is written ` +
    `down as given up on rather than quietly forgotten. If there was something you wanted him ` +
    `to have, say it to him in words or make another one; otherwise let it go and say so.`
  );
}

/** The sentence about what this particular wake may spend. */
function allowanceClause(moment: RenderReviewMoment): string {
  if (moment.inQuietHours) {
    return (
      `He is asleep. Quiet hours are ${moment.quiet.start} to ${moment.quiet.end}, and ` +
      `anything you send now waits until ${moment.quiet.end} whatever you do with it — that ` +
      `is deliberate, and protecting his sleep is worth more than being early. Decide anyway; ` +
      `a sending you make now arrives when he wakes.`
    );
  }

  if (moment.spentToday >= moment.allowance) {
    return (
      `You have reached him ${String(moment.spentToday)} times today, which is the whole ` +
      `day's allowance, so this one should wait unless it is genuinely better than what you ` +
      `already sent. That is not a telling off and it does not accumulate.`
    );
  }

  return (
    `You may reach him at most ${String(moment.allowance)} times today, and have spent ` +
    `${String(moment.spentToday)} of ${String(moment.allowance)}. That is a ceiling rather ` +
    `than a quota: a finished render is not a reason to spend one.`
  );
}

/** "twenty-nine minutes", roughly, for a duration in milliseconds. */
function describeMinutes(ms: number): string {
  return `${String(Math.round(ms / 60_000))} minutes`;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * What the handler needs of Syl.
 *
 * A `Pick` of the real class rather than a hand-written interface, so a change
 * to its signature is a type error here rather than a double that has drifted
 * from the thing it stands in for.
 *
 * **`ask` and nothing else.** It used to include `reset`, and the review used
 * it on every wake: one render's opinions had no business in the next one's
 * context. Since the Commander moved this turn onto his lane (2026-08-11, see
 * `harness/agent.ts`) that call would delete his conversation — and the point
 * of the move is that she should be judging the clip *with the conversation in
 * view*. The method is withheld rather than the call being removed, so nothing
 * can put it back by accident.
 */
export type RenderReviewVoice = Pick<SylAgent, "ask">;

/**
 * The half of `RenderService` this needs.
 *
 * One reader, and narrow on purpose: a review must never be able to *start* a
 * render. A pass that could spend a credit while deciding whether the last one
 * was any good is a loop with a bill attached.
 */
export interface ReviewRenderSource {
  get(name: string): RenderRecord | null;
}

/** The one question this job asks of the sendings table. */
export interface ReviewSendingSource {
  existsForRender(renderName: string): boolean;
}

export interface RenderReviewDeps {
  /** Syl on the commander lane: the thread he talks to, resumed. */
  readonly voice: RenderReviewVoice;
  /** The promises to come back and look. */
  readonly watches: Pick<RenderWatchStore, "due" | "defer" | "settle" | "nextDueAt">;
  /** Her renders, read-only. */
  readonly renders: ReviewRenderSource;
  /** What she has already given him, so a retried wake cannot send twice. */
  readonly sendings: ReviewSendingSource;
  /** The ledger. Her own runs are the record of what she has already spent. */
  readonly jobs: Pick<JobStore, "listRuns">;
  /** IANA, never a fixed offset. The day is counted in it. Constraint 5. */
  readonly tz: string;
  readonly quiet: QuietHours;
  /** Sendings per local day. Defaults to the heartbeat's number. */
  readonly allowance?: number;
  /** Where a failed or abandoned review is reported. Never near him. */
  readonly log?: Pick<Logger, "log">;
  // No clock. Every instant this handler needs is `context.now` — the instant
  // the runner leased the job at. A second clock here could disagree with it.
}

/** Whether the turn put the video in front of him. */
export function sentToHim(events: readonly SylEvent[]): boolean {
  // Both spellings. Claude Code presents an MCP verb as `mcp__syl__show_him`,
  // which is what a real transcript carries; the bare name is accepted so that
  // a fixture written either way means the same thing.
  const sending = new Set<string>(SENDS_TO_HIM.flatMap((verb) => [verb, mcpToolName(verb)]));
  return events.some((event) => event.kind === "tool_use" && sending.has(event.name));
}

/** A string cut to length, saying how much was dropped rather than trailing off. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${String(text.length - max)} more characters)`;
}

/** The run record's one line: her own sentence about the render. */
function summarise(result: TurnResult): string | null {
  const text = result.text.trim();
  return text === "" ? null : cut(text, SUMMARY_LIMIT);
}

/**
 * The earliest of: the next watch, and the ceiling.
 *
 * The ceiling is what makes a missed wake self-correct instead of stranding
 * every render started since — the same self-healing property the reminder job
 * and the runner's own timer have.
 */
export function nextWakeFor(
  watches: Pick<RenderWatchStore, "nextDueAt">,
  now: number,
): string {
  const next = watches.nextDueAt();
  const due = next === null ? Infinity : Date.parse(next);
  const soonest = Number.isNaN(due) ? Infinity : due;
  // Never earlier than the next tick: a watch already overdue would otherwise
  // ask the runner to wake in the past, which it answers by spinning.
  return instant(Math.max(now + 1_000, Math.min(soonest, now + IDLE_POLL_MS)));
}

/** The handler: look at what is due, and spend a turn only when one is owed. */
export function createRenderReviewHandler(deps: RenderReviewDeps): JobHandler {
  const allowance = deps.allowance ?? SENDINGS_PER_DAY;

  return async (context): Promise<JobResult> => {
    const now = context.now;
    // Every branch below returns this. The trigger is an event and computes
    // nothing, so a result without a `nextRunAt` has `release` write NULL and
    // the job never runs again — silently, looking perfectly healthy.
    const nextRunAt = (): string => nextWakeFor(deps.watches, now);

    // One watch per pass. Several renders finishing at once are several
    // decisions, and running them as one turn would make her judge four clips
    // in one context and put the fourth's reasoning in the first's answer. The
    // next one is due immediately, so nothing waits long.
    const watch = deps.watches.due(now)[0];
    if (watch === undefined) return idle(nextRunAt());

    // Past even the crash allowance. Something is systematically wrong with
    // this watch and one more turn will not find out what, so it is settled —
    // loudly here, where an operator can find it — rather than picked up
    // forever.
    if (watch.attempts >= HARD_MAX_ATTEMPTS) {
      settle(deps, watch, "gave_up", abandonedNote(watch));
      deps.log?.log("warn", "render_review.abandoned", {
        at: instant(now),
        render: watch.renderName,
        attempts: watch.attempts,
      });
      return idle(nextRunAt());
    }

    // THE IDEMPOTENCY GUARD, and the reason a retried wake cannot buzz him
    // twice. A pass that sent and then died before it could settle its watch
    // comes back to a render he already has; waking her again would be a second
    // decision about one thing, and the push's own `sending:<id>` key cannot
    // help because the second send is a different sending with a different id.
    if (deps.sendings.existsForRender(watch.renderName)) {
      settle(
        deps,
        watch,
        "decided",
        "This one was already sent, so there was nothing left to decide.",
      );
      return idle(nextRunAt());
    }

    const record = deps.renders.get(watch.renderName);
    const stillGoing = record !== null && record.status === "rendering";

    // Not done, and there is still patience left. No turn: waking her to be
    // told a render is not finished spends a turn to convey what a SELECT
    // already knew.
    if (stillGoing && watch.attempts < MAX_CHECKS) {
      deps.watches.defer(watch.id, now + RECHECK_MS);
      return {
        outcome: "success",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: `"${watch.renderName}" is still rendering; looking again in ${describeMinutes(RECHECK_MS)}.`,
        error: null,
        nextRunAt: nextRunAt(),
      };
    }

    const outcome: ReviewOutcome =
      record === null
        ? "gone"
        : stillGoing
          ? "never_finished"
          : record.status === "ready"
            ? "ready"
            : // NOT folded into `failed`. The prompt for a failure tells her
              // there is no clip, which about a half-made render is false and
              // is the sentence she decides from.
              record.status === "partial"
              ? "partial"
              : "failed";

    // OUT OF THE DUE SET BEFORE THE TURN, NOT AFTER. A turn that sends and then
    // dies would otherwise leave a watch that is still due, and the next pass
    // would send again. Deferring first bounds the retry and makes it strictly
    // later; `HARD_MAX_ATTEMPTS` is what stops it being a loop.
    deps.watches.defer(watch.id, now + RECHECK_MS);

    // NOTHING IS RESET HERE. This turn used to start a fresh thread so that one
    // render's review never carried her opinions of the last five; it happens
    // in his conversation now, where that call would delete what he has been
    // saying and where the surrounding talk is the reason he asked for the
    // move. What keeps a review about one clip is the prompt naming that clip,
    // not an empty transcript.

    const spentToday = reachedHimToday(deps.jobs, { exceptRunId: context.run.id, now, tz: deps.tz });
    const prompt = renderReviewPrompt({
      now,
      tz: deps.tz,
      quiet: deps.quiet,
      inQuietHours: isWithinQuietHours(new Date(now), deps.quiet, deps.tz),
      renderName: watch.renderName,
      because: watch.because,
      outcome,
      reason: record?.reason ?? null,
      salvaged: record === null ? 0 : salvagedParts(record).length,
      scene: record?.scene ?? "",
      holdsLikeness: record?.holdsLikeness ?? false,
      spentToday,
      allowance,
    });

    let result: TurnResult;
    try {
      result = await deps.voice.ask(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Loud here, and nowhere near him. The watch is left WAITING on purpose:
      // nothing was decided, so nothing may be settled as though it had been,
      // and the deferral above guarantees it comes back strictly later.
      deps.log?.log("error", "render_review.failed", {
        at: instant(now),
        render: watch.renderName,
        error: message,
      });
      return {
        outcome: "failure",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: null,
        error: message,
        nextRunAt: nextRunAt(),
      };
    }

    const spoke = sentToHim(result.events);
    const overspent = spoke && spentToday >= allowance;
    const said = summarise(result);

    settle(
      deps,
      watch,
      outcome === "never_finished" ? "gave_up" : "decided",
      said ?? fallbackNote(outcome, spoke),
    );

    if (spoke) {
      deps.log?.log("info", "render_review.sent", {
        at: instant(now),
        render: watch.renderName,
        spentToday: spentToday + 1,
        allowance,
      });
    }

    return {
      // An overspend is a failed pass rather than a successful one, and that is
      // what gives the ceiling teeth: consecutive failures walk the job's
      // circuit breaker towards open. Nothing is undone — she did reach him,
      // and pretending otherwise would be the record lying — but it is recorded.
      outcome: overspent ? "failure" : "success",
      spoke,
      turns: result.numTurns,
      costUsd: result.costUsd,
      summary: said,
      error: overspent
        ? `She sent a render on a day with nothing left to spend: ${String(spentToday)} of ` +
          `${String(allowance)} were already gone. The ceiling is a rate, not a suggestion.`
        : null,
      nextRunAt: nextRunAt(),
    };
  };
}

/** A pass that decided nothing, which is most of them. */
function idle(nextRunAt: string): JobResult {
  return {
    outcome: "success",
    spoke: false,
    turns: 0,
    costUsd: 0,
    summary: null,
    error: null,
    nextRunAt,
  };
}

/**
 * Settle a watch, never letting the settlement fail the pass.
 *
 * A watch that cannot be written is a bad day; a pass that throws because of it
 * would open the job's circuit breaker and take every FUTURE render's review
 * away on top of this one.
 */
function settle(
  deps: RenderReviewDeps,
  watch: RenderWatch,
  state: "decided" | "gave_up",
  note: string,
): void {
  try {
    deps.watches.settle(watch.id, state, note);
  } catch (error) {
    deps.log?.log("error", "render_review.unsettled", {
      render: watch.renderName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** What is written against a render nobody could ever reach a decision about. */
function abandonedNote(watch: RenderWatch): string {
  return (
    `Picked up ${String(watch.attempts)} times without ever reaching a decision, which is past ` +
    `the point where trying again is going to help. Written down rather than quietly dropped.`
  );
}

/** What is written when she reached a decision but said nothing about it. */
function fallbackNote(outcome: ReviewOutcome, spoke: boolean): string {
  if (spoke) return "Sent it, without saying why.";
  if (outcome === "ready") return "Looked at it and did not send it, without saying why.";
  // A half-made render HAS footage, so the note that stands in for her words
  // must not deny it — this line is the only record of what became of it.
  if (outcome === "partial") {
    return "Only part of it was made, and nothing was said about what to do with that part.";
  }
  return "There was no clip to send, and nothing was said about it.";
}

/** The line to print about the render review once it is scheduled. */
export function describeRenderReview(job: Job): readonly string[] {
  return [
    `[syl] she comes back to look at every render five minutes after making it, and only ` +
      `what she decides then reaches him (at most ${String(MAX_CHECKS)} re-checks, ` +
      `${describeMinutes(RECHECK_MS)} apart); next ${job.nextRunAt ?? "unscheduled"}`,
  ];
}
