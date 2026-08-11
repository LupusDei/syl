import type {
  Job,
  JobBudget,
  JobCatchUp,
  JobDeliveryClass,
  JobKind,
  JobPage,
  JobPriority,
  JobState,
  JobTrigger,
  Run,
  RunOutcome,
  RunPage,
  RunStep,
} from "@syl/shared";

import { instant, parseInstant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import { pageOf, resolvePage, type PageOptions } from "./paging.js";
import { nextOccurrence, parseRrule } from "./recurrence.js";
import type { Database } from "./sqlite.js";

/**
 * Jobs, runs and steps.
 *
 * The persistence half of the runner: everything here is a query, and every
 * decision about *whether* to run something lives in `job-runner.ts`. The seam
 * is worth it because the interesting failures on this side are schema
 * failures — a lease that was not reclaimed, a run that has no end — and they
 * are testable without a timer.
 */

/** The closed catalogue. The model may enqueue; it may never invent a kind. */
export const JOB_KINDS: readonly JobKind[] = [
  "reminder_delivery",
  "morning_agenda",
  "evening_review",
  "heartbeat",
  "nightly_consolidation",
  "research_brief",
  "content_ingestion",
  "maintenance",
];

export const JOB_STATES: readonly JobState[] = [
  "pending",
  "leased",
  "running",
  "done",
  "failed",
  "abandoned",
  "suspended",
];

/**
 * Priority order. Background never *starts* while interactive work is pending.
 *
 * Lower sorts first.
 */
const PRIORITY_ORDER: Readonly<Record<JobPriority, number>> = {
  interactive: 0,
  reminder: 1,
  scheduled: 2,
  background: 3,
};

/** Consecutive failures before a kind is disabled and reported once. */
export const BREAKER_THRESHOLD = 5;

/**
 * How long an open breaker stays shut before one trial run is allowed through.
 *
 * **A breaker with no way back is not a breaker, it is a kill switch.** The
 * only path to `release` — the one call that can close a breaker — runs through
 * `due`, and `due` excludes open breakers. Without a cooldown the job could
 * never be selected, never run, and never be released, so five transient
 * failures ended reminder delivery permanently and silently, across restarts.
 * Any throw counted: an APNs socket reset, SQLITE_BUSY, a bad stored rrule.
 *
 * Five minutes is chosen against the thing being protected. The breaker exists
 * to stop a hot loop, and going from a 60-second tick to a 5-minute probe is a
 * factor of five off the failing path — while a reminder held by an open
 * breaker is at worst five minutes late, and says so. A late reminder is a
 * nuisance; a vanished one destroys trust.
 */
export const BREAKER_COOLDOWN_MS = 5 * 60_000;

/** Thrown when a job cannot be written as asked. */
export class JobStoreError extends Error {
  readonly kind: "unknown_kind" | "bad_trigger";

  constructor(kind: JobStoreError["kind"], message: string) {
    super(message);
    this.name = "JobStoreError";
    this.kind = kind;
  }
}

/** What defining a job requires. */
export interface DefineJob {
  readonly kind: string;
  readonly priority: JobPriority;
  readonly trigger: JobTrigger;
  readonly deliveryClass: JobDeliveryClass;
  readonly catchUp: JobCatchUp;
  readonly budget: JobBudget;
  readonly speaks: boolean;
  /** Overrides the trigger's own computation. For a manual or event job. */
  readonly nextRunAt?: string | null;
}

interface JobRow {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly priority: JobPriority;
  readonly trigger_json: string;
  readonly delivery_class: JobDeliveryClass;
  readonly catch_up_json: string;
  readonly budget_json: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly breaker_state: "closed" | "open" | "half_open";
  readonly breaker_failures: number;
  readonly breaker_opened_at: string | null;
  readonly next_run_at: string | null;
  readonly last_run_id: string | null;
  readonly speaks: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunRow {
  readonly id: string;
  readonly job_id: string;
  readonly kind: JobKind;
  readonly trigger_instant: string;
  readonly actual_instant: string | null;
  readonly lateness_ms: number;
  readonly outcome: RunOutcome;
  readonly spoke: number;
  readonly turns: number;
  readonly cost_usd: number;
  readonly summary: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly started_at: string;
  readonly finished_at: string | null;
}

interface StepRow {
  readonly id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly session_id: string | null;
  readonly num_turns: number;
  readonly cost_usd: number;
  readonly outcome: RunOutcome;
  readonly summary: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

const JOB_COLUMNS =
  "id, kind, state, priority, trigger_json, delivery_class, catch_up_json, budget_json, " +
  "lease_owner, lease_expires_at, breaker_state, breaker_failures, breaker_opened_at, " +
  "next_run_at, last_run_id, speaks, created_at, updated_at";

const RUN_COLUMNS =
  "id, job_id, kind, trigger_instant, actual_instant, lateness_ms, outcome, spoke, turns, " +
  "cost_usd, summary, error, attempts, started_at, finished_at";

const STEP_COLUMNS =
  "id, run_id, step_index, session_id, num_turns, cost_usd, outcome, summary, started_at, finished_at";

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    // Safe assertions: every JSON column below is written by this module from
    // a typed value and read back into the same type.
    trigger: JSON.parse(row.trigger_json) as JobTrigger,
    deliveryClass: row.delivery_class,
    catchUp: JSON.parse(row.catch_up_json) as JobCatchUp,
    budget: JSON.parse(row.budget_json) as JobBudget,
    lease:
      row.lease_owner === null || row.lease_expires_at === null
        ? null
        : { owner: row.lease_owner, expiresAt: row.lease_expires_at },
    circuitBreaker: {
      state: row.breaker_state,
      consecutiveFailures: row.breaker_failures,
      openedAt: row.breaker_opened_at,
    },
    nextRunAt: row.next_run_at,
    lastRunId: row.last_run_id,
    speaks: row.speaks === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStep(row: StepRow): RunStep {
  return {
    id: row.id,
    index: row.step_index,
    sessionId: row.session_id,
    numTurns: row.num_turns,
    costUsd: row.cost_usd,
    outcome: row.outcome,
    summary: row.summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The next instant a trigger fires, strictly after `from`.
 *
 * Recomputed from the wall clock and the zone every time rather than
 * incremented, so sleep, wake, daylight saving and NTP corrections all
 * self-heal. An interval trigger is measured from `from`, which is `now` on
 * every tick, so a long sleep is indistinguishable from a long tick.
 *
 * @returns `null` for an event or manual trigger, which nothing schedules.
 */
export function nextRunAtFor(trigger: JobTrigger, from: number): string | null {
  if (trigger.type === "interval") {
    const intervalMs = trigger.intervalMs ?? null;
    if (intervalMs === null) {
      throw new JobStoreError("bad_trigger", "An interval trigger needs an intervalMs.");
    }
    return instant(from + intervalMs);
  }

  if (trigger.type === "wall_clock") {
    const wallTime = trigger.wallTime;
    const tz = trigger.tz;
    if (wallTime === undefined || tz === undefined) {
      throw new JobStoreError("bad_trigger", "A wall-clock trigger needs a wallTime and a tz.");
    }
    const rule = trigger.rrule == null ? null : parseRrule(trigger.rrule);
    return nextOccurrence(rule, wallTime, new Date(from), tz).toISOString();
  }

  return null;
}

export interface JobStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

/** What `listRuns` may filter on. */
export interface RunFilter extends PageOptions {
  readonly jobId?: string;
  /**
   * Restrict to particular job kinds.
   *
   * Needed because runs are ordered by time across every kind, and
   * `reminder_delivery` wakes at least once a minute: a page of "the most
   * recent hundred runs" is a hundred deliveries and none of the two kinds a
   * caller asking about her unattended work actually means. Filtering by job
   * id cannot express "these two kinds" without the caller first finding two
   * rows it has no other reason to hold.
   */
  readonly kinds?: readonly string[];
}

export class JobStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: JobStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /** Define a job. */
  define(input: DefineJob): Job {
    const kind = JOB_KINDS.find((candidate) => candidate === input.kind);
    if (kind === undefined) {
      throw new JobStoreError(
        "unknown_kind",
        `"${input.kind}" is not a job kind. The catalogue is closed on purpose.`,
      );
    }

    const now = this.#clock();
    const at = instant(now);
    const id = newId("job");
    const nextRunAt =
      input.nextRunAt === undefined ? nextRunAtFor(input.trigger, now) : input.nextRunAt;

    this.#db
      .prepare(
        `INSERT INTO jobs (${JOB_COLUMNS})
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, 'closed', 0, NULL, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        input.priority,
        JSON.stringify(input.trigger),
        input.deliveryClass,
        JSON.stringify(input.catchUp),
        JSON.stringify(input.budget),
        nextRunAt,
        input.speaks ? 1 : 0,
        at,
        at,
      );

    const job = this.get(id);
    if (job === null) throw new Error("job vanished during define");
    return job;
  }

  /** One job by id, or `null`. */
  get(id: string): Job | null {
    const row = this.#db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id);
    return row === undefined ? null : toJob(row as unknown as JobRow);
  }

  /** A page of jobs, soonest first. */
  list(filter: PageOptions & { state?: JobState; kind?: JobKind } = {}): JobPage {
    const { limit, offset } = resolvePage(filter);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filter.state !== undefined) {
      conditions.push("state = ?");
      bindings.push(filter.state);
    }
    if (filter.kind !== undefined) {
      conditions.push("kind = ?");
      bindings.push(filter.kind);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs ${where}
          ORDER BY next_run_at IS NULL, next_run_at, id
          LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit + 1, offset);

    return pageOf(
      rows.map((row) => toJob(row as unknown as JobRow)),
      limit,
      offset,
    );
  }

  /**
   * Everything due, highest priority first.
   *
   * A job whose breaker is open is excluded **for the cooldown, and no
   * longer**. After that one trial run is let through — the half-open probe —
   * because `release` is reachable only from here, so a breaker that excluded
   * its job unconditionally could never be closed by anything: not a success,
   * not an endpoint, not a restart.
   *
   * A breaker in a state this code did not write (`open` with no instant
   * recorded) is treated as ready to probe. Failing open is the right way for
   * this particular predicate to be wrong.
   */
  due(now: number = this.#clock()): readonly Job[] {
    const rows = this.#db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE state = 'pending'
            AND (breaker_state != 'open'
                 OR breaker_opened_at IS NULL
                 OR breaker_opened_at <= ?)
            AND next_run_at IS NOT NULL
            AND next_run_at <= ?
          ORDER BY next_run_at, id`,
      )
      .all(instant(now - BREAKER_COOLDOWN_MS), instant(now));

    return rows
      .map((row) => toJob(row as unknown as JobRow))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }

  /**
   * The next instant anything is scheduled, or `null`.
   *
   * An open breaker hides its job only until the cooldown expires. It must
   * agree with `due` about that: a job `due` would return but this one hides
   * is a job the runner never arms a timer for.
   */
  nextRunAt(now: number = this.#clock()): string | null {
    const row = this.#db
      .prepare(
        `SELECT min(next_run_at) AS next FROM jobs
          WHERE state = 'pending'
            AND (breaker_state != 'open'
                 OR breaker_opened_at IS NULL
                 OR breaker_opened_at <= ?)
            AND next_run_at IS NOT NULL`,
      )
      .get(instant(now - BREAKER_COOLDOWN_MS));
    // Safe assertion: `min` over a TEXT column is TEXT or NULL.
    return (row as unknown as { next: string | null } | undefined)?.next ?? null;
  }

  /**
   * Take a lease on a job.
   *
   * A job whose breaker has been open longer than the cooldown moves to
   * `half_open` as it is leased: taking the lease *is* the trial run, and
   * recording it here means the state on the admin surface says what is
   * actually happening rather than "open" forever.
   *
   * @returns the leased job, or `null` if another runner got there first. The
   * `state = 'pending'` predicate in the UPDATE is what makes that race safe
   * without a transaction: exactly one writer changes the row.
   */
  lease(id: string, owner: string, leaseMs: number): Job | null {
    const now = this.#clock();
    const expiresAt = instant(now + leaseMs);
    const result = this.#db
      .prepare(
        `UPDATE jobs
            SET state = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?,
                breaker_state = CASE
                  WHEN breaker_state = 'open'
                       AND (breaker_opened_at IS NULL OR breaker_opened_at <= ?)
                  THEN 'half_open'
                  ELSE breaker_state
                END
          WHERE id = ? AND state = 'pending'`,
      )
      .run(owner, expiresAt, instant(now), instant(now - BREAKER_COOLDOWN_MS), id);

    return Number(result.changes) === 0 ? null : this.get(id);
  }

  /** Move a leased job into `running`. */
  markRunning(id: string): Job | null {
    this.#db
      .prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?")
      .run(instant(this.#clock()), id);
    return this.get(id);
  }

  /**
   * Release a job, schedule its next occurrence, and move the breaker.
   *
   * Rescheduling is computed from `now` rather than from the instant that was
   * missed, so a machine that was asleep for a day does not wake up and fire a
   * day's worth of triggers.
   *
   * `nextRunAt` lets a handler name its own next instant. The reminder job is
   * the reason: what it needs is `min(next reminder, next outbox attempt)`,
   * which no trigger expression can know and only the job itself can compute.
   *
   * The breaker moves here and nowhere else. A success closes it outright,
   * whatever it was — that is what makes the half-open probe worth running. A
   * failure at or past the threshold opens it **from this instant**: the
   * cooldown is measured from the last failure, never from the first, or a
   * breaker that keeps failing its probes would go straight back to being a
   * one-way door.
   */
  release(
    id: string,
    outcome: RunOutcome,
    runId: string | null,
    nextRunAt?: string | null,
  ): Job | null {
    const job = this.get(id);
    if (job === null) return null;

    const now = this.#clock();
    const failed = outcome === "failure";
    const failures = failed ? job.circuitBreaker.consecutiveFailures + 1 : 0;
    const breakerState = failures >= BREAKER_THRESHOLD ? "open" : "closed";
    const openedAt = breakerState === "open" ? instant(now) : null;

    this.#db
      .prepare(
        `UPDATE jobs
            SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                next_run_at = ?, last_run_id = ?, breaker_failures = ?, breaker_state = ?,
                breaker_opened_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        nextRunAt === undefined ? nextRunAtFor(job.trigger, now) : nextRunAt,
        runId ?? job.lastRunId,
        failures,
        breakerState,
        openedAt,
        instant(now),
        id,
      );

    return this.get(id);
  }

  /**
   * Reclaim leases this process does not hold, or that have expired.
   *
   * Runs **before** anything is scheduled. A runner that starts scheduling
   * before it has looked at what it missed silently swallows whatever was due
   * while it was down, which is the failure this table exists to prevent.
   *
   * An `at_most_once` job whose run was interrupted is **not** re-run: its run
   * is marked abandoned. Re-running a crashed heartbeat risks duplicating a
   * proactive message, and skipping is both simpler and correct.
   *
   * @returns the ids of the jobs it reclaimed.
   */
  recoverLeases(owner: string, now: number = this.#clock()): readonly string[] {
    const rows = this.#db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE state IN ('leased', 'running')
            AND (lease_owner IS NULL OR lease_owner != ? OR lease_expires_at <= ?)`,
      )
      .all(owner, instant(now));

    const reclaimed: string[] = [];
    for (const raw of rows) {
      const job = toJob(raw as unknown as JobRow);

      // The run that was in flight is already `abandoned` in the table — that
      // is what an unfinished run truthfully is — so all that is needed is to
      // close it off with a finish instant.
      this.#db
        .prepare(
          `UPDATE runs SET finished_at = ?, error = ?
            WHERE job_id = ? AND finished_at IS NULL`,
        )
        .run(
          instant(now),
          "The runner stopped before this run finished. Reclaimed on the next start.",
          job.id,
        );

      // Rescheduled from now: what to do about the instant that passed is the
      // catch-up policy's decision, made on the next tick, not here.
      this.#db
        .prepare(
          `UPDATE jobs
              SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                  next_run_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          job.deliveryClass === "at_most_once"
            ? nextRunAtFor(job.trigger, now)
            : (job.nextRunAt ?? nextRunAtFor(job.trigger, now)),
          instant(now),
          job.id,
        );

      reclaimed.push(job.id);
    }

    return reclaimed;
  }

  /**
   * Open a run.
   *
   * The row exists from the first moment, carrying `abandoned` and a null
   * `finished_at`. That is not a placeholder: it is the truthful answer to
   * "what was this run, if we never come back to it", which is exactly what a
   * crash makes true.
   */
  startRun(job: Job, triggerInstant: string, now: number = this.#clock()): Run {
    const id = newId("run");
    const at = instant(now);
    const lateness = Math.max(0, now - (parseInstant(triggerInstant) ?? now));

    this.#db
      .prepare(
        `INSERT INTO runs (${RUN_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, 'abandoned', 0, 0, 0, NULL, NULL, 1, ?, NULL)`,
      )
      .run(id, job.id, job.kind, triggerInstant, at, lateness, at);

    const run = this.run(id);
    if (run === null) throw new Error("run vanished during start");
    return run;
  }

  /** Conclude a run. */
  finishRun(
    id: string,
    result: {
      readonly outcome: RunOutcome;
      readonly spoke?: boolean;
      readonly turns?: number;
      readonly costUsd?: number;
      readonly summary?: string | null;
      readonly error?: string | null;
    },
  ): Run | null {
    this.#db
      .prepare(
        `UPDATE runs
            SET outcome = ?, spoke = ?, turns = ?, cost_usd = ?, summary = ?, error = ?,
                finished_at = ?
          WHERE id = ?`,
      )
      .run(
        result.outcome,
        result.spoke === true ? 1 : 0,
        result.turns ?? 0,
        result.costUsd ?? 0,
        result.summary ?? null,
        result.error ?? null,
        instant(this.#clock()),
        id,
      );
    return this.run(id);
  }

  /**
   * Record a step.
   *
   * Persisted after every turn and before the next one starts, because a turn
   * is atomic from the outside: either it completed and we have the session
   * id, the turn count and the cost, or it did not and there is nothing
   * partial to reconcile.
   */
  appendStep(
    runId: string,
    step: {
      readonly index: number;
      readonly sessionId?: string | null;
      readonly numTurns?: number;
      readonly costUsd?: number;
      readonly outcome: RunOutcome;
      readonly summary?: string | null;
      readonly startedAt: string;
      readonly finishedAt?: string | null;
    },
  ): RunStep {
    const id = newId("step");
    this.#db
      .prepare(`INSERT INTO run_steps (${STEP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        runId,
        step.index,
        step.sessionId ?? null,
        step.numTurns ?? 0,
        step.costUsd ?? 0,
        step.outcome,
        step.summary ?? null,
        step.startedAt,
        step.finishedAt ?? null,
      );

    return {
      id,
      index: step.index,
      sessionId: step.sessionId ?? null,
      numTurns: step.numTurns ?? 0,
      costUsd: step.costUsd ?? 0,
      outcome: step.outcome,
      summary: step.summary ?? null,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt ?? null,
    };
  }

  /** One run with its ordered steps, or `null`. */
  run(id: string): Run | null {
    const row = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id);
    if (row === undefined) return null;

    const typed = row as unknown as RunRow;
    const steps = this.#db
      .prepare(`SELECT ${STEP_COLUMNS} FROM run_steps WHERE run_id = ? ORDER BY step_index`)
      .all(id)
      .map((step) => toStep(step as unknown as StepRow));

    return {
      id: typed.id,
      jobId: typed.job_id,
      kind: typed.kind,
      triggerInstant: typed.trigger_instant,
      actualInstant: typed.actual_instant,
      latenessMs: typed.lateness_ms,
      outcome: typed.outcome,
      spoke: typed.spoke === 1,
      turns: typed.turns,
      costUsd: typed.cost_usd,
      summary: typed.summary,
      error: typed.error,
      attempts: typed.attempts,
      startedAt: typed.started_at,
      finishedAt: typed.finished_at,
      steps,
    };
  }

  /** A page of runs, newest first. */
  listRuns(filter: RunFilter = {}): RunPage {
    const { limit, offset } = resolvePage(filter);

    const clauses: string[] = [];
    const bindings: string[] = [];
    if (filter.jobId !== undefined) {
      clauses.push("job_id = ?");
      bindings.push(filter.jobId);
    }
    // Placeholders rather than an interpolated list: the kinds are a closed
    // catalogue today and this stays sound the day one of them is a variable.
    if (filter.kinds !== undefined && filter.kinds.length > 0) {
      clauses.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      bindings.push(...filter.kinds);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;

    const rows = this.#db
      .prepare(
        `SELECT id FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit + 1, offset);

    const runs = rows
      // Safe assertion: a single TEXT column selected by name.
      .map((row) => this.run((row as unknown as { id: string }).id))
      .filter((run): run is Run => run !== null);

    return pageOf(runs, limit, offset);
  }
}
