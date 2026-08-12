import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_QUIET_HOURS, loadQuietHours } from "../../src/config.js";
import { isWithinQuietHours, shiftWallTime } from "../../src/harness/schedule.js";
import type { SylDatabase } from "../../src/services/database.js";
import { Outbox, quietHoursFromEnv } from "../../src/services/outbox.js";
import {
  DEFAULT_QUIET_HOURS as PRESENCE_QUIET_HOURS,
  DEFAULT_TIMEZONE as PRESENCE_TIMEZONE,
} from "../../src/services/presence.js";
import { PART_OF_DAY } from "../../src/tools/time.js";
import { testDatabase } from "../helpers/service.js";

/**
 * The quiet window: one definition, and the boundary the morning depends on.
 *
 * Two properties live here, and they are the two that have actually failed.
 *
 * **The boundary.** The morning brief is composed at 06:45 and its notification
 * is created at 07:00. If the window's end were inclusive, that notification
 * would be held for another cycle and the rhythm would never reach him — which
 * is what an 08:00 end did on 2026-08-12, holding the brief for seventy-five
 * minutes. So a notification created at exactly the end of the window must go
 * out at exactly the end of the window.
 *
 * **One window.** There were three of them in this tree, two exported under the
 * same name with different values, and a fourth constant restating one of them
 * with a comment asserting they agreed. A comment is not a mechanism. The scan
 * below is.
 */

const CHICAGO = "America/Chicago";

/** 07:00 America/Chicago on 12 August 2026 — CDT, so UTC-5. */
const AT_THE_BOUNDARY = Date.UTC(2026, 7, 12, 12, 0, 0, 0);
/** One minute before it. */
const A_MINUTE_EARLIER = AT_THE_BOUNDARY - 60_000;

const databases: SylDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** An outbox gated by the window the service actually runs on. */
function gated(now: number): Outbox {
  const db = testDatabase();
  databases.push(db);
  return new Outbox({
    db: db.handle,
    clock: () => now,
    quietHours: quietHoursFromEnv({}),
    jitter: () => 0,
  });
}

describe("the quiet window", () => {
  it("should run from 23:00 to 07:00 in the Commander's zone", () => {
    // The literal IS the point here: this is the one place the value is
    // written down, so this is the one place it can be read back.
    expect(DEFAULT_QUIET_HOURS).toEqual({
      quiet: { start: "23:00", end: "07:00" },
      tz: CHICAGO,
    });
  });

  it("should store an IANA zone rather than a fixed UTC offset", () => {
    // Constraint 5. An offset is a property of an instant, not of a place, and
    // one that reaches storage is an hour wrong after the next DST boundary.
    expect(DEFAULT_QUIET_HOURS.tz).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/u);
  });
});

describe("the end of the window, at the exact minute", () => {
  const { quiet, tz } = DEFAULT_QUIET_HOURS;

  it("should treat the closing minute as already out of quiet hours", () => {
    // End-exclusive. Inclusive in the other direction and the 07:00
    // notification waits for the next pass, which is the whole defect.
    expect(isWithinQuietHours(new Date(AT_THE_BOUNDARY), quiet, tz)).toBe(false);
    expect(isWithinQuietHours(new Date(A_MINUTE_EARLIER), quiet, tz)).toBe(true);
  });

  it("should release a notification created at 07:00 at 07:00, not a cycle later", () => {
    const outbox = gated(AT_THE_BOUNDARY);

    const { delivery } = outbox.enqueue({
      channel: "apns",
      messageClass: "morning_agenda",
      payload: { title: "Syl", body: "Your morning brief.", interruptionLevel: "active" },
      idempotencyKey: "agenda-2026-08-12",
    });

    expect(delivery.nextAttemptAt).toBe(new Date(AT_THE_BOUNDARY).toISOString());
    expect(outbox.due(AT_THE_BOUNDARY)).toHaveLength(1);
  });

  it("should hold a notification created a minute earlier until exactly 07:00", () => {
    // The other side of the same boundary: 06:59 is still his sleep, and the
    // release is the boundary itself rather than some later sweep.
    const outbox = gated(A_MINUTE_EARLIER);
    outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      payload: { title: "Syl", body: "Call the pharmacy.", interruptionLevel: "active" },
      idempotencyKey: "held-2026-08-12",
    });

    expect(outbox.releaseAt(A_MINUTE_EARLIER)).toBe(new Date(AT_THE_BOUNDARY).toISOString());
    expect(outbox.due(A_MINUTE_EARLIER)).toHaveLength(0);
  });

  it("should hold something enqueued at 23:00 until 07:00 the next morning", () => {
    // 23:00 CDT on the 12th is 04:00Z on the 13th; 07:00 CDT on the 13th is
    // 12:00Z. The start is inclusive, so 23:00 is already inside the window.
    const sleepBegins = Date.UTC(2026, 7, 13, 4, 0, 0, 0);

    expect(gated(sleepBegins).releaseAt(sleepBegins)).toBe(
      new Date(Date.UTC(2026, 7, 13, 12, 0)).toISOString(),
    );
  });
});

describe("one window, one definition", () => {
  const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

  /**
   * A quiet-window literal: `start` and `end` both given as `HH:MM` strings,
   * in either order, close enough together to be one object.
   */
  const WINDOW_LITERAL = [
    /start\s*:\s*"[0-2]\d:[0-5]\d"[\s\S]{0,120}?end\s*:\s*"[0-2]\d:[0-5]\d"/u,
    /end\s*:\s*"[0-2]\d:[0-5]\d"[\s\S]{0,120}?start\s*:\s*"[0-2]\d:[0-5]\d"/u,
  ] as const;

  function sourceFiles(): readonly string[] {
    return readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .sort();
  }

  it("should find a quiet-window literal in config.ts and nowhere else in the service", () => {
    // `INFERRED_RELATIONS` was exported from two modules for one column and the
    // resolution was one home with everything else importing it. The same rule,
    // enforced rather than remembered: a module may USE the window by importing
    // it; a module that writes one down is declaring a second one.
    const declaring = sourceFiles().filter((name) => {
      const source = readFileSync(join(SRC_ROOT, name), "utf8");
      return WINDOW_LITERAL.some((pattern) => pattern.test(source));
    });

    expect(declaring).toEqual(["config.ts"]);
  });

  it("should let presence and the outbox agree with config because they import it", () => {
    // Not "these must agree" in a comment — the same object, reached two ways.
    expect(PRESENCE_QUIET_HOURS).toBe(DEFAULT_QUIET_HOURS.quiet);
    expect(PRESENCE_TIMEZONE).toBe(DEFAULT_QUIET_HOURS.tz);
    expect(quietHoursFromEnv({})).toEqual(DEFAULT_QUIET_HOURS);
  });
});

describe("the conventions derived from the window", () => {
  it("should place morning at the moment he has declared himself reachable", () => {
    // Not a pleasant-looking hour: the first minute a reminder created for
    // "tomorrow morning" would not immediately be deferred on arrival.
    expect(PART_OF_DAY.morning).toBe(DEFAULT_QUIET_HOURS.quiet.end);
  });

  it("should place night an hour before the window begins", () => {
    // So an evening reminder is not created only to be pushed to the morning.
    expect(PART_OF_DAY.night).toBe(shiftWallTime(DEFAULT_QUIET_HOURS.quiet.start, -60));
  });

  it("should leave every convention outside the window", () => {
    // The property behind all four: a reminder created for a named part of the
    // day must not be deferred the instant it is created. Asserted over the
    // whole record, so a fifth convention cannot be added inside his sleep.
    const { quiet, tz } = DEFAULT_QUIET_HOURS;

    for (const wallTime of Object.values(PART_OF_DAY)) {
      const [hour = 0, minute = 0] = wallTime.split(":").map(Number);
      // 12 August 2026 is CDT, so a Chicago wall time is five hours behind UTC.
      // `Date.UTC` carries an hour past 24 into the next day, which is right.
      const at = new Date(Date.UTC(2026, 7, 12, hour + 5, minute));
      expect(
        isWithinQuietHours(at, quiet, tz),
        `${wallTime} would be deferred the moment it was created`,
      ).toBe(false);
    }
  });
});

describe("what his machine actually runs on", () => {
  // The grammar of `SYL_QUIET_START` / `SYL_QUIET_END` / `SYL_TZ` is covered in
  // `config.test.ts`. What matters here is narrower and is why this change
  // takes effect at all: neither variable is set in `~/.syl/.env` or in the
  // launchd plist, so the default IS the window, and a value that cannot be
  // parsed must stop the boot rather than become one.

  it("should be the default window, because the environment names no other", () => {
    expect(loadQuietHours({})).toEqual(DEFAULT_QUIET_HOURS);
    expect(loadQuietHours({ SYL_QUIET_START: "  ", SYL_QUIET_END: "" })).toEqual(
      DEFAULT_QUIET_HOURS,
    );
  });

  it("should refuse a malformed value loudly rather than running a window it invented", () => {
    // `syl-085`: an unparseable window used to start cleanly and then throw
    // once a minute inside the delivery handler; five failures opened a
    // breaker nothing could close and reminder delivery ended permanently. It
    // fails at boot now, naming the variable that is wrong.
    expect(() => loadQuietHours({ SYL_QUIET_START: "25:00" })).toThrow(ConfigError);
    expect(() => loadQuietHours({ SYL_QUIET_START: "25:00" })).toThrow(/SYL_QUIET_START/u);
    expect(() => loadQuietHours({ SYL_QUIET_END: "7:00" })).toThrow(/SYL_QUIET_END/u);
    expect(() => loadQuietHours({ SYL_TZ: "-06:00" })).toThrow(/SYL_TZ/u);
  });
});
