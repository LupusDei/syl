import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthType,
} from "../../src/health/contract.js";
import { HealthSamples } from "../../src/health/samples.js";
import {
  CORROBORATED_DAYS,
  CORROBORATION_STALE_DAYS,
  summariseHealth,
  unpublishedTypes,
} from "../../src/health/summarise.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { seedHealthCorpus } from "../helpers/health-corpus.js";
import { testDatabase } from "../helpers/service.js";

/**
 * The judgement the phone cannot make.
 *
 * `syl-8ys9.3.1`. `HKHealthStore.isHealthDataAvailable()` answers device-wide,
 * so no client can say "this SOURCE does not carry this type". The server can,
 * because it is the only party that can see a type which has never once arrived
 * across weeks in which everything else did.
 *
 * Every test here is about the two ways that inference can be wrong, because
 * being wrong in either direction costs more than saying nothing:
 *
 *  - **Too eager** — he took the ring off for a fortnight, or revoked a grant,
 *    and she announces that his equipment cannot publish something it can.
 *  - **Too shy** — she goes on blaming his permissions for a vendor's
 *    integration gap, which is the defect this bead exists to fix.
 */

const NOW = Date.parse("2026-08-13T18:00:00.000Z");
const TZ = "America/Chicago";
const DAY_MS = 86_400_000;

let db: SylDatabase;
let health: HealthSamples;

beforeEach(() => {
  db = testDatabase();
  health = new HealthSamples({ db: db.handle, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

/** A complete report — the store refuses a partial one — with overrides. */
function reportWith(
  overrides: Partial<Record<HealthType, AuthorisationState>>,
): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = overrides[type] ?? "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

/**
 * HIS shape, exactly: two months of heart rate, sleep, steps and workouts from
 * the ring, and nothing whatsoever for heart rate variability or resting heart
 * rate — because Oura publishes neither.
 *
 * The authorisation defaults reproduce what his live store actually holds,
 * which is `denied` for the two absent types: written there by the build that
 * still narrowed `undisclosed` onto `denied`, and the exact label this bead
 * exists to stop.
 */
function seedHisShape(
  days = 62,
  overrides: Partial<Record<HealthType, AuthorisationState>> = {
    heartRateVariability: "denied",
    restingHeartRate: "denied",
  },
): void {
  seedHealthCorpus(health, { now: NOW, days, authorisation: reportWith(overrides) });
}

describe("the unavailable judgement", () => {
  it("should report a type nothing has ever published as unavailable, not as denied", () => {
    seedHisShape();

    const findings = unpublishedTypes({ samples: health, now: NOW, tz: TZ });

    expect(findings["heartRateVariability"]).toBeDefined();
    expect(findings["restingHeartRate"]).toBeDefined();
    // The types that ARE arriving are untouched. An inference that fired on a
    // working type would be worse than the label it replaces.
    expect(findings["heartRate"]).toBeUndefined();
    expect(findings["steps"]).toBeUndefined();
    expect(findings["sleep"]).toBeUndefined();
  });

  it("should carry the window it was drawn from, and what was arriving across it", () => {
    seedHisShape();

    const finding = unpublishedTypes({ samples: health, now: NOW, tz: TZ })["heartRateVariability"];

    expect(finding?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(finding?.to).toBe("2026-08-13");
    expect(finding?.corroboratedDays).toBeGreaterThanOrEqual(CORROBORATED_DAYS);
    expect(finding?.corroboratedBy).toContain("heartRate");
    expect(finding?.corroboratedBy).toContain("steps");
    // It never claims the silent type corroborated anything.
    expect(finding?.corroboratedBy).not.toContain("heartRateVariability");
  });

  it("should keep what the phone actually reported, because the label is inferred and the record is not", () => {
    seedHisShape();

    const finding = unpublishedTypes({ samples: health, now: NOW, tz: TZ })["heartRateVariability"];

    expect(finding?.reported).toBe("denied");
    // The store is untouched. An inference that rewrote the phone's report
    // would destroy the only first-hand evidence there is.
    expect(health.authorisationFor("heartRateVariability")?.state).toBe("denied");
  });

  it("should state what it was drawn from, in words, so the claim can be argued with", () => {
    seedHisShape();

    const finding = unpublishedTypes({ samples: health, now: NOW, tz: TZ })["heartRateVariability"];

    expect(finding?.because).toContain("heartRateVariability");
    expect(finding?.because).toContain(String(finding?.corroboratedDays));
    expect(finding?.because).toContain(finding?.to ?? "");
    // It names the state it overrode rather than quietly replacing it.
    expect(finding?.because).toContain("denied");
  });

  it("should say nothing at all when the source itself has been quiet — the ring in a drawer", () => {
    // THE OBJECTION THIS TEST IS THE ANSWER TO. A type silent for sixty days
    // because he travelled without the ring must not be read as a type his ring
    // cannot produce. When the ring is off EVERYTHING is silent, so there is
    // nothing to corroborate against and the judgement declines to speak.
    seedHealthCorpus(health, {
      now: NOW,
      days: 62,
      perDay: {},
      authorisation: reportWith({ heartRateVariability: "denied" }),
    });

    expect(unpublishedTypes({ samples: health, now: NOW, tz: TZ })).toEqual({});
  });

  it("should say nothing when the source stopped delivering days ago, whatever it delivered before", () => {
    // Two months of everything, ending a week before `now`. The corroboration is
    // long but STALE, and a store that has stopped hearing from the phone cannot
    // tell a type that never arrives from a phone that no longer uploads.
    const stopped = NOW - (CORROBORATION_STALE_DAYS + 5) * DAY_MS;
    seedHealthCorpus(health, {
      now: stopped,
      days: 62,
      authorisation: reportWith({ heartRateVariability: "denied" }),
    });

    expect(unpublishedTypes({ samples: health, now: NOW, tz: TZ })).toEqual({});
  });

  it("should hold its judgement until the source has delivered across enough days", () => {
    // A fresh install with three days of history. Every other type is arriving,
    // and it is far too early to tell him his ring cannot produce a number: a
    // type that reports weekly has not had its turn yet.
    seedHisShape(3);

    expect(unpublishedTypes({ samples: health, now: NOW, tz: TZ })).toEqual({});
  });

  it("should never judge a type that has EVER produced a sample, however long ago", () => {
    // Revocation after proof is undetectable — the contract says so — so a type
    // that worked and then stopped looks exactly like a type that never worked.
    // The watermark is what tells them apart, and it is read over ALL time
    // rather than over the window.
    seedHisShape();
    health.append({
      samples: [
        {
          type: "heartRateVariability",
          startedAt: "2026-06-18T04:00:00.000Z",
          endedAt: "2026-06-18T04:00:00.000Z",
          value: 42.5,
          source: "Oura",
        },
      ],
    });

    const findings = unpublishedTypes({ samples: health, now: NOW, tz: TZ });

    expect(findings["heartRateVariability"]).toBeUndefined();
    // And the type beside it, which really never arrived, is still judged.
    expect(findings["restingHeartRate"]).toBeDefined();
  });

  it("should never judge a type he has not been asked about, because that already explains the silence", () => {
    seedHisShape(62, {
      heartRateVariability: "notDetermined",
      restingHeartRate: "denied",
    });

    const findings = unpublishedTypes({ samples: health, now: NOW, tz: TZ });

    // `notDetermined` has a real remedy — show him the prompt — and telling him
    // instead that no source publishes it sends him shopping for hardware over a
    // question nobody has put to him yet.
    expect(findings["heartRateVariability"]).toBeUndefined();
    expect(findings["restingHeartRate"]).toBeDefined();
  });

  it("should leave a type the phone already called unavailable alone", () => {
    seedHisShape(62, { heartRateVariability: "unavailable" });

    expect(
      unpublishedTypes({ samples: health, now: NOW, tz: TZ })["heartRateVariability"],
    ).toBeUndefined();
  });

  it("should not judge a type the phone has never reported on at all", () => {
    // No report means we have never been told whether we may look, which is a
    // different missing fact with a different remedy, and one this inference has
    // no standing over.
    seedHealthCorpus(health, { now: NOW, days: 62 });
    db.handle.exec("DELETE FROM health_authorisation WHERE type = 'heartRateVariability'");

    expect(
      unpublishedTypes({ samples: health, now: NOW, tz: TZ })["heartRateVariability"],
    ).toBeUndefined();
  });

  it("should answer the same for a narrowed question as for the whole fleet", () => {
    // The corroboration is a fact about the STORE, not about the question, so
    // asking about one type must not cost the judgement its evidence. This is
    // the live case: "what is my HRV" narrows to exactly the type that needs it.
    seedHisShape();

    const all = unpublishedTypes({ samples: health, now: NOW, tz: TZ });
    const one = unpublishedTypes({
      samples: health,
      now: NOW,
      tz: TZ,
      types: ["heartRateVariability"],
    });

    expect(one["heartRateVariability"]).toEqual(all["heartRateVariability"]);
  });
});

describe("summariseHealth, when a type is never published", () => {
  it("should report the type as unavailable rather than as the phone's denied", () => {
    seedHisShape();

    const summary = summariseHealth({ samples: health, now: NOW, tz: TZ });
    const hrv = summary.types.find((entry) => entry.type === "heartRateVariability");

    expect(hrv?.authorisation).toBe("unavailable");
    expect(hrv?.unpublished?.reported).toBe("denied");
    expect(hrv?.unpublished?.corroboratedDays).toBeGreaterThanOrEqual(CORROBORATED_DAYS);
  });

  it("should NOT let unavailable license a conclusion drawn from the silence", () => {
    // THE TRAP. `silenceIsEvidence` is written as an equality on `authorised`
    // precisely so a new state cannot start licensing conclusions, and an
    // inferred `unavailable` is the least entitled state there is: nothing was
    // ever measured, so there is no fact about his body in it.
    seedHisShape();

    const summary = summariseHealth({ samples: health, now: NOW, tz: TZ });

    let judged = 0;
    for (const digest of summary.types) {
      if (digest.unpublished === null) continue;
      judged += 1;
      expect(digest.silenceIsEvidence, `silence for ${digest.type}`).toBe(false);
    }
    expect(judged).toBeGreaterThan(0);
  });

  it("should carry the estimate for resting heart rate AND the reason it has to be estimated", () => {
    // Both at once, and they are not in tension. His ring does not publish
    // resting heart rate, so the quiet floor of raw heart rate is the only way
    // he will ever have that number — and the digest says both, so she can
    // explain where the figure came from instead of implying a sensor produced
    // it.
    seedHisShape();

    const resting = summariseHealth({ samples: health, now: NOW, tz: TZ }).types.find(
      (entry) => entry.type === "restingHeartRate",
    );

    expect(resting?.derivedFrom).toBe("heartRate");
    expect(resting?.unpublished).not.toBeNull();
    expect(resting?.latest).not.toBeNull();
  });

  it("should leave a working type's digest exactly as it was", () => {
    seedHisShape();

    const heart = summariseHealth({ samples: health, now: NOW, tz: TZ }).types.find(
      (entry) => entry.type === "heartRate",
    );

    expect(heart?.authorisation).toBe("authorised");
    expect(heart?.unpublished).toBeNull();
    expect(heart?.silenceIsEvidence).toBe(true);
  });
});
