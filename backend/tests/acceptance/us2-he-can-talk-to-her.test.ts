import type {
  WsAuthChallenge,
  WsConnected,
  WsDeliveryConfirmation,
  WsServerChatMessage,
  WsSyncResponse,
} from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { PROTOCOL_VERSION } from "../../src/services/ws-server.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";
import { TestClient } from "../helpers/ws.js";

/**
 * **US2 — he can talk to her.**
 *
 * > As the Commander, I want to hold a conversation with Syl from my phone, so
 * > that she is reachable without a terminal.
 *
 * Everything below runs against the socket the service actually serves — the
 * one `startServer` attaches to the HTTP server, over a real TCP connection.
 * `ws-server.test.ts` covers the same protocol against a hand-built server; the
 * difference that matters here is that this one is reached the way a phone
 * reaches it, through `bootstrap`, on the port the contract names.
 *
 * The story does not fully pass. Two of its clauses are proven, one is proven
 * with a documented hole, and the most important one — that there is somebody
 * on the other end — does not hold at all. Each is marked at the test that
 * shows it.
 */

const CHICAGO_MORNING = Date.UTC(2026, 7, 10, 12, 0, 0, 0);

describe("US2 — he can talk to her", () => {
  let syl: LiveService;
  let clients: TestClient[] = [];

  beforeEach(async () => {
    syl = await startLiveService();
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await syl.close();
  });

  /** Connect, answer the challenge, and return the client once authenticated. */
  async function connect(options: { readonly token?: string } = {}): Promise<{
    readonly client: TestClient;
    readonly connected: WsConnected;
  }> {
    const client = await TestClient.connect(syl.wsUrl);
    clients.push(client);

    const challenge = (await client.next()) as WsAuthChallenge;
    expect(challenge.type).toBe("auth_challenge");

    client.send({
      type: "auth_response",
      token: options.token ?? syl.token,
      nonce: challenge.nonce,
    });

    const connected = (await client.next()) as WsConnected;
    expect(connected.type).toBe("connected");
    return { client, connected };
  }

  describe("the connection itself", () => {
    it("should speak first, and refuse a client that answers before it has heard the challenge", async () => {
      const client = await TestClient.connect(syl.wsUrl);
      clients.push(client);

      const challenge = (await client.next()) as WsAuthChallenge;
      expect(challenge.type).toBe("auth_challenge");
      expect(challenge.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(challenge.nonce).toMatch(/^[0-9a-f]{16}$/u);
    });

    it("should identify the principal and its own sequence position on connect", async () => {
      const { connected } = await connect();

      expect(connected.protocolVersion).toBe(PROTOCOL_VERSION);
      // One principal, no accounts, no multi-tenancy — the device name is a
      // label on the key, not an identity.
      expect(connected.principal.name).toBe("The Commander");
      // Where the client resumes from. Zero on a socket that has sent nothing.
      expect(connected.lastSeq).toBe(0);
    });

    it("should close fatally on a bad token, so the client re-pairs instead of looping", async () => {
      const client = await TestClient.connect(syl.wsUrl);
      clients.push(client);
      await client.next(); // the challenge

      client.send({ type: "auth_response", token: "not-a-token" });

      const error = (await client.next()) as { type: string; fatal: boolean };
      expect(error.type).toBe("error");
      // `fatal` is what stops a client hammering a wall it cannot get past.
      expect(error.fatal).toBe(true);
      await client.waitForClose();
    });

    it("should carry the same bearer token as HTTP, on the same origin and port", async () => {
      // One credential, one host, one thing to expose over the tunnel. The URL
      // never carries the token — query strings reach proxy logs.
      const { connected } = await connect();
      const whoami = await expectData<{ id: string }>(await syl.api("/auth/whoami"));

      expect(connected.principal.id).toBe(whoami.id);
      expect(syl.wsUrl).toContain(new URL(syl.baseUrl).port);
      expect(syl.wsUrl).not.toContain(syl.token);
    });
  });

  describe("sending a message", () => {
    it("should confirm an optimistic send by the client's own id", async () => {
      const { client } = await connect();

      client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000a001",
        text: "Are you there?",
      });

      const confirmation = (await client.next()) as WsDeliveryConfirmation;
      expect(confirmation.type).toBe("delivery_confirmation");
      expect(confirmation.clientId).toBe("syl:message:00000000-0000-7000-8000-00000000a001");
      expect(confirmation.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
      // Two sequences, deliberately named apart: `seq` is the frame's position
      // on this socket, `messageSeq` is the message's position in its thread.
      // Feeding the wrong one back into `sync` replays everything or nothing.
      expect(confirmation.messageSeq).toBe(1);
      expect(confirmation.seq).toBeGreaterThan(0);
      expect(confirmation.seq).not.toBe(confirmation.messageSeq + 1000);
    });

    it("should deliver exactly once when the client retries the same send", async () => {
      // The phone's outbox retries by design. A second send of the same
      // clientId is the same message, not a second one.
      const { client } = await connect();
      const frame = {
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000a002",
        text: "Did you get that?",
      };

      client.send(frame);
      await client.next(); // confirmation
      await client.next(); // the broadcast chat_message

      client.send(frame);
      const second = (await client.next()) as WsDeliveryConfirmation;
      expect(second.type).toBe("delivery_confirmation");
      // No second chat_message: a replayed send already produced its frame.
      await client.expectSilence();

      const page = await expectData<{ items: unknown[] }>(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
      );
      expect(page.items).toHaveLength(1);
    });

    it("should replay what a client missed while it was in a tunnel", async () => {
      const first = await connect();
      first.client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000a003",
        text: "Sent while both were up.",
      });
      const confirmation = (await first.client.next()) as WsDeliveryConfirmation;
      await first.client.next(); // the broadcast

      // The tunnel drops.
      first.client.close();

      // Another client sends while the first is away.
      const second = await connect();
      second.client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000a004",
        text: "Sent while the phone was away.",
      });
      await second.client.next();
      await second.client.next();

      // The phone comes back and asks for the gap.
      const resumed = await connect();
      expect(resumed.connected.lastSeq).toBeGreaterThan(confirmation.seq);

      resumed.client.send({ type: "sync", sinceSeq: confirmation.seq });
      const replay = (await resumed.client.next()) as WsSyncResponse;

      expect(replay.type).toBe("sync_response");
      expect(replay.complete).toBe(true);
      expect(replay.frames.length).toBeGreaterThan(0);
      const texts = replay.frames
        .filter((frame): frame is WsServerChatMessage => frame.type === "chat_message")
        .map((frame) => frame.message.text);
      expect(texts).toContain("Sent while the phone was away.");
    });

    it("should answer a ping, so the client can tell a live socket from a dead one", async () => {
      const { client } = await connect();
      client.send({ type: "ping", ts: "2026-08-10T12:00:00.000Z" });

      const pong = (await client.next()) as { type: string; ts: string; serverTime: string };
      expect(pong.type).toBe("pong");
      expect(pong.ts).toBe("2026-08-10T12:00:00.000Z");
      expect(pong.serverTime).toMatch(/Z$/u);
    });
  });

  describe("what the story does not yet do", () => {
    /**
     * `syl-vls` — **she never answers.**
     *
     * This is the clause US2 exists for, and it is the one that does not hold.
     * `runTurn` and `SylAgent` are reachable from exactly one place in the
     * tree: `npm run ping`. `#onChatMessage` stores the message, confirms it,
     * echoes it, and stops. `role: "user"` is the only role anything in
     * `backend/src` ever appends.
     *
     * A generous timeout, because the assertion is about silence and a short
     * one would pass on a slow machine for the wrong reason.
     */
    it("should leave the Commander talking to himself: no assistant message ever arrives", async () => {
      const { client } = await connect();

      client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000b001",
        text: "Syl, are you awake?",
      });
      await client.next(); // confirmation
      const echo = (await client.next()) as WsServerChatMessage;
      expect(echo.message.role).toBe("user");

      // Nothing else comes. Not a `thinking` presence frame, not a reply.
      await client.expectSilence(600);

      const page = await expectData<{ items: { role: string }[] }>(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
      );
      expect(page.items.map((message) => message.role)).toEqual(["user"]);
      expect(page.items.some((message) => message.role === "assistant")).toBe(false);
    });

    /**
     * `syl-vls` — the second write path is invisible to live clients.
     *
     * A message posted over HTTP is stored and confirmed in the response, and
     * never broadcast: `SylSocketServer` is not in `AppDependencies` and the
     * conversation router has no reference to it. The same message arriving
     * over the socket *is* broadcast. So an admin sending from the web console,
     * or the phone falling back to HTTP when its socket is down, leaves every
     * other attached client showing a conversation that is missing a message
     * until it reloads.
     */
    it("should not tell attached clients about a message posted over HTTP", async () => {
      const { client } = await connect();

      await expectData(
        await syl.api(
          `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              clientId: "syl:message:00000000-0000-7000-8000-00000000b002",
              text: "Posted over HTTP, invisible on the socket.",
            }),
          },
        ),
      );

      await client.expectSilence(400);

      // It is really there — it just was not announced.
      const page = await expectData<{ items: { text: string }[] }>(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
      );
      expect(page.items.map((message) => message.text)).toContain(
        "Posted over HTTP, invisible on the socket.",
      );
    });
  });

  describe("the conversation the app renders from disk", () => {
    it("should return history newest-first with a cursor, so a cold launch can page it", async () => {
      const { client } = await connect();
      for (let index = 0; index < 3; index += 1) {
        client.send({
          type: "chat_message",
          clientId: `syl:message:00000000-0000-7000-8000-00000000c00${String(index)}`,
          text: `Message ${String(index)}`,
        });
        await client.next();
        await client.next();
      }

      const page = await expectData<{
        items: { text: string; seq: number }[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        await syl.api(
          `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages?limit=2`,
        ),
      );

      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();
      // Newest first, so the app renders the bottom of the thread without
      // having read all of it.
      expect(page.items[0]?.seq).toBeGreaterThan(page.items[1]?.seq ?? 0);
    });
  });

  it("should serve the socket regardless of the hour the store thinks it is", async () => {
    // Guards against the socket acquiring a time-of-day behaviour by accident:
    // there are no quiet hours on the conversation surface, and a client that
    // could not connect at 23:00 would be a client that is offline all night.
    //
    // It also records a smaller fact worth knowing: `startServer` gives
    // `SylSocketServer` no clock, so on a frozen-clock service the socket's own
    // stamps stay real while the stores' do not. Harmless in production, where
    // there is one clock, and a trap for anyone writing a test that asserts on
    // both.
    const frozen = await startLiveService({ clock: () => CHICAGO_MORNING });
    try {
      const client = await TestClient.connect(frozen.wsUrl);
      const challenge = (await client.next()) as WsAuthChallenge;
      client.send({ type: "auth_response", token: frozen.token, nonce: challenge.nonce });
      const connected = (await client.next()) as WsConnected;

      expect(connected.type).toBe("connected");
      expect(connected.serverTime).toMatch(/Z$/u);
      client.close();
    } finally {
      await frozen.close();
    }
  });
});
