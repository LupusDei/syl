import type {
  ApiError,
  Conversation,
  ConversationPage,
  DeliveryConfirmation,
  MessagePage,
} from "@syl/shared";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
});

afterEach(async () => {
  await running.close();
  db.close();
});

/**
 * Every write carries an `Idempotency-Key`, because the contract requires one
 * and the service now enforces it. A fresh key per call unless the test names
 * one — a test that wants to model a retry has to say so, which is the point.
 */
async function api(
  path: string,
  init: RequestInit & { readonly anonymous?: boolean; readonly idempotencyKey?: string } = {},
): Promise<Response> {
  const { anonymous, idempotencyKey, ...rest } = init;
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      "Idempotency-Key": idempotencyKey ?? randomUUID(),
      ...(rest.headers ?? {}),
    },
  });
}

async function send(text: string, clientId: string, idempotencyKey?: string): Promise<Response> {
  return api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({ clientId, text }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}

describe("GET /api/v1/conversations", () => {
  it("should list the interactive lane the service seeds itself", async () => {
    const body = (await (await api("/conversations")).json()) as Envelope<ConversationPage>;

    expect(body.data?.items.map((c) => c.id)).toEqual([INTERACTIVE_CONVERSATION_ID]);
    expect(body.data?.hasMore).toBe(false);
  });

  it("should filter to a lane", async () => {
    deps.messages.createJobConversation("nightly consolidation");

    const body = (await (
      await api("/conversations?lane=job")
    ).json()) as Envelope<ConversationPage>;

    expect(body.data?.items).toHaveLength(1);
    expect(body.data?.items[0]?.lane).toBe("job");
  });

  it("should refuse a lane the contract does not define", async () => {
    const response = await api("/conversations?lane=gossip");
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details).toMatchObject({ field: "lane" });
  });

  it("should refuse a cursor it did not issue", async () => {
    const response = await api("/conversations?cursor=nonsense");

    expect(response.status).toBe(400);
  });

  it("should need a token", async () => {
    expect((await api("/conversations", { anonymous: true })).status).toBe(401);
  });
});

describe("GET /api/v1/conversations/{id}", () => {
  it("should return the conversation", async () => {
    const body = (await (
      await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}`)
    ).json()) as Envelope<Conversation>;

    expect(body.data?.id).toBe(INTERACTIVE_CONVERSATION_ID);
    expect(body.data?.lane).toBe("interactive");
  });

  it("should 404 a conversation that does not exist", async () => {
    const response = await api(
      "/conversations/syl:conversation:00000000-0000-7000-8000-0000000000ff",
    );

    expect(response.status).toBe(404);
  });

  it("should 404 rather than 500 for something that is not an id at all", async () => {
    // A path segment reaches a query. Checking the shape first is what keeps
    // that from being interesting.
    const response = await api("/conversations/..%2F..%2Fetc%2Fpasswd");
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/v1/conversations/{id}/messages", () => {
  it("should accept a message and answer with a delivery confirmation", async () => {
    const response = await send("Remind me to call the pharmacy at 4 today.", "c-1");
    const body = (await response.json()) as Envelope<DeliveryConfirmation>;

    expect(response.status).toBe(201);
    expect(body.data?.clientId).toBe("c-1");
    expect(body.data?.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
    expect(body.data?.serverId).toMatch(/^syl:message:/);
    expect(body.data?.seq).toBe(1);
  });

  it("should carry the MESSAGE sequence in `seq`, not a frame sequence", async () => {
    // The one place the bare name means the message space: there is no frame
    // stream in an HTTP response for a position to be in.
    await send("one", "c-1");
    const second = (await (await send("two", "c-2")).json()) as Envelope<DeliveryConfirmation>;

    expect(second.data?.seq).toBe(2);
  });

  it("should answer a retried send with the original message, not a second one", async () => {
    // The mobile client keeps a local outbox and retries by design, carrying
    // the key it stored with the queued intent — never a fresh one.
    const first = (await (
      await send("hello", "c-1", "outbox-key-0001")
    ).json()) as Envelope<DeliveryConfirmation>;
    const retry = await send("hello", "c-1", "outbox-key-0001");
    const retryBody = (await retry.json()) as Envelope<DeliveryConfirmation>;

    // `syl-9e0`: this used to answer 200, and 201 is the only success status
    // the contract documents for a send. A client that got 201 the first time
    // and 200 the second has to reconcile two answers to one operation, which
    // is the ambiguity idempotency exists to remove. The replay is announced in
    // a header instead, where it costs the client nothing to ignore.
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
    expect(retryBody.data?.serverId).toBe(first.data?.serverId);
  });

  it("should refuse a key reused for a different message", async () => {
    // `syl-ux1`: this route did not go through the ledger at all, so it could
    // not answer `IDEMPOTENCY_KEY_REUSE` — and `MessageStore` deduping on
    // `clientId` masked it for every case where the client behaved.
    await send("hello", "c-1", "outbox-key-0002");
    const reused = await send("something else entirely", "c-2", "outbox-key-0002");
    const body = (await reused.json()) as Envelope<never>;

    expect(reused.status).toBe(409);
    expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  it("should still recognise a repeated clientId under a key it has never seen", async () => {
    // The two dedupe mechanisms are not redundant. A reinstall loses the
    // outbox and its keys; `clientId` survives in the message the app already
    // rendered. Landing a second copy of his message because the ledger had
    // amnesia would be the visible failure.
    const first = (await (
      await send("hello", "c-1", "outbox-key-0003")
    ).json()) as Envelope<DeliveryConfirmation>;
    const again = await send("hello", "c-1", "a-completely-different-key");
    const againBody = (await again.json()) as Envelope<DeliveryConfirmation>;

    expect(againBody.data?.serverId).toBe(first.data?.serverId);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
  });

  it("should refuse a send with no Idempotency-Key at all", async () => {
    const response = await fetch(
      `${running.baseUrl}/api/v1/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ clientId: "c-1", text: "hello" }),
      },
    );
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("should not set the replayed header on a first send", async () => {
    const response = await send("hello", "c-1");

    expect(response.headers.get("idempotency-replayed")).toBeNull();
  });

  it("should refuse a send with no clientId, since nothing could reconcile it", async () => {
    // Without clientId every retry looks like a fresh send, and the optimistic
    // bubble either duplicates or hangs pending forever.
    const response = await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ field: "clientId" });
  });

  it("should refuse an empty message", async () => {
    const response = await send("   ", "c-1");

    expect(response.status).toBe(400);
  });

  it("should refuse a message into a conversation that does not exist", async () => {
    const response = await api(
      "/conversations/syl:conversation:00000000-0000-7000-8000-0000000000ff/messages",
      { method: "POST", body: JSON.stringify({ clientId: "c-1", text: "orphan" }) },
    );

    expect(response.status).toBe(404);
  });

  it("should need a token", async () => {
    const response = await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`, {
      method: "POST",
      body: JSON.stringify({ clientId: "c-1", text: "hello" }),
      anonymous: true,
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/conversations/{id}/messages", () => {
  it("should return history newest first", async () => {
    await send("one", "c-1");
    await send("two", "c-2");

    const body = (await (
      await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`)
    ).json()) as Envelope<MessagePage>;

    expect(body.data?.items.map((m) => m.text)).toEqual(["two", "one"]);
  });

  it("should stamp every message with its conversation", async () => {
    await send("one", "c-1");

    const body = (await (
      await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`)
    ).json()) as Envelope<MessagePage>;

    expect(body.data?.items.every((m) => m.conversationId === INTERACTIVE_CONVERSATION_ID)).toBe(
      true,
    );
  });

  it("should page with the cursor it hands back", async () => {
    await send("one", "c-1");
    await send("two", "c-2");
    await send("three", "c-3");

    const first = (await (
      await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages?limit=2`)
    ).json()) as Envelope<MessagePage>;
    const second = (await (
      await api(
        `/conversations/${INTERACTIVE_CONVERSATION_ID}/messages?limit=2&cursor=${encodeURIComponent(
          first.data?.nextCursor ?? "",
        )}`,
      )
    ).json()) as Envelope<MessagePage>;

    expect(first.data?.items).toHaveLength(2);
    expect(first.data?.hasMore).toBe(true);
    expect(second.data?.items.map((m) => m.text)).toEqual(["one"]);
    expect(second.data?.hasMore).toBe(false);
  });

  it("should refuse a limit that is not a whole number", async () => {
    const response = await api(
      `/conversations/${INTERACTIVE_CONVERSATION_ID}/messages?limit=lots`,
    );
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ field: "limit" });
  });

  it("should refuse an absurd limit rather than serving the whole thread", async () => {
    const response = await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages?limit=5000`);

    expect(response.status).toBe(400);
  });

  it("should 404 history for a conversation that does not exist", async () => {
    const response = await api(
      "/conversations/syl:conversation:00000000-0000-7000-8000-0000000000ff/messages",
    );

    expect(response.status).toBe(404);
  });

  it("should need a token", async () => {
    const response = await api(`/conversations/${INTERACTIVE_CONVERSATION_ID}/messages`, {
      anonymous: true,
    });

    expect(response.status).toBe(401);
  });
});
