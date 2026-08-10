import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HealthStatus } from "@syl/shared";

import { afterEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, startSyl, type RunningSyl } from "../../src/index.js";
import type { SylConfig } from "../../src/config.js";
import { loadQuietHours } from "../../src/config.js";
import { PushEnvironmentError } from "../../src/ops/apns-environment.js";
import { apnsEnv, expectData, inertTimers } from "../helpers/live-service.js";

/**
 * The operational checks, on the path `main` takes.
 *
 * Every component here was written to run once, in production, months from now.
 * That is the exact shape of every serious defect this project has found — a
 * thing that had never actually executed — so each of these cases boots the
 * real `startSyl` and asks the real `/health` route what it says.
 *
 * The two claims worth being sceptical about, and both are asserted below:
 * that a production service with no declared APNs environment **does not
 * start**, and that refusing does not leave a database handle or a bound port
 * behind.
 */

let started: RunningSyl | null = null;
const directories: string[] = [];

afterEach(async () => {
  if (started !== null) {
    await started.close();
    started.database.close();
    started = null;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-ops-"));
  directories.push(directory);
  return directory;
}

function config(overrides: Partial<SylConfig> = {}): SylConfig {
  const directory = scratch();
  return {
    host: "127.0.0.1",
    port: 0,
    nodeEnv: "test",
    version: "0.1.0",
    databasePath: join(directory, "syl.db"),
    autoMemoryDirectory: join(directory, "memory"),
    credentialSource: "none",
    subscriptionRails: true,
    quietHours: loadQuietHours(process.env),
    pushEnvironment: null,
    allowSandboxPush: false,
    logDirectory: join(directory, "logs"),
    certStatusPath: join(directory, "cert-status.json"),
    // Not built, on purpose — see the note in `tests/helpers/service.ts`.
    adminDir: join(directory, "admin-not-built"),
    attachmentDir: join(directory, "attachments"),
    ...overrides,
  };
}

async function health(syl: RunningSyl): Promise<HealthStatus> {
  const address = syl.service.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}${API_BASE_PATH}/health`);
  return expectData<HealthStatus>(response);
}

describe("the APNs environment assertion, on the real boot path", () => {
  it("should refuse to start a production service that has not declared it", async () => {
    await expect(
      startSyl(config({ nodeEnv: "production" }), {
        delivery: { env: apnsEnv(), timers: inertTimers },
      }),
    ).rejects.toThrow(PushEnvironmentError);
  });

  it("should leave nothing behind when it refuses", async () => {
    // A refusal that leaked the store would show up as a locked database on the
    // next attempt, and as a file handle per case in this suite.
    const settings = config({ nodeEnv: "production" });
    await expect(
      startSyl(settings, { delivery: { env: apnsEnv(), timers: inertTimers } }),
    ).rejects.toThrow(PushEnvironmentError);

    // The same store opens again cleanly, which it could not if the first
    // attempt still held it.
    const second = await startSyl(
      { ...settings, pushEnvironment: "production" },
      { delivery: { env: apnsEnv(), timers: inertTimers } },
    );
    started = second;
    expect(second.push.environment).toBe("production");
  });

  it("should start a production service that declared production", async () => {
    started = await startSyl(config({ nodeEnv: "production", pushEnvironment: "production" }), {
      delivery: { env: apnsEnv(), timers: inertTimers },
    });

    expect(started.push.declared).toBe(true);
    expect(started.startupFields["pushEnvironment"]).toBe("production");
  });

  it("should refuse a production service pointed at sandbox", async () => {
    await expect(
      startSyl(config({ nodeEnv: "production", pushEnvironment: "sandbox" }), {
        delivery: { env: apnsEnv(), timers: inertTimers },
      }),
    ).rejects.toThrow(/TestFlight/);
  });

  it("should still start a production service with no APNs key at all", async () => {
    // A machine with no `.p8` has nothing to be wrong about, and refusing would
    // stop the conversation surface over a capability it is not using.
    started = await startSyl(config({ nodeEnv: "production" }), {
      delivery: { timers: inertTimers, env: {} },
    });

    expect(started.runtime.pushEnabled).toBe(false);
  });

  it("should report the environment on /health", async () => {
    started = await startSyl(config({ pushEnvironment: "sandbox" }), {
      delivery: { env: apnsEnv(), timers: inertTimers },
    });

    const body = await health(started);
    const check = body.checks.find((candidate) => candidate.name === "apns-environment");
    expect(check).toBeDefined();
    expect(check?.status).toBe("ok");
    expect(check?.detail).toBe("sandbox");
  });

  it("should degrade /health when a registered token is from the other channel", async () => {
    started = await startSyl(config({ pushEnvironment: "sandbox" }), {
      delivery: { env: apnsEnv(), timers: inertTimers },
    });

    // Registered after boot, which is the case a probe captured at startup
    // could never see.
    started.deps.devices.register({
      platform: "ios",
      environment: "production",
      token: "a".repeat(64),
      name: "TestFlight build",
      appVersion: "0.1.0",
      osVersion: "26.0",
    });

    const body = await health(started);
    const check = body.checks.find((candidate) => candidate.name === "apns-environment");
    expect(check?.status).toBe("degraded");
    expect(body.status).toBe("degraded");
  });
});

describe("the tailnet certificate check, on the real boot path", () => {
  it("should report degraded when renewal has never run", async () => {
    started = await startSyl(config(), { delivery: { timers: inertTimers, env: {} } });

    const body = await health(started);
    const check = body.checks.find((candidate) => candidate.name === "tailnet-cert");
    expect(check?.status).toBe("degraded");
    expect(check?.detail).toContain("com.jmm.syl.cert");
  });

  it("should report ok once the renewal job has written a healthy status", async () => {
    const settings = config();
    writeFileSync(
      settings.certStatusPath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        hostname: "syl.tail1234.ts.net",
        certPath: "/tmp/x.crt",
        ok: true,
        renewed: false,
        daysRemaining: 85,
        error: null,
      }),
    );

    started = await startSyl(settings, { delivery: { timers: inertTimers, env: {} } });

    const body = await health(started);
    const check = body.checks.find((candidate) => candidate.name === "tailnet-cert");
    expect(check?.status).toBe("ok");
  });

  it("should take the whole service down when the certificate has expired", async () => {
    // Down rather than degraded: the phone cannot complete a TLS handshake, so
    // there is nothing partial about it.
    const settings = config();
    writeFileSync(
      settings.certStatusPath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        hostname: "syl.tail1234.ts.net",
        certPath: "/tmp/x.crt",
        ok: true,
        renewed: false,
        daysRemaining: -1,
        error: null,
      }),
    );

    started = await startSyl(settings, { delivery: { timers: inertTimers, env: {} } });

    expect((await health(started)).status).toBe("down");
  });
});

describe("the startup record", () => {
  it("should carry the credential source, which is the invariant that costs money", async () => {
    started = await startSyl(config(), { delivery: { timers: inertTimers, env: {} } });

    expect(started.startupFields["credentialSource"]).toBe("none");
    expect(started.startupFields["subscriptionRails"]).toBe(true);
    expect(started.startupLines.join("\n")).toContain("credentials: none");
  });

  it("should say what it concluded about the machine's power settings", async () => {
    started = await startSyl(config(), { delivery: { timers: inertTimers, env: {} } });

    expect(started.startupFields).toHaveProperty("powerOk");
  });
});
