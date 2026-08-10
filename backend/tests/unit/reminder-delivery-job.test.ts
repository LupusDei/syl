import { generateKeyPairSync } from "node:crypto";

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
import { JobRunner } from "../../src/services/job-runner.js";
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, JobStore } from "../../src/services/job-store.js";
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
  /** Every line the handler said out loud, so the suite stays quiet. */
  let warned: string[];

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    warned = [];
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
    const handler = createReminderDeliveryHandler({
      reminders,
      outbox,
      devices,
      apns,
      warn: (line) => warned.push(line),
    });
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

  it("should succeed while reporting what is held on a machine that cannot send", async () => {
    // A blocked attempt is not a failed run: the row survives and goes again,
    // which is the entire reason the outbox exists. But it is not silence
    // either — the run says what is wrong and which four values to check.
    reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.UTC(2026, 7, 9, 21, 0);

    const result = await run(null);
    expect(result.outcome).toBe("success");
    expect(result.error).toContain("held and undelivered");
    expect(result.error).toContain("SYL_APNS_KEY_ID");
    expect(outbox.list().items[0]?.state).toBe("pending");
    // And it is said out loud exactly once, not once a minute forever.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("held and undelivered");
  });

  it("should say a machine cannot send once, not on every pass", async () => {
    // The signal has to be loud enough to notice and quiet enough to keep
    // reading. Sixty identical lines an hour is the same as none.
    reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.UTC(2026, 7, 9, 21, 0);

    const job = defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const handler = createReminderDeliveryHandler({
      reminders,
      outbox,
      devices,
      apns: null,
      warn: (line) => warned.push(line),
    });
    for (let pass = 0; pass < 5; pass += 1) {
      const runRow = jobs.startRun(job, job.nextRunAt ?? "", now);
      await handler({ job, run: runRow, triggerInstant: job.nextRunAt ?? "", late: false, now });
      now += 60_000;
    }

    expect(warned).toHaveLength(1);
  });

  it("should succeed while reporting what is waiting to be retried", async () => {
    // A refusal that is about this moment. The row keeps its place in the
    // queue and the run stays a success, because the outbox is working.
    reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.UTC(2026, 7, 9, 21, 0);

    const result = await run(
      scriptedApns({ ok: false, status: 503, reason: "ServiceUnavailable", disposition: "retry" }),
    );
    expect(result.outcome).toBe("success");
    expect(result.error).toContain("will be retried");
    expect(outbox.list().items[0]?.state).toBe("pending");
  });

  it("should schedule its own next wake", async () => {
    const result = await run(scriptedApns());
    expect(result.nextRunAt).toBe(new Date(now + IDLE_POLL_MS).toISOString());
  });
});

describe("the alert seam", () => {
  /**
   * `syl-8l7`. `PresenceService.alerted` existed, was tested, and had no caller
   * anywhere in `backend/src` — so `alert`, the one presence state that is
   * about the Commander being interrupted, could never occur on a running
   * service.
   *
   * The rationing rule is the whole design and it is asserted here rather than
   * assumed: the character says `alert` **only** when a notification Apple
   * actually took carried `time-sensitive`. If a message was not worth breaking
   * through Focus, it is not worth breaking through the screen either — and a
   * row that was held, refused or merely written to the outbox interrupted
   * nobody.
   */
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;
  let outbox: Outbox;
  let devices: DeviceTokenService;
  let jobs: JobStore;
  let alerts: number;

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    alerts = 0;
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

  /** One pass, with a character listening unless `presence` is overridden. */
  async function run(
    apns: ApnsSender | null,
    presence: { alerted(): void } | undefined = {
      alerted: () => {
        alerts += 1;
      },
    },
  ): Promise<void> {
    const job = defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const runRow = jobs.startRun(job, job.nextRunAt ?? "", now);
    const handler = createReminderDeliveryHandler({
      reminders,
      outbox,
      devices,
      apns,
      warn: () => undefined,
      ...(presence === undefined ? {} : { presence }),
    });
    await handler({ job, run: runRow, triggerInstant: job.nextRunAt ?? "", late: false, now });
  }

  /** A commitment: `payloadFor` marks it `time-sensitive`. */
  function commitment(): void {
    reminders.create({ text: "Call the pharmacy.", wallTime: "16:00", tz: CHICAGO, date: "2026-08-09" });
    now = Date.UTC(2026, 7, 9, 21, 0);
  }

  /** A rhythm message that is not urgent: ordinary, `active`. */
  function rhythm(): void {
    reminders.create({
      text: "Evening review.",
      kind: "rhythm",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.UTC(2026, 7, 9, 21, 0);
  }

  it("should tell presence when Apple took a time-sensitive notification", async () => {
    commitment();
    await run(scriptedApns());
    expect(alerts).toBe(1);
  });

  it("should say nothing to presence when the notification was not time-sensitive", async () => {
    // The ration. `alert` is coupled to the interruption level so that the
    // character cannot become something every reminder does.
    rhythm();
    await run(scriptedApns());
    expect(alerts).toBe(0);
  });

  it("should say nothing to presence when nothing was accepted", async () => {
    // A machine that cannot send interrupted nobody. Presence must not claim
    // an interruption that only ever reached the outbox.
    commitment();
    await run(null);
    expect(alerts).toBe(0);
    expect(outbox.list().items[0]?.state).toBe("pending");
  });

  it("should say nothing to presence on a pass with nothing due", async () => {
    await run(scriptedApns());
    expect(alerts).toBe(0);
  });

  it("should announce one interruption for a pass that accepted several", async () => {
    // Two reminders that come due together are one moment of being
    // interrupted, not two. The window is 8s either way, so a second call
    // would only mean a second identical frame.
    reminders.create({ text: "Pharmacy.", wallTime: "16:00", tz: CHICAGO, date: "2026-08-09" });
    reminders.create({ text: "Dentist.", wallTime: "16:00", tz: CHICAGO, date: "2026-08-09" });
    now = Date.UTC(2026, 7, 9, 21, 0);

    await run(scriptedApns());
    expect(alerts).toBe(1);
  });

  it("should deliver normally with no character wired at all", async () => {
    // Presence is optional here on purpose: a delivery runtime with no socket
    // is still a delivery runtime, and the never-drop guarantee may not depend
    // on anything as decorative as a character.
    commitment();
    await run(scriptedApns(), undefined);
    expect(outbox.list().items[0]?.state).toBe("delivered");
  });

  it("should deliver the reminder even when telling presence throws", async () => {
    // The guarantee outranks the character. A throw out of the handler is what
    // opens the job's circuit breaker, so a broken sink here would end every
    // FUTURE reminder as well as this one.
    commitment();
    await run(scriptedApns(), {
      alerted: () => {
        throw new Error("the socket went away mid-frame");
      },
    });
    expect(outbox.list().items[0]?.state).toBe("delivered");
  });
});

describe("delivery across a run of failures", () => {
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

  /** The real handler, behind a fault that clears after `faults` passes. */
  function runnerThatFailsFirst(faults: number, apns: ApnsSender | null): JobRunner {
    let left = faults;
    const real = createReminderDeliveryHandler({ reminders, outbox, devices, apns });
    return new JobRunner({
      store: jobs,
      handlers: new Map([
        [
          "reminder_delivery",
          async (context) => {
            if (left > 0) {
              left -= 1;
              throw new Error("APNs connection reset");
            }
            return real(context);
          },
        ],
      ]),
      clock: () => now,
      timers: { set: () => null, clear: () => undefined },
      onError: () => undefined,
    });
  }

  it("should keep delivering after a transient fault opened the breaker", async () => {
    // syl-6z2. Any throw out of the handler counts: an APNs socket reset,
    // SQLITE_BUSY, a bad stored rrule. Five of them used to end reminder
    // delivery permanently and silently, across restarts, because the only
    // call that could close the breaker was reachable only through the query
    // that excluded it.
    defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const apns = scriptedApns();
    const runner = runnerThatFailsFirst(BREAKER_THRESHOLD, apns);

    await runner.start();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      now += 60_000;
      await runner.tick();
    }
    expect(jobs.list().items[0]?.circuitBreaker.state).toBe("open");

    // The fault is over, and a reminder comes due.
    const reminder = reminders.create({
      text: "Take the medication.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
    });
    now = Date.parse(reminder.nextFireAt) + 1_000;
    for (let i = 0; i < 60; i += 1) {
      now += 60_000;
      await runner.tick();
    }

    expect(apns.sent).toBe(1);
    expect(outbox.list().items).toHaveLength(1);
    expect(reminders.get(reminder.id)?.deliveryState).toBe("delivered");
    expect(jobs.list().items[0]?.circuitBreaker.state).toBe("closed");
  });

  it("should recover within the cooldown, not within a whole night", async () => {
    // The bound matters as much as the recovery: a reminder held behind an
    // open breaker is late by at most the cooldown, and says so.
    defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const runner = runnerThatFailsFirst(BREAKER_THRESHOLD, scriptedApns());

    await runner.start();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      now += 60_000;
      await runner.tick();
    }

    const opened = now;
    let closedAt: number | null = null;
    for (; now <= opened + 2 * BREAKER_COOLDOWN_MS && closedAt === null; now += 60_000) {
      await runner.tick();
      if (jobs.list().items[0]?.circuitBreaker.state === "closed") closedAt = now;
    }

    expect(closedAt).not.toBeNull();
    expect((closedAt ?? Infinity) - opened).toBeLessThanOrEqual(BREAKER_COOLDOWN_MS + 60_000);
  });

  it("should still be trying a day after a fault that never clears", async () => {
    // A permanent fault must not become a permanent silence. The breaker may
    // slow the retry down; it may not end it.
    defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const runner = runnerThatFailsFirst(Number.MAX_SAFE_INTEGER, null);

    await runner.start();
    const started = now;
    let runs = 0;
    for (; now <= started + 86_400_000; now += 60_000) {
      const tick = await runner.tick();
      runs += tick.ran.length;
    }

    expect(runs).toBeGreaterThan(100);
    // And the moment it clears, the queue drains. Nothing was lost meanwhile.
    const reminder = reminders.create({
      text: "Take the medication.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-10",
    });
    now = Date.parse(reminder.nextFireAt) + 1_000;

    const healthy = new JobRunner({
      store: jobs,
      handlers: new Map([
        ["reminder_delivery", createReminderDeliveryHandler({ reminders, outbox, devices, apns: scriptedApns() })],
      ]),
      clock: () => now,
      timers: { set: () => null, clear: () => undefined },
      onError: () => undefined,
    });
    for (let i = 0; i < 10; i += 1) {
      now += 60_000;
      await healthy.tick();
    }

    expect(reminders.get(reminder.id)?.deliveryState).toBe("delivered");
  });
});

describe("a whole night, driven by the runner", () => {
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;
  let outbox: Outbox;
  let devices: DeviceTokenService;
  let jobs: JobStore;

  /** 22:00 Chicago on the 8th: the window closes. */
  const NIGHT_STARTS = Date.UTC(2026, 7, 9, 3, 0, 0, 0);
  /** 09:00 Chicago on the 9th: an hour after it lifts. */
  const NEXT_MORNING = Date.UTC(2026, 7, 9, 14, 0, 0, 0);

  beforeEach(() => {
    db = testDatabase();
    now = NIGHT_STARTS;
    const clock = (): number => now;
    reminders = new ReminderService({ db: db.handle, clock });
    outbox = new Outbox({
      db: db.handle,
      clock,
      quietHours: { quiet: { start: "22:00", end: "08:00" }, tz: CHICAGO },
      jitter: () => 0,
    });
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

  it("should turn a night of reminders into one notification at 08:00", async () => {
    // syl-yvi and syl-2il end to end, through the real runner rather than one
    // hand-called pass. The runner wakes at least every sixty seconds, so this
    // is roughly 660 passes — the shape under which the per-pass digest both
    // burst and dropped, and which nothing in the suite ran.
    for (const [text, wallTime] of [
      ["The parcel is out for delivery.", "22:30"],
      ["Priya replied.", "23:30"],
      ["Rent cleared.", "01:30"],
      ["The build went green.", "05:45"],
    ] as const) {
      reminders.create({
        text,
        wallTime,
        tz: CHICAGO,
        date: wallTime === "22:30" || wallTime === "23:30" ? "2026-08-08" : "2026-08-09",
      });
    }

    defineReminderDeliveryJob(jobs, new Date(now).toISOString());
    const apns = scriptedApns();
    const runner = new JobRunner({
      store: jobs,
      handlers: new Map([
        ["reminder_delivery", createReminderDeliveryHandler({ reminders, outbox, devices, apns })],
      ]),
      clock: () => now,
      timers: { set: () => null, clear: () => undefined },
      onError: () => undefined,
    });

    await runner.start();
    for (; now <= NEXT_MORNING; now += 60_000) await runner.tick();

    // One notification, not four in one second, and not two of them lost.
    expect(apns.sent).toBe(1);
    const rows = outbox.list().items;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.body).toContain("Four things came in overnight");
    expect(rows[0]?.coalescedReminderIds).toHaveLength(4);
    expect(rows[0]?.state).toBe("delivered");

    // And every reminder the night marked delivered is named by that row.
    const named = new Set(rows[0]?.coalescedReminderIds ?? []);
    for (const reminder of reminders.list().items) {
      expect(reminder.deliveryState).toBe("delivered");
      expect(named.has(reminder.id)).toBe(true);
    }
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

  it("should refuse to let a caller replace the reminder-delivery handler", async () => {
    // The docstring on `handlers` says reminder delivery "is built here and
    // cannot be overridden — the never-drop guarantee is not a thing a caller
    // gets to replace". Nothing asserted it, and the property depends entirely
    // on the order of a spread.
    let hijacked = false;
    const runtime = createDeliveryRuntime({
      ...runtimeDeps({}),
      handlers: new Map([
        [
          "reminder_delivery",
          () => {
            hijacked = true;
            return { outcome: "success" as const };
          },
        ],
      ]),
    });

    await runtime.runner.start();
    expect(hijacked, "a caller replaced the delivery handler").toBe(false);
    await runtime.stop();
  });

  it("should send where it was told to, rather than only ever to Apple", async () => {
    // `syl-md5`. `origins` had no seam, so no test could obtain a runtime from
    // this function whose pushes went anywhere but api.push.apple.com — and
    // five journeys rebuilt the runner by hand because of it.
    // A real P-256 key, because the provider token is signed for real on the
    // way out and a placeholder PEM fails before the origin is ever used.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const runtime = createDeliveryRuntime({
      ...runtimeDeps({
        SYL_APNS_KEY_ID: "ABCD123456",
        SYL_APNS_TEAM_ID: "TEAM123456",
        SYL_APNS_BUNDLE_ID: "com.jmm.syl",
        SYL_APNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
      origins: { production: "http://127.0.0.1:1", sandbox: "http://127.0.0.1:1" },
    });

    // Nothing is listening on port 1, so a send fails at the transport — which
    // is the observable difference between "went to the given origin" and
    // "went to Apple", without this unit test opening a socket to the internet.
    const result = await runtime.apns?.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "x" },
    });
    expect(result?.ok).toBe(false);
    await runtime.stop();
  });
});
