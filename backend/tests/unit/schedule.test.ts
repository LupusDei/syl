import { describe, it, expect } from "vitest";

import {
  deferPastQuietHours,
  isWithinQuietHours,
  nextDailyOccurrence,
  type QuietHours,
} from "../../src/harness/schedule.js";

const TZ = "America/Chicago";
const QUIET: QuietHours = { start: "23:00", end: "08:00" };

/**
 * America/Chicago is UTC-6 in winter (CST) and UTC-5 in summer (CDT).
 * 2026 transitions: spring forward Sun Mar 8 02:00 CST -> 03:00 CDT;
 * fall back Sun Nov 1 02:00 CDT -> 01:00 CST.
 *
 * The load-bearing property in this file is that a 07:00 local reminder stays
 * at 07:00 local year-round. Adjutant's scheduler gets this wrong today by
 * collapsing cron to a fixed interval, which drifts an hour twice a year.
 */
const utc = (iso: string): Date => new Date(iso);

describe("nextDailyOccurrence", () => {
  it("should return today's occurrence when the wall time is still ahead", () => {
    // 05:00 CDT on Aug 8 -> 07:00 CDT the same day.
    const next = nextDailyOccurrence("07:00", utc("2026-08-08T10:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });

  it("should roll to tomorrow when the wall time has already passed today", () => {
    // 08:00 CDT on Aug 8 -> 07:00 CDT on Aug 9.
    const next = nextDailyOccurrence("07:00", utc("2026-08-08T13:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-08-09T12:00:00.000Z");
  });

  it("should treat an exact match as already past so a reminder never double-fires", () => {
    const next = nextDailyOccurrence("07:00", utc("2026-08-08T12:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-08-09T12:00:00.000Z");
  });

  it("should hold 07:00 local across the DST boundary rather than drifting an hour", () => {
    // Summer: 07:00 CDT == 12:00Z. Winter: 07:00 CST == 13:00Z.
    // Same wall-clock time, different UTC instants — that is the whole point.
    const summer = nextDailyOccurrence("07:00", utc("2026-08-08T13:00:00Z"), TZ);
    const winter = nextDailyOccurrence("07:00", utc("2026-01-10T20:00:00Z"), TZ);

    expect(summer.toISOString()).toBe("2026-08-09T12:00:00.000Z");
    expect(winter.toISOString()).toBe("2026-01-11T13:00:00.000Z");
  });

  it("should schedule correctly across the spring-forward night", () => {
    // From Mar 7 12:00 CST, the next 07:00 is Mar 8 — already CDT (UTC-5).
    const next = nextDailyOccurrence("07:00", utc("2026-03-07T18:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-03-08T12:00:00.000Z");
  });

  it("should schedule correctly across the fall-back night", () => {
    // From Oct 31 12:00 CDT, the next 07:00 is Nov 1 — already back on CST (UTC-6).
    const next = nextDailyOccurrence("07:00", utc("2026-10-31T17:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-11-01T13:00:00.000Z");
  });

  it("should not lose a reminder whose wall time does not exist on a spring-forward day", () => {
    // 02:30 never happens on Mar 8 2026 — the clock jumps 02:00 -> 03:00.
    // Dropping it would silently skip a day, so we fire at the first instant
    // that does exist (03:00 CDT == 08:00Z).
    const next = nextDailyOccurrence("02:30", utc("2026-03-07T18:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("should fire once, on the first pass, for a wall time that repeats on a fall-back day", () => {
    // 01:30 happens twice on Nov 1 2026. Take the earlier (CDT) instant so the
    // reminder does not fire twice.
    const next = nextDailyOccurrence("01:30", utc("2026-11-01T04:00:00Z"), TZ);
    expect(next.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("should reject a malformed time spec instead of silently scheduling something wrong", () => {
    expect(() => nextDailyOccurrence("7am", utc("2026-08-08T12:00:00Z"), TZ)).toThrow(/HH:MM/);
    expect(() => nextDailyOccurrence("25:00", utc("2026-08-08T12:00:00Z"), TZ)).toThrow(/HH:MM/);
    expect(() => nextDailyOccurrence("07:60", utc("2026-08-08T12:00:00Z"), TZ)).toThrow(/HH:MM/);
  });
});

describe("isWithinQuietHours", () => {
  it("should treat the small hours as quiet across the midnight wrap", () => {
    // 03:00 CDT on Aug 8 == 08:00Z.
    expect(isWithinQuietHours(utc("2026-08-08T08:00:00Z"), QUIET, TZ)).toBe(true);
  });

  it("should treat late evening after the start as quiet", () => {
    // 23:30 CDT on Aug 8 == 04:30Z Aug 9.
    expect(isWithinQuietHours(utc("2026-08-09T04:30:00Z"), QUIET, TZ)).toBe(true);
  });

  it("should treat midday as not quiet", () => {
    // 12:00 CDT == 17:00Z.
    expect(isWithinQuietHours(utc("2026-08-08T17:00:00Z"), QUIET, TZ)).toBe(false);
  });

  it("should treat the boundaries as start-inclusive and end-exclusive", () => {
    expect(isWithinQuietHours(utc("2026-08-09T04:00:00Z"), QUIET, TZ)).toBe(true); // 23:00
    expect(isWithinQuietHours(utc("2026-08-08T13:00:00Z"), QUIET, TZ)).toBe(false); // 08:00
  });
});

describe("deferPastQuietHours", () => {
  it("should hold a 03:00 reminder until 08:00 the same morning rather than waking the Commander", () => {
    const fire = utc("2026-08-08T08:00:00Z"); // 03:00 CDT
    const deferred = deferPastQuietHours(fire, QUIET, TZ);
    expect(deferred.toISOString()).toBe("2026-08-08T13:00:00.000Z"); // 08:00 CDT
  });

  it("should push a 23:30 reminder to 08:00 the NEXT morning", () => {
    const fire = utc("2026-08-09T04:30:00Z"); // 23:30 CDT on Aug 8
    const deferred = deferPastQuietHours(fire, QUIET, TZ);
    expect(deferred.toISOString()).toBe("2026-08-09T13:00:00.000Z"); // 08:00 CDT Aug 9
  });

  it("should leave a daytime reminder exactly where it is", () => {
    const fire = utc("2026-08-08T17:00:00Z"); // 12:00 CDT
    expect(deferPastQuietHours(fire, QUIET, TZ).toISOString()).toBe(fire.toISOString());
  });

  it("should never drop a reminder — deferral always returns a later instant, never null", () => {
    // Silent loss is the one failure mode that would make the assistant
    // untrustworthy, so this is asserted explicitly.
    const fire = utc("2026-08-08T08:00:00Z");
    const deferred = deferPastQuietHours(fire, QUIET, TZ);
    expect(deferred.getTime()).toBeGreaterThan(fire.getTime());
  });

  it("should honor an urgent override by delivering inside quiet hours", () => {
    const fire = utc("2026-08-08T08:00:00Z"); // 03:00 CDT
    const deferred = deferPastQuietHours(fire, QUIET, TZ, { urgent: true });
    expect(deferred.toISOString()).toBe(fire.toISOString());
  });
});
