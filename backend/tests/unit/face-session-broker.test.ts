import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASK_SECRET_PREFIX, verifyAskCredential } from "../../src/face/ask-credential.js";
import { FaceCostGuard } from "../../src/face/face-cost-guard.js";
import {
  FaceColdLaneError,
  FaceCostCeilingError,
  FaceSessionBroker,
  FaceSessionFailedError,
} from "../../src/face/face-session-broker.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import type {
  CreateRealtimeSessionInput,
  LiveKitConnectCreds,
  RealtimeSessionRow,
  RunwaySessionApi,
} from "../../src/face/runway-client.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * The lifecycle, and the one property everything else here is in service of:
 * **`RUNWAYML_API_SECRET` never crosses the boundary.**
 *
 * The leak test asserts on the VALUE, not on the field names. A field rename is
 * exactly how a secret gets shipped to a browser, and a test that checks for a
 * key called `apiKey` passes cheerfully the day somebody calls it `token`.
 */

/** The dev-org secret, as the client would hold it. */
const SECRET = "key_thisisthesecretandmustneverleavetheserver";
const AVATAR = "48cbc73d-f47f-41de-bed8-58a532b3b84b";

/** A Runway that answers whatever the test tells it to. */
class FakeRunway implements RunwaySessionApi {
  createCalls: CreateRealtimeSessionInput[] = [];
  connectCalls: string[] = [];
  /** Status answers, consumed one per poll; the last one repeats. */
  statuses: RealtimeSessionRow[] = [];
  createResult: RealtimeSessionRow = { id: "rts_1", status: "PENDING" };
  createError: Error | null = null;
  #polls = 0;

  createRealtimeSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionRow> {
    this.createCalls.push(input);
    if (this.createError) return Promise.reject(this.createError);
    return Promise.resolve(this.createResult);
  }

  getRealtimeSession(sessionId: string): Promise<RealtimeSessionRow> {
    const index = Math.min(this.#polls, this.statuses.length - 1);
    this.#polls += 1;
    const row = this.statuses[index] ?? { id: sessionId, status: "PENDING" };
    return Promise.resolve(row);
  }

  connectBackend(sessionId: string): Promise<LiveKitConnectCreds> {
    this.connectCalls.push(sessionId);
    return Promise.resolve({ url: "wss://livekit.example", token: "lk_tok", roomName: "room-1" });
  }
}

describe("FaceSessionBroker", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let guard: FaceCostGuard;
  let runway: FakeRunway;
  let now: number;
  const clock: Clock = () => now;

  const READY: RealtimeSessionRow = {
    id: "rts_1",
    status: "READY",
    sessionKey: "stk_shortlived",
    expiresAt: "2026-08-21T12:05:00.000Z",
  };

  beforeEach(() => {
    now = Date.parse("2026-08-21T12:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    sessions = new FaceSessionStore({ db: database.handle, clock });
    guard = new FaceCostGuard({ dailyCreditCeiling: 300, now: clock });
    runway = new FakeRunway();
    runway.statuses = [READY];
  });

  afterEach(() => {
    database.close();
  });

  function broker(overrides: Partial<ConstructorParameters<typeof FaceSessionBroker>[0]> = {}) {
    return new FaceSessionBroker({
      client: runway,
      guard,
      sessions,
      avatarId: AVATAR,
      now: clock,
      // No real timers anywhere in this file.
      sleep: () => Promise.resolve(),
      pollIntervalMs: 10,
      timeoutMs: 100,
      isLaneWarm: () => true,
      ...overrides,
    });
  }

  describe("the happy path", () => {
    it("should create, charge, poll to READY and hand back browser credentials", async () => {
      const opened = await broker().startSession();

      expect(opened.credentials.sessionId).toBe("rts_1");
      expect(opened.credentials.sessionKey).toBe("stk_shortlived");
      expect(opened.credentials.avatarId).toBe(AVATAR);
      expect(opened.credentials.expiresAt).toBe("2026-08-21T12:05:00.000Z");
    });

    it("should ask for HER avatar as a custom character on the avatar model", async () => {
      await broker().startSession();

      expect(runway.createCalls[0]?.avatar).toEqual({ type: "custom", avatarId: AVATAR });
    });

    it("should declare the ask_syl tool at create, or she has no way to be asked anything", async () => {
      await broker().startSession();

      const tools = runway.createCalls[0]?.tools ?? [];
      expect(tools.map((tool) => tool.name)).toContain("ask_syl");
    });

    it("should record the session in the ledger with the upfront credits", async () => {
      await broker().startSession();

      const row = sessions.get("rts_1");
      expect(row?.credits).toBe(2);
      expect(row?.closedAt).toBeNull();
      expect(guard.spentToday()).toBe(2);
    });

    it("should mint a per-session ask credential that verifies against that session", async () => {
      const opened = await broker().startSession();

      expect(opened.askSecret.startsWith(ASK_SECRET_PREFIX)).toBe(true);
      expect(
        verifyAskCredential({ sessions, sessionId: "rts_1", secret: opened.askSecret, now }).ok,
      ).toBe(true);
    });

    it("should give the credential the session's own expiry, so it dies with it", async () => {
      await broker().startSession();

      expect(sessions.get("rts_1")?.askExpiresAt).toBe("2026-08-21T12:05:00.000Z");
    });

    it("should keep polling until READY rather than giving up on the first PENDING", async () => {
      runway.statuses = [
        { id: "rts_1", status: "PENDING" },
        { id: "rts_1", status: "PENDING" },
        READY,
      ];

      const opened = await broker().startSession();

      expect(opened.credentials.sessionKey).toBe("stk_shortlived");
    });
  });

  describe("the secret", () => {
    it("should never appear in the credentials handed to a client", async () => {
      const opened = await broker().startSession();

      // On the VALUE, not on the field names. A rename is how this leaks.
      expect(JSON.stringify(opened.credentials)).not.toContain(SECRET);
      expect(JSON.stringify(opened.credentials)).not.toContain(SECRET.slice(0, 12));
    });

    it("should never put the per-session ask credential in the client's credentials either", async () => {
      const opened = await broker().startSession();

      // The avatar's RPC handler gets it; the browser has no use for it and
      // handing it over would make the ingress reachable from the client.
      expect(JSON.stringify(opened.credentials)).not.toContain(opened.askSecret);
    });

    it("should hand a client nothing but the four fields it needs", async () => {
      const opened = await broker().startSession();

      expect(Object.keys(opened.credentials).sort()).toEqual([
        "avatarId",
        "expiresAt",
        "sessionId",
        "sessionKey",
      ]);
    });
  });

  describe("the gates, which run before any money is spent", () => {
    it("should refuse before making any HTTP call once the ceiling is reached", async () => {
      guard.recordSpend(300);

      await expect(broker().startSession()).rejects.toBeInstanceOf(FaceCostCeilingError);
      expect(runway.createCalls).toHaveLength(0);
      expect(sessions.live()).toHaveLength(0);
    });

    it("should name the ceiling in the refusal, so she can say why rather than shrug", async () => {
      guard.recordSpend(300);

      await expect(broker().startSession()).rejects.toSatisfy(
        (error: unknown) => error instanceof FaceCostCeilingError && error.ceiling === 300,
      );
    });

    it("should refuse to open a face on a cold lane, and spend nothing doing it", async () => {
      // A cold spawn is ~7,450ms and the provider's tool ceiling is 8 seconds.
      // Opening a face she cannot answer on is paying to be silent.
      await expect(broker({ isLaneWarm: () => false }).startSession()).rejects.toBeInstanceOf(
        FaceColdLaneError,
      );
      expect(runway.createCalls).toHaveLength(0);
      expect(guard.spentToday()).toBe(0);
    });

    it("should check the lane before the ceiling, since neither costs anything", async () => {
      guard.recordSpend(300);

      await expect(broker({ isLaneWarm: () => false }).startSession()).rejects.toBeInstanceOf(
        FaceColdLaneError,
      );
    });

    it("should open normally when no lane predicate was supplied", async () => {
      const opened = await new FaceSessionBroker({
        client: runway,
        guard,
        sessions,
        avatarId: AVATAR,
        now: clock,
        sleep: () => Promise.resolve(),
        pollIntervalMs: 10,
        timeoutMs: 100,
      }).startSession();

      expect(opened.credentials.sessionId).toBe("rts_1");
    });
  });

  /**
   * `syl-chzl.2.3` — the gate above is correct and, on its own, answers a
   * question nobody had to lose.
   *
   * The lane goes cold after fifteen idle minutes and there is no free pre-warm:
   * measured 2026-08-22, the CLI emits nothing until a user frame arrives, so a
   * lane becomes warm only by taking a turn. The ordinary failure is therefore
   * not exotic — he does not talk to her for a quarter of an hour, long-presses
   * her face, and gets the refusal. So the open takes one cheap turn first.
   */
  describe("warming the lane at the moment a face opens", () => {
    /** A warmer that records that it ran and reports the lane warm afterwards. */
    function warmer(): { calls: number; warm: boolean; run: () => Promise<string> } {
      const state = {
        calls: 0,
        warm: false,
        run: (): Promise<string> => {
          state.calls += 1;
          state.warm = true;
          return Promise.resolve("warmed");
        },
      };
      return state;
    }

    it("should warm a cold lane and then open, rather than refusing him", async () => {
      const warm = warmer();

      const opened = await broker({
        isLaneWarm: () => warm.warm,
        warmLane: warm.run,
      }).startSession();

      expect(warm.calls).toBe(1);
      expect(opened.credentials.sessionId).toBe("rts_1");
    });

    it("should warm before anything is created or charged", async () => {
      // Ordering is the entire feature, and it runs both ways. A warmer called
      // after the gate warms a lane for a session already refused; a warmer
      // called after the create pays Runway before finding out she can speak.
      const warm = warmer();
      const order: string[] = [];
      runway.createRealtimeSession = (input): Promise<RealtimeSessionRow> => {
        order.push("create");
        runway.createCalls.push(input);
        return Promise.resolve({ id: "rts_1", status: "PENDING" });
      };

      await broker({
        isLaneWarm: () => warm.warm,
        warmLane: () => {
          order.push("warm");
          return warm.run();
        },
      }).startSession();

      expect(order).toEqual(["warm", "create"]);
      expect(guard.spentToday()).toBeGreaterThan(0);
    });

    it("should still refuse when the warm-up could not make the lane warm", async () => {
      // The gate is not weakened, only better informed. A warm-up that failed
      // leaves a lane that cannot answer inside the ceiling, and opening a face
      // on it is paying about $0.20 a minute to be silent.
      await expect(
        broker({ isLaneWarm: () => false, warmLane: () => Promise.resolve("failed") }).startSession(),
      ).rejects.toBeInstanceOf(FaceColdLaneError);
      expect(runway.createCalls).toHaveLength(0);
      expect(guard.spentToday()).toBe(0);
    });

    it("should not fail the open when the warm-up itself rejects", async () => {
      // A preparation that can fail an open is not a preparation. The gate
      // below decides; a thrown warm-up would turn a decidable question into a
      // 500 on his phone.
      const opened = await broker({
        isLaneWarm: () => true,
        warmLane: () => Promise.reject(new Error("claude exited with code 1")),
      }).startSession();

      expect(opened.credentials.sessionId).toBe("rts_1");
    });

    it("should spend no turn on a lane that is already warm", async () => {
      const warm = warmer();
      warm.warm = true;

      await broker({ isLaneWarm: () => warm.warm, warmLane: warm.run }).startSession();

      expect(warm.calls).toBe(0);
    });

    it("should spend no turn when today's ceiling has already refused the session", async () => {
      // A subscription turn burned to warm a lane for a face that cannot open.
      guard.recordSpend(300);
      const warm = warmer();

      await expect(
        broker({ isLaneWarm: () => warm.warm, warmLane: warm.run }).startSession(),
      ).rejects.toBeInstanceOf(FaceColdLaneError);
      expect(warm.calls).toBe(0);
    });

    it("should leave a broker with no warmer exactly as it was", async () => {
      // Every suite that injects its own runner is this caller: there is no
      // warm process for anything to be warm about, and the absence of both
      // seams has to keep meaning "do not check".
      const opened = await new FaceSessionBroker({
        client: runway,
        guard,
        sessions,
        avatarId: AVATAR,
        now: clock,
        sleep: () => Promise.resolve(),
        pollIntervalMs: 10,
        timeoutMs: 100,
      }).startSession();

      expect(opened.credentials.sessionId).toBe("rts_1");
    });
  });

  describe("a session that was charged for and never worked", () => {
    it("should still record the upfront spend when READY never arrives", async () => {
      runway.statuses = [{ id: "rts_1", status: "PENDING" }];

      await expect(broker().startSession()).rejects.toBeInstanceOf(FaceSessionFailedError);

      // Runway charged at create. The ledger says so, even though nothing worked.
      expect(guard.spentToday()).toBe(2);
      expect(sessions.get("rts_1")?.credits).toBe(2);
    });

    it("should settle the row as failed rather than leaving it open forever", async () => {
      runway.statuses = [{ id: "rts_1", status: "PENDING" }];

      await expect(broker().startSession()).rejects.toThrow();

      expect(sessions.get("rts_1")?.ended).toBe("failed");
      expect(sessions.live()).toHaveLength(0);
    });

    it("should stop early and settle when the provider says the session FAILED", async () => {
      runway.statuses = [{ id: "rts_1", status: "FAILED" }];

      await expect(broker().startSession()).rejects.toBeInstanceOf(FaceSessionFailedError);

      expect(sessions.get("rts_1")?.ended).toBe("failed");
      expect(guard.spentToday()).toBe(2);
    });

    it("should charge nothing and record nothing when the create call itself fails", async () => {
      runway.createError = new Error("Runway session create failed (HTTP 502)");

      await expect(broker().startSession()).rejects.toThrow(/502/);

      expect(guard.spentToday()).toBe(0);
      expect(sessions.live()).toHaveLength(0);
    });

    it("should survive a transient poll failure rather than treating it as a dead session", async () => {
      const flaky = new FakeRunway();
      flaky.statuses = [READY];
      let firstPoll = true;
      flaky.getRealtimeSession = (id: string): Promise<RealtimeSessionRow> => {
        if (firstPoll) {
          firstPoll = false;
          return Promise.reject(new Error("ECONNRESET"));
        }
        return Promise.resolve({ ...READY, id });
      };

      const opened = await broker({ client: flaky }).startSession();

      expect(opened.credentials.sessionKey).toBe("stk_shortlived");
    });
  });

  describe("renewing", () => {
    it("should charge again, because a realtime session cannot be extended", async () => {
      const subject = broker();
      await subject.startSession();
      runway.createResult = { id: "rts_2", status: "PENDING" };
      runway.statuses = [{ ...READY, id: "rts_2" }];

      const renewed = await subject.renewSession();

      expect(renewed.credentials.sessionId).toBe("rts_2");
      expect(guard.spentToday()).toBe(4);
      expect(sessions.live()).toHaveLength(2);
    });

    it("should mint a NEW credential for the new session, not carry the old one over", async () => {
      const subject = broker();
      const first = await subject.startSession();
      runway.createResult = { id: "rts_2", status: "PENDING" };
      runway.statuses = [{ ...READY, id: "rts_2" }];

      const second = await subject.renewSession();

      expect(second.askSecret).not.toBe(first.askSecret);
      expect(
        verifyAskCredential({ sessions, sessionId: "rts_2", secret: first.askSecret, now }).ok,
      ).toBe(false);
    });
  });

  describe("expiry awareness", () => {
    it("should report the time left before the provider's session cap", () => {
      expect(broker().msUntilExpiry({ expiresAt: "2026-08-21T12:05:00.000Z" })).toBe(300_000);
    });

    it("should call a session inside the renew lead expiring", () => {
      const subject = broker({ renewLeadMs: 30_000 });

      expect(subject.isExpiring({ expiresAt: "2026-08-21T12:00:31.000Z" })).toBe(false);
      expect(subject.isExpiring({ expiresAt: "2026-08-21T12:00:29.000Z" })).toBe(true);
    });

    it("should treat an unknown expiry as not expiring rather than guessing", () => {
      expect(broker().isExpiring({})).toBe(false);
      expect(broker().msUntilExpiry({ expiresAt: "not a date" })).toBeUndefined();
    });
  });

  describe("end-of-session accounting", () => {
    it("should charge the streaming portion and never the upfront twice", async () => {
      await broker().startSession();
      now += 60_000;

      broker().recordSessionEnd("rts_1", "closed");

      // A minute is 2 upfront + 20 streaming. The upfront was charged at open.
      expect(guard.spentToday()).toBe(22);
      expect(sessions.get("rts_1")?.credits).toBe(22);
    });

    it("should write the whole-session total to the ledger, not the delta", async () => {
      await broker().startSession();
      now += 60_000;

      broker().recordSessionEnd("rts_1", "closed");

      expect(sessions.get("rts_1")?.dollars).toBeCloseTo(0.22, 10);
    });

    it("should be idempotent: settling twice does not charge twice", async () => {
      const subject = broker();
      await subject.startSession();
      now += 60_000;

      subject.recordSessionEnd("rts_1", "closed");
      subject.recordSessionEnd("rts_1", "reaped");

      expect(guard.spentToday()).toBe(22);
      expect(sessions.get("rts_1")?.ended).toBe("closed");
    });

    it("should say whether this call was the one that settled the session", async () => {
      const subject = broker();
      await subject.startSession();

      expect(subject.recordSessionEnd("rts_1", "closed").settled).toBe(true);
      expect(subject.recordSessionEnd("rts_1", "closed").settled).toBe(false);
    });

    it("should meter a live session without settling it", async () => {
      await broker().startSession();
      now += 30_000;

      const meter = broker().meterSession(sessions.get("rts_1")!);

      expect(meter.credits).toBe(12);
      expect(sessions.get("rts_1")?.closedAt).toBeNull();
    });
  });

  describe("recovering after a restart", () => {
    it("should seed the guard from the ledger, so a crash does not reset the ceiling", async () => {
      await broker().startSession();
      now += 60_000;
      broker().recordSessionEnd("rts_1", "closed");

      // The restart: a brand-new guard, which knows nothing.
      const freshGuard = new FaceCostGuard({ dailyCreditCeiling: 300, now: clock });
      expect(freshGuard.spentToday()).toBe(0);

      broker({ guard: freshGuard }).seedFromLedger();

      expect(freshGuard.spentToday()).toBe(22);
    });

    it("should report sessions left open by a dead process", async () => {
      await broker().startSession();

      expect(broker().liveSessions().map((session) => session.id)).toEqual(["rts_1"]);
    });
  });

  describe("the idle question, delegated to the guard", () => {
    it("should say a quiet session must be disconnected once past the timeout", async () => {
      const idleGuard = new FaceCostGuard({ idleTimeoutMs: 10_000, now: clock });
      const subject = broker({ guard: idleGuard });
      await subject.startSession();

      expect(subject.shouldDisconnectIdle(sessions.get("rts_1")!)).toBe(false);
      now += 10_000;
      expect(subject.shouldDisconnectIdle(sessions.get("rts_1")!)).toBe(true);
    });
  });

  describe("the client is built lazily", () => {
    it("should not need the secret to answer a question about time or idleness", () => {
      const withoutSecret = new FaceSessionBroker({
        guard,
        sessions,
        avatarId: AVATAR,
        now: clock,
        clientOptions: { apiKey: "" },
      });

      // Constructing a real RunwayClient with no secret throws. A broker used
      // purely for arithmetic must never reach for one.
      expect(() => withoutSecret.isExpiring({})).not.toThrow();
      expect(withoutSecret.msUntilExpiry({})).toBeUndefined();
    });

    it("should fail loudly the moment it actually needs the secret", async () => {
      const withoutSecret = new FaceSessionBroker({
        guard,
        sessions,
        avatarId: AVATAR,
        now: clock,
        clientOptions: { apiKey: "" },
      });

      await expect(withoutSecret.startSession()).rejects.toThrow(/RUNWAYML_API_SECRET/);
    });
  });

  describe("disconnecting", () => {
    it("should hand back LiveKit join credentials for an existing session", async () => {
      await broker().startSession();

      const creds = await broker().connectBackend("rts_1");

      expect(creds.roomName).toBe("room-1");
      expect(runway.connectCalls).toEqual(["rts_1"]);
    });

    it("should not create a second session when joining an existing one", async () => {
      await broker().startSession();
      runway.createCalls = [];

      await broker().connectBackend("rts_1");

      expect(runway.createCalls).toHaveLength(0);
    });
  });

  describe("configuration", () => {
    it("should refuse to open a face with no avatar configured", async () => {
      await expect(broker({ avatarId: "" }).startSession()).rejects.toThrow(/avatar/i);
      expect(runway.createCalls).toHaveLength(0);
    });

    it("should never declare a tool above the provider's eight-second ceiling", async () => {
      await broker().startSession();

      for (const tool of runway.createCalls[0]?.tools ?? []) {
        expect(tool.timeoutSeconds).toBeLessThanOrEqual(8);
        expect(tool.parameters.length).toBeLessThanOrEqual(20);
      }
    });
  });

  describe("what gets logged", () => {
    it("should log an opened session with its id and what it cost up front", async () => {
      const log = vi.fn();

      await broker({ log }).startSession();

      expect(log).toHaveBeenCalledWith(
        "face.session.opened",
        expect.objectContaining({ sessionId: "rts_1", credits: 2 }),
      );
    });

    it("should never log the credential it just minted", async () => {
      const log = vi.fn();

      const opened = await broker({ log }).startSession();

      expect(JSON.stringify(log.mock.calls)).not.toContain(opened.askSecret);
    });
  });
});
