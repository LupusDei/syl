import type { ApiError, Goal, Todo, TodoPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `/todos` over a real socket.
 *
 * The five operations `shared/openapi.yaml` has published since the contract
 * was written and the service answered none of (`syl-c1m`). Every write is
 * probed twice: once for the answer, once for the refusal — and once more,
 * where it matters, for the retry, because the iOS outbox queues `createTodo`
 * and `completeTodo` as first-class intents and will resend both.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let keyCounter = 0;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(
  path: string,
  init: RequestInit & { readonly anonymous?: boolean; readonly idempotencyKey?: string | null } = {},
): Promise<Response> {
  const { anonymous, idempotencyKey, ...rest } = init;
  keyCounter += 1;
  const key = idempotencyKey === undefined ? `key-${String(keyCounter)}` : idempotencyKey;

  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
      ...(rest.headers ?? {}),
    },
  });
}

async function create(overrides: Record<string, unknown> = {}): Promise<Todo> {
  const response = await api("/todos", {
    method: "POST",
    body: JSON.stringify({ text: "Book the dentist", ...overrides }),
  });
  const body = (await response.json()) as Envelope<Todo>;
  if (body.data === undefined) throw new Error(`create failed: ${JSON.stringify(body)}`);
  return body.data;
}

async function createGoal(): Promise<Goal> {
  const response = await api("/goals", {
    method: "POST",
    body: JSON.stringify({ title: "Ship Syl" }),
  });
  const body = (await response.json()) as Envelope<Goal>;
  if (body.data === undefined) throw new Error(`goal failed: ${JSON.stringify(body)}`);
  return body.data;
}

describe("POST /api/v1/todos", () => {
  it("should answer 201 with the created to-do", async () => {
    const response = await api("/todos", {
      method: "POST",
      body: JSON.stringify({ text: "Book the dentist" }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data?.text).toBe("Book the dentist");
    expect(body.data?.status).toBe("open");
  });

  it("should refuse a body with no text, in the contract's failure envelope", async () => {
    const response = await api("/todos", { method: "POST", body: JSON.stringify({}) });
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("text");
  });

  it("should refuse a goal reference that names nothing", async () => {
    const response = await api("/todos", {
      method: "POST",
      body: JSON.stringify({
        text: "Linked to nowhere",
        goalId: "syl:goal:00000000-0000-7000-8000-00000000dead",
      }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("goalId");
  });

  it("should accept a goal reference that exists", async () => {
    const goal = await createGoal();
    const todo = await create({ goalId: goal.id, pinned: true });

    expect(todo.goalId).toBe(goal.id);
    expect(todo.pinned).toBe(true);
  });

  it("should refuse a write with no Idempotency-Key", async () => {
    // The mobile outbox retries by design and would duplicate without one.
    const response = await api("/todos", {
      method: "POST",
      idempotencyKey: null,
      body: JSON.stringify({ text: "Unkeyed" }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("should replay a repeated create rather than writing a second to-do", async () => {
    const body = JSON.stringify({ text: "Sent twice" });
    const first = await api("/todos", { method: "POST", idempotencyKey: "same", body });
    const second = await api("/todos", { method: "POST", idempotencyKey: "same", body });

    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.status).toBe(first.status);

    const listed = (await (await api("/todos")).json()) as Envelope<TodoPage>;
    expect(listed.data?.items).toHaveLength(1);
  });

  it("should refuse an unauthenticated write", async () => {
    const response = await api("/todos", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ text: "No token" }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /api/v1/todos", () => {
  it("should answer a page in agenda order", async () => {
    const undated = await create({ text: "Someday" });
    const soon = await create({ text: "Tomorrow", dueAt: "2026-08-10T12:00:00.000Z" });
    const pinned = await create({ text: "Matters", pinned: true });

    const body = (await (await api("/todos")).json()) as Envelope<TodoPage>;
    expect(body.data?.items.map((todo) => todo.id)).toEqual([pinned.id, soon.id, undated.id]);
    expect(body.data?.hasMore).toBe(false);
  });

  it("should refuse a status outside the enum, in the contract's failure envelope", async () => {
    const response = await api("/todos?status=nearly");
    const body = (await response.json()) as Envelope<TodoPage>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("status");
  });

  it("should refuse a cursor it did not issue", async () => {
    const response = await api("/todos?cursor=nonsense");
    const body = (await response.json()) as Envelope<TodoPage>;

    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("cursor");
  });

  it("should narrow to a status", async () => {
    await create({ text: "Still open" });
    const done = await create({ text: "Finished" });
    await api(`/todos/${encodeURIComponent(done.id)}/complete`, { method: "POST" });

    const body = (await (await api("/todos?status=done")).json()) as Envelope<TodoPage>;
    expect(body.data?.items.map((todo) => todo.id)).toEqual([done.id]);
  });
});

describe("GET /api/v1/todos/{todoId}", () => {
  it("should answer with the to-do", async () => {
    const created = await create();
    const body = (await (await api(`/todos/${encodeURIComponent(created.id)}`)).json()) as Envelope<Todo>;

    expect(body.success).toBe(true);
    expect(body.data?.id).toBe(created.id);
  });

  it("should answer NOT_FOUND for an id that names nothing", async () => {
    const response = await api("/todos/syl%3Atodo%3A00000000-0000-7000-8000-00000000dead");
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("should answer NOT_FOUND for a path segment that is not an id at all", async () => {
    // A route that exists, refusing in the contract's envelope — not the
    // terminal 404, which would tell a client the endpoint is missing.
    const response = await api("/todos/banana");
    const body = (await response.json()) as Envelope<Todo>;

    expect(body.error?.code).toBe("NOT_FOUND");
    expect(body.error?.message).toBe("That is not a to-do id.");
  });
});

describe("PATCH /api/v1/todos/{todoId}", () => {
  it("should change only the fields it was given", async () => {
    const created = await create({ dueAt: "2026-08-10T12:00:00.000Z" });
    const response = await api(`/todos/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Book the dentist, properly" }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(200);
    expect(body.data?.text).toBe("Book the dentist, properly");
    expect(body.data?.dueAt).toBe("2026-08-10T12:00:00.000Z");
  });

  it("should clear a field asked to be null, and leave an absent one alone", async () => {
    const created = await create({ dueAt: "2026-08-10T12:00:00.000Z", pinned: true });
    const response = await api(`/todos/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ dueAt: null }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(body.data?.dueAt).toBeNull();
    expect(body.data?.pinned).toBe(true);
  });

  it("should refuse an unknown status, in the contract's failure envelope", async () => {
    const created = await create();
    const response = await api(`/todos/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "nearly" }),
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("status");
  });

  it("should answer NOT_FOUND for an id that names nothing", async () => {
    const response = await api("/todos/syl%3Atodo%3A00000000-0000-7000-8000-00000000dead", {
      method: "PATCH",
      body: JSON.stringify({ text: "Nobody home" }),
    });
    expect(((await response.json()) as Envelope<Todo>).error?.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/v1/todos/{todoId}/complete", () => {
  it("should mark the to-do done", async () => {
    const created = await create();
    const response = await api(`/todos/${encodeURIComponent(created.id)}/complete`, {
      method: "POST",
    });
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(200);
    expect(body.data?.status).toBe("done");
    expect(body.data?.completedAt).not.toBeNull();
  });

  it("should answer NOT_FOUND for an id that names nothing", async () => {
    const response = await api(
      "/todos/syl%3Atodo%3A00000000-0000-7000-8000-00000000dead/complete",
      { method: "POST" },
    );
    const body = (await response.json()) as Envelope<Todo>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("should answer the same row when the device sends the completion twice", async () => {
    // The outbox retries this by design. Neither the ledger nor the store may
    // let the second call move `completedAt`.
    const created = await create();
    const path = `/todos/${encodeURIComponent(created.id)}/complete`;
    const first = (await (await api(path, { method: "POST" })).json()) as Envelope<Todo>;
    const second = (await (await api(path, { method: "POST" })).json()) as Envelope<Todo>;

    expect(second.data).toEqual(first.data);
  });
});
