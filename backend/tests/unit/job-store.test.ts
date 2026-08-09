import type { JobTrigger } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SylDatabase } from "../../src/services/database.js";
import {
  BREAKER_THRESHOLD,
  JobStore,
  JobStoreError,
  nextRunAtFor,
  type DefineJob,
} from "../../src/services/job-store.js";
import { PagingError } from "../../src/services/paging.js";
import { testDatabase } from "../helpers/service.js";

const CHICAGO = "America/Chicago";
/** 2026-08-09T12:00Z — 07:00 in Chicago. */
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0, 0);

const REMINDER_TRIGGER: JobTrigger = { type: "interval", intervalMs: 30_000 };

function reminderDelivery(overrides: Partial<DefineJob> = {}): DefineJob {
  return {
    kind: "reminder_delivery",
    priority: "reminder",
    trigger: REMINDER_TRIGGER,
    deliveryClass: "at_least_once",
    catchUp: { policy: "never_expires" },
    // maxTurns 0 is the strongest statement in the catalogue: a job that
    // cannot spawn a turn cannot be delayed by a rate limit.
    budget: { maxTurns: 0, maxWallClockMs: 5_000, allowedTools: [] },
    speaks: true,
    ...overrides,
  };
}

describe("nextRunAtFor", () => {
  it("should measure an interval from the instant it is given", () => {
    expect(nextRunAtFor({ type: "interval", intervalMs: 60_000 }, NOW)).toBe(
      new Date(NOW + 60_000).toISOString(),
    );
  });

  it("should resolve a wall-clock trigger in its own zone", () => {
    expect(
      nextRunAtFor({ type: "wall_clock", wallTime: "07:00", tz: CHICAGO }, NOW),
    ).toBe("2026-08-10T12:00:00.000Z");
  });

  it("should honour a recurrence on a wall-clock trigger", () => {
    const next = nextRunAtFor(
      { type: "wall_clock", wallTime: "07:00", tz: CHICAGO, rrule: "FREQ=WEEKLY;BYDAY=WE" },
      NOW,
    );
    expect(next).toBe("2026-08-12T12:00:00.000Z");
  });

  it("should schedule nothing for an event or manual trigger", () => {
    expect(nextRunAtFor({ type: "event", event: "reminder.due" }, NOW)).toBeNull();
    expect(nextRunAtFor({ type: "manual" }, NOW)).toBeNull();
  });

  it("should refuse a trigger missing what it needs", () => {
    expect(() => nextRunAtFor({ type: "interval" }, NOW)).toThrow(JobStoreError);
    expect(() => nextRunAtFor({ type: "wall_clock", wallTime: "07:00" }, NOW)).toThrow(
      JobStoreError,
    );
  });
});

describe("JobStore", () => {
  let db: SylDatabase;
  let now: number;
  let jobs: JobStore;

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    jobs = new JobStore({ db: db.handle, clock: () => now });
  });

  afterEach(() => {
    db.close();
  });

  describe("define", () => {
    it("should schedule a job from its trigger", () => {
      const job = jobs.define(reminderDelivery());

      expect(job.state).toBe("pending");
      expect(job.nextRunAt).toBe(new Date(NOW + 30_000).toISOString());
      expect(job.lease).toBeNull();
      expect(job.circuitBreaker).toEqual({
        state: "closed",
        consecutiveFailures: 0,
        openedAt: null,
      });
    });

    it("should refuse a kind outside the closed catalogue", () => {
      // The model may enqueue a job; it may never invent a kind. If it could, a
      // prompt injection inside an article becomes a job that speaks every
      // morning.
      expect(() => jobs.define(reminderDelivery({ kind: "obey_the_article" }))).toThrow(
        JobStoreError,
      );
    });

    it("should take an explicit instant for an event-driven job", () => {
      const job = jobs.define(
        reminderDelivery({
          trigger: { type: "event", event: "reminder.due" },
          nextRunAt: "2026-08-09T21:00:00.000Z",
        }),
      );
      expect(job.nextRunAt).toBe("2026-08-09T21:00:00.000Z");
    });
  });

  describe("due", () => {
    it("should return nothing before the instant arrives", () => {
      jobs.define(reminderDelivery());
      expect(jobs.due(now)).toHaveLength(0);
    });

    it("should return a job whose instant has passed", () => {
      jobs.define(reminderDelivery());
      expect(jobs.due(now + 30_000)).toHaveLength(1);
    });

    it("should order by priority, not by instant", () => {
      // Background never starts while interactive work is pending.
      jobs.define(reminderDelivery({ kind: "content_ingestion", priority: "background" }));
      jobs.define(reminderDelivery({ priority: "reminder" }));

      const due = jobs.due(now + 30_000);
      expect(due.map((job) => job.priority)).toEqual(["reminder", "background"]);
    });

    it("should exclude a job whose breaker is open", () => {
      const job = jobs.define(reminderDelivery());
      for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
        jobs.lease(job.id, "owner", 60_000);
        jobs.release(job.id, "failure", null);
      }

      expect(jobs.get(job.id)?.circuitBreaker.state).toBe("open");
      expect(jobs.due(now + 3_600_000)).toHaveLength(0);
      expect(jobs.nextRunAt()).toBeNull();
    });

    it("should close the breaker again after a success", () => {
      const job = jobs.define(reminderDelivery());
      jobs.lease(job.id, "owner", 60_000);
      jobs.release(job.id, "failure", null);
      jobs.lease(job.id, "owner", 60_000);
      jobs.release(job.id, "success", null);

      expect(jobs.get(job.id)?.circuitBreaker.consecutiveFailures).toBe(0);
    });

    it("should report the next instant anything is scheduled", () => {
      expect(jobs.nextRunAt()).toBeNull();
      const job = jobs.define(reminderDelivery());
      expect(jobs.nextRunAt()).toBe(job.nextRunAt);
    });
  });

  describe("leases", () => {
    it("should let exactly one runner take a job", () => {
      const job = jobs.define(reminderDelivery());

      expect(jobs.lease(job.id, "runner-a", 60_000)?.lease?.owner).toBe("runner-a");
      // The second runner gets nothing rather than a second copy.
      expect(jobs.lease(job.id, "runner-b", 60_000)).toBeNull();
    });

    it("should reclaim a lease held by a process that is gone", () => {
      const job = jobs.define(reminderDelivery());
      jobs.lease(job.id, "runner-a", 60_000);

      const reclaimed = jobs.recoverLeases("runner-b", now);

      expect(reclaimed).toEqual([job.id]);
      expect(jobs.get(job.id)?.state).toBe("pending");
      expect(jobs.get(job.id)?.lease).toBeNull();
    });

    it("should reclaim its own expired lease", () => {
      const job = jobs.define(reminderDelivery());
      jobs.lease(job.id, "runner-a", 60_000);

      expect(jobs.recoverLeases("runner-a", now)).toHaveLength(0);
      expect(jobs.recoverLeases("runner-a", now + 60_001)).toEqual([job.id]);
    });

    it("should close off the run that was in flight", () => {
      const job = jobs.define(reminderDelivery());
      const leased = jobs.lease(job.id, "runner-a", 60_000);
      const run = jobs.startRun(leased ?? job, job.nextRunAt ?? "", now);

      jobs.recoverLeases("runner-b", now + 60_001);

      const after = jobs.run(run.id);
      // Abandoned is what an unfinished run truthfully is, and the row said so
      // from the first moment rather than being patched into it.
      expect(after?.outcome).toBe("abandoned");
      expect(after?.finishedAt).not.toBeNull();
      expect(after?.error).toContain("stopped before this run finished");
    });

    it("should reschedule an at-most-once job rather than re-running it", () => {
      // Re-running a crashed heartbeat risks duplicating a proactive message.
      const job = jobs.define(
        reminderDelivery({ kind: "heartbeat", deliveryClass: "at_most_once" }),
      );
      jobs.lease(job.id, "runner-a", 60_000);

      jobs.recoverLeases("runner-b", now + 120_000);
      expect(Date.parse(jobs.get(job.id)?.nextRunAt ?? "")).toBeGreaterThan(now + 120_000);
    });

    it("should keep an at-least-once job's missed instant, for the catch-up policy to judge", () => {
      const job = jobs.define(reminderDelivery());
      jobs.lease(job.id, "runner-a", 60_000);

      jobs.recoverLeases("runner-b", now + 120_000);
      expect(jobs.get(job.id)?.nextRunAt).toBe(job.nextRunAt);
    });
  });

  describe("runs", () => {
    it("should record the gap between scheduled and actual", () => {
      // A reminder that fired late is a nuisance; one that pretended to be on
      // time is a lie.
      const job = jobs.define(reminderDelivery());
      now += 30_000 + 391_000;
      const run = jobs.startRun(job, job.nextRunAt ?? "", now);

      expect(run.latenessMs).toBe(391_000);
      expect(run.triggerInstant).toBe(job.nextRunAt);
      expect(run.actualInstant).toBe(new Date(now).toISOString());
    });

    it("should never report negative lateness for an early run", () => {
      const job = jobs.define(reminderDelivery());
      expect(jobs.startRun(job, job.nextRunAt ?? "", now).latenessMs).toBe(0);
    });

    it("should conclude a run", () => {
      const job = jobs.define(reminderDelivery());
      const run = jobs.startRun(job, job.nextRunAt ?? "", now);
      const finished = jobs.finishRun(run.id, {
        outcome: "success",
        spoke: true,
        turns: 0,
        costUsd: 0,
      });

      expect(finished?.outcome).toBe("success");
      expect(finished?.spoke).toBe(true);
      // Zero turns and zero cost: the reminder path never touches the model.
      expect(finished?.turns).toBe(0);
      expect(finished?.costUsd).toBe(0);
      expect(finished?.finishedAt).not.toBeNull();
    });

    it("should keep steps in order", () => {
      const job = jobs.define(reminderDelivery({ kind: "research_brief" }));
      const run = jobs.startRun(job, job.nextRunAt ?? "", now);

      jobs.appendStep(run.id, {
        index: 0,
        sessionId: "1f4c9a2b-7d31-4e88-b0a5-6c2e9f0d3a17",
        numTurns: 1,
        costUsd: 0.0198,
        outcome: "success",
        summary: "Read today's reminders.",
        startedAt: new Date(now).toISOString(),
      });
      jobs.appendStep(run.id, {
        index: 1,
        outcome: "success",
        startedAt: new Date(now + 1).toISOString(),
      });

      const steps = jobs.run(run.id)?.steps ?? [];
      expect(steps.map((step) => step.index)).toEqual([0, 1]);
      expect(steps[0]?.sessionId).toBe("1f4c9a2b-7d31-4e88-b0a5-6c2e9f0d3a17");
      expect(steps[1]?.numTurns).toBe(0);
    });

    it("should refuse two steps claiming the same position", () => {
      const job = jobs.define(reminderDelivery({ kind: "research_brief" }));
      const run = jobs.startRun(job, job.nextRunAt ?? "", now);
      const step = { index: 0, outcome: "success" as const, startedAt: new Date(now).toISOString() };

      jobs.appendStep(run.id, step);
      expect(() => jobs.appendStep(run.id, step)).toThrow();
    });

    it("should page runs newest first and filter by job", () => {
      const first = jobs.define(reminderDelivery());
      const second = jobs.define(reminderDelivery({ kind: "heartbeat" }));
      jobs.startRun(first, first.nextRunAt ?? "", now);
      now += 1_000;
      jobs.startRun(second, second.nextRunAt ?? "", now);

      expect(jobs.listRuns().items[0]?.jobId).toBe(second.id);
      expect(jobs.listRuns({ jobId: first.id }).items).toHaveLength(1);

      const page = jobs.listRuns({ limit: 1 });
      expect(page.hasMore).toBe(true);
      expect(jobs.listRuns({ limit: 1, cursor: page.nextCursor }).items).toHaveLength(1);
    });

    it("should return null for a run it does not have", () => {
      expect(jobs.run("syl:run:missing")).toBeNull();
      expect(jobs.finishRun("syl:run:missing", { outcome: "success" })).toBeNull();
    });
  });

  describe("list", () => {
    it("should page, filter and refuse a bad cursor", () => {
      jobs.define(reminderDelivery());
      jobs.define(reminderDelivery({ kind: "heartbeat", priority: "background" }));

      expect(jobs.list({ kind: "heartbeat" }).items).toHaveLength(1);
      expect(jobs.list({ state: "pending" }).items).toHaveLength(2);
      expect(jobs.list({ limit: 1 }).hasMore).toBe(true);
      expect(() => jobs.list({ cursor: "nope" })).toThrow(PagingError);
    });

    it("should return null for a job it does not have", () => {
      expect(jobs.get("syl:job:missing")).toBeNull();
      expect(jobs.release("syl:job:missing", "success", null)).toBeNull();
      expect(jobs.markRunning("syl:job:missing")).toBeNull();
    });
  });
});
