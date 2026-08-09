import { describe, expect, it } from "vitest";

import {
  elapsedMs,
  formatDuration,
  formatInstant,
  formatLateness,
  formatRelative,
  formatTimeOfDay,
  isNotablyLate,
  LATE_THRESHOLD_MS,
} from "../../src/format/time";

describe("formatInstant", () => {
  it("should render the wire's UTC instant, keeping the Z", () => {
    // The wire is UTC always; a local rendering is a second representation to
    // reconcile at exactly the moment you are checking whether a job fired on
    // time.
    expect(formatInstant("2026-08-09T21:00:00.480Z")).toBe("2026-08-09 21:00:00Z");
  });

  it("should render a missing instant as an em dash rather than an empty cell", () => {
    expect(formatInstant(null)).toBe("—");
  });

  it("should pass an unparseable value through rather than inventing one", () => {
    expect(formatInstant("not a date")).toBe("not a date");
  });
});

describe("formatTimeOfDay", () => {
  it("should keep only the clock part", () => {
    expect(formatTimeOfDay("2026-08-09T21:00:00.480Z")).toBe("21:00:00Z");
  });

  it("should handle a missing or unparseable value", () => {
    expect(formatTimeOfDay(null)).toBe("—");
    expect(formatTimeOfDay("nope")).toBe("nope");
  });
});

describe("formatDuration", () => {
  it("should use milliseconds for sub-second work", () => {
    expect(formatDuration(470)).toBe("470ms");
    expect(formatDuration(0)).toBe("0ms");
  });

  it("should use tenths of a second up to a minute", () => {
    expect(formatDuration(14_800)).toBe("14.8s");
  });

  it("should use minutes and seconds up to an hour", () => {
    expect(formatDuration(391_000)).toBe("6m 31s");
  });

  it("should use hours and minutes beyond that", () => {
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });

  it("should sign a negative span rather than hiding it", () => {
    expect(formatDuration(-2_000)).toBe("-2.0s");
  });

  it("should render an unknown span as an em dash", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("elapsedMs", () => {
  it("should measure the gap between two instants", () => {
    expect(elapsedMs("2026-08-09T12:06:31.000Z", "2026-08-09T12:06:45.800Z")).toBe(14_800);
  });

  it("should return null when either end is missing", () => {
    expect(elapsedMs(null, "2026-08-09T12:06:45.800Z")).toBeNull();
    expect(elapsedMs("2026-08-09T12:06:31.000Z", null)).toBeNull();
  });

  it("should return null when either end is unparseable", () => {
    expect(elapsedMs("nope", "2026-08-09T12:06:45.800Z")).toBeNull();
    expect(elapsedMs("2026-08-09T12:06:31.000Z", "nope")).toBeNull();
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  it("should say how long until a future instant", () => {
    expect(formatRelative("2026-08-09T15:00:00.000Z", now)).toBe("in 3h 00m");
  });

  it("should say how long since a past one", () => {
    expect(formatRelative("2026-08-09T11:54:00.000Z", now)).toBe("6m 00s ago");
  });

  it("should say now for anything inside a second", () => {
    expect(formatRelative("2026-08-09T12:00:00.500Z", now)).toBe("now");
  });

  it("should handle a missing or unparseable instant", () => {
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative("nope", now)).toBe("nope");
  });
});

describe("formatLateness", () => {
  it("should sign a late run so it cannot be read as a duration", () => {
    expect(formatLateness(391_000)).toBe("+6m 31s");
  });

  it("should call zero and negative gaps on time", () => {
    // A run cannot be early in any way worth a column.
    expect(formatLateness(0)).toBe("on time");
    expect(formatLateness(-5)).toBe("on time");
    expect(formatLateness(Number.NaN)).toBe("on time");
  });
});

describe("isNotablyLate", () => {
  it("should flag a gap of a minute or more", () => {
    expect(isNotablyLate(LATE_THRESHOLD_MS)).toBe(true);
    expect(isNotablyLate(391_000)).toBe(true);
  });

  it("should not flag the sub-second gap a healthy run has", () => {
    expect(isNotablyLate(140)).toBe(false);
    expect(isNotablyLate(Number.NaN)).toBe(false);
  });
});
