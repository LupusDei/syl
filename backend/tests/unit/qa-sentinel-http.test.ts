import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * QA sentinel reproductions over the real Express app. Every test here is
 * expected to FAIL against current product code.
 */

describe("syl-qa: the contract's idempotency rule is not enforced by the server", () => {
  let db: SylDatabase;
  let running: RunningApp;
  let deps: ReturnType<typeof testDeps>;

  beforeEach(async () => {
    db = testDatabase();
    deps = testDeps(db);
    running = await startTestApp(createApp(testConfig(), deps));
  });

  afterEach(async () => {
    await running.close();
    db.close();
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${running.baseUrl}/api/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("should replay POST /auth/pair under the same Idempotency-Key rather than burning the code", async () => {
    const code = deps.keys.issuePairingCode().code;
    const body = { pairingCode: code, deviceName: "Commander's iPhone" };
    const key = { "Idempotency-Key": "pair-retry-0001" };

    const first = await post("/auth/pair", body, key);
    expect(first.status).toBe(200);

    // The response was lost in flight. The client retries with the same key —
    // which is the entire scenario the header exists for.
    const retry = await post("/auth/pair", body, key);

    // The contract requires the stored response, replayed. What actually
    // happens: `keys.pair` consumed the code on the first call, so this is a
    // 401 and the device can never pair. There is no endpoint to reissue a
    // pairing code; the service has to be restarted.
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
  });

  it("should refuse a write that carries no Idempotency-Key at all", async () => {
    const code = deps.keys.issuePairingCode().code;

    // openapi.yaml marks the header `required: true` on every write, and the
    // mock server (shared/src/mock/server.ts:431) rejects a write without one.
    // The real server accepts it.
    const response = await post("/auth/pair", {
      pairingCode: code,
      deviceName: "Commander's iPhone",
    });

    expect(response.status).toBe(400);
  });
});
