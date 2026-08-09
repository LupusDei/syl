import { rmSync } from "node:fs";

import type { Delivery, Job, Reminder } from "@syl/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startFakeApns } from "../helpers/fake-apns.js";
import { expectData, startLiveService } from "../helpers/live-service.js";

/**
 * **Journey 6 — a reboot mid-flight.**
 *
 * US5 already proves that a *leased* job is reclaimed after a restart. What it
 * never does is kill the service while a notification is genuinely in the air:
 * the row claimed, the request on the wire to Apple, and the answer never
 * recorded because the process is gone.
 *
 * That is the state the outbox's `SENDING_STALE_MS` deadline exists for, and it
 * is the one the never-drop guarantee is thinnest at — a claim that cleared the
 * attempt instant outright would leave a row no query ever returns again.
 *
 * The kill here is real: Apple is mid-request, the tick is un-awaited, and the
 * database handle is closed under it. Nothing tidies up on the way out, which
 * is exactly what happens when the Mac reboots (`syl-iwb` — there is no signal
 * handler).
 */

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "7ab34c19".repeat(8);
const FIRE_AT = "2026-08-10T21:00:00.000Z";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long to wait on the fake Apple. Generous: this suite runs in parallel. */
const SETTLE_MS = 15_000;

describe("Journey 6 — a reboot mid-flight", () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const remove of cleanup.splice(0)) remove();
  });

  it("should recover a notification that was on the wire when the machine died, without sending it twice", async () => {
    let now = Date.parse(FIRE_AT) - HOUR;

    const apple = await startFakeApns();
    // `onError` is swallowed because the kill below leaves this service's tick
    // executing against a closed database. That death rattle is the simulation
    // working, not a failure worth printing over the run.
    const first = await startLiveService({
      clock: () => now,
      delivery: { apple, clock: () => now, onError: () => undefined },
    });
    const path = first.databasePath;
    const directory = first.directory;
    cleanup.push(() => rmSync(directory ?? path, { recursive: true, force: true }));

    await first.api("/devices", {
      method: "POST",
      body: JSON.stringify({
        token: APNS_TOKEN,
        environment: "production",
        platform: "ios",
        name: "Commander's iPhone",
        appVersion: "0.1.0 (14)",
        osVersion: "26.1",
      }),
    });
    const reminder = await expectData<Reminder>(
      await first.api("/reminders", {
        method: "POST",
        body: JSON.stringify({
          text: "Call the dentist.",
          wallTime: "16:00",
          tz: CHICAGO,
          date: "2026-08-10",
        }),
      }),
    );

    const before = first.runtime;
    await before.runner.start();

    // Apple takes the request and then says nothing at all — the machine dies
    // in that gap.
    apple.reply({ status: 200, delayMs: 10 * MINUTE });

    now = Date.parse(FIRE_AT);
    // Deliberately neither awaited nor kept: this tick never completes, and the
    // `catch` is only here so its eventual rejection is not unhandled.
    void before.runner.tick().catch(() => undefined);

    await vi.waitFor(() => {
      expect(apple.pushes, "the push never reached Apple").toHaveLength(1);
    }, SETTLE_MS);

    // The row is claimed and in flight, exactly as production would have it.
    const inFlight = (await expectData<{ items: Delivery[] }>(await first.api("/deliveries")))
      .items[0];
    expect(inFlight?.state).toBe("sending");
    expect(inFlight?.attempts).toBe(1);
    // The claim carries a deadline rather than clearing the instant. Without
    // this the row is invisible to every future pass.
    expect(
      inFlight?.nextAttemptAt,
      "a claimed row with no deadline can never be reclaimed",
    ).not.toBeNull();

    // The power goes. Nothing runs on the way down — no graceful stop of the
    // delivery loop, because a rebooting Mac does not offer one (`syl-iwb`).
    before.runner.stop();
    await first.service.close();
    first.database.close();

    // ---- She comes back, five minutes later. ----
    now = Date.parse(FIRE_AT) + 5 * MINUTE;
    // Paired afresh, because a rebooted Mac is a new process and the Commander
    // is not at the keyboard — but the *device* row, the APNs token, and the
    // outbox all come back off the disk untouched.
    const second = await startLiveService({
      databasePath: path,
      clock: () => now,
      delivery: { apple, clock: () => now },
    });
    const after = second.runtime;
    try {
      await after.runner.start();

      // The stale claim is reclaimed and retried.
      await vi.waitFor(() => {
        expect(apple.pushes, "the stranded notification was never retried").toHaveLength(2);
      }, SETTLE_MS);

      // Same `apns-id` both times, so Apple treats the retry as the same
      // notification rather than a second one. This is the only thing standing
      // between a reboot and the Commander being told twice.
      expect(apple.pushes[1]?.headers["apns-id"]).toBe(apple.pushes[0]?.headers["apns-id"]);

      // One row, not two: the outbox key is derived from the occurrence.
      const rows = (await expectData<{ items: Delivery[] }>(await second.api("/deliveries"))).items;
      expect(rows, "the reboot produced a second notification row").toHaveLength(1);
      expect(rows[0]?.state).toBe("delivered");

      // And the reminder itself was not fired twice.
      const reloaded = await expectData<Reminder>(
        await second.api(`/reminders/${encodeURIComponent(reminder.id)}`),
      );
      expect(reloaded.deliveryState).toBe("delivered");

      // Exactly one delivery job, however many times she has booted.
      const jobs = await expectData<{ items: Job[] }>(await second.api("/jobs"));
      expect(jobs.items.filter((job) => job.kind === "reminder_delivery")).toHaveLength(1);
    } finally {
      await after.stop();
      await second.close({ keepDatabase: true });
      await apple.close();
    }
  }, 30_000);
});
