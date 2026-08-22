import { describe, expect, it } from "vitest";

import {
  computeSessionMeter,
  DEFAULT_COST_MODEL,
  DEFAULT_DAILY_CREDIT_CEILING,
  DEFAULT_IDLE_TIMEOUT_MS,
  FaceCostGuard,
  isSessionIdle,
} from "../../src/face/face-cost-guard.js";

/** A movable clock. The whole guard is testable without time passing. */
function movableClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const NOON = Date.UTC(2026, 7, 21, 12, 0, 0);

describe("computeSessionMeter", () => {
  it("should charge the upfront credits and nothing else for a session of zero length", () => {
    const meter = computeSessionMeter(0);

    expect(meter.elapsedSeconds).toBe(0);
    expect(meter.blocks).toBe(0);
    expect(meter.credits).toBe(DEFAULT_COST_MODEL.upfrontCredits);
    expect(meter.dollars).toBeCloseTo(0.02, 10);
  });

  it("should bill a partial block UP: one second costs a whole six-second block", () => {
    const meter = computeSessionMeter(1_000);

    expect(meter.blocks).toBe(1);
    expect(meter.credits).toBe(4);
  });

  it("should not round a whole block up into the next one", () => {
    expect(computeSessionMeter(6_000).blocks).toBe(1);
    expect(computeSessionMeter(6_001).blocks).toBe(2);
  });

  it("should meter a minute at about twenty credits of streaming plus the upfront", () => {
    const meter = computeSessionMeter(60_000);

    expect(meter.blocks).toBe(10);
    expect(meter.credits).toBe(22);
    expect(meter.dollars).toBeCloseTo(0.22, 10);
  });

  it("should clamp negative elapsed time from clock skew to zero rather than crediting it back", () => {
    const meter = computeSessionMeter(-30_000);

    expect(meter.elapsedSeconds).toBe(0);
    expect(meter.blocks).toBe(0);
    expect(meter.credits).toBe(DEFAULT_COST_MODEL.upfrontCredits);
  });

  it("should treat a non-finite elapsed time as zero rather than producing NaN credits", () => {
    expect(computeSessionMeter(Number.NaN).credits).toBe(DEFAULT_COST_MODEL.upfrontCredits);
    expect(computeSessionMeter(Number.POSITIVE_INFINITY).credits).toBe(
      DEFAULT_COST_MODEL.upfrontCredits,
    );
  });

  it("should honour an overridden cost model rather than the default", () => {
    const meter = computeSessionMeter(12_000, {
      upfrontCredits: 0,
      creditsPerBlock: 1,
      blockSeconds: 4,
      dollarsPerCredit: 0.5,
    });

    expect(meter.blocks).toBe(3);
    expect(meter.credits).toBe(3);
    expect(meter.dollars).toBeCloseTo(1.5, 10);
  });
});

describe("isSessionIdle", () => {
  it("should report idle exactly AT the boundary, not only past it", () => {
    expect(isSessionIdle(1_000, 1_000 + DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS)).toBe(true);
  });

  it("should report a session inside its timeout as not idle", () => {
    expect(isSessionIdle(1_000, 1_000 + DEFAULT_IDLE_TIMEOUT_MS - 1, DEFAULT_IDLE_TIMEOUT_MS)).toBe(
      false,
    );
  });

  it("should treat future-dated activity from clock skew as not idle", () => {
    expect(isSessionIdle(10_000, 1_000, DEFAULT_IDLE_TIMEOUT_MS)).toBe(false);
  });
});

describe("FaceCostGuard", () => {
  it("should permit a session while today's spend is under the ceiling", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ dailyCreditCeiling: 100, now: clock.now });

    guard.recordSpend(99);

    expect(guard.canStartSession()).toBe(true);
    expect(guard.spentToday()).toBe(99);
    expect(guard.remainingCreditsToday()).toBe(1);
  });

  it("should refuse a session once today's spend has reached the ceiling", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ dailyCreditCeiling: 100, now: clock.now });

    guard.recordSpend(100);

    expect(guard.canStartSession()).toBe(false);
    expect(guard.remainingCreditsToday()).toBe(0);
  });

  it("should never report a negative remaining balance after an overshoot", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ dailyCreditCeiling: 10, now: clock.now });

    guard.recordSpend(40);

    expect(guard.remainingCreditsToday()).toBe(0);
    expect(guard.spentToday()).toBe(40);
  });

  it("should reset the tally on the next UTC calendar day", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ dailyCreditCeiling: 100, now: clock.now });

    guard.recordSpend(100);
    expect(guard.canStartSession()).toBe(false);

    // Still the same UTC day, eleven hours later.
    clock.advance(11 * 60 * 60 * 1_000);
    expect(guard.canStartSession()).toBe(false);

    // Past midnight UTC.
    clock.advance(2 * 60 * 60 * 1_000);
    expect(guard.canStartSession()).toBe(true);
    expect(guard.spentToday()).toBe(0);
  });

  it("should refuse to record a negative or non-finite spend rather than crediting the day back", () => {
    const guard = new FaceCostGuard({ now: () => NOON });

    expect(() => guard.recordSpend(-1)).toThrow(/non-negative/);
    expect(() => guard.recordSpend(Number.NaN)).toThrow(/finite/);
  });

  it("should adopt a durable day total so a restart does not reset the ceiling to zero", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ dailyCreditCeiling: 100, now: clock.now });

    guard.adoptDailyTotal(100);

    expect(guard.spentToday()).toBe(100);
    expect(guard.canStartSession()).toBe(false);
  });

  it("should let an adopted total expire with the day it belonged to", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ dailyCreditCeiling: 100, now: clock.now });

    guard.adoptDailyTotal(100);
    clock.advance(13 * 60 * 60 * 1_000);

    expect(guard.spentToday()).toBe(0);
    expect(guard.canStartSession()).toBe(true);
  });

  it("should meter an elapsed session with its own cost model", () => {
    const guard = new FaceCostGuard({ now: () => NOON });

    expect(guard.meter(60_000).credits).toBe(22);
  });

  it("should record a metered session's whole spend in one call", () => {
    const guard = new FaceCostGuard({ now: () => NOON });

    guard.recordSessionSpend(60_000);

    expect(guard.spentToday()).toBe(22);
  });

  it("should say a quiet session past the idle timeout must be disconnected", () => {
    const clock = movableClock(NOON);
    const guard = new FaceCostGuard({ idleTimeoutMs: 10_000, now: clock.now });
    const lastActivityAt = clock.now();

    expect(guard.shouldDisconnectIdle(lastActivityAt)).toBe(false);

    clock.advance(9_999);
    expect(guard.shouldDisconnectIdle(lastActivityAt)).toBe(false);

    clock.advance(1);
    expect(guard.shouldDisconnectIdle(lastActivityAt)).toBe(true);
  });

  it("should default to a ceiling and an idle timeout rather than to unbounded spend", () => {
    expect(DEFAULT_DAILY_CREDIT_CEILING).toBeGreaterThan(0);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);

    const guard = new FaceCostGuard();

    expect(guard.remainingCreditsToday()).toBe(DEFAULT_DAILY_CREDIT_CEILING);
  });
});
