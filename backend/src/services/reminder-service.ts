import type { Reminder, ReminderDeliveryState, ReminderKind, ReminderPage } from "@syl/shared";

import { instant, parseInstant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import { pageOf, resolvePage, type PageOptions } from "./paging.js";
import {
  RruleUnsupportedError,
  nextOccurrence,
  occurrenceOnDate,
  parseRrule,
} from "./recurrence.js";
import type { Database } from "./sqlite.js";

/**
 * Reminders.
 *
 * The text is composed **at creation time, in Syl's voice**, and read verbatim
 * at delivery. That is what lets delivery be a zero-turn path: nothing
 * downstream needs a model in order to know what to say, so nothing downstream
 * can be delayed by a rate limit or broken by a model declining to act.
 *
 * Two invariants live here and neither may be relaxed:
 *
 * 1. **Deferral always returns a strictly later instant.** A deferral that
 *    resolved to the same moment, or to an earlier one, is a reminder that
 *    vanishes — the single failure this project is built against. The store
 *    refuses rather than accepting it.
 * 2. **Rows are closed, never deleted.** Cancelling sets a state. A row that
 *    disappears takes its history with it, and the history is what proves the
 *    thing was not silently dropped.
 */

/** States a reminder can be in and still be waiting to fire. */
const PENDING_STATES: readonly ReminderDeliveryState[] = ["scheduled", "due", "deferred"];

const KINDS: readonly ReminderKind[] = ["commitment", "rhythm"];

const DELIVERY_STATES: readonly ReminderDeliveryState[] = [
  "scheduled",
  "due",
  "delivered",
  "acknowledged",
  "deferred",
  "completed",
  "cancelled",
  "failed",
];

/** `HH:MM`, 24-hour. */
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A reminder longer than this is a document, not a reminder. */
const MAX_TEXT = 2_000;

/** Thrown when a reminder cannot be written as asked. */
export class ReminderError extends Error {
  readonly kind:
    | "bad_text"
    | "bad_wall_time"
    | "bad_timezone"
    | "bad_kind"
    | "bad_schedule"
    | "rrule_unsupported"
    | "not_later";

  constructor(kind: ReminderError["kind"], message: string) {
    super(message);
    this.name = "ReminderError";
    this.kind = kind;
  }
}

/** What `POST /reminders` supplies. */
export interface CreateReminderInput {
  readonly text: string;
  readonly kind?: string;
  readonly wallTime: string;
  readonly tz: string;
  /** `YYYY-MM-DD` for a one-shot. Null or absent with an `rrule`. */
  readonly date?: string | null;
  readonly rrule?: string | null;
  readonly todoId?: string | null;
  readonly urgent?: boolean;
  /**
   * Why this exists, in his terms or hers. `syl-y82`.
   *
   * Required by `remind_me` since it shipped and DISCARDED until now, on the
   * one verb that wakes him. `SOUL.md` promises he can tell a good suggestion
   * from a wrong one and can tell her to stop making a kind he dislikes; both
   * were false while this was dropped on the floor.
   */
  readonly because?: string | null;
  /**
   * Whether HE asked, or SHE thought of it.
   *
   * A different question from `because`, and the one that was actually got
   * wrong: prose answers "why does this exist" and only sometimes "did he ask".
   * A list has to show him at a glance which ones are hers.
   *
   * Derived rather than claimed wherever it can be — a turn with no message
   * from him cannot be a response to one. See `tools/server.ts`.
   */
  readonly origin?: ReminderOrigin | null;
}

/** Who a reminder came from. */
export type ReminderOrigin = "he_asked" | "she_noticed";

/** Every field optional; omitted fields are left alone. */
export interface UpdateReminderInput {
  readonly text?: string;
  readonly wallTime?: string;
  readonly tz?: string;
  readonly rrule?: string | null;
  readonly urgent?: boolean;
}

/** What `list` may filter on. */
export interface ReminderFilter extends PageOptions {
  readonly state?: ReminderDeliveryState;
  readonly dueBefore?: string;
}

interface ReminderRow {
  readonly id: string;
  readonly kind: ReminderKind;
  readonly text: string;
  readonly todo_id: string | null;
  readonly event_id: string | null;
  readonly because: string | null;
  readonly origin: ReminderOrigin | null;
  readonly wall_time: string;
  readonly tz: string;
  readonly rrule: string | null;
  readonly scheduled_for: string;
  readonly next_fire_at: string;
  readonly urgent: number;
  readonly late: number;
  readonly deferred_from: string | null;
  readonly supersedes_previous: number;
  readonly skipped_count: number;
  readonly delivery_state: ReminderDeliveryState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

const COLUMNS =
  "id, kind, text, todo_id, event_id, wall_time, tz, rrule, scheduled_for, next_fire_at, " +
  "urgent, late, deferred_from, supersedes_previous, skipped_count, delivery_state, " +
  "created_at, updated_at, completed_at, because, origin";

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    todoId: row.todo_id,
    eventId: row.event_id,
    wallTime: row.wall_time,
    tz: row.tz,
    rrule: row.rrule,
    scheduledFor: row.scheduled_for,
    nextFireAt: row.next_fire_at,
    urgent: row.urgent === 1,
    late: row.late === 1,
    deferredFrom: row.deferred_from,
    supersedesPrevious: row.supersedes_previous === 1,
    deliveryState: row.delivery_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    because: row.because,
    origin: row.origin,
  };
}

/** How many occurrences of a rhythm message a reminder has skipped. */
export function skippedCountOf(db: Database, id: string): number {
  const row = db.prepare("SELECT skipped_count FROM reminders WHERE id = ?").get(id);
  // Safe assertion: our own INTEGER NOT NULL column on a STRICT table.
  return (row as unknown as { skipped_count: number } | undefined)?.skipped_count ?? 0;
}

/** Validate an IANA zone by asking the platform whether it knows it. */
function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new ReminderError(
      "bad_timezone",
      `"${tz}" is not an IANA timezone. Store a place (America/Chicago), never an offset.`,
    );
  }
  // A bare offset parses in some runtimes. It must not: an offset is a
  // property of an instant, not of a place, and one that reaches storage
  // survives exactly one daylight-saving boundary.
  if (!tz.includes("/") && tz !== "UTC") {
    throw new ReminderError(
      "bad_timezone",
      `"${tz}" is not an IANA timezone. Store a place (America/Chicago), never an offset.`,
    );
  }
}

function assertWallTime(wallTime: string): void {
  if (!WALL_TIME.test(wallTime)) {
    throw new ReminderError("bad_wall_time", `"${wallTime}" is not a 24-hour HH:MM wall time.`);
  }
}

export interface ReminderServiceOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class ReminderService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: ReminderServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Create a reminder and materialise its first occurrence.
   *
   * A one-shot takes a `date`; a recurring reminder takes an `rrule` and fires
   * at the next occurrence after now. Supplying neither is a reminder with no
   * time, which is a to-do — a different object, deliberately.
   */
  create(input: CreateReminderInput): Reminder {
    const text = input.text.trim();
    if (text === "") throw new ReminderError("bad_text", "A reminder must say something.");
    if (text.length > MAX_TEXT) {
      throw new ReminderError("bad_text", `A reminder is at most ${MAX_TEXT} characters.`);
    }

    assertWallTime(input.wallTime);
    assertTimezone(input.tz);

    const kind =
      input.kind === undefined
        ? "commitment"
        : KINDS.find((candidate) => candidate === input.kind);
    if (kind === undefined) {
      throw new ReminderError("bad_kind", `kind must be one of ${KINDS.join(", ")}.`);
    }

    const rrule = input.rrule ?? null;
    const date = input.date ?? null;
    if (rrule !== null && date !== null) {
      throw new ReminderError(
        "bad_schedule",
        "Give a date for a one-shot or an rrule for a recurrence, not both.",
      );
    }
    if (rrule === null && date === null) {
      throw new ReminderError(
        "bad_schedule",
        "A reminder needs a date or an rrule. Something with no time is a to-do, not a reminder.",
      );
    }

    const now = this.#clock();
    let fireAt: Date;
    try {
      fireAt =
        rrule === null
          ? occurrenceOnDate(date ?? "", input.wallTime, input.tz)
          : nextOccurrence(parseRrule(rrule), input.wallTime, new Date(now), input.tz);
    } catch (error) {
      if (error instanceof RruleUnsupportedError) {
        throw new ReminderError("rrule_unsupported", error.message);
      }
      throw error;
    }

    const id = newId("reminder");
    const at = instant(now);
    const fire = fireAt.toISOString();

    this.#db
      .prepare(
        `INSERT INTO reminders (${COLUMNS})
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, 'scheduled', ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        kind,
        text,
        input.todoId ?? null,
        input.wallTime,
        input.tz,
        rrule,
        fire,
        fire,
        input.urgent === true ? 1 : 0,
        // A rhythm message supersedes: yesterday's morning agenda has no
        // business arriving today. A commitment never collapses.
        kind === "rhythm" ? 1 : 0,
        at,
        at,
        // `syl-y82`. Required by the verb since it shipped and dropped here
        // until now — on the one verb that wakes him at 3am.
        input.because ?? null,
        input.origin ?? null,
      );

    const created = this.get(id);
    if (created === null) throw new Error("reminder vanished during create");
    return created;
  }

  /** One reminder by id, or `null`. */
  get(id: string): Reminder | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM reminders WHERE id = ?`).get(id);
    return row === undefined ? null : toReminder(row as unknown as ReminderRow);
  }

  /** A page of reminders, newest first. */
  list(filter: ReminderFilter = {}): ReminderPage {
    const { limit, offset } = resolvePage(filter);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filter.state !== undefined) {
      conditions.push("delivery_state = ?");
      bindings.push(filter.state);
    }
    if (filter.dueBefore !== undefined) {
      conditions.push("next_fire_at < ?");
      bindings.push(filter.dueBefore);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM reminders ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit + 1, offset);

    return pageOf(
      rows.map((row) => toReminder(row as unknown as ReminderRow)),
      limit,
      offset,
    );
  }

  /**
   * Everything whose moment has arrived.
   *
   * `deferred` is included: a deferral moves the instant, it does not remove
   * the obligation. That is the whole difference between late and lost.
   */
  due(now: number = this.#clock(), limit = 200): readonly Reminder[] {
    const placeholders = PENDING_STATES.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM reminders
          WHERE delivery_state IN (${placeholders}) AND next_fire_at <= ?
          ORDER BY next_fire_at, id
          LIMIT ?`,
      )
      .all(...PENDING_STATES, instant(now), limit);

    return rows.map((row) => toReminder(row as unknown as ReminderRow));
  }

  /** The next instant anything is due, or `null` if nothing is waiting. */
  nextDueAt(): string | null {
    const placeholders = PENDING_STATES.map(() => "?").join(", ");
    const row = this.#db
      .prepare(
        `SELECT min(next_fire_at) AS next FROM reminders WHERE delivery_state IN (${placeholders})`,
      )
      .get(...PENDING_STATES);
    // Safe assertion: `min` over a TEXT column is TEXT or NULL.
    return (row as unknown as { next: string | null } | undefined)?.next ?? null;
  }

  /** Change what a reminder says or when it says it. */
  update(id: string, patch: UpdateReminderInput): Reminder | null {
    const current = this.get(id);
    if (current === null) return null;

    const text = patch.text === undefined ? current.text : patch.text.trim();
    if (text === "") throw new ReminderError("bad_text", "A reminder must say something.");
    if (text.length > MAX_TEXT) {
      throw new ReminderError("bad_text", `A reminder is at most ${MAX_TEXT} characters.`);
    }

    const wallTime = patch.wallTime ?? current.wallTime;
    const tz = patch.tz ?? current.tz;
    assertWallTime(wallTime);
    assertTimezone(tz);

    const rrule = patch.rrule === undefined ? current.rrule : patch.rrule;
    const urgent = patch.urgent ?? current.urgent;

    // Rescheduling recomputes from the wall time and the zone rather than
    // shifting the stored instant: an instant shifted by a fixed amount is how
    // a recurring reminder drifts an hour at a DST boundary.
    let nextFireAt = current.nextFireAt;
    const rescheduled =
      wallTime !== current.wallTime || tz !== current.tz || rrule !== current.rrule;
    if (rescheduled) {
      try {
        nextFireAt = (
          rrule === null
            ? occurrenceOnDate(
                localDateOf(current.nextFireAt, tz),
                wallTime,
                tz,
              )
            : nextOccurrence(parseRrule(rrule), wallTime, new Date(this.#clock()), tz)
        ).toISOString();
      } catch (error) {
        if (error instanceof RruleUnsupportedError) {
          throw new ReminderError("rrule_unsupported", error.message);
        }
        throw error;
      }
    }

    this.#db
      .prepare(
        `UPDATE reminders
            SET text = ?, wall_time = ?, tz = ?, rrule = ?, urgent = ?, next_fire_at = ?,
                scheduled_for = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        text,
        wallTime,
        tz,
        rrule,
        urgent ? 1 : 0,
        nextFireAt,
        rescheduled ? nextFireAt : current.scheduledFor,
        instant(this.#clock()),
        id,
      );

    return this.get(id);
  }

  /**
   * Defer a reminder to a strictly later instant.
   *
   * The authority is server-side, always. The notification action lives on the
   * device; a phone that is wiped, restored or replaced would take a
   * device-local deferral with it, and a deferral that vanishes is the one
   * outcome the project forbids.
   *
   * @throws {ReminderError} `not_later` if the requested instant is not
   * strictly after the current one. Refusing is the point: silently accepting
   * a deferral that does not move forward is how a reminder disappears.
   */
  snooze(id: string, options: { readonly until?: string; readonly minutes?: number }): Reminder | null {
    const current = this.get(id);
    if (current === null) return null;

    const currentFireAt = parseInstant(current.nextFireAt) ?? this.#clock();
    let target: number;

    if (options.until !== undefined) {
      const parsed = parseInstant(options.until);
      if (parsed === null) {
        throw new ReminderError("bad_schedule", "until must be an RFC 3339 UTC instant.");
      }
      target = parsed;
    } else if (options.minutes !== undefined) {
      if (!Number.isInteger(options.minutes) || options.minutes < 1) {
        throw new ReminderError("bad_schedule", "minutes must be a whole number of at least 1.");
      }
      // Measured from now, not from the original instant: a reminder that is
      // already two hours late and gets "15 minutes" must arrive in fifteen
      // minutes, not an hour and three quarters ago.
      target = Math.max(this.#clock(), currentFireAt) + options.minutes * 60_000;
    } else {
      throw new ReminderError("bad_schedule", "Supply exactly one of until or minutes.");
    }

    if (target <= currentFireAt) {
      throw new ReminderError(
        "not_later",
        "A deferral must move a reminder strictly later. Accepting this one would drop it.",
      );
    }

    this.#db
      .prepare(
        `UPDATE reminders
            SET next_fire_at = ?, deferred_from = ?, delivery_state = 'deferred', updated_at = ?
          WHERE id = ?`,
      )
      .run(instant(target), current.nextFireAt, instant(this.#clock()), id);

    return this.get(id);
  }

  /** Mark a reminder done. */
  complete(id: string): Reminder | null {
    if (this.get(id) === null) return null;
    const at = instant(this.#clock());
    this.#db
      .prepare(
        "UPDATE reminders SET delivery_state = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(at, at, id);
    return this.get(id);
  }

  /** Close a reminder. The row stays; only the state changes. */
  cancel(id: string): Reminder | null {
    if (this.get(id) === null) return null;
    this.#db
      .prepare("UPDATE reminders SET delivery_state = 'cancelled', updated_at = ? WHERE id = ?")
      .run(instant(this.#clock()), id);
    return this.get(id);
  }

  /** Record that the device confirmed a reminder's notification. */
  markAcknowledged(id: string): Reminder | null {
    const current = this.get(id);
    if (current === null) return null;
    // A recurring reminder has already been rolled forward to its next
    // occurrence; acknowledging the one that just fired must not drag it back
    // out of `scheduled`.
    if (current.deliveryState !== "delivered") return current;

    this.#db
      .prepare("UPDATE reminders SET delivery_state = 'acknowledged', updated_at = ? WHERE id = ?")
      .run(instant(this.#clock()), id);
    return this.get(id);
  }

  /**
   * Record that an occurrence was handed to the outbox.
   *
   * A one-shot becomes `delivered` and waits for an acknowledgement. A
   * recurring reminder rolls forward to its next occurrence and goes back to
   * `scheduled` — computed from the wall time and the zone, never by adding 24
   * hours, which is what makes it survive a daylight-saving boundary.
   */
  markFired(id: string, options: { readonly late?: boolean } = {}): Reminder | null {
    const current = this.get(id);
    if (current === null) return null;

    const at = instant(this.#clock());
    if (current.rrule === null) {
      this.#db
        .prepare(
          "UPDATE reminders SET delivery_state = 'delivered', late = ?, updated_at = ? WHERE id = ?",
        )
        .run(options.late === true ? 1 : 0, at, id);
      return this.get(id);
    }

    const nextFireAt = nextOccurrence(
      parseRrule(current.rrule),
      current.wallTime,
      new Date(Math.max(this.#clock(), parseInstant(current.nextFireAt) ?? 0)),
      current.tz,
    ).toISOString();

    this.#db
      .prepare(
        `UPDATE reminders
            SET delivery_state = 'scheduled', late = 0, deferred_from = NULL,
                scheduled_for = ?, next_fire_at = ?, skipped_count = 0, updated_at = ?
          WHERE id = ?`,
      )
      .run(nextFireAt, nextFireAt, at, id);

    return this.get(id);
  }

  /**
   * Roll a rhythm occurrence forward without saying anything.
   *
   * Yesterday's morning agenda has no business arriving today. The skip is
   * *counted* rather than discarded, so the next occurrence can say what it
   * missed — silent suppression is the failure this whole design exists to
   * prevent, and a suppression nobody is told about is silent.
   */
  supersede(id: string): Reminder | null {
    const current = this.get(id);
    if (current === null || current.rrule === null) return null;

    const nextFireAt = nextOccurrence(
      parseRrule(current.rrule),
      current.wallTime,
      new Date(Math.max(this.#clock(), parseInstant(current.nextFireAt) ?? 0)),
      current.tz,
    ).toISOString();

    this.#db
      .prepare(
        `UPDATE reminders
            SET delivery_state = 'scheduled', late = 0, deferred_from = NULL,
                scheduled_for = ?, next_fire_at = ?, skipped_count = skipped_count + 1,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(nextFireAt, nextFireAt, instant(this.#clock()), id);

    return this.get(id);
  }

  /** How many occurrences this reminder has skipped since it last spoke. */
  skippedCount(id: string): number {
    return skippedCountOf(this.#db, id);
  }

  /** The states a reminder may be filtered by. */
  static get states(): readonly ReminderDeliveryState[] {
    return DELIVERY_STATES;
  }
}

/** The local calendar date of a stored instant. */
function localDateOf(at: string, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(at));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}
