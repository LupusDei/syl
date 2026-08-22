import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FaceCostGuard } from "../../src/face/face-cost-guard.js";
import { FaceSessionBroker } from "../../src/face/face-session-broker.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import { IdleReaper } from "../../src/face/idle-reaper.js";
import type {
  CreateRealtimeSessionInput,
  LiveKitConnectCreds,
  RealtimeSessionRow,
  RunwaySessionApi,
} from "../../src/face/runway-client.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * The auto-disconnect, which is not optional.
 *
 * An open session bills by the second whether or not anybody is there. A
 * forgotten one is a silent leak, and a silent leak is this project's
 * most-repeated defect shape. This file exists so that the reaper cannot be
 * folded into the broker and quietly dropped under schedule pressure — and so
 * that a reap which FAILS is loud rather than a session that vanishes from
 * tracking while still billing.
 */

/** Enough of Runway to open sessions. */
class FakeRunway implements RunwaySessionApi {
  nextId = 1;
  createRealtimeSession(_input: CreateRealtimeSessionInput): Promise<RealtimeSessionRow> {
    return Promise.resolve({ id: `rts_${String(this.nextId++)}`, status: "PENDING" });
  }
  getRealtimeSession(sessionId: string): Promise<RealtimeSessionRow> {
    return Promise.resolve({
      id: sessionId,
      status: "READY",
      sessionKey: "stk_x",
      expiresAt: new Date(Date.parse("2026-08-21T12:00:00.000Z") + 300_000).toISOString(),
    });
  }
  connectBackend(_sessionId: string): Promise<LiveKitConnectCreds> {
    return Promise.resolve({ url: "wss://x", token: "t", roomName: "r" });
  }
}

describe("IdleReaper", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let guard: FaceCostGuard;
  let broker: FaceSessionBroker;
  let now: number;
  const clock: Clock = () => now;

  const IDLE_TIMEOUT_MS = 120_000;

  beforeEach(() => {
    now = Date.parse("2026-08-21T12:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    sessions = new FaceSessionStore({ db: database.handle, clock });
    guard = new FaceCostGuard({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: clock });
    broker = new FaceSessionBroker({
      client: new FakeRunway(),
      guard,
      sessions,
      avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
      now: clock,
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      timeoutMs: 10,
      log: () => undefined,
    });
  });

  afterEach(() => {
    database.close();
  });

  function reaper(
    overrides: Partial<ConstructorParameters<typeof IdleReaper>[0]> = {},
  ): IdleReaper {
    return new IdleReaper({
      broker,
      sessions,
      disconnect: () => Promise.resolve(),
      now: clock,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      logError: () => undefined,
      ...overrides,
    });
  }

  describe("who gets reaped", () => {
    it("should reap a session that has been quiet past the timeout", async () => {
      const opened = await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      const report = await reaper().sweep();

      expect(report.reaped).toEqual([opened.credentials.sessionId]);
      expect(sessions.get(opened.credentials.sessionId)?.ended).toBe("reaped");
    });

    it("should leave an active session alone", async () => {
      const opened = await broker.startSession();
      now += IDLE_TIMEOUT_MS - 1;

      const report = await reaper().sweep();

      expect(report.reaped).toEqual([]);
      expect(sessions.get(opened.credentials.sessionId)?.closedAt).toBeNull();
    });

    it("should not reap a session that went quiet and then spoke again", async () => {
      const opened = await broker.startSession();

      // Almost idle, then he says something.
      now += IDLE_TIMEOUT_MS - 1_000;
      sessions.touch(opened.credentials.sessionId, now);

      // Time enough to have been reaped, had the touch not landed.
      now += 1_000;
      expect((await reaper().sweep()).reaped).toEqual([]);

      // And it IS reaped once the timeout passes from the LATEST activity.
      now += IDLE_TIMEOUT_MS;
      expect((await reaper().sweep()).reaped).toHaveLength(1);
    });

    it("should reap only the idle ones when several are open", async () => {
      const stale = await broker.startSession();
      now += IDLE_TIMEOUT_MS;
      const fresh = await broker.startSession();

      const report = await reaper().sweep();

      expect(report.reaped).toEqual([stale.credentials.sessionId]);
      expect(sessions.get(fresh.credentials.sessionId)?.closedAt).toBeNull();
    });

    it("should do nothing at all when nothing is open", async () => {
      const disconnect = vi.fn(() => Promise.resolve());

      const report = await reaper({ disconnect }).sweep();

      expect(report.reaped).toEqual([]);
      expect(disconnect).not.toHaveBeenCalled();
    });
  });

  describe("a session past the provider's cap", () => {
    it("should settle it as expired rather than as reaped", async () => {
      const opened = await broker.startSession();
      // The fake reports a five-minute cap; the idle timeout is two.
      now += 6 * 60 * 1_000;

      const report = await reaper().sweep();

      expect(report.expired).toEqual([opened.credentials.sessionId]);
      expect(sessions.get(opened.credentials.sessionId)?.ended).toBe("expired");
    });

    it("should NEVER treat a session with no reported cap as expired", async () => {
      // The inversion this guards against killed a healthy session seconds
      // after it opened, and would make anything renewing on the signal loop
      // at twenty cents a lap. A missing cap means "nothing to renew against".
      const capless = new FakeRunway();
      capless.getRealtimeSession = (id: string): Promise<RealtimeSessionRow> =>
        // READY, and deliberately silent about when it ends.
        Promise.resolve({ id, status: "READY", sessionKey: "stk_x" });
      const brokerWithoutCap = new FaceSessionBroker({
        client: capless,
        guard,
        sessions,
        avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
        now: clock,
        sleep: () => Promise.resolve(),
        pollIntervalMs: 1,
        timeoutMs: 10,
        log: () => undefined,
      });
      const opened = await brokerWithoutCap.startSession();
      expect(sessions.get(opened.credentials.sessionId)?.providerCapAt).toBeNull();

      // Far past any local floor, and past the provider cap the OTHER fake
      // reports — so a reaper reading the credential column would settle it.
      now += 60 * 60 * 1_000;
      const report = await reaper({ broker: brokerWithoutCap }).sweep();

      expect(report.expired).toEqual([]);
      // It is still cut, for idleness, which is the correct reason.
      expect(report.reaped).toEqual([opened.credentials.sessionId]);
      expect(sessions.get(opened.credentials.sessionId)?.ended).toBe("reaped");
    });

    it("should not double-count an expired session as reaped as well", async () => {
      await broker.startSession();
      now += 6 * 60 * 1_000;

      const report = await reaper().sweep();

      expect(report.reaped).toEqual([]);
    });
  });

  describe("the accounting", () => {
    it("should record the spend of a reaped session", async () => {
      await broker.startSession();
      expect(guard.spentToday()).toBe(2);

      now += IDLE_TIMEOUT_MS;
      await reaper().sweep();

      // Two minutes: 2 upfront + 20 blocks x 2 credits.
      expect(guard.spentToday()).toBe(42);
    });

    it("should write the whole-session total to the ledger", async () => {
      const opened = await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      await reaper().sweep();

      expect(sessions.get(opened.credentials.sessionId)?.credits).toBe(42);
    });

    it("should not charge again if the same session is swept twice", async () => {
      await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      await reaper().sweep();
      await reaper().sweep();

      expect(guard.spentToday()).toBe(42);
    });
  });

  describe("logging, because a session that disappears must not look like a crash", () => {
    it("should log every reap with the id, the idle duration and the spend", async () => {
      const log = vi.fn();
      const opened = await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      await reaper({ log }).sweep();

      expect(log).toHaveBeenCalledWith(
        "face.session.reaped",
        expect.objectContaining({
          sessionId: opened.credentials.sessionId,
          idleMs: IDLE_TIMEOUT_MS,
          credits: 42,
        }),
      );
    });

    it("should log the dollars too, so the leak is legible in money", async () => {
      const log = vi.fn();
      await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      await reaper({ log }).sweep();

      const fields = log.mock.calls.find(([event]) => event === "face.session.reaped")?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(fields?.["dollars"]).toBeCloseTo(0.42, 4);
    });
  });

  describe("when the disconnect fails", () => {
    it("should retry before giving up", async () => {
      const disconnect = vi
        .fn<(id: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("livekit unreachable"))
        .mockResolvedValueOnce(undefined);
      await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      const report = await reaper({ disconnect }).sweep();

      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(report.reaped).toHaveLength(1);
    });

    it("should escalate loudly rather than dropping the session from tracking", async () => {
      const disconnect = vi
        .fn<(id: string) => Promise<void>>()
        .mockRejectedValue(new Error("livekit unreachable"));
      const logError = vi.fn();
      const opened = await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      const report = await reaper({ disconnect, logError, retries: 2 }).sweep();

      expect(disconnect).toHaveBeenCalledTimes(3);
      expect(report.failed).toEqual([opened.credentials.sessionId]);
      expect(logError).toHaveBeenCalledWith(
        "face.session.reap_failed",
        expect.objectContaining({ sessionId: opened.credentials.sessionId, attempts: 3 }),
      );
    });

    it("should leave a session it could not disconnect OPEN, so the next sweep tries again", async () => {
      const disconnect = vi
        .fn<(id: string) => Promise<void>>()
        .mockRejectedValue(new Error("livekit unreachable"));
      const opened = await broker.startSession();
      now += IDLE_TIMEOUT_MS;

      await reaper({ disconnect, retries: 0 }).sweep();

      // NOT settled: an unreachable session still billing is exactly the
      // condition the reaper exists to prevent, and a row marked closed while
      // the stream runs on is that leak wearing the guard's uniform.
      expect(sessions.get(opened.credentials.sessionId)?.closedAt).toBeNull();
      expect(sessions.live()).toHaveLength(1);
    });

    it("should keep escalating on every sweep while a session cannot be cut", async () => {
      const disconnect = vi
        .fn<(id: string) => Promise<void>>()
        .mockRejectedValue(new Error("livekit unreachable"));
      const logError = vi.fn();
      await broker.startSession();
      now += IDLE_TIMEOUT_MS;
      const subject = reaper({ disconnect, logError, retries: 0 });

      await subject.sweep();
      await subject.sweep();

      const escalations = logError.mock.calls.filter(
        ([event]) => event === "face.session.reap_failed",
      );
      expect(escalations).toHaveLength(2);
      // The count rises, so a permanent failure looks different from a blip.
      expect((escalations[1]?.[1] as Record<string, unknown>)["consecutiveFailures"]).toBe(2);
    });

    it("should carry on to the next session rather than abandoning the sweep", async () => {
      const stuck = await broker.startSession();
      const reapable = await broker.startSession();
      now += IDLE_TIMEOUT_MS;
      const disconnect = vi.fn((id: string) =>
        id === stuck.credentials.sessionId
          ? Promise.reject(new Error("stuck"))
          : Promise.resolve(),
      );

      const report = await reaper({ disconnect, retries: 0 }).sweep();

      expect(report.failed).toEqual([stuck.credentials.sessionId]);
      expect(report.reaped).toEqual([reapable.credentials.sessionId]);
    });

    it("should not let a disconnect that throws synchronously escape the sweep", async () => {
      await broker.startSession();
      now += IDLE_TIMEOUT_MS;
      const disconnect = (): Promise<void> => {
        throw new Error("thrown, not rejected");
      };

      await expect(reaper({ disconnect, retries: 0 }).sweep()).resolves.toBeDefined();
    });
  });

  describe("the timer", () => {
    it("should sweep on the interval it was given, with no real time passing", async () => {
      vi.useFakeTimers();
      try {
        const disconnect = vi.fn(() => Promise.resolve());
        await broker.startSession();
        now += IDLE_TIMEOUT_MS;
        const subject = reaper({ disconnect, intervalMs: 30_000 });

        subject.start();
        await vi.advanceTimersByTimeAsync(30_000);
        subject.stop();

        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should stop sweeping once stopped", async () => {
      vi.useFakeTimers();
      try {
        const disconnect = vi.fn(() => Promise.resolve());
        const subject = reaper({ disconnect, intervalMs: 30_000 });

        subject.start();
        subject.stop();
        await broker.startSession();
        now += IDLE_TIMEOUT_MS;
        await vi.advanceTimersByTimeAsync(120_000);

        expect(disconnect).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should be safe to start twice without running two timers", async () => {
      vi.useFakeTimers();
      try {
        const disconnect = vi.fn(() => Promise.resolve());
        await broker.startSession();
        now += IDLE_TIMEOUT_MS;
        const subject = reaper({ disconnect, intervalMs: 30_000 });

        subject.start();
        subject.start();
        await vi.advanceTimersByTimeAsync(30_000);
        subject.stop();

        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should survive a sweep that rejects rather than killing the timer", async () => {
      vi.useFakeTimers();
      try {
        const logError = vi.fn();
        const subject = reaper({
          intervalMs: 10_000,
          logError,
          // A store that blows up mid-sweep.
          sessions: {
            live: () => {
              throw new Error("database is locked");
            },
            touch: () => undefined,
          } as unknown as FaceSessionStore,
        });

        subject.start();
        await vi.advanceTimersByTimeAsync(30_000);
        subject.stop();

        expect(logError).toHaveBeenCalledWith("face.reaper.sweep_failed", expect.anything());
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
