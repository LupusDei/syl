import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { API_BASE, specRoutes, WS_PATH } from "../src/mock/router.js";
import {
  MOCK_EXPIRED_PAIRING_CODE,
  MOCK_PAIRING_CODE,
  MOCK_USED_PAIRING_CODE,
  MockServer,
  startMockServer,
} from "../src/mock/server.js";
import { MockStore } from "../src/mock/store.js";
import { loadSchemas, loadSpec } from "../src/spec.js";
import { validate } from "../src/validate.js";

/**
 * The mock is what two squads build against for days with no backend, so it is
 * tested as a real server over a real socket rather than by calling its
 * handlers directly. A mock that only works when driven from inside its own
 * process is not the thing anyone is going to use.
 */

let server: MockServer;
let base: string;
const registry = loadSchemas();
const TOKEN = { Authorization: "Bearer mock-token", "Content-Type": "application/json" };

beforeAll(async () => {
  server = await startMockServer({ port: 0, quiet: true });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await fetch(`${base}/__mock/reset`, { method: "POST" });
});

/** One pairing attempt, with a caller-named key so replays are deliberate. */
async function pair(pairingCode: string, idempotencyKey: string): Promise<Response> {
  return fetch(`${base}${API_BASE}/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ pairingCode, deviceName: "Test" }),
  });
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${API_BASE}${path}`, { headers: TOKEN });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}${API_BASE}${path}`, {
    method: "POST",
    headers: { ...TOKEN, "Idempotency-Key": `key-${Math.random().toString(36).slice(2)}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

// ---------------------------------------------------------------------------

describe("contract coverage", () => {
  it("should have a handler for every operation in the spec", () => {
    // The route table is derived from openapi.yaml, so this is what stops a
    // new endpoint from 404ing at a squad who will assume it is their bug.
    const declared = specRoutes().map((r) => r.operationId).sort();
    const handled = [...server.operationIds()].sort();
    expect(handled).toEqual(declared);
  });

  it("should expose the route table for a human to check", async () => {
    const res = await fetch(`${base}/__mock/routes`);
    const routes = (await res.json()) as { operationId: string; path: string }[];
    expect(routes.length).toBe(specRoutes().length);
    expect(routes.every((r) => r.path.startsWith(API_BASE))).toBe(true);
  });
});

/**
 * Every readable endpoint, validated against the schema the spec declares for
 * its own 200 response. This is the test that makes "serves the contract" a
 * fact rather than a claim.
 */
describe("every response matches the contract", () => {
  const spec = loadSpec();

  /** The `data` schema name the spec declares for an operation's success. */
  function dataSchemaFor(operationId: string): string | undefined {
    for (const operations of Object.values(spec.paths)) {
      for (const operation of Object.values(operations)) {
        const op = operation as {
          operationId?: string;
          responses?: Record<string, unknown>;
        };
        if (op.operationId !== operationId) continue;
        for (const status of ["200", "201"]) {
          const response = op.responses?.[status] as
            | { content?: Record<string, { schema?: { allOf?: { properties?: { data?: { $ref?: string } } }[] } }> }
            | undefined;
          const schema = response?.content?.["application/json"]?.schema;
          const ref = schema?.allOf?.[1]?.properties?.data?.$ref;
          if (ref !== undefined) return ref.split("/").pop();
        }
      }
    }
    return undefined;
  }

  const store = new MockStore();
  const cases: readonly { operationId: string; path: string }[] = [
    { operationId: "getHealth", path: "/health" },
    { operationId: "whoami", path: "/auth/whoami" },
    { operationId: "listConversations", path: "/conversations" },
    { operationId: "getConversation", path: `/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}` },
    { operationId: "listMessages", path: `/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages` },
    { operationId: "listReminders", path: "/reminders" },
    { operationId: "getReminder", path: `/reminders/${store.reminders[0]?.id ?? ""}` },
    { operationId: "listTodos", path: "/todos" },
    { operationId: "getTodo", path: `/todos/${store.todos[0]?.id ?? ""}` },
    { operationId: "listGoals", path: "/goals" },
    { operationId: "getGoal", path: `/goals/${store.goals[0]?.id ?? ""}` },
    { operationId: "listDevices", path: "/devices" },
    { operationId: "listDeliveries", path: "/deliveries" },
    { operationId: "getDelivery", path: `/deliveries/${store.deliveries[0]?.id ?? ""}` },
    { operationId: "listJobs", path: "/jobs" },
    { operationId: "getJob", path: `/jobs/${store.jobs[0]?.id ?? ""}` },
    { operationId: "listJobRuns", path: `/jobs/${store.jobs[0]?.id ?? ""}/runs` },
    { operationId: "getRun", path: `/runs/${store.runs[0]?.id ?? ""}` },
    { operationId: "syncSinceCursor", path: "/sync" },
  ];

  for (const { operationId, path } of cases) {
    it(`should serve ${operationId} as its declared schema`, async () => {
      const schemaName = dataSchemaFor(operationId);
      expect(schemaName).toBeDefined();
      const { status, body } = await get(path);
      expect(status).toBe(200);
      expect(body["success"]).toBe(true);
      expect(validate(registry, schemaName as string, body["data"])).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("should let health through unauthenticated", async () => {
    const res = await fetch(`${base}${API_BASE}/health`);
    expect(res.status).toBe(200);
  });

  it("should reject an unauthenticated read with a typed error", async () => {
    const res = await fetch(`${base}${API_BASE}/reminders`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(validate(registry, "ErrorEnvelope", body)).toEqual([]);
  });

  it("should let pairing through, since that is how a token is obtained", async () => {
    const res = await pair(MOCK_PAIRING_CODE, "pair-key-1");
    expect(res.status).toBe(200);
  });
});

/**
 * `syl-q1f` — the mock has to be able to refuse.
 *
 * It used to hand a token to anything that asked, which made three of the four
 * states a pairing screen must render unreachable: they got written once and
 * never looked at. A mock that only produces the happy path produces clients
 * that only handle the happy path, which is the same argument that made
 * `Scenario` worth building in the first place.
 */
describe("pairing, as a client has to handle it", () => {
  const codeOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { code: string } }).error.code;

  it("should refuse a code it never published, without saying more", async () => {
    const res = await pair("1357-2468", "pair-wrong-1");

    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("UNAUTHORIZED");
  });

  it("should have a code that always answers expired", async () => {
    const res = await pair(MOCK_EXPIRED_PAIRING_CODE, "pair-expired-1");

    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("PAIRING_CODE_EXPIRED");
  });

  it("should have a code that always answers already used", async () => {
    const res = await pair(MOCK_USED_PAIRING_CODE, "pair-used-1");

    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("PAIRING_CODE_ALREADY_USED");
  });

  it("should spend the working code, so the honest path reaches that state too", async () => {
    // A different idempotency key each time: replaying a stored response would
    // hide exactly the behaviour under test.
    expect((await pair(MOCK_PAIRING_CODE, "pair-once-1")).status).toBe(200);
    const second = await pair(MOCK_PAIRING_CODE, "pair-once-2");

    expect(second.status).toBe(401);
    expect(await codeOf(second)).toBe("PAIRING_CODE_ALREADY_USED");
  });

  it("should answer every refusal in the contract's error envelope", async () => {
    const res = await pair("0000-9999", "pair-envelope-1");

    expect(validate(registry, "ErrorEnvelope", await res.json())).toEqual([]);
  });
});

describe("routing errors", () => {
  it("should 404 an unknown path", async () => {
    const { status, body } = await get("/nope");
    expect(status).toBe(404);
    expect(validate(registry, "ErrorEnvelope", body)).toEqual([]);
  });

  it("should 405 a known path with the wrong method", async () => {
    const res = await fetch(`${base}${API_BASE}/health`, { method: "DELETE", headers: TOKEN });
    expect(res.status).toBe(405);
  });

  it("should 404 anything outside the API base", async () => {
    const res = await fetch(`${base}/reminders`, { headers: TOKEN });
    expect(res.status).toBe(404);
  });
});

describe("sending a message", () => {
  it("should confirm with the caller's own clientId, not the fixture's", async () => {
    // This is the single most important behaviour in the mock. A canned
    // clientId makes optimistic reconciliation look broken in the one place
    // it is hardest to debug.
    const clientId = "my-own-client-id-0001";
    const { status, body } = await post(
      `/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`,
      { clientId, text: "Remind me to call the pharmacy at 4." },
    );
    expect(status).toBe(201);
    const data = body["data"] as Record<string, unknown>;
    expect(data["clientId"]).toBe(clientId);
    expect(data["serverId"]).toMatch(/^syl:message:/);
    expect(validate(registry, "DeliveryConfirmation", data)).toEqual([]);
  });

  it("should refuse a send with no clientId rather than invent one", async () => {
    const { status, body } = await post(
      `/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`,
      { text: "no client id" },
    );
    expect(status).toBe(400);
    expect((body["error"] as { code: string }).code).toBe("VALIDATION_FAILED");
  });

  it("should make the message readable afterwards", async () => {
    const before = await get(`/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`);
    const beforeCount = ((before.body["data"] as { items: unknown[] }).items ?? []).length;
    await post(`/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`, {
      clientId: "client-id-abcdef01",
      text: "hello",
    });
    const after = await get(`/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`);
    const items = (after.body["data"] as { items: { text: string }[] }).items;
    // The user's message plus Syl's reply.
    expect(items.length).toBe(beforeCount + 2);
  });

  it("should stamp the conversationId on every message it stores", async () => {
    await post(`/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`, {
      clientId: "client-id-abcdef02",
      text: "hello again",
    });
    const { body } = await get(`/conversations/${MockStore.INTERACTIVE_CONVERSATION_ID}/messages`);
    const items = (body["data"] as { items: { conversationId: string }[] }).items;
    expect(items.every((m) => m.conversationId === MockStore.INTERACTIVE_CONVERSATION_ID)).toBe(true);
  });
});

describe("idempotency", () => {
  const path = "/todos";
  const body = { text: "buy milk" };

  it("should require a key on a write", async () => {
    const res = await fetch(`${base}${API_BASE}${path}`, {
      method: "POST",
      headers: TOKEN,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("should replay the stored response for the same key and body", async () => {
    // The mobile outbox retries by design; without this it duplicates.
    const key = "idem-key-replay-01";
    const first = await post(path, body, { "Idempotency-Key": key });
    const second = await post(path, body, { "Idempotency-Key": key });
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(second.body).toEqual(first.body);

    const listed = await get("/todos");
    const texts = (listed.body["data"] as { items: { text: string }[] }).items.map((t) => t.text);
    expect(texts.filter((t) => t === "buy milk").length).toBe(1);
  });

  it("should conflict on the same key with a different body", async () => {
    const key = "idem-key-conflict-1";
    await post(path, body, { "Idempotency-Key": key });
    const second = await post(path, { text: "something else" }, { "Idempotency-Key": key });
    expect(second.status).toBe(409);
    expect((second.body["error"] as { code: string }).code).toBe("IDEMPOTENCY_KEY_REUSE");
  });
});

describe("the deferral guarantee", () => {
  it("should refuse a snooze that is not strictly later", async () => {
    const { body: list } = await get("/reminders");
    const id = (list["data"] as { items: { id: string }[] }).items[0]?.id ?? "";
    const { status, body } = await post(`/reminders/${id}/snooze`, {
      until: "2020-01-01T00:00:00.000Z",
    });
    expect(status).toBe(409);
    expect((body["error"] as { code: string }).code).toBe("DEFERRAL_NOT_LATER");
  });

  it("should accept a snooze in minutes and move the fire time strictly later", async () => {
    const { body: list } = await get("/reminders");
    const first = (list["data"] as { items: { id: string; nextFireAt: string }[] }).items[0];
    const { status, body } = await post(`/reminders/${first?.id ?? ""}/snooze`, { minutes: 15 });
    expect(status).toBe(200);
    const data = body["data"] as { nextFireAt: string; deferredFrom: string };
    expect(Date.parse(data.nextFireAt)).toBeGreaterThan(Date.parse(first?.nextFireAt ?? ""));
    expect(data.deferredFrom).toBe(first?.nextFireAt);
    expect(validate(registry, "Reminder", data)).toEqual([]);
  });
});

describe("the delivery acknowledgement", () => {
  it("should be the thing that sets ackedAt", async () => {
    const { body: list } = await get("/deliveries?unacknowledged=true");
    const target = (list["data"] as { items: { id: string; ackedAt: string | null }[] }).items[0];
    expect(target?.ackedAt).toBeNull();

    const { status, body } = await post(`/deliveries/${target?.id ?? ""}/ack`, {
      ackedAt: "2026-08-09T21:00:07.220Z",
      engagement: "opened",
    });
    expect(status).toBe(200);
    const data = body["data"] as { ackedAt: string | null; state: string };
    expect(data.ackedAt).toBe("2026-08-09T21:00:07.220Z");
    expect(data.state).toBe("acknowledged");
    expect(validate(registry, "Delivery", data)).toEqual([]);
  });

  it("should be a no-op the second time, because the device retries by design", async () => {
    const { body: list } = await get("/deliveries?unacknowledged=true");
    const id = (list["data"] as { items: { id: string }[] }).items[0]?.id ?? "";
    const first = await post(`/deliveries/${id}/ack`, { ackedAt: "2026-08-09T21:00:07.220Z" });
    const second = await post(`/deliveries/${id}/ack`, { ackedAt: "2026-08-09T22:00:00.000Z" });
    expect(second.status).toBe(200);
    expect((second.body["data"] as { ackedAt: string }).ackedAt).toBe(
      (first.body["data"] as { ackedAt: string }).ackedAt,
    );
  });
});

describe("cursor sync", () => {
  it("should return changes made since the cursor, and nothing on a second call", async () => {
    const first = await get("/sync");
    const cursor = (first.body["data"] as { cursor: string }).cursor;

    await post("/todos", { text: "something new" });

    const second = await get(`/sync?since=${encodeURIComponent(cursor)}`);
    const data = second.body["data"] as { changes: { type: string }[]; cursor: string };
    expect(data.changes.length).toBeGreaterThan(0);
    expect(data.changes.some((c) => c.type === "todo")).toBe(true);

    const third = await get(`/sync?since=${encodeURIComponent(data.cursor)}`);
    expect((third.body["data"] as { changes: unknown[] }).changes.length).toBe(0);
  });

  it("should page and report hasMore", async () => {
    for (let i = 0; i < 5; i += 1) await post("/todos", { text: `todo ${i}` });
    const { body } = await get("/sync?limit=2");
    const data = body["data"] as { hasMore: boolean; changes: unknown[] };
    expect(data.changes.length).toBe(2);
    expect(data.hasMore).toBe(true);
  });
});

describe("scripted failure", () => {
  it("should fail exactly failNext requests and then recover", async () => {
    await fetch(`${base}/__mock/scenario`, {
      method: "POST",
      body: JSON.stringify({ failNext: 2, error: "UPSTREAM_UNAVAILABLE", status: 503 }),
    });
    expect((await get("/reminders")).status).toBe(503);
    expect((await get("/reminders")).status).toBe(503);
    expect((await get("/reminders")).status).toBe(200);
  });

  it("should mark an injected retryable error retryable", async () => {
    await fetch(`${base}/__mock/scenario`, {
      method: "POST",
      body: JSON.stringify({ failNext: 1, error: "RATE_LIMITED", status: 429 }),
    });
    const { status, body } = await get("/reminders");
    expect(status).toBe(429);
    expect(validate(registry, "ErrorEnvelope", body)).toEqual([]);
    expect((body["error"] as { retryable: boolean }).retryable).toBe(true);
  });

  it("should inject a per-request error without touching global state", async () => {
    const res = await fetch(`${base}${API_BASE}/reminders`, {
      headers: { ...TOKEN, "X-Mock-Error": "INTERNAL", "X-Mock-Status": "500" },
    });
    expect(res.status).toBe(500);
    // The next request, with no header, is unaffected.
    expect((await get("/reminders")).status).toBe(200);
  });

  it("should add scripted latency", async () => {
    const started = Date.now();
    await fetch(`${base}${API_BASE}/health`, { headers: { "X-Mock-Latency-Ms": "300" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("should drop the connection entirely when offline, which is not the same as an error", async () => {
    await fetch(`${base}/__mock/scenario`, {
      method: "POST",
      body: JSON.stringify({ offline: true }),
    });
    // A dead tunnel does not answer. Clients take a different path for this
    // than for a server that returned a status, so the mock must produce both.
    await expect(fetch(`${base}${API_BASE}/health`)).rejects.toThrow();
    await fetch(`${base}/__mock/scenario`, { method: "DELETE" });
    expect((await get("/reminders")).status).toBe(200);
  });

  it("should never delay or fault the control plane itself", async () => {
    await fetch(`${base}/__mock/scenario`, {
      method: "POST",
      body: JSON.stringify({ failNext: 99, latencyMs: 5000 }),
    });
    const started = Date.now();
    const res = await fetch(`${base}/__mock/scenario`, { method: "DELETE" });
    // Otherwise a test could not turn a fault off once it was on.
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------

interface Socket {
  readonly ws: WebSocket;
  readonly frames: Record<string, unknown>[];
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
    const frames: Record<string, unknown>[] = [];
    const waiters: { type: string; resolve: (f: Record<string, unknown>) => void }[] = [];

    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      const index = waiters.findIndex((w) => w.type === frame["type"]);
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(frame);
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        frames,
        next(type, timeoutMs = 2000) {
          const existing = frames.find((f) => f["type"] === type);
          if (existing !== undefined) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`no ${type} frame within ${timeoutMs}ms`)), timeoutMs);
            waiters.push({
              type,
              resolve: (f) => {
                clearTimeout(timer);
                res(f);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

async function authed(): Promise<Socket> {
  const socket = await connect();
  await socket.next("auth_challenge");
  socket.ws.send(JSON.stringify({ type: "auth_response", token: "mock-token", lastSeq: 0 }));
  await socket.next("connected");
  return socket;
}

describe("the WebSocket handshake", () => {
  it("should speak first with an auth_challenge", async () => {
    const socket = await connect();
    const challenge = await socket.next("auth_challenge");
    expect(validate(registry, "WsAuthChallenge", challenge)).toEqual([]);
    socket.close();
  });

  it("should answer a valid auth_response with connected", async () => {
    const socket = await connect();
    await socket.next("auth_challenge");
    socket.ws.send(JSON.stringify({ type: "auth_response", token: "mock-token", lastSeq: 0 }));
    const connected = await socket.next("connected");
    expect(validate(registry, "WsConnected", connected)).toEqual([]);
    socket.close();
  });

  it("should send a fatal error and close when the token is missing", async () => {
    const socket = await connect();
    await socket.next("auth_challenge");
    socket.ws.send(JSON.stringify({ type: "auth_response", token: "" }));
    const error = await socket.next("error");
    expect(validate(registry, "WsError", error)).toEqual([]);
    // fatal means stop reconnecting and re-pair, rather than loop.
    expect(error["fatal"]).toBe(true);
  });

  it("should refuse traffic before authentication", async () => {
    const socket = await connect();
    await socket.next("auth_challenge");
    socket.ws.send(JSON.stringify({ type: "sync", sinceSeq: 0 }));
    const error = await socket.next("error");
    expect((error["error"] as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("should answer ping with pong", async () => {
    const socket = await authed();
    socket.ws.send(JSON.stringify({ type: "ping", ts: "2026-08-09T07:00:30.000Z" }));
    const pong = await socket.next("pong");
    expect(validate(registry, "WsPong", pong)).toEqual([]);
    socket.close();
  });
});

describe("WebSocket frames match the contract", () => {
  it("should confirm a socket send with the caller's clientId, and reply", async () => {
    const socket = await authed();
    socket.ws.send(
      JSON.stringify({
        type: "chat_message",
        clientId: "socket-client-id-01",
        conversationId: MockStore.INTERACTIVE_CONVERSATION_ID,
        text: "hello over the socket",
        idempotencyKey: "ws-idem-key-000001",
      }),
    );
    const confirmation = await socket.next("delivery_confirmation");
    expect(validate(registry, "WsDeliveryConfirmation", confirmation)).toEqual([]);
    expect(confirmation["clientId"]).toBe("socket-client-id-01");
    // Both sequences travel, and they are different numbers.
    expect(confirmation["seq"]).not.toBe(confirmation["messageSeq"]);

    const message = await socket.next("chat_message");
    expect(validate(registry, "WsServerChatMessage", message)).toEqual([]);
    socket.close();
  });

  it("should emit presence frames with no seq", async () => {
    const socket = await authed();
    await fetch(`${base}/__mock/presence`, {
      method: "POST",
      body: JSON.stringify({ state: "thinking", intensity: 0.6, ttl_ms: 9000 }),
    });
    const presence = await socket.next("presence");
    expect(validate(registry, "WsPresence", presence)).toEqual([]);
    // Numbering presence would force either a forbidden replay or holes in
    // the sequence space, and holes are how gap detection works.
    expect(presence["seq"]).toBeUndefined();
    expect(presence["ttl_ms"]).toBe(9000);
    socket.close();
  });

  it("should number every replayable frame monotonically", async () => {
    const socket = await authed();
    await fetch(`${base}/__mock/broadcast`, {
      method: "POST",
      body: JSON.stringify({ fixture: "ws/server_chat_message" }),
    });
    const first = await socket.next("chat_message");
    const firstSeq = first["seq"] as number;
    socket.frames.length = 0;
    await fetch(`${base}/__mock/broadcast`, {
      method: "POST",
      body: JSON.stringify({ fixture: "ws/server_chat_message" }),
    });
    const second = await socket.next("chat_message");
    expect(second["seq"]).toBe(firstSeq + 1);
    socket.close();
  });
});

describe("gap recovery", () => {
  it("should replay numbered frames a client missed", async () => {
    const first = await authed();
    await fetch(`${base}/__mock/broadcast`, {
      method: "POST",
      body: JSON.stringify({ fixture: "ws/server_chat_message" }),
    });
    const seen = await first.next("chat_message");
    const lastSeq = seen["seq"] as number;
    first.ws.terminate();

    // ...while the client was away.
    await fetch(`${base}/__mock/broadcast`, {
      method: "POST",
      body: JSON.stringify({ fixture: "ws/server_chat_message" }),
    });

    const reconnected = await authed();
    reconnected.ws.send(JSON.stringify({ type: "sync", sinceSeq: lastSeq }));
    const response = await reconnected.next("sync_response");
    expect(validate(registry, "WsSyncResponse", response)).toEqual([]);
    const frames = response["frames"] as { seq: number }[];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.seq > lastSeq)).toBe(true);
    reconnected.close();
  });

  it("should never put a presence frame in the replay", async () => {
    const socket = await authed();
    await fetch(`${base}/__mock/presence`, {
      method: "POST",
      body: JSON.stringify({ state: "speaking" }),
    });
    await fetch(`${base}/__mock/broadcast`, {
      method: "POST",
      body: JSON.stringify({ fixture: "ws/server_chat_message" }),
    });
    socket.ws.send(JSON.stringify({ type: "sync", sinceSeq: 0 }));
    const response = await socket.next("sync_response");
    const types = (response["frames"] as { type: string }[]).map((f) => f.type);
    // Replaying "thinking" from four minutes ago is a lie.
    expect(types).not.toContain("presence");
    socket.close();
  });

  it("should drop every socket on demand, so reconnect can be exercised", async () => {
    const socket = await authed();
    const closed = new Promise<void>((resolve) => socket.ws.on("close", () => resolve()));
    const res = await fetch(`${base}/__mock/disconnect`, { method: "POST" });
    expect((await res.json() as { disconnected: number }).disconnected).toBeGreaterThan(0);
    await closed;
  });
});

describe("the control plane", () => {
  it("should report the seeded state", async () => {
    const res = await fetch(`${base}/__mock/state`);
    const state = (await res.json()) as Record<string, number>;
    expect(state["reminders"]).toBeGreaterThan(0);
    expect(state["jobs"]).toBeGreaterThan(0);
  });

  it("should reset the store back to the fixtures", async () => {
    await post("/todos", { text: "temporary" });
    const before = (await (await fetch(`${base}/__mock/state`)).json()) as Record<string, number>;
    await fetch(`${base}/__mock/reset`, { method: "POST" });
    const after = (await (await fetch(`${base}/__mock/state`)).json()) as Record<string, number>;
    expect(after["todos"]).toBeLessThan(before["todos"] as number);
  });

  it("should 404 an unknown control endpoint", async () => {
    const res = await fetch(`${base}/__mock/nope`);
    expect(res.status).toBe(404);
  });
});

describe("surviving bad input", () => {
  // Regression: `loadFixture` throws by design, but the handler was invoked as
  // `void this.handleHttp(...)`, so the rejection was unhandled and Node exited.
  // One malformed curl killed the server two squads were building against.
  it("should answer 500 and stay up when a control call names an unknown fixture", async () => {
    const res = await fetch(`${base}/__mock/broadcast`, {
      method: "POST",
      body: JSON.stringify({ fixture: "ws/does-not-exist" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    // The error still lists the alternatives, which is why it throws at all.
    expect(body.error.message).toMatch(/No fixture named/);
    expect((await fetch(`${base}${API_BASE}/health`)).status).toBe(200);
  });

  // Regression: the control plane parsed JSON with no try/catch, so a
  // hand-typed body took the process down the same way.
  it("should answer 400 and stay up on a malformed control body", async () => {
    const res = await fetch(`${base}/__mock/scenario`, { method: "POST", body: "not json at all" });
    expect(res.status).toBe(400);
    expect((await fetch(`${base}${API_BASE}/health`)).status).toBe(200);
  });

  it("should answer 400 and stay up on a malformed API body", async () => {
    const res = await fetch(`${base}${API_BASE}/todos`, {
      method: "POST",
      headers: { ...TOKEN, "Idempotency-Key": "malformed-body-1" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await fetch(`${base}${API_BASE}/health`)).status).toBe(200);
  });

  // Regression: a per-request X-Mock-Error wrote its own failNext back to the
  // server, silently consuming a global "fail the next three" a test was using.
  it("should not let a per-request error consume the global failNext countdown", async () => {
    await fetch(`${base}/__mock/scenario`, {
      method: "POST",
      body: JSON.stringify({ failNext: 2, error: "UPSTREAM_UNAVAILABLE", status: 503 }),
    });
    const withHeader = await fetch(`${base}${API_BASE}/reminders`, {
      headers: { ...TOKEN, "X-Mock-Error": "RATE_LIMITED", "X-Mock-Status": "429" },
    });
    expect(withHeader.status).toBe(429);
    // The global countdown is untouched: still exactly two failures owed.
    expect((await get("/reminders")).status).toBe(503);
    expect((await get("/reminders")).status).toBe(503);
    expect((await get("/reminders")).status).toBe(200);
  });
});
