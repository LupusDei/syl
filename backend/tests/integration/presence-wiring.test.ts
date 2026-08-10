import { readFileSync } from "node:fs";

import type { WsAuthChallenge, WsPresence } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { PRESENCE_TTL_MS } from "../../src/services/presence.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
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

/** A device token for the phone the alert stories push at. */
const APNS_TOKEN = "7ab34c19".repeat(8);

/** 16:00 in Chicago the same day: the instant those stories' reminder fires. */
const FIRE_AT = Date.UTC(2026, 7, 10, 21, 0, 0, 0);

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
          // No tool call in a double, so the two are the same string.
          spoken: "Yes.",
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
            autoMemoryPath: undefined,
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

    expect([...callers.keys()].sort()).toEqual([
      "alerted",
      "setAttached",
      "turnEnded",
      "turnStarted",
    ]);
    expect(callers.get("setAttached")).toEqual(["services/ws-server.ts"]);
    // `syl-vls` wired the turn. Both halves, in the one place that owns a turn's
    // lifetime — a `turnStarted` without a matching `turnEnded` pins Syl on
    // `thinking` until the process restarts.
    expect(callers.get("turnStarted")).toEqual(["services/conversation-service.ts"]);
    expect(callers.get("turnEnded")).toEqual(["services/conversation-service.ts"]);
    // `syl-8l7` wired the interruption. In the delivery path, because that is
    // the only place that knows a notification was `time-sensitive` AND that
    // Apple took it — the two facts `alert` is rationed by.
    expect(callers.get("alerted")).toEqual(["jobs/reminder-delivery-job.ts"]);
  });

  /**
   * What is still not wired, named rather than left to be rediscovered.
   *
   * `audioStarted` and `micOpened` need a voice and a microphone, neither of
   * which reaches this service yet. `manifested` needs the set piece, and
   * `setMuted` needs a control on a surface that does not exist.
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

  /**
   * A live service with a phone registered, a fake Apple behind it, and one
   * reminder waiting at 16:00 Chicago.
   *
   * The stores — and therefore presence — stay frozen at noon, so what the
   * character does is a statement about the story rather than about the hour
   * the suite ran. Only the delivery loop walks forward, which is the same
   * asymmetry every timing story in this repo uses.
   */
  async function serviceWithReminderDue(reminder: {
    readonly text: string;
    readonly kind?: string;
  }): Promise<{
    readonly syl: LiveService;
    readonly apple: FakeApns;
    /** Move the delivery loop to the reminder's instant and run one pass. */
    fire(): Promise<void>;
    close(): Promise<void>;
  }> {
    const apple = await startFakeApns();
    let deliveryNow = NOON_IN_CHICAGO;
    const syl = await startLiveService({
      clock: fixedClock(NOON_IN_CHICAGO),
      delivery: { apple, clock: () => deliveryNow },
    });

    syl.deps.devices.register({
      token: APNS_TOKEN,
      environment: "production",
      platform: "ios",
      name: "Commander's iPhone",
      appVersion: "0.1.0",
      osVersion: "26.1",
    });
    syl.deps.reminders.create({
      ...reminder,
      wallTime: "16:00",
      tz: "America/Chicago",
      date: "2026-08-10",
    });

    return {
      syl,
      apple,
      fire: async () => {
        deliveryNow = FIRE_AT;
        // The service's own runtime, driven by hand — Apple was redirected when
        // it booted, so this is the production assembly rather than one the
        // test built out of the same pieces.
        await syl.runtime.runner.tick();
      },
      close: async () => {
        await syl.close();
        await apple.close();
      },
    };
  }

  /** Attach, authenticate, and swallow the `idle` frame the attach produces. */
  async function attach(syl: LiveService): Promise<TestClient> {
    const client = await TestClient.connect(syl.wsUrl);
    clients.push(client);
    const challenge = (await client.next()) as WsAuthChallenge;
    client.send({ type: "auth_response", token: syl.token, nonce: challenge.nonce });
    await client.next(); // connected
    await client.next(); // the `idle` frame the attach produced
    return client;
  }

  it("should say she is alert when a time-sensitive reminder actually goes out", async () => {
    // `syl-8l7`, the third seam and the behavioural half of it. The static
    // assertion above proves `alerted` has a caller; this proves the caller is
    // on the path a real reminder takes, with a real fake Apple at the end of
    // it. A grep cannot tell a call that runs from a call that is unreachable.
    //
    // A commitment, so `payloadFor` marks the notification `time-sensitive` —
    // which is the one thing that earns the character an interruption.
    const story = await serviceWithReminderDue({
      text: "Call the pharmacy — the refill lapses today.",
    });

    try {
      const client = await attach(story.syl);
      await story.fire();

      const frame = (await client.next()) as WsPresence;
      expect(frame.type).toBe("presence");
      expect(frame.state).toBe("alert");
      // Exactly the window `alerted()` opened, and no longer. A frame that
      // outlives the state it describes is the same defect as no frame at all,
      // seen from the other end of the wire.
      expect(frame.ttl_ms).toBe(PRESENCE_TTL_MS.alert);
      expect(story.apple.pushes).toHaveLength(1);
    } finally {
      await story.close();
    }
  });

  it("should stay silent when what went out was not worth interrupting him for", async () => {
    // The ration, end to end. A rhythm message is `active`, not
    // `time-sensitive`: it arrives on the phone and the character does not
    // move. Without this, `alert` degrades into "a notification happened",
    // which is the state it is defined against.
    const story = await serviceWithReminderDue({ text: "Evening review.", kind: "rhythm" });

    try {
      const client = await attach(story.syl);
      await story.fire();

      expect(story.apple.pushes).toHaveLength(1);
      await client.expectSilence(300);
      expect(story.syl.deps.presence.current.state).toBe("idle");
    } finally {
      await story.close();
    }
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
