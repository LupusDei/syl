import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { GoalError, GoalService } from "../../src/services/goal-service.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

/**
 * `GoalService`, against a real migrated SQLite database.
 *
 * The omissions are the design and they are asserted here as much as the
 * fields are: goals self-nest rather than having a separate objective entity,
 * and there is no percent-complete anywhere — a self-reported percentage is
 * fiction and it decays.
 */

let db: SylDatabase;
let goals: GoalService;

beforeEach(() => {
  db = testDatabase();
  goals = new GoalService({ db: db.handle, clock: fixedClock(TEST_NOW) });
});

afterEach(() => {
  db.close();
});

describe("GoalService.create", () => {
  it("should store a goal when given nothing but a title", () => {
    const created = goals.create({ title: "Get to a working assistant" });

    expect(created.title).toBe("Get to a working assistant");
    expect(created.status).toBe("active");
    expect(created.parentId).toBeNull();
    expect(created.why).toBeNull();
    expect(created.targetDate).toBeNull();
    expect(created.cadenceDays).toBeNull();
    expect(created.metricKey).toBeNull();
    expect(created.targetValue).toBeNull();
    expect(created.statusReason).toBeNull();
    expect(created.id).toMatch(/^syl:goal:/u);
  });

  it("should refuse a goal with no title", () => {
    try {
      goals.create({ title: "   " });
      expect.unreachable("an empty title must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(GoalError);
      expect((error as GoalError).kind).toBe("bad_title");
    }
  });

  it("should refuse a parent that names nothing", () => {
    try {
      goals.create({ title: "Orphan", parentId: "syl:goal:00000000-0000-7000-8000-00000000dead" });
      expect.unreachable("a dangling parent must be refused");
    } catch (error) {
      expect((error as GoalError).kind).toBe("unknown_parent");
    }
  });

  it("should nest a goal under an existing one", () => {
    // Self-nesting is the whole hierarchy: there is deliberately no separate
    // objective or key-result entity.
    const parent = goals.create({ title: "This year" });
    const child = goals.create({ title: "This season", parentId: parent.id });

    expect(child.parentId).toBe(parent.id);
  });

  it("should refuse a target date that is not a date that exists", () => {
    // The pattern alone accepts 2026-02-31, and a target nobody can reach is a
    // goal that is permanently overdue.
    try {
      goals.create({ title: "Impossible", targetDate: "2026-02-31" });
      expect.unreachable("a nonexistent date must be refused");
    } catch (error) {
      expect((error as GoalError).kind).toBe("bad_target_date");
    }
    expect(goals.create({ title: "Fine", targetDate: "2026-02-28" }).targetDate).toBe("2026-02-28");
  });

  it("should refuse a cadence that is not a whole number of at least a day", () => {
    try {
      goals.create({ title: "Weekly-ish", cadenceDays: 0 });
      expect.unreachable("a zero cadence must be refused");
    } catch (error) {
      expect((error as GoalError).kind).toBe("bad_cadence");
    }
    expect(goals.create({ title: "Weekly", cadenceDays: 7 }).cadenceDays).toBe(7);
  });

  it("should accept abandoned as an ordinary status", () => {
    // A first-class, non-shameful outcome rather than a failure state, and
    // `dormant` is a real state rather than a soft delete.
    expect(goals.create({ title: "Learn the cello", status: "abandoned" }).status).toBe("abandoned");
    expect(goals.create({ title: "Learn to sail", status: "dormant" }).status).toBe("dormant");
  });

  it("should refuse a status outside the enum", () => {
    try {
      goals.create({ title: "Nearly", status: "in_progress" });
      expect.unreachable("an unknown status must be refused");
    } catch (error) {
      expect((error as GoalError).kind).toBe("bad_status");
    }
  });
});

describe("GoalService.get", () => {
  it("should return the goal it stored", () => {
    const created = goals.create({ title: "Ship it" });
    expect(goals.get(created.id)).toEqual(created);
  });

  it("should return null for an id that names nothing", () => {
    expect(goals.get("syl:goal:00000000-0000-7000-8000-00000000dead")).toBeNull();
  });

  it("should return null rather than throwing on a string that is not an id", () => {
    expect(goals.get("")).toBeNull();
  });
});

describe("GoalService.list", () => {
  it("should return goals newest first", () => {
    const first = goals.create({ title: "First" });
    const second = goals.create({ title: "Second" });

    expect(goals.list().items.map((goal) => goal.id)).toEqual([second.id, first.id]);
  });

  it("should narrow to a status", () => {
    goals.create({ title: "Live one" });
    const dormant = goals.create({ title: "Parked one", status: "dormant" });

    expect(goals.list({ status: "dormant" }).items.map((goal) => goal.id)).toEqual([dormant.id]);
  });

  it("should page, and hand back a cursor that resumes exactly where it stopped", () => {
    const created = [0, 1, 2, 3, 4].map((index) => goals.create({ title: `Goal ${String(index)}` }));

    const first = goals.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = goals.list({ limit: 2, cursor: first.nextCursor });
    const seen = [...first.items, ...second.items].map((goal) => goal.id);
    expect(new Set(seen).size).toBe(4);
    expect(created.map((goal) => goal.id)).toEqual(expect.arrayContaining(seen));
  });

  it("should refuse a limit outside the contract's range", () => {
    expect(() => goals.list({ limit: 0 })).toThrow(/between 1 and 200/u);
    expect(() => goals.list({ limit: 201 })).toThrow(/between 1 and 200/u);
  });

  it("should answer an empty store with an empty page rather than throwing", () => {
    expect(goals.list()).toEqual({ items: [], nextCursor: null, hasMore: false });
  });
});
