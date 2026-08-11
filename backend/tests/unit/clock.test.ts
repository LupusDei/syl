import { describe, expect, it } from "vitest";

import {
  fixedClock,
  hasExpired,
  instant,
  parseInstant,
  systemClock,
} from "../../src/services/clock.js";

describe("systemClock", () => {
  it("should report a plausible epoch-millisecond value", () => {
    const before = Date.now();
    const value = systemClock();

    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});

describe("fixedClock", () => {
  it("should return the same instant however often it is called", () => {
    const clock = fixedClock(1_775_000_000_000);

    expect(clock()).toBe(1_775_000_000_000);
    expect(clock()).toBe(1_775_000_000_000);
  });
});

describe("instant", () => {
  it("should render the contract's shape: UTC, milliseconds, literal Z", () => {
    expect(instant(Date.UTC(2026, 7, 9, 7, 0, 3, 114))).toBe("2026-08-09T07:00:03.114Z");
  });

  it("should keep the milliseconds even when they are zero", () => {
    expect(instant(Date.UTC(2026, 7, 9))).toBe("2026-08-09T00:00:00.000Z");
  });

  it("should refuse a value it cannot represent rather than emitting Invalid Date", () => {
    expect(() => instant(Number.NaN)).toThrow(RangeError);
  });
});

describe("parseInstant", () => {
  it("should round-trip an instant it produced", () => {
    const epochMs = Date.UTC(2026, 7, 9, 7, 0, 3, 114);

    expect(parseInstant(instant(epochMs))).toBe(epochMs);
  });

  it("should reject a fixed UTC offset, which is how one reaches storage", () => {
    // An offset is a property of an instant, not of a place. One that gets
    // stored survives exactly one DST boundary and then moves every recurring
    // reminder by an hour.
    expect(parseInstant("2026-08-09T02:00:03.114-05:00")).toBeNull();
  });

  it("should reject a date with no time, which Date.parse would happily accept", () => {
    expect(parseInstant("2026-08-09")).toBeNull();
  });

  it("should reject second precision, since the contract specifies milliseconds", () => {
    expect(parseInstant("2026-08-09T07:00:03Z")).toBeNull();
  });

  it("should reject a well-shaped string that is not a real date", () => {
    expect(parseInstant("2026-13-45T99:00:00.000Z")).toBeNull();
  });

  it("should reject prose", () => {
    expect(parseInstant("tomorrow at four")).toBeNull();
  });
});

describe("hasExpired", () => {
  const now = Date.UTC(2026, 7, 9, 7, 0, 0, 0);

  it("should treat null as never expiring", () => {
    expect(hasExpired(null, now)).toBe(false);
  });

  it("should be false for an instant in the future", () => {
    expect(hasExpired(instant(now + 1), now)).toBe(false);
  });

  it("should be true for an instant in the past", () => {
    expect(hasExpired(instant(now - 1), now)).toBe(true);
  });

  it("should treat the exact expiry instant as expired", () => {
    expect(hasExpired(instant(now), now)).toBe(true);
  });

  it("should treat an unparseable expiry as expired, not as valid forever", () => {
    // This value grants or denies access. Corrupt data must fail closed.
    expect(hasExpired("whenever", now)).toBe(true);
  });
});
