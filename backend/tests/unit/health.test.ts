import type { HealthStatus } from "@syl/shared";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import type { SylConfig } from "../../src/config.js";
import {
  createHealthRouter,
  databaseProbe,
  subscriptionRailsProbe,
  worstStatus,
  type HealthProbe,
} from "../../src/routes/health.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { TEST_NOW, testConfig, testDatabase } from "../helpers/service.js";

let running: RunningApp | undefined;
let db: SylDatabase | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  db?.close();
  db = undefined;
});

/** Mount the health router alone, so nothing else can colour the result. */
async function serve(
  config: SylConfig = testConfig(),
  probes: readonly HealthProbe[] = [],
  clock = fixedClock(TEST_NOW),
): Promise<HealthStatus> {
  const app = express();
  app.use("/api/v1", createHealthRouter({ config, probes, clock }));
  running = await startTestApp(app);

  const response = await fetch(`${running.baseUrl}/api/v1/health`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { success: boolean; data: HealthStatus };
  expect(body.success).toBe(true);
  return body.data;
}

/** A probe with a fixed answer. */
function probe(name: string, status: "ok" | "degraded" | "down", detail?: string): HealthProbe {
  return { name, run: () => (detail === undefined ? { status } : { status, detail }) };
}

describe("GET /api/v1/health", () => {
  it("should answer in the contract's envelope with every required field", async () => {
    const data = await serve();

    expect(data.status).toBe("ok");
    expect(data.version).toBe("0.1.0");
    expect(data.startedAt).toBe("2026-08-09T07:00:00.000Z");
    expect(data.now).toBe("2026-08-09T07:00:00.000Z");
    expect(Array.isArray(data.checks)).toBe(true);
  });

  it("should always include the subscription-rails check, since that is the one that is ours", async () => {
    const data = await serve();

    expect(data.checks.map((check) => check.name)).toContain("subscription-rails");
  });

  it("should report degraded when a credential variable would reroute billing", async () => {
    // A health check that could only say "ok" would report perfect health
    // while the Commander's billing was being rerouted to the metered API.
    const data = await serve(
      testConfig({ credentialSource: "ANTHROPIC_API_KEY", subscriptionRails: false }),
    );

    expect(data.status).toBe("degraded");
    const check = data.checks.find((c) => c.name === "subscription-rails");
    expect(check?.status).toBe("degraded");
    expect(check?.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("should never print a credential value, only the variable's name", async () => {
    const data = await serve(
      testConfig({ credentialSource: "ANTHROPIC_API_KEY", subscriptionRails: false }),
    );

    expect(JSON.stringify(data)).not.toMatch(/sk-ant/);
  });

  it("should carry every extra probe through with a null detail when it gave none", async () => {
    const data = await serve(testConfig(), [probe("scheduler", "ok")]);

    expect(data.checks).toContainEqual({ name: "scheduler", status: "ok", detail: null });
  });

  it("should take the worst check as the top-line status", async () => {
    const data = await serve(testConfig(), [probe("apns", "down", "BadDeviceToken")]);

    expect(data.status).toBe("down");
  });

  it("should still answer 200 when a dependency is down", async () => {
    // The status inside the body is the answer. A non-200 is indistinguishable
    // from the proxy in front of Syl being unhappy, and "degraded" is
    // information a monitor should read, not a failure it should retry.
    const app = express();
    app.use("/api/v1", createHealthRouter({ config: testConfig(), probes: [probe("x", "down")] }));
    running = await startTestApp(app);

    expect((await fetch(`${running.baseUrl}/api/v1/health`)).status).toBe(200);
  });

  it("should advance `now` while `startedAt` stays put", async () => {
    let ms = TEST_NOW;
    const app = express();
    app.use("/api/v1", createHealthRouter({ config: testConfig(), clock: () => ms }));
    running = await startTestApp(app);

    ms += 90_000;
    const body = (await (await fetch(`${running.baseUrl}/api/v1/health`)).json()) as {
      data: HealthStatus;
    };

    expect(body.data.startedAt).toBe("2026-08-09T07:00:00.000Z");
    expect(body.data.now).toBe("2026-08-09T07:01:30.000Z");
  });
});

describe("worstStatus", () => {
  it("should be ok when there is nothing to report", () => {
    expect(worstStatus([])).toBe("ok");
  });

  it("should prefer degraded over ok", () => {
    expect(
      worstStatus([
        { name: "a", status: "ok", detail: null },
        { name: "b", status: "degraded", detail: null },
      ]),
    ).toBe("degraded");
  });

  it("should prefer down over degraded, whatever the order", () => {
    expect(
      worstStatus([
        { name: "a", status: "down", detail: null },
        { name: "b", status: "degraded", detail: null },
      ]),
    ).toBe("down");
    expect(
      worstStatus([
        { name: "a", status: "degraded", detail: null },
        { name: "b", status: "down", detail: null },
      ]),
    ).toBe("down");
  });
});

describe("subscriptionRailsProbe", () => {
  it("should name the login when billing is safe", () => {
    expect(subscriptionRailsProbe(testConfig()).run()).toEqual({
      status: "ok",
      detail: "claude.ai subscription",
    });
  });

  it("should be degraded rather than down, because the service still works", () => {
    const result = subscriptionRailsProbe(
      testConfig({ credentialSource: "ANTHROPIC_AUTH_TOKEN", subscriptionRails: false }),
    ).run();

    expect(result.status).toBe("degraded");
  });
});

describe("databaseProbe", () => {
  it("should be ok against a migrated database", () => {
    db = testDatabase();

    expect(databaseProbe(db.handle).run()).toEqual({ status: "ok", detail: null });
  });

  it("should be down rather than throwing when the store cannot be read", () => {
    // A probe that throws takes the health endpoint down with it, and a health
    // endpoint that 500s is indistinguishable from the service being gone.
    db = testDatabase();
    db.handle.exec("DROP TABLE schema_migrations");

    const result = databaseProbe(db.handle).run();

    expect(result.status).toBe("down");
    expect(result.detail).toBeTruthy();
  });
});
