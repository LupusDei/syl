import { instant, parseInstant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import type { Database } from "./sqlite.js";

/**
 * The rows behind "come back in five minutes and look at it".
 *
 * A **render watch** is one promise: she started a render, and she is going to
 * come back, look at what came out, and decide whether he should have it. The
 * whole point of the table is that the promise survives the process — see
 * `0026_render_watches.sql` for why it is a row rather than a `setTimeout`, and
 * a table of its own rather than a job row.
 *
 * ## Two invariants live here and nowhere else
 *
 * **A deferral is always to a strictly later instant.** Constraint 4 says a
 * deferral must always return a strictly later instant, and this is the one
 * place in the render path where that can be broken by arithmetic. A watch
 * deferred onto its own instant is due on every tick forever; one deferred
 * into the past is the same, and looks like data rather than a bug. So
 * {@link RenderWatchStore.defer} refuses rather than clamps: a caller that
 * computed a bad instant has a defect, and silently correcting it hides the
 * defect while leaving the wrong interval in place.
 *
 * **A settled watch is settled with a sentence.** `decided` and `gave_up` both
 * carry a note, checked here and by the schema. A give-up with no explanation
 * is exactly the silent drop the constraint forbids, wearing a state code.
 *
 * ## Sending and declining are the same state
 *
 * `decided` covers both, deliberately. Her restraint is a decision and not a
 * missing value; a schema that recorded only the sends could not tell a render
 * she looked at and passed on from one nobody ever looked at, and those are
 * the two things this table exists to distinguish.
 */

/** Where a watch ended up. `waiting` is the only state with a future. */
export type RenderWatchState = "waiting" | "decided" | "gave_up";

/** How a watch may be settled — every terminal state, and no other. */
export type RenderWatchSettlement = Exclude<RenderWatchState, "waiting">;

/** One promise to come back and look. */
export interface RenderWatch {
  readonly id: string;
  /** The render this wake is about, by name. Never `latest`. */
  readonly renderName: string;
  /** Why she made it, carried from the render's own record. */
  readonly because: string;
  readonly state: RenderWatchState;
  /** When to look next. `null` once settled. */
  readonly checkAt: string | null;
  /** How many times this watch has been picked up. The bound on re-checks. */
  readonly attempts: number;
  /** Her line about the decision, or why it was given up on. `null` while waiting. */
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Thrown when a watch cannot be written as asked. */
export class RenderWatchError extends Error {
  readonly kind:
    | "empty_render_name"
    | "empty_because"
    | "empty_note"
    | "unknown_watch"
    | "already_settled"
    | "not_later";

  constructor(kind: RenderWatchError["kind"], message: string) {
    super(message);
    this.name = "RenderWatchError";
    this.kind = kind;
  }
}

/** What starting a watch requires. */
export interface StartWatch {
  /** The render, by name. */
  readonly renderName: string;
  /** Why she made it. Kept so the wake has something to remind her with. */
  readonly because: string;
  /** When to look, as an epoch milliseconds instant. */
  readonly checkAt: number;
}

interface WatchRow {
  readonly id: string;
  readonly render_name: string;
  readonly because: string;
  readonly state: RenderWatchState;
  readonly check_at: string | null;
  readonly attempts: number;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, render_name, because, state, check_at, attempts, note, created_at, updated_at";

function toWatch(row: WatchRow): RenderWatch {
  return {
    id: row.id,
    renderName: row.render_name,
    because: row.because,
    state: row.state,
    checkAt: row.check_at,
    attempts: row.attempts,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RenderWatchStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class RenderWatchStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: RenderWatchStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Promise to come back and look at this render.
   *
   * **Idempotent on the render name.** A render already being watched adopts
   * the watch that exists rather than getting a second one — a retried start,
   * or a recovery pass over the studio, must not end in her being woken twice
   * about one clip. Two wakes are two decisions about one thing, and if she
   * says yes to both he gets two notifications for one video.
   */
  watch(input: StartWatch): RenderWatch {
    const renderName = input.renderName.trim();
    if (renderName === "") {
      throw new RenderWatchError(
        "empty_render_name",
        "A watch is about one particular render, so it needs the name of one.",
      );
    }

    const because = input.because.trim();
    if (because === "") {
      throw new RenderWatchError(
        "empty_because",
        "The wake happens on a thread that remembers nothing, so it carries the reason she made " +
          "it — otherwise she is handed a machine-generated name and asked to have an opinion.",
      );
    }

    const existing = this.byRenderName(renderName);
    if (existing !== null) return existing;

    const at = instant(this.#clock());
    const id = newId("render_watch");

    this.#db
      .prepare(`INSERT INTO render_watches (${COLUMNS}) VALUES (?, ?, ?, 'waiting', ?, 0, NULL, ?, ?)`)
      .run(id, renderName, because, instant(input.checkAt), at, at);

    const created = this.get(id);
    if (created === null) throw new Error("render watch vanished during create");
    return created;
  }

  /**
   * Everything waiting whose instant has arrived, longest-waiting first.
   *
   * Oldest first because the render she has been waiting on longest is the one
   * whose decision is most overdue — and because a job that takes one watch per
   * pass must not be able to starve the first one behind a stream of newer ones.
   *
   * **Unpaged, deliberately.** The set is bounded by how many renders she
   * started in one window, and a page here would leave the row past the limit
   * waiting forever with nothing to notice.
   */
  due(now: number = this.#clock()): readonly RenderWatch[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM render_watches
          WHERE state = 'waiting' AND check_at <= ?
          ORDER BY check_at ASC, id ASC`,
      )
      .all(instant(now));

    return rows.map((row) => toWatch(row as unknown as WatchRow));
  }

  /**
   * The next instant anything is due, or `null`.
   *
   * What the job schedules itself off, the way `reminder_delivery` schedules
   * itself off the next reminder: a poll interval would be either wasteful or
   * late, and this is neither.
   */
  nextDueAt(): string | null {
    const row = this.#db
      .prepare("SELECT min(check_at) AS next FROM render_watches WHERE state = 'waiting'")
      .get();
    // Safe assertion: `min` over a TEXT column is TEXT or NULL.
    return (row as unknown as { next: string | null } | undefined)?.next ?? null;
  }

  /**
   * Look again later, and count that this one happened.
   *
   * @throws {RenderWatchError} if `at` is not strictly later than the instant
   * the watch is already waiting for. Constraint 4: a deferral that does not
   * move forward is a wake that never arrives while looking like one that will.
   */
  defer(id: string, at: number): RenderWatch {
    const row = this.#row(id);
    if (row.state !== "waiting") {
      throw new RenderWatchError(
        "already_settled",
        `The watch on ${row.render_name} is already ${row.state}, so there is nothing left to defer.`,
      );
    }

    const current = parseInstant(row.check_at ?? "") ?? 0;
    if (at <= current) {
      throw new RenderWatchError(
        "not_later",
        `A deferral has to be to a strictly later instant than ${row.check_at ?? "now"}; ` +
          `${instant(at)} is not. A watch deferred onto its own instant is due on every tick ` +
          "forever, which is a dropped promise wearing a busy loop.",
      );
    }

    this.#db
      .prepare(
        `UPDATE render_watches
            SET check_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(instant(at), instant(this.#clock()), id);

    return toWatch(this.#row(id));
  }

  /**
   * This watch is over, and this is what became of it.
   *
   * Refuses a watch that is already settled. A watch that could be re-decided
   * is a watch that could send twice, and the second call is either a duplicate
   * pass or a bug — both of which want to be loud.
   */
  settle(id: string, state: RenderWatchSettlement, note: string): RenderWatch {
    const said = note.trim();
    if (said === "") {
      throw new RenderWatchError(
        "empty_note",
        "A settled watch says what became of it. A give-up with no explanation is the silent " +
          "drop constraint 4 forbids, wearing a state code.",
      );
    }

    const row = this.#row(id);
    if (row.state !== "waiting") {
      throw new RenderWatchError(
        "already_settled",
        `The watch on ${row.render_name} is already ${row.state}.`,
      );
    }

    this.#db
      .prepare(
        `UPDATE render_watches
            SET state = ?, check_at = NULL, note = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(state, said, instant(this.#clock()), id);

    return toWatch(this.#row(id));
  }

  /** One watch by id, or `null`. */
  get(id: string): RenderWatch | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM render_watches WHERE id = ?`).get(id);
    return row === undefined ? null : toWatch(row as unknown as WatchRow);
  }

  /** The watch on a render, whatever became of it, or `null`. */
  byRenderName(renderName: string): RenderWatch | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM render_watches WHERE render_name = ?`)
      .get(renderName.trim());
    return row === undefined ? null : toWatch(row as unknown as WatchRow);
  }

  // ------------------------------------------------------------ internals ---

  #row(id: string): WatchRow {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM render_watches WHERE id = ?`).get(id);
    if (row === undefined) {
      throw new RenderWatchError("unknown_watch", `There is no render watch ${id}.`);
    }
    return row as unknown as WatchRow;
  }
}
