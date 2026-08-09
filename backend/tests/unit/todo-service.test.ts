import type { Goal } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { GoalService } from "../../src/services/goal-service.js";
import { TodoError, TodoService } from "../../src/services/todo-service.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

/**
 * `TodoService`, against a real migrated SQLite database.
 *
 * A double would not have the CHECK constraints, would not have the foreign
 * key to `goals`, and would not have the agenda index — which are three of the
 * four things worth asserting here. `:memory:` makes the real thing free.
 */

let db: SylDatabase;
let todos: TodoService;
let goals: GoalService;
let goal: Goal;

beforeEach(() => {
  db = testDatabase();
  todos = new TodoService({ db: db.handle, clock: fixedClock(TEST_NOW) });
  goals = new GoalService({ db: db.handle, clock: fixedClock(TEST_NOW) });
  goal = goals.create({ title: "Ship Syl" });
});

afterEach(() => {
  db.close();
});

describe("TodoService.create", () => {
  it("should store a to-do when given nothing but text", () => {
    // The common case, and the one the contract calls out: "a to-do with only
    // text appears in the right places" is a test, not an aspiration.
    const todo = todos.create({ text: "Book the dentist" });

    expect(todo.text).toBe("Book the dentist");
    expect(todo.status).toBe("open");
    expect(todo.source).toBe("commander");
    expect(todo.goalId).toBeNull();
    expect(todo.dueAt).toBeNull();
    expect(todo.pinned).toBe(false);
    expect(todo.delegatedJobId).toBeNull();
    expect(todo.completedAt).toBeNull();
    expect(todo.createdAt).toBe(new Date(TEST_NOW).toISOString());
    expect(todo.id).toMatch(/^syl:todo:/u);
  });

  it("should refuse a to-do that says nothing", () => {
    expect(() => todos.create({ text: "   " })).toThrow(TodoError);
    try {
      todos.create({ text: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(TodoError);
      expect((error as TodoError).kind).toBe("bad_text");
    }
  });

  it("should refuse a goal reference that names nothing", () => {
    // The column has a real foreign key, so the alternative is a SQLite
    // constraint error arriving as a 500 with none of the explanation.
    try {
      todos.create({ text: "Linked to nowhere", goalId: "syl:goal:00000000-0000-7000-8000-00000000dead" });
      expect.unreachable("a dangling goal reference must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(TodoError);
      expect((error as TodoError).kind).toBe("unknown_goal");
    }
  });

  it("should land an inferred to-do as proposed and an explicit one as open", () => {
    // `proposed` is inferred structure, never an explicit ask.
    expect(todos.create({ text: "Maybe call Dad", source: "inferred" }).status).toBe("proposed");
    expect(todos.create({ text: "Call Dad", source: "commander" }).status).toBe("open");
  });

  it("should accept a goal link, a deadline and a pin together", () => {
    const todo = todos.create({
      text: "Draft the proposal",
      goalId: goal.id,
      dueAt: "2026-09-01T12:00:00.000Z",
      pinned: true,
    });

    expect(todo.goalId).toBe(goal.id);
    expect(todo.dueAt).toBe("2026-09-01T12:00:00.000Z");
    expect(todo.pinned).toBe(true);
  });

  it("should refuse a deadline carrying a fixed UTC offset", () => {
    // Constraint 5, at the store boundary. An offset is a property of an
    // instant, not of a place, and one that reaches storage survives exactly
    // one daylight-saving boundary.
    try {
      todos.create({ text: "Wrong shape", dueAt: "2026-09-01T07:00:00-05:00" });
      expect.unreachable("an offset instant must be refused");
    } catch (error) {
      expect((error as TodoError).kind).toBe("bad_due_at");
    }
  });
});

describe("TodoService.get", () => {
  it("should return the to-do it stored", () => {
    const created = todos.create({ text: "Read the migration" });
    expect(todos.get(created.id)).toEqual(created);
  });

  it("should return null for an id that names nothing", () => {
    expect(todos.get("syl:todo:00000000-0000-7000-8000-00000000dead")).toBeNull();
  });

  it("should return null rather than throwing on a string that is not an id", () => {
    expect(todos.get("not-an-id")).toBeNull();
  });
});

describe("TodoService.list", () => {
  it("should return to-dos in agenda order", () => {
    // Pinned first; then the nearest deadline; undated last, because "someday"
    // is not more urgent than "today".
    const undated = todos.create({ text: "Someday" });
    const soon = todos.create({ text: "Tomorrow", dueAt: "2026-08-10T12:00:00.000Z" });
    const later = todos.create({ text: "Next month", dueAt: "2026-09-10T12:00:00.000Z" });
    const pinned = todos.create({ text: "This one matters", pinned: true });

    expect(todos.list().items.map((todo) => todo.id)).toEqual([
      pinned.id,
      soon.id,
      later.id,
      undated.id,
    ]);
  });

  it("should narrow to a status", () => {
    todos.create({ text: "Open one" });
    const done = todos.create({ text: "Finished one" });
    todos.complete(done.id);

    const page = todos.list({ status: "done" });
    expect(page.items.map((todo) => todo.id)).toEqual([done.id]);
    expect(page.hasMore).toBe(false);
  });

  it("should page, and hand back a cursor that resumes exactly where it stopped", () => {
    for (let index = 0; index < 5; index += 1) {
      todos.create({ text: `Item ${String(index)}`, dueAt: `2026-08-1${String(index)}T12:00:00.000Z` });
    }

    const first = todos.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = todos.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(2);
    // No overlap and no gap: the two pages are disjoint and consecutive.
    expect(second.items.map((todo) => todo.id)).not.toContain(first.items[0]?.id);

    const third = todos.list({ limit: 2, cursor: second.nextCursor });
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it("should refuse a cursor it did not issue", () => {
    expect(() => todos.list({ cursor: "not-a-cursor" })).toThrow(
      /not one this service issued/u,
    );
  });

  it("should answer an empty store with an empty page rather than throwing", () => {
    const page = todos.list();
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("TodoService.update", () => {
  it("should change only the fields it was given", () => {
    const created = todos.create({ text: "Original", dueAt: "2026-08-10T12:00:00.000Z" });
    const updated = todos.update(created.id, { text: "Revised" });

    expect(updated?.text).toBe("Revised");
    expect(updated?.dueAt).toBe("2026-08-10T12:00:00.000Z");
    expect(updated?.pinned).toBe(false);
  });

  it("should return null for an id that names nothing", () => {
    expect(todos.update("syl:todo:00000000-0000-7000-8000-00000000dead", { text: "x" })).toBeNull();
  });

  it("should distinguish an absent field from an explicit null", () => {
    // Three answers are needed and only three: leave it alone, clear it, set
    // it. Collapsing absent and null would make a deadline impossible to unset.
    const created = todos.create({ text: "Dated", dueAt: "2026-08-10T12:00:00.000Z" });

    expect(todos.update(created.id, { pinned: true })?.dueAt).toBe("2026-08-10T12:00:00.000Z");
    expect(todos.update(created.id, { dueAt: null })?.dueAt).toBeNull();
  });

  it("should refuse a status outside the enum", () => {
    const created = todos.create({ text: "Fine" });
    try {
      todos.update(created.id, { status: "nearly" });
      expect.unreachable("an unknown status must be refused");
    } catch (error) {
      expect((error as TodoError).kind).toBe("bad_status");
    }
  });

  it("should keep completedAt in step with the status in both directions", () => {
    // A row that is `done` with no completion instant, or `open` with one, is a
    // row two readers will disagree about.
    const created = todos.create({ text: "Toggle me" });
    const done = todos.update(created.id, { status: "done" });
    expect(done?.completedAt).toBe(new Date(TEST_NOW).toISOString());

    const reopened = todos.update(created.id, { status: "open" });
    expect(reopened?.completedAt).toBeNull();
  });
});

describe("TodoService.complete", () => {
  it("should mark a to-do done and stamp when", () => {
    const created = todos.create({ text: "Finish this" });
    const done = todos.complete(created.id);

    expect(done?.status).toBe("done");
    expect(done?.completedAt).toBe(new Date(TEST_NOW).toISOString());
  });

  it("should return null for an id that names nothing", () => {
    expect(todos.complete("syl:todo:00000000-0000-7000-8000-00000000dead")).toBeNull();
  });

  it("should leave an already-completed to-do exactly as it was", () => {
    // The phone's outbox retries this call by design, and a retry that moved
    // `completedAt` forward would rewrite when he actually finished it.
    const created = todos.create({ text: "Finish this" });
    const first = todos.complete(created.id);

    const later = new TodoService({ db: db.handle, clock: fixedClock(TEST_NOW + 3_600_000) });
    expect(later.complete(created.id)).toEqual(first);
  });
});

describe("the reminders.todo_id reference", () => {
  it("should refuse a reminder pointing at a to-do that does not exist", () => {
    // `syl-c1m`: migration 0006 declared this column against a table no
    // migration created. It cannot be given a real FOREIGN KEY without
    // rebuilding a shipped table, so 0009 enforces it with a trigger.
    expect(() =>
      db.handle
        .prepare(
          `INSERT INTO reminders (id, kind, text, todo_id, wall_time, tz, scheduled_for,
                                  next_fire_at, delivery_state, created_at, updated_at)
           VALUES (?, 'commitment', 'Dangling', ?, '09:00', 'America/Chicago', ?, ?, 'scheduled', ?, ?)`,
        )
        .run(
          "syl:reminder:00000000-0000-7000-8000-00000000aaaa",
          "syl:todo:00000000-0000-7000-8000-00000000dead",
          new Date(TEST_NOW).toISOString(),
          new Date(TEST_NOW).toISOString(),
          new Date(TEST_NOW).toISOString(),
          new Date(TEST_NOW).toISOString(),
        ),
    ).toThrow(/must reference an existing todo/u);
  });

  it("should accept a reminder pointing at a to-do that does exist", () => {
    const todo = todos.create({ text: "The thing the reminder is about" });
    expect(() =>
      db.handle
        .prepare(
          `INSERT INTO reminders (id, kind, text, todo_id, wall_time, tz, scheduled_for,
                                  next_fire_at, delivery_state, created_at, updated_at)
           VALUES (?, 'commitment', 'Attached', ?, '09:00', 'America/Chicago', ?, ?, 'scheduled', ?, ?)`,
        )
        .run(
          "syl:reminder:00000000-0000-7000-8000-00000000bbbb",
          todo.id,
          new Date(TEST_NOW).toISOString(),
          new Date(TEST_NOW).toISOString(),
          new Date(TEST_NOW).toISOString(),
          new Date(TEST_NOW).toISOString(),
        ),
    ).not.toThrow();
  });
});
