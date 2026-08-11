import type { Delivery, Device, Job, Reminder } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeliveryRuntime } from "../../src/jobs/runtime.js";
import { fixedClock } from "../../src/services/clock.js";
import type { JobRunner } from "../../src/services/job-runner.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import {
  apnsEnv,
  expectData,
  inertTimers,
  startLiveService,
  type LiveService,
} from "../helpers/live-service.js";

/**
 * **US1 — a reminder reaches him.**
 *
 * > As the Commander, I want a reminder to arrive on my phone at the right
 * > wall-clock moment, so that I can trust Syl with something that matters.
 *
 * `tests/integration/reminder-delivery.test.ts` already proves the delivery
 * mechanism against a fake Apple, and proves it well. What it does not prove is
 * that the **service Syl actually boots** contains that mechanism: it builds
 * its dependencies by hand, calls `createApp`, and assembles its own runner.
 * Every one of those is a place where the shipped assembly could differ from
 * the tested one and no test would notice.
 *
 * So this story runs against `bootstrap` + `startServer` — a real SQLite file,
 * a real port, the WebSocket sharing it — and asserts the two halves separately:
 *
 * 1. `createDeliveryRuntime` produces a runtime that is actually wired: the job
 *    exists, the handler is registered, and push is enabled exactly when the
 *    credentials are there.
 * 2. A reminder created over real HTTP travels to a real notification and back
 *    through a real acknowledgement.
 *
 * Both halves run against the runtime the service built for itself.
 * `createDeliveryRuntime` takes its `origins` now (`syl-md5`), so the Apple leg
 * no longer needs a runner assembled by hand out of the pieces the runtime
 * uses — which was a test of an assembly nothing ships.
 */

const { spawnCalls } = vi.hoisted(() => ({ spawnCalls: [] as unknown[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnCalls.push(args);
      throw new Error("The delivery path must never spawn a subprocess.");
    },
  };
});

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "7ab34c19".repeat(8);
/** 07:00 in Chicago on a summer morning. */
const MORNING = Date.UTC(2026, 7, 10, 12, 0, 0, 0);
/** 16:00 the same day, in Chicago. */
const FIRE_AT = "2026-08-10T21:00:00.000Z";

describe("US1 — a reminder reaches him", () => {
  let syl: LiveService;
  let apple: FakeApns;
  let now: number;

  beforeEach(async () => {
    spawnCalls.length = 0;
    now = MORNING;
    apple = await startFakeApns();
    // Frozen, so "fires at the right instant" and "fired five hours late" are
    // statements about the reminder rather than about the hour the suite ran.
    // The delivery loop is the one thing that moves, and it pushes at `apple`.
    syl = await startLiveService({
      clock: fixedClock(MORNING),
      delivery: { apple, clock: () => now },
    });
  });

  afterEach(async () => {
    await apple.close();
    await syl.close();
  });

  /** Register the Commander's phone through the public API. */
  async function registerDevice(): Promise<Device> {
    return expectData<Device>(
      await syl.api("/devices", {
        method: "POST",
        body: JSON.stringify({
          token: APNS_TOKEN,
          environment: "production",
          platform: "ios",
          name: "Commander's iPhone",
          appVersion: "0.1.0 (14)",
          osVersion: "26.1",
        }),
      }),
    );
  }

  async function setReminder(overrides: Record<string, unknown> = {}): Promise<Reminder> {
    return expectData<Reminder>(
      await syl.api("/reminders", {
        method: "POST",
        body: JSON.stringify({
          text: "Call the pharmacy — the refill lapses today.",
          wallTime: "16:00",
          tz: CHICAGO,
          date: "2026-08-10",
          ...overrides,
        }),
      }),
    );
  }

  /** The service's own delivery runner. Apple was redirected when it booted. */
  function runnerAgainst(target: FakeApns): { runner: JobRunner; close: () => Promise<void> } {
    if (target !== apple) throw new Error("this story boots against one Apple");
    return { runner: syl.runtime.runner, close: async () => undefined };
  }

  describe("the service Syl actually boots", () => {
    it("should assemble a delivery runtime with the job defined and push enabled", async () => {
      const runtime = createDeliveryRuntime({
        jobs: syl.deps.jobs,
        reminders: syl.deps.reminders,
        outbox: syl.deps.outbox,
        devices: syl.deps.devices,
        env: apnsEnv(),
        clock: () => now,
        timers: inertTimers,
      });

      expect(runtime.pushEnabled).toBe(true);
      expect(runtime.job.kind).toBe("reminder_delivery");
      // maxTurns 0 is the guarantee: a delivery that cannot spawn a turn cannot
      // be delayed by a rate limit or cost anything.
      expect(runtime.job.budget.maxTurns).toBe(0);

      // And it is visible on the admin surface, over HTTP, on the real port.
      const page = await expectData<{ items: Job[] }>(await syl.api("/jobs"));
      expect(page.items.map((job) => job.kind)).toContain("reminder_delivery");

      await runtime.stop();
    });

    it("should hold reminders in the outbox rather than refusing to start when APNs is unconfigured", async () => {
      const runtime = createDeliveryRuntime({
        jobs: syl.deps.jobs,
        reminders: syl.deps.reminders,
        outbox: syl.deps.outbox,
        devices: syl.deps.devices,
        env: {},
        clock: () => now,
        timers: inertTimers,
      });

      expect(runtime.pushEnabled).toBe(false);
      expect(runtime.apns).toBeNull();
      await runtime.stop();
    });

    it("should define exactly one delivery job however many times it boots", () => {
      const first = createDeliveryRuntime({
        jobs: syl.deps.jobs,
        reminders: syl.deps.reminders,
        outbox: syl.deps.outbox,
        devices: syl.deps.devices,
        env: {},
        clock: () => now,
        timers: inertTimers,
      });
      const second = createDeliveryRuntime({
        jobs: syl.deps.jobs,
        reminders: syl.deps.reminders,
        outbox: syl.deps.outbox,
        devices: syl.deps.devices,
        env: {},
        clock: () => now,
        timers: inertTimers,
      });

      // `nextRunAt` is state, not configuration. A second boot that redefined
      // the job would throw away the instant the last pass chose to wake at.
      expect(second.job.id).toBe(first.job.id);
      expect(syl.deps.jobs.list({ kind: "reminder_delivery" }).items).toHaveLength(1);
    });
  });

  describe("the reminder itself", () => {
    it("should fire at the right wall-clock instant, arrive time-sensitive, and close on the ack", async () => {
      await registerDevice();
      const reminder = await setReminder();

      // Resolved from a wall time and an IANA zone, never from a stored offset.
      expect(reminder.nextFireAt).toBe(FIRE_AT);
      expect(reminder.tz).toBe(CHICAGO);

      const { runner, close } = runnerAgainst(apple);
      try {
        now = Date.parse(FIRE_AT) - 1;
        await runner.start();
        expect(apple.pushes).toHaveLength(0);

        now = Date.parse(FIRE_AT);
        await runner.tick();

        expect(apple.pushes).toHaveLength(1);
        const push = apple.pushes[0];
        expect(push?.path).toBe(`/3/device/${APNS_TOKEN}`);
        expect(push?.headers["apns-priority"]).toBe("10");

        const body = push?.body as Record<string, unknown>;
        const aps = body["aps"] as Record<string, unknown>;
        expect(aps["interruption-level"]).toBe("time-sensitive");
        expect(aps["alert"]).toEqual({
          title: "Syl",
          body: "Call the pharmacy — the refill lapses today.",
        });

        // The phone reads the delivery id out of the notification and posts it
        // back. Nothing in this test knows that id by any other route.
        const deliveryId = String(body["deliveryId"]);
        const acked = await expectData<Delivery>(
          await syl.api(`/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
            method: "POST",
            body: JSON.stringify({ ackedAt: "2026-08-10T21:00:07.220Z", engagement: "opened" }),
          }),
        );

        expect(acked.state).toBe("acknowledged");
        const after = await expectData<Reminder>(
          await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`),
        );
        expect(after.deliveryState).toBe("acknowledged");
      } finally {
        await close();
      }
    });

    it("should fire late and say so after the machine has slept through the instant", async () => {
      await registerDevice();
      const reminder = await setReminder();

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();
        expect(apple.pushes).toHaveLength(0);

        // Asleep for five hours past the instant. No ticks in between.
        now = Date.parse(FIRE_AT) + 5 * 60 * 60_000;
        await runner.tick();

        expect(apple.pushes).toHaveLength(1);
        const delivery = (await expectData<{ items: Delivery[] }>(await syl.api("/deliveries")))
          .items[0];
        expect(delivery?.late).toBe(true);
        expect(delivery?.scheduledFor).toBe(FIRE_AT);

        const after = await expectData<Reminder>(
          await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`),
        );
        expect(after.late).toBe(true);
      } finally {
        await close();
      }
    });

    it("should never invoke the model anywhere on the delivery path", async () => {
      await registerDevice();
      await setReminder();

      const { runner, close } = runnerAgainst(apple);
      try {
        now = Date.parse(FIRE_AT);
        await runner.start();
        await runner.tick();

        expect(apple.pushes).toHaveLength(1);
        // The property the whole guarantee rests on, checkable only from
        // outside: nothing on this path spawned a child process.
        expect(spawnCalls).toHaveLength(0);

        const runs = syl.deps.jobs.listRuns().items.filter((run) => run.spoke);
        expect(runs.every((run) => run.turns === 0 && run.costUsd === 0)).toBe(true);
      } finally {
        await close();
      }
    });

    it("should keep an unconfirmed delivery visible for the app to reconcile", async () => {
      // "Delivery is confirmed by the client; an unconfirmed reminder is
      // retried." Push having been accepted by Apple is not confirmation.
      await registerDevice();
      await setReminder();

      const { runner, close } = runnerAgainst(apple);
      try {
        now = Date.parse(FIRE_AT);
        await runner.start();
        await runner.tick();

        const unacknowledged = await expectData<{ items: Delivery[] }>(
          await syl.api("/deliveries?unacknowledged=true"),
        );
        expect(unacknowledged.items).toHaveLength(1);
        expect(unacknowledged.items[0]?.ackedAt).toBeNull();
      } finally {
        await close();
      }
    });
  });
});
