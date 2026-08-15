import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HIS_OWN_WORDS, REPORTED_BY, type CharacteristicOutcome } from "../../src/health/characteristics.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `POST /health/characteristics` over a real socket — `syl-8ys9.4`.
 *
 * The door, not the meaning: authentication, refusals, and the one thing that
 * is easy to break by accident here — **`GET /health` must still answer without
 * a token.** Its neighbour `health-data-routes.test.ts` holds the same guard for
 * the sample routes; this file adds the fourth name to the list that must never
 * be mounted on the `/health` prefix.
 *
 * The story about what these values MEAN — that his own words outrank a sensor,
 * and that she says which one she used — lives in
 * `health-characteristics.test.ts`.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

interface Recorded {
  readonly outcomes: readonly CharacteristicOutcome[];
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let keyCounter = 0;

function headers(): Record<string, string> {
  keyCounter += 1;
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "idempotency-key": `characteristics-${String(keyCounter)}`,
  };
}

const A_BIRTHDAY = {
  characteristic: "dateOfBirth",
  value: "1988-10-08",
  readAt: "2026-08-14T11:59:00.000Z",
};

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

describe("POST /health/characteristics", () => {
  it("should refuse an anonymous caller", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/health/characteristics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characteristics: [A_BIRTHDAY] }),
    });
    expect(response.status).toBe(401);
  });

  it("should leave GET /health answering without a token", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/health`);
    expect(response.status).toBe(200);
  });

  it("should file a characteristic and say which source it is using", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/health/characteristics`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ characteristics: [A_BIRTHDAY] }),
    });
    const body = (await response.json()) as Envelope<Recorded>;

    expect(response.status).toBe(200);
    const outcome = body.data?.outcomes[0];
    expect(outcome?.characteristic).toBe("dateOfBirth");
    expect(outcome?.reported).toBe("8 October 1988");
    expect(outcome?.using).toBe(REPORTED_BY);
    expect(outcome?.nodeId).toMatch(/^syl:memory_node:/u);
  });

  it("should use his own words when the graph already holds them", async () => {
    deps.memory.graph.addNode({
      kind: "person",
      label: "Justin Martin",
      body: "He is Justin Martin, an engineering leader and entrepreneur, born October 8th 1988.",
    });

    const response = await fetch(`${running.baseUrl}/api/v1/health/characteristics`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ characteristics: [{ ...A_BIRTHDAY, value: "1989-10-08" }] }),
    });
    const body = (await response.json()) as Envelope<Recorded>;

    const outcome = body.data?.outcomes[0];
    expect(outcome?.using).toBe(HIS_OWN_WORDS);
    expect(outcome?.value).toBe("1988-10-08");
    expect(outcome?.contradicts).toMatch(/^syl:memory_edge:/u);
  });

  it("should refuse a measurement type with a message that says where it belongs", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/health/characteristics`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        characteristics: [{ characteristic: "steps", value: "12000", readAt: A_BIRTHDAY.readAt }],
      }),
    });
    const body = (await response.json()) as Envelope<Recorded>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.message).toContain("/health/samples");
  });

  it("should refuse a body with no characteristics array", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/health/characteristics`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("should write nothing into health_samples, however many times it is called", async () => {
    for (const value of ["1988-10-08", "1988-10-08"]) {
      await fetch(`${running.baseUrl}/api/v1/health/characteristics`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ characteristics: [{ ...A_BIRTHDAY, value }] }),
      });
    }
    const rows = db.handle.prepare("SELECT count(*) AS n FROM health_samples").get() as unknown as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});
