import { afterEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * The harness's own gate.
 *
 * `startLiveService` used to build Syl two ways: through `bootstrap`, which is
 * what `main` called, or through a hand-written copy of that constructor list
 * on a frozen clock — the only way a story about *when* something happens could
 * be deterministic. The copy was guarded by a test comparing the two field for
 * field, which caught a *missing* store and could not catch a differently
 * *configured* one.
 *
 * `bootstrap` takes a clock now (`syl-md5`), so there is one list, and
 * `startLiveService` is `startSyl` — the whole of `main` — on a chosen clock.
 * What is left to gate is that the boot really produces the working service and
 * not merely the app: the delivery runtime and the jobs it schedules.
 */

const FROZEN = Date.UTC(2026, 7, 10, 12, 0, 0, 0);

describe("startLiveService", () => {
  let services: LiveService[] = [];

  afterEach(async () => {
    for (const service of services) await service.close();
    services = [];
  });

  async function boot(clock?: number): Promise<LiveService> {
    const service = await startLiveService(
      clock === undefined ? {} : { clock: fixedClock(clock) },
    );
    services.push(service);
    return service;
  }

  it("should wire the same dependencies on a frozen clock as on the real one", async () => {
    const production = await boot();
    const frozen = await boot(FROZEN);

    expect(Object.keys(frozen.deps).sort()).toEqual(Object.keys(production.deps).sort());

    for (const key of Object.keys(production.deps)) {
      const left = (production.deps as unknown as Record<string, unknown>)[key];
      const right = (frozen.deps as unknown as Record<string, unknown>)[key];
      // Same constructor for every field, so a store swapped for another in one
      // path and not the other cannot pass.
      expect(right?.constructor.name).toBe(left?.constructor.name);
    }
  });

  it("should bring up the delivery runtime, not merely the app", async () => {
    // The distinction that mattered: `bootstrap` + `startServer` answers every
    // request and delivers nothing, and that is what every test booted for
    // months. A service with no runtime accepts a reminder and holds it forever.
    const syl = await boot(FROZEN);

    expect(syl.runtime.job.kind).toBe("reminder_delivery");
    expect(syl.runtime.runner.started).toBe(true);
    // No `.p8` was supplied, so push is off — and the service came up anyway,
    // which is the documented behaviour for a machine without credentials.
    expect(syl.runtime.pushEnabled).toBe(false);

    const kinds = syl.deps.jobs.list().items.map((job) => job.kind);
    expect(kinds).toContain("reminder_delivery");
    expect(kinds).toContain("content_ingestion");
  });

  it("should actually freeze time when asked", async () => {
    const frozen = await boot(FROZEN);
    const message = frozen.deps.messages.append({
      clientId: "syl:message:00000000-0000-7000-8000-0000000000f0",
      role: "user",
      text: "What time is it?",
    });

    expect(message.message.createdAt).toBe(new Date(FROZEN).toISOString());
  });

  it("should bind a real port and serve the contract's base path", async () => {
    const syl = await boot();
    const response = await syl.api("/health", { anonymous: true });

    expect(syl.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u);
    expect(syl.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/v1\/ws$/u);
    expect(response.status).toBe(200);
  });
});
