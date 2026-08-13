import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUTHORISATION_STATES,
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthType,
} from "../../src/health/contract.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `/health/samples`, `/health/watermarks` and `/health/series` over a real
 * socket.
 *
 * The stories about what the data MEANS live in
 * `tests/acceptance/empty-is-not-denied.test.ts` and its two siblings. This file
 * is about the door: authentication, idempotency, refusals, and the one thing
 * that is easy to break by accident — **`GET /health` must still answer without
 * a token.** These routers share a path prefix and nothing else, and a
 * `router.use("/health", authenticate)` here would put a bearer check in front
 * of liveness silently, in whichever mount order happened to be current.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

function fullReport(): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

const A_READING = {
  type: "restingHeartRate",
  startedAt: "2026-08-11T03:12:00.000Z",
  endedAt: "2026-08-11T03:12:00.000Z",
  value: 54,
  source: "Apple Watch",
};

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

async function api(
  path: string,
  init: RequestInit & { readonly anonymous?: boolean; readonly idempotencyKey?: string | null } = {},
): Promise<Response> {
  const { anonymous, idempotencyKey, ...rest } = init;
  keyCounter += 1;
  const key = idempotencyKey === undefined ? `health-key-${String(keyCounter)}` : idempotencyKey;

  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
      ...(rest.headers ?? {}),
    },
  });
}

describe("POST /health/samples", () => {
  it("should accept an upload and answer with what it wrote", async () => {
    const response = await api("/health/samples", {
      method: "POST",
      body: JSON.stringify({ authorisation: fullReport(), samples: [A_READING] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<{
      written: number;
      duplicates: number;
      watermarks: Partial<Record<HealthType, string>>;
    }>;
    expect(body.data?.written).toBe(1);
    expect(body.data?.duplicates).toBe(0);
    expect(body.data?.watermarks.restingHeartRate).toBe("2026-08-11T03:12:00.000Z");
  });

  it("should require an Idempotency-Key like every other write on this surface", async () => {
    const response = await api("/health/samples", {
      method: "POST",
      idempotencyKey: null,
      body: JSON.stringify({ authorisation: fullReport(), samples: [A_READING] }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope<never>;
    expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(deps.health.count()).toBe(0);
  });

  it("should replay a retried request rather than writing twice", async () => {
    const send = async (): Promise<Response> =>
      api("/health/samples", {
        method: "POST",
        idempotencyKey: "the-same-call",
        body: JSON.stringify({ authorisation: fullReport(), samples: [A_READING] }),
      });

    const first = await send();
    const second = await send();

    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    // The STORED answer, not a fresh one. A replay that recomputed would report
    // `duplicates: 1` for a call the client believes it made once.
    expect(await second.json()).toEqual(await first.json());
    expect(deps.health.count()).toBe(1);
  });

  it("should refuse a malformed body before the ledger is touched", async () => {
    const response = await api("/health/samples", {
      method: "POST",
      idempotencyKey: "the-bad-one",
      body: JSON.stringify({ authorisation: fullReport(), samples: "not an array" }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<never>).error?.details?.["field"]).toBe("samples");

    // The same key, now with a corrected body, must work. Remembering a
    // validation failure would make the client's fix fail forever with the
    // original error, which is the opposite of what a retry is for.
    const corrected = await api("/health/samples", {
      method: "POST",
      idempotencyKey: "the-bad-one",
      body: JSON.stringify({ authorisation: fullReport(), samples: [A_READING] }),
    });
    expect(corrected.status).toBe(200);
  });

  it("should refuse an authorisation state the contract does not name", async () => {
    const response = await api("/health/samples", {
      method: "POST",
      body: JSON.stringify({
        authorisation: { ...fullReport(), steps: "maybe" },
        samples: [],
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<never>).error?.details?.["field"]).toBe(
      "authorisation.steps",
    );
  });

  it("should accept every state the contract names, including the two iOS forced", async () => {
    // Driven off `AUTHORISATION_STATES` rather than a list written here. The
    // enum went from three to five mid-build (`syl-m3gi`), and a route guard
    // that named the three would have refused `undisclosed` while reading as a
    // correct guard — which is the exact shape of bug this endpoint exists to
    // prevent, relocated into the validator.
    for (const state of AUTHORISATION_STATES) {
      const response = await api("/health/samples", {
        method: "POST",
        body: JSON.stringify({
          authorisation: { ...fullReport(), steps: state },
          samples: [],
        }),
      });
      expect(response.status, `state ${state} must be accepted`).toBe(200);
      expect(deps.health.authorisationFor("steps")?.state).toBe(state);
    }
  });

  it("should refuse an anonymous caller with the ordinary indistinguishable 401", async () => {
    const response = await api("/health/samples", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ authorisation: fullReport(), samples: [A_READING] }),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope<never>).error?.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /health/series", () => {
  beforeEach(async () => {
    await api("/health/samples", {
      method: "POST",
      body: JSON.stringify({ authorisation: fullReport(), samples: [A_READING] }),
    });
  });

  it("should answer with the samples, the unit and the authorisation state", async () => {
    const response = await api("/health/series?type=restingHeartRate");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Envelope<{
      unit: string;
      state: AuthorisationState | null;
      silenceIsEvidence: boolean;
      samples: readonly { value: number }[];
    }>;
    expect(body.data?.unit).toBe("count/min");
    expect(body.data?.state).toBe("authorised");
    expect(body.data?.silenceIsEvidence).toBe(true);
    expect(body.data?.samples.map((sample) => sample.value)).toEqual([54]);
  });

  it("should refuse a missing or unknown type rather than answering about everything", async () => {
    expect((await api("/health/series")).status).toBe(400);
    expect((await api("/health/series?type=bloodPressure")).status).toBe(400);
  });

  it("should refuse a window it cannot parse", async () => {
    const response = await api("/health/series?type=restingHeartRate&from=yesterday");
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<never>).error?.details?.["field"]).toBe("from");
  });

  it("should refuse an anonymous caller", async () => {
    expect((await api("/health/series?type=restingHeartRate", { anonymous: true })).status).toBe(
      401,
    );
  });
});

describe("GET /health/watermarks", () => {
  it("should list every type, always, whether or not there is news about it", async () => {
    const body = (await (await api("/health/watermarks")).json()) as Envelope<{
      types: readonly { type: HealthType }[];
    }>;

    expect(body.data?.types.map((entry) => entry.type).sort()).toEqual([...HEALTH_TYPES].sort());
  });

  it("should refuse an anonymous caller", async () => {
    expect((await api("/health/watermarks", { anonymous: true })).status).toBe(401);
  });
});

describe("the liveness endpoint that shares this prefix", () => {
  /**
   * The regression this whole file's mount strategy exists to prevent.
   *
   * `GET /health` is one of two routes in the contract that must answer without
   * a token — it is how a monitor learns the service is alive. Mounting the data
   * router's authentication on the `/health` prefix rather than on its three
   * named paths would close it, and nothing else in the suite would notice
   * because every other test carries a token.
   */
  it("should still answer GET /health without any credential at all", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<{ status: string }>;
    expect(body.success).toBe(true);
    expect(body.data?.status).toBe("ok");
  });
});
