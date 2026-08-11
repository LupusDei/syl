/**
 * Everything the job and run viewer decides, as pure functions.
 *
 * The rendering is thin on purpose: the judgements worth testing are "is this
 * job in trouble", "what does this trigger actually mean" and "did this run
 * fire late", and none of them need a DOM to be checked.
 */

import type {
  CircuitBreaker,
  Job,
  JobBudget,
  JobLease,
  JobState,
  JobTrigger,
  Run,
  RunOutcome,
} from "@syl/shared/types";

import { elapsedMs, isNotablyLate } from "../../format/time";
import { humanise, pluralise } from "../../format/text";
import type { Tone } from "../../ui/Badge";

/**
 * The state filter, as offered in the toolbar.
 *
 * Written as an exhaustive `Record` rather than an array so that a state
 * added to the contract **fails typecheck here** until it is listed. An array
 * of the same strings would silently omit it, and the filter would quietly
 * stop being able to ask about the newest kind of failure — which is exactly
 * the one you would want to ask about.
 */
const JOB_STATE_ORDER: Record<JobState, true> = {
  pending: true,
  leased: true,
  running: true,
  done: true,
  failed: true,
  abandoned: true,
  suspended: true,
};

// Safe: the keys of an exhaustive `Record<JobState, …>` are exactly `JobState`.
export const JOB_STATES = Object.keys(JOB_STATE_ORDER) as readonly JobState[];

export function jobStateTone(state: JobState): Tone {
  switch (state) {
    case "done":
      return "ok";
    case "running":
    case "leased":
      return "accent";
    case "failed":
    case "abandoned":
      return "fail";
    case "suspended":
      return "warn";
    default:
      return "pending";
  }
}

export function runOutcomeTone(outcome: RunOutcome): Tone {
  switch (outcome) {
    case "success":
      return "ok";
    case "failure":
    case "abandoned":
      return "fail";
    case "suspended":
      return "warn";
    default:
      return "muted";
  }
}

/**
 * A trigger in one line.
 *
 * `wall_clock` keeps its wall time *and* its zone together, because the pair
 * is the value — an instant on its own is the fixed-offset bug in a different
 * costume, and a viewer that shows only one half invites exactly that mistake.
 */
export function describeTrigger(trigger: JobTrigger): string {
  switch (trigger.type) {
    case "wall_clock": {
      const time = trigger.wallTime ?? "??:??";
      const zone = trigger.tz ?? "no zone";
      const rule = trigger.rrule === null || trigger.rrule === undefined ? "" : ` · ${trigger.rrule}`;
      return `${time} ${zone}${rule}`;
    }
    case "interval": {
      const ms = trigger.intervalMs;
      return ms === null || ms === undefined ? "every ?" : `every ${Math.round(ms / 1000)}s`;
    }
    case "event":
      return `on ${trigger.event ?? "?"}`;
    default:
      return "manual";
  }
}

/**
 * The budget in one line. `maxTurns: 0` is called out rather than shown as a
 * number: a job that cannot spawn a turn cannot be delayed by a rate limit or
 * broken by a model declining to act, and that is the most useful thing on
 * the row.
 */
export function describeBudget(budget: JobBudget): string {
  const turns = budget.maxTurns === 0 ? "no turns" : pluralise(budget.maxTurns, "turn");
  const tools =
    budget.allowedTools.length === 0 ? "no tools" : `${budget.allowedTools.length} tools`;
  return `${turns} · ${tools}`;
}

export function describeLease(lease: JobLease | null): string {
  return lease === null ? "—" : lease.owner;
}

/** A breaker that has tripped is the loudest thing on a job row. */
export function breakerTone(breaker: CircuitBreaker): Tone {
  switch (breaker.state) {
    case "open":
      return "fail";
    case "half_open":
      return "warn";
    default:
      return breaker.consecutiveFailures > 0 ? "warn" : "muted";
  }
}

export function describeBreaker(breaker: CircuitBreaker): string {
  const failures =
    breaker.consecutiveFailures === 0
      ? ""
      : ` · ${pluralise(breaker.consecutiveFailures, "failure")}`;
  return `${humanise(breaker.state)}${failures}`;
}

/**
 * Is this job worth looking at before the others?
 *
 * Used to sort, not to hide: a filter that quietly drops rows is how a
 * debugging surface starts lying. The order is failure first, then a tripped
 * breaker, then running work, then everything else by next run.
 */
export function jobUrgency(job: Job): number {
  if (job.state === "failed" || job.state === "abandoned") return 0;
  if (job.circuitBreaker.state !== "closed") return 1;
  if (job.state === "suspended") return 2;
  if (job.state === "running" || job.state === "leased") return 3;
  return 4;
}

export function sortJobs(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const byUrgency = jobUrgency(a) - jobUrgency(b);
    if (byUrgency !== 0) return byUrgency;
    // Soonest next run first; a job with none sorts after one that has one.
    if (a.nextRunAt === null && b.nextRunAt === null) return a.kind.localeCompare(b.kind);
    if (a.nextRunAt === null) return 1;
    if (b.nextRunAt === null) return -1;
    return a.nextRunAt.localeCompare(b.nextRunAt);
  });
}

/** How long a run took, or `null` while it is still going. */
export function runDurationMs(run: Run): number | null {
  return elapsedMs(run.startedAt, run.finishedAt);
}

export function runIsLate(run: Run): boolean {
  return isNotablyLate(run.latenessMs);
}

/**
 * The one-line reason a run is interesting, or the empty string.
 *
 * A failure's error wins over its summary: when a run failed, the summary is
 * what it managed to say and the error is what actually happened.
 */
export function runDetail(run: Run): string {
  if (run.error !== null && run.error.length > 0) return run.error;
  return run.summary ?? "";
}
