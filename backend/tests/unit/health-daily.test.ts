import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthType,
} from "../../src/health/contract.js";
import { derivationSpan, derive } from "../../src/health/derive.js";
import { downsampleHealth, DOWNSAMPLED_SOURCE } from "../../src/health/downsample.js";
import { HealthSampleError, HealthSamples, type HealthSample } from "../../src/health/samples.js";
import { summariseHealth } from "../../src/health/summarise.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { seedHealthCorpus } from "../helpers/health-corpus.js";
import { testDatabase } from "../helpers/service.js";

/**
 * THE TWO DOORS INTO `derive()` MUST PRODUCE THE SAME NUMBERS.
 *
 * `syl-8ys9.2.1` (T006). The summary verb now reads days aggregated inside
 * SQLite rather than raw rows bucketed in JavaScript, which is what took it
 * from 8.675 seconds to well under one. Speed was the easy half.
 *
 * The hard half is this: a baseline that quietly shifted when the read path
 * changed would make her conclusions change for reasons nothing recorded. So
 * every test here computes one corpus BOTH ways and demands they agree
 * **exactly** — `toEqual`, not a tolerance. A tolerance would be a decision
 * about how much silent drift is acceptable, and there is no such quantity.
 *
 * Two things had to be carried to make that true, and each is pinned below:
 *
 *  - **Compensated summation.** SQLite's `sum()` is Kahan-Babuska-Neumaier and
 *    a plain `+=` in JavaScript is not, so over a day of 464 readings the two
 *    differ in the last bits. `derive.ts` now sums the same way SQLite does.
 *  - **The quiet floor.** `DailyStat.low` is the one figure that IS finer than
 *    a day — a within-day percentile — so it is computed by nearest rank on
 *    both sides, through the same exported `percentileRank`.
 *
 * The corpus carries fractional values on purpose. Round numbers sum exactly
 * and would let the first of those rot without a test noticing.
 */

const NOW = Date.parse("2026-08-13T18:00:00.000Z");
const TZ = "America/Chicago";

let db: SylDatabase;
let health: HealthSamples;

beforeEach(() => {
  db = testDatabase();
  health = new HealthSamples({ db: db.handle, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

/** Everything held for a type, unbounded, as the raw path would read it. */
function rawSeries(types: readonly HealthType[]): Partial<Record<HealthType, readonly HealthSample[]>> {
  const series: Partial<Record<HealthType, readonly HealthSample[]>> = {};
  for (const type of types) series[type] = health.series({ type, limit: 500_000 });
  return series;
}

/** The whole derivation, computed the slow way. The reference. */
function deriveFromRawRows(now: number, tz: string): ReturnType<typeof derive> {
  return derive({ series: rawSeries(HEALTH_TYPES), now, tz });
}

/** The whole derivation, computed from SQL day aggregates. */
function deriveFromAggregates(now: number, tz: string): ReturnType<typeof derive> {
  const span = derivationSpan({ now, tz });
  const days = health.daily({
    types: HEALTH_TYPES,
    from: span.baselineFrom,
    to: span.today,
    tz,
  });
  return derive({
    days: Object.fromEntries(HEALTH_TYPES.map((type) => [type, days[type] ?? []])),
    now,
    tz,
  });
}

describe("HealthSamples.daily", () => {
  it("should produce exactly the days derive() would have bucketed from the raw rows", () => {
    seedHealthCorpus(health, { now: NOW, days: 24 });

    const span = derivationSpan({ now: NOW, tz: TZ });
    const aggregated = health.daily({
      types: HEALTH_TYPES,
      from: span.baselineFrom,
      to: span.today,
      tz: TZ,
    });
    const raw = derive({ series: rawSeries(HEALTH_TYPES), now: NOW, tz: TZ });

    for (const derivation of raw.series) {
      // `restingHeartRate` is ESTIMATED from heart rate rather than measured, so
      // it has no aggregate of its own to compare against. The estimate is
      // exercised end to end by the summary test below.
      if (derivation.derivedFrom !== null) continue;
      expect(aggregated[derivation.type] ?? [], `type ${derivation.type}`).toEqual(derivation.days);
    }
  });

  it("should sum a day the way SQLite does, on a day where a plain += would not", () => {
    // THE DAY IS BUILT TO SEPARATE THEM, and it is worth saying why rather than
    // reaching for a real-looking corpus.
    //
    // Kahan-Babuska-Neumaier and a naive `+=` agree on values of one magnitude,
    // so a day of 400 heart-rate readings between 48 and 120 does NOT expose
    // the difference — measured, on the corpus this file uses everywhere else.
    // Which means a test written against his real shape would pass whichever
    // summation `derive.ts` used, and would go on passing after the two doors
    // stopped agreeing.
    //
    // So this day mixes magnitudes: a few large readings among many tiny ones,
    // where the tiny ones fall off the end of the large ones' mantissa. That is
    // the only kind of day the difference is visible on, and pinning it is
    // pinning the mechanism rather than a symptom.
    const values: number[] = [];
    for (let i = 0; i < 800; i += 1) values.push(i % 199 === 0 ? 1e11 + i : 1e-5 * (i + 1));

    const day = "2026-08-12";
    health.append({
      samples: values.map((value, index) => {
        const at = new Date(Date.parse("2026-08-12T12:00:00.000Z") + index * 1_000).toISOString();
        return { type: "steps" as HealthType, startedAt: at, endedAt: at, value, source: "Oura" };
      }),
    });

    const span = derivationSpan({ now: NOW, tz: TZ });
    const aggregated = health.daily({
      types: ["steps"],
      from: span.baselineFrom,
      to: span.today,
      tz: TZ,
    });
    const fromSql = (aggregated["steps"] ?? []).find((entry) => entry.day === day);
    const fromRaw = derive({ series: rawSeries(["steps"]), now: NOW, tz: TZ }).series
      .find((entry) => entry.type === "steps")
      ?.days.find((entry) => entry.day === day);

    let naive = 0;
    for (const value of values) naive += value;

    expect(fromSql).toBeDefined();
    // The two doors agree exactly. This is the assertion that matters.
    expect(fromSql?.total).toBe(fromRaw?.total);
    // And the day genuinely was one where naive summation would have split
    // them — otherwise the assertion above is proving nothing.
    expect(naive, "the fixture must be a day naive summation gets differently").not.toBe(
      fromSql?.total,
    );
  });

  it("should treat a day at a DST boundary as his day, not as 24 hours", () => {
    // 2026-11-01 is when America/Chicago falls back: a 25-hour local day. A
    // bucket built by subtracting a fixed offset would put an hour of it in the
    // wrong day, and the two paths would disagree about a Sunday every autumn.
    const november = Date.parse("2026-11-04T18:00:00.000Z");
    seedHealthCorpus(health, { now: november, days: 12, perDay: { heartRate: 240, steps: 200 } });

    expect(deriveFromAggregates(november, TZ)).toEqual(deriveFromRawRows(november, TZ));

    const span = derivationSpan({ now: november, tz: TZ });
    const aggregated = health.daily({ types: ["heartRate"], from: span.baselineFrom, to: span.today, tz: TZ });
    const longDay = (aggregated["heartRate"] ?? []).find((day) => day.day === "2026-11-01");
    const ordinary = (aggregated["heartRate"] ?? []).find((day) => day.day === "2026-11-02");

    // Seeded at a fixed rate per day, so the 25-hour day genuinely holds more
    // readings than the 24-hour one beside it. If both came back the same size
    // the boundaries were fixed-width and the test would be proving nothing.
    expect(longDay).toBeDefined();
    expect(ordinary).toBeDefined();
    expect(longDay?.count).toBeGreaterThan(ordinary?.count ?? 0);
  });

  it("should agree with the raw rows ACROSS the sixty-day seam, where both kinds of row exist", () => {
    // Inside sixty days there are raw rows; outside, only `syl:daily`
    // aggregates. A path that were correct on one side and not the other would
    // be correct today and wrong the first night the fold ran on real history.
    seedHealthCorpus(health, {
      now: NOW,
      days: 80,
      perDay: { heartRate: 60, steps: 40, sleep: 6 },
    });
    const folded = downsampleHealth({ db: db.handle, tz: TZ, clock: fixedClock(NOW) });
    expect(folded.daysFolded).toBeGreaterThan(0);

    const mixed = health.series({ type: "heartRate", limit: 500_000 });
    expect(mixed.some((row) => row.source === DOWNSAMPLED_SOURCE)).toBe(true);
    expect(mixed.some((row) => row.source !== DOWNSAMPLED_SOURCE)).toBe(true);

    // A baseline long enough to reach past the seam, so the window genuinely
    // straddles it rather than sitting inside the retention period.
    const now = NOW;
    const span = derivationSpan({ now, tz: TZ, recentDays: 7, baselineDays: 70 });
    const days = health.daily({ types: HEALTH_TYPES, from: span.baselineFrom, to: span.today, tz: TZ });

    expect(
      derive({
        days: Object.fromEntries(HEALTH_TYPES.map((type) => [type, days[type] ?? []])),
        now,
        tz: TZ,
        recentDays: 7,
        baselineDays: 70,
      }),
    ).toEqual(derive({ series: rawSeries(HEALTH_TYPES), now, tz: TZ, recentDays: 7, baselineDays: 70 }));
  });

  it("should leave a type with nothing in it absent rather than empty, so silence stays a separate answer", () => {
    seedHealthCorpus(health, { now: NOW, days: 3, perDay: { steps: 10 } });

    const span = derivationSpan({ now: NOW, tz: TZ });
    const aggregated = health.daily({
      types: ["steps", "heartRateVariability"],
      from: span.baselineFrom,
      to: span.today,
      tz: TZ,
    });

    expect(aggregated["steps"]).toBeDefined();
    expect(aggregated).not.toHaveProperty("heartRateVariability");
  });

  it("should refuse a type it does not know, rather than answering about nothing", () => {
    expect(() =>
      health.daily({
        types: ["bloodPressure" as HealthType],
        from: "2026-08-01",
        to: "2026-08-13",
        tz: TZ,
      }),
    ).toThrow(HealthSampleError);
  });

  it("should answer nothing for an empty type list or a window that runs backwards", () => {
    seedHealthCorpus(health, { now: NOW, days: 2, perDay: { steps: 10 } });

    expect(health.daily({ types: [], from: "2026-08-01", to: "2026-08-13", tz: TZ })).toEqual({});
    expect(health.daily({ types: ["steps"], from: "2026-08-13", to: "2026-08-01", tz: TZ })).toEqual({});
  });
});

describe("summariseHealth, from aggregates", () => {
  it("should produce the same summary it would have produced from raw rows", () => {
    seedHealthCorpus(health, { now: NOW, days: 40 });

    const fromAggregates = summariseHealth({ samples: health, now: NOW, tz: TZ });

    // The same object, computed the slow way: every type's raw rows, bucketed
    // by `derive` itself, then reduced to digests by hand exactly as
    // `summariseHealth` does.
    const raw = deriveFromRawRows(NOW, TZ);
    expect(fromAggregates.window).toEqual(raw.window);
    expect(fromAggregates.recentDays).toBe(raw.recentDays);
    expect(fromAggregates.baselineDays).toBe(raw.baselineDays);

    for (const digest of fromAggregates.types) {
      const reference = raw.series.find((entry) => entry.type === digest.type);
      expect(reference, `type ${digest.type}`).toBeDefined();
      expect(digest.days, `days for ${digest.type}`).toBe(reference?.days.length);
      expect(digest.derivedFrom, `derivedFrom for ${digest.type}`).toBe(reference?.derivedFrom);
      expect(digest.recent, `recent for ${digest.type}`).toEqual(reference?.recent);
      expect(digest.baseline, `baseline for ${digest.type}`).toEqual(reference?.baseline);
      expect(digest.deviation, `deviation for ${digest.type}`).toEqual(reference?.deviation);
      expect(digest.run, `run for ${digest.type}`).toEqual(reference?.run);
      expect(digest.latest, `latest for ${digest.type}`).toEqual(reference?.latest);
    }
  });

  it("should still estimate his resting heart rate from the quiet floor, which is a WITHIN-DAY figure", () => {
    // The one thing the summary computes that is finer than a day, and
    // therefore the one thing that could not survive being handed a daily mean.
    // He has no resting-heart-rate readings at all — Oura does not publish
    // them — so this is not an optimisation of a spare path, it is the only way
    // he ever has that number.
    seedHealthCorpus(health, { now: NOW, days: 40 });

    const summary = summariseHealth({ samples: health, now: NOW, tz: TZ });
    const resting = summary.types.find((entry) => entry.type === "restingHeartRate");
    const raw = deriveFromRawRows(NOW, TZ).series.find((entry) => entry.type === "restingHeartRate");

    expect(resting?.derivedFrom).toBe("heartRate");
    expect(resting?.latest).toEqual(raw?.latest);
    expect(resting?.baseline).toEqual(raw?.baseline);
    expect(resting?.deviation).toEqual(raw?.deviation);
  });

  it("should narrow to the types asked for and answer about those identically", () => {
    seedHealthCorpus(health, { now: NOW, days: 20 });

    const all = summariseHealth({ samples: health, now: NOW, tz: TZ });
    const one = summariseHealth({ samples: health, now: NOW, tz: TZ, types: ["sleep"] });

    expect(one.types).toHaveLength(1);
    expect(one.types[0]).toEqual(all.types.find((entry) => entry.type === "sleep"));
  });

  it("should read a type that is authorised and empty as silence, and an unreported one as unproven", () => {
    const report: Partial<Record<HealthType, AuthorisationState>> = {};
    for (const type of HEALTH_TYPES) report[type] = "authorised";
    report["bodyMass"] = "denied";
    seedHealthCorpus(health, { now: NOW, days: 3, perDay: { steps: 20 }, authorisation: report });

    const summary = summariseHealth({ samples: health, now: NOW, tz: TZ });
    const vo2 = summary.types.find((entry) => entry.type === "vo2Max");
    const mass = summary.types.find((entry) => entry.type === "bodyMass");

    expect(vo2?.days).toBe(0);
    expect(vo2?.silenceIsEvidence).toBe(true);
    expect(mass?.silenceIsEvidence).toBe(false);
  });
});
