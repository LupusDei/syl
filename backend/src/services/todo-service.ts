import type { Todo, TodoPage, TodoSource, TodoStatus } from "@syl/shared";

import { instant, parseInstant, systemClock, type Clock } from "./clock.js";
import { isId, newId } from "./id.js";
import { pageOf, resolvePage, type PageOptions } from "./paging.js";
import type { Database } from "./sqlite.js";

/**
 * To-dos.
 *
 * Two design decisions are load-bearing and both come from the contract:
 *
 * 1. **There is no priority ladder.** Priority is a property of a moment, not
 *    of a task, and a stored one is stale the day after it is set. The single
 *    durable bit is `pinned` — "this one matters" genuinely survives — and
 *    everything else about ordering is computed on read. See {@link list}.
 * 2. **`text` is the only required field**, and every read must behave sanely
 *    when the rest are null. A to-do with nothing but text is the common case:
 *    it is what a person types when they are walking out of the door.
 *
 * Rows are closed, never deleted, for the same reason reminders are: a row
 * that disappears takes its history with it, and the history is what proves
 * nothing was quietly dropped. `dropped` is a status, not a `DELETE`.
 */

/** A to-do longer than this is a document, not a to-do. */
const MAX_TEXT = 2_000;

const STATUSES: readonly TodoStatus[] = ["proposed", "open", "done", "dropped"];

const SOURCES: readonly TodoSource[] = ["commander", "inferred", "imported"];

/** Thrown when a to-do cannot be written as asked. */
export class TodoError extends Error {
  readonly kind: "bad_text" | "bad_status" | "bad_source" | "bad_due_at" | "unknown_goal";

  constructor(kind: TodoError["kind"], message: string) {
    super(message);
    this.name = "TodoError";
    this.kind = kind;
  }
}

/** What `POST /todos` supplies. */
export interface CreateTodoInput {
  readonly text: string;
  readonly goalId?: string | null;
  readonly dueAt?: string | null;
  readonly pinned?: boolean;
  /**
   * Where this came from. Defaults to `commander`, because an explicit ask is
   * never provisional — only Syl's own inferences land as `proposed`.
   */
  readonly source?: string;
  readonly status?: string;
}

/** Every field optional; omitted fields are left alone. */
export interface UpdateTodoInput {
  readonly text?: string;
  readonly goalId?: string | null;
  readonly dueAt?: string | null;
  readonly pinned?: boolean;
  readonly status?: string;
}

/** What {@link TodoService.list} may narrow by. */
export interface TodoFilter extends PageOptions {
  readonly status?: TodoStatus;
  readonly goalId?: string;
}

interface TodoRow {
  readonly id: string;
  readonly text: string;
  readonly goal_id: string | null;
  readonly due_at: string | null;
  readonly pinned: number;
  readonly status: TodoStatus;
  readonly source: TodoSource;
  readonly delegated_job_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

const COLUMNS =
  "id, text, goal_id, due_at, pinned, status, source, delegated_job_id, " +
  "created_at, updated_at, completed_at";

/**
 * Agenda order.
 *
 * Stated here in one place because the contract publishes `listTodos` as
 * returning "a page of to-dos, in agenda order", and a documented order that
 * the server does not actually apply is the same species of lie as a
 * documented endpoint the server does not actually serve.
 *
 * Pinned first; then the nearest deadline, with undated to-dos after every
 * dated one (SQLite sorts NULL first by default, which would put "someday" ahead
 * of "today"); then newest. Deterministic to the last tiebreak, because a page
 * boundary that moves between two equal rows drops one of them.
 */
const AGENDA_ORDER =
  "ORDER BY pinned DESC, due_at IS NULL, due_at ASC, created_at DESC, id DESC";

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    text: row.text,
    goalId: row.goal_id,
    dueAt: row.due_at,
    pinned: row.pinned === 1,
    status: row.status,
    source: row.source,
    delegatedJobId: row.delegated_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** Validate an optional deadline, normalising it to the stored spelling. */
function normaliseDueAt(dueAt: string | null | undefined): string | null {
  if (dueAt === undefined || dueAt === null) return null;
  const parsed = parseInstant(dueAt);
  if (parsed === null) {
    throw new TodoError("bad_due_at", "dueAt must be an RFC 3339 UTC instant, or null.");
  }
  return instant(parsed);
}

export interface TodoServiceOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class TodoService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: TodoServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Write a to-do.
   *
   * @throws {TodoError} `unknown_goal` when `goalId` names nothing. The column
   * has a real foreign key, so the alternative is a SQLite constraint error
   * surfacing as a 500 — the same refusal, with none of the explanation.
   */
  create(input: CreateTodoInput): Todo {
    const text = input.text.trim();
    if (text === "") throw new TodoError("bad_text", "A to-do must say something.");
    if (text.length > MAX_TEXT) {
      throw new TodoError("bad_text", `A to-do is at most ${String(MAX_TEXT)} characters.`);
    }

    const source =
      input.source === undefined
        ? "commander"
        : SOURCES.find((candidate) => candidate === input.source);
    if (source === undefined) {
      throw new TodoError("bad_source", `source must be one of ${SOURCES.join(", ")}.`);
    }

    // An explicit ask is never provisional. `proposed` is reserved for
    // structure Syl inferred, so the default follows the source rather than
    // being a constant.
    const fallback: TodoStatus = source === "inferred" ? "proposed" : "open";
    const status =
      input.status === undefined
        ? fallback
        : STATUSES.find((candidate) => candidate === input.status);
    if (status === undefined) {
      throw new TodoError("bad_status", `status must be one of ${STATUSES.join(", ")}.`);
    }

    const goalId = this.#requireGoal(input.goalId ?? null);
    const dueAt = normaliseDueAt(input.dueAt);
    const id = newId("todo");
    const at = instant(this.#clock());

    this.#db
      .prepare(
        `INSERT INTO todos (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        text,
        goalId,
        dueAt,
        input.pinned === true ? 1 : 0,
        status,
        source,
        at,
        at,
        status === "done" ? at : null,
      );

    const created = this.get(id);
    if (created === null) throw new Error("todo vanished during create");
    return created;
  }

  /** One to-do by id, or `null`. */
  get(id: string): Todo | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM todos WHERE id = ?`).get(id);
    return row === undefined ? null : toTodo(row as unknown as TodoRow);
  }

  /** A page of to-dos, in agenda order. See {@link AGENDA_ORDER}. */
  list(filter: TodoFilter = {}): TodoPage {
    const { limit, offset } = resolvePage(filter);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      bindings.push(filter.status);
    }
    if (filter.goalId !== undefined) {
      conditions.push("goal_id = ?");
      bindings.push(filter.goalId);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM todos ${where} ${AGENDA_ORDER} LIMIT ? OFFSET ?`)
      .all(...bindings, limit + 1, offset);

    return pageOf(
      rows.map((row) => toTodo(row as unknown as TodoRow)),
      limit,
      offset,
    );
  }

  /**
   * Change a to-do. Omitted fields are left alone; an explicit `null` clears.
   *
   * @returns the updated to-do, or `null` if there is no such id.
   */
  update(id: string, patch: UpdateTodoInput): Todo | null {
    const current = this.get(id);
    if (current === null) return null;

    const text = patch.text === undefined ? current.text : patch.text.trim();
    if (text === "") throw new TodoError("bad_text", "A to-do must say something.");
    if (text.length > MAX_TEXT) {
      throw new TodoError("bad_text", `A to-do is at most ${String(MAX_TEXT)} characters.`);
    }

    const status =
      patch.status === undefined
        ? current.status
        : STATUSES.find((candidate) => candidate === patch.status);
    if (status === undefined) {
      throw new TodoError("bad_status", `status must be one of ${STATUSES.join(", ")}.`);
    }

    const goalId =
      patch.goalId === undefined ? current.goalId : this.#requireGoal(patch.goalId);
    const dueAt = patch.dueAt === undefined ? current.dueAt : normaliseDueAt(patch.dueAt);
    const pinned = patch.pinned ?? current.pinned;
    const at = instant(this.#clock());

    // `completed_at` follows the status rather than being set independently:
    // a row that is `done` with no completion instant, or `open` with one, is a
    // row two different readers will disagree about.
    const completedAt =
      status === "done" ? (current.completedAt ?? at) : status === current.status ? current.completedAt : null;

    this.#db
      .prepare(
        `UPDATE todos
            SET text = ?, goal_id = ?, due_at = ?, pinned = ?, status = ?,
                updated_at = ?, completed_at = ?
          WHERE id = ?`,
      )
      .run(text, goalId, dueAt, pinned ? 1 : 0, status, at, completedAt, id);

    return this.get(id);
  }

  /**
   * Mark a to-do done.
   *
   * Completing an already-completed to-do returns the existing row unchanged.
   * The phone's outbox retries this call by design, and a retry that moved
   * `completedAt` forward would rewrite when he actually finished it.
   */
  complete(id: string): Todo | null {
    const current = this.get(id);
    if (current === null) return null;
    if (current.status === "done") return current;

    const at = instant(this.#clock());
    this.#db
      .prepare("UPDATE todos SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, id);
    return this.get(id);
  }

  /** The statuses a to-do may be filtered by. */
  static get statuses(): readonly TodoStatus[] {
    return STATUSES;
  }

  /**
   * Check a goal reference before the database does.
   *
   * @throws {TodoError} `unknown_goal` for an id that is not a goal id or names
   * no row.
   */
  #requireGoal(goalId: string | null): string | null {
    if (goalId === null) return null;
    if (!isId(goalId, "goal")) {
      throw new TodoError("unknown_goal", "goalId must be a goal id.");
    }
    const row = this.#db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId);
    if (row === undefined) throw new TodoError("unknown_goal", "There is no such goal.");
    return goalId;
  }
}
