import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliverDueReminders } from "../../src/jobs/deliver-reminders.js";
import type { SylDatabase } from "../../src/services/database.js";
import { Outbox, quietHoursFromEnv } from "../../src/services/outbox.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { testDatabase } from "../helpers/service.js";

/**
 * QA sentinel reproduction: a typo in one environment variable takes the
 * never-drop guarantee down permanently.
 */

const CHICAGO = "America/Chicago";
const TEN_PM = Date.UTC(2026, 7, 9, 3, 0, 0, 0);

describe("syl-qa: quiet-hours configuration is never validated", () => {
  let db: SylDatabase;
  let now: number;

  beforeEach(() => {
    db = testDatabase();
    now = TEN_PM;
  });
  afterEach(() => db.close());

  it("should reject a quiet window that is not a 24-hour wall time", () => {
    // `bootstrap` calls this at line 275 of index.ts and passes the result
    // straight into `new Outbox(...)`. Nothing between the environment and
    // the Outbox constructor looks at the values.
    expect(() => quietHoursFromEnv({ SYL_QUIET_START: "25:00", SYL_QUIET_END: "08:00" })).toThrow();
  });

  it("should reject a timezone that is not an IANA zone", () => {
    // `ReminderService.assertTimezone` refuses "-06:00" for exactly the reason
    // CLAUDE.md constraint 5 gives. The identical value reaches the outbox
    // through SYL_TZ with no check at all.
    expect(() => quietHoursFromEnv({ SYL_TZ: "-06:00" })).toThrow();
  });

  it("should not let a malformed quiet window throw out of the delivery job", () => {
    // The construction succeeds — the value is only parsed at the first
    // deferral, which is inside the delivery job's handler.
    const quietHours = quietHoursFromEnv({ SYL_QUIET_START: "25:00", SYL_QUIET_END: "08:00" });
    const outbox = new Outbox({ db: db.handle, clock: () => now, quietHours });
    const reminders = new ReminderService({ db: db.handle, clock: () => now });

    const reminder = reminders.create({
      text: "Take the medication.",
      wallTime: "23:00",
      tz: CHICAGO,
      date: "2026-08-08",
    });
    now = Date.parse(reminder.nextFireAt);

    // `deliverDueReminders` -> `outbox.releaseAt` -> `deferPastQuietHours`
    // -> `parseWallTime` throws. `JobRunner.#runOne` catches it and records
    // outcome "failure". Five of these in a row and `JobStore.release` opens
    // the circuit breaker, which nothing can ever close (syl-6z2).
    //
    // A single typo in one environment variable therefore ends all reminder
    // delivery, permanently, five minutes after boot.
    expect(() => deliverDueReminders({ reminders, outbox }, now)).not.toThrow();
  });
});
