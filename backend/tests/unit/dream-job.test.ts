import type { Job, Run } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNightlyDreamHandler,
  createYieldSignal,
  defineNightlyDreamJob,
  describeDream,
  dreamWallTime,
  ensureNightlyDreamJob,
  quietWindowMs,
  YIELD_GRACE_MS,
  type NightDreamer,
} from "../../src/jobs/dream-job.js";
import { DreamLog, nightOf, type DreamSessionOutcome } from "../../src/memory/dream/log.js";
import type { JudgeReport } from "../../src/memory/dream/judge.js";
import { fixedClock, instant } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import type { JobContext } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The clock that finally calls `DreamJudge.dream` (`syl-cbb`).
 *
 * Nothing here spawns a subprocess. `DreamJudge`'s own end-to-end behaviour is
 * covered against a fake CLI in `memory-dream-judge.test.ts`; what is left —
 * and what no test of the judge can see — is *when* it is called, *which* night
 * it is handed, what happens to one that dies, and what makes it stop when the
 * Commander starts talking.
 */

/** The Commander's window, and a zone that is a place and not an offset. */
const TZ = "America/Chicago";
const QUIET = { start: "23:00", end: "08:00" } as const;

/** 03:00 in Chicago on a summer night — deep inside the window. */
const AT_0300 = Date.parse("2026-08-10T08:00:00.000Z");
/** 07:55 in Chicago — inside the window, but five minutes from its end. */
const AT_0755 = Date.parse("2026-08-10T12:55:00.000Z");

let db: Database;
let log: DreamLog;
let jobs: JobStore;

function openMigrated(): Database {
  const handle = new DatabaseSync(IN_MEMORY, { allowExtension: true });
  applyPragmas(handle, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(handle, readMigrations(MIGRATIONS_DIR));
  return handle;
}

beforeEach(() => {
  db = openMigrated();
  log = new DreamLog({ db, clock: fixedClock(AT_0300) });
  jobs = new JobStore({ db, clock: fixedClock(AT_0300) });
});

afterEach(() => {
  db.close();
});

/** Only `now` is read by the handler; the rest is the runner's business. */
function contextAt(now: number): JobContext {
  return {
    job: {} as Job,
    run: {} as Run,
    triggerInstant: instant(now),
    late: false,
    now,
  };
}

function report(overrides: Partial<JudgeReport> = {}): JudgeReport {
  return {
    sessionId: "unset",
    outcome: "completed",
    turns: 3,
    judged: 12,
    created: 2,
    reactivated: 1,
    suppressed: 0,
    rejected: 1,
    surfaced: 0,
    ...overrides,
  };
}

/** A judge that records what it was asked for and answers immediately. */
function fakeJudge(answers: {
  readonly dream?: (input: { night: string; tz: string }) => Promise<JudgeReport>;
  readonly resumeNight?: (sessionId: string) => Promise<JudgeReport>;
}): NightDreamer & {
  readonly dreamt: { night: string; tz: string }[];
  readonly resumed: string[];
} {
  const dreamt: { night: string; tz: string }[] = [];
  const resumed: string[] = [];
  return {
    dreamt,
    resumed,
    dream: async (input) => {
      dreamt.push({ night: input.night, tz: input.tz });
      return answers.dream === undefined
        ? report()
        : await answers.dream({ night: input.night, tz: input.tz });
    },
    resumeNight: async (sessionId) => {
      resumed.push(sessionId);
      return answers.resumeNight === undefined
        ? report({ sessionId })
        : await answers.resumeNight(sessionId);
    },
  };
}

/** An open session from a night, for the resume paths. */
function openSession(night: string, outcome?: DreamSessionOutcome): string {
  const session = log.openSession({ night, tz: TZ, tokenCeiling: 1000, runId: null });
  if (outcome !== undefined) log.closeSession(session.id, { outcome });
  return session.id;
}

describe("dreamWallTime", () => {
  it("should prefer 03:00, which every plausible quiet window contains", () => {
    expect(dreamWallTime(QUIET)).toBe("03:00");
    expect(dreamWallTime({ start: "22:00", end: "08:00" })).toBe("03:00");
  });

  it("should fall back to the window start when the window does not contain 03:00", () => {
    // Otherwise `once_per_window` skips every occurrence and the dream is
    // scheduled forever and never runs.
    expect(dreamWallTime({ start: "13:00", end: "17:00" })).toBe("13:00");
  });

  it("should handle a window that does not wrap past midnight", () => {
    expect(dreamWallTime({ start: "01:00", end: "05:00" })).toBe("03:00");
  });
});

describe("quietWindowMs", () => {
  it("should measure a window that wraps past midnight", () => {
    expect(quietWindowMs(QUIET)).toBe(9 * 60 * 60_000);
  });

  it("should measure a window that does not wrap", () => {
    expect(quietWindowMs({ start: "01:00", end: "05:30" })).toBe(4.5 * 60 * 60_000);
  });

  it("should measure a window given in minutes as well as hours", () => {
    expect(quietWindowMs({ start: "23:30", end: "00:15" })).toBe(45 * 60_000);
  });
});

describe("defineNightlyDreamJob", () => {
  it("should carry a wall-clock trigger in the Commander's zone, never a fixed offset", () => {
    const job = defineNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET });

    expect(job.kind).toBe("nightly_consolidation");
    expect(job.trigger.type).toBe("wall_clock");
    expect(job.trigger.wallTime).toBe("03:00");
    expect(job.trigger.tz).toBe(TZ);
    expect(job.nextRunAt).not.toBeNull();
  });

  it("should be allowed to run only inside the quiet window", () => {
    const job = defineNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET });

    expect(job.catchUp.policy).toBe("once_per_window");
    expect(job.catchUp.windowStart).toBe(QUIET.start);
    expect(job.catchUp.windowEnd).toBe(QUIET.end);
  });

  it("should be background, resumable, silent and toolless", () => {
    const job = defineNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET });

    expect(job.priority).toBe("background");
    expect(job.deliveryClass).toBe("at_least_once_resumable");
    expect(job.speaks).toBe(false);
    expect(job.budget.allowedTools).toEqual([]);
  });
});

describe("ensureNightlyDreamJob", () => {
  it("should create the one row when there is none", () => {
    const job = ensureNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET }, AT_0300);

    expect(jobs.list({ kind: "nightly_consolidation", limit: 10 }).items).toHaveLength(1);
    expect(job.nextRunAt).not.toBeNull();
  });

  it("should return the existing row rather than defining a second on every boot", () => {
    const first = ensureNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET }, AT_0300);
    const second = ensureNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET }, AT_0300 + 86_400_000);

    expect(second.id).toBe(first.id);
    expect(jobs.list({ kind: "nightly_consolidation", limit: 10 }).items).toHaveLength(1);
  });

  it("should keep the existing row's schedule state, which a redefinition would throw away", () => {
    const first = ensureNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET }, AT_0300);
    jobs.release(first.id, "success", null, instant(AT_0300 + 600_000));

    const second = ensureNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET }, AT_0300);

    expect(second.nextRunAt).toBe(instant(AT_0300 + 600_000));
  });
});

describe("createYieldSignal", () => {
  it("should be false when nothing is pending and nothing has happened", () => {
    const shouldYield = createYieldSignal({
      conversations: { pending: 0, lastActiveAt: null },
      clock: fixedClock(AT_0300),
    });

    expect(shouldYield()).toBe(false);
  });

  it("should be true while a conversation has a turn running or queued", () => {
    const shouldYield = createYieldSignal({
      conversations: { pending: 1, lastActiveAt: null },
      clock: fixedClock(AT_0300),
    });

    expect(shouldYield()).toBe(true);
  });

  it("should stay true through the gap between his messages, not only during a turn", () => {
    const shouldYield = createYieldSignal({
      conversations: { pending: 0, lastActiveAt: AT_0300 - 60_000 },
      clock: fixedClock(AT_0300),
    });

    expect(shouldYield()).toBe(true);
  });

  it("should be false again once the grace window has passed", () => {
    const shouldYield = createYieldSignal({
      conversations: { pending: 0, lastActiveAt: AT_0300 - YIELD_GRACE_MS - 1 },
      clock: fixedClock(AT_0300),
    });

    expect(shouldYield()).toBe(false);
  });

  it("should honour a grace window a caller sets", () => {
    const conversations = { pending: 0, lastActiveAt: AT_0300 - 30_000 };

    expect(
      createYieldSignal({ conversations, clock: fixedClock(AT_0300), graceMs: 10_000 })(),
    ).toBe(false);
    expect(
      createYieldSignal({ conversations, clock: fixedClock(AT_0300), graceMs: 60_000 })(),
    ).toBe(true);
  });

  it("should end the night when the quiet gap closes, even with nobody talking", () => {
    // Not a nicety. `JobRunner` is concurrency-one and does not re-arm until
    // the pass in flight returns, so an unbounded six-hour night holds
    // `reminder_delivery` for six hours. See `syl-ncx`.
    const outside = createYieldSignal({
      conversations: { pending: 0, lastActiveAt: null },
      clock: fixedClock(Date.parse("2026-08-10T14:00:00.000Z")), // 09:00 Chicago
      window: { tz: TZ, quiet: QUIET },
    });

    expect(outside()).toBe(true);
  });

  it("should let the night run while the gap is still open", () => {
    const inside = createYieldSignal({
      conversations: { pending: 0, lastActiveAt: null },
      clock: fixedClock(AT_0300),
      window: { tz: TZ, quiet: QUIET },
    });

    expect(inside()).toBe(false);
  });

  it("should still yield to the Commander inside the window", () => {
    const talking = createYieldSignal({
      conversations: { pending: 1, lastActiveAt: AT_0300 },
      clock: fixedClock(AT_0300),
      window: { tz: TZ, quiet: QUIET },
    });

    expect(talking()).toBe(true);
  });

  it("should be unbounded when no window is given, which is what a unit test wants", () => {
    const unbounded = createYieldSignal({
      conversations: { pending: 0, lastActiveAt: null },
      clock: fixedClock(Date.parse("2026-08-10T14:00:00.000Z")),
    });

    expect(unbounded()).toBe(false);
  });
});

describe("createNightlyDreamHandler", () => {
  it("should dream tonight's night, in the Commander's zone", async () => {
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({
      log,
      tz: TZ,
      quiet: QUIET,
      judge: () => judge,
    });

    const result = await handler(contextAt(AT_0300));

    expect(judge.dreamt).toEqual([{ night: nightOf(AT_0300, TZ), tz: TZ }]);
    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(false);
    expect(result.turns).toBe(3);
  });

  it("should label 03:00 as the night that began the evening before, not as a new one", async () => {
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    await handler(contextAt(AT_0300));

    // 03:00 local on the 10th belongs to the night of the 9th.
    expect(judge.dreamt[0]?.night).toBe("2026-08-09");
  });

  it("should resume a session left open for tonight rather than starting a second one", async () => {
    const sessionId = openSession(nightOf(AT_0300, TZ));
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    await handler(contextAt(AT_0300));

    expect(judge.resumed).toEqual([sessionId]);
    expect(judge.dreamt).toEqual([]);
  });

  it("should finish a night that died yesterday rather than losing it", async () => {
    const sessionId = openSession(nightOf(AT_0300 - 86_400_000, TZ));
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    await handler(contextAt(AT_0300));

    expect(judge.resumed).toEqual([sessionId]);
  });

  it("should abandon a session older than that, in the log, and dream tonight anyway", async () => {
    const stale = openSession("2026-07-01");
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    await handler(contextAt(AT_0300));

    const closed = log.session(stale);
    expect(closed?.outcome).toBe("abandoned");
    expect(closed?.endedAt).not.toBeNull();
    expect(closed?.error).toContain("2026-07-01");
    expect(judge.dreamt).toHaveLength(1);
    expect(judge.resumed).toEqual([]);
  });

  it("should come back inside the window after yielding to the Commander", async () => {
    const judge = fakeJudge({
      dream: async () => report({ outcome: "yielded" }),
    });
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0300));

    // Yielding is the feature working, not a failure. A failure here would
    // walk the circuit breaker open for correct behaviour.
    expect(result.outcome).toBe("success");
    expect(result.nextRunAt).toBe(instant(AT_0300 + 10 * 60_000));
  });

  it("should record a failed night as a failure, and try again tonight", async () => {
    const judge = fakeJudge({ dream: async () => report({ outcome: "failed" }) });
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0300));

    expect(result.outcome).toBe("failure");
    expect(result.nextRunAt).toBe(instant(AT_0300 + 15 * 60_000));
  });

  it("should carry a thrown dream out as a failed run, not as a thrown handler", async () => {
    const judge: NightDreamer = {
      dream: async () => {
        throw new Error("the sweep could not read the graph");
      },
      resumeNight: async () => report(),
    };
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0300));

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("the sweep could not read the graph");
    expect(result.nextRunAt).toBe(instant(AT_0300 + 15 * 60_000));
  });

  it("should never return a null nextRunAt, which would unschedule the dream forever", async () => {
    // 07:55 + 15 minutes is past the window's 08:00 end, so there is no retry
    // to give — and the field must be ABSENT rather than null, or `release`
    // writes NULL and the job leaves `due` permanently.
    const judge = fakeJudge({ dream: async () => report({ outcome: "failed" }) });
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0755));

    expect(result.outcome).toBe("failure");
    expect(result.nextRunAt).toBeUndefined();
    expect("nextRunAt" in result).toBe(false);
  });

  it("should report a failure when the searchable half of memory is unavailable", async () => {
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => null });

    const result = await handler(contextAt(AT_0300));

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("searchable half of memory");
    expect(result.turns).toBe(0);
    expect(result.nextRunAt).toBe(instant(AT_0300 + 15 * 60_000));
  });

  it("should try again tonight when a resume found no checkpoint to resume from", async () => {
    const sessionId = openSession(nightOf(AT_0300, TZ));
    const judge = fakeJudge({
      resumeNight: async (id) => report({ sessionId: id, outcome: "abandoned", turns: 0 }),
    });
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0300));

    expect(judge.resumed).toEqual([sessionId]);
    expect(result.outcome).toBe("success");
    expect(result.nextRunAt).toBe(instant(AT_0300 + 15 * 60_000));
  });

  it("should let a completed night fall back to its trigger's own next occurrence", async () => {
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0300));

    expect(result.nextRunAt).toBeUndefined();
  });

  it("should say what the night came to, on the run record", async () => {
    const judge = fakeJudge({});
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    const result = await handler(contextAt(AT_0300));

    expect(result.summary).toContain("judged 12");
    expect(result.summary).toContain("created 2");
  });

  it("should never speak, whatever the night found", async () => {
    const judge = fakeJudge({ dream: async () => report({ created: 40, surfaced: 9 }) });
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge: () => judge });

    expect((await handler(contextAt(AT_0300))).spoke).toBe(false);
  });

  it("should not build a judge at all before it has dealt with the stale sessions", async () => {
    // The judge factory loads a native extension. A machine with no vec0 must
    // still get its abandoned rows closed.
    const stale = openSession("2026-07-01");
    const judge = vi.fn(() => null);
    const handler = createNightlyDreamHandler({ log, tz: TZ, quiet: QUIET, judge });

    await handler(contextAt(AT_0300));

    expect(log.session(stale)?.outcome).toBe("abandoned");
  });
});

describe("describeDream", () => {
  it("should say when the dream will next run, and in which window", () => {
    const job = defineNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET });

    const lines = describeDream(job, { tz: TZ, quiet: QUIET });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("03:00");
    expect(lines[0]).toContain(TZ);
    expect(lines[0]).toContain("23:00-08:00");
  });

  it("should say so plainly when the job is unscheduled", () => {
    const job = defineNightlyDreamJob(jobs, { tz: TZ, quiet: QUIET });
    jobs.release(job.id, "success", null, null);

    const released = jobs.get(job.id);
    expect(describeDream(released as Job, { tz: TZ, quiet: QUIET })[0]).toContain("unscheduled");
  });
});
