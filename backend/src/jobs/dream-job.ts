import type { Job } from "@syl/shared";

import { isWithinQuietHours, type QuietHours } from "../harness/schedule.js";
import type { DreamJudge, JudgeReport } from "../memory/dream/judge.js";
import { nightOf, type DreamLog } from "../memory/dream/log.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";

/**
 * The catalogue entry that makes the dream actually happen.
 *
 * `DreamJudge.dream({ night, tz })` opens a session, sweeps, judges,
 * checkpoints, resumes and yields — all of it tested end to end against a fake
 * CLI — and until this file nothing called it on a clock (`syl-cbb`). Same
 * shape as `content_ingestion` before `intake-job.ts`: a complete mechanism
 * with no engine.
 *
 * ## It runs in the quiet-hours gap, not on a second scheduler
 *
 * `harness/schedule.ts` already gets wall-clock scheduling right — the DST gap
 * (fire late rather than skip a day), the DST overlap (fire once), and the
 * wrap-past-midnight quiet window — and `JobStore.nextRunAtFor` already routes
 * a `wall_clock` trigger through it. So the dream is one row in the jobs table
 * with a `wall_clock` trigger, and its catch-up policy is `once_per_window`
 * over **the quiet window itself**: the window is the only time the dream is
 * allowed to be spending turns, and outside it a missed occurrence is skipped
 * and recorded rather than run at breakfast.
 *
 * The wall time is {@link PREFERRED_DREAM_WALL_TIME} whenever the configured
 * window contains it, which for any plausible window it does.
 *
 * ## Priority is `background`
 *
 * On subscription rails there is one rate-limit pool, shared with the
 * Commander's own work. `JobStore.due` sorts `background` last, so the dream
 * never *starts* while anything interactive is pending — and
 * {@link createYieldSignal} is the other half of the same rule, for the case
 * where he starts talking after it already has.
 *
 * ## A night that dies is retried, not forgotten
 *
 * Three mechanisms, in order of how bad the failure is:
 *
 *  - **A crash mid-night** leaves the session row open with its checkpoint
 *    intact. The next pass finds it and calls `resumeNight` rather than
 *    starting a second session over the same candidates.
 *  - **A failed or yielded night** returns a `nextRunAt` inside the window, so
 *    the night is retried tonight rather than lost until tomorrow — and if the
 *    window has run out, the field is omitted so the trigger's own next
 *    occurrence stands. It is never `null`, which would unschedule the job
 *    permanently and is the exact shape of "silently never runs again".
 *  - **A persistent failure** is recorded on every run and eventually opens the
 *    job's circuit breaker, which is visible in the jobs surface and which
 *    `BREAKER_COOLDOWN_MS` lets back out on its own.
 */

/**
 * The hour the dream prefers, when the quiet window contains it.
 *
 * Deep inside any plausible window, hours after the Commander has stopped
 * talking, and far enough from the window's end that a long night still
 * finishes inside it.
 */
export const PREFERRED_DREAM_WALL_TIME = "03:00";

/** How long after yielding to the Commander the dream tries again. */
export const YIELD_RETRY_MS = 10 * 60_000;

/** How long after a night failed the dream tries again, while the window lasts. */
export const FAILURE_RETRY_MS = 15 * 60_000;

/**
 * How long the yield signal stays true after the last interactive turn settles.
 *
 * A reply landing is not the Commander going back to sleep — it is the middle
 * of a conversation. Resuming the instant a turn settles would put a judgment
 * turn between his question and his follow-up, on the one rate-limit pool they
 * share.
 */
export const YIELD_GRACE_MS = 5 * 60_000;

/**
 * An estimate, not a limit. `JudgeBudget.tokenCeiling` is what actually bounds
 * a night; this is the jobs surface's description of the shape of the work
 * (~180 turns at ~2 minutes each — see `JudgeBudget.tokenCeiling`).
 */
export const DREAM_MAX_TURNS = 200;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The wall time the dream fires at, given the window it has to run inside.
 *
 * {@link PREFERRED_DREAM_WALL_TIME} when the window contains it, and the start
 * of the window otherwise. The fallback matters: `once_per_window` skips every
 * occurrence outside the window, so a trigger time the window does not contain
 * is a dream that is scheduled forever and never runs — silently, and looking
 * exactly like data.
 */
export function dreamWallTime(quiet: QuietHours): string {
  return withinWindow(PREFERRED_DREAM_WALL_TIME, quiet) ? PREFERRED_DREAM_WALL_TIME : quiet.start;
}

/** Whether a wall time falls inside a window, wrap-aware. */
function withinWindow(wallTime: string, quiet: QuietHours): boolean {
  const [hour, minute] = wallTime.split(":").map(Number);
  // Asked in UTC on an arbitrary date, so this is a pure question about the
  // wall clock and reuses the one wrap-aware predicate rather than a second
  // copy of the arithmetic.
  return isWithinQuietHours(
    new Date(Date.UTC(2000, 0, 1, hour ?? 0, minute ?? 0)),
    quiet,
    "UTC",
  );
}

/** How long the quiet window lasts, in milliseconds. */
export function quietWindowMs(quiet: QuietHours): number {
  const minutes = (spec: string): number => {
    const [hour, minute] = spec.split(":").map(Number);
    return (hour ?? 0) * 60 + (minute ?? 0);
  };
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  const span = end > start ? end - start : 24 * 60 - start + end;
  return span * 60_000;
}

export interface DreamSchedule {
  /** IANA, never a fixed offset. Constraint 5. */
  readonly tz: string;
  /** The window the dream is allowed to spend turns in. */
  readonly quiet: QuietHours;
}

/** The trigger and the window this job carries. */
export function defineNightlyDreamJob(
  store: JobStore,
  schedule: DreamSchedule,
  firstRunAt?: string,
): Job {
  return store.define({
    kind: "nightly_consolidation",
    // Never ahead of the Commander, and never ahead of a reminder.
    priority: "background",
    trigger: {
      type: "wall_clock",
      wallTime: dreamWallTime(schedule.quiet),
      tz: schedule.tz,
    },
    // A night checkpoints between batches and `resumeNight` picks it back up,
    // which is exactly what this class names.
    deliveryClass: "at_least_once_resumable",
    // The dream belongs to the quiet gap. Outside it, a missed occurrence waits
    // for the next window rather than spending turns while he is awake.
    catchUp: {
      policy: "once_per_window",
      windowStart: schedule.quiet.start,
      windowEnd: schedule.quiet.end,
    },
    // `--tools ""`, enforced by `DreamJudge` itself and asserted against the
    // CLI's own init frame. Listing nothing here says the same thing where the
    // catalogue is read.
    budget: {
      maxTurns: DREAM_MAX_TURNS,
      maxWallClockMs: quietWindowMs(schedule.quiet),
      allowedTools: [],
    },
    // The dream never speaks. What it finds is surfaced later, on its own
    // terms, by whatever decides to raise it — not at 03:00.
    speaks: false,
    ...(firstRunAt === undefined ? {} : { nextRunAt: firstRunAt }),
  });
}

/**
 * Find the one `nightly_consolidation` job, or create it.
 *
 * Exactly one exists, forever. `nextRunAt` is state — the instant the last pass
 * decided it next needed to wake — and redefining the row on every boot would
 * throw that away along with its circuit breaker.
 */
export function ensureNightlyDreamJob(
  jobs: JobStore,
  schedule: DreamSchedule,
  now: number,
): Job {
  const existing = jobs.list({ kind: "nightly_consolidation", limit: 1 }).items[0];
  if (existing !== undefined) return existing;
  return defineNightlyDreamJob(jobs, schedule, instant(now));
}

// ---------------------------------------------------------------------------
// The yield signal
// ---------------------------------------------------------------------------

/**
 * Whatever knows the Commander is talking.
 *
 * `ConversationService` is the one: it owns the per-conversation queue that
 * every interactive turn goes through, and the dream's own turns do not go
 * through it — `DreamJudge` drives `runTurn` directly on the `consolidation`
 * lane. So this cannot see the dream and mistake it for him.
 */
export interface InteractiveActivity {
  /** Conversations with a turn running or queued right now. */
  readonly pending: number;
  /** When the most recent interactive turn was accepted, or settled. */
  readonly lastActiveAt: number | null;
}

export interface YieldSignalOptions {
  readonly conversations: InteractiveActivity;
  readonly clock?: Clock;
  /** How long after the last turn settles the dream stays paused. */
  readonly graceMs?: number;
  /**
   * The window the dream is allowed to spend turns in. Outside it, it yields.
   *
   * Omit and the dream is bounded only by its token ceiling, which is what
   * every unit test of the judge wants and what production must not have.
   */
  readonly window?: DreamSchedule;
}

/**
 * The predicate `DreamJudge` checks at every checkpoint boundary.
 *
 * ## 1. The Commander is talking
 *
 * Two clauses, and the second is the one that matters. "A turn is in flight" is
 * only true for the couple of minutes the model is actually thinking; a
 * conversation is a sequence of those with gaps between them, and a dream that
 * resumed in every gap would be competing with him for the rate-limit pool
 * throughout. So the signal stays true for {@link YIELD_GRACE_MS} after the
 * last turn settles.
 *
 * ## 2. The gap has closed
 *
 * **This bound is not optional in production, and the reason is reminders.**
 * `JobRunner` is concurrency-one by design and does not re-arm its timer until
 * the pass in flight returns, so a job that runs for hours is a job that holds
 * the whole loop for hours — including `reminder_delivery`, the one kind
 * carrying a hard guarantee. A night is budgeted at roughly 180 turns and six
 * wall-clock hours (`JudgeBudget.tokenCeiling`), which is exactly long enough
 * for that to matter.
 *
 * Yielding at the window's end bounds it to the quiet window, which is the
 * window in which `deferPastQuietHours` is already holding every non-urgent
 * reminder. So the runner comes free at the same instant the backlog is
 * released, and delivery resumes with it.
 *
 * It is also just what "the dream runs in the quiet-hours gap" means. A dream
 * still judging at 08:30 is not a dream.
 *
 * An urgent reminder — one that fires *inside* quiet hours — can still be held
 * behind a night in flight. Nothing is lost (`never_expires`, and it is marked
 * late), but it is later than it should be, and the fix is in the runner rather
 * than here: `syl-ncx`.
 */
export function createYieldSignal(options: YieldSignalOptions): () => boolean {
  const clock = options.clock ?? systemClock;
  const graceMs = options.graceMs ?? YIELD_GRACE_MS;
  const window = options.window;

  return (): boolean => {
    if (window !== undefined && !isWithinQuietHours(new Date(clock()), window.quiet, window.tz)) {
      return true;
    }
    if (options.conversations.pending > 0) return true;
    const last = options.conversations.lastActiveAt;
    return last !== null && clock() - last < graceMs;
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * What the handler needs of a {@link DreamJudge}.
 *
 * A `Pick` of the real class rather than a hand-written interface, so a change
 * to either method's signature is a type error here rather than a fake that has
 * drifted from the thing it stands in for.
 */
export type NightDreamer = Pick<DreamJudge, "dream" | "resumeNight">;

export interface NightlyDreamDeps {
  readonly log: DreamLog;
  /** IANA, never a fixed offset. */
  readonly tz: string;
  /** The window the dream runs inside. */
  readonly quiet: QuietHours;
  /**
   * Built on demand, and allowed to say no.
   *
   * Lazy because a judge needs the searchable half of memory, which loads a
   * native extension — see `services/memory-runtime.ts`. `null` means that half
   * is unavailable on this machine, which is a failed run to be retried and
   * reported, not a reason for the boot to have failed.
   */
  readonly judge: () => NightDreamer | null;
  // No clock. Every instant this handler needs is `context.now`, which is the
  // instant the runner leased the job at — the one the run record, the
  // catch-up decision and the lateness are all measured from. A second clock
  // here could disagree with it, and a job that thinks it is a different time
  // from the runner that scheduled it is a whole category of bug.
}

/** The handler: dream one night, or finish the one that did not end. */
export function createNightlyDreamHandler(deps: NightlyDreamDeps): JobHandler {
  return async (context): Promise<JobResult> => {
    const now = context.now;
    const night = nightOf(now, deps.tz);
    const yesterday = nightOf(now - DAY_MS, deps.tz);

    // Anything still open from before last night is not going to be finished:
    // its candidates describe a graph that has moved on. Closed as `abandoned`,
    // which is what it truthfully was, so the open list means "needs
    // attention" rather than accumulating rows nobody will ever act on.
    const open = deps.log.list({ open: true, limit: 50 }).items;
    for (const session of open) {
      if (session.night < yesterday) {
        deps.log.closeSession(session.id, {
          outcome: "abandoned",
          error: `Never finished, and its night (${session.night}) is older than ${yesterday}; its candidates no longer describe the graph.`,
        });
      }
    }

    const judge = deps.judge();
    if (judge === null) {
      return {
        outcome: "failure",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: null,
        error:
          "The dream could not run: the searchable half of memory is unavailable, so the " +
          "sweep has no embedding kernel to propose with.",
        ...retryIn(FAILURE_RETRY_MS, now, deps),
      };
    }

    const resumable = open.find(
      (session) => session.night === night || session.night === yesterday,
    );

    let report;
    try {
      report =
        resumable === undefined
          ? await judge.dream({ night, tz: deps.tz })
          : await judge.resumeNight(resumable.id);
    } catch (error) {
      // `dream` and `resumeNight` both close the session as `failed` before
      // re-throwing, so the log already says what happened. What is left is to
      // make sure the JOB comes back tonight rather than tomorrow.
      return {
        outcome: "failure",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: null,
        error: error instanceof Error ? error.message : String(error),
        ...retryIn(FAILURE_RETRY_MS, now, deps),
      };
    }

    const session = deps.log.session(report.sessionId);

    // `yielded` is a success. The dream did exactly what it is supposed to do
    // when the Commander starts talking, and calling it a failure would walk
    // the circuit breaker towards open for the one behaviour that is working.
    const retry =
      report.outcome === "yielded"
        ? retryIn(YIELD_RETRY_MS, now, deps)
        : report.outcome === "failed" || report.outcome === "abandoned"
          ? retryIn(FAILURE_RETRY_MS, now, deps)
          : {};

    return {
      outcome: report.outcome === "failed" ? "failure" : "success",
      spoke: false,
      turns: report.turns,
      costUsd: session?.costUsd ?? 0,
      summary: summarise(report, resumable !== undefined),
      error: session?.error ?? null,
      ...retry,
    };
  };
}

/**
 * A `nextRunAt` inside the window, or nothing at all.
 *
 * **Never `null`.** `JobStore.release` writes `nextRunAt` through verbatim when
 * it is given, and a `null` there sets `next_run_at = NULL`, which takes the
 * job out of `due` forever. Omitting the field instead lets `nextRunAtFor`
 * compute the trigger's own next occurrence — tomorrow night — which is the
 * correct answer once the window has run out.
 */
function retryIn(
  delayMs: number,
  now: number,
  deps: Pick<NightlyDreamDeps, "quiet" | "tz">,
): { nextRunAt?: string } {
  const at = new Date(now + delayMs);
  if (!isWithinQuietHours(at, deps.quiet, deps.tz)) return {};
  return { nextRunAt: instant(at.getTime()) };
}

/**
 * The run record's one line.
 *
 * `JobResult.summary` is documented as the model's own sentence about what it
 * did, and there is no such sentence here: a night is many turns and none of
 * them writes prose. A tally is what the runs table can honestly show, and the
 * alternative — `null`, as `reminder_delivery` correctly uses — would leave the
 * one row an operator looks at blank on the job that does the most work.
 */
function summarise(report: JudgeReport, resumed: boolean): string {
  return (
    `${resumed ? "resumed" : "dreamt"}: ${report.outcome}; judged ${String(report.judged)}, ` +
    `created ${String(report.created)}, reactivated ${String(report.reactivated)}, ` +
    `suppressed ${String(report.suppressed)}, rejected ${String(report.rejected)}`
  );
}

/** The lines to print about the dream once it is scheduled. */
export function describeDream(job: Job, schedule: DreamSchedule): readonly string[] {
  return [
    `[syl] the dream is scheduled for ${job.trigger.wallTime ?? "?"} ${schedule.tz} ` +
      `(quiet ${schedule.quiet.start}-${schedule.quiet.end}); next ${job.nextRunAt ?? "unscheduled"}`,
  ];
}
