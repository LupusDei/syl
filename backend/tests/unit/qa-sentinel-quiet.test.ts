import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError } from "../../src/config.js";
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
    // `bootstrap` passes this straight into `new Outbox(...)`. It is now the
    // last place between the environment and the store that can say no, and it
    // says no here rather than in the delivery handler an hour later.
    expect(() => quietHoursFromEnv({ SYL_QUIET_START: "25:00", SYL_QUIET_END: "08:00" })).toThrow(
      ConfigError,
    );
    expect(() => quietHoursFromEnv({ SYL_QUIET_END: "8:00" })).toThrow(ConfigError);
    // The message has to name the variable, because the operator reading it is
    // looking at an environment and not at this file.
    expect(() => quietHoursFromEnv({ SYL_QUIET_START: "25:00" })).toThrow(/SYL_QUIET_START/u);
  });

  it("should reject a timezone that is not an IANA zone", () => {
    // `ReminderService.assertTimezone` refuses "-06:00" for exactly the reason
    // CLAUDE.md constraint 5 gives, and the identical value used to reach the
    // outbox through SYL_TZ with no check at all. One rule now, not two.
    expect(() => quietHoursFromEnv({ SYL_TZ: "-06:00" })).toThrow(ConfigError);
    expect(() => quietHoursFromEnv({ SYL_TZ: "Mars/Olympus" })).toThrow(ConfigError);
    expect(() => quietHoursFromEnv({ SYL_TZ: "America/Chicago" })).not.toThrow();
    expect(() => quietHoursFromEnv({ SYL_TZ: "UTC" })).not.toThrow();
  });

  it("should not let a malformed quiet window throw out of the delivery job", () => {
    // The window is refused where it enters the process, so the Outbox can
    // only ever hold one the scheduler can parse. That is what makes the
    // assertion below true for every environment rather than for this one:
    // there is no longer a value of SYL_QUIET_START that constructs an Outbox
    // and then throws from inside the handler.
    expect(() =>
      quietHoursFromEnv({ SYL_QUIET_START: "25:00", SYL_QUIET_END: "08:00" }),
    ).toThrow(ConfigError);

    const quietHours = quietHoursFromEnv({
      SYL_QUIET_START: "22:00",
      SYL_QUIET_END: "08:00",
      SYL_TZ: CHICAGO,
    });
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
    // -> `parseWallTime`. Previously this threw, `JobRunner.#runOne` recorded
    // outcome "failure", and five of those opened a circuit breaker nothing
    // can close (syl-6z2) — all reminder delivery ended, permanently, five
    // minutes after a clean-looking boot.
    expect(() => deliverDueReminders({ reminders, outbox }, now)).not.toThrow();

    // And the reminder actually went somewhere: 23:00 is inside the window, so
    // it is held to 08:00 rather than dropped.
    const held = outbox.list().items[0];
    expect(held?.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");
  });
});
