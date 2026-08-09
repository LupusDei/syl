import type { Job } from "@syl/shared";

import { instant, type Clock, systemClock } from "../services/clock.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";
import type { ArticleIntake, IntakeScheduler } from "./intake.js";
import type { IntakeSource } from "./intake-store.js";

/** Whatever can say which sources still have a step to run. */
export interface PendingSources {
  pending(): readonly IntakeSource[];
}

/**
 * The catalogue entry that makes article intake actually run.
 *
 * `content_ingestion` was a declared `JobKind` with no registered handler, so
 * `JobRunner.#runOne` would have failed any job of that kind on sight — which
 * never happened, because nothing defined one either (`syl-1o7`). Intake had a
 * complete, tested ladder and no engine.
 *
 * ## One job for all sources, not one job per source
 *
 * A job row is a durable, leased, circuit-broken thing. A thousand of them
 * would make the jobs table a queue of work items, which it is not: it is a
 * catalogue of *kinds*. So there is exactly one `content_ingestion` row, it
 * reschedules itself the way `reminder_delivery` does, and which source it
 * touches on a given pass is decided by {@link IntakeQueue}.
 *
 * ## Exactly one step per run
 *
 * `ArticleIntake.advance` performs one step and returns — a thirty-chapter
 * book is thirty runs. Draining inside a single run would let one document
 * monopolise the process and blow through the budget, and the whole reason
 * intake is resumable is so that it does not have to.
 *
 * ## Priority is `background`
 *
 * Reading an article is never more urgent than a reminder or than the
 * Commander's own request, and on subscription rails there is one rate-limit
 * pool shared with everything. Background never starts while interactive work
 * is pending, which is exactly right for this.
 */

/** How long the job sleeps when there is nothing to ingest. */
export const IDLE_POLL_MS = 5 * 60_000;

/**
 * The trigger this job carries.
 *
 * `event`, not a schedule: intake happens when something is submitted, and the
 * handler computes its own next wake from the queue. `skip` catch-up, because
 * three missed wake-ups produce one pass, not three — the durable state is the
 * source's `stage`, not the instant we meant to look at it.
 */
export function defineContentIngestionJob(store: JobStore, firstRunAt?: string): Job {
  return store.define({
    kind: "content_ingestion",
    priority: "background",
    trigger: { type: "event", event: "intake.submitted" },
    // A step that half-ran leaves the stage where it was and runs again; every
    // step is idempotent, which is what makes that safe.
    deliveryClass: "at_least_once_resumable",
    catchUp: { policy: "skip" },
    // One reader turn per run, at most — `#readStep` is the only step that
    // spawns one, and `readStructured` runs with `--tools ""`.
    budget: { maxTurns: 1, maxWallClockMs: 120_000, allowedTools: [] },
    // Intake never speaks. A source being read is not news.
    speaks: false,
    ...(firstRunAt === undefined ? {} : { nextRunAt: firstRunAt }),
  });
}

/** Find the one `content_ingestion` job, or create it. */
export function ensureContentIngestionJob(jobs: JobStore, now: number): Job {
  const existing = jobs.list({ kind: "content_ingestion", limit: 1 }).items[0];
  if (existing !== undefined) return existing;
  return defineContentIngestionJob(jobs, instant(now));
}

/**
 * Which source to advance next, and when.
 *
 * This is the `IntakeScheduler` that `ArticleIntake` has always asked for and
 * never been given: every step ends by saying "call me again for this source,
 * no sooner than then", and until now that call went nowhere.
 *
 * **In memory, and deliberately so.** The durable record of outstanding work is
 * `intake_sources.stage`, which is exactly what a resumable ladder means; this
 * holds only the *backoff*, which is a hint about pacing rather than a fact
 * about the world. {@link recover} rebuilds it from the store on boot, so a
 * crash costs at most one retry delay and never a source.
 */
export class IntakeQueue implements IntakeScheduler {
  readonly #due = new Map<string, number>();

  /** Record that a source may be advanced again at `notBefore`. */
  schedule(job: { readonly sourceId: string; readonly notBefore: number }): void {
    this.#due.set(job.sourceId, job.notBefore);
  }

  /** How many sources are waiting for a step. */
  get size(): number {
    return this.#due.size;
  }

  /**
   * Seed the queue from the store.
   *
   * Every source that is not terminal has a step left to run, and after a
   * restart nothing knows how long it had been waiting — so everything is due
   * now. Re-running a step is safe by construction; skipping one is not.
   */
  recover(sources: PendingSources, now: number): number {
    for (const source of sources.pending()) {
      if (!this.#due.has(source.id)) this.#due.set(source.id, now);
    }
    return this.#due.size;
  }

  /**
   * Take the source that has been waiting longest and is due, or `null`.
   *
   * Removed as it is handed out: the step that follows will re-schedule it if
   * there is more to do, and a source that has finished must not linger.
   */
  claim(now: number): string | null {
    let claimed: string | null = null;
    let earliest = Infinity;
    for (const [sourceId, notBefore] of this.#due) {
      if (notBefore > now || notBefore >= earliest) continue;
      claimed = sourceId;
      earliest = notBefore;
    }
    if (claimed !== null) this.#due.delete(claimed);
    return claimed;
  }

  /** The earliest instant anything becomes claimable, or `null`. */
  nextWakeAt(): number | null {
    let earliest = Infinity;
    for (const notBefore of this.#due.values()) earliest = Math.min(earliest, notBefore);
    return earliest === Infinity ? null : earliest;
  }

  /** Forget a source. For a purge, so a deleted source is not re-advanced. */
  forget(sourceId: string): void {
    this.#due.delete(sourceId);
  }
}

export interface ContentIngestionDeps {
  readonly intake: ArticleIntake;
  readonly queue: IntakeQueue;
  readonly clock?: Clock;
}

/** The handler: advance one source by exactly one step. */
export function createContentIngestionHandler(deps: ContentIngestionDeps): JobHandler {
  const clock = deps.clock ?? systemClock;

  return async (context): Promise<JobResult> => {
    const sourceId = deps.queue.claim(context.now);
    if (sourceId === null) {
      return {
        outcome: "success",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: null,
        error: null,
        nextRunAt: nextWakeFor(deps.queue, clock()),
      };
    }

    // Read before the step so the turn count is honest: `read` is the only
    // stage that spawns one, and it spawns exactly one.
    const before = deps.intake.get(sourceId);
    const turns = before?.stage === "read" ? 1 : 0;

    const result = await deps.intake.advance(sourceId);

    return {
      outcome: "success",
      spoke: false,
      turns,
      costUsd: 0,
      summary: null,
      // A step that could not run is recorded on the run and on the source, and
      // it is **not** a failed run: the ladder is resumable, the reason is in
      // `intake_sources.failure`, and marking the job failed would count
      // towards a circuit breaker that would then stop every other source too.
      error: result.failure === null ? null : `${sourceId}: ${result.failure.message}`,
      nextRunAt: nextWakeFor(deps.queue, clock()),
    };
  };
}

/** The earlier of: the queue's next due source, and the idle poll ceiling. */
export function nextWakeFor(queue: IntakeQueue, now: number): string {
  const next = queue.nextWakeAt();
  const ceiling = now + IDLE_POLL_MS;
  return instant(next === null ? ceiling : Math.min(Math.max(next, now), ceiling));
}
