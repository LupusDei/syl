import type { ApiError, SyncResponse, Todo } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `GET /sync` over a real socket.
 *
 * The endpoint the iOS `SyncEngine` calls on every foreground reconcile, and
 * which had no server at all until `syl-c1m`. The store's semantics are
 * asserted in `sync-service.test.ts`; what is asserted here is the HTTP shape
 * of them — including the two ways a client can ask for the same thing and the
 * refusals that keep a bad cursor from being silently reinterpreted.
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
  init: RequestInit & { readonly anonymous?: boolean } = {},
): Promise<Response> {
  const { anonymous, ...rest } = init;
  keyCounter += 1;
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      "Idempotency-Key": `key-${String(keyCounter)}`,
      ...(rest.headers ?? {}),
    },
  });
}

async function sync(query = ""): Promise<SyncResponse> {
  const body = (await (await api(`/sync${query}`)).json()) as Envelope<SyncResponse>;
  if (body.data === undefined) throw new Error(`sync failed: ${JSON.stringify(body)}`);
  return body.data;
}

async function createTodo(text: string): Promise<Todo> {
  const body = (await (
    await api("/todos", { method: "POST", body: JSON.stringify({ text }) })
  ).json()) as Envelope<Todo>;
  if (body.data === undefined) throw new Error(`create failed: ${JSON.stringify(body)}`);
  return body.data;
}

describe("GET /api/v1/sync", () => {
  it("should answer a bootstrap with every resource type's changes and a cursor", async () => {
    const first = await sync();

    expect(first.cursor).not.toBe("");
    expect(first.serverTime).toMatch(/Z$/u);
    expect(Array.isArray(first.changes)).toBe(true);
    for (const change of first.changes) {
      expect(["upsert", "delete"]).toContain(change.op);
      expect(change.id).toMatch(/^syl:/u);
    }
  });

  it("should refuse a cursor it did not issue, in the contract's failure envelope", async () => {
    // The refusal that matters most on this endpoint. A cursor silently read
    // as "start over" re-downloads everything on every foreground; read as
    // "start from now" it skips whatever was missed.
    const response = await api("/sync?since=nonsense");
    const body = (await response.json()) as Envelope<SyncResponse>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("since");
  });

  it("should report the write a device made through the ordinary endpoint", async () => {
    // Push, then pull: the write went through `POST /todos` with its
    // idempotency key, and the pull hands back the server's authoritative row.
    // That split is why this endpoint has no conflict to resolve.
    const before = await sync();
    const todo = await createTodo("Written by the phone");

    const after = await sync(`?since=${encodeURIComponent(before.cursor)}`);
    const change = after.changes.find((candidate) => candidate.id === todo.id);
    expect(change?.op).toBe("upsert");
    expect(change?.resource?.["text"]).toBe("Written by the phone");
  });

  it("should let a client that follows hasMore reach the end", async () => {
    for (let index = 0; index < 4; index += 1) await createTodo(`Item ${String(index)}`);

    let cursor: string | undefined;
    let pages = 0;
    let response = await sync("?limit=1");
    while (response.hasMore) {
      cursor = response.cursor;
      response = await sync(`?limit=1&since=${encodeURIComponent(cursor)}`);
      pages += 1;
      if (pages > 40) throw new Error("hasMore never went false");
    }
    expect(pages).toBeGreaterThan(1);
    expect(response.hasMore).toBe(false);
  });

  it("should narrow to the types asked for, in either spelling", async () => {
    const before = await sync();
    await createTodo("Only this");

    const repeated = await sync(`?since=${encodeURIComponent(before.cursor)}&types=todo&types=goal`);
    const commaSeparated = await sync(
      `?since=${encodeURIComponent(before.cursor)}&types=todo,goal`,
    );

    expect(repeated.changes).toEqual(commaSeparated.changes);
    expect(repeated.changes.every((change) => change.type === "todo")).toBe(true);
  });

  it("should refuse a type name outside the enum", async () => {
    const response = await api("/sync?types=unicorn");
    const body = (await response.json()) as Envelope<SyncResponse>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("types");
  });

  it("should refuse a limit that is not a whole number", async () => {
    const body = (await (await api("/sync?limit=half")).json()) as Envelope<SyncResponse>;
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("limit");
  });

  it("should refuse a limit outside the contract's range", async () => {
    const body = (await (await api("/sync?limit=9999")).json()) as Envelope<SyncResponse>;
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("limit");
  });

  it("should refuse an unauthenticated read", async () => {
    const response = await api("/sync", { anonymous: true });
    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope<SyncResponse>).error?.code).toBe("UNAUTHORIZED");
  });

  it("should have no write side, because there is no merge to perform", async () => {
    // Deliberate. The push half is the ordinary write endpoints; giving this
    // endpoint a write side would invent a merge problem the architecture does
    // not have, and an endpoint whose conflict rules cannot be stated is a
    // data-loss bug waiting to be written.
    const response = await api("/sync", { method: "POST", body: JSON.stringify({}) });
    const body = (await response.json()) as Envelope<SyncResponse>;

    expect(response.status).toBe(404);
    expect(body.error?.message).toBe("No route on this service matches that request.");
  });
});
