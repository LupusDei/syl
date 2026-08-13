import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncResolvers } from "../../src/index.js";
import { fixedClock } from "../../src/services/clock.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { GoalService } from "../../src/services/goal-service.js";
import { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import { PagingError } from "../../src/services/paging.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { SendingStore } from "../../src/services/sending-store.js";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  SYNC_RESOURCE_TYPES,
  SyncService,
} from "../../src/services/sync-service.js";
import { TodoService } from "../../src/services/todo-service.js";
import { TEST_NOW, testAttachments, testDatabase } from "../helpers/service.js";

/**
 * `GET /sync`'s store half.
 *
 * These tests are the semantics, written down. `syl-c1m` asked for the
 * endpoint's conflict behaviour to be statable before it was implemented, and
 * the statement was: *it accepts no client state, so it cannot conflict; the
 * server is the sole authority; delivery is at-least-once over a monotonic
 * sequence; the resource is read at response time.* Each clause below is a
 * test, because a semantic nobody asserts is a semantic that drifts.
 */

let db: SylDatabase;
let sync: SyncService;
let todos: TodoService;
let goals: GoalService;
let reminders: ReminderService;
let messages: MessageStore;
let devices: DeviceTokenService;
let outbox: Outbox;
let sendings: SendingStore;

const clock = fixedClock(TEST_NOW);

beforeEach(() => {
  db = testDatabase();
  messages = new MessageStore({ db: db.handle, clock });
  reminders = new ReminderService({ db: db.handle, clock });
  todos = new TodoService({ db: db.handle, clock });
  goals = new GoalService({ db: db.handle, clock });
  devices = new DeviceTokenService({ db: db.handle, clock });
  outbox = new Outbox({ db: db.handle, clock });
  sendings = new SendingStore({
    db: db.handle,
    clock,
    attachments: testAttachments(db, clock),
  });
  sync = new SyncService({
    db: db.handle,
    clock,
    resolvers: syncResolvers({ messages, reminders, todos, goals, devices, outbox, sendings }),
  });
});

afterEach(() => {
  db.close();
});

describe("the cursor", () => {
  it("should round-trip a sequence through an opaque token", () => {
    expect(decodeSyncCursor(encodeSyncCursor(42))).toBe(42);
  });

  it("should refuse a token it did not issue", () => {
    // Refusing matters more here than anywhere else in the service: a bad
    // cursor read as "start from the beginning" re-downloads everything on
    // every foreground, and read as "start from now" skips what was missed.
    expect(() => decodeSyncCursor("hello")).toThrow(PagingError);
    expect(() => decodeSyncCursor(Buffer.from('{"seq":-1}').toString("base64url"))).toThrow(
      PagingError,
    );
    expect(() => decodeSyncCursor(Buffer.from('{"offset":3}').toString("base64url"))).toThrow(
      PagingError,
    );
  });

  it("should not be readable as a number by a client that peeks", () => {
    // Opaque is the point. A cursor a client can read is a cursor a client
    // will construct, and then the server can never change how it walks.
    expect(encodeSyncCursor(7)).not.toBe("7");
    expect(Number.isNaN(Number(encodeSyncCursor(7)))).toBe(true);
  });
});

describe("SyncService.changes", () => {
  it("should bootstrap from nothing with the rows that already exist", () => {
    // Migration 0001 seeds the interactive conversation, and 0010 backfills
    // the log — so a device starting from zero is told about the one row it
    // needs before it can send anything at all.
    const response = sync.changes();

    expect(response.changes.map((change) => change.id)).toContain(INTERACTIVE_CONVERSATION_ID);
    expect(response.serverTime).toBe(new Date(TEST_NOW).toISOString());
  });

  it("should report a to-do written after the cursor, and not one written before it", () => {
    const before = sync.changes().cursor;
    const todo = todos.create({ text: "Something new" });

    const after = sync.changes({ since: before });
    expect(after.changes).toHaveLength(1);
    expect(after.changes[0]?.type).toBe("todo");
    expect(after.changes[0]?.op).toBe("upsert");
    expect(after.changes[0]?.id).toBe(todo.id);
    expect(after.changes[0]?.resource).toEqual(todo);
  });

  it("should refuse a cursor it did not issue rather than silently starting over", () => {
    expect(() => sync.changes({ since: "not-a-cursor" })).toThrow(PagingError);
  });

  it("should leave the cursor exactly where it was when nothing changed", () => {
    // A client polling a quiet server must neither lose its place nor skip
    // forward past a row that lands a millisecond later.
    todos.create({ text: "One thing" });
    const caughtUp = sync.changes().cursor;

    const again = sync.changes({ since: caughtUp });
    expect(again.changes).toEqual([]);
    expect(again.hasMore).toBe(false);
    expect(again.cursor).toBe(caughtUp);
  });

  it("should page, and a client that follows hasMore should see everything exactly once", () => {
    const written = [0, 1, 2, 3, 4, 5].map((index) =>
      todos.create({ text: `Item ${String(index)}` }).id,
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const response = sync.changes({ limit: 2, ...(cursor === undefined ? {} : { since: cursor }) });
      pages += 1;
      for (const change of response.changes) {
        if (change.type === "todo") seen.push(change.id);
      }
      cursor = response.cursor;
      if (!response.hasMore) break;
      // A loop with no ceiling is a hang, not a test.
      if (pages > 20) throw new Error("hasMore never went false");
    }

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(written);
  });

  it("should never let hasMore be false while rows remain after the cursor", () => {
    // The one property a client cannot recover from losing: a device that is
    // told it is current when it is not simply stops asking.
    for (let index = 0; index < 5; index += 1) todos.create({ text: `Item ${String(index)}` });

    const page = sync.changes({ limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(decodeSyncCursor(page.cursor)).toBeLessThan(sync.head());
  });

  it("should re-deliver on a replayed cursor, because delivery is at-least-once", () => {
    // Not a defect: every change is an id-keyed upsert, so a duplicate is a
    // no-op on the device. Asserted so nobody later "optimises" it into
    // exactly-once and quietly drops a row instead.
    const before = sync.changes().cursor;
    todos.create({ text: "Written once" });

    const first = sync.changes({ since: before });
    const replay = sync.changes({ since: before });
    expect(replay.changes).toEqual(first.changes);
  });

  it("should carry the resource as it is now, not as it was when it changed", () => {
    // The feed is state-based, not diff-based. A device that pages slowly sees
    // fewer, fresher changes rather than a replay it would only overwrite.
    const before = sync.changes().cursor;
    const todo = todos.create({ text: "First wording" });
    todos.update(todo.id, { text: "Second wording" });

    const changes = sync.changes({ since: before }).changes;
    expect(changes.length).toBeGreaterThan(1);
    for (const change of changes) {
      expect(change.resource?.["text"]).toBe("Second wording");
    }
  });

  it("should spell a row that is gone as a delete with no resource", () => {
    // No synced table hard-deletes today — rows are closed, not removed — so
    // this shape has to be proven with a direct DELETE. It is the difference
    // between a feed that supports removal and one that only claims to.
    const before = sync.changes().cursor;
    const goal = goals.create({ title: "Briefly held" });
    db.handle.prepare("DELETE FROM goals WHERE id = ?").run(goal.id);

    const changes = sync.changes({ since: before }).changes;
    expect(changes.at(-1)?.op).toBe("delete");
    expect(changes.at(-1)?.id).toBe(goal.id);
    expect(changes.at(-1)?.resource).toBeNull();
  });

  it("should narrow to the types it was asked for", () => {
    const before = sync.changes().cursor;
    goals.create({ title: "A goal" });
    const todo = todos.create({ text: "A to-do" });

    const only = sync.changes({ since: before, types: ["todo"] });
    expect(only.changes.map((change) => change.id)).toEqual([todo.id]);
  });

  it("should answer an explicitly empty type list with nothing, and not advance", () => {
    // Answering with everything would be the opposite of what was asked, and
    // advancing the cursor past unseen rows would lose them.
    const before = sync.changes().cursor;
    todos.create({ text: "Unseen" });

    const nothing = sync.changes({ since: before, types: [] });
    expect(nothing.changes).toEqual([]);
    expect(nothing.hasMore).toBe(false);
    expect(nothing.cursor).toBe(before);
  });

  it("should refuse a limit outside the contract's range", () => {
    expect(() => sync.changes({ limit: 0 })).toThrow(PagingError);
    expect(() => sync.changes({ limit: 500 })).toThrow(PagingError);
  });

  it("should be monotonic even when the store's clock walks backwards", () => {
    // The whole reason the cursor is a sequence rather than a timestamp. With
    // an `updated_at` cursor this row lands *before* the cursor the device
    // already holds and is never seen again — silently, because a row missing
    // from a feed is indistinguishable from one never written.
    const before = sync.changes().cursor;
    const backwards = new TodoService({ db: db.handle, clock: fixedClock(TEST_NOW - 86_400_000) });
    const todo = backwards.create({ text: "Written by a clock that stepped back" });

    const after = sync.changes({ since: before });
    expect(after.changes.map((change) => change.id)).toContain(todo.id);
    // Its own stamp really is in the past — the feed found it anyway.
    expect(after.changes.at(-1)?.at).toBe(new Date(TEST_NOW - 86_400_000).toISOString());
  });
});

describe("the resolver map", () => {
  it("should cover every resource type the contract publishes", () => {
    // `SyncResolvers` is a Record over `SyncResourceType`, so a type added to
    // the contract without a source does not compile. This asserts the other
    // half: that the runtime list this service filters by has not drifted from
    // the generated union.
    const resolvers = syncResolvers({ messages, reminders, todos, goals, devices, outbox, sendings });
    expect(Object.keys(resolvers).sort()).toEqual([...SYNC_RESOURCE_TYPES].sort());
  });

  it("should reach each type through the store that owns it", () => {
    // A resolver wired to the wrong store would still return an object, and
    // every envelope check downstream would still pass. This is the only place
    // that catches it.
    const todo = todos.create({ text: "Reachable" });
    const goal = goals.create({ title: "Also reachable" });
    const reminder = reminders.create({
      text: "And this",
      wallTime: "09:00",
      tz: "America/Chicago",
      date: "2099-01-02",
    });

    const resolvers = syncResolvers({ messages, reminders, todos, goals, devices, outbox, sendings });
    expect(resolvers.todo(todo.id)).toEqual(todo);
    expect(resolvers.goal(goal.id)).toEqual(goal);
    expect(resolvers.reminder(reminder.id)).toEqual(reminder);
    expect(resolvers.conversation(INTERACTIVE_CONVERSATION_ID)?.["id"]).toBe(
      INTERACTIVE_CONVERSATION_ID,
    );
  });

  it("should return null for an id no store knows", () => {
    const resolvers = syncResolvers({ messages, reminders, todos, goals, devices, outbox, sendings });
    for (const type of SYNC_RESOURCE_TYPES) {
      expect(resolvers[type](`syl:${type}:00000000-0000-7000-8000-00000000dead`)).toBeNull();
    }
  });
});

describe("SyncService.head", () => {
  it("should report the newest sequence in the log", () => {
    const start = sync.head();
    todos.create({ text: "One" });
    expect(sync.head()).toBe(start + 1);
  });

  it("should agree with the cursor a caught-up client holds", () => {
    todos.create({ text: "One" });
    let cursor = "";
    let response = sync.changes();
    while (response.hasMore) {
      cursor = response.cursor;
      response = sync.changes({ since: cursor });
    }
    expect(decodeSyncCursor(response.cursor)).toBe(sync.head());
  });
});
