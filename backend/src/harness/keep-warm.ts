import { LANES, type AskOptions, type Lane } from "./agent.js";

/**
 * **One cheap turn, taken so her first real sentence is not her last.**
 *
 * ## Why a turn, and why it cannot be avoided
 *
 * Measured 2026-08-22 on CLI 2.1.235: the binary emits **nothing at all** until
 * a user frame arrives — stdin was held open against a spawned process for
 * thirty seconds and no init frame came. So there is no free pre-warm. Spawning
 * early warms nothing, and nothing fails to say so; a lane becomes warm **only
 * by taking a turn**, which is why {@link WarmStatus.warm} is derived from
 * having seen an init rather than from holding a pid.
 *
 * That leaves an ordinary failure rather than an exotic one. He does not talk to
 * her for fifteen minutes, the idle reaper takes the process, he long-presses
 * her face, and the first thing she is asked is the thing that times out —
 * Runway's `BackendRPCTool` gives up at **8 seconds**, and a cold turn has
 * already measured 8,073ms with the real turn shape. A cold face is not slow.
 * It is silent.
 *
 * ## Why ON DEMAND rather than a background ping
 *
 * `syl-chzl.2.3`: *"A ping running all day to serve a feature used twice is
 * waste; warming when the long press happens costs one turn and is honest about
 * why."* So this is a function the session-open path calls, not a timer.
 *
 * ## What this turn is NOT allowed to be, and how each is held
 *
 * | constraint | how |
 * |---|---|
 * | **must not reach him** | It goes through `SylAgent.ask`, whose return value is the only reply path. `ConversationService` is what appends and broadcasts, and it is not in this path — so nothing is persisted, nothing is pushed, nothing appears in the app. |
 * | **must not spend the day's allowance** | The allowance that bounds how often she speaks is counted over *runs of the heartbeat job* (`jobs/heartbeat-job.ts` reading the runs table). This writes no run. |
 * | **must not write memory** | The commander lane is `autoMemoryOff()`, so the CLI writes nothing; extraction into the graph is driven by `ConversationService`, which is not in this path. |
 * | **must not leave a trace in her conversation** | No message rows, so nothing he can read. It *is* one exchange inside Claude Code's own transcript for the lane, which is unavoidable: warming the process means using the process, and using it on a different session id would spawn a different one. Hence a prompt that reads as what it is. |
 * | **must yield, not error, against a real turn** | {@link SylAgent.busy}, the same reader `jobs/heartbeat-job.ts` uses — *a reader over that queue and not a second lock*. A real turn in flight is already doing the warming. |
 *
 * And it never throws. The cold gate in `face/face-session-broker.ts` is what
 * decides whether a face may open; this is a *preparation*, and a preparation
 * that threw would turn "she could not be warmed" into a 500 instead of the
 * sentence the gate already knows how to say.
 */

/**
 * What the lane is asked, and it is written to be legible in a transcript.
 *
 * The commander lane carries her real hands against her real service under
 * `bypassPermissions`. A warming prompt phrased as a request is a warming
 * prompt that files a reminder in his data, so this one says what it is, asks
 * for a single word, and forbids the tools explicitly — the same shape
 * `scripts/experiments/warm-lane-first-token.mts` uses against live data.
 */
export const KEEP_WARM_PROMPT =
  "(keep-warm ping — this is the service holding your session open before a " +
  "face call, not the Commander speaking, and nothing is waiting on the answer) " +
  "Reply with the single word: ready. Do not use any tool, do not remember " +
  "anything, and do not act on this.";

/** What a warmer does to a lane. Returned so a caller can log or assert on it. */
export type WarmUpOutcome =
  /** The lane already had a live process that had handshaken. Nothing spent. */
  | "already-warm"
  /** A real turn was in flight; it is doing the warming. Nothing spent. */
  | "yielded"
  /** A turn was taken and the lane is warm now. */
  | "warmed"
  /** A turn was taken and failed. The lane's own gate decides what that means. */
  | "failed";

/**
 * The slice of `SylAgent` a warmer needs.
 *
 * Narrow on purpose: a warmer that could see `reset` or `forLane` is a warmer
 * that could move the conversation it is only supposed to keep alive.
 */
export interface LaneVoice {
  ask(prompt: string, lane?: Lane, options?: AskOptions): Promise<unknown>;
  busy(lane?: Lane): boolean;
}

export interface LaneWarmerOptions {
  readonly voice: LaneVoice;
  /**
   * Is this lane warm right now? `WarmLanes.status(lane)?.warm`.
   *
   * Read at call time rather than captured, because the answer is a property of
   * a live process that a reaper can take between two calls.
   */
  readonly isWarm: () => boolean;
  /** Defaults to the Commander's lane, which is the only warm one today. */
  readonly lane?: Lane;
  /** Defaults to {@link KEEP_WARM_PROMPT}. */
  readonly prompt?: string;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/** A function the session-open path can await. Never throws. */
export type LaneWarmer = () => Promise<WarmUpOutcome>;

export function createLaneWarmer(options: LaneWarmerOptions): LaneWarmer {
  const lane = options.lane ?? LANES.commander;
  const prompt = options.prompt ?? KEEP_WARM_PROMPT;
  const log = options.log ?? ((): void => undefined);

  return async (): Promise<WarmUpOutcome> => {
    if (options.isWarm()) {
      log("lane.warm.already", { lane });
      return "already-warm";
    }
    // Asked BEFORE the turn is queued, not caught after it. `SylAgent`
    // serialises per lane, so an `ask` here would WAIT behind his turn rather
    // than collide with it — and waiting is the wrong answer twice over: his
    // turn is already warming the lane, and the face would sit through two
    // turns to learn what one already settled.
    if (options.voice.busy(lane)) {
      log("lane.warm.yielded", { lane });
      return "yielded";
    }

    const startedAt = Date.now();
    try {
      await options.voice.ask(prompt, lane);
      log("lane.warm.taken", { lane, ms: Date.now() - startedAt });
      return "warmed";
    } catch (error) {
      log("lane.warm.failed", {
        lane,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
  };
}
