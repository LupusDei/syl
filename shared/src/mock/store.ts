import { fixture } from "../fixtures.js";
import type {
  Conversation,
  Delivery,
  DeliveryConfirmation,
  Device,
  Goal,
  HealthStatus,
  Job,
  Message,
  Principal,
  Reminder,
  Run,
  SyncChange,
  Todo,
} from "../types.js";

/**
 * The mock's in-memory state, seeded from the shared fixtures.
 *
 * Two rules shape everything here.
 *
 * **A write must echo what the caller sent.** The mobile client renders an
 * optimistic bubble keyed by its own `clientId` and swaps it when the server
 * confirms the same `clientId`. A mock that returns the fixture's canned id
 * instead makes reconciliation look broken in the one place it is hardest to
 * debug — so `sendMessage` templates its response from the request.
 *
 * **A write must actually change what a subsequent read returns.** Otherwise
 * the local-first squad cannot test push-outbox → pull-since-cursor →
 * reconcile at all, which is the whole flow they are building.
 */

let counter = 0;

/**
 * A UUIDv7-shaped id: milliseconds first, so ids sort by creation time.
 *
 * Not cryptographically anything — this is a mock. It matters only that the
 * shape matches the contract's pattern and that ordering is stable, because a
 * client sorting by id must behave the same here as in production.
 */
export function mockId(type: string): string {
  const ms = Date.now().toString(16).padStart(12, "0").slice(-12);
  const seq = (counter++ & 0xfff).toString(16).padStart(3, "0");
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `syl:${type}:${ms.slice(0, 8)}-${ms.slice(8)}-7${seq}-8${rand().slice(1)}-${rand()}${rand()}${rand()}`;
}

export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 23)}Z`;
}

/** The `data` half of a success fixture. */
function data<T>(name: string): T {
  return (fixture(name) as { data: T }).data;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** A change the WebSocket should broadcast as a result of a write. */
export type Broadcast =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "confirmation"; readonly confirmation: DeliveryConfirmation };

export class MockStore {
  conversations: Conversation[];
  messages: Message[];
  reminders: Reminder[];
  todos: Todo[];
  goals: Goal[];
  devices: Device[];
  deliveries: Delivery[];
  jobs: Job[];
  runs: Run[];
  readonly principal: Principal;
  private changes: SyncChange[] = [];

  constructor() {
    this.conversations = clone(data<Page<Conversation>>("http/conversations.page").items) as Conversation[];
    this.messages = clone(data<Page<Message>>("http/messages.page").items).slice().reverse() as Message[];
    this.reminders = clone(data<Page<Reminder>>("http/reminders.page").items) as Reminder[];
    this.todos = clone(data<Page<Todo>>("http/todos.page").items) as Todo[];
    this.goals = clone(data<Page<Goal>>("http/goals.page").items) as Goal[];
    this.devices = clone(data<Page<Device>>("http/devices.page").items) as Device[];
    this.deliveries = clone(data<Page<Delivery>>("http/deliveries.page").items) as Delivery[];
    this.jobs = clone(data<Page<Job>>("http/jobs.page").items) as Job[];
    this.runs = clone(data<Page<Run>>("http/runs.page").items) as Run[];
    this.principal = clone(data<Principal>("http/auth.whoami"));
  }

  /** Restore the seeded state. `POST /__mock/reset` calls this. */
  reset(): void {
    const fresh = new MockStore();
    this.conversations = fresh.conversations;
    this.messages = fresh.messages;
    this.reminders = fresh.reminders;
    this.todos = fresh.todos;
    this.goals = fresh.goals;
    this.devices = fresh.devices;
    this.deliveries = fresh.deliveries;
    this.jobs = fresh.jobs;
    this.runs = fresh.runs;
    this.changes = [];
  }

  // ------------------------------------------------------------- health ---

  health(): HealthStatus {
    const seed = data<HealthStatus>("http/health.ok");
    return { ...clone(seed), now: nowIso() };
  }

  // ------------------------------------------------------ conversations ---

  /**
   * The interactive lane's well-known id.
   *
   * A constant on both sides is the entire fix for the bug Adjutant paid for
   * twice: it reconstructed conversation scope from sender and recipient,
   * shipped messages into the wrong thread, and needed a backfill migration
   * with an audit log to repair it.
   */
  static readonly INTERACTIVE_CONVERSATION_ID =
    "syl:conversation:00000000-0000-7000-8000-000000000001";

  conversation(id: string): Conversation | undefined {
    return this.conversations.find((c) => c.id === id);
  }

  messagesFor(conversationId: string): Message[] {
    return this.messages.filter((m) => m.conversationId === conversationId);
  }

  /**
   * Accept a message and confirm it with the caller's own `clientId`.
   *
   * Returns the confirmation plus the frames the socket should broadcast: the
   * confirmation itself, then Syl's reply. Both go out so a client testing the
   * socket path sees the same sequence it will see in production.
   */
  sendMessage(
    conversationId: string,
    body: { clientId: string; text: string },
  ): { confirmation: DeliveryConfirmation; broadcasts: Broadcast[] } {
    const conversation = this.conversation(conversationId);
    const seq = this.messagesFor(conversationId).length + 1;
    const at = nowIso();

    const message: Message = {
      id: mockId("message"),
      conversationId,
      clientId: body.clientId,
      role: "user",
      text: body.text,
      createdAt: at,
      seq,
    };
    this.messages.push(message);
    this.record("message", "upsert", message.id, at, message);

    const reply: Message = {
      id: mockId("message"),
      conversationId,
      clientId: null,
      role: "assistant",
      text: `(mock) I heard: ${body.text}`,
      createdAt: nowIso(),
      seq: seq + 1,
    };
    this.messages.push(reply);
    this.record("message", "upsert", reply.id, reply.createdAt, reply);

    if (conversation !== undefined) {
      const updated: Conversation = {
        ...conversation,
        updatedAt: reply.createdAt,
        lastMessageAt: reply.createdAt,
        messageCount: conversation.messageCount + 2,
      };
      this.conversations = this.conversations.map((c) => (c.id === updated.id ? updated : c));
    }

    const confirmation: DeliveryConfirmation = {
      clientId: body.clientId,
      serverId: message.id,
      conversationId,
      seq,
      acceptedAt: at,
    };

    return {
      confirmation,
      broadcasts: [
        { kind: "confirmation", confirmation },
        { kind: "message", message: reply },
      ],
    };
  }

  // ---------------------------------------------------------- reminders ---

  reminder(id: string): Reminder | undefined {
    return this.reminders.find((r) => r.id === id);
  }

  createReminder(body: Record<string, unknown>): Reminder {
    const at = nowIso();
    const seed = this.reminders[0] as Reminder;
    const reminder: Reminder = {
      ...clone(seed),
      id: mockId("reminder"),
      kind: (body["kind"] as Reminder["kind"]) ?? "commitment",
      text: String(body["text"] ?? "(mock) untitled reminder"),
      todoId: (body["todoId"] as string | null) ?? null,
      eventId: null,
      wallTime: String(body["wallTime"] ?? "09:00"),
      tz: String(body["tz"] ?? "America/Chicago"),
      rrule: (body["rrule"] as string | null) ?? null,
      urgent: body["urgent"] === true,
      late: false,
      deferredFrom: null,
      supersedesPrevious: false,
      deliveryState: "scheduled",
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    };
    this.reminders.unshift(reminder);
    this.record("reminder", "upsert", reminder.id, at, reminder);
    return reminder;
  }

  updateReminder(id: string, patch: Record<string, unknown>): Reminder | undefined {
    const existing = this.reminder(id);
    if (existing === undefined) return undefined;
    const updated: Reminder = { ...existing, updatedAt: nowIso() };
    for (const key of ["text", "wallTime", "tz", "rrule", "urgent"] as const) {
      if (patch[key] !== undefined) {
        (updated as Record<string, unknown>)[key] = patch[key];
      }
    }
    this.replaceReminder(updated);
    return updated;
  }

  setReminderState(id: string, state: Reminder["deliveryState"]): Reminder | undefined {
    const existing = this.reminder(id);
    if (existing === undefined) return undefined;
    const at = nowIso();
    const updated: Reminder = {
      ...existing,
      deliveryState: state,
      updatedAt: at,
      completedAt: state === "completed" ? at : existing.completedAt,
    };
    this.replaceReminder(updated);
    return updated;
  }

  /**
   * Defer a reminder, refusing anything that is not strictly later.
   *
   * The mock enforces this rather than accepting whatever it is told, because
   * "a deferral must always return a strictly later instant" is the constraint
   * the whole reminder system rests on. A client that only ever sees the happy
   * answer never builds the path that handles `DEFERRAL_NOT_LATER`, and it is
   * cheaper to find that here than in the field.
   */
  snoozeReminder(
    id: string,
    body: { until?: string | null; minutes?: number | null },
  ): { reminder: Reminder } | { error: "NOT_FOUND" | "DEFERRAL_NOT_LATER" } {
    const existing = this.reminder(id);
    if (existing === undefined) return { error: "NOT_FOUND" };

    const current = Date.parse(existing.nextFireAt);
    let target: number;
    if (typeof body.minutes === "number" && body.minutes > 0) {
      target = Math.max(Date.now(), current) + body.minutes * 60_000;
    } else if (typeof body.until === "string") {
      target = Date.parse(body.until);
    } else {
      return { error: "DEFERRAL_NOT_LATER" };
    }

    if (!Number.isFinite(target) || target <= current) return { error: "DEFERRAL_NOT_LATER" };

    const at = nowIso();
    const updated: Reminder = {
      ...existing,
      deferredFrom: existing.nextFireAt,
      nextFireAt: `${new Date(target).toISOString().slice(0, 23)}Z`,
      deliveryState: "deferred",
      updatedAt: at,
    };
    this.replaceReminder(updated);
    return { reminder: updated };
  }

  private replaceReminder(updated: Reminder): void {
    this.reminders = this.reminders.map((r) => (r.id === updated.id ? updated : r));
    this.record("reminder", "upsert", updated.id, updated.updatedAt, updated);
  }

  // -------------------------------------------------------------- todos ---

  todo(id: string): Todo | undefined {
    return this.todos.find((t) => t.id === id);
  }

  createTodo(body: Record<string, unknown>): Todo {
    const at = nowIso();
    const todo: Todo = {
      id: mockId("todo"),
      text: String(body["text"] ?? "(mock) untitled"),
      goalId: (body["goalId"] as string | null) ?? null,
      dueAt: (body["dueAt"] as string | null) ?? null,
      pinned: body["pinned"] === true,
      // An explicit ask is never provisional; it lands as `open`.
      status: "open",
      source: "commander",
      delegatedJobId: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    };
    this.todos.unshift(todo);
    this.record("todo", "upsert", todo.id, at, todo);
    return todo;
  }

  updateTodo(id: string, patch: Record<string, unknown>): Todo | undefined {
    const existing = this.todo(id);
    if (existing === undefined) return undefined;
    const updated: Todo = { ...existing, updatedAt: nowIso() };
    for (const key of ["text", "goalId", "dueAt", "pinned", "status"] as const) {
      if (patch[key] !== undefined) (updated as Record<string, unknown>)[key] = patch[key];
    }
    this.todos = this.todos.map((t) => (t.id === id ? updated : t));
    this.record("todo", "upsert", id, updated.updatedAt, updated);
    return updated;
  }

  completeTodo(id: string): Todo | undefined {
    const at = nowIso();
    const existing = this.todo(id);
    if (existing === undefined) return undefined;
    const updated: Todo = { ...existing, status: "done", completedAt: at, updatedAt: at };
    this.todos = this.todos.map((t) => (t.id === id ? updated : t));
    this.record("todo", "upsert", id, at, updated);
    return updated;
  }

  // -------------------------------------------------------------- goals ---

  goal(id: string): Goal | undefined {
    return this.goals.find((g) => g.id === id);
  }

  createGoal(body: Record<string, unknown>): Goal {
    const at = nowIso();
    const goal: Goal = {
      id: mockId("goal"),
      parentId: (body["parentId"] as string | null) ?? null,
      title: String(body["title"] ?? "(mock) untitled goal"),
      why: (body["why"] as string | null) ?? null,
      targetDate: (body["targetDate"] as string | null) ?? null,
      metricKey: null,
      targetValue: null,
      cadenceDays: (body["cadenceDays"] as number | null) ?? null,
      status: "active",
      statusReason: null,
      createdAt: at,
      updatedAt: at,
    };
    this.goals.unshift(goal);
    this.record("goal", "upsert", goal.id, at, goal);
    return goal;
  }

  // ------------------------------------------------------------ devices ---

  device(id: string): Device | undefined {
    return this.devices.find((d) => d.id === id);
  }

  registerDevice(body: Record<string, unknown>): Device {
    const at = nowIso();
    const token = String(body["token"] ?? "");
    const device: Device = {
      id: mockId("device"),
      platform: "ios",
      // Per token, never global: TestFlight builds are production and Xcode
      // builds are sandbox, and both exist at once during development.
      environment: (body["environment"] as Device["environment"]) ?? "production",
      tokenSuffix: (token.slice(-8) || "00000000").toLowerCase(),
      name: String(body["name"] ?? "(mock) device"),
      appVersion: String(body["appVersion"] ?? "0.0.0"),
      osVersion: String(body["osVersion"] ?? "0.0"),
      active: true,
      registeredAt: at,
      lastSeenAt: at,
    };
    this.devices.unshift(device);
    this.record("device", "upsert", device.id, at, device);
    return device;
  }

  unregisterDevice(id: string): Device | undefined {
    const existing = this.device(id);
    if (existing === undefined) return undefined;
    const updated: Device = { ...existing, active: false, lastSeenAt: nowIso() };
    this.devices = this.devices.map((d) => (d.id === id ? updated : d));
    this.record("device", "upsert", id, updated.lastSeenAt, updated);
    return updated;
  }

  // --------------------------------------------------------- deliveries ---

  delivery(id: string): Delivery | undefined {
    return this.deliveries.find((d) => d.id === id);
  }

  /**
   * The client acknowledgement — the only thing that marks a row delivered.
   *
   * Idempotent on purpose: the device retries this call by design, and a
   * second ack returns the existing row rather than erroring. APNs cannot tell
   * us anything, so this call is the entire delivery signal.
   */
  acknowledgeDelivery(
    id: string,
    body: { ackedAt?: string; engagement?: Delivery["engagement"] },
  ): Delivery | undefined {
    const existing = this.delivery(id);
    if (existing === undefined) return undefined;
    if (existing.ackedAt !== null) return existing;
    const updated: Delivery = {
      ...existing,
      state: "acknowledged",
      ackedAt: body.ackedAt ?? nowIso(),
      engagement: body.engagement ?? "opened",
      nextAttemptAt: null,
    };
    this.deliveries = this.deliveries.map((d) => (d.id === id ? updated : d));
    this.record("delivery", "upsert", id, updated.ackedAt as string, updated);

    if (existing.reminderId !== null) {
      this.setReminderState(existing.reminderId, "acknowledged");
    }
    return updated;
  }

  // --------------------------------------------------------------- jobs ---

  job(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  run(id: string): Run | undefined {
    return this.runs.find((r) => r.id === id);
  }

  runsFor(jobId: string): Run[] {
    return this.runs.filter((r) => r.jobId === jobId);
  }

  // --------------------------------------------------------------- sync ---

  private record(
    type: SyncChange["type"],
    op: SyncChange["op"],
    id: string,
    at: string,
    resource: unknown,
  ): void {
    this.changes.push({ type, op, id, at, resource: resource as SyncChange["resource"] });
  }

  /**
   * Cursor sync. The cursor is an opaque base64 offset into the change log.
   *
   * Deliberately paged at a small default so a client that ignores `hasMore`
   * fails here rather than in the field, where the symptom is a device that
   * silently believes it is up to date.
   */
  sync(since: string | undefined, limit: number): {
    cursor: string;
    hasMore: boolean;
    changes: SyncChange[];
    serverTime: string;
  } {
    const offset = decodeCursor(since);
    const slice = this.changes.slice(offset, offset + limit);
    const next = offset + slice.length;
    return {
      cursor: encodeCursor(next),
      hasMore: next < this.changes.length,
      changes: slice,
      serverTime: nowIso(),
    };
  }

  changeCount(): number {
    return this.changes.length;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: number };
    return typeof parsed.o === "number" && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

/** Wrap a list as a single page. The mock does not paginate list endpoints. */
export function page<T>(items: readonly T[]): Page<T> {
  return { items, nextCursor: null, hasMore: false };
}
