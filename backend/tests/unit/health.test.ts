import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import type { SylConfig } from "../../src/config.js";
import { createHealthRouter, type HealthBody } from "../../src/routes/health.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";

const baseConfig: SylConfig = {
  host: "127.0.0.1",
  port: 4201,
  nodeEnv: "test",
  version: "0.1.0",
  credentialSource: "none",
  subscriptionRails: true,
};

let running: RunningApp | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** Mount the health router alone, so nothing else can colour the result. */
async function serve(
  config: SylConfig = baseConfig,
  now: () => number = Date.now,
): Promise<RunningApp> {
  const app = express();
  app.use("/api", createHealthRouter(config, now));
  running = await startTestApp(app);
  return running;
}

describe("GET /api/health", () => {
  it("should return 200 with status, version and uptime", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}/api/health`);
    const body = (await response.json()) as HealthBody;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("should answer as JSON", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}/api/health`);

    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("should report uptime measured from when the router was created", async () => {
    let clock = 1_000_000;
    const app = await serve(baseConfig, () => clock);

    clock += 2_500;
    const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as HealthBody;

    expect(body.uptimeSeconds).toBe(2.5);
  });

  it("should report a non-negative uptime on the very first request", async () => {
    const app = await serve(baseConfig, () => 42);

    const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as HealthBody;

    expect(body.uptimeSeconds).toBe(0);
  });

  describe("credential source", () => {
    it("should report subscription rails when no key is in the environment", async () => {
      const app = await serve();

      const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as HealthBody;

      expect(body.credentialSource).toBe("none");
      expect(body.subscriptionRails).toBe(true);
    });

    it("should name the variable that would reroute billing to the metered API", async () => {
      const app = await serve({
        ...baseConfig,
        credentialSource: "ANTHROPIC_API_KEY",
        subscriptionRails: false,
      });

      const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as HealthBody;

      expect(body.credentialSource).toBe("ANTHROPIC_API_KEY");
      expect(body.subscriptionRails).toBe(false);
    });

    it("should stay 200 even when the rails are wrong, so monitoring can read the detail", async () => {
      const app = await serve({
        ...baseConfig,
        credentialSource: "ANTHROPIC_API_KEY",
        subscriptionRails: false,
      });

      const response = await fetch(`${app.baseUrl}/api/health`);

      expect(response.status).toBe(200);
    });
  });

  describe("error path", () => {
    it("should not answer a POST to the health path", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}/api/health`, { method: "POST" });

      expect(response.status).not.toBe(200);
    });

    it("should not answer a sibling path it does not own", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}/api/health/deep`);

      expect(response.status).toBe(404);
    });

    it("should expose nothing beyond the documented fields", async () => {
      const app = await serve();

      const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as HealthBody;

      expect(Object.keys(body).sort()).toEqual([
        "credentialSource",
        "status",
        "subscriptionRails",
        "uptimeSeconds",
        "version",
      ]);
    });
  });
});
