import type { Goal, GoalPage, GoalStatus } from "@syl/shared";

import { instant, systemClock, type Clock } from "./clock.js";
import { isId, newId } from "./id.js";
import { pageOf, resolvePage, type PageOptions } from "./paging.js";
import type { Database } from "./sqlite.js";

/**
 * Goals.
 *
 * The minimal skeleton the contract calls S1 scope, and the omissions are the
 * design:
 *
 * * **Goals self-nest through `parentId`.** There is no separate objective or
 *   key-result entity, because every system that has one ends up asking which
 *   level a given thing belongs to and getting a different answer each time.
 * * **There is no percent-complete field.** Self-reported percentages are
 *   fiction and they decay. Progress is evidenced by what was linked to the
 *   goal — `todos.goal_id` — and computed from that, never asserted.
 * * **`abandoned` is a first-class outcome**, and `dormant` is a real state
 *   rather than a soft delete. Reactivating a dormant goal restores its
 *   history intact, which is only possible because nothing was removed to
 *   express it.
 */

/** A title longer than this is a description, not a title. */
const MAX_TITLE = 500;

/** `why` is prose. It is still not a document. */
const MAX_WHY = 4_000;

const STATUSES: readonly GoalStatus[] = [
  "proposed",
  "active",
  "dormant",
  "achieved",
  "abandoned",
];

/** `YYYY-MM-DD`, and a date that exists. */
const TARGET_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Thrown when a goal cannot be written as asked. */
export class GoalError extends Error {
  readonly kind:
    | "bad_title"
    | "bad_why"
    | "bad_status"
    | "bad_target_date"
    | "bad_cadence"
    // No `cyclic_parent`: a parent must already exist and a new goal's id is
    // freshly minted, so the tree cannot be closed into a loop by any write
    // this service offers. Re-parenting would change that.
    | "unknown_parent";

  constructor(kind: GoalError["kind"], message: string) {
    super(message);
    this.name = "GoalError";
    this.kind = kind;
  }
}

/** What `POST /goals` supplies. */
export interface CreateGoalInput {
  readonly title: string;
  readonly parentId?: string | null;
  readonly why?: string | null;
  readonly targetDate?: string | null;
  readonly cadenceDays?: number | null;
  readonly status?: string;
}

/** What {@link GoalService.list} may narrow by. */
export interface GoalFilter extends PageOptions {
  readonly status?: GoalStatus;
}

interface GoalRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly title: string;
  readonly why: string | null;
  readonly target_date: string | null;
  readonly metric_key: string | null;
  readonly target_value: number | null;
  readonly cadence_days: number | null;
  readonly status: GoalStatus;
  readonly status_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, parent_id, title, why, target_date, metric_key, target_value, cadence_days, " +
  "status, status_reason, created_at, updated_at";

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    why: row.why,
    targetDate: row.target_date,
    metricKey: row.metric_key,
    targetValue: row.target_value,
    cadenceDays: row.cadence_days,
    status: row.status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Validate `YYYY-MM-DD` as a date that exists.
 *
 * The regex alone accepts `2026-02-31`. A target date nobody can reach is a
 * goal that is permanently overdue, and the horizon is derived from this field
 * so a nonsense value propagates.
 */
function normaliseTargetDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const match = TARGET_DATE.exec(value);
  if (match === null) {
    throw new GoalError("bad_target_date", "targetDate must be YYYY-MM-DD, or null.");
  }
  const [, year, month, day] = match;
  const parsed = new Date(`${String(year)}-${String(month)}-${String(day)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    throw new GoalError("bad_target_date", `${value} is not a date that exists.`);
  }
  return value;
}

export interface GoalServiceOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class GoalService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: GoalServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Write a goal.
   *
   * @throws {GoalError} `unknown_parent` when `parentId` names nothing.
   */
  create(input: CreateGoalInput): Goal {
    const title = input.title.trim();
    if (title === "") throw new GoalError("bad_title", "A goal must have a title.");
    if (title.length > MAX_TITLE) {
      throw new GoalError("bad_title", `A goal title is at most ${String(MAX_TITLE)} characters.`);
    }

    const why = input.why === undefined || input.why === null ? null : input.why.trim();
    if (why !== null && why.length > MAX_WHY) {
      throw new GoalError("bad_why", `why is at most ${String(MAX_WHY)} characters.`);
    }

    const status =
      input.status === undefined
        ? "active"
        : STATUSES.find((candidate) => candidate === input.status);
    if (status === undefined) {
      throw new GoalError("bad_status", `status must be one of ${STATUSES.join(", ")}.`);
    }

    const cadenceDays = input.cadenceDays ?? null;
    if (cadenceDays !== null && (!Number.isInteger(cadenceDays) || cadenceDays < 1)) {
      throw new GoalError("bad_cadence", "cadenceDays must be a whole number of at least 1.");
    }

    const parentId = this.#requireParent(input.parentId ?? null);
    const targetDate = normaliseTargetDate(input.targetDate);
    const id = newId("goal");
    const at = instant(this.#clock());

    this.#db
      .prepare(
        `INSERT INTO goals (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`,
      )
      .run(id, parentId, title, why === "" ? null : why, targetDate, cadenceDays, status, at, at);

    const created = this.get(id);
    if (created === null) throw new Error("goal vanished during create");
    return created;
  }

  /** One goal by id, or `null`. */
  get(id: string): Goal | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM goals WHERE id = ?`).get(id);
    return row === undefined ? null : toGoal(row as unknown as GoalRow);
  }

  /**
   * A page of goals, newest first.
   *
   * Not nested: the tree is `parentId`, and a client that wants the shape
   * assembles it. Serving a nested page would make `limit` mean something
   * different at every depth.
   */
  list(filter: GoalFilter = {}): GoalPage {
    const { limit, offset } = resolvePage(filter);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      bindings.push(filter.status);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM goals ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit + 1, offset);

    return pageOf(
      rows.map((row) => toGoal(row as unknown as GoalRow)),
      limit,
      offset,
    );
  }

  /** The statuses a goal may be filtered by. */
  static get statuses(): readonly GoalStatus[] {
    return STATUSES;
  }

  /**
   * Check a parent reference before the database does.
   *
   * @throws {GoalError} `unknown_parent` for an id that is not a goal id or
   * names no row.
   */
  #requireParent(parentId: string | null): string | null {
    if (parentId === null) return null;
    if (!isId(parentId, "goal")) {
      throw new GoalError("unknown_parent", "parentId must be a goal id.");
    }
    const row = this.#db.prepare("SELECT id FROM goals WHERE id = ?").get(parentId);
    if (row === undefined) throw new GoalError("unknown_parent", "There is no such parent goal.");
    return parentId;
  }
}
