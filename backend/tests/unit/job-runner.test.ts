import type { Job, JobKind, JobTrigger } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SylDatabase } from "../../src/services/database.js";
import { JobStore, type DefineJob } from "../../src/services/job-store.js";
import {
  JobRunner,
  MAX_TICK_MS,
  MIN_TICK_MS,
  decideCatchUp,
  type JobHandler,
  type Timers,
} from "../../src/services/job-runner.js";
import { testDatabase } from "../helpers/service.js";

const CHICAGO = "America/Chicago";
/** 2026-08-09T12:00Z — 07:00 in Chicago. */
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
const MINUTE = 60_000;

/** A timer that never fires on its own; the test drives the clock instead. */
function manualTimers(): Timers & { readonly armed: number[]; fire(): void } {
  const armed: number[] = [];
  let pending: (() => void) | null = null;

  return {
    armed,
    set: (callback, ms) => {
      armed.push(ms);
      pending = callback;
      return armed.length;
    },
    clear: () => {
      pending = null;
    },
    fire: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
  };
}

describe("decideCatchUp", () => {
  describe("never_expires", () => {
    it("should fire however late, and say it is late", () => {
      // A late reminder is a nuisance; a vanished one destroys trust.
      expect(decideCatchUp({ policy: "never_expires" }, NOW, NOW + 48 * 60 * MINUTE)).toEqual({
        action: "run",
        late: true,
      });
    });

    it("should not call an on-time run late", () => {
      expect(decideCatchUp({ policy: "never_expires" }, NOW, NOW)).toEqual({
        action: "run",
        late: false,
      });
    });
  });

  describe("grace_window", () => {
    it("should run inside the window", () => {
      // A morning agenda at 10:00 is still a morning agenda.
      const decision = decideCatchUp(
        { policy: "grace_window", graceMs: 3 * 60 * MINUTE },
        NOW,
        NOW + 2 * 60 * MINUTE,
      );
      expect(decision).toEqual({ action: "run", late: true });
    });

    it("should skip past it, and say why", () => {
      // One at 16:00 is an interruption about a morning that already happened.
      const decision = decideCatchUp(
        { policy: "grace_window", graceMs: 3 * 60 * MINUTE },
        NOW,
        NOW + 9 * 60 * MINUTE,
      );
      expect(decision.action).toBe("skip");
      expect(decision).toMatchObject({ reason: expect.stringContaining("grace window") });
    });

    it("should treat a missing grace as no grace at all", () => {
      expect(decideCatchUp({ policy: "grace_window" }, NOW, NOW + 10 * MINUTE).action).toBe("skip");
    });
  });

  describe("skip", () => {
    it("should collapse three missed heartbeats into none", () => {
      expect(decideCatchUp({ policy: "skip" }, NOW, NOW + 5 * MINUTE).action).toBe("skip");
    });

    it("should still run one that is on time", () => {
      expect(decideCatchUp({ policy: "skip" }, NOW, NOW)).toEqual({ action: "run", late: false });
    });
  });

  describe("once_per_window", () => {
    const policy = {
      policy: "once_per_window" as const,
      windowStart: "01:00",
      windowEnd: "05:00",
    };

    it("should run inside its wall-clock window", () => {
      // 02:30 in Chicago is 07:30Z.
      const at = Date.UTC(2026, 7, 9, 7, 30);
      expect(decideCatchUp(policy, at, at, CHICAGO).action).toBe("run");
    });

    it("should wait for the next window outside it", () => {
      const at = Date.UTC(2026, 7, 9, 20, 0);
      expect(decideCatchUp(policy, at, at, CHICAGO).action).toBe("skip");
    });

    it("should run when no window is configured", () => {
      expect(decideCatchUp({ policy: "once_per_window" }, NOW, NOW).action).toBe("run");
    });
  });
});

describe("JobRunner", () => {
  let db: SylDatabase;
  let now: number;
  let store: JobStore;
  let timers: ReturnType<typeof manualTimers>;
  let handled: JobKind[];
  let handlers: Map<JobKind, JobHandler>;

  function define(overrides: Partial<DefineJob> = {}): Job {
    return store.define({
      kind: "reminder_delivery",
      priority: "reminder",
      trigger: { type: "interval", intervalMs: 30_000 } satisfies JobTrigger,
      deliveryClass: "at_least_once",
      catchUp: { policy: "never_expires" },
      budget: { maxTurns: 0, maxWallClockMs: 5_000, allowedTools: [] },
      speaks: true,
      ...overrides,
    });
  }

  function runner(overrides: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}): JobRunner {
    return new JobRunner({
      store,
      handlers,
      clock: () => now,
      timers,
      owner: "runner-a",
      onError: () => {
        // Swallowed: a failing job must not stop the loop, and the test
        // asserts on the recorded run rather than on console output.
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    store = new JobStore({ db: db.handle, clock: () => now });
    timers = manualTimers();
    handled = [];
    handlers = new Map<JobKind, JobHandler>([
      [
        "reminder_delivery",
        (context) => {
          handled.push(context.job.kind);
          return { outcome: "success", spoke: true, turns: 0, costUsd: 0 };
        },
      ],
    ]);
  });

  afterEach(() => {
    db.close();
  });

  it("should run a due job and record a zero-turn run", async () => {
    const job = define();
    now += 30_000;

    const loop = runner();
    const result = await loop.start();

    expect(result.ran).toEqual([job.id]);
    expect(handled).toEqual(["reminder_delivery"]);

    const run = store.listRuns({ jobId: job.id }).items[0];
    expect(run?.outcome).toBe("success");
    expect(run?.spoke).toBe(true);
    // The delivery path never touches the model, and the run says so.
    expect(run?.turns).toBe(0);
    expect(run?.costUsd).toBe(0);
    loop.stop();
  });

  it("should run nothing when nothing is due", async () => {
    define();
    const loop = runner();
    expect((await loop.start()).ran).toHaveLength(0);
    loop.stop();
  });

  it("should run at most one job per tick", async () => {
    // Concurrency is one: a single rate-limit pool is shared with the
    // Commander's own work, so parallelism buys nothing but contention.
    define();
    define();
    now += 30_000;

    const loop = runner();
    expect((await loop.start()).ran).toHaveLength(1);
    expect((await loop.tick()).ran).toHaveLength(1);
    loop.stop();
  });

  it("should take the highest-priority job first", async () => {
    handlers.set("content_ingestion", (context) => {
      handled.push(context.job.kind);
      return { outcome: "success" };
    });
    define({ kind: "content_ingestion", priority: "background" });
    define({ priority: "reminder" });
    now += 30_000;

    const loop = runner();
    await loop.start();
    expect(handled).toEqual(["reminder_delivery"]);
    loop.stop();
  });

  describe("the timer", () => {
    it("should arm for the next instant when it is close", async () => {
      define({ trigger: { type: "interval", intervalMs: 5_000 } });
      const loop = runner();

      const result = await loop.start();
      expect(result.nextTickMs).toBe(5_000);
      expect(timers.armed.at(-1)).toBe(5_000);
      loop.stop();
    });

    it("should never sleep longer than a minute", async () => {
      // The ceiling is what makes the loop self-healing: however wrong the
      // last timer was, the next tick recomputes everything from the clock.
      define({ trigger: { type: "interval", intervalMs: 6 * 60 * MINUTE } });
      const loop = runner();

      expect((await loop.start()).nextTickMs).toBe(MAX_TICK_MS);
      loop.stop();
    });

    it("should still tick with nothing scheduled at all", async () => {
      const loop = runner();
      expect((await loop.start()).nextTickMs).toBe(MAX_TICK_MS);
      loop.stop();
    });

    it("should not spin when work is already overdue", async () => {
      define();
      now += 30 * MINUTE;
      const loop = runner();
      await loop.start();

      // The job it just ran is rescheduled; anything still overdue clamps to
      // the floor rather than becoming a zero-delay loop.
      expect((await loop.tick()).nextTickMs).toBeGreaterThanOrEqual(MIN_TICK_MS);
      loop.stop();
    });

    it("should recompute from now rather than trusting the last timer", async () => {
      // A laptop asleep for six hours and a six-hour tick are the same event.
      define({ trigger: { type: "interval", intervalMs: 45_000 } });
      const loop = runner();
      await loop.start();

      now += 6 * 60 * 60_000;
      timers.fire();
      await loop.tick();

      expect(handled).toHaveLength(1);
      expect(loop.nextTickMs(now)).toBeLessThanOrEqual(MAX_TICK_MS);
      loop.stop();
    });

    it("should stop cleanly and arm nothing more", () => {
      const loop = runner();
      loop.stop();
      expect(loop.started).toBe(false);
      // Stopping twice is not an error; shutdown paths call it more than once.
      loop.stop();
    });
  });

  describe("catch-up", () => {
    it("should fire a late commitment and mark the run late", async () => {
      let sawLate = false;
      handlers.set("reminder_delivery", (context) => {
        sawLate = context.late;
        return { outcome: "success" };
      });
      const job = define();
      now += 6 * 60 * 60_000;

      const loop = runner();
      await loop.start();

      expect(sawLate).toBe(true);
      expect(store.listRuns({ jobId: job.id }).items[0]?.latenessMs).toBeGreaterThan(0);
      loop.stop();
    });

    it("should skip a rhythm message past its grace window, and record the skip", async () => {
      // Yesterday's morning agenda has no business arriving today — but the
      // suppression is recorded, not silent.
      handlers.set("morning_agenda", () => ({ outcome: "success" }));
      const job = define({
        kind: "morning_agenda",
        priority: "scheduled",
        catchUp: { policy: "grace_window", graceMs: 3 * 60 * MINUTE },
      });
      now += 9 * 60 * MINUTE;

      const loop = runner();
      const result = await loop.start();

      expect(result.skipped).toEqual([job.id]);
      const run = store.listRuns({ jobId: job.id }).items[0];
      expect(run?.outcome).toBe("skipped");
      expect(run?.summary).toContain("grace window");
      loop.stop();
    });

    it("should collapse missed heartbeats into none", async () => {
      handlers.set("heartbeat", () => ({ outcome: "success" }));
      const job = define({
        kind: "heartbeat",
        priority: "background",
        deliveryClass: "at_most_once",
        catchUp: { policy: "skip" },
      });
      now += 5 * 60 * MINUTE;

      const loop = runner();
      expect((await loop.start()).skipped).toEqual([job.id]);
      loop.stop();
    });
  });

  describe("recovery", () => {
    it("should reclaim a lease left by a process that is gone", async () => {
      const job = define();
      store.lease(job.id, "runner-b", 60_000);
      now += 30_000;

      const loop = runner();
      const result = await loop.start();

      expect(result.reclaimed).toContain(job.id);
      // Reclaimed AND run: recovery happens before scheduling, so the instant
      // that passed while we were down is not swallowed.
      expect(result.ran).toEqual([job.id]);
      loop.stop();
    });

    it("should recover before it schedules anything", async () => {
      const job = define();
      store.lease(job.id, "runner-b", 60_000);
      now += 30_000;

      const loop = runner();
      await loop.start();

      expect(store.listRuns({ jobId: job.id }).items).not.toHaveLength(0);
      loop.stop();
    });
  });

  describe("failures", () => {
    it("should record a thrown handler as a failed run and keep going", async () => {
      handlers.set("reminder_delivery", () => {
        throw new Error("APNs is on fire");
      });
      const job = define();
      now += 30_000;

      const loop = runner();
      await loop.start();

      const run = store.listRuns({ jobId: job.id }).items[0];
      expect(run?.outcome).toBe("failure");
      expect(run?.error).toContain("APNs is on fire");
      // The job is released, not stuck: the next reminder is behind it.
      expect(store.get(job.id)?.state).toBe("pending");
      loop.stop();
    });

    it("should fail a kind with no handler rather than leaving it leased", async () => {
      const job = define({ kind: "research_brief", priority: "background" });
      now += 30_000;

      const loop = runner();
      await loop.start();

      expect(store.listRuns({ jobId: job.id }).items[0]?.error).toContain("No handler");
      expect(store.get(job.id)?.state).toBe("pending");
      loop.stop();
    });

    it("should keep an event-driven job alive after a thrown handler", async () => {
      // An event trigger has no expression to compute a next instant from, so
      // a failed run that returns none would release the job with a null
      // instant and it would go permanently dormant. For reminder delivery
      // that is every future reminder dropped, on one thrown exception.
      handlers.set("reminder_delivery", () => {
        throw new Error("APNs is on fire");
      });
      const job = define({ trigger: { type: "event", event: "reminder.due" }, nextRunAt: new Date(now).toISOString() });

      const loop = runner();
      await loop.start();

      const after = store.get(job.id);
      expect(after?.state).toBe("pending");
      expect(after?.nextRunAt).not.toBeNull();
      expect(Date.parse(after?.nextRunAt ?? "")).toBeGreaterThan(now);
      loop.stop();
    });

    it("should keep an event-driven job alive when its occurrence is skipped", async () => {
      handlers.set("heartbeat", () => ({ outcome: "success" }));
      const job = define({
        kind: "heartbeat",
        priority: "background",
        trigger: { type: "event", event: "something.happened" },
        nextRunAt: new Date(now).toISOString(),
        catchUp: { policy: "skip" },
      });
      now += 5 * MINUTE;

      const loop = runner();
      expect((await loop.start()).skipped).toEqual([job.id]);
      expect(store.get(job.id)?.nextRunAt).not.toBeNull();
      loop.stop();
    });

    it("should leave a manual job dormant, because dormant is what manual means", async () => {
      const job = define({
        kind: "research_brief",
        priority: "background",
        trigger: { type: "manual" },
        nextRunAt: new Date(now).toISOString(),
      });

      const loop = runner();
      await loop.start();

      expect(store.get(job.id)?.nextRunAt).toBeNull();
      loop.stop();
    });

    it("should report an error through the injected reporter", async () => {
      const seen: unknown[] = [];
      handlers.set("reminder_delivery", () => {
        throw new Error("boom");
      });
      define();
      now += 30_000;

      const loop = runner({ onError: (error) => seen.push(error) });
      await loop.start();

      expect(seen).toHaveLength(1);
      loop.stop();
    });

    it("should not run two passes at once", async () => {
      // A tick that overlapped its predecessor would break concurrency-of-one
      // the moment a job took longer than the interval.
      const gate: { release: () => void } = { release: () => undefined };
      handlers.set("reminder_delivery", async () => {
        await new Promise<void>((done) => {
          gate.release = done;
        });
        return { outcome: "success" as const };
      });
      define();
      now += 30_000;

      const loop = runner();
      const first = loop.tick();
      const second = loop.tick();
      gate.release();

      expect(await second).toBe(await first);
      loop.stop();
    });
  });
});
