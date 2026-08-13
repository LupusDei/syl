import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_TYPES,
  sampleKey,
  type AuthorisationState,
  type HealthSampleInput,
  type HealthType,
} from "../../src/health/contract.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * **`syl-t9tj.2.4` (T008) — a re-upload changes nothing.**
 *
 * > The same batch sent twice writes nothing the second time, **and says so.**
 *
 * ## Idempotence here is load-bearing, not defensive
 *
 * The failure to guard against is not a clumsy client. It is the ordinary
 * operating condition of a phone: a retry after a lost response, a second device
 * that also saw the watch, an app that lost its watermark and re-sent a week
 * from cold.
 *
 * A doubled sleep sample is a wrong average, which is a wrong baseline, which is
 * a conclusion about a pattern that does not exist — and the Commander has ruled
 * that a health conclusion may interrupt him often and may be `time-sensitive`.
 * So a duplicate does not produce a tidiness problem, it produces a message that
 * pierces Focus to tell him something untrue about his own body.
 *
 * ## Identity, not the request key
 *
 * The identity is `(type, startedAt, endedAt, source)` — the contract's
 * {@link sampleKey}. It is deliberately NOT the `Idempotency-Key` header, and
 * this file asserts the difference: the second upload here carries a **different**
 * idempotency key, because the case that matters is one measurement arriving in
 * two different HTTP calls. A test that reused the key would be exercising the
 * ledger and proving nothing about the store.
 *
 * ## And it says so
 *
 * `duplicates` is reported rather than hidden. A re-upload that silently
 * answered `written: 0` is indistinguishable from an upload the server dropped
 * on the floor — and the phone advances its watermark on this answer, so an
 * ambiguous zero is how a device stops sending data it still holds.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

interface UploadResult {
  readonly written: number;
  readonly duplicates: number;
  readonly watermarks: Readonly<Partial<Record<HealthType, string>>>;
}

function fullReport(): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

/** One night, as a watch and a phone would actually report it. */
const THE_BATCH: readonly HealthSampleInput[] = [
  {
    type: "restingHeartRate",
    startedAt: "2026-08-11T03:12:00.000Z",
    endedAt: "2026-08-11T03:12:00.000Z",
    value: 54,
    source: "Apple Watch",
  },
  {
    type: "sleep",
    startedAt: "2026-08-10T22:41:00.000Z",
    endedAt: "2026-08-11T06:02:00.000Z",
    value: 441,
    source: "Apple Watch",
  },
  {
    type: "steps",
    startedAt: "2026-08-11T00:00:00.000Z",
    endedAt: "2026-08-11T23:59:59.000Z",
    value: 8_431,
    source: "iPhone",
  },
];

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
});

afterEach(async () => {
  await running.close();
  db.close();
});

/** Post the batch under a caller-chosen idempotency key. */
async function post(
  samples: readonly HealthSampleInput[],
  idempotencyKey: string,
): Promise<Envelope<UploadResult>> {
  const response = await fetch(`${running.baseUrl}/api/v1/health/samples`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ authorisation: fullReport(), samples }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Envelope<UploadResult>;
}

describe("a re-upload changes nothing", () => {
  it("should write the batch once and report the second attempt as duplicates, under a different idempotency key", async () => {
    const first = await post(THE_BATCH, "upload-monday-morning");

    expect(first.data?.written).toBe(3);
    expect(first.data?.duplicates).toBe(0);
    expect(deps.health.count()).toBe(3);

    // A DIFFERENT key. This is the same measurement arriving in a second HTTP
    // call, which the request ledger cannot see and the sample identity can.
    const second = await post(THE_BATCH, "upload-monday-afternoon");

    expect(second.data?.written).toBe(0);
    // Reported, not hidden. `written: 0` alone is indistinguishable from an
    // upload the server dropped.
    expect(second.data?.duplicates).toBe(3);
    expect(deps.health.count()).toBe(3);
  });

  it("should leave the watermarks exactly where the first upload put them", async () => {
    const first = await post(THE_BATCH, "first");
    const second = await post(THE_BATCH, "second");

    expect(second.data?.watermarks).toEqual(first.data?.watermarks);
    // The furthest `endedAt` per type, not the furthest `startedAt`: a sleep
    // block that starts before midnight ends after it, and a phone resuming from
    // the start would re-read the night forever.
    expect(first.data?.watermarks.sleep).toBe("2026-08-11T06:02:00.000Z");
    expect(first.data?.watermarks.restingHeartRate).toBe("2026-08-11T03:12:00.000Z");
  });

  it("should hold one row per identity, with the values the first upload carried", async () => {
    await post(THE_BATCH, "first");
    // The second upload claims a different value for a sample it has already
    // sent. It is the SAME measurement by identity, so it must neither create a
    // second row nor overwrite the first: an upload is not an edit, and a client
    // that could rewrite history through a retry is a client that can rewrite it
    // by accident.
    await post(
      THE_BATCH.map((sample) =>
        sample.type === "restingHeartRate" ? { ...sample, value: 99 } : sample,
      ),
      "second",
    );

    const readings = deps.health.series({ type: "restingHeartRate" });
    expect(readings).toHaveLength(1);
    expect(readings[0]?.value).toBe(54);
  });

  it("should count a genuinely new measurement from a second device as new, not as a duplicate", async () => {
    await post(THE_BATCH, "watch");

    // The same minute, the same type — from the phone rather than the watch.
    // `source` is part of the identity precisely so this is two measurements
    // rather than one duplicate: averaging them silently would be inventing a
    // third reading that no device ever took.
    const alsoTheIPhone: HealthSampleInput = {
      type: "restingHeartRate",
      startedAt: "2026-08-11T03:12:00.000Z",
      endedAt: "2026-08-11T03:12:00.000Z",
      value: 57,
      source: "iPhone",
    };
    const second = await post([alsoTheIPhone], "phone");

    expect(second.data?.written).toBe(1);
    expect(second.data?.duplicates).toBe(0);
    expect(deps.health.series({ type: "restingHeartRate" })).toHaveLength(2);
    expect(sampleKey(alsoTheIPhone)).not.toBe(sampleKey(THE_BATCH[0] as HealthSampleInput));
  });

  it("should treat a differently-spelled instant as the same measurement", async () => {
    await post(THE_BATCH, "first");

    // `…:00Z` rather than `…:00.000Z`. The same instant, spelled the way a
    // formatter without fractional seconds writes it. Identity is a comparison
    // of TEXT, so without canonicalisation at the door this is a second row for
    // one measurement and the unique index never sees it — a duplicate that
    // survives precisely because it looks different.
    const sameNight = await post(
      [
        {
          type: "restingHeartRate",
          startedAt: "2026-08-11T03:12:00Z",
          endedAt: "2026-08-11T03:12:00Z",
          value: 54,
          source: "Apple Watch",
        },
      ],
      "same-night-other-spelling",
    );

    expect(sameNight.data?.written).toBe(0);
    expect(sameNight.data?.duplicates).toBe(1);
    expect(deps.health.series({ type: "restingHeartRate" })).toHaveLength(1);
  });
});
