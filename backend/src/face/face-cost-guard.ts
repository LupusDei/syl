import { systemClock, type Clock } from "../services/clock.js";

/**
 * What a face costs, and when she is not allowed to open one — `syl-chzl.3.1`.
 *
 * A live face bills by the second whether or not anybody is looking at it, so
 * this file is about **real money**. It is deliberately **pure**: in-memory
 * logic over an injected {@link Clock}, no I/O, no database, no timers. The
 * broker wires it to live sessions and `face-session-store.ts` persists the
 * accounting; keeping the two apart is what lets the cost model be exercised
 * exhaustively in milliseconds.
 *
 * Three concerns, and the second is the one that gets dropped:
 *
 * 1. **A per-day credit ceiling.** {@link FaceCostGuard.canStartSession} and
 *    {@link FaceCostGuard.recordSpend} trip once a configurable daily total is
 *    reached, and reset on the next UTC calendar day.
 * 2. **An idle predicate.** {@link isSessionIdle} and
 *    {@link FaceCostGuard.shouldDisconnectIdle} tell the reaper when a quiet
 *    session has passed its timeout. A forgotten session is a silent leak, and
 *    a silent leak is this project's most-repeated defect shape — the same
 *    shape as constraint 4, a thing that fails without saying so.
 * 3. **A live meter.** {@link computeSessionMeter} turns elapsed wall-clock
 *    time into blocks, credits and dollars, so spend is *visible* rather than
 *    discovered on an invoice.
 *
 * ## The cost model, and why it rounds against us
 *
 * Runway `gwm1_avatars`, verified: **2 credits up front per session**, **2
 * credits per 6-second streaming block**, roughly **$0.01/credit** — 20
 * credits/minute, about **$0.20/minute**.
 *
 * **Partial blocks bill UP.** A started six-second block costs a full 2
 * credits. That is how the provider bills, and it keeps this guard
 * conservative: it can over-report what a session cost and it can never
 * under-report. A guard that under-counts is worse than no guard at all,
 * because it reports a safety it has not verified.
 *
 * ## Why the day is UTC
 *
 * Constraint 5 says store IANA zones, never fixed offsets — and it is about
 * *instants that mean something to the Commander*, like a reminder at seven in
 * the morning. This is not one of those. It is an accounting bucket that only
 * has to be consistent with itself and with the ledger it is seeded from, and a
 * bucket that moves an hour at every DST boundary is a bucket that double-counts
 * or drops an hour of spend twice a year. So: UTC, in both halves, stated here
 * so nobody "fixes" it into local time.
 */

/** The credit and dollar cost model for one face session. */
export interface CostModel {
  /** Credits charged once, the moment a session is created. */
  readonly upfrontCredits: number;
  /** Credits charged per streaming block. */
  readonly creditsPerBlock: number;
  /** Seconds in one streaming block. */
  readonly blockSeconds: number;
  /** USD per credit, for the live meter. */
  readonly dollarsPerCredit: number;
}

/**
 * Runway `gwm1_avatars`: 2 credits up front, 2 credits per 6s, ~$0.01/credit.
 *
 * 2 credits / 6s is 20 credits/minute, and $0.20/minute ÷ 20 credits/minute is
 * $0.01/credit — the three numbers agree, which is the check that matters.
 */
export const DEFAULT_COST_MODEL: CostModel = {
  upfrontCredits: 2,
  creditsPerBlock: 2,
  blockSeconds: 6,
  dollarsPerCredit: 0.01,
};

/**
 * The default per-day ceiling: 300 credits, about **$3/day**, about fifteen
 * minutes of face.
 *
 * Deliberately low. This is a number a human should raise on purpose once he
 * knows what he uses, not one that quietly permits an afternoon of billing
 * because nobody thought about it. Fifteen minutes is generous for the thing it
 * is for — talking to her — and a ceiling that trips is a message she can say,
 * which is a far better outcome than an invoice.
 */
export const DEFAULT_DAILY_CREDIT_CEILING = 300;

/** Default idle timeout: cut a face that has been quiet for two minutes. */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** Whole milliseconds in one calendar day, for UTC day bucketing. */
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** What a session has cost so far. */
export interface SessionMeter {
  /** Wall-clock seconds elapsed, clamped to at least zero. */
  readonly elapsedSeconds: number;
  /** Streaming blocks billed, rounded UP. */
  readonly blocks: number;
  /** `upfrontCredits + blocks × creditsPerBlock`. */
  readonly credits: number;
  /** `credits × dollarsPerCredit`. */
  readonly dollars: number;
}

/**
 * What a session that has run `elapsedMs` has cost.
 *
 * Pure. Negative elapsed time — clock skew, or a `closedAt` written before an
 * `openedAt` — clamps to zero rather than crediting time back; a non-finite one
 * does the same, because the alternative is `NaN` credits recorded against a
 * ceiling, which makes every subsequent comparison false and disables the guard
 * silently.
 */
export function computeSessionMeter(
  elapsedMs: number,
  model: Partial<CostModel> = {},
): SessionMeter {
  const m: CostModel = { ...DEFAULT_COST_MODEL, ...model };
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const elapsedSeconds = safeElapsedMs / 1_000;
  const blocks = m.blockSeconds > 0 ? Math.ceil(elapsedSeconds / m.blockSeconds) : 0;
  const credits = m.upfrontCredits + blocks * m.creditsPerBlock;
  return { elapsedSeconds, blocks, credits, dollars: credits * m.dollarsPerCredit };
}

/**
 * Has a session been quiet for at least `idleTimeoutMs`?
 *
 * Fires **at** the boundary and after it. Activity dated in the future — clock
 * skew — reads as not idle, which is the safe direction: the worst case is one
 * extra idle window before the reaper acts, against disconnecting somebody
 * mid-sentence.
 */
export function isSessionIdle(
  lastActivityAt: number,
  now: number,
  idleTimeoutMs: number,
): boolean {
  return now - lastActivityAt >= idleTimeoutMs;
}

export interface FaceCostGuardOptions {
  /** Hard per-day credit ceiling. Defaults to {@link DEFAULT_DAILY_CREDIT_CEILING}. */
  readonly dailyCreditCeiling?: number;
  /** Idle timeout in milliseconds. Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number;
  /** The cost model. Defaults to {@link DEFAULT_COST_MODEL}. */
  readonly costModel?: CostModel;
  /** The clock. Defaults to {@link systemClock}. */
  readonly now?: Clock;
}

/**
 * The rolling daily tally, and the questions asked of it.
 *
 * One instance bounds spend across every face session. It holds the tally in
 * memory and rolls it across UTC day boundaries; durability is
 * `face-session-store.ts`'s job, and {@link adoptDailyTotal} is the seam where
 * a restart puts today's total back.
 */
export class FaceCostGuard {
  readonly #dailyCreditCeiling: number;
  readonly #idleTimeoutMs: number;
  readonly #costModel: CostModel;
  readonly #now: Clock;

  /** Which UTC day (epoch-days) the tally below belongs to. */
  #currentDay: number;
  /** Credits spent during `#currentDay`. */
  #creditsSpent = 0;

  constructor(options: FaceCostGuardOptions = {}) {
    this.#dailyCreditCeiling = options.dailyCreditCeiling ?? DEFAULT_DAILY_CREDIT_CEILING;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#costModel = options.costModel ?? DEFAULT_COST_MODEL;
    this.#now = options.now ?? systemClock;
    this.#currentDay = this.#dayIndex();
  }

  /** The idle timeout this guard was built with, for a reaper that reports it. */
  get idleTimeoutMs(): number {
    return this.#idleTimeoutMs;
  }

  /** The ceiling this guard was built with, so a refusal can name the number. */
  get dailyCreditCeiling(): number {
    return this.#dailyCreditCeiling;
  }

  /** The cost model this guard was built with. */
  get costModel(): CostModel {
    return this.#costModel;
  }

  /** The UTC day bucket the clock is currently in. */
  #dayIndex(): number {
    return Math.floor(this.#now() / ONE_DAY_MS);
  }

  /** Roll the tally to today, zeroing it if the calendar day has turned over. */
  #rollDay(): void {
    const today = this.#dayIndex();
    if (today !== this.#currentDay) {
      this.#currentDay = today;
      this.#creditsSpent = 0;
    }
  }

  /** May a new session start? True while today's spend is below the ceiling. */
  canStartSession(): boolean {
    this.#rollDay();
    return this.#creditsSpent < this.#dailyCreditCeiling;
  }

  /**
   * Add credits to today's tally.
   *
   * Refuses a negative or non-finite amount rather than accepting it. A
   * negative spend is a refund the provider never gave, and `NaN` in the tally
   * makes every `<` comparison false — a ceiling that has silently stopped
   * being a ceiling, which is the worst way for this file to fail.
   */
  recordSpend(credits: number): void {
    if (!Number.isFinite(credits)) {
      throw new RangeError(`recordSpend needs a finite credit amount, got ${String(credits)}.`);
    }
    if (credits < 0) {
      throw new RangeError(
        `recordSpend needs a non-negative credit amount, got ${String(credits)}. ` +
          "Spend is never given back.",
      );
    }
    this.#rollDay();
    this.#creditsSpent += credits;
  }

  /**
   * Put today's durable total back after a restart.
   *
   * The ceiling is meaningless if a crash at noon hands the afternoon a fresh
   * budget. The caller reads the day's total out of the ledger and hands it
   * here; the day-roll still applies, so a total adopted yesterday expires
   * tonight exactly like one accumulated in this process.
   */
  adoptDailyTotal(credits: number): void {
    if (!Number.isFinite(credits) || credits < 0) {
      throw new RangeError(
        `adoptDailyTotal needs a finite, non-negative credit amount, got ${String(credits)}.`,
      );
    }
    this.#rollDay();
    this.#creditsSpent = credits;
  }

  /** Credits spent so far today. */
  spentToday(): number {
    this.#rollDay();
    return this.#creditsSpent;
  }

  /** Credits left before the ceiling trips today. Never negative. */
  remainingCreditsToday(): number {
    this.#rollDay();
    return Math.max(0, this.#dailyCreditCeiling - this.#creditsSpent);
  }

  /** What a session that has run `elapsedMs` has cost. */
  meter(elapsedMs: number): SessionMeter {
    return computeSessionMeter(elapsedMs, this.#costModel);
  }

  /** Meter an elapsed session and record every credit of it, in one call. */
  recordSessionSpend(elapsedMs: number): void {
    this.recordSpend(this.meter(elapsedMs).credits);
  }

  /** Should a session last active at `lastActivityAt` be cut for idleness? */
  shouldDisconnectIdle(lastActivityAt: number): boolean {
    return isSessionIdle(lastActivityAt, this.#now(), this.#idleTimeoutMs);
  }
}
