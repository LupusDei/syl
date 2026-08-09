import { readFileSync } from "node:fs";

import type { WsAuthChallenge, WsPresence } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";
import { TestClient } from "../helpers/ws.js";

/**
 * `syl-c5q` — presence was built on both ends and joined in neither.
 *
 * `services/presence.ts` derives the state correctly and has a thorough unit
 * suite. `ws-server.ts` can put a frame on the wire and has one too. Between
 * them there was nothing: `PresenceService` was constructed in exactly one
 * place in the repository — a test — and `announcePresence` was called from
 * exactly one place, the same test. Nothing told presence that a client had
 * arrived.
 *
 * Both unit suites passed, and would have kept passing forever. The only way to
 * see the gap is to attach a client to the running service and listen, which is
 * what this does.
 *
 * The join now lives in `startServer`: the socket is given presence as an
 * `AttachmentSink`, and presence is given `announcePresence` as its sink. Both
 * directions, made at the first moment both halves exist.
 *
 * ## Why the clock is frozen
 *
 * Presence goes `absent` during quiet hours, unconditionally. On the real
 * clock this file would pass for most of the day and go red between 23:00 and
 * 08:00 Chicago — the same one-day-fuse time bomb `testDatabase` documents.
 * Quiet hours are wall-clock, so the only way to be sure is to fix the wall
 * clock: noon in Chicago, outside every window in the service.
 */

/** 12:00 in Chicago on a Monday. Outside quiet hours by a wide margin. */
const NOON_IN_CHICAGO = Date.UTC(2026, 7, 10, 17, 0, 0, 0);

describe("presence on the live socket", () => {
  let syl: LiveService;
  let clients: TestClient[] = [];

  beforeEach(async () => {
    syl = await startLiveService({ clock: fixedClock(NOON_IN_CHICAGO) });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await syl.close();
  });

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(syl.wsUrl);
    clients.push(client);
    const challenge = (await client.next()) as WsAuthChallenge;
    client.send({ type: "auth_response", token: syl.token, nonce: challenge.nonce });
    await client.next(); // connected
    return client;
  }

  it("should send a presence frame when a client attaches", async () => {
    const client = await connect();

    // A client attaching is the one event that moves her off `absent`: `idle`
    // is defined as "present but silent". This frame is the whole finding —
    // before the wiring it never arrived, and every other presence behaviour
    // in the service is downstream of it.
    const frame = (await client.next()) as WsPresence;

    expect(frame.type).toBe("presence");
    expect(frame.state).toBe("idle");
    // The one snake_case field on the wire, and the reason three sources pin it.
    expect(frame.ttl_ms).toBe(30_000);
    expect(Object.hasOwn(frame, "seq")).toBe(false);
  });

  it("should arrive after `connected`, never before it", async () => {
    const client = await TestClient.connect(syl.wsUrl);
    clients.push(client);
    const challenge = (await client.next()) as WsAuthChallenge;
    client.send({ type: "auth_response", token: syl.token, nonce: challenge.nonce });

    // A client that has not been told the handshake succeeded has no business
    // being told what Syl is doing.
    expect(((await client.next()) as { type: string }).type).toBe("connected");
    expect(((await client.next()) as { type: string }).type).toBe("presence");
  });

  it("should not announce again for a second client while one is already attached", async () => {
    await connect();
    const second = await connect();

    // `setAttached` is derived from the connection set, and `PresenceService`
    // only emits when a client would notice a difference. Two attached clients
    // are the same fact as one.
    await second.expectSilence(300);
  });

  it("should go back to absent once the last client leaves", async () => {
    const first = await connect();
    const watcher = await connect();
    await first.next(); // the `idle` frame the first attach produced

    first.close();
    await watcher.expectSilence(300); // one client left, one remains: no change

    // The watcher is the last one out, so nothing is listening to hear the
    // `absent` frame — assert the state machine instead of the wire.
    watcher.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(syl.deps.presence.current.state).toBe("absent");
  });

  it("should say she is thinking while a turn is open, and stop when it closes", async () => {
    // `syl-vls`. This test used to assert the opposite — that no presence frame
    // appeared while a message was handled — and the reason it gave was right
    // at the time: `#onChatMessage` stored the message and broadcast it
    // synchronously, with no model involved, so `thinking` would have said
    // something was happening when nothing was. Derived state cannot lie, and
    // there was nothing to derive it from.
    //
    // There is now. A turn is a subprocess that runs for as long as it runs,
    // and `thinking` is downstream of it being open rather than of anything the
    // model claims. The turn here is held open by the test's own runner, so
    // what is asserted is the *derivation*, not a race with a real spawn.
    let finish = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const slow = await startLiveService({
      clock: fixedClock(NOON_IN_CHICAGO),
      runner: async (_prompt, options) => {
        options.onSessionId?.("held-session");
        await held;
        return {
          sessionId: "held-session",
          text: "Yes.",
          costUsd: 0,
          numTurns: 1,
          init: {
            kind: "init",
            sessionId: "held-session",
            raw: {},
            model: "test",
            apiKeySource: "none",
            mcpServers: [],
            tools: [],
            capabilities: [],
          },
          events: [],
        };
      },
    });

    try {
      const client = await TestClient.connect(slow.wsUrl);
      const challenge = (await client.next()) as WsAuthChallenge;
      client.send({ type: "auth_response", token: slow.token, nonce: challenge.nonce });
      await client.next(); // connected
      await client.next(); // the `idle` frame the attach produced

      client.send({
        type: "chat_message",
        clientId: "syl:message:00000000-0000-7000-8000-0000000000d1",
        text: "Are you thinking about it?",
      });

      const seen: string[] = [];
      let thinking: WsPresence | undefined;
      while (thinking === undefined) {
        const frame = (await client.next()) as { type: string };
        seen.push(frame.type);
        if (frame.type === "presence") thinking = frame as WsPresence;
      }

      // His message and its receipt come first; the turn opens behind them.
      expect(seen.slice(0, 2)).toEqual(["delivery_confirmation", "chat_message"]);
      expect(thinking.state).toBe("thinking");
      // Re-announced before it lapses, so a three-minute turn does not leave the
      // client falling back to idle after fifteen seconds.
      expect(thinking.ttl_ms).toBeGreaterThan(0);

      finish();

      // The turn closes: her answer, and a character that is no longer busy.
      const after: string[] = [];
      while (!after.includes("presence") || !after.includes("chat_message")) {
        after.push(((await client.next()) as { type: string }).type);
      }
      expect(slow.deps.presence.current.state).toBe("idle");
      client.close();
    } finally {
      finish();
      await slow.close();
    }
  });

  it("should have a caller in the service for every presence mutator that is wired", () => {
    // The static half of the same finding, so the wiring cannot regress to one
    // frame in one place while the rest goes quiet again. Each entry is a fact
    // the service owns and a component that owns it.
    const mutators = [
      "setAttached",
      "turnStarted",
      "turnEnded",
      "alerted",
      "manifested",
      "audioStarted",
      "micOpened",
      "setMuted",
    ];

    const callers = new Map<string, string[]>();
    for (const file of sourceFiles(BACKEND_SRC)) {
      if (file.endsWith("presence.ts")) continue; // the declarations themselves
      const source = readFileSync(file, "utf8");
      for (const mutator of mutators) {
        if (!source.includes(`${mutator}(`)) continue;
        callers.set(mutator, [...(callers.get(mutator) ?? []), file.slice(BACKEND_SRC.length)]);
      }
    }

    expect([...callers.keys()].sort()).toEqual(["setAttached", "turnEnded", "turnStarted"]);
    expect(callers.get("setAttached")).toEqual(["services/ws-server.ts"]);
    // `syl-vls` wired the turn. Both halves, in the one place that owns a turn's
    // lifetime — a `turnStarted` without a matching `turnEnded` pins Syl on
    // `thinking` until the process restarts.
    expect(callers.get("turnStarted")).toEqual(["services/conversation-service.ts"]);
    expect(callers.get("turnEnded")).toEqual(["services/conversation-service.ts"]);
  });

  /**
   * What is still not wired, named rather than left to be rediscovered.
   *
   * `alerted` belongs to the delivery path — `jobs/reminder-delivery-job.ts`
   * decides that a notification is time-sensitive, and that file belongs to
   * another lane. `audioStarted` and `micOpened` need a voice and a microphone,
   * neither of which reaches this service yet.
   *
   * This is an exemption list and it is a **finding, not a configuration**: the
   * assertion above fails the moment one of these gains a caller, so nobody can
   * wire one and leave a stale note behind.
   */
  it("should have no construction of PresenceService outside bootstrap and the harness", () => {
    const constructing = sourceFiles(BACKEND_SRC)
      .filter((file) => readFileSync(file, "utf8").includes("new PresenceService("))
      .map((file) => file.slice(BACKEND_SRC.length));

    // Exactly one, and it is `bootstrap`. Two would mean two characters
    // deriving state from the same facts and disagreeing about `since`.
    expect(constructing).toEqual(["index.ts"]);
  });

  it("should have exactly one caller for announcePresence, and it is the join", () => {
    const announcing = sourceFiles(BACKEND_SRC)
      .filter((file) => readFileSync(file, "utf8").includes("announcePresence("))
      .map((file) => file.slice(BACKEND_SRC.length));

    // `ws-server.ts` declares it; `index.ts` is the one place that hands it to
    // presence as a sink.
    expect(announcing.sort()).toEqual(["index.ts", "services/ws-server.ts"]);
  });

  it("should be absent, not idle, when a client attaches inside quiet hours", async () => {
    // The precedence that matters most, checked through the real service
    // rather than through `derivePresence`: quiet hours outrank a client
    // being attached. 01:00 Chicago.
    const quiet = await startLiveService({ clock: fixedClock(Date.UTC(2026, 7, 10, 6, 0, 0, 0)) });
    try {
      const client = await TestClient.connect(quiet.wsUrl);
      const challenge = (await client.next()) as WsAuthChallenge;
      client.send({ type: "auth_response", token: quiet.token, nonce: challenge.nonce });
      await client.next(); // connected

      await client.expectSilence(300);
      expect(quiet.deps.presence.current.state).toBe("absent");
      client.close();
    } finally {
      await quiet.close();
    }
  });
});
