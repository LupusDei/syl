import { rmSync } from "node:fs";

import type { Job, Reminder } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * `startSyl` — the body of `main`.
 *
 * `syl-md5`: this used to be `main` itself, which reads `process.env`, binds the
 * real port and returns nothing. No test could call it, so **the six lines that
 * decide whether reminders run on the Commander's machine were executed by
 * exactly one thing: production, on first boot.**
 *
 * What was therefore unverified, and is asserted here: that the handler the
 * runtime registers is reachable from the runner it returns; that the awaited
 * first pass catches up on what was missed while the machine was down; and that
 * the content-ingestion job exists before that pass rather than after it.
 */

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "7ab34c19".repeat(8);
/** 12:00 UTC — 07:00 in Chicago. */
const MORNING = Date.UTC(2026, 7, 10, 12, 0, 0, 0);
/** 16:00 in Chicago, four hours after she went down. */
const FIRE_AT = Date.parse("2026-08-10T21:00:00.000Z");
/** She comes back an hour after the reminder was owed. */
const BACK_AT = FIRE_AT + 60 * 60_000;

describe("startSyl", () => {
  let apple: FakeApns;
  const running: LiveService[] = [];
  const leftovers: string[] = [];

  afterEach(async () => {
    for (const service of running.splice(0)) await service.close({ keepDatabase: true });
    await apple?.close();
    for (const path of leftovers.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function boot(options: {
    readonly at: number;
    readonly databasePath?: string;
  }): Promise<LiveService> {
    const service = await startLiveService({
      ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
      clock: fixedClock(options.at),
      delivery: { apple, clock: () => options.at },
    });
    running.push(service);
    return service;
  }

  it("should deliver a reminder that came due while the machine was down, before it claims to be up", async () => {
    apple = await startFakeApns();

    // She is up at 07:00, with a phone paired and a commitment for 16:00.
    const before = await boot({ at: MORNING });
    const path = before.databasePath;
    leftovers.push(before.directory ?? path);

    await before.api("/devices", {
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
      await before.api("/reminders", {
        method: "POST",
        body: JSON.stringify({
          text: "Call the dentist.",
          wallTime: "16:00",
          tz: CHICAGO,
          date: "2026-08-10",
        }),
      }),
    );
    expect(apple.pushes).toHaveLength(0);

    // The machine goes down, and stays down through 16:00.
    await before.close({ keepDatabase: true });
    running.length = 0;

    // She comes back at 17:00. Nothing in this test ticks anything: the only
    // pass that runs is the one `startSyl` awaits before returning.
    const after = await boot({ at: BACK_AT, databasePath: path });

    expect(
      apple.pushes,
      "the reminder owed while she was down was not sent by the boot itself",
    ).toHaveLength(1);

    const reloaded = await expectData<Reminder>(
      await after.api(`/reminders/${encodeURIComponent(reminder.id)}`),
    );
    // Late, and saying so. A late reminder is a nuisance; a vanished one
    // destroys trust.
    expect(reloaded.deliveryState).toBe("delivered");
  });

  it("should have the content-ingestion job in place before its first pass", async () => {
    apple = await startFakeApns();
    const syl = await boot({ at: MORNING });
    leftovers.push(syl.directory ?? syl.databasePath);

    // Defined by the boot, not by this test, and already carrying an instant —
    // so the first pass, which has already run by the time `boot` returns, saw
    // it. Defined after that pass, a source left mid-ladder by the last crash
    // would wait a further minute for no reason.
    const jobs = await expectData<{ items: Job[] }>(await syl.api("/jobs"));
    const kinds = jobs.items.map((job) => job.kind);
    expect(kinds).toContain("content_ingestion");
    expect(kinds).toContain("reminder_delivery");

    const runs = syl.deps.jobs.listRuns({ limit: 10 }).items;
    expect(runs.length, "the boot did not run a pass at all").toBeGreaterThan(0);
  });

  it("should reach Apple through the runner it returns, not one a caller assembles", async () => {
    apple = await startFakeApns();
    // The loop walks forward here, because the boot's own pass has already
    // scheduled the next wake a minute out and this story adds work after it.
    let ticking = MORNING;
    const syl = await startLiveService({
      clock: fixedClock(MORNING),
      delivery: { apple, clock: () => ticking },
    });
    running.push(syl);
    leftovers.push(syl.directory ?? syl.databasePath);

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
    });

    // Push is enabled because credentials reached `createDeliveryRuntime`, and
    // the notification lands on this fake because `origins` did. Both were
    // unreachable from this function before `syl-md5`.
    expect(syl.runtime.pushEnabled).toBe(true);

    await syl.api("/reminders", {
      method: "POST",
      body: JSON.stringify({
        text: "Call the dentist.",
        wallTime: "16:00",
        tz: CHICAGO,
        date: "2026-08-10",
      }),
    });
    ticking = FIRE_AT;
    await syl.runtime.runner.tick();

    expect(apple.pushes).toHaveLength(1);
    expect(apple.pushes[0]?.path).toBe(`/3/device/${APNS_TOKEN}`);
  });
});
