import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HealthSampleInput, HealthType } from "../../src/health/contract.js";
import {
  DEFAULT_RETENTION_DAYS,
  DOWNSAMPLED_SOURCE,
  downsampleHealth,
  isAggregate,
} from "../../src/health/downsample.js";
import { HealthSamples } from "../../src/health/samples.js";
import { fixedClock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * `syl-t9tj.2.7` (T011) — full resolution inside sixty days, daily aggregates
 * outside it, and safe to run twice.
 *
 * The two things worth proving here are the two things that would be silently
 * wrong: that the fold is a **fixed point** (so "idempotent" is a fact about the
 * arithmetic rather than a flag somebody has to keep true), and that a day means
 * HIS day (so a reading at 23:40 is not folded into tomorrow).
 */

const CHICAGO = "America/Chicago";
/** 13 August 2026, 08:00 UTC — 03:00 in his zone. */
const NOW = Date.UTC(2026, 7, 13, 8, 0, 0, 0);
const DAY_MS = 24 * 60 * 60_000;

let database: SylDatabase;
let samples: HealthSamples;

beforeEach(() => {
  database = openDatabase({ path: IN_MEMORY });
  samples = new HealthSamples({ db: database.handle, clock: fixedClock(NOW) });
});

afterEach(() => {
  database.close();
});

function reading(type: HealthType, daysAgo: number, hourUtc: number, value: number, source = "Apple Watch"): HealthSampleInput {
  const stamp = new Date(NOW - daysAgo * DAY_MS + (hourUtc - 8) * 3_600_000).toISOString();
  return { type, startedAt: stamp, endedAt: stamp, value, source };
}

function rowsOf(type: HealthType): { started_at: string; ended_at: string; value: number; source: string }[] {
  return database.handle
    .prepare(
      "SELECT started_at, ended_at, value, source FROM health_samples WHERE type = ? ORDER BY started_at",
    )
    .all(type)
    .map((row) => row as unknown as { started_at: string; ended_at: string; value: number; source: string });
}

function fold(retentionDays = DEFAULT_RETENTION_DAYS): ReturnType<typeof downsampleHealth> {
  return downsampleHealth({
    db: database.handle,
    tz: CHICAGO,
    clock: fixedClock(NOW),
    retentionDays,
  });
}

describe("the 60-day downsample", () => {
  it("should keep everything inside the retention window at full resolution", () => {
    samples.append({
      samples: [
        reading("heartRate", 1, 10, 60),
        reading("heartRate", 1, 14, 70),
        reading("heartRate", 59, 10, 61),
        reading("heartRate", 59, 14, 71),
      ],
    });

    const outcome = fold();
    expect(outcome.daysFolded).toBe(0);
    expect(outcome.samplesReplaced).toBe(0);
    expect(rowsOf("heartRate")).toHaveLength(4);
  });

  it("should fold a day older than the window into one row per type", () => {
    samples.append({
      samples: [
        reading("heartRate", 90, 10, 60),
        reading("heartRate", 90, 14, 70),
        reading("steps", 90, 10, 3_000),
        reading("steps", 90, 14, 2_000, "iPhone"),
      ],
    });

    const outcome = fold();
    expect(outcome.daysFolded).toBe(1);
    expect(outcome.samplesReplaced).toBe(4);
    expect(outcome.aggregatesWritten).toBe(2);

    const heart = rowsOf("heartRate");
    expect(heart).toHaveLength(1);
    // Sampled type: the day's mean.
    expect(heart[0]?.value).toBe(65);
    expect(heart[0]?.source).toBe(DOWNSAMPLED_SOURCE);
    expect(isAggregate(heart[0]?.source ?? "")).toBe(true);

    const steps = rowsOf("steps");
    expect(steps).toHaveLength(1);
    // Accumulating type: the day's total, across both devices.
    expect(steps[0]?.value).toBe(5_000);
  });

  it("should span exactly one of HIS days, midnight to midnight in his zone", () => {
    samples.append({
      samples: [
        // 04:00 UTC is 23:00 the previous evening in Chicago. Folding it into
        // the UTC day would file his whole evening under tomorrow.
        reading("steps", 90, 4, 1_000),
        reading("steps", 90, 20, 2_000),
      ],
    });
    fold();

    const rows = rowsOf("steps");
    // Two of his days, therefore two aggregates — not one.
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const start = Date.parse(row.started_at);
      const end = Date.parse(row.ended_at);
      expect(end - start).toBe(DAY_MS);
      const wall = new Intl.DateTimeFormat("en-GB", {
        timeZone: CHICAGO,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(start));
      expect(wall).toBe("00:00");
    }
  });

  it("should be a fixed point: running it twice changes nothing and writes nothing", () => {
    samples.append({
      samples: [
        reading("heartRate", 90, 10, 60),
        reading("heartRate", 90, 14, 70),
        reading("sleep", 90, 10, 200),
        reading("sleep", 90, 12, 180),
      ],
    });

    fold();
    const after = {
      heartRate: rowsOf("heartRate"),
      sleep: rowsOf("sleep"),
    };

    const second = fold();
    expect(second.daysFolded).toBe(0);
    expect(second.samplesReplaced).toBe(0);
    expect(second.aggregatesWritten).toBe(0);
    expect(rowsOf("heartRate")).toEqual(after.heartRate);
    expect(rowsOf("sleep")).toEqual(after.sleep);
  });

  it("should survive a daylight-saving day, which is 23 or 25 hours long", () => {
    // 8 March 2026 is the spring-forward Sunday in Chicago: that local day is
    // 23 hours. A day computed as "start plus 24 hours" would swallow an hour
    // of the 9th.
    const springForward = Date.UTC(2026, 2, 8, 12, 0, 0, 0);
    const at = (offsetHours: number, value: number): HealthSampleInput => {
      const stamp = new Date(springForward + offsetHours * 3_600_000).toISOString();
      return { type: "steps", startedAt: stamp, endedAt: stamp, value, source: "iPhone" };
    };
    samples.append({ samples: [at(0, 100), at(6, 200), at(18, 400)] });

    downsampleHealth({
      db: database.handle,
      tz: CHICAGO,
      clock: fixedClock(NOW),
      retentionDays: 30,
    });

    const rows = rowsOf("steps");
    // 12:00 and 18:00 UTC are the 8th in Chicago; 06:00 UTC on the 9th is the
    // 9th. Two of his days.
    expect(rows).toHaveLength(2);
    const eighth = rows[0];
    expect(eighth?.value).toBe(300);
    // 23 hours, not 24.
    expect(Date.parse(eighth?.ended_at ?? "") - Date.parse(eighth?.started_at ?? "")).toBe(
      23 * 3_600_000,
    );
  });

  it("should do nothing at all against an empty store", () => {
    const outcome = fold();
    expect(outcome).toEqual({
      daysFolded: 0,
      samplesReplaced: 0,
      aggregatesWritten: 0,
      fullResolutionFrom: "2026-06-15",
      more: false,
    });
  });

  it("should refuse a retention that would fold a day before it has finished", () => {
    expect(() => fold(0)).toThrow(/positive whole number of days/u);
  });

  it("should leave the watermark alone, because a fold is not an upload", () => {
    samples.append({ samples: [reading("steps", 90, 12, 4_000)] });
    const before = samples.watermark("steps");
    fold();
    expect(samples.watermark("steps")).toBe(before);
  });

  it("should not touch the memory graph, because there is no path to it", () => {
    samples.append({ samples: [reading("heartRate", 90, 12, 60)] });
    const nodes = database.handle.prepare("SELECT count(*) AS n FROM memory_nodes").get();
    fold();
    const after = database.handle.prepare("SELECT count(*) AS n FROM memory_nodes").get();
    expect(after).toEqual(nodes);
  });
});
