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

  it("should send no presence frame while a message is being handled", async () => {
    const client = await connect();
    await client.next(); // the attach

    client.send({
      type: "chat_message",
      clientId: "syl:message:00000000-0000-7000-8000-0000000000d1",
      text: "Are you thinking about it?",
    });

    const frames: string[] = [];
    frames.push(((await client.next()) as { type: string }).type);
    frames.push(((await client.next()) as { type: string }).type);
    await client.expectSilence(500);

    // Still true, and deliberately so. `thinking` means a turn is open, and no
    // turn opens on this path: `#onChatMessage` stores the message and
    // broadcasts it, synchronously, with no model involved. Calling
    // `turnStarted`/`turnEnded` around it would put `thinking` then `idle` on
    // the wire within the same millisecond — a state that says something is
    // happening when nothing is. Derived state cannot lie, and this is the
    // seam where it would start. It gets its caller when the agent is wired to
    // the socket, not before.
    expect(frames).toEqual(["delivery_confirmation", "chat_message"]);
    expect(frames).not.toContain("presence");
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

    expect([...callers.keys()].sort()).toEqual(["setAttached"]);
    expect(callers.get("setAttached")).toEqual(["services/ws-server.ts"]);
  });

  /**
   * What is still not wired, named rather than left to be rediscovered.
   *
   * `alerted` belongs to the delivery path — `jobs/reminder-delivery-job.ts`
   * decides that a notification is time-sensitive, and that file belongs to
   * another lane. `turnStarted`, `audioStarted` and `micOpened` need a turn, a
   * voice and a microphone, none of which reach this service yet.
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
