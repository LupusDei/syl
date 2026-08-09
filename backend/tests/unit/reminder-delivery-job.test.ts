import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IDLE_POLL_MS,
  createReminderDeliveryHandler,
  defineReminderDeliveryJob,
  nextWakeFor,
} from "../../src/jobs/reminder-delivery-job.js";
import { createDeliveryRuntime, describeRuntime, ensureReminderDeliveryJob } from "../../src/jobs/runtime.js";
import type { ApnsSender } from "../../src/jobs/push-outbox.js";
import type { ApnsResult } from "../../src/services/apns-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { JobStore } from "../../src/services/job-store.js";
import { Outbox } from "../../src/services/outbox.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { testDatabase } from "../helpers/service.js";

const CHICAGO = "America/Chicago";
/** 2026-08-09T12:00Z — 07:00 in Chicago. */
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
const TOKEN = "9c0d2e41".repeat(8);

const ACCEPTED: ApnsResult = { ok: true, apnsUniqueId: "UNIQUE-1", apnsId: "APNS-1" };

function scriptedApns(result: ApnsResult = ACCEPTED): ApnsSender & { sent: number } {
  const sender = {
    sent: 0,
    send: () => {
      sender.sent += 1;
      return Promise.resolve(result);
    },
  };
  return sender;
}

describe("defineReminderDeliveryJob", () => {
  let db: SylDatabase;
  let jobs: JobStore;

  beforeEach(() => {
    db = testDatabase();
    jobs = new JobStore({ db: db.handle, clock: () => NOW });
  });

  afterEach(() => {
    db.close();
  });

  it("should forbid the job from ever spawning a turn", () => {
    // The strongest statement in the catalogue: a job that cannot spawn a turn
    // cannot be delayed by a rate limit or broken by a model declining to act.
    const job = defineReminderDeliveryJob(jobs);
    expect(job.budget.maxTurns).toBe(0);
    expect(job.budget.allowedTools).toEqual([]);
  });

  it("should never expire a missed instant", () => {
    const job = defineReminderDeliveryJob(jobs);
    expect(job.catchUp.policy).toBe("never_expires");
    expect(job.priority).toBe("reminder");
    expect(job.speaks).toBe(true);
  });

  it("should take an explicit first instant", () => {
    expect(defineReminderDeliveryJob(jobs, "2026-08-09T12:00:00.000Z").nextRunAt).toBe(
      "2026-08-09T12:00:00.000Z",
    );
  });
});

describe("nextWakeFor", () => {
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;
  let outbox: Outbox;

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    reminders = new ReminderService({ db: db.handle, clock: () => now });
    outbox = new Outbox({ db: db.handle, clock: () => now });
  });

  afterEach(() => {
    db.close();
  });

  it("should ceiling at a minute when nothing is pending", () => {
    // A ceiling, not a poll interval: everything real is scheduled precisely,
    // and the ceiling is what makes a missed wake-up self-correct.
    expect(nextWakeFor({ reminders, outbox }, now)).toBe(new Date(now + IDLE_POLL_MS).toISOString());
  });

  it("should wake for the next reminder when it is sooner", () => {
    reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    // 16:00 Chicago is more than a minute away, so the ceiling still wins.
    expect(nextWakeFor({ reminders, outbox }, now)).toBe(new Date(now + IDLE_POLL_MS).toISOString());

    now = Date.UTC(2026, 7, 9, 20, 59, 30);
    expect(nextWakeFor({ reminders, outbox }, now)).toBe("2026-08-09T21:00:00.000Z");
  });

  it("should wake for the next outbox attempt when it is sooner", () => {
    outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      payload: { title: "Syl", body: "x" },
      idempotencyKey: "k",
      notBefore: new Date(now + 5_000).toISOString(),
    });
    expect(nextWakeFor({ reminders, outbox }, now)).toBe(new Date(now + 5_000).toISOString());
  });
});

describe("createReminderDeliveryHandler", () => {
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;
  let outbox: Outbox;
  let devices: DeviceTokenService;
  let jobs: JobStore;

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    const clock = (): number => now;
    reminders = new ReminderService({ db: db.handle, clock });
    outbox = new Outbox({ db: db.handle, clock });
    devices = new DeviceTokenService({ db: db.handle, clock });
    jobs = new JobStore({ db: db.handle, clock });
    devices.register({
      token: TOKEN,
      environment: "production",
      platform: "ios",
      name: "iPhone",
      appVersion: "1",
      osVersion: "26.1",
    });
  });

  afterEach(() => {
    db.close();
  });

  async function run(apns: ApnsSender | null): Promise<Awaited<ReturnType<ReturnType<typeof createReminderDeliveryHandler>>>> {
    const job = defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const runRow = jobs.startRun(job, job.nextRunAt ?? "", now);
    const handler = createReminderDeliveryHandler({ reminders, outbox, devices, apns });
    return handler({ job, run: runRow, triggerInstant: job.nextRunAt ?? "", late: false, now });
  }

  it("should report a zero-turn, zero-cost run with no summary", async () => {
    // There is no model here, so there is nothing for a summary to be.
    const result = await run(scriptedApns());
    expect(result).toMatchObject({ outcome: "success", turns: 0, costUsd: 0, summary: null });
  });

  it("should say it spoke only when Apple took something", async () => {
    expect((await run(scriptedApns())).spoke).toBe(false);

    reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.UTC(2026, 7, 9, 21, 0);
    expect((await run(scriptedApns())).spoke).toBe(true);
  });

  it("should succeed while reporting what is waiting to be retried", async () => {
    // A failed attempt is not a failed run: the row survives and goes again,
    // which is the entire reason the outbox exists.
    reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.UTC(2026, 7, 9, 21, 0);

    const result = await run(null);
    expect(result.outcome).toBe("success");
    expect(result.error).toContain("will be retried");
    expect(outbox.list().items[0]?.state).toBe("pending");
  });

  it("should schedule its own next wake", async () => {
    const result = await run(scriptedApns());
    expect(result.nextRunAt).toBe(new Date(now + IDLE_POLL_MS).toISOString());
  });
});

describe("the delivery runtime", () => {
  let db: SylDatabase;
  let jobs: JobStore;

  function runtimeDeps(env: NodeJS.ProcessEnv): Parameters<typeof createDeliveryRuntime>[0] {
    const clock = (): number => NOW;
    return {
      jobs,
      reminders: new ReminderService({ db: db.handle, clock }),
      outbox: new Outbox({ db: db.handle, clock }),
      devices: new DeviceTokenService({ db: db.handle, clock }),
      env,
      clock,
      timers: { set: () => 0, clear: () => undefined },
    };
  }

  beforeEach(() => {
    db = testDatabase();
    jobs = new JobStore({ db: db.handle, clock: () => NOW });
  });

  afterEach(() => {
    db.close();
  });

  it("should create the reminder job once and reuse it afterwards", () => {
    // Its nextRunAt is state — the instant the last pass decided it next
    // needed to wake — and redefining it per boot would throw that away along
    // with the circuit breaker.
    const first = ensureReminderDeliveryJob(jobs, NOW);
    const second = ensureReminderDeliveryJob(jobs, NOW);
    expect(second.id).toBe(first.id);
    expect(jobs.list().items).toHaveLength(1);
  });

  it("should come up without APNs rather than refusing to start", async () => {
    // A machine with no .p8 still has to boot: the admin, the harness and the
    // conversation surface do not need push.
    const runtime = createDeliveryRuntime(runtimeDeps({}));
    expect(runtime.pushEnabled).toBe(false);
    expect(runtime.apns).toBeNull();
    expect(describeRuntime(runtime)[0]).toContain("NOT configured");
    await runtime.stop();
  });

  it("should build a sender when APNs is configured", async () => {
    const runtime = createDeliveryRuntime(
      runtimeDeps({
        SYL_APNS_KEY_ID: "ABCD123456",
        SYL_APNS_TEAM_ID: "TEAM123456",
        SYL_APNS_BUNDLE_ID: "com.jmm.syl",
        SYL_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
      }),
    );

    expect(runtime.pushEnabled).toBe(true);
    expect(describeRuntime(runtime)[0]).toContain("delivery runtime up");
    await runtime.stop();
  });

  it("should register a handler for the reminder job", async () => {
    const runtime = createDeliveryRuntime(runtimeDeps({}));
    const result = await runtime.runner.start();
    // Due from boot, so the first tick runs it and finds nothing to do.
    expect(result.ran).toEqual([runtime.job.id]);
    await runtime.stop();
  });
});
