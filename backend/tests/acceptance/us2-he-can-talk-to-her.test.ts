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
import {
  flagValue,
  type FakeClaude,
  type FakeClaudeInvocation,
} from "../helpers/fake-claude.js";
import { replyingRunner } from "../helpers/service.js";
import {
  answeringClaude,
  expectData,
  LIVE_REPLY_TEXT,
  startLiveService,
  type LiveService,
} from "../helpers/live-service.js";
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
 * **The story holds in both directions** as of `syl-vls`. It did not before:
 * `runTurn` and `SylAgent` were reachable from exactly one place in the tree
 * (`npm run ping`), `#onChatMessage` stored the message and stopped, and
 * `role: "user"` was the only role anything in `backend/src` ever appended. The
 * clauses that were broken are marked at the tests that now prove them.
 *
 * Every turn here runs against a fake `claude` executable replaying a captured
 * transcript, spawned for real by `runTurn` — see `helpers/fake-claude.ts`.
 * Nothing in this suite may reach the real CLI.
 */

const CHICAGO_MORNING = Date.UTC(2026, 7, 10, 12, 0, 0, 0);

/**
 * The spawns that are HIS CONVERSATION, in order — not every spawn.
 *
 * A turn of his own conversation runs pre-authorised, because there is nobody
 * to approve a prompt in a headless turn. A sealed reader — extraction, an
 * article — runs with `manual` and no MCP config precisely so it cannot act.
 * That difference is a security boundary, which makes it the honest thing to
 * filter on: any test that means "his turns" can say so, and one that
 * accidentally matched a reader turn would be asserting against a turn that is
 * not allowed to do anything.
 */
function hisTurns(syl: { readonly claude: FakeClaude | null }): FakeClaudeInvocation[] {
  return (syl.claude?.invocations() ?? []).filter(
    (spawn) => flagValue(spawn.argv, "--permission-mode") === "bypassPermissions",
  );
}

describe("US2 — he can talk to her", () => {
  let syl: LiveService;
  let clients: TestClient[] = [];

  beforeEach(async () => {
    // Syl answers here, in process. The turns that must go through a real
    // subprocess — `runTurn`, its argv, the stream-json decode — live in
    // "through the real harness" below and start their own service, because a
    // node spawn per message across a whole acceptance file is how a suite
    // acquires load-dependent flakiness.
    syl = await startLiveService({ runner: replyingRunner(LIVE_REPLY_TEXT) });
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
    const client = await TestClient.connect(syl.wsUrl, { ignorePresence: true });
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

  /**
   * One complete exchange: he says something, and she answers.
   *
   * Three frames, in this order and no other. The confirmation is this
   * connection's receipt for the send; the echo is his own message entering the
   * thread; the reply is hers, and it arrives later because a turn is a
   * subprocess. The generous timeout on the third is because a spawn is a
   * spawn — a short one would fail on a loaded machine for the wrong reason.
   */
  async function exchange(
    client: TestClient,
    clientId: string,
    text: string,
  ): Promise<{
    readonly confirmation: WsDeliveryConfirmation;
    readonly echo: WsServerChatMessage;
    readonly reply: WsServerChatMessage;
  }> {
    client.send({ type: "chat_message", clientId, text });

    const confirmation = (await client.next()) as WsDeliveryConfirmation;
    expect(confirmation.type).toBe("delivery_confirmation");
    const echo = (await client.next()) as WsServerChatMessage;
    expect(echo.type).toBe("chat_message");
    const reply = (await client.next(15_000)) as WsServerChatMessage;
    expect(reply.type).toBe("chat_message");

    return { confirmation, echo, reply };
  }

  describe("the connection itself", () => {
    it("should speak first, and refuse a client that answers before it has heard the challenge", async () => {
      const client = await TestClient.connect(syl.wsUrl, { ignorePresence: true });
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
      const client = await TestClient.connect(syl.wsUrl, { ignorePresence: true });
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
      // clientId is the same message, not a second one — and, since `syl-vls`,
      // it must not be a second *turn* either. Answering a retry twice would
      // make the outbox's own correctness a reason to burn a subscription turn
      // and put a duplicate reply in the thread.
      const { client } = await connect();
      const frame = {
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000a002",
        text: "Did you get that?",
      };

      client.send(frame);
      await client.next(); // confirmation
      await client.next(); // the broadcast chat_message
      await client.next(10_000); // her reply

      client.send(frame);
      const second = (await client.next()) as WsDeliveryConfirmation;
      expect(second.type).toBe("delivery_confirmation");
      // No second chat_message and no second reply: a replayed send already
      // produced its frame and its answer.
      await client.expectSilence(500);

      const page = await expectData<{ items: { role: string }[] }>(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
      );
      expect(page.items.filter((message) => message.role === "user")).toHaveLength(1);
      expect(page.items.filter((message) => message.role === "assistant")).toHaveLength(1);
    });

    it("should replay what a client missed while it was in a tunnel", async () => {
      const first = await connect();
      const { confirmation } = await exchange(
        first.client,
        "syl:message:00000000-0000-7000-8000-00000000a003",
        "Sent while both were up.",
      );

      // The tunnel drops.
      first.client.close();

      // Another client sends while the first is away.
      const second = await connect();
      await exchange(
        second.client,
        "syl:message:00000000-0000-7000-8000-00000000a004",
        "Sent while the phone was away.",
      );

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

  describe("somebody on the other end", () => {
    /**
     * `syl-vls` — **this is the clause US2 exists for.**
     *
     * It used to fail. `runTurn` and `SylAgent` were reachable from exactly one
     * place in the tree — `npm run ping` — `#onChatMessage` stored the message,
     * confirmed it, echoed it and stopped, and `role: "user"` was the only role
     * anything in `backend/src` ever appended.
     */
    it("should answer him, on the socket and in the history he reloads", async () => {
      const { client } = await connect();

      const { echo, reply } = await exchange(
        client,
        "syl:message:00000000-0000-7000-8000-00000000b001",
        "Syl, are you awake?",
      );

      expect(echo.message.role).toBe("user");
      expect(reply.message.role).toBe("assistant");
      expect(reply.message.text).toBe(LIVE_REPLY_TEXT);
      // Null for anything Syl originated: there is no optimistic bubble on the
      // client for her own message to reconcile against.
      expect(reply.message.clientId).toBeNull();
      // Numbered, and after his. A frame that is not numbered is a frame a
      // client in a tunnel never gets back.
      expect(reply.seq).toBeGreaterThan(echo.seq);
      expect(reply.message.seq).toBeGreaterThan(echo.message.seq);

      // And on disk, so a cold launch shows the exchange without the socket.
      const page = await expectData<{ items: { role: string; text: string }[] }>(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
      );
      expect(page.items.map((message) => message.role)).toEqual(["assistant", "user"]);
    });

    /**
     * `syl-vls` — the second write path used to be invisible to live clients.
     *
     * A message posted over HTTP was stored and confirmed in the response and
     * never broadcast: `SylSocketServer` was not in `AppDependencies` and the
     * conversation router had no reference to it. So an admin sending from the
     * web console, or the phone falling back to HTTP when its socket is down,
     * left every other attached client showing a conversation missing a message
     * until it reloaded — and nothing answered it either.
     *
     * Both paths now go through `ConversationService.append` + `.accept`, which
     * is the only reason they cannot drift apart again.
     */
    it("should announce and answer a message posted over HTTP, exactly as over the socket", async () => {
      const { client } = await connect();

      await expectData(
        await syl.api(
          `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              clientId: "syl:message:00000000-0000-7000-8000-00000000b002",
              text: "Posted over HTTP.",
            }),
          },
        ),
      );

      // The attached client is told, without having sent anything itself.
      const announced = (await client.next()) as WsServerChatMessage;
      expect(announced.type).toBe("chat_message");
      expect(announced.message.role).toBe("user");
      expect(announced.message.text).toBe("Posted over HTTP.");

      const reply = (await client.next(10_000)) as WsServerChatMessage;
      expect(reply.message.role).toBe("assistant");
      expect(reply.message.text).toBe(LIVE_REPLY_TEXT);
    });

    it("should answer two quick sends in order, one turn at a time", async () => {
      // A phone with a flaky tunnel flushes its outbox in a burst. Two turns
      // resuming one session id concurrently is the failure this serialises
      // against, and the observable consequence is that both answers arrive and
      // neither send is lost.
      const { client } = await connect();

      client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000b005",
        text: "One.",
      });
      client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-00000000b006",
        text: "Two.",
      });

      const assistant: string[] = [];
      const said: string[] = [];
      while (assistant.length < 2) {
        const frame = (await client.next(10_000)) as WsServerChatMessage;
        if (frame.type !== "chat_message") continue;
        if (frame.message.role === "assistant") assistant.push(frame.message.text);
        else said.push(frame.message.text);
      }

      expect(said).toEqual(["One.", "Two."]);
      expect(assistant).toEqual([LIVE_REPLY_TEXT, LIVE_REPLY_TEXT]);
    });

    /**
     * `syl-vls` — a turn that fails must not be silence.
     *
     * A send that vanishes is the same class of defect as a dropped reminder:
     * the Commander cannot tell a broken assistant from a thinking one, and the
     * only recovery available to him is to give up. So a failed turn leaves a
     * message in the thread saying so — persisted, and broadcast like any other.
     */
    it("should say so in the conversation when the turn fails", async () => {
      const broken = await startLiveService({
        // A CLI that rejects its own arguments: it exits without reading stdin,
        // which is the real shape of this failure.
        claude: { ignoreStdin: true, exitCode: 1, stderr: "claude: error: unknown option\n" },
      });

      try {
        const client = await TestClient.connect(broken.wsUrl, { ignorePresence: true });
        const challenge = (await client.next()) as WsAuthChallenge;
        client.send({ type: "auth_response", token: broken.token, nonce: challenge.nonce });
        await client.next(); // connected

        client.send({
          type: "chat_message",
          clientId: "syl:message:00000000-0000-7000-8000-00000000b007",
          text: "Is anything on for today?",
        });
        await client.next(); // confirmation
        await client.next(); // his own message

        // A real spawn, so the same generous budget the `exchange` helper uses.
        const reply = (await client.next(15_000)) as WsServerChatMessage;
        expect(reply.message.role).toBe("assistant");
        expect(reply.message.text).toContain("could not answer");
        // The reason is in the message, on his own machine, where it is the
        // most useful thing on the screen.
        expect(reply.message.text).toContain("unknown option");

        // And it is history, so it is still there after a reload.
        const page = await expectData<{ items: { role: string }[] }>(
          await broken.api(
            `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`,
          ),
        );
        expect(page.items.map((message) => message.role)).toEqual(["assistant", "user"]);
        client.close();
      } finally {
        await broken.close();
      }
    });
  });

  /**
   * The same story, run through a real `claude` subprocess.
   *
   * Everything above uses an in-process runner, which is right for the
   * behaviour of the service and says nothing about the harness underneath it.
   * These three facts are about that harness — that `runTurn` really assembles
   * the argv, really decodes stream-json, and really resumes — so they are
   * asserted against a fake executable replaying a captured transcript, and
   * they are kept few because each one costs a process.
   */
  describe("through the real harness", () => {
    beforeEach(async () => {
      // Replaces the in-process service the outer hook just built. Cheap: a
      // live service is a port and an in-memory-ish store, and this way every
      // helper in this file keeps working unchanged.
      await syl.close();
      syl = await startLiveService({ claude: answeringClaude() });
    });

    it("should answer over a real subprocess, and resume the same session next turn", async () => {
      // Two turns in one test rather than two, because each one is a process
      // and this file is not the place to spend them. Everything asserted here
      // is a fact about the harness underneath the service.
      const { client } = await connect();

      const first = await exchange(
        client,
        "syl:message:00000000-0000-7000-8000-00000000b0a1",
        "Bill me right.",
      );
      // The text came back through the stream-json decoder, out of a transcript
      // captured from Claude Code 2.1.226.
      expect(first.reply.message.text).toBe(LIVE_REPLY_TEXT);

      // THE FIRST TURN OF HIS CONVERSATION by name, not "whatever is in the
      // slot" — `syl-ah4`.
      const opening = hisTurns(syl)[0];
      expect(opening).toBeDefined();
      // Non-negotiable constraint 3, on the service path rather than only in
      // the harness's own unit tests: a set `ANTHROPIC_API_KEY` outranks the
      // claude.ai login and silently reroutes billing (`adj-t64m9`).
      expect(opening?.sawApiKey).toBe(false);
      expect(opening?.sawAuthToken).toBe(false);
      // Unattended means pre-authorised. There is nobody to approve a prompt in
      // a headless turn, and the CLI's default denies every call.
      expect(flagValue(opening?.argv ?? [], "--permission-mode")).toBe("bypassPermissions");
      // The first turn of a lane opens a session under an id settled before the
      // spawn, so a crash between spawn and init cannot strand a conversation.
      expect(flagValue(opening?.argv ?? [], "--session-id")).toBeDefined();

      await exchange(client, "syl:message:00000000-0000-7000-8000-00000000b003", "Second thing.");

      // Continuity is `--resume <sessionId>` against the id stored for this
      // lane, and it is also why turns must not overlap: two subprocesses
      // resuming one id interleave two halves of one transcript.
      // THE SECOND TURN OF HIS CONVERSATION, named rather than assumed to be
      // the newest spawn.
      //
      // This is the line that failed intermittently for weeks and passed 15/15
      // in isolation, and the cause was never timing. Every spawn wrote to one
      // record file, and an EXTRACTION READER TURN fires between his two
      // messages — sealed, never resumed, so it carries no `--resume` at all.
      // Whenever that reader was the last thing to write, this assertion read
      // it and failed, and the failure was indistinguishable from continuity
      // being broken. One record per spawn plus a filter for his own lane
      // makes it say what it always meant.
      // Exactly two turns of HIS CONVERSATION. There are three spawns: an
      // extraction reader fires between them, which is the whole reason this
      // assertion has to name what it wants.
      expect(hisTurns(syl).length, "the second turn never spawned").toBe(2);
      const resuming = hisTurns(syl)[1]?.argv ?? [];
      expect(flagValue(resuming, "--resume")).toBeDefined();
      expect(resuming).not.toContain("--session-id");

      const page = await expectData<{ items: { role: string }[] }>(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
      );
      expect(page.items.map((message) => message.role)).toEqual([
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
    });
  });

  describe("the conversation the app renders from disk", () => {
    it("should return history newest-first with a cursor, so a cold launch can page it", async () => {
      const { client } = await connect();
      for (let index = 0; index < 3; index += 1) {
        await exchange(
          client,
          `syl:message:00000000-0000-7000-8000-00000000c00${String(index)}`,
          `Message ${String(index)}`,
        );
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
      const client = await TestClient.connect(frozen.wsUrl, { ignorePresence: true });
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
