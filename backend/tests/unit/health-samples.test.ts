import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUTHORISATION_STATES,
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthSampleInput,
  type HealthType,
} from "../../src/health/contract.js";
import {
  canonicalInstant,
  HealthSampleError,
  HealthSamples,
  MAX_SAMPLES_PER_APPEND,
} from "../../src/health/samples.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { testDatabase, TEST_NOW } from "../helpers/service.js";

/**
 * The observation store, against a real migrated database.
 *
 * A real one rather than a double, for the reason every store test here uses
 * one: the interesting failures in this layer are the UNIQUE index that fires
 * and the CHECK that does, and a mock has neither. `:memory:` makes it free.
 */

let db: SylDatabase;
let health: HealthSamples;

beforeEach(() => {
  db = testDatabase();
  health = new HealthSamples({ db: db.handle, clock: fixedClock(TEST_NOW) });
});

afterEach(() => {
  db.close();
});

function fullReport(
  overrides: Partial<Record<HealthType, AuthorisationState>> = {},
): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = overrides[type] ?? "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

const A_READING: HealthSampleInput = {
  type: "restingHeartRate",
  startedAt: "2026-08-11T03:12:00.000Z",
  endedAt: "2026-08-11T03:12:00.000Z",
  value: 54,
  source: "Apple Watch",
};

describe("canonicalInstant", () => {
  it("should accept the spellings a phone actually sends and reduce them to one", () => {
    expect(canonicalInstant("2026-08-11T03:12:00.000Z")).toBe("2026-08-11T03:12:00.000Z");
    expect(canonicalInstant("2026-08-11T03:12:00Z")).toBe("2026-08-11T03:12:00.000Z");
    expect(canonicalInstant("2026-08-11T03:12:00.123456Z")).toBe("2026-08-11T03:12:00.123Z");
  });

  it("should refuse a fixed UTC offset, which is constraint 5", () => {
    // An offset is a property of an instant rather than of a place, and one that
    // reaches storage survives exactly one DST boundary.
    expect(canonicalInstant("2026-08-11T03:12:00-05:00")).toBeNull();
    expect(canonicalInstant("2026-08-11T03:12:00+00:00")).toBeNull();
  });

  it("should refuse anything that is not an instant", () => {
    expect(canonicalInstant("2026-08-11")).toBeNull();
    expect(canonicalInstant("Aug 11 2026")).toBeNull();
    expect(canonicalInstant("")).toBeNull();
    expect(canonicalInstant(54)).toBeNull();
    expect(canonicalInstant(undefined)).toBeNull();
  });
});

describe("HealthSamples.append", () => {
  it("should write a batch and report what it wrote", () => {
    const outcome = health.append({ samples: [A_READING], authorisation: fullReport() });

    expect(outcome.written).toBe(1);
    expect(outcome.duplicates).toBe(0);
    expect(outcome.watermarks.restingHeartRate).toBe("2026-08-11T03:12:00.000Z");
    expect(health.count()).toBe(1);
  });

  it("should refuse the whole batch when one sample is malformed, rather than writing part of it", () => {
    expect(() =>
      health.append({
        samples: [
          A_READING,
          { ...A_READING, startedAt: "2026-08-11T03:12:00-05:00", source: "iPhone" },
        ],
      }),
    ).toThrow(HealthSampleError);

    // Nothing at all. A partial success is a success the phone has to reconcile
    // against a refusal, and it cannot: it does not know which rows landed.
    expect(health.count()).toBe(0);
  });

  it("should name the offending row and field", () => {
    try {
      health.append({ samples: [A_READING, { ...A_READING, value: Number.POSITIVE_INFINITY }] });
      expect.unreachable("an infinite value must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(HealthSampleError);
      expect((error as HealthSampleError).kind).toBe("bad_value");
      expect((error as HealthSampleError).field).toBe("samples[1].value");
    }
  });

  it("should refuse a sample that ends before it starts", () => {
    expect(() =>
      health.append({
        samples: [{ ...A_READING, endedAt: "2026-08-11T03:11:00.000Z" }],
      }),
    ).toThrow(/cannot end/u);
  });

  it("should refuse an unknown type", () => {
    expect(() =>
      // Safe cast: the point of the test is what happens when the type is wrong.
      health.append({ samples: [{ ...A_READING, type: "bloodPressure" as HealthType }] }),
    ).toThrow(/not a health type/u);
  });

  it("should refuse an empty source, which is half of a sample's identity", () => {
    expect(() => health.append({ samples: [{ ...A_READING, source: "   " }] })).toThrow(
      /identity/u,
    );
  });

  it("should refuse an incomplete authorisation report rather than defaulting it", () => {
    const partial = fullReport();
    const { bodyMass: _dropped, ...missingOne } = partial;

    expect(() =>
      health.append({
        samples: [],
        // Safe cast: the point of the test is the incomplete report.
        authorisation: missingOne as Record<HealthType, AuthorisationState>,
      }),
    ).toThrow(/bodyMass/u);

    expect(health.authorisation()).toEqual({});
  });

  it("should refuse a batch larger than one transaction should hold", () => {
    const oversized = Array.from({ length: MAX_SAMPLES_PER_APPEND + 1 }, (_unused, index) => ({
      ...A_READING,
      startedAt: new Date(TEST_NOW + index * 60_000).toISOString(),
      endedAt: new Date(TEST_NOW + index * 60_000).toISOString(),
    }));

    expect(() => health.append({ samples: oversized })).toThrow(/batched/u);
    expect(health.count()).toBe(0);
  });

  it("should record the authorisation report even when no samples come with it", () => {
    // The whole of an upload from a device whose permissions were all revoked.
    health.recordAuthorisation(fullReport({ steps: "denied", sleep: "denied" }));

    expect(health.authorisationFor("steps")?.state).toBe("denied");
    expect(health.authorisationFor("heartRate")?.state).toBe("authorised");
    expect(health.count()).toBe(0);
  });

  it("should store every state the contract names, exactly as reported", () => {
    // Written over `AUTHORISATION_STATES` rather than over a list of literals,
    // so a state added to the contract and refused by the migration's CHECK
    // fails here rather than on the Commander's phone. `syl-m3gi` widened this
    // enum from three to five mid-build.
    for (const [index, state] of AUTHORISATION_STATES.entries()) {
      const type = HEALTH_TYPES[index % HEALTH_TYPES.length] as HealthType;
      health.recordAuthorisation(fullReport({ [type]: state }));
      expect(health.authorisationFor(type)?.state).toBe(state);
    }
  });

  it("should overwrite an earlier authorisation report, because permission changes", () => {
    health.recordAuthorisation(fullReport({ steps: "notDetermined" }), "2026-08-10T09:00:00.000Z");
    expect(health.authorisationFor("steps")?.state).toBe("notDetermined");

    health.recordAuthorisation(fullReport({ steps: "authorised" }), "2026-08-11T09:00:00.000Z");
    expect(health.authorisationFor("steps")?.state).toBe("authorised");
    expect(health.authorisationFor("steps")?.reportedAt).toBe("2026-08-11T09:00:00.000Z");
  });
});

describe("HealthSamples watermarks", () => {
  it("should be absent for a type nothing has ever been held for", () => {
    expect(health.watermark("steps")).toBeNull();
    expect(health.watermarks()).toEqual({});
  });

  it("should sit at the furthest endedAt, not the furthest startedAt", () => {
    // A sleep block starts before midnight and ends after it. A phone resuming
    // from the start would re-read the same night forever.
    health.append({
      samples: [
        {
          type: "sleep",
          startedAt: "2026-08-10T22:41:00.000Z",
          endedAt: "2026-08-11T06:02:00.000Z",
          value: 441,
          source: "Apple Watch",
        },
      ],
    });

    expect(health.watermark("sleep")).toBe("2026-08-11T06:02:00.000Z");
  });

  it("should never move backwards", () => {
    health.append({ samples: [A_READING] });
    expect(health.watermark("restingHeartRate")).toBe("2026-08-11T03:12:00.000Z");

    // A backfill: older data, arriving later. It is written, and the resume
    // point stays where it was.
    const outcome = health.append({
      samples: [
        {
          ...A_READING,
          startedAt: "2026-08-04T03:12:00.000Z",
          endedAt: "2026-08-04T03:12:00.000Z",
        },
      ],
    });

    expect(outcome.written).toBe(1);
    expect(health.watermark("restingHeartRate")).toBe("2026-08-11T03:12:00.000Z");
  });

  it("should advance for a duplicate, because the row is held either way", () => {
    health.append({ samples: [A_READING] });
    db.handle.prepare("DELETE FROM health_watermarks").run();

    const outcome = health.append({ samples: [A_READING] });

    expect(outcome.written).toBe(0);
    expect(outcome.duplicates).toBe(1);
    // Held is held. Making the phone re-send a measurement forever because we
    // already had it is the same dropped-data failure wearing a busy loop.
    expect(health.watermark("restingHeartRate")).toBe("2026-08-11T03:12:00.000Z");
  });
});

describe("HealthSamples.series", () => {
  beforeEach(() => {
    health.append({
      samples: ["08", "09", "10", "11"].map((day, index) => ({
        type: "bodyMass" as const,
        startedAt: `2026-08-${day}T13:00:00.000Z`,
        endedAt: `2026-08-${day}T13:00:00.000Z`,
        value: 191 - index,
        source: "Withings",
      })),
    });
  });

  it("should return one type, oldest first", () => {
    const series = health.series({ type: "bodyMass" });
    expect(series.map((sample) => sample.value)).toEqual([191, 190, 189, 188]);
  });

  it("should bound the window, inclusive at the start and exclusive at the end", () => {
    const series = health.series({
      type: "bodyMass",
      from: "2026-08-09T00:00:00.000Z",
      to: "2026-08-11T00:00:00.000Z",
    });
    expect(series.map((sample) => sample.value)).toEqual([190, 189]);
  });

  it("should answer empty for a type that holds nothing, without inventing a reason", () => {
    // The store's job is the rows. Whether empty MEANS anything is
    // `health_authorisation`'s answer, and keeping the two apart is what stops a
    // reader from concluding anything from silence it cannot attribute.
    expect(health.series({ type: "steps" })).toEqual([]);
    expect(health.authorisationFor("steps")).toBeNull();
  });

  it("should refuse a window it cannot parse rather than reading it as unbounded", () => {
    expect(() => health.series({ type: "bodyMass", from: "yesterday" })).toThrow(
      HealthSampleError,
    );
  });
});
