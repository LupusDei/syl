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
  /**
   * How long a session may go without its client ever confirming it is up.
   *
   * See {@link DEFAULT_UNCONFIRMED_TIMEOUT_MS}. Shorter than the ordinary idle
   * timeout because it answers a different question.
   */
  readonly unconfirmedTimeoutMs?: number;
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

/**
 * How long a face may bill before its client has ever said it is up.
 *
 * **A different question from the idle timeout, which is why it has its own
 * number.** Idle asks "has this conversation gone quiet"; two minutes is right
 * for that, because a pause in a conversation is an ordinary thing. This asks
 * "did a face ever appear at all", and there is no innocent version of the
 * answer being no.
 *
 * The number comes from a real bill. On 2026-08-23 the app was terminated by
 * iOS four seconds into each of two sessions — a TCC crash over an undeclared
 * camera usage — and each one then billed for the full two-minute idle window:
 * 44 and 46 credits, ninety cents, for two crashes. Nothing was on his screen
 * for any of it. A crash loop would have opened one of these per attempt.
 *
 * 45 seconds is chosen against the create-and-connect path, not against
 * comfort: the create plus the poll to READY is bounded at 30 seconds, and the
 * page reports `connected` within a second or two of the stream starting. So a
 * healthy face confirms itself with room to spare, and a face that never
 * appears costs a third of what it used to.
 */
export const DEFAULT_UNCONFIRMED_TIMEOUT_MS = 45_000;

/**
 * The client states that mean a face is actually up on his screen.
 *
 * Anything else — including having said nothing at all — is unconfirmed. The
 * set is deliberately the two that require frames or a live room, not the ones
 * that merely mean the page is trying.
 */
const CONFIRMED_LIVE: ReadonlySet<string> = new Set(["connected", "playing"]);

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
  readonly #unconfirmedTimeoutMs: number;
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
    this.#unconfirmedTimeoutMs = options.unconfirmedTimeoutMs ?? DEFAULT_UNCONFIRMED_TIMEOUT_MS;
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

      // A face nobody ever saw is cut on a shorter clock than a conversation
      // that has gone quiet. See `#neverAppeared`.
      if (!this.#broker.shouldDisconnectIdle(session) && !this.#neverAppeared(session)) {
        // It spoke, or it is up and simply quiet. Whatever went wrong before is
        // no longer going wrong.
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

  /**
   * Whether the session is past the cap **the provider itself reported**.
   *
   * `providerCapAt === null` means the provider never told us when the session
   * ends, and that is answered `false`: **a missing cap means "there is nothing
   * to renew against", never "expired"**. Read the other way this is expensive
   * in both directions — it settles a healthy session seconds after it opens,
   * and anything renewing on the signal loops at twenty cents a lap, each new
   * session instantly "expired" again.
   *
   * Deliberately NOT `askExpiresAt`. That column always holds a value, so
   * reading it here would make the NULL case unreachable and the bug above
   * unavoidable. This module had exactly that defect.
   */
  /**
   * Has this face been billing for {@link DEFAULT_UNCONFIRMED_TIMEOUT_MS}
   * without its client ever saying it is up?
   *
   * Three conditions, all of which must hold, and each one is there to stop
   * this from cutting something that works:
   *
   * - **No `ask_syl` has ever landed.** `lastActivityAt` still equals
   *   `openedAt`, which is the exact signature of the two sessions this exists
   *   for. One question asked is proof of life and takes the session straight
   *   back onto the ordinary two-minute clock.
   * - **The client has never reported `connected` or `playing`.** The page says
   *   so within a second or two of the stream starting, over the same origin it
   *   was just fetched from.
   * - **It has been open longer than the grace window.**
   *
   * The accepted risk is stated rather than hidden: a face that genuinely works
   * while its reports cannot reach us is cut at 45 seconds. That path is
   * narrow — the report shares an origin and a connection with the document —
   * and the failure it replaces is a crashed app billing twenty cents a minute
   * at nobody.
   */
  #neverAppeared(session: FaceSession): boolean {
    if (session.clientState !== null && CONFIRMED_LIVE.has(session.clientState)) return false;

    const opened = parseInstant(session.openedAt);
    const last = parseInstant(session.lastActivityAt);
    if (opened === null) return false;
    // Any activity at all is proof of life, whatever the client said.
    if (last !== null && last > opened) return false;

    return this.#now() - opened >= this.#unconfirmedTimeoutMs;
  }

  #isPastCap(session: FaceSession): boolean {
    if (session.providerCapAt === null) return false;
    const cap = parseInstant(session.providerCapAt);
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
      clientState: session.clientState,
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
      // WHY it had no activity, from the row (`0037`). A reap used to report
      // only that nothing had been said, which is a symptom with a dozen
      // causes; this is the page's own last word about itself, and `null` here
      // is itself a finding — the document never ran or could not reach us.
      clientState: session.clientState,
      clientDetail: session.clientDetail,
      // Which clock cut it. A face nobody ever saw and a conversation that went
      // quiet are two different findings settled into the same `reaped` row.
      neverAppeared: this.#neverAppeared(session),
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
