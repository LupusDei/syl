import { describe, expect, it } from "vitest";

import {
  createRng,
  DEFAULT_SCENARIO,
  delayFor,
  mergeScenario,
  nextFault,
  scenarioFromHeaders,
} from "../src/mock/scenario.js";

describe("createRng", () => {
  it("should be deterministic for a seed", () => {
    // A fault injector whose failures cannot be reproduced is worse than none.
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("should differ between seeds", () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });

  it("should stay inside [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("nextFault", () => {
  const rng = (): number => 0.5;

  it("should not fault a default scenario", () => {
    expect(nextFault(DEFAULT_SCENARIO, rng).fault).toBeUndefined();
  });

  it("should count down failNext and stop", () => {
    let scenario = { ...DEFAULT_SCENARIO, failNext: 2 };
    const first = nextFault(scenario, rng);
    expect(first.fault?.code).toBe("UPSTREAM_UNAVAILABLE");
    scenario = first.scenario;
    expect(scenario.failNext).toBe(1);

    const second = nextFault(scenario, rng);
    expect(second.fault).toBeDefined();
    scenario = second.scenario;

    expect(nextFault(scenario, rng).fault).toBeUndefined();
  });

  it("should let failNext outrank errorRate, so a test is not flaky by construction", () => {
    const scenario = { ...DEFAULT_SCENARIO, failNext: 1, errorRate: 0 };
    expect(nextFault(scenario, rng).fault).toBeDefined();
  });

  it("should fault when errorRate exceeds the draw and not when it does not", () => {
    expect(nextFault({ ...DEFAULT_SCENARIO, errorRate: 0.9 }, () => 0.1).fault).toBeDefined();
    expect(nextFault({ ...DEFAULT_SCENARIO, errorRate: 0.1 }, () => 0.9).fault).toBeUndefined();
  });

  it("should mark only the retryable codes retryable", () => {
    expect(nextFault({ ...DEFAULT_SCENARIO, failNext: 1, error: "RATE_LIMITED" }, rng).fault?.retryable).toBe(true);
    expect(nextFault({ ...DEFAULT_SCENARIO, failNext: 1, error: "INTERNAL" }, rng).fault?.retryable).toBe(true);
    // Retrying an auth failure fifty times is the worst possible response.
    expect(nextFault({ ...DEFAULT_SCENARIO, failNext: 1, error: "UNAUTHORIZED" }, rng).fault?.retryable).toBe(false);
    expect(nextFault({ ...DEFAULT_SCENARIO, failNext: 1, error: "VALIDATION_FAILED" }, rng).fault?.retryable).toBe(false);
  });
});

describe("delayFor", () => {
  it("should return the fixed latency when there is no jitter", () => {
    expect(delayFor({ ...DEFAULT_SCENARIO, latencyMs: 250 }, () => 0.5)).toBe(250);
  });

  it("should add jitter on top of the latency", () => {
    expect(delayFor({ ...DEFAULT_SCENARIO, latencyMs: 100, jitterMs: 100 }, () => 0.5)).toBe(150);
  });

  it("should never return a negative delay", () => {
    expect(delayFor({ ...DEFAULT_SCENARIO, latencyMs: -50 }, () => 0)).toBe(0);
  });
});

describe("mergeScenario", () => {
  it("should keep the base where the patch says nothing", () => {
    const merged = mergeScenario({ ...DEFAULT_SCENARIO, latencyMs: 300 }, {});
    expect(merged.latencyMs).toBe(300);
  });

  it("should coerce numeric strings, because these arrive from headers and JSON by hand", () => {
    const merged = mergeScenario(DEFAULT_SCENARIO, { latencyMs: "400" } as never);
    expect(merged.latencyMs).toBe(400);
  });

  it("should ignore nonsense rather than produce a server that never answers", () => {
    // `latencyMs: NaN` in a setTimeout is an afternoon of someone's life.
    const merged = mergeScenario({ ...DEFAULT_SCENARIO, latencyMs: 10 }, { latencyMs: "banana" } as never);
    expect(merged.latencyMs).toBe(10);
  });

  it("should clamp errorRate into 0..1", () => {
    expect(mergeScenario(DEFAULT_SCENARIO, { errorRate: 5 }).errorRate).toBe(1);
    expect(mergeScenario(DEFAULT_SCENARIO, { errorRate: -1 }).errorRate).toBe(0);
  });

  it("should carry booleans through", () => {
    expect(mergeScenario(DEFAULT_SCENARIO, { offline: true }).offline).toBe(true);
  });
});

describe("scenarioFromHeaders", () => {
  it("should read a per-request latency", () => {
    expect(scenarioFromHeaders({ "x-mock-latency-ms": "750" })).toMatchObject({ latencyMs: "750" });
  });

  it("should turn an error header into exactly one injected failure", () => {
    // Per-request beats global: one test wanting one failure must not have to
    // mutate server-wide state that another test is relying on.
    expect(scenarioFromHeaders({ "x-mock-error": "RATE_LIMITED" })).toMatchObject({
      error: "RATE_LIMITED",
      failNext: 1,
    });
  });

  it("should return nothing for a request that asked for nothing", () => {
    expect(scenarioFromHeaders({ "content-type": "application/json" })).toEqual({});
  });

  it("should take the first value when a header arrives repeated", () => {
    expect(scenarioFromHeaders({ "x-mock-latency-ms": ["100", "200"] })).toMatchObject({
      latencyMs: "100",
    });
  });
});
