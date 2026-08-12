import { describe, it, expect } from "vitest";

import { DEFAULT_QUIET_HOURS } from "../../src/config.js";
import { shiftWallTime } from "../../src/harness/schedule.js";
import { fixedClock } from "../../src/services/clock.js";
import {
  MAX_HORIZON_DAYS,
  MAX_RELATIVE_MINUTES,
  PART_OF_DAY,
  reminderInputFrom,
  resolveTime,
  type AmbiguousTime,
  type ResolvedTime,
  type TimeResolution,
} from "../../src/tools/time.js";
import { TEST_NOW } from "../helpers/service.js";

/**
 * The Commander's zone, and the instants this file hangs off.
 *
 * `TEST_NOW` is 2026-08-09T07:00:00Z, which in America/Chicago (CDT, UTC-5) is
 * **02:00 on Sunday 9 August**. Every expectation below is written against that
 * local reading rather than the UTC one, because the whole module exists to
 * stop the two being confused.
 *
 * America/Chicago transitions in 2026: spring forward Sun **Mar 8** (02:00 CST
 * -> 03:00 CDT, so 02:00-02:59 local does not exist) and fall back Sun **Nov 1**
 * (02:00 CDT -> 01:00 CST, so 01:00-01:59 local happens twice — once in the
 * 06:00Z hour and again in the 07:00Z hour).
 *
 * Nothing here reads the real clock. That is not ceremony: a seeded
 * `strftime('now')` in migration 0001 made a test that passed on the day it was
 * written and went red at 07:00 the next morning with no code change. Time
 * bombs in this project are real, and this module is the one most able to plant
 * one.
 */
const TZ = "America/Chicago";

/** A clock at an arbitrary instant, for the cases TEST_NOW cannot express. */
const at = (iso: string) => fixedClock(Date.parse(iso));

const resolve = (
  said: string,
  spec: unknown,
  options: { clock?: () => number; tz?: string } = {},
): TimeResolution =>
  resolveTime({
    said,
    spec,
    clock: options.clock ?? fixedClock(TEST_NOW),
    tz: options.tz ?? TZ,
  });

/** Narrow to a resolution, failing the test with the question if it asked one. */
function expectResolved(result: TimeResolution): ResolvedTime {
  if (result.outcome !== "resolved") {
    throw new Error(`expected a resolution, got a question: ${result.question}`);
  }
  return result;
}

/** Narrow to a question, failing the test with the resolution if it resolved. */
function expectAmbiguous(result: TimeResolution): AmbiguousTime {
  if (result.outcome !== "ambiguous") {
    throw new Error(`expected a question, got ${result.fireAt} (${result.spoken})`);
  }
  return result;
}

describe("resolveTime — relative (\"in five minutes\")", () => {
  it("should resolve minutes from the injected instant, in his zone", () => {
    const result = expectResolved(resolve("in five minutes", { kind: "relative", minutes: 5 }));

    // 07:05Z is 02:05 in Chicago, on the same local day.
    expect(result.wallTime).toBe("02:05");
    expect(result.date).toBe("2026-08-09");
    expect(result.tz).toBe(TZ);
    expect(result.rrule).toBeNull();
    expect(result.fireAt).toBe("2026-08-09T07:05:00.000Z");
  });

  it("should state no assumption, because nothing was assumed", () => {
    const result = expectResolved(resolve("in 5 minutes", { kind: "relative", minutes: 5 }));
    expect(result.assumption).toBeNull();
  });

  it("should take the calendar date from his zone, not from UTC", () => {
    // 04:00Z on 11 August is 23:00 on the 10th in Chicago. Ten minutes on is
    // still the 10th locally while UTC has already turned over — a reminder
    // dated from the server's calendar would be a day out.
    const result = expectResolved(
      resolve("in ten minutes", { kind: "relative", minutes: 10 }, { clock: at("2026-08-11T04:00:00Z") }),
    );
    expect(result.date).toBe("2026-08-10");
    expect(result.wallTime).toBe("23:10");
    expect(result.fireAt).toBe("2026-08-11T04:10:00.000Z");
  });

  it("should accept a numeric string, because that is a shape models emit", () => {
    const result = expectResolved(resolve("in 5 minutes", { kind: "relative", minutes: "5" }));
    expect(result.fireAt).toBe("2026-08-09T07:05:00.000Z");
  });

  it("should ask rather than schedule a reminder for the past", () => {
    const question = expectAmbiguous(resolve("in zero minutes", { kind: "relative", minutes: 0 }));
    expect(question.reason).toBe("past");
  });

  it("should refuse a horizon beyond a year, where minutes are almost certainly a unit slip", () => {
    const question = expectAmbiguous(
      resolve("in a lot of minutes", { kind: "relative", minutes: MAX_RELATIVE_MINUTES + 1 }),
    );
    expect(question.reason).toBe("out_of_range");
  });
});

describe("resolveTime — a bare time of day (\"at 7am\")", () => {
  it("should resolve to today when that time is still ahead", () => {
    // 02:00 local, so 07:00 local is five hours away: 12:00Z.
    const result = expectResolved(resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }));

    expect(result.wallTime).toBe("07:00");
    expect(result.date).toBe("2026-08-09");
    expect(result.fireAt).toBe("2026-08-09T12:00:00.000Z");
    expect(result.assumption).toBeNull();
  });

  it("should roll to tomorrow when that time has already gone today", () => {
    // 13:00Z is 08:00 local: 07:00 is behind us.
    const result = expectResolved(
      resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }, { clock: at("2026-08-09T13:00:00Z") }),
    );

    expect(result.date).toBe("2026-08-10");
    expect(result.fireAt).toBe("2026-08-10T12:00:00.000Z");
  });

  it("should DISCLOSE the roll to tomorrow, because he did not say which day", () => {
    const result = expectResolved(
      resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }, { clock: at("2026-08-09T13:00:00Z") }),
    );

    expect(result.assumption).not.toBeNull();
    expect(result.assumption).toMatch(/tomorrow/i);
  });

  it("should treat the exact instant as gone, so a reminder never lands in the past", () => {
    const result = expectResolved(
      resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }, { clock: at("2026-08-09T12:00:00Z") }),
    );
    expect(result.date).toBe("2026-08-10");
  });

  it.each([
    ["7am", "07:00"],
    ["7 AM", "07:00"],
    ["7:30pm", "19:30"],
    ["7:05", "07:05"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["noon", "12:00"],
    ["midnight", "00:00"],
  ])("should normalise the wall time %s to %s", (given, expected) => {
    const result = expectResolved(resolve("at " + given, { kind: "time_of_day", wallTime: given }));
    expect(result.wallTime).toBe(expected);
  });

  it("should ask rather than invent a reading of a time it cannot normalise", () => {
    const question = expectAmbiguous(
      resolve("at quarter past seven", { kind: "time_of_day", wallTime: "quarter past seven" }),
    );
    expect(question.reason).toBe("malformed");
  });
});

describe("resolveTime — an explicit date and time", () => {
  it("should resolve a calendar date in his zone", () => {
    const result = expectResolved(
      resolve("on 12 August at 3pm", { kind: "date_time", date: "2026-08-12", wallTime: "15:00" }),
    );

    expect(result.date).toBe("2026-08-12");
    expect(result.wallTime).toBe("15:00");
    expect(result.fireAt).toBe("2026-08-12T20:00:00.000Z");
  });

  it("should ask rather than schedule a date that has already gone", () => {
    const question = expectAmbiguous(
      resolve("on 1 August at 3pm", { kind: "date_time", date: "2026-08-01", wallTime: "15:00" }),
    );
    expect(question.reason).toBe("past");
  });

  it("should ask when the date is not a real one", () => {
    const question = expectAmbiguous(
      resolve("on 31 February", { kind: "date_time", date: "2026-02-31", wallTime: "09:00" }),
    );
    expect(question.reason).toBe("malformed");
  });

  it("should refuse a date past the horizon it is willing to schedule", () => {
    const question = expectAmbiguous(
      resolve("in 2099", { kind: "date_time", date: "2099-01-01", wallTime: "09:00" }),
    );
    expect(question.reason).toBe("out_of_range");
  });

  it("should schedule right up to the horizon it does accept", () => {
    const withinHorizon = new Date(TEST_NOW + (MAX_HORIZON_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const result = expectResolved(
      resolve("a long way out", { kind: "date_time", date: withinHorizon, wallTime: "09:00" }),
    );
    expect(result.date).toBe(withinHorizon);
  });

  it("should ask for the hour when a date arrives without one", () => {
    const question = expectAmbiguous(resolve("on 12 August", { kind: "date_time", date: "2026-08-12" }));
    expect(question.reason).toBe("missing_time_of_day");
  });
});

describe("resolveTime — a part of the day (\"tomorrow morning\")", () => {
  it("should apply the stated convention for morning", () => {
    const result = expectResolved(
      resolve("tomorrow morning", { kind: "part_of_day", day: "tomorrow", part: "morning" }),
    );

    expect(result.wallTime).toBe(PART_OF_DAY.morning);
    expect(result.date).toBe("2026-08-10");
    // 07:00 CDT on 10 August is 12:00Z. The instant is the point here: the
    // convention has to survive the trip through the zone intact.
    expect(result.fireAt).toBe("2026-08-10T12:00:00.000Z");
  });

  it("should place morning at the end of quiet hours, so it is never deferred on arrival", () => {
    // The convention is not a magic hour: it is the minute the Commander has
    // already declared himself reachable. Asserted against the window rather
    // than against a copy of today's value — a copy is the arrangement that
    // let this constant and the window disagree in the first place.
    expect(PART_OF_DAY.morning).toBe(DEFAULT_QUIET_HOURS.quiet.end);
  });

  it("should DISCLOSE the convention, because a convention he cannot hear is a guess", () => {
    const result = expectResolved(
      resolve("tomorrow morning", { kind: "part_of_day", day: "tomorrow", part: "morning" }),
    );

    expect(result.assumption).not.toBeNull();
    // The hour he would actually hear, not a stored 24-hour string — and taken
    // from the convention, so a window that moves moves what she says too.
    expect(result.assumption).toContain(PART_OF_DAY.morning.replace(/^0/u, ""));
  });

  it("should resolve today's part when it is still ahead", () => {
    const result = expectResolved(
      resolve("this morning", { kind: "part_of_day", day: "today", part: "morning" }),
    );
    expect(result.date).toBe("2026-08-09");
    expect(result.fireAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("should ask rather than silently move a part of today that has already gone", () => {
    // 19:00Z is 14:00 local: this morning is behind us. Assuming he meant
    // tomorrow is exactly the guess that is only discovered when nothing
    // arrives.
    const question = expectAmbiguous(
      resolve("this morning", { kind: "part_of_day", day: "today", part: "morning" }, { clock: at("2026-08-09T19:00:00Z") }),
    );
    expect(question.reason).toBe("past");
  });

  it.each([
    // `afternoon` and `evening` are free-standing conventions, so their hours
    // are written down. `night` is not: it is an hour before his sleep starts,
    // so that an evening reminder is not created only to be deferred to the
    // morning, and it has to move when the window does.
    ["afternoon", "13:00"],
    ["evening", "18:00"],
    ["night", shiftWallTime(DEFAULT_QUIET_HOURS.quiet.start, -60)],
  ])("should carry a stated convention for %s too", (part, expected) => {
    const result = expectResolved(
      resolve(`tomorrow ${part}`, { kind: "part_of_day", day: "tomorrow", part }),
    );
    expect(result.wallTime).toBe(expected);
    expect(result.assumption).not.toBeNull();
  });

  it("should ask when the part of day is not one it has a convention for", () => {
    const question = expectAmbiguous(
      resolve("tomorrow lunchtime", { kind: "part_of_day", day: "tomorrow", part: "lunchtime" }),
    );
    expect(question.reason).toBe("malformed");
  });
});

describe("resolveTime — recurrence (\"every Tuesday\")", () => {
  it("should produce an rrule and no date", () => {
    const result = expectResolved(
      resolve("every Tuesday at 9", { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=TU", wallTime: "09:00" }),
    );

    expect(result.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(result.date).toBeNull();
    expect(result.wallTime).toBe("09:00");
    // The first Tuesday after Sunday 9 August is the 11th, 09:00 CDT.
    expect(result.fireAt).toBe("2026-08-11T14:00:00.000Z");
  });

  it("should say what it will do, in words he can check", () => {
    const result = expectResolved(
      resolve("every Tuesday at 9", { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=TU", wallTime: "09:00" }),
    );
    expect(result.spoken).toBe("every Tuesday at 9:00 AM");
  });

  it("should ASK for the hour when a recurrence arrives without one", () => {
    // "every Tuesday" carries no time of day. Picking one would be a guess he
    // only discovers on the Tuesday nothing arrives.
    const question = expectAmbiguous(
      resolve("every Tuesday", { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=TU" }),
    );
    expect(question.reason).toBe("missing_time_of_day");
    expect(question.question).toMatch(/time/i);
  });

  it.each([
    ["FREQ=HOURLY", "an unsupported frequency"],
    ["FREQ=WEEKLY;BYDAY=TU;INTERVAL=2", "an interval"],
    ["FREQ=WEEKLY", "a weekly rule with no day"],
    ["every tuesday", "prose rather than a rule"],
  ])("should ask rather than half-support %s (%s)", (rrule) => {
    const question = expectAmbiguous(
      resolve("every so often", { kind: "recurring", rrule, wallTime: "09:00" }),
    );
    expect(question.reason).toBe("unsupported_recurrence");
  });

  it("should ask when a rule parses but can never occur", () => {
    const question = expectAmbiguous(
      resolve("every 31 February", {
        kind: "recurring",
        rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31",
        wallTime: "09:00",
      }),
    );
    expect(question.reason).toBe("unsupported_recurrence");
  });

  it("should describe a daily rule in words", () => {
    const result = expectResolved(
      resolve("every day at 7", { kind: "recurring", rrule: "FREQ=DAILY", wallTime: "07:00" }),
    );
    expect(result.spoken).toBe("every day at 7:00 AM");
    expect(result.fireAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("should describe a monthly rule in words", () => {
    const result = expectResolved(
      resolve("the 1st of every month", {
        kind: "recurring",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        wallTime: "09:00",
      }),
    );
    expect(result.spoken).toBe("on the 1st of every month at 9:00 AM");
  });
});

describe("resolveTime — the refusals", () => {
  it.each([
    "later",
    "Later",
    "soon",
    "sometime",
    "some time next week",
    "whenever",
    "eventually",
    "shortly",
    "in a bit",
    "in a while",
    "in a sec",
    "at some point",
    "one of these days",
    "before long",
    "asap",
    "as soon as possible",
    "later today",
  ])("should refuse %s even when the model offers a confident time", (said) => {
    // The veto runs on what he SAID, not on what the model made of it. A model
    // asked for structure will always produce structure; that is the failure
    // mode this guard exists for.
    const question = expectAmbiguous(resolve(said, { kind: "relative", minutes: 30 }));
    expect(question.reason).toBe("vague");
    expect(question.question).not.toBe("");
  });

  it("should not veto a phrase that merely contains a vague-looking substring", () => {
    // "soon" inside "afternoon" must not fire the guard.
    const result = expectResolved(
      resolve("tomorrow afternoon", { kind: "part_of_day", day: "tomorrow", part: "afternoon" }),
    );
    expect(result.wallTime).toBe(PART_OF_DAY.afternoon);
  });

  it("should ask when the model offered no interpretation at all", () => {
    expect(expectAmbiguous(resolve("at the thing", null)).reason).toBe("missing");
    expect(expectAmbiguous(resolve("at the thing", undefined)).reason).toBe("missing");
  });

  it("should ask when he said nothing about time", () => {
    expect(expectAmbiguous(resolve("", { kind: "relative", minutes: 5 })).reason).toBe("missing");
    expect(expectAmbiguous(resolve("   ", { kind: "relative", minutes: 5 })).reason).toBe("missing");
  });

  it("should ask, never throw, whatever shape the model's output arrives in", () => {
    // Everything below is real model output gone wrong, not invented junk: a
    // bare string instead of an object, a number for a count that was spelled
    // out, a single spec wrapped in an array. This module is the validator, so
    // a throw here would surface as a tool crash rather than a question.
    const shapes: readonly { readonly label: string; readonly spec: unknown }[] = [
      { label: "a bare string", spec: "in five minutes" },
      { label: "a number", spec: 5 },
      { label: "an array", spec: [{ kind: "relative", minutes: 5 }] },
      { label: "an unknown kind", spec: { kind: "whenever", minutes: 5 } },
      { label: "a kind that is not a string", spec: { kind: 7 } },
      { label: "relative with no minutes", spec: { kind: "relative" } },
      { label: "relative with prose minutes", spec: { kind: "relative", minutes: "five" } },
      { label: "an infinite count", spec: { kind: "relative", minutes: Number.POSITIVE_INFINITY } },
      { label: "a NaN count", spec: { kind: "relative", minutes: Number.NaN } },
      { label: "a date that is prose", spec: { kind: "date_time", date: "next Tuesday", wallTime: "09:00" } },
      { label: "a nested mess", spec: { kind: { kind: "relative" }, minutes: { n: 5 } } },
      { label: "a time_of_day with no time", spec: { kind: "time_of_day" } },
      { label: "a recurring with no rule", spec: { kind: "recurring", wallTime: "09:00" } },
      { label: "a part_of_day with no day", spec: { kind: "part_of_day", part: "morning" } },
    ];

    for (const { label, spec } of shapes) {
      const result = resolve("tomorrow at nine", spec);
      expect(result.outcome, label).toBe("ambiguous");
    }
  });

  it("should always carry a question a person could actually answer", () => {
    const specs: readonly unknown[] = [
      null,
      "later",
      { kind: "relative", minutes: 0 },
      { kind: "date_time", date: "2020-01-01", wallTime: "09:00" },
      { kind: "recurring", rrule: "FREQ=HOURLY", wallTime: "09:00" },
      { kind: "part_of_day", day: "today", part: "lunchtime" },
      { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=TU" },
    ];

    for (const spec of specs) {
      const question = expectAmbiguous(resolve("tomorrow at nine", spec));
      expect(question.question.length).toBeGreaterThan(10);
      expect(question.question.trim().endsWith("?")).toBe(true);
    }
  });
});

describe("resolveTime — daylight saving", () => {
  const beforeSpring = at("2026-03-06T12:00:00Z");

  it("should hold 07:00 local across the spring-forward boundary rather than drifting", () => {
    // The load-bearing property: same wall time either side, DIFFERENT instants.
    // 07:00 CST is 13:00Z; 07:00 CDT is 12:00Z.
    const before = expectResolved(
      resolve("on 7 March at 7am", { kind: "date_time", date: "2026-03-07", wallTime: "07:00" }, { clock: beforeSpring }),
    );
    const after = expectResolved(
      resolve("on 9 March at 7am", { kind: "date_time", date: "2026-03-09", wallTime: "07:00" }, { clock: beforeSpring }),
    );

    expect(before.wallTime).toBe("07:00");
    expect(after.wallTime).toBe("07:00");
    expect(before.fireAt).toBe("2026-03-07T13:00:00.000Z");
    expect(after.fireAt).toBe("2026-03-09T12:00:00.000Z");
  });

  it("should hold a daily recurrence at 07:00 local across the boundary", () => {
    // From noon CST on Saturday 7 March, the next 07:00 is Sunday 8 March —
    // already CDT. A scheduler that collapsed this to "every 24 hours" would
    // fire at 06:00.
    const result = expectResolved(
      resolve("every day at 7am", { kind: "recurring", rrule: "FREQ=DAILY", wallTime: "07:00" }, { clock: at("2026-03-07T18:00:00Z") }),
    );
    expect(result.fireAt).toBe("2026-03-08T12:00:00.000Z");
  });

  it("should hold a weekly recurrence at 07:00 local across the boundary", () => {
    const before = expectResolved(
      resolve("every Monday at 7am", { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=MO", wallTime: "07:00" }, { clock: beforeSpring }),
    );
    const after = expectResolved(
      resolve("every Monday at 7am", { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=MO", wallTime: "07:00" }, { clock: at("2026-03-09T18:00:00Z") }),
    );

    // Monday 9 March, already CDT; then Monday 16 March, still CDT.
    expect(before.fireAt).toBe("2026-03-09T12:00:00.000Z");
    expect(after.fireAt).toBe("2026-03-16T12:00:00.000Z");
    expect(before.wallTime).toBe(after.wallTime);
  });

  it("should ask about a one-shot inside the spring-forward gap, which does not exist", () => {
    // 02:30 never happens on 8 March in Chicago. Silently sliding it to 03:00
    // is a reminder at a time he did not ask for; asking costs one sentence.
    const question = expectAmbiguous(
      resolve("on 8 March at 2:30am", { kind: "date_time", date: "2026-03-08", wallTime: "02:30" }, { clock: beforeSpring }),
    );
    expect(question.reason).toBe("nonexistent_local_time");
    expect(question.question).toContain("02:30");
  });

  it("should resolve a relative time inside the FIRST pass of the repeated hour", () => {
    // 06:26Z is 01:26 CDT — the first 01:26 of the night. Five minutes on is
    // the first 01:31, which is exactly what a wall time of 01:31 means.
    const result = expectResolved(
      resolve("in five minutes", { kind: "relative", minutes: 5 }, { clock: at("2026-11-01T06:26:00Z") }),
    );
    expect(result.wallTime).toBe("01:31");
    expect(result.fireAt).toBe("2026-11-01T06:31:00.000Z");
  });

  it("should ask during the SECOND pass of the repeated hour rather than fire an hour early", () => {
    // 07:26Z is 01:26 CST — the second 01:26. A stored wall time of 01:31
    // resolves to the FIRST 01:31, an hour in the past, and the reminder goes
    // off immediately. Minute-granularity wall time cannot say "the second
    // one", so the honest answer is a question.
    const question = expectAmbiguous(
      resolve("in five minutes", { kind: "relative", minutes: 5 }, { clock: at("2026-11-01T07:26:00Z") }),
    );
    expect(question.reason).toBe("ambiguous_local_time");
    expect(question.question).toContain("twice");
  });

  it("should still resolve a bare time of day on the fall-back night", () => {
    // Forward-looking, and the documented policy is the earlier instant so it
    // fires once. No question needed.
    const result = expectResolved(
      resolve("at 1:30am", { kind: "time_of_day", wallTime: "01:30" }, { clock: at("2026-11-01T04:00:00Z") }),
    );
    expect(result.fireAt).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("resolveTime — a zone that is not the server's", () => {
  const TOKYO = "Asia/Tokyo";

  it("should take the calendar date from his zone, not from UTC", () => {
    // TEST_NOW is 16:00 on 9 August in Tokyo, so the next 07:00 is the 10th —
    // while the instant it resolves to is still 9 August in UTC.
    const result = expectResolved(
      resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }, { tz: TOKYO }),
    );

    expect(result.tz).toBe(TOKYO);
    expect(result.date).toBe("2026-08-10");
    expect(result.fireAt).toBe("2026-08-09T22:00:00.000Z");
  });

  it("should resolve a relative time against that zone's wall clock", () => {
    const result = expectResolved(
      resolve("in five minutes", { kind: "relative", minutes: 5 }, { tz: TOKYO }),
    );
    expect(result.wallTime).toBe("16:05");
    expect(result.date).toBe("2026-08-09");
  });

  it("should resolve a convention against that zone", () => {
    const result = expectResolved(
      resolve("tomorrow morning", { kind: "part_of_day", day: "tomorrow", part: "morning" }, { tz: TOKYO }),
    );
    // 07:00 on 10 August in Tokyo (UTC+9) is 22:00Z on the 9th.
    expect(result.fireAt).toBe("2026-08-09T22:00:00.000Z");
  });

  it("should work in a zone with a half-hour offset", () => {
    const result = expectResolved(
      resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }, { tz: "Asia/Kolkata" }),
    );
    // 07:00 IST (UTC+5:30) on 10 August. TEST_NOW is 12:30 on the 9th there.
    expect(result.fireAt).toBe("2026-08-10T01:30:00.000Z");
  });
});

describe("resolveTime — constraint 5, the zone itself", () => {
  it.each(["-06:00", "+05:30", "CST", "EST5EDT", "Mars/Olympus", ""])(
    "should throw rather than accept %s as a zone",
    (tz) => {
      // A bad zone is OUR bug, not his ambiguity. Turning it into a question
      // would ask the Commander to explain a misconfiguration, and hide it.
      expect(() => resolve("in five minutes", { kind: "relative", minutes: 5 }, { tz })).toThrow(
        /IANA/,
      );
    },
  );

  it("should accept UTC, which names no place but is not an offset", () => {
    const result = expectResolved(
      resolve("in five minutes", { kind: "relative", minutes: 5 }, { tz: "UTC" }),
    );
    expect(result.wallTime).toBe("07:05");
  });

  it("should never put an offset in the resolved value", () => {
    const result = expectResolved(resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }));
    expect(result.tz).toBe(TZ);
    expect(result.fireAt.endsWith("Z")).toBe(true);
  });
});

describe("reminderInputFrom", () => {
  it("should produce exactly the fields CreateReminderInput wants for a one-shot", () => {
    const result = expectResolved(resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }));

    expect(reminderInputFrom(result)).toEqual({
      wallTime: "07:00",
      tz: TZ,
      date: "2026-08-09",
      rrule: null,
    });
  });

  it("should produce an rrule and a null date for a recurrence", () => {
    const result = expectResolved(
      resolve("every Tuesday at 9", { kind: "recurring", rrule: "FREQ=WEEKLY;BYDAY=TU", wallTime: "09:00" }),
    );

    expect(reminderInputFrom(result)).toEqual({
      wallTime: "09:00",
      tz: TZ,
      date: null,
      rrule: "FREQ=WEEKLY;BYDAY=TU",
    });
  });

  it("should never emit both a date and an rrule, which the store refuses", () => {
    const oneShot = reminderInputFrom(
      expectResolved(resolve("in five minutes", { kind: "relative", minutes: 5 })),
    );
    const recurring = reminderInputFrom(
      expectResolved(
        resolve("every day at 7", { kind: "recurring", rrule: "FREQ=DAILY", wallTime: "07:00" }),
      ),
    );

    expect(oneShot.rrule).toBeNull();
    expect(recurring.date).toBeNull();
  });
});

describe("resolveTime — what it says back", () => {
  it("should render a one-shot as a date and time he can check", () => {
    const result = expectResolved(resolve("at 7am", { kind: "time_of_day", wallTime: "07:00" }));
    expect(result.spoken).toBe("Sunday, August 9 at 7:00 AM");
  });

  it("should render midnight and noon without the 0 o'clock trap", () => {
    const midnight = expectResolved(
      resolve("at midnight", { kind: "time_of_day", wallTime: "00:00" }),
    );
    const noon = expectResolved(resolve("at noon", { kind: "time_of_day", wallTime: "12:00" }));

    expect(midnight.spoken).toContain("12:00 AM");
    expect(noon.spoken).toContain("12:00 PM");
  });
});
