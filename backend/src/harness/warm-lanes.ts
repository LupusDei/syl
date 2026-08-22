import { LANES, type Lane } from "./agent.js";
import { PersistentSession, type WarmStatus } from "./persistent-session.js";
import { runTurn, type TurnOptions, type TurnResult, type TurnRunner } from "./session.js";

/**
 * **The lane split.** Which of Syl's turns run on a warm persistent process,
 * and which keep spawning and dying.
 *
 * `syl-per1` re-measured the constraint the architecture was built on and found
 * it gone: one process can serve many turns. It is explicit that this is a
 * **split and not a replacement** — "keep the per-turn path … persistence is
 * for the COMMANDER LANE, where latency is felt."
 *
 * ## WARM — a person is waiting
 *
 * {@link WARM_LANES}. The Commander's own conversation, which is also the
 * thread her unattended turns resume (see `harness/agent.ts`), and whatever
 * live-face lane rides on it. A cold spawn is seconds of silence in the middle
 * of a conversation with a person in it, and for the realtime face it is worse
 * than slow: Runway's `BackendRPCTool` caps `timeoutSeconds` at **8**, so a
 * cold first utterance does not arrive late, it does not arrive.
 *
 * ## PER-TURN — nobody is waiting, and isolation is worth more than seconds
 *
 * Everything else, unchanged: scheduled jobs, the hourly self-ping, the morning
 * brief, the nightly consolidation, the render review. A spawn costs a few
 * seconds nobody is counting, and a crash costs exactly the job that caused it.
 *
 * ## NEVER WARM — `runReaderTurn`, and it is not on this list to be left off it
 *
 * The reader's security property IS the process: `--tools ""`, no MCP config,
 * auto-memory off, a session that is never resumed and never persisted. A
 * persistent reader session is a quarantine with a door in it — one injected
 * article would reach every later read down the same process.
 *
 * That is not held by this router's judgement. It is held twice, structurally:
 *
 * - `harness/reader.ts` imports `runTurn` **directly** and takes no injectable
 *   runner, so no wiring mistake can route it here at all;
 * - and this router keys on `TurnOptions.lane`, which a reader turn does not
 *   set — so even a reader driven through this object falls to the per-turn
 *   path. **Absence routes cold**, which is the safe direction.
 *
 * Both are asserted in `tests/unit/warm-lanes.test.ts`.
 */

/**
 * The lanes that run on a persistent process.
 *
 * One entry, and the shape of the argument is worth keeping even while the list
 * is short: a lane is warm because **a person is waiting on it**, not because
 * it is important. The dream is the most expensive thing Syl does and it stays
 * cold, because nobody is sitting in front of it at 03:00.
 */
export const WARM_LANES: ReadonlySet<Lane> = new Set<Lane>([LANES.commander]);

export interface WarmLanesOptions {
  /** Which lanes go warm. Defaults to {@link WARM_LANES}. */
  readonly lanes?: Iterable<Lane>;
  /**
   * What runs everything else. Defaults to `runTurn` — spawn, one turn, die.
   *
   * A seam for tests and for the wrappers `index.ts` already puts around a
   * runner (`withMemoryIndex`, `recordHisWords`), which must apply to warm and
   * cold turns alike or a guarantee would hold on only half of them.
   */
  readonly fallback?: TurnRunner;
  /** Idle ceiling for each warm process. See `PersistentSession`. */
  readonly idleMs?: number;
}

/**
 * Routes each turn to the warm path or the per-turn path, and owns the warm
 * processes' lifecycle.
 *
 * One `PersistentSession` per warm lane, created lazily. The service that
 * constructs this owns it and must `close()` it on shutdown; nothing here
 * reaps at the process level, because a warm session that outlives its service
 * is the "process to supervise" cost arriving through the back door.
 */
export class WarmLanes {
  readonly #lanes: ReadonlySet<Lane>;
  readonly #fallback: TurnRunner;
  readonly #idleMs: number | undefined;
  readonly #sessions = new Map<Lane, PersistentSession>();
  #closed = false;

  constructor(options: WarmLanesOptions = {}) {
    this.#lanes = options.lanes ? new Set(options.lanes) : WARM_LANES;
    this.#fallback = options.fallback ?? runTurn;
    this.#idleMs = options.idleMs;
  }

  /** Does this turn run warm? Derived from its lane and nothing else. */
  isWarm(options: TurnOptions): boolean {
    // `undefined` is not a member of the set, so a turn that names no lane —
    // every reader turn, and anything else that forgot — routes cold. The
    // default must be the one that costs seconds rather than the one that
    // shares a process.
    return options.lane !== undefined && this.#lanes.has(options.lane);
  }

  /** A `TurnRunner` that routes. Drop it into `SylAgent` in place of `runTurn`. */
  readonly runner: TurnRunner = async (
    prompt: string,
    options: TurnOptions = {},
  ): Promise<TurnResult> => {
    if (!this.isWarm(options) || this.#closed) return this.#fallback(prompt, options);
    const lane = options.lane;
    if (lane === undefined) return this.#fallback(prompt, options);
    return this.#sessionFor(lane).run(prompt, options);
  };

  /** This lane's warm status, or `undefined` if the lane is not a warm one. */
  status(lane: Lane): WarmStatus | undefined {
    if (!this.#lanes.has(lane)) return undefined;
    return (
      this.#sessions.get(lane)?.status() ?? {
        lane,
        warm: false,
        busy: false,
        sessionId: undefined,
        pid: undefined,
        apiKeySource: undefined,
        turnsServed: 0,
        idleForMs: undefined,
      }
    );
  }

  /** Every warm lane's status, for the admin and for the boot notice. */
  statuses(): WarmStatus[] {
    return [...this.#lanes].flatMap((lane) => {
      const status = this.status(lane);
      return status ? [status] : [];
    });
  }

  /** End every warm process. The owner's half of the lifecycle. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions.values()].map((session) => session.close()));
    this.#sessions.clear();
  }

  #sessionFor(lane: Lane): PersistentSession {
    const existing = this.#sessions.get(lane);
    if (existing) return existing;
    const created = new PersistentSession({
      lane,
      ...(this.#idleMs === undefined ? {} : { idleMs: this.#idleMs }),
    });
    this.#sessions.set(lane, created);
    return created;
  }
}
