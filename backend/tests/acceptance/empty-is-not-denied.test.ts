import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUTHORISATION_STATES,
  HEALTH_TYPES,
  silenceIsEvidence,
  type AuthorisationState,
  type HealthType,
} from "../../src/health/contract.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * **`syl-t9tj.1.4` (T004) — empty is not denied.**
 *
 * > A type the Commander never authorised and a type genuinely authorised with
 * > no samples in it must be **distinguishable at every layer**: on the wire, in
 * > the store, and in the read the admin is built on.
 *
 * ## Why this is the test the feature is arranged around
 *
 * HealthKit's authorisation model is asymmetric in a way that makes a missing
 * permission SILENT. A type he has not granted does not error and does not
 * report denial — **it reads as empty.** So without a per-type report from the
 * phone, "he walked nowhere on Tuesday" and "we were never allowed to look at
 * steps" are the same zero samples, forever, with every layer reporting success.
 *
 * That is `syl-kqc` one subsystem over, and `syl-kqc` is the reason this test
 * exists rather than a paragraph in a design document. There, a payload claimed
 * a capability the binary had never been signed for: iOS accepted it, downgraded
 * it silently, and Focus suppressed the notification. Server said delivered,
 * Apple said accepted, the phone showed nothing, and **no layer recorded an
 * error.** A capability claimed, silently absent, every layer green.
 *
 * The answer is the same in both places: **make the two states different data
 * rather than trusting them to look different.**
 *
 * ## Six answers, not two
 *
 * The distinction this file holds is much finer than "empty vs denied", and
 * every extra rung is one a re-implementation would drop:
 *
 * | What the server holds | What it means |
 * |---|---|
 * | no row in `health_authorisation` | the phone has never told us anything about this type |
 * | `notDetermined` | a prompt he has not seen |
 * | `denied` | an answer he gave |
 * | `undisclosed` | asked, and the platform will not say (`syl-m3gi`) |
 * | `unavailable` | this device cannot measure it — no watch, no sensor |
 * | `authorised`, no samples | nothing happened, and only here may silence be read as evidence |
 *
 * Collapsing the first two would have Syl telling him he had refused something
 * nobody ever asked him about. Collapsing the last two is the bug itself.
 *
 * `undisclosed` is here because iOS **cannot** answer the three-state question:
 * `authorizationStatus(for:)` reports sharing and Syl reads, so it says
 * `.sharingDenied` for everything whatever he granted, and only a returned
 * sample positively proves `authorised`. Narrowing that to `denied` would put
 * this very conflation back one level up, inside the field built to abolish it.
 * `unavailable` is separate because the remedy differs — telling him to grant a
 * permission he already granted, when the real problem is that he owns no watch,
 * is useless advice.
 *
 * **Widening the enum must not widen the evidence rule.** Only `authorised`
 * licenses a conclusion drawn from silence, and the last test in this file is
 * there to fail if that ever becomes "everything except denied".
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

interface SeriesBody {
  readonly type: HealthType;
  readonly unit: string;
  readonly state: AuthorisationState | null;
  readonly reportedAt: string | null;
  readonly silenceIsEvidence: boolean;
  readonly watermark: string | null;
  readonly samples: readonly { readonly value: number }[];
}

interface WatermarksBody {
  readonly watermarks: Readonly<Partial<Record<HealthType, string>>>;
  readonly types: readonly {
    readonly type: HealthType;
    readonly watermark: string | null;
    readonly state: AuthorisationState | null;
    readonly silenceIsEvidence: boolean;
  }[];
}

/**
 * The report the phone sends, with the named types overridden.
 *
 * Every type appears, always: the contract requires a COMPLETE report and the
 * server refuses a partial one. Writing the helper this way means a test cannot
 * accidentally exercise the refusal path when it meant to exercise the data
 * path.
 */
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
let keyCounter = 0;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  keyCounter += 1;
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "Idempotency-Key": `empty-is-not-denied-${String(keyCounter)}`,
      ...(init.headers ?? {}),
    },
  });
}

describe("empty is not denied", () => {
  /**
   * The upload that sets the scene, and the only one these stories need.
   *
   * `steps` is denied and carries nothing. `sleep` is authorised and carries
   * nothing, which is the state a quiet night genuinely produces.
   * `restingHeartRate` is authorised and carries a reading, so the tests can
   * tell "this surface answers at all" from "this surface answers empty".
   */
  async function upload(): Promise<void> {
    const response = await api("/health/samples", {
      method: "POST",
      body: JSON.stringify({
        authorisation: reportWith({
          steps: "denied",
          heartRate: "notDetermined",
          // The state iOS actually produces for a type it will not talk about,
          // and the one a three-state contract had to narrow to `denied`.
          workout: "undisclosed",
          // No watch on this device, so there is no HRV to be had at any
          // permission level.
          heartRateVariability: "unavailable",
        }),
        samples: [
          {
            type: "restingHeartRate",
            startedAt: "2026-08-11T03:12:00.000Z",
            endedAt: "2026-08-11T03:12:00.000Z",
            value: 54,
            source: "Apple Watch",
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
  }

  it("should refuse an upload whose authorisation report is incomplete, rather than defaulting the missing types", async () => {
    const response = await api("/health/samples", {
      method: "POST",
      body: JSON.stringify({
        // Six of seven. `bodyMass` is missing, which is exactly the shape an
        // older build sends after a type is added to the contract.
        authorisation: (() => {
          const report = reportWith({});
          const { bodyMass: _dropped, ...rest } = report;
          return rest;
        })(),
        samples: [],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope<never>;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    // It NAMES the type. A client told only "incomplete" has to diff two lists
    // to find out what it forgot, and the list it would diff against is the one
    // it is already out of date with.
    expect(body.error?.message).toContain("bodyMass");
    expect(body.error?.details?.["missing"]).toEqual(["bodyMass"]);

    // And nothing was recorded. A refusal that had already written the six
    // types it did understand would leave the store holding a report the phone
    // does not believe it sent.
    expect(deps.health.authorisation()).toEqual({});
  });

  it("should distinguish a denied type from an authorised-but-empty one in the store", async () => {
    await upload();

    const denied = deps.health.authorisationFor("steps");
    const empty = deps.health.authorisationFor("sleep");

    expect(denied?.state).toBe("denied");
    expect(empty?.state).toBe("authorised");

    // Both hold nothing, and that is the point: identical sample sets, different
    // facts.
    expect(deps.health.series({ type: "steps" })).toEqual([]);
    expect(deps.health.series({ type: "sleep" })).toEqual([]);

    // The contract's own function is what decides, so no layer has to remember
    // that `authorised` is the only state under which silence means anything.
    expect(silenceIsEvidence(denied?.state ?? "denied")).toBe(false);
    expect(silenceIsEvidence(empty?.state ?? "denied")).toBe(true);
  });

  it("should report a type the phone has never mentioned as absent, which is not denied", async () => {
    // No upload at all. This is a service that has never heard from the phone —
    // a fresh pairing, or a build too old to send a report.
    expect(deps.health.authorisationFor("steps")).toBeNull();
    expect(deps.health.authorisation()).toEqual({});

    const response = await api("/health/series?type=steps");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<SeriesBody>;

    // `null`, and emphatically not `"denied"`. Nobody has asked him about steps,
    // so telling him he said no would be inventing an answer on his behalf.
    expect(body.data?.state).toBeNull();
    expect(body.data?.reportedAt).toBeNull();
    expect(body.data?.samples).toEqual([]);
    // Unattributed silence is never evidence.
    expect(body.data?.silenceIsEvidence).toBe(false);
  });

  it("should make an empty series and a denied series different answers on the wire", async () => {
    await upload();

    const denied = (await (await api("/health/series?type=steps")).json()) as Envelope<SeriesBody>;
    const empty = (await (await api("/health/series?type=sleep")).json()) as Envelope<SeriesBody>;

    // The thing that would be broken: both carry no samples.
    expect(denied.data?.samples).toEqual([]);
    expect(empty.data?.samples).toEqual([]);

    // And yet the two bodies are not the same answer.
    expect(denied.data?.state).toBe("denied");
    expect(empty.data?.state).toBe("authorised");
    expect(denied.data?.silenceIsEvidence).toBe(false);
    expect(empty.data?.silenceIsEvidence).toBe(true);
    expect(denied.data).not.toEqual(empty.data);
  });

  it("should keep notDetermined distinct from denied, because they need different things from him", async () => {
    await upload();

    const notAsked = (await (
      await api("/health/series?type=heartRate")
    ).json()) as Envelope<SeriesBody>;
    const refused = (await (await api("/health/series?type=steps")).json()) as Envelope<SeriesBody>;

    expect(notAsked.data?.state).toBe("notDetermined");
    expect(refused.data?.state).toBe("denied");

    // Neither may be read as evidence, and they still must not be collapsed:
    // one is a prompt he has not seen, the other is an answer he gave, and
    // re-asking for something he declined is its own small betrayal.
    expect(notAsked.data?.silenceIsEvidence).toBe(false);
    expect(refused.data?.silenceIsEvidence).toBe(false);
    expect(notAsked.data?.state).not.toBe(refused.data?.state);
  });

  it("should store undisclosed as reported, rather than collapsing it into denied", async () => {
    await upload();

    // The state the platform forces (`syl-m3gi`). Folding it into `denied`
    // server-side would rebuild the exact conflation this feature exists to
    // remove, one layer below the admin screen that has to show the difference.
    expect(deps.health.authorisationFor("workout")?.state).toBe("undisclosed");

    const body = (await (await api("/health/series?type=workout")).json()) as Envelope<SeriesBody>;
    expect(body.data?.state).toBe("undisclosed");
    expect(body.data?.samples).toEqual([]);
    // Unproven is unproven. She may not conclude he did no exercise.
    expect(body.data?.silenceIsEvidence).toBe(false);
  });

  it("should keep unavailable distinct, because it has a different remedy", async () => {
    await upload();

    const unavailable = (await (
      await api("/health/series?type=heartRateVariability")
    ).json()) as Envelope<SeriesBody>;
    const refused = (await (await api("/health/series?type=steps")).json()) as Envelope<SeriesBody>;

    // Both empty, both unusable as evidence — and still not the same fact. No
    // watch means no HRV at any permission level, and telling him to grant
    // something he has already granted is useless advice.
    expect(unavailable.data?.state).toBe("unavailable");
    expect(refused.data?.state).toBe("denied");
    expect(unavailable.data?.silenceIsEvidence).toBe(false);
  });

  it("should let ONLY authorised license a conclusion from silence, however many states there are", async () => {
    // The load-bearing assertion, and the one that must survive every future
    // widening of the enum. `syl-m3gi` took it from three states to five without
    // moving this line, which is the property being pinned: adding a state is
    // safe exactly because an unproven type never licenses a conclusion drawn
    // from its quiet.
    //
    // Written over the contract's own list rather than over a copy, so a sixth
    // state cannot be added without this test seeing it.
    const licensing = AUTHORISATION_STATES.filter((state) => silenceIsEvidence(state));

    expect(licensing).toEqual(["authorised"]);
    // Stated the other way round too: "not denied" is emphatically not the rule.
    expect(silenceIsEvidence("undisclosed")).toBe(false);
    expect(silenceIsEvidence("unavailable")).toBe(false);
    expect(silenceIsEvidence("notDetermined")).toBe(false);
  });

  it("should carry the same distinction on the resume surface the phone reads", async () => {
    await upload();

    const body = (await (await api("/health/watermarks")).json()) as Envelope<WatermarksBody>;
    const byType = new Map(body.data?.types.map((entry) => [entry.type, entry]) ?? []);

    // Four types, no watermark on any of them — and four different reasons.
    expect(byType.get("steps")?.watermark).toBeNull();
    expect(byType.get("sleep")?.watermark).toBeNull();
    expect(byType.get("workout")?.watermark).toBeNull();
    expect(byType.get("heartRateVariability")?.watermark).toBeNull();

    expect(byType.get("steps")?.state).toBe("denied");
    expect(byType.get("sleep")?.state).toBe("authorised");
    expect(byType.get("workout")?.state).toBe("undisclosed");
    expect(byType.get("heartRateVariability")?.state).toBe("unavailable");

    // The one type that actually holds something reports where to resume from.
    expect(byType.get("restingHeartRate")?.watermark).toBe("2026-08-11T03:12:00.000Z");
    expect(body.data?.watermarks.restingHeartRate).toBe("2026-08-11T03:12:00.000Z");

    // Every type is accounted for. A resume surface that only listed the types
    // it had news about would be the silent-absence bug wearing a shorter list.
    expect(body.data?.types.map((entry) => entry.type).sort()).toEqual([...HEALTH_TYPES].sort());
  });
});
