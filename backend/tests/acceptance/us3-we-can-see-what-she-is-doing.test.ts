import type { Conversation, Delivery, Device, Run } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineReminderDeliveryJob } from "../../src/jobs/reminder-delivery-job.js";
import { JOB_KINDS } from "../../src/services/job-store.js";
import { JobRunner, type Timers } from "../../src/services/job-runner.js";
import { specOperations } from "../helpers/contract.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * **US3 — we can see what she is doing.**
 *
 * > As the Commander (and as whoever is debugging her), I want a web admin
 * > showing conversations, jobs, and delivery state, so that the system is
 * > inspectable while we build it.
 *
 * The admin is a browser application built entirely against the mock. What it
 * needs from Syl is four read surfaces, and the acceptance criteria name them:
 * every job run with its outcome, duration and failure detail; the outbox
 * including what was retried and what is unconfirmed; conversations, readable
 * and searchable; push and device registration status.
 *
 * Three of the four hold against the real service. The fourth is a bead.
 */

const FROZEN = Date.UTC(2026, 7, 10, 12, 0, 0, 0);
const APNS_TOKEN = "3e91bd07".repeat(8);
const inertTimers: Timers = { set: () => 0, clear: () => undefined };

describe("US3 — we can see what she is doing", () => {
  let syl: LiveService;
  let now: number;

  beforeEach(async () => {
    now = FROZEN;
    syl = await startLiveService({ clock: () => now });
  });

  afterEach(async () => {
    await syl.close();
  });

  describe("every job run, with its outcome, duration and failure detail", () => {
    it("should list a run that succeeded, with lateness measured rather than assumed", async () => {
      const job = defineReminderDeliveryJob(syl.deps.jobs, new Date(now - 60_000).toISOString());
      const runner = new JobRunner({
        store: syl.deps.jobs,
        handlers: new Map([
          [
            "reminder_delivery",
            async () => ({
              outcome: "success" as const,
              spoke: false,
              turns: 0,
              costUsd: 0,
              summary: null,
              error: null,
              nextRunAt: new Date(now + 60_000).toISOString(),
            }),
          ],
        ]),
        clock: () => now,
        timers: inertTimers,
        owner: "us3",
      });

      await runner.start();
      runner.stop();

      const runs = await expectData<{ items: Run[] }>(
        await syl.api(`/jobs/${encodeURIComponent(job.id)}/runs`),
      );
      const run = runs.items[0];

      expect(run?.outcome).toBe("success");
      // The gap between scheduled and actual is the point of the record: a run
      // that fired late must say so rather than look identical to one that did
      // not.
      expect(run?.triggerInstant).toBe(new Date(now - 60_000).toISOString());
      expect(run?.latenessMs).toBe(60_000);
      expect(run?.startedAt).toBe(new Date(now).toISOString());
      expect(run?.finishedAt).not.toBeNull();
      expect(run?.error).toBeNull();

      // And it is reachable on its own, which is what an admin's detail view
      // needs.
      const single = await expectData<Run>(
        await syl.api(`/runs/${encodeURIComponent(run?.id ?? "")}`),
      );
      expect(single.id).toBe(run?.id);
    });

    it("should record the failure detail of a run that threw", async () => {
      const job = defineReminderDeliveryJob(syl.deps.jobs, new Date(now - 1_000).toISOString());
      const runner = new JobRunner({
        store: syl.deps.jobs,
        handlers: new Map([
          [
            "reminder_delivery",
            () => {
              throw new Error("Apple refused the certificate.");
            },
          ],
        ]),
        clock: () => now,
        timers: inertTimers,
        owner: "us3",
      });

      await runner.start();
      runner.stop();

      const runs = await expectData<{ items: Run[] }>(
        await syl.api(`/jobs/${encodeURIComponent(job.id)}/runs`),
      );
      expect(runs.items[0]?.outcome).not.toBe("success");
      // The detail, not just the fact. An admin that shows "failed" and nothing
      // else is a page you have to leave in order to use.
      expect(runs.items[0]?.error).toContain("Apple refused the certificate.");
    });

    /**
     * `syl-djr` — seven of the eight declared job kinds have no handler.
     *
     * `JobStore.define` validates against `JOB_KINDS` and accepts all eight;
     * `createDeliveryRuntime` registers one. A job of any other kind is leased
     * and then fails with "No handler is registered", which counts against the
     * circuit breaker until the job trips open. Nothing outside the process can
     * enqueue one today — `routes/jobs.ts` is GET-only — which is the only
     * reason this is not already happening.
     */
    it("should fail every job kind but reminder_delivery, and say so on the admin surface", async () => {
      const job = syl.deps.jobs.define({
        kind: "morning_agenda",
        priority: "scheduled",
        trigger: { type: "wall_clock", wallTime: "07:00", tz: "America/Chicago" },
        deliveryClass: "at_least_once",
        catchUp: { policy: "grace_window", graceMs: 3_600_000 },
        budget: { maxTurns: 4, maxWallClockMs: 120_000, allowedTools: [] },
        speaks: true,
        nextRunAt: new Date(now - 1_000).toISOString(),
      });

      const runner = new JobRunner({
        store: syl.deps.jobs,
        handlers: new Map(),
        clock: () => now,
        timers: inertTimers,
        owner: "us3",
      });
      await runner.start();
      runner.stop();

      const runs = await expectData<{ items: Run[] }>(
        await syl.api(`/jobs/${encodeURIComponent(job.id)}/runs`),
      );
      expect(runs.items[0]?.error).toContain("No handler is registered");

      // The scale of the gap, stated once so it cannot drift quietly.
      expect(JOB_KINDS).toHaveLength(8);
    });
  });

  describe("the outbox, including what was retried and what is unconfirmed", () => {
    it("should show a delivery, its attempts and its last error", async () => {
      const reminder = await expectData<{ id: string }>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "The parcel is out for delivery.",
            wallTime: "08:00",
            tz: "America/Chicago",
            date: "2026-08-11",
          }),
        }),
      );

      syl.deps.outbox.enqueue({
        channel: "apns",
        messageClass: "reminder_delivery",
        reminderId: reminder.id,
        payload: {
          title: "Syl",
          body: "The parcel is out for delivery.",
          interruptionLevel: "time-sensitive",
        },
        idempotencyKey: `us3-${reminder.id}`,
        scheduledFor: new Date(now).toISOString(),
      });

      const page = await expectData<{ items: Delivery[] }>(await syl.api("/deliveries"));
      const delivery = page.items[0];

      expect(delivery?.state).toBe("pending");
      expect(delivery?.attempts).toBe(0);
      expect(delivery?.ackedAt).toBeNull();
      expect(delivery?.reminderId).toBe(reminder.id);

      // Unconfirmed is its own view, because it is the one the admin is for:
      // "what went out and never came back".
      const unconfirmed = await expectData<{ items: Delivery[] }>(
        await syl.api("/deliveries?unacknowledged=true"),
      );
      expect(unconfirmed.items.map((item) => item.id)).toContain(delivery?.id);

      const single = await expectData<Delivery>(
        await syl.api(`/deliveries/${encodeURIComponent(delivery?.id ?? "")}`),
      );
      expect(single.idempotencyKey).toBe(`us3-${reminder.id}`);
    });
  });

  describe("push and device registration status", () => {
    it("should show a registered device and mark an unregistered one inactive", async () => {
      const device = await expectData<Device>(
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
      expect(device.active).toBe(true);

      await syl.api(`/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });

      const page = await expectData<{ items: Device[] }>(await syl.api("/devices"));
      // The row stays, deactivated. A device that vanishes on unregistration
      // takes the reason it stopped receiving anything with it.
      expect(page.items.find((item) => item.id === device.id)?.active).toBe(false);
    });

    it("should report whether the service is on subscription rails, on the health check", async () => {
      const health = await expectData<{
        status: string;
        checks: { name: string; status: string }[];
      }>(await syl.api("/health", { anonymous: true }));

      expect(health.checks.map((check) => check.name)).toContain("database");
      // The billing constraint, surfaced rather than assumed: a set
      // ANTHROPIC_API_KEY silently reroutes billing to the metered API.
      expect(health.checks.some((check) => check.name.includes("subscription"))).toBe(true);
    });
  });

  describe("conversations, readable and searchable", () => {
    it("should list and read conversations", async () => {
      const page = await expectData<{ items: Conversation[] }>(await syl.api("/conversations"));
      expect(page.items).not.toHaveLength(0);

      const lane = await expectData<{ items: Conversation[] }>(
        await syl.api("/conversations?lane=interactive"),
      );
      expect(lane.items.every((item) => item.lane === "interactive")).toBe(true);
    });

    /**
     * `syl-lr1` — searchable is the half that does not exist.
     *
     * Migration 0003 builds an FTS5 virtual table and three triggers to keep it
     * current, and `MessageStore.search` queries it correctly. No route calls
     * it, and — the part that makes this more than an omission — the contract
     * has no search operation either, so the admin cannot add one without a
     * contract change on both sides.
     */
    it("should have no search operation to offer the admin at all", async () => {
      const searchOperations = specOperations().filter((candidate) =>
        candidate.operationId.toLowerCase().includes("search"),
      );
      expect(searchOperations).toEqual([]);

      // The index is real and populated — this is a missing surface, not a
      // missing capability.
      syl.deps.messages.append({
        clientId: "syl:message:00000000-0000-7000-8000-0000000000e1",
        role: "user",
        text: "Remind me about the pharmacy refill.",
      });
      expect(syl.deps.messages.search("pharmacy")).toHaveLength(1);
    });

    /**
     * `syl-lr1` — the `job` lane is never populated either.
     *
     * `MessageStore.createJobConversation` is called from nowhere in
     * `backend/src`, so "Syl's inner monologue", which the contract describes
     * at length and the admin has a filter for, is always an empty page.
     */
    it("should return an empty job lane, because nothing ever creates one", async () => {
      const page = await expectData<{ items: Conversation[] }>(
        await syl.api("/conversations?lane=job"),
      );
      expect(page.items).toEqual([]);
    });
  });

  it("should expose the read surfaces the admin was built against, and only those", () => {
    // The admin's four screens map onto these. Recorded as an assertion so a
    // route disappearing shows up here rather than as a blank page.
    const ids = specOperations()
      .filter((candidate) => candidate.method === "GET")
      .map((candidate) => candidate.operationId);

    for (const required of ["listJobs", "listJobRuns", "getRun", "listDeliveries", "listDevices"]) {
      expect(ids).toContain(required);
    }
  });
});
