import { describe, expect, it } from "vitest";

import {
  DAILY_SUMMARY,
  DEFAULT_BASELINE_DAYS,
  DEFAULT_RECENT_DAYS,
  dayOf,
  derive,
  describeWindow,
  shiftDay,
  type Measurement,
  type Series,
  type SeriesDerivation,
} from "../../src/health/derive.js";
import { HEALTH_TYPES, type HealthType } from "../../src/health/contract.js";

/**
 * `syl-t9tj.4.1` (T014) — the derivations, and every test here is an array of
 * numbers in and an object out.
 *
 * Not one of these opens a database, spawns anything, or reads a clock. That is
 * the whole reason `derive.ts` refuses to import the store: the bugs in this
 * layer are arithmetic bugs and provoking one should not need a schema.
 */

const CHICAGO = "America/Chicago";
/** 13 August 2026, 08:00 UTC — 03:00 in his zone, the hour the dream runs. */
const NOW = Date.UTC(2026, 7, 13, 8, 0, 0, 0);
const DAY_MS = 24 * 60 * 60_000;

/** One reading at a given hour of a given day, counted back from `NOW`. */
function at(daysAgo: number, hourUtc: number, value: number): Measurement {
  const stamp = new Date(Date.UTC(2026, 7, 13 - daysAgo, hourUtc, 0, 0, 0)).toISOString();
  return { startedAt: stamp, endedAt: stamp, value };
}

function seriesFor(type: HealthType, measurements: readonly Measurement[]): Series {
  return { [type]: measurements };
}

function only(type: HealthType, measurements: readonly Measurement[]): SeriesDerivation {
  const derived = derive({ series: seriesFor(type, measurements), now: NOW, tz: CHICAGO });
  const found = derived.series.find((one) => one.type === type);
  if (found === undefined) throw new Error(`no derivation for ${type}`);
  return found;
}

describe("health derivations — days are HIS days", () => {
  it("should bucket a late-evening reading into his day, not tomorrow's UTC one", () => {
    // 04:00 UTC on the 12th is 23:00 on the 11th in Chicago. A UTC bucketing
    // would file his whole evening under tomorrow, which is how a "per day"
    // figure silently becomes two half-days.
    expect(dayOf(Date.UTC(2026, 7, 12, 4, 0, 0, 0), CHICAGO)).toBe("2026-08-11");
    expect(dayOf(Date.UTC(2026, 7, 12, 4, 0, 0, 0), "UTC")).toBe("2026-08-12");
  });

  it("should count calendar days forwards and backwards across a month boundary", () => {
    expect(shiftDay("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftDay("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDay("2026-08-13", 0)).toBe("2026-08-13");
  });

  it("should discard anything outside the window rather than let it half-fill a day", () => {
    const derived = only("steps", [
      at(1, 18, 5_000),
      // Two hundred days ago: well outside any baseline, and a partial day at
      // the edge of one is a baseline that is quietly wrong.
      { ...at(1, 18, 9_999), startedAt: new Date(NOW - 200 * DAY_MS).toISOString(), endedAt: new Date(NOW - 200 * DAY_MS).toISOString() },
    ]);
    expect(derived.days).toHaveLength(1);
    expect(derived.days[0]?.figure).toBe(5_000);
  });
});

describe("health derivations — a day's figure", () => {
  it("should total the types that accumulate and average the ones that are sampled", () => {
    expect(DAILY_SUMMARY.steps).toBe("total");
    expect(DAILY_SUMMARY.sleep).toBe("total");
    expect(DAILY_SUMMARY.workout).toBe("total");
    expect(DAILY_SUMMARY.heartRate).toBe("mean");
    expect(DAILY_SUMMARY.bodyMass).toBe("mean");

    const steps = only("steps", [at(1, 14, 3_000), at(1, 18, 2_500)]);
    expect(steps.days[0]?.figure).toBe(5_500);

    const heart = only("heartRate", [at(1, 14, 60), at(1, 18, 70)]);
    expect(heart.days[0]?.figure).toBe(65);
  });

  it("should report the quiet floor as a percentile rather than the minimum", () => {
    // Twenty readings at 60 and one artefact at 20. The minimum is the
    // artefact; the fifth percentile is not.
    const readings = [at(1, 3, 20), ...Array.from({ length: 20 }, (_, i) => at(1, (i % 20) + 4, 60))];
    const derived = only("heartRate", readings);
    expect(derived.days[0]?.min).toBe(20);
    expect(derived.days[0]?.low).toBe(20);

    // With a hundred ordinary readings the single artefact no longer sets it.
    const many = [at(1, 3, 20), ...Array.from({ length: 100 }, () => at(1, 4, 60))];
    const bigger = only("heartRate", many);
    expect(bigger.days[0]?.min).toBe(20);
    expect(bigger.days[0]?.low).toBe(60);
  });

  it("should ignore a measurement whose value is not finite", () => {
    const derived = only("steps", [at(1, 14, 1_000), at(1, 15, Number.NaN)]);
    expect(derived.days[0]?.count).toBe(1);
    expect(derived.days[0]?.figure).toBe(1_000);
  });
});

describe("health derivations — lately, against his own ordinary", () => {
  /** A flat baseline of `base` and a recent week of `recent`. */
  function twoLevels(base: number, recent: number): Measurement[] {
    const out: Measurement[] = [];
    for (let back = 1; back <= 35; back += 1) {
      out.push(at(back, 14, back <= DEFAULT_RECENT_DAYS - 1 ? recent : base));
    }
    return out;
  }

  it("should compare the last week against the four before it", () => {
    const derived = only("steps", twoLevels(8_000, 5_000));
    expect(derived.recent.days).toBe(6);
    expect(derived.recent.mean).toBe(5_000);
    expect(derived.baseline.days).toBeGreaterThan(20);
    expect(derived.baseline.mean).toBe(8_000);
    expect(derived.deviation?.delta).toBe(-3_000);
    expect(derived.deviation?.percent).toBeCloseTo(-37.5, 5);
  });

  it("should leave z null when there is no such thing as typical yet", () => {
    // A flat baseline has zero spread. A z of 0 would read as "exactly
    // ordinary"; absent reads as "there is no ordinary here", which is true.
    const flat = only("steps", twoLevels(8_000, 5_000));
    expect(flat.baseline.sd).toBe(0);
    expect(flat.deviation?.z).toBeNull();

    // One baseline day: no spread can be computed at all.
    const single = only("bodyMass", [at(1, 8, 190), at(20, 8, 195)]);
    expect(single.baseline.sd).toBeNull();
    expect(single.deviation?.z).toBeNull();
  });

  it("should score a real change in units of his own variability", () => {
    const measurements: Measurement[] = [];
    // A baseline that wobbles between 7,600 and 8,400.
    for (let back = DEFAULT_RECENT_DAYS; back <= 34; back += 1) {
      measurements.push(at(back, 14, back % 2 === 0 ? 7_600 : 8_400));
    }
    for (let back = 1; back < DEFAULT_RECENT_DAYS; back += 1) {
      measurements.push(at(back, 14, 4_000));
    }
    const derived = only("steps", measurements);
    expect(derived.deviation?.z).toBeLessThan(-5);
  });

  it("should report no deviation at all when one side of the comparison is empty", () => {
    const recentOnly = only("steps", [at(1, 14, 5_000), at(2, 14, 5_200)]);
    expect(recentOnly.baseline.mean).toBeNull();
    expect(recentOnly.deviation).toBeNull();
  });
});

describe("health derivations — a run of days", () => {
  function withRun(runLength: number, gapAt: number | null): SeriesDerivation {
    const measurements: Measurement[] = [];
    for (let back = DEFAULT_RECENT_DAYS; back <= 34; back += 1) {
      measurements.push(at(back, 14, 100));
    }
    for (let back = 1; back < DEFAULT_RECENT_DAYS; back += 1) {
      if (back === gapAt) continue;
      measurements.push(at(back, 14, back <= runLength ? 130 : 100));
    }
    return only("bodyMass", measurements);
  }

  it("should count consecutive days on one side of his baseline", () => {
    const derived = withRun(4, null);
    expect(derived.run?.direction).toBe("above");
    expect(derived.run?.days).toBe(4);
    expect(derived.run?.since).toBe("2026-08-09");
  });

  it("should end a run at a calendar gap, because nine days has to mean nine days", () => {
    // Day 3 is missing entirely — the watch was off. A run that jumped it would
    // be a claim about the battery.
    const derived = withRun(5, 3);
    expect(derived.run?.days).toBe(2);
  });

  it("should report no run at all without a baseline to have a side of", () => {
    const derived = only("bodyMass", [at(1, 8, 190), at(2, 8, 191)]);
    expect(derived.run).toBeNull();
  });
});

describe("health derivations — the resting heart rate he does not have", () => {
  /**
   * His real distribution, 2026-08-13: 28,726 raw heart-rate samples and **zero**
   * resting-heart-rate readings. A derivation layer that requires the series the
   * spec's own example leans on produces nothing forever and looks like a bug.
   */
  function aDayOfHeartRate(daysAgo: number, floor: number): Measurement[] {
    // UTC 06:00–23:00 is 01:00–18:00 in Chicago, so a "day" here is one of HIS
    // days rather than one that straddles two — which is what the window's
    // `observed` count is about.
    return Array.from({ length: 18 }, (_, index) =>
      at(daysAgo, index + 6, index < 6 ? floor : floor + 16),
    );
  }

  it("should estimate a resting figure from raw heart rate, and say that it did", () => {
    const measurements: Measurement[] = [];
    for (let back = 1; back <= 20; back += 1) measurements.push(...aDayOfHeartRate(back, 52));

    const derived = derive({
      series: { heartRate: measurements },
      now: NOW,
      tz: CHICAGO,
    });
    const resting = derived.series.find((one) => one.type === "restingHeartRate");
    expect(resting?.derivedFrom).toBe("heartRate");
    expect(resting?.evidence).toBe("estimated");
    expect(resting?.latest?.figure).toBe(52);

    // And the raw series is still itself: the estimate is a second reading of
    // the same numbers, not a replacement for them.
    const raw = derived.series.find((one) => one.type === "heartRate");
    expect(raw?.derivedFrom).toBeNull();
    expect(raw?.latest?.figure).toBeGreaterThan(60);
  });

  it("should leave the measured series alone when his device does record one", () => {
    const derived = derive({
      series: {
        heartRate: aDayOfHeartRate(1, 52),
        restingHeartRate: [at(1, 8, 49)],
      },
      now: NOW,
      tz: CHICAGO,
    });
    const resting = derived.series.find((one) => one.type === "restingHeartRate");
    expect(resting?.derivedFrom).toBeNull();
    expect(resting?.evidence).toBe("measured");
    expect(resting?.latest?.figure).toBe(49);
  });

  it("should not count an estimate as a day that was observed", () => {
    const derived = derive({
      series: { heartRate: aDayOfHeartRate(1, 52) },
      now: NOW,
      tz: CHICAGO,
    });
    // One day of raw heart rate is one observed day, not two.
    expect(derived.window.observed).toBe(1);
  });
});

describe("health derivations — empty is not denied", () => {
  it("should call a proven-authorised silence evidence and an unproven one nothing", () => {
    const derived = derive({
      series: { steps: [at(1, 14, 5_000)] },
      authorisation: {
        sleep: "authorised",
        heartRate: "denied",
        heartRateVariability: "unavailable",
        bodyMass: "undisclosed",
      },
      now: NOW,
      tz: CHICAGO,
    });
    const evidence = (type: HealthType): string =>
      derived.series.find((one) => one.type === type)?.evidence ?? "?";

    expect(evidence("steps")).toBe("measured");
    // He was allowed to be looked at and there is genuinely nothing.
    expect(evidence("sleep")).toBe("silent");
    // Everything else is a fact about his phone, not about him.
    expect(evidence("heartRate")).toBe("unproven");
    expect(evidence("heartRateVariability")).toBe("unproven");
    expect(evidence("bodyMass")).toBe("unproven");
    // Never reported on at all is also not `denied`.
    expect(evidence("workout")).toBe("unproven");
  });

  it("should return one derivation per type, always, in contract order", () => {
    const derived = derive({ series: {}, now: NOW, tz: CHICAGO });
    expect(derived.series.map((one) => one.type)).toEqual([...HEALTH_TYPES]);
    expect(derived.anyMeasurement).toBe(false);
  });
});

describe("health derivations — the window a conclusion names", () => {
  it("should describe the days that actually carried a measurement", () => {
    const measurements: Measurement[] = [];
    for (let back = 1; back <= 14; back += 1) measurements.push(at(back, 14, 400));
    const derived = derive({ series: { sleep: measurements }, now: NOW, tz: CHICAGO });

    expect(derived.window.observed).toBe(14);
    expect(describeWindow(derived.window)).toBe(
      "14 days of measurement, 30 July 2026 – 12 August 2026",
    );
  });

  it("should span the whole lookback whether or not anything was measured in it", () => {
    const derived = derive({ series: {}, now: NOW, tz: CHICAGO });
    expect(derived.window.span).toBe(DEFAULT_RECENT_DAYS + DEFAULT_BASELINE_DAYS);
    expect(derived.window.to).toBe("2026-08-13");
    expect(derived.window.firstObserved).toBeNull();
    expect(describeWindow(derived.window)).toContain("no days of measurement");
  });

  it("should be deterministic — same input, same output, no clock anywhere", () => {
    const series = { steps: [at(1, 14, 5_000), at(2, 14, 6_000)] };
    const first = derive({ series, now: NOW, tz: CHICAGO });
    const second = derive({ series, now: NOW, tz: CHICAGO });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
