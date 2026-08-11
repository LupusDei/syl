import type { Delivery, Device, Job, Reminder } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * **Journey 4 — a bad week.**
 *
 * > The APNs credentials are wrong. Apple refuses every push for days. When the
 * > credentials are finally fixed, the backlog delivers.
 *
 * This is the journey the delivery path was never driven through. Every
 * existing test of the push path either succeeds on the first attempt or fails
 * with a reason the classifier already calls transient. Nobody has asked what a
 * *misconfiguration* does — which is the single most likely thing to be wrong on
 * the morning Syl is stood up on the Commander's machine, because the `.p8`,
 * the key id, the team id and the bundle id are four values a human types once.
 *
 * Apple answers a wrong provider token with `403 InvalidProviderToken`.
 */

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "7ab34c19".repeat(8);
/** 16:00 Chicago — deliberately outside the 22:00–08:00 quiet window. */
const FIRE_AT = "2026-08-10T21:00:00.000Z";
const AFTERNOON = Date.parse("2026-08-10T18:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("Journey 4 — a bad week", () => {
  let syl: LiveService;
  let apple: FakeApns;
  let now: number;

  beforeEach(async () => {
    now = AFTERNOON;
    apple = await startFakeApns();
    // Syl, booted the way `main` boots her, with Apple's address changed and
    // her timer in this test's hand. `syl.runtime` is the runtime the service
    // built for itself — not one assembled here.
    syl = await startLiveService({
      clock: fixedClock(AFTERNOON),
      delivery: { apple, clock: () => now },
    });
  });

  afterEach(async () => {
    await apple.close();
    await syl.close();
  });

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

  async function setReminder(text: string): Promise<Reminder> {
    return expectData<Reminder>(
      await syl.api("/reminders", {
        method: "POST",
        body: JSON.stringify({ text, wallTime: "16:00", tz: CHICAGO, date: "2026-08-10" }),
      }),
    );
  }

  /** Every delivery the service is holding, newest first. */
  async function deliveries(): Promise<readonly Delivery[]> {
    return (await expectData<{ items: Delivery[] }>(await syl.api("/deliveries"))).items;
  }

  it("should keep retrying a reminder Apple refuses with a bad provider token, and deliver it once the credentials are fixed", async () => {
    await registerDevice();
    await setReminder("Call the dentist.");

    const { runner } = syl.runtime;
    await runner.start();

    // Apple refuses every push for the rest of the week: the key id is wrong.
    //
    // A standing refusal, not a queue of them. How many attempts a week of
    // passes makes is exactly what this journey is asking, so a queue of n
    // refusals would mean "Apple starts accepting after the nth attempt" —
    // the fixture choosing the hour the credentials get fixed, and choosing
    // it differently for every candidate implementation.
    apple.refuse({ status: 403, reason: "InvalidProviderToken" });

    now = Date.parse(FIRE_AT);
    await runner.tick();

    // One refusal so far.
    expect(apple.pushes).toHaveLength(1);

    // A week of passes, once an hour. Nothing is fixed yet.
    for (let hour = 1; hour <= 24 * 7; hour += 1) {
      now = Date.parse(FIRE_AT) + hour * HOUR;
      await runner.tick();
    }

    // THE CLAIM UNDER TEST: the reminder is still owed. Whatever the outbox
    // decided to do about the refusals, the row must still be reachable by a
    // future attempt — an environment that cannot send yet is a state to wait
    // out, not a reason to drop a reminder.
    //
    // OBSERVED (syl-clc): exactly one push is ever attempted. A 403 with
    // `InvalidProviderToken` is classified `permanent`, `recordFailure` sets
    // `state = 'failed'` and `next_attempt_at = NULL`, and `Outbox.due` only
    // ever selects `pending`/`sending` rows with a non-null instant. The row
    // is unreachable by every future pass, forever, after ONE refusal.
    expect(
      apple.pushes.length,
      "a week of passes attempted this reminder only this many times",
    ).toBeGreaterThan(1);

    const held = (await deliveries())[0];
    expect(held).toBeDefined();
    expect(held?.ackedAt).toBeNull();
    expect(held?.nextAttemptAt, "a reminder with no next attempt can never be sent again").not.toBeNull();

    // And somebody was told. Holding a reminder for a week in silence is a
    // better failure than losing it and no kind of success — the whole reason
    // it is still here is that a human is expected to go and fix the key.
    expect(syl.warnings).toHaveLength(1);
    expect(syl.warnings[0]).toContain("InvalidProviderToken");
    expect(syl.warnings[0]).toContain("SYL_APNS_KEY_ID");

    // The credentials are fixed. Apple accepts.
    apple.accept();
    now = Date.parse(FIRE_AT) + 7 * 24 * HOUR + HOUR;
    const before = apple.pushes.length;
    await runner.tick();

    expect(apple.pushes.length, "the backlog must deliver once Apple accepts").toBeGreaterThan(before);
    const after = (await deliveries())[0];
    expect(after?.state).toBe("delivered");
  });

  it("should not let the delivery job's circuit breaker be opened by Apple refusing pushes", async () => {
    await registerDevice();
    await setReminder("Call the dentist.");

    const { runner } = syl.runtime;
    await runner.start();
    apple.refuse({ status: 403, reason: "InvalidProviderToken" });

    now = Date.parse(FIRE_AT);
    for (let pass = 0; pass < 10; pass += 1) {
      now += MINUTE;
      await runner.tick();
    }

    // Whatever else is true, the job that carries the never-drop guarantee
    // must still be scheduled to wake. A breaker that opened here would end
    // every future reminder, not only this one.
    const jobs = await expectData<{ items: Job[] }>(await syl.api("/jobs"));
    const delivery = jobs.items.find((job) => job.kind === "reminder_delivery");
    expect(delivery?.circuitBreaker.state).toBe("closed");
    expect(delivery?.nextRunAt).not.toBeNull();
  });
});
