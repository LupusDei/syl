import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  WsAuthChallenge,
  WsDeliveryConfirmation,
  WsError,
  WsPong,
  WsPresence,
  WsServerChatMessage,
  WsSyncResponse,
} from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiKeyService } from "../../src/services/api-key-service.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import type { MessageStore } from "../../src/services/message-store.js";
import {
  PROTOCOL_VERSION,
  SylSocketServer,
  WS_PATH,
  type WsConnectedFrame,
} from "../../src/services/ws-server.js";
import { testDatabase, testDeps } from "../helpers/service.js";
import { TestClient } from "../helpers/ws.js";

let db: SylDatabase;
let keys: ApiKeyService;
let messages: MessageStore;
let http: Server;
let sockets: SylSocketServer;
let url: string;
let token: string;
const clients: TestClient[] = [];

async function start(options: { capacity?: number; authTimeoutMs?: number } = {}): Promise<void> {
  db = testDatabase();
  const deps = testDeps(db);
  keys = deps.keys;
  messages = deps.messages;

  http = createServer();
  sockets = new SylSocketServer({
    server: http,
    keys,
    chat: deps.chat,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const address = http.address() as AddressInfo;
  url = `ws://127.0.0.1:${address.port}${WS_PATH}`;
  token = keys.pair(keys.issuePairingCode().code, "Commander's iPhone").token;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await sockets.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  db.close();
});

/** Connect and take the challenge off the queue. */
async function connect(): Promise<{ client: TestClient; challenge: WsAuthChallenge }> {
  const client = await TestClient.connect(url);
  clients.push(client);
  const challenge = (await client.next()) as WsAuthChallenge;
  return { client, challenge };
}

/** Connect, authenticate, and return the client plus the `connected` frame. */
async function join(
  lastSeq?: number,
): Promise<{ client: TestClient; connected: WsConnectedFrame }> {
  const { client, challenge } = await connect();
  client.send({
    type: "auth_response",
    token,
    nonce: challenge.nonce,
    ...(lastSeq === undefined ? {} : { lastSeq }),
  });
  const connected = (await client.next()) as WsConnectedFrame;
  return { client, connected };
}

describe("the handshake", () => {
  it("should speak first, with a nonce and the protocol version", async () => {
    // A client that sends auth_response unprompted is answering a challenge it
    // has not seen.
    const { challenge } = await connect();

    expect(challenge.type).toBe("auth_challenge");
    expect(challenge.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(challenge.nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  it("should give each connection its own nonce", async () => {
    const first = await connect();
    const second = await connect();

    expect(first.challenge.nonce).not.toBe(second.challenge.nonce);
  });

  it("should answer a good token with connected, naming the principal", async () => {
    const { connected } = await join();

    expect(connected.type).toBe("connected");
    expect(connected.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(connected.principal.name).toBe("The Commander");
    expect(connected.lastSeq).toBe(0);
  });

  it("should name the run its sequence belongs to", async () => {
    // `syl-47j`. `lastSeq` is held in memory and starts again at zero on every
    // restart, so the number on its own is not enough for a client to tell
    // "nothing new" from "everything you hold is from a server that no longer
    // exists". The run has to be named, and this is the only place to name it:
    // the client's mark is already stale by the time any other frame arrives.
    const { connected } = await join();

    expect(connected.serverEpoch).toEqual(expect.any(String));
    expect(connected.serverEpoch).not.toBe("");
    // The accessor and the wire are the same fact. A caller that logged one while
    // clients keyed on the other would make a restart untraceable in exactly the
    // incident where the log is the only evidence.
    expect(connected.serverEpoch).toBe(sockets.serverEpoch);
  });

  it("should give every connection to one run the same epoch", async () => {
    // Nothing restarted between these two, so a client that reset its mark on
    // the strength of a changed epoch would replay the whole buffer on every
    // ordinary reconnect.
    const first = await join();
    const second = await join();

    expect(second.connected.serverEpoch).toBe(first.connected.serverEpoch);
  });

  it("should mint a different epoch for a different run", async () => {
    // The point of the field. Two servers over the same store are two frame
    // streams, and the sequences in them are unrelated.
    const before = (await join()).connected.serverEpoch;

    for (const client of clients.splice(0)) client.close();
    await sockets.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    db.close();
    await start();

    expect((await join()).connected.serverEpoch).not.toBe(before);
  });

  it("should take the token in a frame, never from the URL", async () => {
    // A query string reaches proxy logs, and a bearer token in a log file is a
    // bearer token that has leaked.
    const client = await TestClient.connect(`${url}?token=${token}`);
    clients.push(client);
    await client.next(); // the challenge

    client.send({ type: "sync", sinceSeq: 0 });

    const frame = (await client.next()) as WsError;
    expect(frame.type).toBe("error");
    expect(frame.fatal).toBe(true);
  });

  it("should close on a rejected token, fatally, so the client stops looping", async () => {
    const { client, challenge } = await connect();

    client.send({ type: "auth_response", token: `syl_pat_${"0".repeat(32)}`, nonce: challenge.nonce });

    const frame = (await client.next()) as WsError;
    expect(frame.type).toBe("error");
    expect(frame.error.code).toBe("UNAUTHORIZED");
    expect(frame.fatal).toBe(true);
    await client.waitForClose();
  });

  it("should close on a revoked token", async () => {
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;
    keys.revoke(id, "phone lost");
    const { client, challenge } = await connect();

    client.send({ type: "auth_response", token, nonce: challenge.nonce });

    expect(((await client.next()) as WsError).fatal).toBe(true);
    await client.waitForClose();
  });

  it("should close on Syl's own agent key, which has no business on this socket", async () => {
    // The socket is the Commander's conversation. `confineAgent` guards the
    // HTTP contract and cannot guard this, because the handshake calls
    // `keys.verify` directly — so a credential that reaches reminders over
    // loopback would otherwise be able to send chat frames AS HIM here.
    //
    // Indistinguishable from any other rejection on the wire, for the same
    // reason every other one is: this end of the socket does not tell a caller
    // why a token was not good enough.
    const agent = keys.mint("Syl (her own hands)", { scope: "agent" }).token;
    const { client, challenge } = await connect();

    client.send({ type: "auth_response", token: agent, nonce: challenge.nonce });

    const frame = (await client.next()) as WsError;
    expect(frame.error.code).toBe("UNAUTHORIZED");
    expect(frame.fatal).toBe(true);
    await client.waitForClose();
  });

  it("should refuse a nonce belonging to somebody else's challenge", async () => {
    const other = await connect();
    const { client } = await connect();

    client.send({ type: "auth_response", token, nonce: other.challenge.nonce });

    expect(((await client.next()) as WsError).fatal).toBe(true);
    await client.waitForClose();
  });

  it("should accept an auth_response that omits the nonce, as the contract allows", async () => {
    const { client } = await connect();

    client.send({ type: "auth_response", token });

    expect((await client.next()).type).toBe("connected");
  });

  it("should refuse any other frame before the handshake finishes", async () => {
    const { client } = await connect();

    client.send({ type: "ping", ts: "2026-08-09T07:00:00.000Z" });

    expect(((await client.next()) as WsError).fatal).toBe(true);
    await client.waitForClose();
  });

  it("should not hold an unauthenticated socket open indefinitely", async () => {
    // Anyone who can reach the port could otherwise hold connections open
    // without ever presenting a credential.
    await sockets.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    db.close();
    await start({ authTimeoutMs: 50 });

    const { client } = await connect();

    expect(((await client.next()) as WsError).fatal).toBe(true);
    await client.waitForClose();
  });

  it("should refuse a second auth_response without dropping the session", async () => {
    const { client } = await join();

    client.send({ type: "auth_response", token });

    const frame = (await client.next()) as WsError;
    expect(frame.fatal).toBe(false);
    expect(client.closed).toBe(false);
  });
});

describe("chat_message", () => {
  it("should store the message and confirm it with both sequence numbers", async () => {
    const { client } = await join();

    client.send({
      type: "chat_message",
      clientId: "c-1",
      conversationId: INTERACTIVE_CONVERSATION_ID,
      text: "Remind me to call the pharmacy at 4.",
      idempotencyKey: "k-1",
    });

    const confirmation = (await client.next()) as WsDeliveryConfirmation;
    expect(confirmation.type).toBe("delivery_confirmation");
    expect(confirmation.clientId).toBe("c-1");
    // `seq` is its position in the frame stream; `messageSeq` is the message's
    // position in its conversation. They are different numbers.
    expect(confirmation.seq).toBe(1);
    expect(confirmation.messageSeq).toBe(1);
    expect(confirmation.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
  });

  it("should broadcast the stored message after confirming it", async () => {
    const { client } = await join();

    client.send({ type: "chat_message", clientId: "c-1", text: "hello", idempotencyKey: "k" });
    await client.next(); // the confirmation

    const frame = (await client.next()) as WsServerChatMessage;
    expect(frame.type).toBe("chat_message");
    expect(frame.seq).toBe(2);
    expect(frame.message.text).toBe("hello");
    expect(frame.message.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
  });

  it("should reach every attached client, not only the sender", async () => {
    const sender = await join();
    const watcher = await join();

    sender.client.send({
      type: "chat_message",
      clientId: "c-1",
      text: "hello",
      idempotencyKey: "k",
    });

    expect((await watcher.client.next()).type).toBe("delivery_confirmation");
    expect((await watcher.client.next()).type).toBe("chat_message");
  });

  it("should not broadcast a second copy of a retried send", async () => {
    const { client } = await join();
    const frame = {
      type: "chat_message",
      clientId: "c-1",
      text: "hello",
      idempotencyKey: "k",
    };

    client.send(frame);
    await client.next();
    await client.next();
    client.send(frame);

    const confirmation = (await client.next()) as WsDeliveryConfirmation;
    expect(confirmation.type).toBe("delivery_confirmation");
    await client.expectSilence();
    expect(messages.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(1);
  });

  it("should refuse a chat_message with no clientId, without dropping the socket", async () => {
    const { client } = await join();

    client.send({ type: "chat_message", text: "hello", idempotencyKey: "k" });

    const frame = (await client.next()) as WsError;
    expect(frame.type).toBe("error");
    expect(frame.fatal).toBe(false);
  });

  it("should refuse a message into a conversation that does not exist", async () => {
    const { client } = await join();

    client.send({
      type: "chat_message",
      clientId: "c-1",
      conversationId: "syl:conversation:00000000-0000-7000-8000-0000000000ff",
      text: "orphan",
      idempotencyKey: "k",
    });

    expect(((await client.next()) as WsError).type).toBe("error");
  });
});

describe("gap recovery", () => {
  it("should tell a reconnecting client how far ahead it is", async () => {
    const first = await join();
    first.client.send({ type: "chat_message", clientId: "c-1", text: "one", idempotencyKey: "k" });
    await first.client.next();
    await first.client.next();

    const second = await join(0);

    expect(second.connected.lastSeq).toBe(2);
  });

  it("should replay the frames a client missed", async () => {
    const sender = await join();
    sender.client.send({ type: "chat_message", clientId: "c-1", text: "one", idempotencyKey: "k" });
    await sender.client.next();
    await sender.client.next();

    const late = await join();
    late.client.send({ type: "sync", sinceSeq: 0 });

    const response = (await late.client.next()) as WsSyncResponse;
    expect(response.type).toBe("sync_response");
    expect(response.complete).toBe(true);
    expect(response.frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("should say complete: false when the gap is older than it remembers", async () => {
    // A phone that spent a weekend in a drawer. A client told `complete: true`
    // here silently misses everything that aged out.
    await sockets.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    db.close();
    await start({ capacity: 2 });

    const sender = await join();
    for (const id of ["c-1", "c-2", "c-3"]) {
      sender.client.send({ type: "chat_message", clientId: id, text: id, idempotencyKey: id });
      await sender.client.next();
      await sender.client.next();
    }

    sender.client.send({ type: "sync", sinceSeq: 0 });
    const response = (await sender.client.next()) as WsSyncResponse;

    expect(response.complete).toBe(false);
  });

  it("should answer a caught-up client with an empty range", async () => {
    const { client, connected } = await join();

    client.send({ type: "sync", sinceSeq: connected.lastSeq });

    const response = (await client.next()) as WsSyncResponse;
    expect(response.frames).toEqual([]);
    expect(response.complete).toBe(true);
  });

  it("should honour a limit and let the client come back for the rest", async () => {
    const sender = await join();
    for (const id of ["c-1", "c-2"]) {
      sender.client.send({ type: "chat_message", clientId: id, text: id, idempotencyKey: id });
      await sender.client.next();
      await sender.client.next();
    }

    sender.client.send({ type: "sync", sinceSeq: 0, limit: 2 });
    const first = (await sender.client.next()) as WsSyncResponse;

    expect(first.frames).toHaveLength(2);
    expect(first.toSeq).toBe(2);
    expect(first.complete).toBe(true);
  });

  it("should refuse a sync with no sequence number rather than guessing", async () => {
    const { client } = await join();

    client.send({ type: "sync" });

    expect(((await client.next()) as WsError).type).toBe("error");
  });

  it("should refuse a sinceSeq that is not a whole number", async () => {
    const { client } = await join();

    client.send({ type: "sync", sinceSeq: "lots" });

    expect(((await client.next()) as WsError).type).toBe("error");
  });
});

describe("presence", () => {
  it("should reach attached clients with the contract's snake_case ttl_ms", async () => {
    const { client } = await join();

    sockets.announcePresence({
      state: "thinking",
      intensity: 0.4,
      since: "2026-08-09T07:00:03.114Z",
      ttlMs: 4_000,
    });

    const frame = (await client.next()) as WsPresence;
    expect(frame.type).toBe("presence");
    expect(frame.state).toBe("thinking");
    expect(frame.ttl_ms).toBe(4_000);
    expect("seq" in frame).toBe(false);
  });

  it("should never be replayed, because replaying it would be a lie about now", async () => {
    // A character frozen mid-thought is worse than no character at all: it is
    // actively misrepresenting what the system is doing.
    const first = await join();
    sockets.announcePresence({
      state: "speaking",
      intensity: 1,
      since: "2026-08-09T07:00:03.114Z",
      ttlMs: 4_000,
    });
    await first.client.next();

    const late = await join();
    late.client.send({ type: "sync", sinceSeq: 0 });

    const response = (await late.client.next()) as WsSyncResponse;
    expect(response.frames).toEqual([]);
  });

  it("should not consume a sequence number, since a hole would look like data loss", async () => {
    const { client } = await join();
    sockets.announcePresence({
      state: "idle",
      intensity: 0,
      since: "2026-08-09T07:00:03.114Z",
      ttlMs: 1_000,
    });
    await client.next();

    client.send({ type: "chat_message", clientId: "c-1", text: "hello", idempotencyKey: "k" });

    expect(((await client.next()) as WsDeliveryConfirmation).seq).toBe(1);
  });

  it("should clamp an intensity outside 0..1 rather than sending it on", async () => {
    const { client } = await join();

    sockets.announcePresence({
      state: "alert",
      intensity: 1.4,
      since: "2026-08-09T07:00:03.114Z",
      ttlMs: 1_000,
    });

    expect(((await client.next()) as WsPresence).intensity).toBe(1);
  });

  it("should not reach a socket that has not authenticated", async () => {
    const { client } = await connect();

    sockets.announcePresence({
      state: "speaking",
      intensity: 1,
      since: "2026-08-09T07:00:03.114Z",
      ttlMs: 1_000,
    });

    await client.expectSilence();
  });
});

describe("keepalive", () => {
  it("should answer a ping with a pong echoing the client's timestamp", async () => {
    const { client } = await join();

    client.send({ type: "ping", ts: "2026-08-09T07:00:00.000Z" });

    const pong = (await client.next()) as WsPong;
    expect(pong.type).toBe("pong");
    expect(pong.ts).toBe("2026-08-09T07:00:00.000Z");
    expect(pong.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("should not number a pong, so keepalive cannot punch a hole in the stream", async () => {
    const { client } = await join();

    client.send({ type: "ping", ts: "2026-08-09T07:00:00.000Z" });
    await client.next();

    expect(sockets.lastSeq).toBe(0);
  });
});

describe("malformed input", () => {
  it("should answer something that is not JSON without dropping the socket", async () => {
    const { client } = await join();

    client.sendRaw("{ this is not json");

    const frame = (await client.next()) as WsError;
    expect(frame.type).toBe("error");
    expect(frame.fatal).toBe(false);
    expect(client.closed).toBe(false);
  });

  it("should refuse a frame with no type", async () => {
    const { client } = await join();

    client.send({ hello: "world" });

    expect(((await client.next()) as WsError).type).toBe("error");
  });

  it("should refuse a frame type it does not know", async () => {
    const { client } = await join();

    client.send({ type: "telepathy" });

    const frame = (await client.next()) as WsError;
    expect(frame.error.message).toContain("telepathy");
    expect(frame.fatal).toBe(false);
  });

  it("should refuse a JSON array, which is JSON but not a frame", async () => {
    const { client } = await join();

    client.sendRaw("[1, 2, 3]");

    expect(((await client.next()) as WsError).type).toBe("error");
  });
});

describe("bookkeeping", () => {
  it("should count only authenticated clients", async () => {
    await connect();
    expect(sockets.clientCount).toBe(0);

    await join();
    expect(sockets.clientCount).toBe(1);
  });

  it("should forget a client that goes away", async () => {
    const { client } = await join();
    expect(sockets.clientCount).toBe(1);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sockets.clientCount).toBe(0);
  });

  it("should number a broadcast made with no clients attached", async () => {
    // The Commander's phone being asleep must not stop the log from advancing,
    // or there would be nothing to replay when it wakes.
    const appended = messages.append({ role: "assistant", text: "while you were out" });

    const frame = sockets.broadcastMessage(appended.message);

    expect(frame.seq).toBe(1);
    expect(sockets.lastSeq).toBe(1);
  });
});
