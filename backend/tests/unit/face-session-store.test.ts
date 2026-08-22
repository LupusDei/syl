import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FaceSessionStore, FaceSessionError } from "../../src/face/face-session-store.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * The ledger behind "how much did that cost", and behind a ceiling that
 * survives a restart.
 *
 * The daily ceiling is meaningless if a crash at noon hands the afternoon a
 * fresh budget, so the total has to live on disk. And a session that ended has
 * to say HOW it ended: a face the reaper cut and a face he closed himself are
 * the same row with the same spend, and only one of them is evidence that the
 * idle auto-disconnect is working.
 */
describe("FaceSessionStore", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let now: number;
  const clock: Clock = () => now;

  const AVATAR = "48cbc73d-f47f-41de-bed8-58a532b3b84b";

  beforeEach(() => {
    now = Date.parse("2026-08-21T12:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    sessions = new FaceSessionStore({ db: database.handle, clock });
  });

  afterEach(() => {
    database.close();
  });

  function open(id = "rts_one", credits = 2, dollars = 0.02) {
    return sessions.open({
      id,
      avatarId: AVATAR,
      credits,
      dollars,
      askSecretHash: `hash-of-${id}`,
      askExpiresAt: now + 300_000,
    });
  }

  describe("opening", () => {
    it("should round-trip a session", () => {
      const opened = open();

      expect(opened.id).toBe("rts_one");
      expect(opened.avatarId).toBe(AVATAR);
      expect(opened.openedAt).toBe("2026-08-21T12:00:00.000Z");
      expect(opened.closedAt).toBeNull();
      expect(opened.ended).toBeNull();
      expect(opened.credits).toBe(2);
      expect(opened.dollars).toBeCloseTo(0.02, 10);
      expect(opened.lastActivityAt).toBe("2026-08-21T12:00:00.000Z");
      expect(sessions.get("rts_one")).toEqual(opened);
    });

    it("should record the upfront credits at open, before the session is known to work", () => {
      // Runway charges the moment a session is created. A row that waits for
      // READY to record them under-reports every session that never readies.
      expect(open("rts_never_ready").credits).toBe(2);
    });

    it("should refuse a second row for one provider session id", () => {
      open("rts_one");

      expect(() => open("rts_one")).toThrow(FaceSessionError);
    });

    it("should refuse a blank id rather than storing an unaddressable session", () => {
      expect(() =>
        sessions.open({
          id: "   ",
          avatarId: AVATAR,
          credits: 2,
          dollars: 0.02,
          askSecretHash: "hash",
          askExpiresAt: now,
        }),
      ).toThrow(FaceSessionError);
    });

    it("should refuse a blank ask credential hash: a session with no credential is a hole", () => {
      expect(() =>
        sessions.open({
          id: "rts_two",
          avatarId: AVATAR,
          credits: 2,
          dollars: 0.02,
          askSecretHash: "",
          askExpiresAt: now,
        }),
      ).toThrow(FaceSessionError);
    });
  });

  describe("the day's total", () => {
    it("should sum credits across every session opened that day", () => {
      open("rts_one", 2, 0.02);
      now += 60_000;
      open("rts_two", 22, 0.22);
      now += 60_000;
      open("rts_three", 6, 0.06);

      expect(sessions.creditsOnDayOf(now)).toBe(30);
    });

    it("should include the settled streaming spend, not only the upfront", () => {
      open("rts_one", 2, 0.02);
      now += 60_000;
      sessions.settle({ id: "rts_one", ended: "closed", credits: 22, dollars: 0.22 });

      expect(sessions.creditsOnDayOf(now)).toBe(22);
    });

    it("should not carry yesterday's spend into today", () => {
      open("rts_yesterday", 100, 1);
      const yesterday = now;
      now += 24 * 60 * 60 * 1_000;
      open("rts_today", 4, 0.04);

      expect(sessions.creditsOnDayOf(yesterday)).toBe(100);
      expect(sessions.creditsOnDayOf(now)).toBe(4);
    });

    it("should report zero for a day with no sessions rather than throwing", () => {
      expect(sessions.creditsOnDayOf(now)).toBe(0);
    });
  });

  describe("settling", () => {
    it("should distinguish a session the reaper cut from one he closed", () => {
      open("rts_closed");
      open("rts_reaped");
      now += 120_000;

      sessions.settle({ id: "rts_closed", ended: "closed", credits: 42, dollars: 0.42 });
      sessions.settle({ id: "rts_reaped", ended: "reaped", credits: 42, dollars: 0.42 });

      expect(sessions.get("rts_closed")?.ended).toBe("closed");
      expect(sessions.get("rts_reaped")?.ended).toBe("reaped");
    });

    it("should record every end state the lifecycle can produce", () => {
      for (const ended of ["closed", "reaped", "expired", "failed"] as const) {
        open(`rts_${ended}`);
        sessions.settle({ id: `rts_${ended}`, ended, credits: 2, dollars: 0.02 });
        expect(sessions.get(`rts_${ended}`)?.ended).toBe(ended);
      }
    });

    it("should stamp closedAt from the clock", () => {
      open();
      now += 90_000;
      const settled = sessions.settle({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 });

      expect(settled.closedAt).toBe("2026-08-21T12:01:30.000Z");
    });

    it("should be idempotent: a second settle changes nothing and does not throw", () => {
      open();
      now += 90_000;
      const first = sessions.settle({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 });

      now += 600_000;
      const second = sessions.settle({
        id: "rts_one",
        ended: "reaped",
        credits: 9_999,
        dollars: 99.99,
      });

      expect(second).toEqual(first);
      expect(sessions.get("rts_one")?.credits).toBe(4);
    });

    it("should say whether a settle was the one that actually settled the row", () => {
      open();

      expect(sessions.settleOnce({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 }).settled).toBe(
        true,
      );
      expect(sessions.settleOnce({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 }).settled).toBe(
        false,
      );
    });

    it("should refuse to settle a session it has never heard of", () => {
      expect(() =>
        sessions.settle({ id: "rts_nobody", ended: "closed", credits: 2, dollars: 0.02 }),
      ).toThrow(FaceSessionError);
    });
  });

  describe("what is still open", () => {
    it("should make an unclosed session from a previous process visible and countable", () => {
      open("rts_orphan", 2, 0.02);

      // A new store over the same database — the restart.
      const afterRestart = new FaceSessionStore({ db: database.handle, clock });

      const live = afterRestart.live();
      expect(live).toHaveLength(1);
      expect(live[0]?.id).toBe("rts_orphan");
      expect(afterRestart.creditsOnDayOf(now)).toBe(2);
    });

    it("should list live sessions oldest first, so the longest leak is dealt with first", () => {
      open("rts_first");
      now += 1_000;
      open("rts_second");
      now += 1_000;
      open("rts_third");

      expect(sessions.live().map((session) => session.id)).toEqual([
        "rts_first",
        "rts_second",
        "rts_third",
      ]);
    });

    it("should drop a settled session out of the live list", () => {
      open("rts_one");
      open("rts_two");
      sessions.settle({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 });

      expect(sessions.live().map((session) => session.id)).toEqual(["rts_two"]);
    });
  });

  describe("activity", () => {
    it("should move lastActivityAt forward so the reaper can see a session is alive", () => {
      open();
      now += 45_000;
      sessions.touch("rts_one");

      expect(sessions.get("rts_one")?.lastActivityAt).toBe("2026-08-21T12:00:45.000Z");
    });

    it("should not resurrect a settled session by touching it", () => {
      open();
      sessions.settle({ id: "rts_one", ended: "reaped", credits: 4, dollars: 0.04 });
      now += 45_000;
      sessions.touch("rts_one");

      expect(sessions.get("rts_one")?.lastActivityAt).toBe("2026-08-21T12:00:00.000Z");
      expect(sessions.live()).toHaveLength(0);
    });

    it("should ignore a touch for a session it has never heard of", () => {
      expect(() => sessions.touch("rts_nobody")).not.toThrow();
    });
  });

  describe("the per-session ask credential", () => {
    it("should keep the hash and the expiry on the session row, so it dies with the session", () => {
      const opened = open();

      expect(opened.askSecretHash).toBe("hash-of-rts_one");
      expect(opened.askExpiresAt).toBe("2026-08-21T12:05:00.000Z");
    });

    it("should adopt the provider's real cap once the session reports one", () => {
      open();

      sessions.adoptProviderExpiry("rts_one", now + 600_000);

      expect(sessions.get("rts_one")?.askExpiresAt).toBe("2026-08-21T12:10:00.000Z");
    });

    it("should refuse to move the expiry of a session that has already ended", () => {
      open();
      sessions.settle({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 });

      sessions.adoptProviderExpiry("rts_one", now + 600_000);

      expect(sessions.get("rts_one")?.askExpiresAt).toBe("2026-08-21T12:05:00.000Z");
    });

    it("should never expose the hash through the shape handed to a client", () => {
      const opened = open();

      // A structural assertion: whatever the row carries, the credential
      // material is not in the public view of it.
      expect(JSON.stringify(sessions.publicView(opened))).not.toContain("hash-of-rts_one");
    });
  });
});
