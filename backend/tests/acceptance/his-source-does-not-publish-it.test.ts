import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthType,
} from "../../src/health/contract.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { seedHealthCorpus } from "../helpers/health-corpus.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * **`syl-8ys9.3.2` (T010) — his ring does not publish it.**
 *
 * > A type authorised for a long window with zero samples is reported as
 * > `unavailable` rather than as denied or undisclosed. She can say *"your ring
 * > does not publish HRV"* rather than *"you have no HRV"*.
 *
 * ## The two sentences, and why only one of them is about a man
 *
 * `heartRateVariability` and `restingHeartRate` are reported by his phone today
 * as **`denied`**, and they are not denied. Oura publishes neither type to Apple
 * Health — established from his own screenshot of Oura's permission list, where
 * both are simply absent between the types that bracket them alphabetically
 * (HRV between *Heart Rate* and *Height*; resting heart rate between
 * *Respiratory Rate* and *Resting Energy*).
 *
 * So the label blames **his permissions** for **a vendor's integration gap**,
 * and everything downstream inherits it. *"You have no HRV"* is a claim about
 * his body. *"Your ring does not publish HRV"* is a claim about his equipment,
 * which he can act on by buying a different device or by ignoring entirely.
 *
 * ## Why the phone cannot fix this and the server can
 *
 * `HKHealthStore.isHealthDataAvailable()` answers **device-wide**, never per
 * type, so `unavailable` from a client can only ever mean "HealthKit is absent
 * from this device". The iOS side established that and correctly refused to
 * invent a per-type detector.
 *
 * The server sees something no client can: a type that has never once arrived
 * across weeks in which the same source delivered everything else. That is an
 * inference, so — like every other inference in this system — it arrives
 * carrying what it was drawn from.
 *
 * ## And it stays quiet when it should
 *
 * The last story here is the objection: a type can be silent for sixty days
 * because the ring spent them in a drawer. That case is not this one and must
 * not be labelled as it, which is why the judgement is corroborated rather than
 * merely long.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

interface UnpublishedBody {
  readonly type: HealthType;
  readonly reported: AuthorisationState;
  readonly from: string;
  readonly to: string;
  readonly corroboratedDays: number;
  readonly corroboratedBy: readonly HealthType[];
  readonly because: string;
}

interface SeriesBody {
  readonly type: HealthType;
  readonly state: AuthorisationState | null;
  readonly reportedAt: string | null;
  readonly silenceIsEvidence: boolean;
  readonly watermark: string | null;
  readonly unpublished: UnpublishedBody | null;
  readonly samples: readonly { readonly value: number }[];
}

interface SummaryBody {
  readonly types: readonly {
    readonly type: HealthType;
    readonly authorisation: AuthorisationState | null;
    readonly silenceIsEvidence: boolean;
    readonly unpublished: UnpublishedBody | null;
  }[];
}

/** A fixed moment, so "the last thirty-five days" is the same window every run. */
const NOW = Date.parse("2026-08-13T18:00:00.000Z");

/** A complete report — the store refuses a partial one — with overrides. */
function reportWith(
  overrides: Partial<Record<HealthType, AuthorisationState>>,
): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = overrides[type] ?? "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  // The service's own clock, pinned. Without it the window under test would be
  // "the thirty-five days ending whenever this test ran", which is a statement
  // about the day rather than about the data.
  running = await startTestApp(createApp(testConfig(), { ...deps, clock: fixedClock(NOW) }));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(path: string): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seriesOf(type: HealthType): Promise<SeriesBody> {
  const response = await api(`/health/series?type=${type}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as Envelope<SeriesBody>;
  expect(body.success).toBe(true);
  // Safe assertion: a successful envelope carries data.
  return body.data as SeriesBody;
}

/**
 * His store, at the shape it actually has.
 *
 * Forty days of heart rate, sleep and steps from the ring; not one sample of
 * heart rate variability or resting heart rate, ever; and the labels his live
 * rows carry today, which are `denied` for exactly those two.
 */
function seedHisRing(): void {
  seedHealthCorpus(deps.health, {
    now: NOW,
    days: 40,
    // Thin, because this story is about which days carried data rather than how
    // many rows each day held. The timing story is `syl-8ys9.2`'s.
    perDay: { heartRate: 6, steps: 6, sleep: 2 },
    authorisation: reportWith({
      heartRateVariability: "denied",
      restingHeartRate: "denied",
    }),
  });
}

describe("his source does not publish it", () => {
  it("should report a type his ring has never published as unavailable, not as denied", async () => {
    seedHisRing();

    const hrv = await seriesOf("heartRateVariability");

    // The whole bead in one assertion. `denied` is what the phone said and it
    // is a claim about HIM; `unavailable` is a claim about the equipment.
    expect(hrv.state).toBe("unavailable");
    expect(hrv.samples).toHaveLength(0);
  });

  it("should carry the window that justifies it, because it is an inference and not a reading", async () => {
    seedHisRing();

    const hrv = await seriesOf("heartRateVariability");

    expect(hrv.unpublished).not.toBeNull();
    expect(hrv.unpublished?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hrv.unpublished?.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hrv.unpublished?.corroboratedDays).toBeGreaterThan(20);
    expect(hrv.unpublished?.corroboratedBy).toContain("heartRate");
    // And it keeps the state it overrode. An inference that erased the report it
    // argued with would leave nothing to check it against.
    expect(hrv.unpublished?.reported).toBe("denied");
    expect(hrv.reportedAt).not.toBeNull();
  });

  it("should not let the inferred state license a conclusion about his body", async () => {
    seedHisRing();

    const hrv = await seriesOf("heartRateVariability");

    // Silence from a type nothing publishes is not a fact about him. It was not
    // evidence when it read `denied` and it must not become evidence now.
    expect(hrv.silenceIsEvidence).toBe(false);
  });

  it("should say the same thing to her as to the admin", async () => {
    seedHisRing();

    const response = await api("/health/summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<SummaryBody>;
    const hrv = body.data?.types.find((entry) => entry.type === "heartRateVariability");

    expect(hrv?.authorisation).toBe("unavailable");
    expect(hrv?.silenceIsEvidence).toBe(false);
    expect(hrv?.unpublished?.reported).toBe("denied");
    // The sentence she can build one true statement out of.
    expect(hrv?.unpublished?.because).toContain("heartRateVariability");
  });

  it("should leave a type that is arriving exactly as the phone reported it", async () => {
    seedHisRing();

    const heart = await seriesOf("heartRate");

    expect(heart.state).toBe("authorised");
    expect(heart.unpublished).toBeNull();
    expect(heart.silenceIsEvidence).toBe(true);
  });

  it("should stay quiet about a type that is silent because the ring is in a drawer", async () => {
    // THE OBJECTION, driven to the surface it would surface on. He travels for
    // two months without the ring: every type is silent, so nothing corroborates
    // anything, and the honest answer is still the one the phone gave.
    seedHealthCorpus(deps.health, {
      now: NOW,
      days: 40,
      perDay: {},
      authorisation: reportWith({ heartRateVariability: "denied" }),
    });

    const hrv = await seriesOf("heartRateVariability");

    expect(hrv.state).toBe("denied");
    expect(hrv.unpublished).toBeNull();
  });
});
