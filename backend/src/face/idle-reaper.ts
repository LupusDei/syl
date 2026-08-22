import { parseInstant, systemClock, type Clock } from "../services/clock.js";
import type { FaceSessionBroker } from "./face-session-broker.js";
import type { FaceSession, FaceSessionStore } from "./face-session-store.js";

/**
 * The idle auto-disconnect — `syl-chzl.3.4`, and it has its own file on purpose.
 *
 * An open face bills by the second whether or not anybody is there. A forgotten
 * session is a **silent leak**, which is this project's most-repeated defect
 * shape: the same shape as constraint 4, a thing that fails without saying so.
 * Folding this into the broker is how it gets dropped under schedule pressure,
 * so it is separate, and it is visible.
 *
 * Two things it cuts, and they are settled differently because they are
 * different facts:
 *
 * - **expired** — the session is past the provider's own cap. It is already
 *   over upstream; we are closing our record of it.
 * - **reaped** — the session is live, billable, and nobody has said anything
 *   for the idle timeout. This is the one the file exists for.
 *
 * ## Never silently
 *
 * A reap that cannot disconnect **retries, then escalates**, and the session
 * **stays in tracking**. It is not settled, it is not forgotten, and the next
 * sweep tries again with a rising failure count so a permanent problem looks
 * different from a blip.
 *
 * That is deliberate and it is the opposite of tidy. Marking the row closed
 * while the stream runs on would make the ledger say the leak had stopped —
 * the leak wearing the guard's uniform, and the exact failure the reaper was
 * written to prevent. An unreachable session that is still billing has to stay
 * visible.
 *
 * Every reap is logged with the session id, the idle duration and the spend,
 * because a session that vanishes without a line in the log is indistinguishable
 * from one that crashed.
 */

/** What one sweep did. */
export interface ReapReport {
  /** Sessions cut for idleness. */
  readonly reaped: readonly string[];
  /** Sessions closed because they were past the provider's cap. */
  readonly expired: readonly string[];
  /** Sessions that could NOT be disconnected. Still open, still tracked. */
  readonly failed: readonly string[];
}

/** The slice of the broker the reaper drives. */
export type ReaperBroker = Pick<
  FaceSessionBroker,
  "shouldDisconnectIdle" | "recordSessionEnd" | "meterSession"
>;

/** The slice of the store the reaper reads. */
export type ReaperSessions = Pick<FaceSessionStore, "live">;

export interface IdleReaperOptions {
  readonly broker: ReaperBroker;
  readonly sessions: ReaperSessions;
  /**
   * Actually cut the session.
   *
   * Required, and required rather than defaulted: the reaper's whole job is
   * stopping a bill, and a default no-op would be a reaper that settles rows
   * while the money keeps going out. Wiring supplies the real one — closing the
   * LiveKit RPC participant and the room, which is what ends the stream.
   */
  readonly disconnect: (sessionId: string) => Promise<void>;
  /** How often to sweep once {@link IdleReaper.start} is called. */
  readonly intervalMs?: number;
  /** Retries after the first attempt. Default 2, so three attempts in all. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: Clock;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
  readonly logError?: (event: string, fields: Record<string, unknown>) => void;
}

/** Default sweep interval. Well under the two-minute idle timeout. */
export const DEFAULT_REAP_INTERVAL_MS = 30_000;

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

export class IdleReaper {
  readonly #broker: ReaperBroker;
  readonly #sessions: ReaperSessions;
  readonly #disconnect: (sessionId: string) => Promise<void>;
  readonly #intervalMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: Clock;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
  readonly #logError: (event: string, fields: Record<string, unknown>) => void;

  /** How many sweeps in a row have failed to cut each session. */
  readonly #failures = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: IdleReaperOptions) {
    this.#broker = options.broker;
    this.#sessions = options.sessions;
    this.#disconnect = options.disconnect;
    this.#intervalMs = options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.#retries = options.retries ?? DEFAULT_RETRIES;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? systemClock;
    this.#log =
      options.log ??
      ((event, fields) => {
        console.info(`[syl] ${event}`, fields);
      });
    this.#logError =
      options.logError ??
      ((event, fields) => {
        console.error(`[syl] ${event}`, fields);
      });
  }

  /** Start sweeping. Idempotent — a second call does not start a second timer. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      // A sweep that rejects must not kill the timer. The next one is the
      // recovery, and a reaper that stopped because of one locked database is
      // a reaper that stopped silently.
      void this.sweep().catch((error: unknown) => {
        this.#logError("face.reaper.sweep_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#intervalMs);
    this.#timer.unref();
  }

  /** Stop sweeping. Safe to call when not started. */
  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * One pass over everything still open.
   *
   * Never rejects for a single session's sake: one stuck session must not stop
   * the others from being cut, because the others are also costing money.
   */
  async sweep(): Promise<ReapReport> {
    const reaped: string[] = [];
    const expired: string[] = [];
    const failed: string[] = [];

    let live: readonly FaceSession[];
    try {
      live = this.#sessions.live();
    } catch (error) {
      this.#logError("face.reaper.sweep_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { reaped, expired, failed };
    }

    for (const session of live) {
      // Past the provider's own cap first: it is already over upstream, so
      // there is nothing to cut and nothing to escalate about.
      if (this.#isPastCap(session)) {
        this.#settle(session, "expired", expired);
        continue;
      }

      if (!this.#broker.shouldDisconnectIdle(session)) {
        // It spoke. Whatever went wrong before is no longer going wrong.
        this.#failures.delete(session.id);
        continue;
      }

      const cut = await this.#cut(session);
      if (!cut) {
        failed.push(session.id);
        continue;
      }
      this.#settle(session, "reaped", reaped);
    }

    return { reaped, expired, failed };
  }

  // ------------------------------------------------------------- internals ---

  /** Whether the session is past the cap the provider reported for it. */
  #isPastCap(session: FaceSession): boolean {
    const cap = parseInstant(session.askExpiresAt);
    return cap !== null && this.#now() >= cap;
  }

  /**
   * Disconnect, with retries, reporting whether it worked.
   *
   * A synchronous throw is caught along with a rejection: `disconnect` is
   * injected, and a seam that can throw two different ways must not have one of
   * them escape into the sweep.
   */
  async #cut(session: FaceSession): Promise<boolean> {
    const attempts = this.#retries + 1;
    let lastError = "";

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#disconnect(session.id);
        this.#failures.delete(session.id);
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await this.#sleep(this.#retryDelayMs);
      }
    }

    const consecutiveFailures = (this.#failures.get(session.id) ?? 0) + 1;
    this.#failures.set(session.id, consecutiveFailures);
    // LOUD, and the session stays open. See the header: a row marked closed
    // while the stream runs on is the leak wearing the guard's uniform.
    this.#logError("face.session.reap_failed", {
      sessionId: session.id,
      attempts,
      consecutiveFailures,
      idleMs: this.#idleMsOf(session),
      error: lastError,
      note: "still open and still billing",
    });
    return false;
  }

  /** Settle the row, record the spend, and say so in the log. */
  #settle(session: FaceSession, ended: "reaped" | "expired", into: string[]): void {
    const meter = this.#broker.meterSession(session);
    let outcomeSettled: boolean;
    try {
      outcomeSettled = this.#broker.recordSessionEnd(session.id, ended).settled;
    } catch (error) {
      this.#logError("face.reaper.settle_failed", {
        sessionId: session.id,
        ended,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    into.push(session.id);
    this.#failures.delete(session.id);
    if (!outcomeSettled) return;

    this.#log(ended === "reaped" ? "face.session.reaped" : "face.session.expired", {
      sessionId: session.id,
      idleMs: this.#idleMsOf(session),
      elapsedSeconds: Math.round(meter.elapsedSeconds),
      credits: meter.credits,
      dollars: Number(meter.dollars.toFixed(4)),
    });
  }

  #idleMsOf(session: FaceSession): number {
    const last = parseInstant(session.lastActivityAt);
    return last === null ? 0 : this.#now() - last;
  }
}
