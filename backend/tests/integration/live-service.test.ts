import { afterEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * The harness's own gate.
 *
 * `startLiveService` can build Syl two ways: through `bootstrap`, which is what
 * `main` calls, or through a hand-written copy of it on a frozen clock, which is
 * the only way a story about *when* something happens can be deterministic.
 *
 * A duplicated wiring list is a seam of exactly the kind this whole pass exists
 * to find, so it gets the same treatment: a test that fails the moment the two
 * stop agreeing. Without it, a dependency added to `bootstrap` alone would leave
 * every timing story running against a service that is quietly not Syl.
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

  it("should wire the same dependencies on a frozen clock as bootstrap does", async () => {
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
