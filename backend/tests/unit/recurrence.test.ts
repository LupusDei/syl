import { describe, expect, it } from "vitest";

import {
  RruleUnsupportedError,
  localPartsOf,
  nextOccurrence,
  occurrenceOnDate,
  parseRrule,
} from "../../src/services/recurrence.js";

const CHICAGO = "America/Chicago";

describe("parseRrule", () => {
  it("should accept the four supported frequencies", () => {
    expect(parseRrule("FREQ=DAILY").freq).toBe("DAILY");
    expect(parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR").byDay).toEqual([1, 3, 5]);
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=15").byMonthDay).toBe(15);
    expect(parseRrule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14").byMonth).toBe(3);
  });

  it("should refuse a frequency outside the subset", () => {
    // Rejected rather than half-supported: a rule that parses but schedules
    // wrongly is a silently dropped reminder wearing a valid row.
    expect(() => parseRrule("FREQ=HOURLY")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=SECONDLY")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("")).toThrow(RruleUnsupportedError);
  });

  it("should refuse an interval other than one", () => {
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY=MO;INTERVAL=2")).toThrow(RruleUnsupportedError);
    expect(parseRrule("FREQ=DAILY;INTERVAL=1").freq).toBe("DAILY");
  });

  it("should refuse a part it does not understand", () => {
    expect(() => parseRrule("FREQ=DAILY;COUNT=5")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=DAILY;UNTIL=20261231T000000Z")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=DAILY;BYSETPOS=1")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("nonsense")).toThrow(RruleUnsupportedError);
  });

  it("should refuse a part that contradicts the frequency", () => {
    expect(() => parseRrule("FREQ=DAILY;BYDAY=MO")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=DAILY;BYMONTHDAY=1")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=WEEKLY")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=MONTHLY")).toThrow(RruleUnsupportedError);
  });

  it("should refuse a weekday or a number that is not one", () => {
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY=XX")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=MONTHLY;BYMONTHDAY=0")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=MONTHLY;BYMONTHDAY=32")).toThrow(RruleUnsupportedError);
    expect(() => parseRrule("FREQ=YEARLY;BYMONTH=13")).toThrow(RruleUnsupportedError);
  });

  it("should be case-insensitive, as RFC 5545 is", () => {
    expect(parseRrule("freq=weekly;byday=mo").byDay).toEqual([1]);
  });
});

describe("localPartsOf", () => {
  it("should read the local date, not the UTC one", () => {
    // 2026-08-10T02:00Z is still 2026-08-09 in Chicago.
    const local = localPartsOf(new Date("2026-08-10T02:00:00.000Z"), CHICAGO);
    expect(local.date).toBe("2026-08-09");
    expect(local.weekday).toBe(0);
  });

  it("should report month and day as numbers", () => {
    const local = localPartsOf(new Date("2026-03-01T12:00:00.000Z"), CHICAGO);
    expect(local).toMatchObject({ year: 2026, month: 3, day: 1 });
  });
});

describe("nextOccurrence", () => {
  it("should be strictly after the instant it is given", () => {
    // An inclusive comparison re-fires the occurrence that just ran.
    const at = new Date("2026-08-09T12:00:00.000Z");
    expect(nextOccurrence(null, "07:00", at, CHICAGO).getTime()).toBeGreaterThan(at.getTime());
  });

  it("should walk daily when there is no rule", () => {
    const next = nextOccurrence(null, "07:00", new Date("2026-08-09T13:00:00.000Z"), CHICAGO);
    expect(next.toISOString()).toBe("2026-08-10T12:00:00.000Z");
  });

  it("should land on the next named weekday", () => {
    // 2026-08-09 is a Sunday; the next MO/WE/FR occurrence is Monday the 10th.
    const rule = parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    const next = nextOccurrence(rule, "07:00", new Date("2026-08-09T13:00:00.000Z"), CHICAGO);
    expect(localPartsOf(next, CHICAGO).date).toBe("2026-08-10");

    const after = nextOccurrence(rule, "07:00", next, CHICAGO);
    expect(localPartsOf(after, CHICAGO).date).toBe("2026-08-12");
  });

  it("should land on the named day of the next month", () => {
    const rule = parseRrule("FREQ=MONTHLY;BYMONTHDAY=15");
    const next = nextOccurrence(rule, "09:00", new Date("2026-08-20T13:00:00.000Z"), CHICAGO);
    expect(localPartsOf(next, CHICAGO).date).toBe("2026-09-15");
  });

  it("should land on the same date next year", () => {
    const rule = parseRrule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14");
    const next = nextOccurrence(rule, "09:00", new Date("2026-08-20T13:00:00.000Z"), CHICAGO);
    expect(localPartsOf(next, CHICAGO).date).toBe("2027-03-14");
  });

  it("should keep the wall time across a daylight-saving boundary", () => {
    // The whole reason wall time and zone are stored instead of an offset.
    // Daylight saving starts on Sunday 2027-03-14 in Chicago, so 07:00 local
    // is 13:00Z on the Saturday and 12:00Z on the Sunday: same wall clock, one
    // hour less of UTC distance. A stored offset would have fired at 06:00.
    const saturday = nextOccurrence(null, "07:00", new Date("2027-03-12T13:00:00.000Z"), CHICAGO);
    const sunday = nextOccurrence(null, "07:00", saturday, CHICAGO);
    const monday = nextOccurrence(null, "07:00", sunday, CHICAGO);

    expect(saturday.toISOString()).toBe("2027-03-13T13:00:00.000Z");
    expect(sunday.toISOString()).toBe("2027-03-14T12:00:00.000Z");
    expect(monday.toISOString()).toBe("2027-03-15T12:00:00.000Z");
    expect(localPartsOf(sunday, CHICAGO).date).toBe("2027-03-14");
  });

  it("should refuse a rule that can never be satisfied", () => {
    const rule = parseRrule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30");
    expect(() => nextOccurrence(rule, "09:00", new Date("2026-08-09T13:00:00.000Z"), CHICAGO)).toThrow(
      RruleUnsupportedError,
    );
  });
});

describe("occurrenceOnDate", () => {
  it("should resolve a local date and wall time to an instant", () => {
    expect(occurrenceOnDate("2026-08-09", "16:00", CHICAGO).toISOString()).toBe(
      "2026-08-09T21:00:00.000Z",
    );
  });

  it("should work at either end of the day", () => {
    expect(occurrenceOnDate("2026-08-09", "00:00", CHICAGO).toISOString()).toBe(
      "2026-08-09T05:00:00.000Z",
    );
    expect(occurrenceOnDate("2026-08-09", "23:30", CHICAGO).toISOString()).toBe(
      "2026-08-10T04:30:00.000Z",
    );
  });

  it("should work in a zone far ahead of UTC", () => {
    expect(occurrenceOnDate("2026-08-09", "09:00", "Pacific/Kiritimati").toISOString()).toBe(
      "2026-08-08T19:00:00.000Z",
    );
  });

  it("should hand a time inside a spring-forward gap to the next existing instant", () => {
    // Losing a reminder is worse than firing it an hour late, so the gap
    // resolves forward rather than skipping the day.
    const at = occurrenceOnDate("2027-03-14", "02:30", CHICAGO);
    expect(localPartsOf(at, CHICAGO).date).toBe("2027-03-14");
    expect(at.toISOString()).toBe("2027-03-14T08:00:00.000Z");
  });

  it("should refuse a date that is not a date", () => {
    expect(() => occurrenceOnDate("nope", "09:00", CHICAGO)).toThrow(RruleUnsupportedError);
    expect(() => occurrenceOnDate("2026-02-30", "09:00", CHICAGO)).toThrow(RruleUnsupportedError);
  });
});
