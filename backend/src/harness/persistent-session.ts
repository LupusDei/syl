import { spawn, type ChildProcess } from "node:child_process";

import { assertAutoMemory } from "../memory/auto-memory.js";

import { resolveClaudeBinFromProcess } from "./claude-bin.js";
import {
  assembleReply,
  assertSubscriptionAuth,
  buildUserFrame,
  createLineDecoder,
  parseEvent,
  type InitEvent,
  type ResultEvent,
  type SylEvent,
} from "./protocol.js";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  TurnTimeoutError,
  buildTurnArgv,
  childEnv,
  newSessionId,
  turnShapeArgs,
  type TurnOptions,
  type TurnResult,
} from "./session.js";

/**
 * One `claude` process serving many turns on ONE lane — the warm path.
 *
 * ## Why this exists
 *
 * `runTurn` spawns a subprocess per turn, and until 2026-08-09 it had no
 * choice: a turn did not complete until stdin reached EOF. That is no longer
 * true on CLI 2.1.226. A `result` arrives with stdin still open and further
 * frames can be sent down the same process against the same session id
 * (`scripts/experiments/persistent-session.mjs`, and re-measured 2026-08-22).
 *
 * The per-turn path is not replaced. It is a **lane split** — see
 * `harness/warm-lanes.ts` for which turns go which way, and why
 * `runReaderTurn` can never be one of them.
 *
 * ## The three costs, designed rather than stumbled into
 *
 * `syl-per1` is explicit that persistence "reintroduces exactly what the
 * original decision was praising us for avoiding: a process to supervise, a
 * crash that costs more than one turn, and backpressure … they must be
 * DESIGNED, not stumbled into." Each is answered here, and each answer has a
 * test in `tests/unit/persistent-session.test.ts` named for it.
 *
 * **1. A process to supervise.** This object owns exactly one child and its
 * whole lifecycle. It is spawned **lazily, by a turn that needs it** — there is
 * no supervisor loop and no restart storm, because a dead process costs nothing
 * until somebody wants a turn. Death is noticed by the `close` and `error`
 * handlers installed at spawn, which fail whatever turn is in flight rather
 * than letting it hang. A wedged process — alive, holding its pipes, producing
 * nothing — is indistinguishable from a busy one except by the clock, so the
 * per-turn deadline is what tells them apart, and it **takes the process with
 * it**: a late result arriving in the middle of somebody else's turn is worse
 * than a respawn. An idle process is reaped on a timer. `close()` is the
 * owner's end of the lifecycle, for service shutdown.
 *
 * **2. A crash costing more than one turn.** It costs one turn, and the design
 * is that the *conversation* lives somewhere this process does not. The session
 * id is announced through `onSessionId` **before the spawn** and persisted by
 * `SylAgent` into `.syl/sessions/<lane>`; when the process is gone, the next
 * turn spawns again with `--resume <that id>` and the Commander sees nothing.
 * If the id itself has become unusable, this throws in the exact shape
 * `SylAgent.isResumeFailure` already recognises, so its stale-session recovery
 * handles it — **reused, not reinvented.** A turn that arrives with no `resume`
 * at all is `SylAgent.reset()` seen from here, and it retires the process
 * rather than quietly continuing a conversation the caller threw away.
 *
 * **3. Backpressure.** There is **no queue here, deliberately.** `SylAgent`
 * already serialises turns per lane over the session store, and
 * `ConversationService` serialises per conversation. A third queue could
 * disagree with both, and "two locking schemes over one session id" is the bug
 * `harness/agent.ts` already warns about. So a concurrent turn is *refused*,
 * loudly, with {@link ConcurrentTurnError}. An assertion cannot disagree with a
 * queue; it can only detect that the queue failed.
 *
 * ## Two things measured on 2026-08-22 that decided the shape
 *
 * - **The CLI emits no `init` frame until a user frame arrives.** Stdin held
 *   idle against a spawned process for 30 seconds produced nothing. So there is
 *   no free pre-warm: spawning early does not warm a lane, and `warm` in
 *   {@link WarmStatus} is derived from having seen an init rather than from
 *   holding a pid. **A lane becomes warm by taking a turn**, and anyone
 *   building a pre-warmer that only spawns will find it does nothing.
 * - **The CLI emits a FRESH init frame on every turn**, four to six
 *   milliseconds after the frame, carrying `apiKeySource` each time. This is
 *   what removes the worry that a long-lived process asserts subscription rails
 *   once and then trusts them for hours: {@link PersistentSession} asserts on
 *   each turn's own init frame, so the guard is exactly as strong here as on
 *   the per-turn path.
 */

/** How long a killed child gets to exit on SIGTERM before SIGKILL. */
const SIGKILL_GRACE_MS = 2_000;

/**
 * How long a warm process may sit unused before it is reaped.
 *
 * A conversation has gaps, and paying a spawn for every gap would give back the
 * whole point of the lane. Fifteen minutes keeps a live exchange warm through
 * an interruption while not leaving a CLI resident overnight for nobody.
 */
export const DEFAULT_IDLE_MS = 15 * 60_000;

/** How much stderr is kept, so a death can be explained without unbounded memory. */
const STDERR_KEPT = 8_000;

/**
 * The process went away while a turn was in flight.
 *
 * Distinct from a turn that failed and from one that timed out: the request is
 * lost and nothing is known about whether the work happened. Deliberately NOT
 * phrased so that `SylAgent`'s resume-failure matcher picks it up — the stored
 * session id is fine, and clearing it would throw away a conversation over a
 * dead pipe.
 */
export class SessionDiedError extends Error {
  readonly lane: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(lane: string, exitCode: number | null, signal: NodeJS.Signals | null, stderr: string) {
    super(
      `The warm claude process for lane "${lane}" exited (code ${exitCode ?? "null"}` +
        `${signal ? `, signal ${signal}` : ""}) while a turn was in flight. ` +
        `The conversation is intact and the next turn will respawn and resume it.` +
        (stderr.trim() === "" ? "" : ` stderr: ${stderr.trim()}`),
    );
    this.name = "SessionDiedError";
    this.lane = lane;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/**
 * A second turn arrived while one was already running on this lane.
 *
 * This is a **bug detector, not backpressure**. The queues that make it
 * unreachable are `SylAgent`'s per-lane chain and `ConversationService`'s
 * per-conversation lock; if this throws, one of them has been bypassed, and the
 * alternative to throwing is two prompts interleaved on one transcript.
 */
export class ConcurrentTurnError extends Error {
  readonly lane: string;

  constructor(lane: string) {
    super(
      `A turn is already running on the warm lane "${lane}". Turns are serialised ` +
        `by SylAgent (per lane) and ConversationService (per conversation); this ` +
        `session refuses rather than adding a queue that could disagree with them.`,
    );
    this.name = "ConcurrentTurnError";
    this.lane = lane;
  }
}

/** What a warm lane can be asked about — see `syl-chzl.2.2`. */
export interface WarmStatus {
  readonly lane: string;
  /**
   * A live child that has completed an init handshake.
   *
   * Not "a process exists": the CLI does no work until a frame arrives, so a
   * spawned-but-unaddressed process is cold. This being true means the lane has
   * already taken at least one turn.
   */
  readonly warm: boolean;
  /** A turn is running right now. */
  readonly busy: boolean;
  /** The conversation the live process is on. */
  readonly sessionId: string | undefined;
  readonly pid: number | undefined;
  /**
   * `apiKeySource` from the most recent init frame. `"none"` is the only
   * acceptable value — anything else means billing left subscription rails.
   */
  readonly apiKeySource: string | undefined;
  /** Turns this process has completed. Resets with the process. */
  readonly turnsServed: number;
  /** Milliseconds since the last turn settled, or `undefined` when cold or busy. */
  readonly idleForMs: number | undefined;
}

export interface PersistentSessionOptions {
  /** Which of Syl's lanes this process serves. One lane, one process. */
  readonly lane: string;
  /** Idle ceiling before the process is reaped. Defaults to {@link DEFAULT_IDLE_MS}. */
  readonly idleMs?: number;
  /** Clock seam, for tests that reason about idleness. */
  readonly now?: () => number;
}

/** The live child and everything known about it. */
interface Live {
  readonly child: ChildProcess;
  /** The turn shape this process was spawned for. See {@link turnShapeArgs}. */
  readonly fingerprint: string;
  readonly sessionId: string;
  /** Whether the subscription guard applies to this process's turns. */
  readonly requireSubscriptionAuth: boolean;
  readonly autoMemory: TurnOptions["autoMemory"];
  init: InitEvent | undefined;
  stderr: string;
  turnsServed: number;
  lastSettledAt: number;
  gone: boolean;
  /** Events arriving between turns, adopted by the next one. */
  pending: SylEvent[];
  /** Where decoded events go while a turn is in flight. */
  sink: ((event: SylEvent) => void) | undefined;
  /** Fails the in-flight turn when the child goes away. */
  onDeath: ((error: SessionDiedError) => void) | undefined;
}

export class PersistentSession {
  readonly #lane: string;
  readonly #idleMs: number;
  readonly #now: () => number;

  #live: Live | undefined;
  #inFlight = false;
  #closed = false;
  #reaper: NodeJS.Timeout | undefined;

  constructor(options: PersistentSessionOptions) {
    this.#lane = options.lane;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#now = options.now ?? Date.now;
  }

  get lane(): string {
    return this.#lane;
  }

  /** What the warm-lane precondition reads. Never throws; safe to poll. */
  status(): WarmStatus {
    const live = this.#live;
    const warm = live !== undefined && !live.gone && live.init !== undefined;
    return {
      lane: this.#lane,
      warm,
      busy: this.#inFlight,
      sessionId: live && !live.gone ? live.sessionId : undefined,
      pid: live && !live.gone ? live.child.pid : undefined,
      apiKeySource: live?.init?.apiKeySource,
      turnsServed: live && !live.gone ? live.turnsServed : 0,
      idleForMs:
        warm && !this.#inFlight && live !== undefined ? this.#now() - live.lastSettledAt : undefined,
    };
  }

  /**
   * Take one turn. Signature-compatible with `TurnRunner`, so it drops straight
   * into `SylAgent` as a runner.
   */
  run = async (prompt: string, options: TurnOptions = {}): Promise<TurnResult> => {
    // Validated before anything is spawned or written, exactly as `runTurn`
    // does — an empty prompt must not cost a process.
    const frame = buildUserFrame(prompt);

    if (this.#closed) {
      throw new Error(`The warm session for lane "${this.#lane}" is closed and will not spawn again.`);
    }
    // A persistent process must not blur lanes. Checked before the concurrency
    // guard so a misrouted turn reads as a routing bug and not as contention.
    if (options.lane !== this.#lane) {
      throw new Error(
        `This warm session serves lane "${this.#lane}" but the turn belongs to ` +
          `"${options.lane ?? "(none)"}". One process per lane: sessions are per lane so ` +
          `Syl's inner monologue does not interleave with the Commander's conversation.`,
      );
    }
    if (this.#inFlight) throw new ConcurrentTurnError(this.#lane);

    this.#inFlight = true;
    this.#disarmReaper();
    try {
      return await this.#turn(frame, options);
    } finally {
      this.#inFlight = false;
      if (this.#live) this.#live.lastSettledAt = this.#now();
      this.#armReaper();
    }
  };

  /** End the process. The owner's half of the lifecycle. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#disarmReaper();
    await this.#retire();
  }

  async #turn(frame: string, options: TurnOptions): Promise<TurnResult> {
    const fingerprint = spawnFingerprint(options);
    if (this.#live && !this.#usable(this.#live, fingerprint, options)) await this.#retire();

    // Settled BEFORE the spawn and announced before it, so a crash between
    // spawn and init cannot strand a conversation that exists on disk with no
    // id anybody can reach it by. Same ordering as `runTurn`, for the same
    // reason; a warm turn announces the live id so the store stays correct.
    const sessionId = this.#live?.sessionId ?? options.resume ?? options.sessionId ?? newSessionId();
    options.onSessionId?.(sessionId);

    const live = this.#live ?? this.#spawn(sessionId, fingerprint, options);

    const events: SylEvent[] = [];
    let fatal: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    const settled = new Promise<ResultEvent>((resolve, reject) => {
      live.onDeath = reject;
      live.sink = (event) => {
        events.push(event);
        options.onEvent?.(event);

        if (event.kind === "init") {
          live.init = event;
          // Per TURN, not per process. The CLI re-emits init on every turn, so
          // this is a check against a fresh frame rather than a remembered one:
          // a process that started clean and later resolved an API key fails
          // the turn that discovers it instead of billing quietly for hours.
          try {
            if (live.requireSubscriptionAuth) assertSubscriptionAuth(event);
            if (live.autoMemory) assertAutoMemory(event, live.autoMemory);
          } catch (error) {
            fatal = error as Error;
            // The process itself is the problem — it is on the wrong rail or
            // writing memory somewhere Syl cannot read. It must not survive to
            // serve the next turn.
            void this.#retire();
            reject(error as Error);
          }
        }

        // An api_error arrives shaped like an ordinary assistant message and is
        // followed by a result. Recorded, then thrown below, so a billing
        // failure is never relayed as though Syl had answered.
        if (event.kind === "api_error") {
          fatal ??= new Error(
            `Claude API error${event.errorType ? ` (${event.errorType})` : ""}: ${event.message}`,
          );
        }

        if (event.kind === "result") resolve(event);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Wedged, not busy — the only thing that distinguishes them is this
          // clock. Take the process with it: a late result arriving during
          // somebody else's turn is worse than a respawn.
          const sawInit = live.init !== undefined;
          void this.#retire();
          reject(new TurnTimeoutError(timeoutMs, sawInit));
        }, timeoutMs);
      }

      // Anything the process said between turns is adopted by this one, and
      // adopted THROUGH THE SINK rather than copied past it. Draining it into
      // the array directly would let an init frame that arrived at an odd
      // moment skip the subscription and auto-memory guards — the one shape of
      // event that must never reach a turn unchecked.
      const buffered = live.pending.splice(0);
      for (const event of buffered) live.sink(event);

      // Written only once every handler above is installed, so nothing this
      // turn produces can arrive before there is somewhere to put it.
      live.child.stdin?.write(frame);
    });

    let result: ResultEvent;
    try {
      result = await settled;
    } finally {
      clearTimeout(timer);
      live.sink = undefined;
      live.onDeath = undefined;
    }

    if (fatal) throw fatal;

    const init = live.init;
    if (!init) {
      throw new Error(
        `The warm claude process for lane "${this.#lane}" produced a result with no init frame.`,
      );
    }
    if (result.isError) {
      throw new Error(`Claude turn failed: ${result.result || live.stderr.trim() || "unknown error"}`);
    }

    live.turnsServed += 1;
    return {
      sessionId: init.sessionId,
      text: result.result,
      spoken: assembleReply(events, result.result),
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      init,
      events,
    };
  }

  /**
   * May this live process serve this turn?
   *
   * Three questions, and each has cost somebody a bug elsewhere in this
   * codebase: is it still there, was it spawned with the flags this turn wants,
   * and is it on the conversation this turn means.
   */
  #usable(live: Live, fingerprint: string, options: TurnOptions): boolean {
    if (live.gone) return false;
    if (live.fingerprint !== fingerprint) return false;
    // `resume === undefined` means the caller wants a NEW conversation —
    // `SylAgent.reset()` after a stale session, most often. Feeding that to the
    // running process would silently continue the one it just threw away.
    return options.resume === live.sessionId;
  }

  #spawn(sessionId: string, fingerprint: string, options: TurnOptions): Live {
    const args = buildTurnArgv(options, sessionId);
    const claudeBin = options.claudeBin ?? resolveClaudeBinFromProcess();
    const child = spawn(claudeBin, args, {
      cwd: options.cwd ?? process.cwd(),
      // Credentials stripped on every spawn, including every respawn. See
      // `childEnv` — this matters more for a long-lived child, not less.
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const live: Live = {
      child,
      fingerprint,
      sessionId,
      requireSubscriptionAuth: options.requireSubscriptionAuth !== false,
      autoMemory: options.autoMemory,
      init: undefined,
      stderr: "",
      turnsServed: 0,
      lastSettledAt: this.#now(),
      gone: false,
      pending: [],
      sink: undefined,
      onDeath: undefined,
    };
    this.#live = live;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const decode = createLineDecoder();
    child.stdout?.on("data", (chunk: string) => {
      for (const line of decode(chunk)) {
        const event = parseEvent(line);
        if (!event) continue;
        // Between turns there is no sink. Held rather than dropped: the next
        // turn adopts them, so nothing the process said is silently lost.
        if (live.sink) live.sink(event);
        else live.pending.push(event);
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      live.stderr = (live.stderr + chunk).slice(-STDERR_KEPT);
    });

    // If the CLI rejects its arguments it exits before reading stdin and the
    // write lands on a closed pipe. An unhandled EPIPE takes the whole service
    // down and buries the exit code that actually explains the failure.
    child.stdin?.on("error", () => {
      /* deliberately ignored — the death handler below explains what happened */
    });

    const died = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (live.gone) return;
      live.gone = true;
      if (this.#live === live) this.#live = undefined;
      const waiting = live.onDeath;
      live.onDeath = undefined;
      live.sink = undefined;
      if (!waiting) return;
      // A process that dies before ever producing an init failed to START —
      // most often a `--resume` onto a conversation that no longer exists. That
      // must reach `SylAgent` in the shape its stale-session recovery matches,
      // which is the same sentence `runTurn` throws, so there is one mechanism
      // and not two.
      waiting(
        live.init === undefined
          ? (new Error(
              `claude exited with code ${exitCode ?? "null"} before the init handshake. ` +
                `stderr: ${live.stderr.trim()}`,
            ) as SessionDiedError)
          : new SessionDiedError(this.#lane, exitCode, signal, live.stderr),
      );
    };

    child.once("close", (code, signal) => died(code, signal));
    child.once("error", (error) => {
      live.stderr = `${live.stderr}${String(error)}`;
      died(null, null);
    });

    return live;
  }

  /** End the current process, if any, and wait for it to actually be gone. */
  async #retire(): Promise<void> {
    const live = this.#live;
    if (!live) return;
    this.#live = undefined;
    if (live.gone) return;
    live.gone = true;

    const exited = new Promise<void>((resolve) => {
      if (live.child.exitCode !== null || live.child.signalCode !== null) return resolve();
      live.child.once("close", () => resolve());
    });

    try {
      live.child.stdin?.end();
    } catch {
      /* already gone */
    }
    live.child.kill("SIGTERM");
    const hard = setTimeout(() => live.child.kill("SIGKILL"), SIGKILL_GRACE_MS);
    hard.unref();
    try {
      await exited;
    } finally {
      clearTimeout(hard);
    }
  }

  #armReaper(): void {
    this.#disarmReaper();
    if (this.#idleMs <= 0 || !this.#live || this.#closed) return;
    this.#reaper = setTimeout(() => {
      // Measured on idleness, not age: a turn doing real work for minutes is
      // not idle, and reaping it would invent the failure the reaper prevents.
      if (this.#inFlight) return this.#armReaper();
      void this.#retire();
    }, this.#idleMs);
    this.#reaper.unref();
  }

  #disarmReaper(): void {
    if (this.#reaper) clearTimeout(this.#reaper);
    this.#reaper = undefined;
  }
}

/**
 * What a live process was spawned for, as a comparable string.
 *
 * Derived from `turnShapeArgs` — **the same array the CLI is actually invoked
 * with** — rather than from a list of "options that affect the spawn" kept
 * beside it. That is the difference between a property that can go stale and
 * one that cannot: a `TurnOptions` field added next month is covered the moment
 * it reaches the argv builder, with nothing to remember.
 *
 * `cwd` and the binary path are in it for the same reason and are not in argv.
 *
 * **Which conversation is deliberately NOT in here**, and getting that wrong
 * once cost seven tests at a stroke: turn one mints (`--session-id`) and turn
 * two resumes (`--resume`) *the same conversation*, so a fingerprint carrying
 * either flag makes every warm process a one-turn process — the exact
 * behaviour this module exists to remove, arriving silently as a performance
 * regression rather than a failure. That question belongs to
 * `PersistentSession.#usable`, which asks it about the live session id.
 */
export function spawnFingerprint(options: TurnOptions): string {
  return JSON.stringify([
    options.cwd ?? process.cwd(),
    options.claudeBin ?? null,
    options.requireSubscriptionAuth !== false,
    turnShapeArgs(options),
  ]);
}
