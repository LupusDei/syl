import type { ErrorCode } from "../types.js";

/**
 * Scripted latency and failure for the mock server.
 *
 * This module is the reason the mock is worth building rather than stubbing.
 * A happy-path mock produces clients that fall over the first time reality is
 * slow or fails — and reality here is a Mac at home behind a tunnel that is
 * torn down when idle, so the first request after a wake genuinely does fail
 * while Tailscale re-establishes. A squad that never sees that during
 * development ships an app that treats it as "server down".
 *
 * Everything here is pure. The server holds the state and the clock; this
 * module only decides.
 */

/** How the mock should behave for the requests that follow. */
export interface Scenario {
  /** Fixed delay added to every response, in milliseconds. */
  readonly latencyMs: number;
  /** Extra uniform random delay on top of `latencyMs`, in milliseconds. */
  readonly jitterMs: number;
  /** Probability in `0..1` that any given request fails. */
  readonly errorRate: number;
  /** Fail exactly this many upcoming requests, then stop. Beats `errorRate`. */
  readonly failNext: number;
  /** Which error to inject when one is injected. */
  readonly error: ErrorCode;
  /** HTTP status to pair with the injected error. */
  readonly status: number;
  /**
   * Drop the request without a response, as a dead tunnel does.
   *
   * Distinct from an error: an error is the server answering, and this is the
   * server not being there. Clients handle them on different paths and a mock
   * that cannot produce the second one only exercises half the retry logic.
   */
  readonly offline: boolean;
  /** Seed for the deterministic RNG, so a flaky run can be reproduced. */
  readonly seed: number;
}

export const DEFAULT_SCENARIO: Scenario = Object.freeze({
  latencyMs: 0,
  jitterMs: 0,
  errorRate: 0,
  failNext: 0,
  error: "UPSTREAM_UNAVAILABLE",
  status: 503,
  offline: false,
  seed: 1,
});

/** An injected failure. */
export interface Fault {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
}

/** Error codes a client is expected to retry. Everything else halts. */
const RETRYABLE: ReadonlySet<string> = new Set([
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
]);

/**
 * A small deterministic PRNG (mulberry32).
 *
 * `Math.random` would make a failing run unreproducible, which is the one
 * thing a fault-injection tool must never do — "it failed once on my machine"
 * is not a bug report anybody can act on.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Decide whether the next request fails, and return the scenario to use after
 * it.
 *
 * `failNext` is a countdown and outranks `errorRate`: "fail the next three
 * calls" is the shape a test actually wants, and leaving it to a probability
 * makes the test flaky by construction.
 */
export function nextFault(
  scenario: Scenario,
  rng: () => number,
): { readonly fault: Fault | undefined; readonly scenario: Scenario } {
  if (scenario.failNext > 0) {
    return {
      fault: faultOf(scenario),
      scenario: { ...scenario, failNext: scenario.failNext - 1 },
    };
  }
  if (scenario.errorRate > 0 && rng() < scenario.errorRate) {
    return { fault: faultOf(scenario), scenario };
  }
  return { fault: undefined, scenario };
}

function faultOf(scenario: Scenario): Fault {
  return {
    code: scenario.error,
    status: scenario.status,
    retryable: RETRYABLE.has(scenario.error),
  };
}

/** How long to wait before answering. */
export function delayFor(scenario: Scenario, rng: () => number): number {
  if (scenario.jitterMs <= 0) return Math.max(0, scenario.latencyMs);
  return Math.max(0, scenario.latencyMs + Math.floor(rng() * scenario.jitterMs));
}

/**
 * Merge a partial scenario over another, ignoring undefined and rejecting
 * nonsense.
 *
 * The mock is a development tool driven by hand-written curl commands and
 * config files, so a typo that silently produces `latencyMs: NaN` — and a
 * server that then never answers — costs someone an afternoon.
 */
export function mergeScenario(base: Scenario, patch: Partial<Scenario>): Scenario {
  const next: Scenario = {
    latencyMs: pickNumber(patch.latencyMs, base.latencyMs, 0),
    jitterMs: pickNumber(patch.jitterMs, base.jitterMs, 0),
    errorRate: clamp(pickNumber(patch.errorRate, base.errorRate, 0), 0, 1),
    failNext: pickNumber(patch.failNext, base.failNext, 0),
    error: patch.error ?? base.error,
    status: pickNumber(patch.status, base.status, 100),
    offline: patch.offline ?? base.offline,
    seed: pickNumber(patch.seed, base.seed, 0),
  };
  return next;
}

function pickNumber(value: unknown, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read a per-request scenario override from headers.
 *
 * Per-request beats global for the common case — one test wants one slow call,
 * and making it mutate server-wide state means it cannot run beside anything
 * else.
 */
export function scenarioFromHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Partial<Scenario> {
  const read = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const patch: Record<string, unknown> = {};
  const latency = read("x-mock-latency-ms");
  if (latency !== undefined) patch["latencyMs"] = latency;
  const jitter = read("x-mock-jitter-ms");
  if (jitter !== undefined) patch["jitterMs"] = jitter;
  const status = read("x-mock-status");
  if (status !== undefined) patch["status"] = status;
  const error = read("x-mock-error");
  if (error !== undefined) {
    patch["error"] = error;
    patch["failNext"] = 1;
  }
  return patch as Partial<Scenario>;
}
