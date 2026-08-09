import { readFileSync } from "node:fs";

import type { WsAuthChallenge, WsPresence } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_TIMEZONE,
  PresenceService,
} from "../../src/services/presence.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";
import { TestClient } from "../helpers/ws.js";

/**
 * `syl-8l7` — presence is built on both ends and joined in neither.
 *
 * `services/presence.ts` derives the state correctly and has a thorough unit
 * suite. `ws-server.ts` can put a frame on the wire and has one too. Between
 * them there is nothing: `PresenceService` is constructed in exactly one place
 * in the repository — a test — and `announcePresence` is called from exactly one
 * place — the same test. Nothing calls `setAttached` when a client connects,
 * `turnStarted` when a turn opens, or `alerted` when a time-sensitive delivery
 * goes out.
 *
 * Both unit suites pass. They will keep passing. The only way to see the gap is
 * to attach a client to the running service and listen, which is what this does.
 *
 * The iOS side is the other half of the waste: `PresenceTimeline` implements the
 * TTL decay, `SocketSession` deliberately keeps presence out of the sequence
 * space, and `ChatViewModel` publishes it — for a frame that never comes.
 */

describe("presence on the live socket", () => {
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

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(syl.wsUrl);
    clients.push(client);
    const challenge = (await client.next()) as WsAuthChallenge;
    client.send({ type: "auth_response", token: syl.token, nonce: challenge.nonce });
    await client.next(); // connected
    return client;
  }

  it("should send no presence frame when a client attaches", async () => {
    const client = await connect();

    // A client attaching is the one event that should move her off `absent`:
    // `idle` is defined as "present but silent". Nothing tells presence that
    // anybody arrived.
    await client.expectSilence(500);
  });

  it("should send no presence frame while a message is being handled", async () => {
    const client = await connect();

    client.send({
      type: "chat_message",
      clientId: "syl:message:00000000-0000-7000-8000-0000000000d1",
      text: "Are you thinking about it?",
    });

    const frames: string[] = [];
    frames.push(((await client.next()) as { type: string }).type);
    frames.push(((await client.next()) as { type: string }).type);
    await client.expectSilence(500);

    expect(frames).toEqual(["delivery_confirmation", "chat_message"]);
    expect(frames).not.toContain("presence");
  });

  it("should have no caller for any presence mutator anywhere in the service", () => {
    // The static half of the same finding, so it cannot be fixed by making the
    // socket emit one frame in one place while the rest stays unwired.
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

    expect([...callers.keys()].sort()).toEqual([]);
  });

  it("should have no construction of PresenceService outside the tests", () => {
    const constructing = sourceFiles(BACKEND_SRC).filter((file) =>
      readFileSync(file, "utf8").includes("new PresenceService("),
    );

    expect(constructing).toEqual([]);
  });

  it("should have no caller for announcePresence outside the tests", () => {
    const announcing = sourceFiles(BACKEND_SRC).filter((file) =>
      readFileSync(file, "utf8").includes("announcePresence("),
    );

    // `ws-server.ts` declares it; nothing calls it.
    expect(announcing.map((file) => file.slice(BACKEND_SRC.length))).toEqual([
      "services/ws-server.ts",
    ]);
  });

  it("should be a frame the socket can carry the moment somebody joins the two", async () => {
    // Not a seam — the opposite. Both halves work, which is what makes the
    // missing join a wiring job rather than a design one, and this is the
    // sentence that says so with an assertion instead of a comment.
    const client = await connect();
    const presence = new PresenceService({
      emit: (frame) => {
        syl.service.sockets.announcePresence(frame);
      },
      // A fixed clock at 12:00 Chicago, not merely a narrow quiet window.
      // Narrowing the window to 23:00–23:01 and leaving the real clock in place
      // would have passed 1439 minutes a day and gone red for one — the same
      // one-day-fuse time bomb `testDatabase` documents. Quiet hours are
      // wall-clock, so the only way to be sure is to fix the wall clock.
      clock: () => Date.UTC(2026, 7, 10, 17, 0, 0, 0),
      quietHours: DEFAULT_QUIET_HOURS,
      timeZone: DEFAULT_TIMEZONE,
    });

    presence.setAttached(true);

    const frame = (await client.next()) as WsPresence;
    expect(frame.type).toBe("presence");
    expect(frame.state).toBe("idle");
    // The one snake_case field on the wire, and the reason three sources pin it.
    expect(frame.ttl_ms).toBe(30_000);
    expect(Object.hasOwn(frame, "seq")).toBe(false);

    presence.close();
  });
});
