import type {
  Delivery,
  DeliveryChannel,
  DeliveryEngagement,
  DeliveryPage,
  DeliveryPayload,
  DeliveryState,
} from "@syl/shared";

import { deferPastQuietHours, type QuietHours } from "../harness/schedule.js";
import { instant, parseInstant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import { pageOf, resolvePage, type PageOptions } from "./paging.js";
import type { Database } from "./sqlite.js";

/**
 * The delivery outbox.
 *
 * This is where the never-drop guarantee actually lives. Apple cannot tell us
 * whether a notification arrived — there is no delivery-status API, only a web
 * console — and while a device is offline Apple retains only the most recent
 * notification per app, so a night of reminders collapses into one. Push is
 * therefore a notification, not the delivery mechanism.
 *
 * What makes a reminder undroppable is the row: written before the push is
 * attempted, surviving a failed attempt and a reboot and a week of the phone
 * being off, and marked delivered only when the device itself says so.
 *
 * **Quiet hours are gated here, one step before the channel — not in the
 * scheduler.** Nightly consolidation runs at 02:30 and must work at full
 * effort while saying nothing. A predicate in the job runner would either stop
 * it running or need a bypass, and bypasses rot.
 */

/** How many times a transient failure is retried before the row is abandoned. */
export const MAX_ATTEMPTS = 6;

/**
 * Backoff between attempts, in milliseconds.
 *
 * Bounded on purpose. Nothing retries forever: an outbox row that has been
 * failing for two hours is not going to succeed on the two-hundredth attempt,
 * and the app's foreground reconcile picks it up regardless of what this table
 * says. The row stays visible either way — abandoning is not forgetting.
 */
export const BACKOFF_MS: readonly number[] = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

/** Up to this fraction of a backoff step is added at random. */
const JITTER_FRACTION = 0.2;

/**
 * How long a claimed row may stay `sending` before another pass reclaims it.
 *
 * A process that dies between `markSending` and the result leaves a row in
 * flight with nobody carrying it. If claiming cleared the attempt instant
 * outright, that row would sit there forever — a silently dropped reminder
 * with a perfectly healthy-looking table. So a claim is a *deadline*, not a
 * removal, and the reclaim is what makes a crash mid-send survivable.
 */
export const SENDING_STALE_MS = 60_000;

/** Quiet hours, and the zone they are expressed in. */
export interface QuietHoursPolicy {
  readonly quiet: QuietHours;
  readonly tz: string;
}

/**
 * The default quiet window, and the Commander's zone.
 *
 * An IANA zone, never a fixed UTC offset. An offset is a property of an
 * instant rather than of a place, and one that reaches storage survives
 * exactly one daylight-saving boundary before moving every window by an hour.
 */
export const DEFAULT_QUIET_HOURS: QuietHoursPolicy = {
  quiet: { start: "22:00", end: "08:00" },
  tz: "America/Chicago",
};

/** Read the quiet window from an environment, falling back to the default. */
export function quietHoursFromEnv(env: NodeJS.ProcessEnv): QuietHoursPolicy {
  const read = (name: string): string | undefined => {
    const trimmed = env[name]?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
  };

  return {
    quiet: {
      start: read("SYL_QUIET_START") ?? DEFAULT_QUIET_HOURS.quiet.start,
      end: read("SYL_QUIET_END") ?? DEFAULT_QUIET_HOURS.quiet.end,
    },
    tz: read("SYL_TZ") ?? DEFAULT_QUIET_HOURS.tz,
  };
}

/** What to put in the outbox. */
export interface EnqueueDelivery {
  readonly channel: DeliveryChannel;
  readonly messageClass: string;
  readonly reminderId?: string | null;
  readonly payload: DeliveryPayload;
  /**
   * The caller's own dedupe key, and the reason a delivery job that runs twice
   * writes one row. Derive it from the occurrence, never from the clock.
   */
  readonly idempotencyKey: string;
  readonly late?: boolean;
  readonly scheduledFor?: string | null;
  readonly coalescedReminderIds?: readonly string[];
  /**
   * Deliver even inside quiet hours. For genuinely urgent items only, and
   * rationed by being coupled to something already scarce.
   */
  readonly urgent?: boolean;
  /**
   * Override the computed release instant. Used by the recovery paths.
   *
   * Nullish means "compute it" — never "no instant at all". A pending row with
   * a null `next_attempt_at` is invisible to `due` and to `nextDueAt` forever:
   * a dropped reminder in a table that looks perfectly healthy. The one state
   * this class exists to make impossible must not be reachable by passing a
   * field the type already permits.
   */
  readonly notBefore?: string | null;
}

/** The result of an enqueue, and whether it wrote a new row. */
export interface EnqueueResult {
  readonly delivery: Delivery;
  readonly created: boolean;
}

/** What a send attempt produced. */
export interface AttemptFailure {
  readonly error: string;
  /** False for a permanent refusal: a bad topic will not fix itself. */
  readonly retryable: boolean;
}

interface DeliveryRow {
  readonly id: string;
  readonly channel: DeliveryChannel;
  readonly message_class: string;
  readonly reminder_id: string | null;
  readonly payload_json: string;
  readonly idempotency_key: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly delivered_at: string | null;
  readonly acked_at: string | null;
  readonly engagement: DeliveryEngagement | null;
  readonly late: number;
  readonly scheduled_for: string | null;
  readonly coalesced_ids: string;
  readonly apns_unique_id: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
}

const COLUMNS =
  "id, channel, message_class, reminder_id, payload_json, idempotency_key, state, attempts, " +
  "next_attempt_at, delivered_at, acked_at, engagement, late, scheduled_for, coalesced_ids, " +
  "apns_unique_id, last_error, created_at";

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    channel: row.channel,
    messageClass: row.message_class,
    reminderId: row.reminder_id,
    // Safe assertion: written by `enqueue` from a typed `DeliveryPayload`.
    payload: JSON.parse(row.payload_json) as DeliveryPayload,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    ackedAt: row.acked_at,
    engagement: row.engagement,
    late: row.late === 1,
    scheduledFor: row.scheduled_for,
    // Safe assertion: written by `enqueue` from a string array.
    coalescedReminderIds: JSON.parse(row.coalesced_ids) as string[],
    apnsUniqueId: row.apns_unique_id,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

/** How long to wait before attempt number `attempts`. */
export function backoffFor(attempts: number, jitter: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
  const base = BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 60_000;
  return Math.round(base * (1 + JITTER_FRACTION * jitter));
}

/**
 * How long to wait when the attempt could not be made at all.
 *
 * Derived from how long the row has been waiting rather than from a counter,
 * because a blocked row must **not** spend its attempt budget: an install with
 * no device paired for a week would otherwise arrive at the ceiling and be
 * abandoned on the first genuine APNs hiccup after the phone finally
 * registers.
 *
 * The same ladder as `backoffFor`, walked by elapsed time: 30s, then a minute,
 * then five, up to an hour. Nothing here ever gives up — an environment that
 * cannot send yet is a state to wait out, not a reason to drop a reminder —
 * but it stops the loop retrying every thirty seconds for weeks.
 */
export function blockedWaitFor(ageMs: number, jitter: number): number {
  let elapsed = 0;
  let step = 0;
  while (step < BACKOFF_MS.length - 1) {
    const current = BACKOFF_MS[step] ?? 0;
    if (elapsed + current > ageMs) break;
    elapsed += current;
    step += 1;
  }
  const base = BACKOFF_MS[step] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 60_000;
  return Math.round(base * (1 + JITTER_FRACTION * jitter));
}

export interface OutboxOptions {
  readonly db: Database;
  readonly clock?: Clock;
  /** Absent means "say anything at any hour", which is not what he asked for. */
  readonly quietHours?: QuietHoursPolicy;
  /** 0..1. Injected so a test can assert an exact backoff. */
  readonly jitter?: () => number;
}

/** What `list` may filter on. */
export interface DeliveryFilter extends PageOptions {
  readonly state?: DeliveryState;
  /** Only rows with a null `ackedAt`. The interesting view. */
  readonly unacknowledged?: boolean;
}

export class Outbox {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #quietHours: QuietHoursPolicy | null;
  readonly #jitter: () => number;

  constructor(options: OutboxOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#quietHours = options.quietHours ?? null;
    this.#jitter = options.jitter ?? Math.random;
  }

  /**
   * When something enqueued now may first be sent.
   *
   * Public because the reminder job needs to ask the same question in order to
   * decide whether to coalesce: a batch that is all being held until 08:00
   * should arrive as one notification, and the only way to know that is to ask
   * the gate.
   */
  releaseAt(now: number, urgent = false): string {
    if (this.#quietHours === null || urgent) return instant(now);
    return deferPastQuietHours(
      new Date(now),
      this.#quietHours.quiet,
      this.#quietHours.tz,
    ).toISOString();
  }

  /** Whether an instant falls inside the window that gates the outbox. */
  get quietHours(): QuietHoursPolicy | null {
    return this.#quietHours;
  }

  /**
   * Put a notification in the outbox.
   *
   * Re-enqueuing the same `idempotencyKey` returns the existing row untouched.
   * That is what makes the delivery job safe to run twice — after a reboot,
   * from a recovery pass, from two ticks racing — and it is enforced by a
   * UNIQUE index rather than by this check alone.
   */
  enqueue(input: EnqueueDelivery): EnqueueResult {
    const existing = this.byIdempotencyKey(input.idempotencyKey);
    if (existing !== null) return { delivery: existing, created: false };

    const now = this.#clock();
    const id = newId("delivery");
    const createdAt = instant(now);
    // Nullish, not just absent. `due` and `nextDueAt` both require a non-null
    // `next_attempt_at`, so writing one straight through would produce a
    // pending row no query in the system can ever return again.
    const nextAttemptAt = input.notBefore ?? this.releaseAt(now, input.urgent ?? false);

    this.#db
      .prepare(
        `INSERT INTO deliveries (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.channel,
        input.messageClass,
        input.reminderId ?? null,
        JSON.stringify(input.payload),
        input.idempotencyKey,
        nextAttemptAt,
        input.late === true ? 1 : 0,
        input.scheduledFor ?? null,
        JSON.stringify(input.coalescedReminderIds ?? []),
        createdAt,
      );

    const delivery = this.get(id);
    if (delivery === null) throw new Error("delivery vanished during enqueue");
    return { delivery, created: true };
  }

  /**
   * Fold more into a row that is still waiting for its window.
   *
   * A batch held by quiet hours is keyed on the instant it will be released,
   * so every pass inside one night addresses the same row — and the runner
   * wakes at least every sixty seconds, so a night is many passes. `enqueue`
   * returns the existing row untouched, which is right for a retry and wrong
   * for a batch that has grown: the reminders the later passes found would be
   * marked delivered while being named by no row anybody will ever see.
   *
   * The predicate is the whole safety argument. A row that has been claimed,
   * attempted, or whose release instant has arrived is **not** amendable: its
   * words may already be on their way to Apple, and quietly changing them
   * afterwards is the same silent drop by another route. The caller must then
   * write its own row rather than assume it was covered.
   *
   * @returns the amended row, or `null` if it can no longer be amended.
   */
  amendHeld(
    id: string,
    input: {
      readonly payload: DeliveryPayload;
      readonly reminderId: string | null;
      readonly coalescedReminderIds: readonly string[];
      readonly scheduledFor: string | null;
    },
  ): Delivery | null {
    const result = this.#db
      .prepare(
        `UPDATE deliveries
            SET payload_json = ?, reminder_id = ?, coalesced_ids = ?, scheduled_for = ?
          WHERE id = ?
            AND state = 'pending'
            AND attempts = 0
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at > ?`,
      )
      .run(
        JSON.stringify(input.payload),
        input.reminderId,
        JSON.stringify(input.coalescedReminderIds),
        input.scheduledFor,
        id,
        instant(this.#clock()),
      );

    return Number(result.changes) === 0 ? null : this.get(id);
  }

  /** One row by id, or `null`. */
  get(id: string): Delivery | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM deliveries WHERE id = ?`).get(id);
    return row === undefined ? null : toDelivery(row as unknown as DeliveryRow);
  }

  /** One row by the caller's dedupe key, or `null`. */
  byIdempotencyKey(key: string): Delivery | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM deliveries WHERE idempotency_key = ?`)
      .get(key);
    return row === undefined ? null : toDelivery(row as unknown as DeliveryRow);
  }

  /** A page of rows, newest first. */
  list(filter: DeliveryFilter = {}): DeliveryPage {
    const { limit, offset } = resolvePage(filter);

    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    if (filter.state !== undefined) {
      conditions.push("state = ?");
      bindings.push(filter.state);
    }
    if (filter.unacknowledged === true) conditions.push("acked_at IS NULL");

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM deliveries ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit + 1, offset);

    return pageOf(
      rows.map((row) => toDelivery(row as unknown as DeliveryRow)),
      limit,
      offset,
    );
  }

  /**
   * Everything that may be attempted now.
   *
   * `sending` rows are included when their attempt window has passed: a row
   * left mid-flight by a crash would otherwise sit there forever, which is
   * precisely the silent drop this table exists to prevent.
   */
  due(now: number = this.#clock(), limit = 100): readonly Delivery[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM deliveries
          WHERE state IN ('pending', 'sending')
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at
          LIMIT ?`,
      )
      .all(instant(now), limit);

    return rows.map((row) => toDelivery(row as unknown as DeliveryRow));
  }

  /** The next instant anything is due, or `null` if the outbox is quiet. */
  nextDueAt(): string | null {
    const row = this.#db
      .prepare(
        `SELECT min(next_attempt_at) AS next FROM deliveries
          WHERE state IN ('pending', 'sending') AND next_attempt_at IS NOT NULL`,
      )
      .get();
    // Safe assertion: `min` over a TEXT column is TEXT or NULL.
    const next = (row as unknown as { next: string | null } | undefined)?.next ?? null;
    return next;
  }

  /**
   * Claim a row for an attempt. Counts the attempt before it is made.
   *
   * The claim carries a deadline rather than clearing the attempt instant. A
   * process that dies between here and the result would otherwise leave the
   * row `sending` with a null `next_attempt_at`, which no query would ever
   * return again — a silently dropped reminder in a table that looks healthy.
   *
   * @returns the claimed row, or `null` if the claim was lost. The
   * `state IN ('pending','sending')` predicate is the compare-and-swap that
   * makes the claim safe, and returning the row regardless of whether it fired
   * would leave the caller unable to tell a won claim from a lost one — so a
   * row another pass already delivered, or the device already acknowledged,
   * would be pushed a second time.
   */
  markSending(id: string): Delivery | null {
    const result = this.#db
      .prepare(
        `UPDATE deliveries
            SET state = 'sending', attempts = attempts + 1, next_attempt_at = ?
          WHERE id = ? AND state IN ('pending', 'sending')`,
      )
      .run(instant(this.#clock() + SENDING_STALE_MS), id);

    return Number(result.changes) === 0 ? null : this.get(id);
  }

  /**
   * The attempt could not be made: no channel, no credentials, no device.
   *
   * Distinct from `recordFailure` on purpose. Nothing was sent and nothing
   * refused us, so this must not spend the row's attempt budget — an install
   * that sat unpaired for a week would otherwise be abandoned on the first
   * genuine hiccup after the phone finally registers. It must also not leave
   * the drain loop retrying every thirty seconds until then.
   *
   * So the row waits, with a backoff derived from its own age, and is **never**
   * abandoned: an environment that cannot send yet is a state to wait out, not
   * a reason to drop a reminder.
   */
  deferBlocked(id: string, error: string): Delivery | null {
    const current = this.get(id);
    if (current === null) return null;

    const now = this.#clock();
    const age = Math.max(0, now - (parseInstant(current.createdAt) ?? now));
    const wait = blockedWaitFor(age, this.#jitter());

    this.#db
      .prepare(
        `UPDATE deliveries SET state = 'pending', next_attempt_at = ?, last_error = ?
          WHERE id = ? AND state IN ('pending', 'sending')`,
      )
      .run(instant(now + wait), error, id);
    return this.get(id);
  }

  /**
   * APNs accepted the request.
   *
   * Note what this does *not* do: it does not mark the row delivered in the
   * sense that matters. `delivered_at` means Apple took it. Only the device's
   * own acknowledgement closes the loop, and until then the row is still open.
   */
  recordAccepted(id: string, options: { readonly apnsUniqueId?: string | null } = {}): Delivery | null {
    this.#db
      .prepare(
        `UPDATE deliveries
            SET state = 'delivered', delivered_at = ?, next_attempt_at = NULL,
                apns_unique_id = ?, last_error = NULL
          WHERE id = ?`,
      )
      .run(instant(this.#clock()), options.apnsUniqueId ?? null, id);
    return this.get(id);
  }

  /**
   * The attempt failed.
   *
   * A retryable failure goes back to `pending` with backoff until the attempt
   * ceiling, then `abandoned`. A permanent one is `failed` immediately —
   * retrying a wrong bundle id forever floods Apple with requests that cannot
   * succeed. Either way the row survives and the app's foreground reconcile
   * still finds it, which is why bounding retry is not the same as dropping.
   */
  recordFailure(id: string, failure: AttemptFailure): Delivery | null {
    const current = this.get(id);
    if (current === null) return null;

    if (!failure.retryable) {
      this.#db
        .prepare(
          "UPDATE deliveries SET state = 'failed', next_attempt_at = NULL, last_error = ? WHERE id = ?",
        )
        .run(failure.error, id);
      return this.get(id);
    }

    if (current.attempts >= MAX_ATTEMPTS) {
      this.#db
        .prepare(
          "UPDATE deliveries SET state = 'abandoned', next_attempt_at = NULL, last_error = ? WHERE id = ?",
        )
        .run(failure.error, id);
      return this.get(id);
    }

    const wait = backoffFor(current.attempts, this.#jitter());
    this.#db
      .prepare(
        "UPDATE deliveries SET state = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?",
      )
      .run(instant(this.#clock() + wait), failure.error, id);
    return this.get(id);
  }

  /**
   * The device confirmed.
   *
   * **This is the only call that makes a delivery real.** Acknowledging twice
   * is a no-op that returns the existing row: the device retries this by
   * design, and a second ack must not overwrite the first instant with a later
   * one — the first is the one that is true.
   */
  acknowledge(
    id: string,
    input: { readonly ackedAt: string; readonly engagement?: DeliveryEngagement },
  ): Delivery | null {
    const current = this.get(id);
    if (current === null) return null;
    if (current.ackedAt !== null) return current;

    this.#db
      .prepare(
        `UPDATE deliveries
            SET state = 'acknowledged', acked_at = ?, engagement = ?, next_attempt_at = NULL
          WHERE id = ?`,
      )
      .run(input.ackedAt, input.engagement ?? "delivered", id);
    return this.get(id);
  }
}
