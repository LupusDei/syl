import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepliesSeen, type InboundReply } from "../../src/agents/replies-seen.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { testDatabase, TEST_NOW } from "../helpers/service.js";

/**
 * The record of which answers Syl has already been shown.
 *
 * A poller asks Adjutant "what has been said to me" and gets back everything,
 * every time. Without this, the second poll re-delivers the first poll's
 * answers, and the Commander's phone buzzes again with the treasurer telling
 * him what his insurance costs. So the interesting property is not "it stores
 * rows" — it is **exactly once**, across a restart, and with nothing lost.
 */

let db: SylDatabase;
let seen: RepliesSeen;

beforeEach(() => {
  db = testDatabase();
  seen = new RepliesSeen({ db: db.handle, clock: fixedClock(TEST_NOW) });
});

afterEach(() => {
  db.close();
});

const reply = (over: Partial<InboundReply> = {}): InboundReply => ({
  messageId: "msg-1",
  from: "treasurer",
  at: "2026-08-11T00:20:00.000Z",
  ...over,
});

describe("RepliesSeen.unseen", () => {
  it("should return an answer nobody has recorded yet", () => {
    expect(seen.unseen([reply()])).toEqual([reply()]);
  });

  it("should drop an answer already recorded, so it is delivered once", () => {
    seen.record([reply()]);

    expect(seen.unseen([reply()])).toEqual([]);
  });

  it("should keep the ones that are new when only some of a batch were recorded", () => {
    // The ordinary steady state: one poll's worth of answers, of which most
    // were on the previous poll.
    seen.record([reply({ messageId: "msg-1" })]);

    const batch = [
      reply({ messageId: "msg-1" }),
      reply({ messageId: "msg-2" }),
      reply({ messageId: "msg-3", from: "raynor" }),
    ];

    expect(seen.unseen(batch).map((r) => r.messageId)).toEqual(["msg-2", "msg-3"]);
  });

  it("should hand back the batch in the order it was given", () => {
    // The caller fences these in order and she reads them in order. Reordering
    // here would put a later answer above an earlier one for no reason the
    // caller could see.
    const batch = [
      reply({ messageId: "b", at: "2026-08-11T00:30:00.000Z" }),
      reply({ messageId: "a", at: "2026-08-11T00:10:00.000Z" }),
    ];

    expect(seen.unseen(batch).map((r) => r.messageId)).toEqual(["b", "a"]);
  });

  it("should not deliver an answer that arrives out of order, and must not skip it either", () => {
    // **The reason this is a ledger and not a high-water mark.**
    //
    // A watermark on the newest instant delivers exactly once only while
    // messages arrive in time order. They do not have to: two agents write
    // concurrently, one of them retries, and an answer stamped 00:10 shows up
    // after one stamped 00:30. A watermark silently swallows it — CLAUDE.md
    // constraint 4 wearing different clothes, because a vanished answer is a
    // vanished reminder.
    seen.record([reply({ messageId: "late-newer", at: "2026-08-11T00:30:00.000Z" })]);

    const older = reply({ messageId: "early-older", at: "2026-08-11T00:10:00.000Z" });

    expect(seen.unseen([older])).toEqual([older]);
  });

  it("should return nothing for an empty batch without touching the database", () => {
    expect(seen.unseen([])).toEqual([]);
  });
});

describe("RepliesSeen.record", () => {
  it("should record the same answer twice without failing", () => {
    // A crash between delivering and recording re-delivers, which is a
    // nuisance. A crash that leaves the second record throwing would wedge the
    // poller, which is not.
    seen.record([reply()]);

    expect(() => seen.record([reply()])).not.toThrow();
    expect(seen.unseen([reply()])).toEqual([]);
  });

  it("should report how many of a batch it had not already recorded", () => {
    seen.record([reply({ messageId: "msg-1" })]);

    expect(seen.record([reply({ messageId: "msg-1" }), reply({ messageId: "msg-2" })])).toBe(1);
  });

  it("should record a whole batch or none of it", () => {
    // One malformed row in a poll must not leave half the batch recorded and
    // the other half about to be re-delivered.
    expect(() => seen.record([reply({ messageId: "ok" }), reply({ messageId: "" })])).toThrow();

    expect(seen.unseen([reply({ messageId: "ok" })]).map((r) => r.messageId)).toEqual(["ok"]);
  });

  it("should refuse an answer from nobody", () => {
    expect(() => seen.record([reply({ from: "" })])).toThrow();
  });

  it("should survive the process it was written by", () => {
    // The whole point of putting this in SQLite rather than in a Set: a restart
    // between two polls must not re-deliver everything the fleet has ever said.
    seen.record([reply()]);

    const afterRestart = new RepliesSeen({ db: db.handle, clock: fixedClock(TEST_NOW) });

    expect(afterRestart.unseen([reply()])).toEqual([]);
  });
});

describe("RepliesSeen.lastFrom", () => {
  it("should name the most recent answer from one agent", () => {
    seen.record([
      reply({ messageId: "old", at: "2026-08-11T00:10:00.000Z" }),
      reply({ messageId: "new", at: "2026-08-11T00:30:00.000Z" }),
    ]);

    expect(seen.lastFrom("treasurer")?.messageId).toBe("new");
  });

  it("should be per agent, so one talkative agent does not hide another", () => {
    seen.record([
      reply({ messageId: "t", from: "treasurer", at: "2026-08-11T00:30:00.000Z" }),
      reply({ messageId: "r", from: "raynor", at: "2026-08-11T00:10:00.000Z" }),
    ]);

    expect(seen.lastFrom("raynor")?.messageId).toBe("r");
  });

  it("should say nothing rather than guess for an agent that has never answered", () => {
    expect(seen.lastFrom("treasurer")).toBeNull();
  });

  it("should break a tie on the id, so two answers stamped the same instant give one answer", () => {
    // Two agents writing in the same millisecond is not exotic, and "the last
    // one" has to mean something rather than depending on page order.
    seen.record([
      reply({ messageId: "a", at: "2026-08-11T00:30:00.000Z" }),
      reply({ messageId: "b", at: "2026-08-11T00:30:00.000Z" }),
    ]);

    expect(seen.lastFrom("treasurer")?.messageId).toBe("b");
  });

  it("should record when Syl saw it, which is not when it was said", () => {
    // The two differ by however long the poller took to come round, and only
    // one of them answers "why did he hear about this an hour late?".
    seen.record([reply({ at: "2026-08-11T00:20:00.000Z" })]);

    const record = seen.lastFrom("treasurer");

    expect(record?.at).toBe("2026-08-11T00:20:00.000Z");
    expect(record?.seenAt).toBe(new Date(TEST_NOW).toISOString());
  });
});
