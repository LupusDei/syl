import { describe, expect, it } from "vitest";

import {
  AUTHORISATION_STATES,
  HEALTH_TYPES,
  SERIES_CAP,
  STANDINGS,
  TYPE_LABELS,
  authorisationDisagrees,
  fleetHeadline,
  fleetTone,
  formatCount,
  formatValue,
  isHistoricOnly,
  pointsAttribute,
  readingOf,
  silenceIsEvidence,
  sparklineSegments,
  standingDescriptor,
  standingOf,
  summarise,
  summariseTypes,
  windowChoice,
  windowRange,
  type AuthorisationState,
  type HealthSample,
  type HealthSeries,
  type HealthType,
  type Standing,
} from "../../src/features/health/health-model";

/**
 * The health viewer's decisions.
 *
 * Everything load-bearing in this file is one distinction: an empty window is
 * either a fact about his body or a fact about his phone, and the code must
 * never be able to say the second while looking like the first.
 */

function series(overrides: Partial<HealthSeries> = {}): HealthSeries {
  return {
    type: "steps",
    unit: "count",
    state: "authorised",
    reportedAt: "2026-08-13T06:00:00.000Z",
    silenceIsEvidence: true,
    watermark: "2026-08-13T05:00:00.000Z",
    samples: [],
    ...overrides,
  };
}

function sample(overrides: Partial<HealthSample> = {}): HealthSample {
  return {
    type: "steps",
    startedAt: "2026-08-13T05:00:00.000Z",
    endedAt: "2026-08-13T05:01:00.000Z",
    value: 100,
    source: "iPhone",
    recordedAt: "2026-08-13T05:02:00.000Z",
    ...overrides,
  };
}

const ALL_STANDINGS: readonly Standing[] = [...AUTHORISATION_STATES, "unreported"];

describe("standings", () => {
  it("should describe every one of the six standings, so none can render blank", () => {
    for (const standing of ALL_STANDINGS) {
      const descriptor = STANDINGS[standing];
      expect(descriptor.label.length, standing).toBeGreaterThan(0);
      expect(descriptor.mark.length, standing).toBeGreaterThan(0);
      expect(descriptor.headline.length, standing).toBeGreaterThan(0);
      expect(descriptor.silenceMeans.length, standing).toBeGreaterThan(0);
    }
  });

  it("should lead every standing with a DIFFERENT sentence", () => {
    const headlines = ALL_STANDINGS.map((standing) => STANDINGS[standing].headline);
    expect(new Set(headlines).size).toBe(headlines.length);
  });

  it("should give every standing a DISTINCT label, glyph and tone triple", () => {
    // The whole requirement in one assertion. Two states that share all three
    // channels are two facts he cannot tell apart on the screen.
    const fingerprints = ALL_STANDINGS.map((standing) => {
      const descriptor = STANDINGS[standing];
      return `${descriptor.label}|${descriptor.mark}|${descriptor.tone}`;
    });
    expect(new Set(fingerprints).size).toBe(ALL_STANDINGS.length);
  });

  it("should give every standing its own label, so none is a synonym of another", () => {
    const labels = ALL_STANDINGS.map((standing) => STANDINGS[standing].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("should give every standing its own glyph, so colour is never the only channel", () => {
    const marks = ALL_STANDINGS.map((standing) => STANDINGS[standing].mark);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it("should say a DIFFERENT thing about each state that has anything to say", () => {
    // Telling him to grant a permission he already granted is useless advice,
    // and identical remedies is exactly what produces it.
    const remedies = ALL_STANDINGS.map((standing) => STANDINGS[standing].remedy).filter(
      (remedy): remedy is string => remedy !== null,
    );
    expect(remedies.length).toBe(ALL_STANDINGS.length - 1);
    expect(new Set(remedies).size).toBe(remedies.length);
  });

  it("should offer no remedy for a type nothing is wrong with", () => {
    expect(STANDINGS.authorised.remedy).toBeNull();
  });

  it("should NEVER advise buying hardware, because no state reports a missing sensor", () => {
    // `isHealthDataAvailable()` answers device-wide only. A phone with no watch
    // reports HRV as `undisclosed`, so "buy a watch" is advice this surface
    // cannot substantiate for any type. An earlier draft rendered it.
    for (const standing of ALL_STANDINGS) {
      expect(STANDINGS[standing].remedy ?? "", standing).not.toMatch(/buy|purchase/i);
    }
    expect(STANDINGS.unavailable.remedy).not.toMatch(/watch/i);
  });

  it("should describe `unavailable` as device-wide rather than as one type's sensor", () => {
    expect(STANDINGS.unavailable.remedy).toMatch(/device-wide/i);
    expect(STANDINGS.unavailable.silenceMeans).toMatch(/any other/i);
  });

  it("should tell him there is nothing to do when iOS will not confirm a read grant", () => {
    // The common case on this platform. Sending him to Settings for it is the
    // useless advice a collapsed display produces.
    expect(STANDINGS.undisclosed.remedy).toMatch(/nothing to do/i);
    expect(STANDINGS.undisclosed.remedy).not.toMatch(/Privacy & Security/);
  });

  it("should record that no current client can prove a refusal", () => {
    // `denied` is reserved: read authorisation is exactly what iOS will not
    // disclose, so one in the store did not come from the phone.
    expect(STANDINGS.denied.remedy).toMatch(/no current client can PROVE a refusal/);
  });

  it("should treat ONLY authorised as a state where silence is evidence", () => {
    for (const standing of ALL_STANDINGS) {
      expect(STANDINGS[standing].evidence, standing).toBe(standing === "authorised");
    }
  });

  it("should read a null state as `unreported`, never as `denied`", () => {
    // A build too old to send a report and a permission he refused are
    // different facts; conflating them tells him he said no to something
    // nobody ever asked him about.
    expect(standingOf(null)).toBe("unreported");
    expect(standingDescriptor(null).label).not.toBe(STANDINGS.denied.label);
  });

  it("should map each wire state to itself", () => {
    for (const state of AUTHORISATION_STATES) {
      expect(standingOf(state)).toBe(state);
    }
  });
});

describe("silenceIsEvidence", () => {
  it("should accept the wire flag when the state beside it agrees", () => {
    expect(silenceIsEvidence(series({ state: "authorised", silenceIsEvidence: true }))).toBe(true);
  });

  it("should refuse a true flag when the state is NOT authorised", () => {
    // Fail closed. Being wrong this way costs a hatched panel; being wrong the
    // other way draws a flat line that lies about his body.
    expect(silenceIsEvidence(series({ state: "denied", silenceIsEvidence: true }))).toBe(false);
  });

  it("should refuse an authorised state when the server says the silence proves nothing", () => {
    expect(silenceIsEvidence(series({ state: "authorised", silenceIsEvidence: false }))).toBe(false);
  });

  it("should never call silence evidence for any non-authorised state", () => {
    for (const state of AUTHORISATION_STATES) {
      if (state === "authorised") continue;
      expect(silenceIsEvidence(series({ state, silenceIsEvidence: true })), state).toBe(false);
    }
  });

  it("should refuse silence as evidence when nobody has ever reported on the type", () => {
    expect(silenceIsEvidence(series({ state: null, silenceIsEvidence: false }))).toBe(false);
  });
});

describe("authorisationDisagrees", () => {
  it("should stay quiet when the flag and the state say the same thing", () => {
    expect(authorisationDisagrees(series({ state: "authorised", silenceIsEvidence: true }))).toBe(
      false,
    );
    expect(authorisationDisagrees(series({ state: "denied", silenceIsEvidence: false }))).toBe(
      false,
    );
  });

  it("should report a server contradicting itself rather than quietly correcting it", () => {
    expect(authorisationDisagrees(series({ state: "denied", silenceIsEvidence: true }))).toBe(true);
  });
});

describe("readingOf", () => {
  it("should call a type with samples a chart", () => {
    expect(readingOf({ type: "steps", series: series({ samples: [sample()] }), failed: false })).toBe(
      "samples",
    );
  });

  it("should call an authorised empty window a MEASURED zero", () => {
    expect(readingOf({ type: "steps", series: series(), failed: false })).toBe("measuredZero");
  });

  it("should call an undisclosed empty window `notLooked`, never a measured zero", () => {
    // The bead in one assertion, on the state his real data actually carries:
    // three of his seven types come back `undisclosed`, and an empty chart for
    // one of those must not read like an empty chart for authorised steps.
    expect(
      readingOf({
        type: "heartRateVariability",
        series: series({ state: "undisclosed", silenceIsEvidence: false }),
        failed: false,
      }),
    ).toBe("notLooked");
  });

  it("should distinguish every non-authorised empty window from the authorised one", () => {
    for (const state of AUTHORISATION_STATES) {
      const reading = readingOf({
        type: "steps",
        series: series({ state, silenceIsEvidence: state === "authorised" }),
        failed: false,
      });
      expect(reading, state).toBe(state === "authorised" ? "measuredZero" : "notLooked");
    }
  });

  it("should call a failed request `failed`, and not an empty type", () => {
    expect(readingOf({ type: "steps", series: null, failed: true })).toBe("failed");
  });

  it("should call a missing series `failed` rather than assuming it was empty", () => {
    expect(readingOf({ type: "steps", series: null, failed: false })).toBe("failed");
  });
});

describe("isHistoricOnly", () => {
  it("should flag rows held for a type the phone can no longer prove it may read", () => {
    // Revocation after proof is undetectable, so history from before it stays
    // true — and a full chart under a red chip would otherwise read as a bug.
    expect(
      isHistoricOnly({
        type: "steps",
        series: series({ state: "denied", silenceIsEvidence: false, samples: [sample()] }),
        failed: false,
      }),
    ).toBe(true);
  });

  it("should not flag an authorised type that is simply full of data", () => {
    expect(
      isHistoricOnly({ type: "steps", series: series({ samples: [sample()] }), failed: false }),
    ).toBe(false);
  });
});

describe("summarise", () => {
  it("should return nulls rather than zeroes for an empty window", () => {
    // A mean of 0 is a measurement. A mean of null is the absence of one, and
    // this surface must never invent the first from the second.
    const summary = summarise([]);
    expect(summary.count).toBe(0);
    expect(summary.mean).toBeNull();
    expect(summary.min).toBeNull();
    expect(summary.max).toBeNull();
    expect(summary.sources).toEqual([]);
  });

  it("should count every contributing source, commonest first", () => {
    const summary = summarise([
      sample({ source: "iPhone" }),
      sample({ source: "Oura", startedAt: "2026-08-13T05:10:00.000Z" }),
      sample({ source: "Oura", startedAt: "2026-08-13T05:20:00.000Z" }),
    ]);
    expect(summary.sources).toEqual([
      { source: "Oura", count: 2 },
      { source: "iPhone", count: 1 },
    ]);
  });

  it("should report the earliest and latest instants regardless of row order", () => {
    const summary = summarise([
      sample({ startedAt: "2026-08-13T09:00:00.000Z" }),
      sample({ startedAt: "2026-08-13T01:00:00.000Z" }),
    ]);
    expect(summary.first).toBe("2026-08-13T01:00:00.000Z");
    expect(summary.last).toBe("2026-08-13T09:00:00.000Z");
  });

  it("should compute min, max and mean over the values", () => {
    const summary = summarise([sample({ value: 10 }), sample({ value: 20 }), sample({ value: 30 })]);
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(30);
    expect(summary.mean).toBe(20);
  });

  it("should call a window truncated when it hits the store's cap", () => {
    // The route offers no `limit` and reports no count, so this magic number is
    // the only signal a client has that the newest rows were dropped.
    const rows = Array.from({ length: SERIES_CAP }, (_, index) =>
      sample({ startedAt: `2026-08-13T00:00:${String(index % 60).padStart(2, "0")}.000Z` }),
    );
    expect(summarise(rows).truncated).toBe(true);
  });

  it("should not call an ordinary window truncated", () => {
    expect(summarise([sample()]).truncated).toBe(false);
  });
});

describe("windowRange", () => {
  it("should span exactly the chosen number of days back from the pinned instant", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const range = windowRange(windowChoice("7d"), now);
    expect(range.to).toBe("2026-08-13T12:00:00.000Z");
    expect(range.from).toBe("2026-08-06T12:00:00.000Z");
  });

  it("should fall back to the shortest window for an unknown id", () => {
    expect(windowChoice("nonsense").days).toBe(1);
  });

  it("should default to a window short enough that heart rate is not capped", () => {
    // ~1,400 heart-rate samples a day against a 5,000 cap: a day fits, a week
    // does not, and an uncapped window is the only one whose counts are counts.
    expect(windowChoice("1d").days).toBe(1);
  });

  it("should offer no window longer than the 60-day retention horizon", () => {
    const longest = Math.max(...[1, 7, 30, 60]);
    expect(windowChoice("60d").days).toBe(longest);
  });
});

describe("sparklineSegments", () => {
  const range = { from: "2026-08-13T00:00:00.000Z", to: "2026-08-14T00:00:00.000Z" };
  const size = { width: 100, height: 10 };

  it("should draw nothing at all when there are no samples", () => {
    expect(sparklineSegments([], range, size)).toEqual([]);
  });

  it("should BREAK the line where the data stops, never drawing across a gap", () => {
    // A continuous line over an unmeasured gap is the small version of the lie
    // this whole view exists to prevent: it says the signal was there and steady.
    const segments = sparklineSegments(
      [
        sample({ startedAt: "2026-08-13T00:10:00.000Z", value: 1 }),
        sample({ startedAt: "2026-08-13T00:20:00.000Z", value: 2 }),
        sample({ startedAt: "2026-08-13T20:00:00.000Z", value: 3 }),
        sample({ startedAt: "2026-08-13T20:30:00.000Z", value: 4 }),
      ],
      range,
      size,
      24,
    );
    expect(segments.length).toBe(2);
  });

  it("should place a later sample further right than an earlier one", () => {
    const segments = sparklineSegments(
      [
        sample({ startedAt: "2026-08-13T01:00:00.000Z", value: 1 }),
        sample({ startedAt: "2026-08-13T02:00:00.000Z", value: 2 }),
      ],
      range,
      size,
      24,
    );
    const points = segments[0] ?? [];
    expect(points.length).toBe(2);
    expect((points[1]?.x ?? 0) > (points[0]?.x ?? 0)).toBe(true);
  });

  it("should put the larger value HIGHER on the screen", () => {
    const segments = sparklineSegments(
      [
        sample({ startedAt: "2026-08-13T01:00:00.000Z", value: 1 }),
        sample({ startedAt: "2026-08-13T02:00:00.000Z", value: 9 }),
      ],
      range,
      size,
      24,
    );
    const points = segments[0] ?? [];
    // SVG y grows downward.
    expect((points[1]?.y ?? 0) < (points[0]?.y ?? 0)).toBe(true);
  });

  it("should draw a flat run down the middle, so it reads as neither a floor nor a ceiling", () => {
    const segments = sparklineSegments(
      [
        sample({ startedAt: "2026-08-13T01:00:00.000Z", value: 5 }),
        sample({ startedAt: "2026-08-13T02:00:00.000Z", value: 5 }),
      ],
      range,
      size,
      24,
    );
    for (const point of segments[0] ?? []) {
      expect(point.y).toBe(size.height / 2);
    }
  });

  it("should ignore samples outside the window rather than stretching to reach them", () => {
    expect(
      sparklineSegments([sample({ startedAt: "2020-01-01T00:00:00.000Z" })], range, size, 24),
    ).toEqual([]);
  });

  it("should refuse a range that does not move forwards", () => {
    expect(
      sparklineSegments([sample()], { from: range.to, to: range.from }, size, 24),
    ).toEqual([]);
  });

  it("should render points as an SVG `points` attribute", () => {
    expect(
      pointsAttribute([
        { x: 1.005, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toBe("1,2 3,4");
  });
});

describe("summariseTypes", () => {
  const authorisedEmpty = { type: "steps" as HealthType, series: series(), failed: false };
  const undisclosedEmpty = {
    type: "bodyMass" as HealthType,
    series: series({ state: "undisclosed" as AuthorisationState, silenceIsEvidence: false }),
    failed: false,
  };
  const flowing = {
    type: "heartRate" as HealthType,
    series: series({ samples: [sample()] }),
    failed: false,
  };
  const broken = { type: "sleep" as HealthType, series: null, failed: true };

  it("should count the two kinds of empty SEPARATELY", () => {
    const summary = summariseTypes([authorisedEmpty, undisclosedEmpty, flowing, broken]);
    expect(summary.measuredZero).toBe(1);
    expect(summary.notLooked).toBe(1);
    expect(summary.flowing).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("should never describe an unconfirmed type as having no data", () => {
    const headline = fleetHeadline(summariseTypes([undisclosedEmpty]));
    expect(headline).toMatch(/quiet proves nothing/);
    expect(headline).not.toMatch(/no data/i);
    // Nor as "not authorised" — `undisclosed` is narrower than that, and
    // claiming a refusal we cannot prove is the mirror image of the same bug.
    expect(headline).not.toMatch(/not authorised/i);
  });

  it("should say when types are authorised and genuinely quiet", () => {
    expect(fleetHeadline(summariseTypes([authorisedEmpty]))).toMatch(/authorised and quiet/);
  });

  it("should sound the alarm when a type could not be asked about", () => {
    expect(fleetTone(summariseTypes([broken]))).toBe("fail");
  });

  it("should warn when a type was not read, even with nothing broken", () => {
    expect(fleetTone(summariseTypes([undisclosedEmpty]))).toBe("warn");
  });

  it("should stay calm when everything was read", () => {
    expect(fleetTone(summariseTypes([authorisedEmpty, flowing]))).toBe("ok");
  });
});

describe("formatting", () => {
  it("should group thousands the same way on every machine", () => {
    // `toLocaleString` renders 29 962 on one machine and 29,962 on another,
    // which is a count two people cannot compare over a call.
    expect(formatCount(29962)).toBe("29,962");
    expect(formatCount(6)).toBe("6");
    expect(formatCount(1000)).toBe("1,000");
  });

  it("should render a missing value as a dash, never as zero", () => {
    expect(formatValue(null, "count/min")).toBe("—");
  });

  it("should keep one decimal for small values and none for large ones", () => {
    expect(formatValue(54.27, "count/min")).toBe("54.3 count/min");
    expect(formatValue(8431.4, "count")).toBe("8,431 count");
  });
});

describe("the type registry", () => {
  it("should label all seven stored types", () => {
    for (const type of HEALTH_TYPES) {
      expect(TYPE_LABELS[type].length, type).toBeGreaterThan(0);
    }
  });

  it("should carry the five authorisation states the contract defines", () => {
    expect([...AUTHORISATION_STATES]).toEqual([
      "authorised",
      "denied",
      "notDetermined",
      "undisclosed",
      "unavailable",
    ]);
  });
});
