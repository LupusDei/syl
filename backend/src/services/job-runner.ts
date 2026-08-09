import type { Job, JobCatchUp, JobKind, Run, RunOutcome } from "@syl/shared";

import { isWithinQuietHours } from "../harness/schedule.js";
import { instant, parseInstant, systemClock, type Clock } from "./clock.js";
import { JobStore } from "./job-store.js";

/**
 * The job runner.
 *
 * **One timer, not a timer per job.** Armed for `min(next due instant, 60s)`
 * and, on every tick, recomputed from `Date.now()` rather than trusted to have
 * been accurate. Sleep, wake, daylight saving and NTP corrections then all
 * self-heal, because a long sleep is indistinguishable from a long tick. A
 * `setTimeout` is not a schedule; a loop that re-derives everything from the
 * clock is.
 *
 * **Recovery runs before scheduling.** On start, leases this process does not
 * hold are reclaimed and the catch-up policy is evaluated for every instant
 * that passed. A runner that starts scheduling before it has looked at what it
 * missed silently swallows whatever was due while it was down.
 *
 * **Concurrency is one.** On subscription rails there is a single rate-limit
 * pool shared with the Commander's own work and the whole fleet, so
 * parallelism buys nothing but contention. The queue is priority-ordered and
 * background never starts while interactive work is pending.
 */

/** The longest a tick may be. Everything is recomputed on each one. */
export const MAX_TICK_MS = 60_000;

/** The shortest, so a burst of due work cannot spin the loop. */
export const MIN_TICK_MS = 10;

/** How long a lease is held before another runner may reclaim it. */
export const DEFAULT_LEASE_MS = 5 * 60_000;

/** Later than this after its instant, and a run is late. */
export const LATE_THRESHOLD_MS = 60_000;

/** What to do about an instant that passed while we were down. */
export type CatchUpAction =
  | { readonly action: "run"; readonly late: boolean }
  | { readonly action: "skip"; readonly reason: string };

/**
 * Decide what a missed instant means for this kind.
 *
 * The four policies are not interchangeable and the differences are the whole
 * point:
 *
 * - `never_expires` — reminders. Fires however late, and is **marked** late.
 * - `grace_window` — a morning agenda inside its window is still a morning
 *   agenda; outside it, it is an interruption about a morning that already
 *   happened.
 * - `skip` — three missed heartbeats produce one heartbeat, not three.
 * - `once_per_window` — consolidation must run once between two wall-clock
 *   times; outside the window it waits for the next one.
 */
export function decideCatchUp(
  catchUp: JobCatchUp,
  triggerInstant: number,
  now: number,
  tz = "UTC",
): CatchUpAction {
  const lateBy = now - triggerInstant;
  const late = lateBy > LATE_THRESHOLD_MS;

  switch (catchUp.policy) {
    case "never_expires":
      // A late reminder is a nuisance; a vanished one destroys trust.
      return { action: "run", late };

    case "grace_window": {
      const grace = catchUp.graceMs ?? 0;
      if (lateBy <= grace) return { action: "run", late };
      return {
        action: "skip",
        reason: `Missed by ${Math.round(lateBy / 60_000)} minutes, past a ${Math.round(grace / 60_000)}-minute grace window.`,
      };
    }

    case "skip":
      if (!late) return { action: "run", late: false };
      return { action: "skip", reason: "Missed while the machine was down; not worth catching up." };

    case "once_per_window": {
      const start = catchUp.windowStart;
      const end = catchUp.windowEnd;
      if (start === undefined || end === undefined) {
        return { action: "run", late };
      }
      // The window is expressed the same way quiet hours are, and reuses the
      // same wrap-aware predicate rather than a second implementation.
      if (isWithinQuietHours(new Date(now), { start, end }, tz)) {
        return { action: "run", late };
      }
      return { action: "skip", reason: `Outside the ${start}–${end} window.` };
    }
  }
}

/** What a handler is given. */
export interface JobContext {
  readonly job: Job;
  readonly run: Run;
  /** The instant this occurrence was scheduled for. */
  readonly triggerInstant: string;
  /** Whether it is firing after that instant. */
  readonly late: boolean;
  readonly now: number;
}

/** What a handler reports. */
export interface JobResult {
  readonly outcome: RunOutcome;
  readonly spoke?: boolean;
  readonly turns?: number;
  readonly costUsd?: number;
  readonly summary?: string | null;
  readonly error?: string | null;
}

/** A job kind's implementation. */
export type JobHandler = (context: JobContext) => Promise<JobResult> | JobResult;

/** A timer, injectable so a test never has to wait. */
export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The real one. Unrefs, so the runner is not a reason for the process to live. */
export const systemTimers: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface JobRunnerOptions {
  readonly store: JobStore;
  readonly handlers: ReadonlyMap<JobKind, JobHandler>;
  readonly clock?: Clock;
  readonly timers?: Timers;
  /** Identifies this process's leases. */
  readonly owner?: string;
  readonly leaseMs?: number;
  /** Reported rather than thrown: a failing job must not stop the loop. */
  readonly onError?: (error: unknown, job: Job | null) => void;
}

/** What one tick did. */
export interface TickResult {
  readonly ran: readonly string[];
  readonly skipped: readonly string[];
  readonly reclaimed: readonly string[];
  /** How long until the next tick, in milliseconds. */
  readonly nextTickMs: number;
}

export class JobRunner {
  readonly #store: JobStore;
  readonly #handlers: ReadonlyMap<JobKind, JobHandler>;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #onError: (error: unknown, job: Job | null) => void;

  #handle: unknown = null;
  #running = false;
  #inFlight: Promise<TickResult> | null = null;

  constructor(options: JobRunnerOptions) {
    this.#store = options.store;
    this.#handlers = options.handlers;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    this.#owner = options.owner ?? `syl-${process.pid}`;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#onError =
      options.onError ??
      ((error, job) => {
        console.error(`[syl] job ${job?.kind ?? "unknown"} failed`, error);
      });
  }

  /** Whether the loop is armed. */
  get started(): boolean {
    return this.#running;
  }

  /**
   * Start the loop.
   *
   * Awaiting this means "everything that was missed has been considered",
   * which is what a caller needs before it can claim the service is up. There
   * is no separate recovery step: every tick reclaims before it schedules, so
   * the first one is the recovery pass and the guarantee holds on every tick
   * rather than only on the first.
   */
  async start(): Promise<TickResult> {
    this.#running = true;
    return this.tick();
  }

  /** Stop the loop. Idempotent. */
  stop(): void {
    this.#running = false;
    if (this.#handle !== null) {
      this.#timers.clear(this.#handle);
      this.#handle = null;
    }
  }

  /**
   * One pass: reclaim, run at most one job, re-arm.
   *
   * Serialised against itself. A tick that overlaps its predecessor would
   * break the concurrency-of-one rule the moment a job took longer than the
   * interval, which for a research brief is most of them.
   */
  async tick(): Promise<TickResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const pass = this.#pass();
    this.#inFlight = pass;
    try {
      return await pass;
    } finally {
      this.#inFlight = null;
    }
  }

  async #pass(): Promise<TickResult> {
    const now = this.#clock();
    const reclaimed = this.#store.recoverLeases(this.#owner, now);

    const ran: string[] = [];
    const skipped: string[] = [];

    // Concurrency one. The highest-priority due job goes; everything else
    // waits for the next tick, which is at most a minute away.
    const next = this.#store.due(now)[0];
    if (next !== undefined) {
      const outcome = await this.#runOne(next, now);
      if (outcome === "skipped") skipped.push(next.id);
      else ran.push(next.id);
    }

    const nextTickMs = this.#armFrom(this.#clock());
    return { ran, skipped, reclaimed, nextTickMs };
  }

  /** Lease, decide catch-up, execute, release. */
  async #runOne(job: Job, now: number): Promise<RunOutcome | "skipped"> {
    const leased = this.#store.lease(job.id, this.#owner, this.#leaseMs);
    if (leased === null) return "skipped";

    const triggerInstant = leased.nextRunAt ?? instant(now);
    const decision = decideCatchUp(
      leased.catchUp,
      parseInstant(triggerInstant) ?? now,
      now,
      leased.trigger.tz ?? "UTC",
    );

    const run = this.#store.startRun(leased, triggerInstant, now);

    if (decision.action === "skip") {
      // A skip is recorded, not silent. The gap between what was scheduled and
      // what happened is the whole reason the runs table exists.
      this.#store.finishRun(run.id, { outcome: "skipped", summary: decision.reason });
      this.#store.release(leased.id, "skipped", run.id);
      return "skipped";
    }

    const handler = this.#handlers.get(leased.kind);
    if (handler === undefined) {
      this.#store.finishRun(run.id, {
        outcome: "failure",
        error: `No handler is registered for ${leased.kind}.`,
      });
      this.#store.release(leased.id, "failure", run.id);
      return "failure";
    }

    this.#store.markRunning(leased.id);

    try {
      const result = await handler({
        job: leased,
        run,
        triggerInstant,
        late: decision.late,
        now,
      });
      this.#store.finishRun(run.id, result);
      this.#store.release(leased.id, result.outcome, run.id);
      return result.outcome;
    } catch (error) {
      // A failing job must never stop the loop: the next reminder is behind it.
      this.#onError(error, leased);
      this.#store.finishRun(run.id, {
        outcome: "failure",
        error: error instanceof Error ? error.message : String(error),
      });
      this.#store.release(leased.id, "failure", run.id);
      return "failure";
    }
  }

  /**
   * Arm the timer for `min(next due instant, 60s)`, measured from now.
   *
   * The ceiling is what makes the loop self-healing: however wrong the last
   * timer turned out to be — a laptop asleep for six hours, a clock stepped by
   * NTP — the next tick recomputes everything from the current instant, and a
   * long sleep is indistinguishable from a long tick.
   */
  #armFrom(now: number): number {
    if (this.#handle !== null) {
      this.#timers.clear(this.#handle);
      this.#handle = null;
    }
    if (!this.#running) return 0;

    const nextTickMs = this.nextTickMs(now);
    this.#handle = this.#timers.set(() => {
      void this.tick();
    }, nextTickMs);
    return nextTickMs;
  }

  /** How long the next tick should be, given the clock. */
  nextTickMs(now: number = this.#clock()): number {
    const next = this.#store.nextRunAt();
    const until = next === null ? MAX_TICK_MS : (parseInstant(next) ?? now) - now;
    return Math.max(MIN_TICK_MS, Math.min(MAX_TICK_MS, until));
  }
}
