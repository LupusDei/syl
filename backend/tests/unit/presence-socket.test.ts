import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { WsAuthChallenge, WsPresence, WsSyncResponse } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PresenceService } from "../../src/services/presence.js";
import type { ApiKeyService } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { SylSocketServer, WS_PATH } from "../../src/services/ws-server.js";
import { testDatabase, testDeps } from "../helpers/service.js";
import { TestClient } from "../helpers/ws.js";

/**
 * The derived state, on the wire.
 *
 * `presence.test.ts` proves the derivation; `ws-server.test.ts` proves the
 * frame's transport rules. This file is the joint between them, and it exists
 * because the two most important properties are only visible together: the
 * service's own frames must reach a client, and they must **not** come back on
 * a reconnect. Replaying a message the Commander missed is the whole point of
 * the replay buffer. Replaying "thinking" from four minutes ago is a lie.
 */

let db: SylDatabase;
let keys: ApiKeyService;
let http: Server;
let sockets: SylSocketServer;
let presence: PresenceService;
let url: string;
let token: string;
const clients: TestClient[] = [];

/** A Wednesday afternoon in Chicago — outside quiet hours. */
let now = Date.UTC(2026, 7, 12, 19, 0, 0);

beforeEach(async () => {
  now = Date.UTC(2026, 7, 12, 19, 0, 0);
  db = testDatabase();
  const deps = testDeps(db);
  keys = deps.keys;

  http = createServer();
  sockets = new SylSocketServer({ server: http, keys, messages: deps.messages });
  presence = new PresenceService({
    clock: () => now,
    // Exactly the wiring a bootstrap would do: the socket server's own method
    // already takes this shape, so nothing adapts between the two.
    emit: (frame) => sockets.announcePresence(frame),
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${WS_PATH}`;
  token = keys.pair(keys.issuePairingCode().code, "Commander's iPhone").token;
});

afterEach(async () => {
  presence.close();
  for (const client of clients.splice(0)) client.close();
  await sockets.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  db.close();
});

/** Connect, authenticate, and drop the handshake frames. */
async function join(): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  const challenge = (await client.next()) as WsAuthChallenge;
  client.send({ type: "auth_response", token, nonce: challenge.nonce });
  await client.next(); // `connected`
  return client;
}

describe("derived presence on the socket", () => {
  it("should reach a client as a presence frame with the contract's field names", async () => {
    const client = await join();
    presence.setAttached(true);

    presence.turnStarted();

    // `idle` from the attach, then `thinking`.
    expect(((await client.next()) as WsPresence).state).toBe("idle");
    const frame = (await client.next()) as WsPresence;
    expect(frame).toMatchObject({ type: "presence", state: "thinking" });
    expect(frame.ttl_ms).toBe(15_000);
    expect("seq" in frame).toBe(false);
  });

  it("should never replay presence to a client that reconnects mid-turn", async () => {
    // The deliberate exception to the replay machinery. A phone that came out
    // of a tunnel must not be told Syl is thinking about something she
    // finished four minutes ago.
    const first = await join();
    presence.setAttached(true);
    presence.turnStarted();
    await first.next();
    await first.next();

    const late = await join();
    late.send({ type: "sync", sinceSeq: 0 });

    expect(((await late.next()) as WsSyncResponse).frames).toEqual([]);
  });

  it("should keep presence out of the sequence space entirely", async () => {
    // A hole in the sequence is exactly how gap detection reports data loss.
    const client = await join();
    presence.setAttached(true);
    presence.turnStarted();
    await client.next();
    await client.next();

    expect(sockets.lastSeq).toBe(0);
  });
});
