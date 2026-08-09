import { rmSync } from "node:fs";

import type { WsServerChatMessage } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { WsConnectedFrame } from "../../src/services/ws-server.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";
import { TestClient } from "../helpers/ws.js";

/**
 * The socket across a restart of the service under it — `syl-47j`.
 *
 * The unit suite starts a `SylSocketServer` on a bare HTTP server, which is the
 * right tool for the protocol's own rules and the wrong one for this: what
 * breaks here is what a client carries **between two runs of the whole
 * service**, and only a real restart against the same store produces the pair of
 * handshakes that reveal it.
 *
 * The failure this guards is the worst shape available. The socket stays open,
 * the keepalive keeps passing, the connection indicator stays green — and the
 * app goes permanently deaf until it is relaunched, because the frame sequence
 * began again at zero underneath a client that is entitled to assume it never
 * does.
 */

const clients: TestClient[] = [];
const opened: LiveService[] = [];
let directory: string | null = null;

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  // Each run is closed once, keeping the store, because the runs share it — a
  // `close()` that removed the directory would pull it out from under the next
  // one. The directory is removed here instead, after every run has let go, and
  // it takes the `-wal` and `-shm` files with it.
  for (const service of opened.splice(0).reverse()) {
    await service.close({ keepDatabase: true });
  }
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

/** Start a service, and hand back a way to restart it against the same store. */
async function startRestartable(): Promise<{
  service: LiveService;
  /** The token the phone holds. It outlives the process, because the keys do. */
  token: string;
  restart: () => Promise<LiveService>;
}> {
  const first = await startLiveService({ deviceName: "Commander's iPhone" });
  opened.push(first);
  directory = first.directory;

  return {
    service: first,
    token: first.token,
    restart: async () => {
      await first.close({ keepDatabase: true });
      opened.splice(opened.indexOf(first), 1);

      // `pair: false` because pairing is single-use and the point is that the
      // phone is still holding the token it already has. The keys live in the
      // store, so the restarted service accepts it without the Commander doing
      // anything — which is exactly why he never sees the failure coming.
      const second = await startLiveService({ databasePath: first.databasePath, pair: false });
      opened.push(second);
      return second;
    },
  };
}

/** Connect to a running service, authenticate, and take the `connected` frame. */
async function join(
  service: LiveService,
  token: string,
): Promise<{ client: TestClient; connected: WsConnectedFrame }> {
  const client = await TestClient.connect(service.wsUrl);
  clients.push(client);
  const challenge = (await client.next()) as { nonce: string };
  client.send({ type: "auth_response", token, nonce: challenge.nonce });
  return { client, connected: (await client.next()) as WsConnectedFrame };
}

/**
 * The next **numbered** frame, skipping presence.
 *
 * This is a live service with a character attached, so `presence` arrives on its
 * own schedule and lands wherever it lands. It is unnumbered and never replayed
 * — it takes no part in anything this file is about — so a test that counted
 * frames positionally would fail on Syl thinking at the wrong moment. It did,
 * once, and only when run alongside other suites.
 */
async function nextNumbered(client: TestClient): Promise<{ type: string; seq: number }> {
  for (;;) {
    const frame = (await client.next()) as { type: string; seq: number };
    if (frame.type !== "presence") return frame;
  }
}

/** Send one message and drain the two numbered frames it produces. */
async function say(client: TestClient, text: string, id: string): Promise<number> {
  client.send({
    type: "chat_message",
    clientId: `syl:message:ws-restart-${id}`,
    text,
    idempotencyKey: `ws-restart-${id}`,
  });
  expect((await nextNumbered(client)).type).toBe("delivery_confirmation");
  const frame = (await nextNumbered(client)) as unknown as WsServerChatMessage;
  expect(frame.type).toBe("chat_message");
  return frame.seq;
}

describe("the socket across a restart of the service", () => {
  it("should hand the reconnecting client the one fact that tells it its mark is void", async () => {
    const { service, token, restart } = await startRestartable();

    // A session with history, so the client's mark is a real position in a real
    // frame stream rather than the zero everything starts at.
    const first = await join(service, token);
    expect(first.connected.lastSeq).toBe(0);
    const clientMark = await say(first.client, "before the restart", "0001");
    expect(clientMark).toBe(2);

    const second = await join(await restart(), token);

    // **The bug, stated as an assertion.** The sequence rewound, and the rewind
    // is invisible to the only rule the client had: `connected.lastSeq >
    // lastSeq` is how a gap is detected, and 0 > 2 is false. On this frame alone
    // a client concludes "nothing new" and then discards frames 1, 2, 3 … under
    // its own already-seen guard, forever.
    expect(second.connected.lastSeq).toBe(0);
    expect(second.connected.lastSeq).not.toBeGreaterThan(clientMark);

    // **The fix.** The run is named, so "nothing new" and "everything you hold
    // came from a server that no longer exists" stop looking identical.
    expect(second.connected.serverEpoch).toEqual(expect.any(String));
    expect(second.connected.serverEpoch).not.toBe(first.connected.serverEpoch);
  }, 30_000);

  it("should deliver the new run's frames to a client that reset on the changed epoch", async () => {
    const { service, token, restart } = await startRestartable();

    const first = await join(service, token);
    await say(first.client, "before the restart", "0002");

    const second = await join(await restart(), token);

    // What `SocketSession` does with a changed epoch, applied here rather than
    // assumed, so the wire fact and the client rule are checked against each
    // other instead of each being asserted against itself.
    const mark = second.connected.serverEpoch === first.connected.serverEpoch ? 2 : 0;
    expect(mark).toBe(0);

    const seq = await say(second.client, "after the restart", "0003");

    // Two, not three: the new run numbers from one. That is the whole hazard,
    // and with the mark reset it is simply the next frame.
    expect(seq).toBe(2);
    expect(seq).toBeGreaterThan(mark);
  }, 30_000);
});
