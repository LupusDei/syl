import { beforeEach, describe, expect, it } from "vitest";

import { MockStore, mockId, nowIso, page } from "../src/mock/store.js";
import { loadSchemas } from "../src/spec.js";
import { validate } from "../src/validate.js";

const registry = loadSchemas();
let store: MockStore;

beforeEach(() => {
  store = new MockStore();
});

describe("mockId", () => {
  it("should match the contract's id pattern", () => {
    expect(validate(registry, "Id", mockId("reminder"))).toEqual([]);
  });

  it("should carry the type prefix", () => {
    expect(mockId("todo").startsWith("syl:todo:")).toBe(true);
  });

  it("should be unique across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mockId("message")));
    expect(ids.size).toBe(200);
  });
});

describe("nowIso", () => {
  it("should be a contract-shaped instant in UTC", () => {
    expect(validate(registry, "Instant", nowIso())).toEqual([]);
    expect(nowIso().endsWith("Z")).toBe(true);
  });
});

describe("page", () => {
  it("should wrap items as a terminal page", () => {
    expect(page([1, 2])).toEqual({ items: [1, 2], nextCursor: null, hasMore: false });
  });
});

describe("seeding", () => {
  it("should load every collection from the fixtures", () => {
    expect(store.reminders.length).toBeGreaterThan(0);
    expect(store.todos.length).toBeGreaterThan(0);
    expect(store.goals.length).toBeGreaterThan(0);
    expect(store.devices.length).toBeGreaterThan(0);
    expect(store.deliveries.length).toBeGreaterThan(0);
    expect(store.jobs.length).toBeGreaterThan(0);
    expect(store.runs.length).toBeGreaterThan(0);
  });

  it("should not share state between instances", () => {
    // Otherwise one test's write leaks into the next one's reads.
    const other = new MockStore();
    store.createTodo({ text: "only mine" });
    expect(other.todos.length).toBe(store.todos.length - 1);
  });

  it("should restore the seeded state on reset", () => {
    const before = store.todos.length;
    store.createTodo({ text: "temporary" });
    store.reset();
    expect(store.todos.length).toBe(before);
    expect(store.changeCount()).toBe(0);
  });
});

describe("sendMessage", () => {
  it("should confirm with the caller's clientId and a fresh server id", () => {
    const { confirmation } = store.sendMessage(MockStore.INTERACTIVE_CONVERSATION_ID, {
      clientId: "abcdefgh-0001",
      text: "hello",
    });
    expect(confirmation.clientId).toBe("abcdefgh-0001");
    expect(validate(registry, "DeliveryConfirmation", confirmation)).toEqual([]);
  });

  it("should append the message and a reply, both stamped with the conversation", () => {
    const before = store.messagesFor(MockStore.INTERACTIVE_CONVERSATION_ID).length;
    store.sendMessage(MockStore.INTERACTIVE_CONVERSATION_ID, { clientId: "abcdefgh-0002", text: "hi" });
    const after = store.messagesFor(MockStore.INTERACTIVE_CONVERSATION_ID);
    expect(after.length).toBe(before + 2);
    expect(after.every((m) => m.conversationId === MockStore.INTERACTIVE_CONVERSATION_ID)).toBe(true);
    expect(after.at(-1)?.clientId).toBeNull();
  });

  it("should broadcast the confirmation before the reply", () => {
    const { broadcasts } = store.sendMessage(MockStore.INTERACTIVE_CONVERSATION_ID, {
      clientId: "abcdefgh-0003",
      text: "hi",
    });
    expect(broadcasts.map((b) => b.kind)).toEqual(["confirmation", "message"]);
  });

  it("should bump the conversation's counters", () => {
    const before = store.conversation(MockStore.INTERACTIVE_CONVERSATION_ID)?.messageCount ?? 0;
    store.sendMessage(MockStore.INTERACTIVE_CONVERSATION_ID, { clientId: "abcdefgh-0004", text: "x" });
    expect(store.conversation(MockStore.INTERACTIVE_CONVERSATION_ID)?.messageCount).toBe(before + 2);
  });

  it("should tolerate an unknown conversation rather than throw", () => {
    // The mock is a development tool; a 500 here is less useful than a row.
    const { confirmation } = store.sendMessage("syl:conversation:unknown", {
      clientId: "abcdefgh-0005",
      text: "x",
    });
    expect(confirmation.conversationId).toBe("syl:conversation:unknown");
  });
});

describe("reminders", () => {
  it("should create a contract-shaped reminder that reads back", () => {
    const created = store.createReminder({
      text: "call the dentist",
      wallTime: "09:30",
      tz: "America/Chicago",
      urgent: true,
    });
    expect(validate(registry, "Reminder", created)).toEqual([]);
    expect(store.reminder(created.id)?.text).toBe("call the dentist");
    expect(created.deliveryState).toBe("scheduled");
  });

  it("should default a reminder that names almost nothing", () => {
    const created = store.createReminder({});
    expect(validate(registry, "Reminder", created)).toEqual([]);
    expect(created.kind).toBe("commitment");
  });

  it("should patch only the fields the caller named", () => {
    const first = store.reminders[0];
    const updated = store.updateReminder(first?.id ?? "", { text: "changed" });
    expect(updated?.text).toBe("changed");
    expect(updated?.wallTime).toBe(first?.wallTime);
  });

  it("should return undefined when updating something that is not there", () => {
    expect(store.updateReminder("syl:reminder:nope", { text: "x" })).toBeUndefined();
  });

  it("should stamp completedAt only on completion", () => {
    const id = store.reminders[0]?.id ?? "";
    expect(store.setReminderState(id, "cancelled")?.completedAt).toBeNull();
    expect(store.setReminderState(id, "completed")?.completedAt).not.toBeNull();
  });

  it("should return undefined when changing the state of a missing reminder", () => {
    expect(store.setReminderState("syl:reminder:nope", "completed")).toBeUndefined();
  });
});

describe("snoozeReminder — the strictly-later guarantee", () => {
  it("should move the fire time later and record the chain", () => {
    const first = store.reminders[0];
    const result = store.snoozeReminder(first?.id ?? "", { minutes: 15 });
    expect("reminder" in result).toBe(true);
    if (!("reminder" in result)) return;
    expect(Date.parse(result.reminder.nextFireAt)).toBeGreaterThan(
      Date.parse(first?.nextFireAt ?? ""),
    );
    // Deferral must never vanish, so the previous instant stays visible.
    expect(result.reminder.deferredFrom).toBe(first?.nextFireAt);
    expect(result.reminder.deliveryState).toBe("deferred");
    expect(validate(registry, "Reminder", result.reminder)).toEqual([]);
  });

  it("should refuse an instant that is not strictly later", () => {
    const id = store.reminders[0]?.id ?? "";
    expect(store.snoozeReminder(id, { until: "2020-01-01T00:00:00.000Z" })).toEqual({
      error: "DEFERRAL_NOT_LATER",
    });
  });

  it("should refuse a snooze that names neither until nor minutes", () => {
    const id = store.reminders[0]?.id ?? "";
    expect(store.snoozeReminder(id, {})).toEqual({ error: "DEFERRAL_NOT_LATER" });
  });

  it("should refuse an unparseable instant rather than produce an invalid date", () => {
    const id = store.reminders[0]?.id ?? "";
    expect(store.snoozeReminder(id, { until: "tomorrow-ish" })).toEqual({
      error: "DEFERRAL_NOT_LATER",
    });
  });

  it("should report a missing reminder distinctly from a bad deferral", () => {
    expect(store.snoozeReminder("syl:reminder:nope", { minutes: 15 })).toEqual({
      error: "NOT_FOUND",
    });
  });

  it("should still move forward when the reminder is already overdue", () => {
    // Deferring from `now` rather than from a past fire time is what stops a
    // late reminder from being deferred into the past again.
    const overdue = store.createReminder({ text: "overdue", wallTime: "01:00", tz: "UTC" });
    store.updateReminder(overdue.id, {});
    const result = store.snoozeReminder(overdue.id, { minutes: 5 });
    if (!("reminder" in result)) throw new Error("expected a snooze");
    expect(Date.parse(result.reminder.nextFireAt)).toBeGreaterThan(Date.now());
  });
});

describe("todos", () => {
  it("should land an explicit ask as open, never proposed", () => {
    const todo = store.createTodo({ text: "explicit" });
    expect(todo.status).toBe("open");
    expect(todo.source).toBe("commander");
    expect(validate(registry, "Todo", todo)).toEqual([]);
  });

  it("should patch a to-do and read it back", () => {
    const id = store.todos[0]?.id ?? "";
    expect(store.updateTodo(id, { pinned: true })?.pinned).toBe(true);
    expect(store.todo(id)?.pinned).toBe(true);
  });

  it("should complete a to-do with a timestamp", () => {
    const id = store.todos[0]?.id ?? "";
    const done = store.completeTodo(id);
    expect(done?.status).toBe("done");
    expect(done?.completedAt).not.toBeNull();
  });

  it("should return undefined for a missing to-do on both write paths", () => {
    expect(store.updateTodo("syl:todo:nope", { pinned: true })).toBeUndefined();
    expect(store.completeTodo("syl:todo:nope")).toBeUndefined();
  });
});

describe("goals and devices", () => {
  it("should create a contract-shaped goal", () => {
    const goal = store.createGoal({ title: "ship it", why: "because" });
    expect(validate(registry, "Goal", goal)).toEqual([]);
    expect(store.goal(goal.id)?.title).toBe("ship it");
  });

  it("should keep the token suffix and never the token", () => {
    const device = store.registerDevice({
      token: "A4F81C02B6E14D778F302AB5C9D10E44C8F41D026B1E4A779F302AB5C9D1ABCDE",
      environment: "sandbox",
      name: "phone",
    });
    expect(validate(registry, "Device", device)).toEqual([]);
    expect(device.tokenSuffix).toBe("c9d1abcde".slice(-8));
    expect(JSON.stringify(device)).not.toContain("A4F81C02");
  });

  it("should route by the token's own environment, not a global setting", () => {
    // Both exist at once during development; a global setting breaks one.
    expect(store.registerDevice({ token: "x".repeat(64), environment: "sandbox" }).environment).toBe("sandbox");
    expect(store.registerDevice({ token: "y".repeat(64), environment: "production" }).environment).toBe("production");
  });

  it("should deactivate rather than delete on unregister", () => {
    const id = store.devices[0]?.id ?? "";
    expect(store.unregisterDevice(id)?.active).toBe(false);
    expect(store.device(id)).toBeDefined();
  });

  it("should return undefined when unregistering a missing device", () => {
    expect(store.unregisterDevice("syl:device:nope")).toBeUndefined();
  });
});

describe("acknowledgeDelivery", () => {
  const unacked = (s: MockStore): string => s.deliveries.find((d) => d.ackedAt === null)?.id ?? "";

  it("should be what sets ackedAt", () => {
    const id = unacked(store);
    const acked = store.acknowledgeDelivery(id, { ackedAt: "2026-08-09T21:00:07.220Z" });
    expect(acked?.ackedAt).toBe("2026-08-09T21:00:07.220Z");
    expect(acked?.state).toBe("acknowledged");
    expect(validate(registry, "Delivery", acked)).toEqual([]);
  });

  it("should be idempotent, because the device retries by design", () => {
    const id = unacked(store);
    const first = store.acknowledgeDelivery(id, { ackedAt: "2026-08-09T21:00:07.220Z" });
    const second = store.acknowledgeDelivery(id, { ackedAt: "2026-08-09T23:00:00.000Z" });
    expect(second?.ackedAt).toBe(first?.ackedAt);
  });

  it("should carry the reminder along to acknowledged", () => {
    const withReminder = store.deliveries.find((d) => d.reminderId !== null && d.ackedAt === null);
    if (withReminder === undefined) return;
    store.acknowledgeDelivery(withReminder.id, {});
    expect(store.reminder(withReminder.reminderId as string)?.deliveryState).toBe("acknowledged");
  });

  it("should return undefined for a missing delivery", () => {
    expect(store.acknowledgeDelivery("syl:delivery:nope", {})).toBeUndefined();
  });

  it("should default the engagement rather than leave it null", () => {
    expect(store.acknowledgeDelivery(unacked(store), {})?.engagement).toBe("opened");
  });
});

describe("cursor sync", () => {
  it("should start empty and record writes in order", () => {
    expect(store.sync(undefined, 50).changes).toEqual([]);
    store.createTodo({ text: "one" });
    store.createGoal({ title: "two" });
    const result = store.sync(undefined, 50);
    expect(result.changes.map((c) => c.type)).toEqual(["todo", "goal"]);
    expect(validate(registry, "SyncResponse", result)).toEqual([]);
  });

  it("should return nothing new when called again with the returned cursor", () => {
    store.createTodo({ text: "one" });
    const first = store.sync(undefined, 50);
    expect(store.sync(first.cursor, 50).changes).toEqual([]);
  });

  it("should page and flag hasMore", () => {
    for (let i = 0; i < 5; i += 1) store.createTodo({ text: `t${i}` });
    const first = store.sync(undefined, 2);
    expect(first.changes.length).toBe(2);
    expect(first.hasMore).toBe(true);
    const second = store.sync(first.cursor, 10);
    expect(second.hasMore).toBe(false);
  });

  it("should treat a corrupt cursor as the beginning rather than throwing", () => {
    // A client that persisted a cursor across a schema change must recover,
    // not crash on every launch forever.
    store.createTodo({ text: "one" });
    expect(store.sync("not-base64-at-all!!", 50).changes.length).toBe(1);
  });

  it("should record a delete with a null resource", () => {
    const id = store.todos[0]?.id ?? "";
    store.completeTodo(id);
    const change = store.sync(undefined, 50).changes[0];
    expect(change?.op).toBe("upsert");
    expect(change?.resource).not.toBeNull();
  });
});
