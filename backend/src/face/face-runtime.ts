import type { Clock } from "../services/clock.js";
import { systemClock } from "../services/clock.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Database } from "../services/sqlite.js";
import { AskSylIngress } from "./ask-syl.js";
import { FaceConversation } from "./face-conversation.js";
import { FaceCostGuard, type CostModel } from "./face-cost-guard.js";
import { FaceSessionBroker } from "./face-session-broker.js";
import { FaceSessionStore } from "./face-session-store.js";
import { IdleReaper } from "./idle-reaper.js";
import type { RunwaySessionApi } from "./runway-client.js";

/**
 * Her face, assembled — one object so `index.ts` and the test helpers each grow
 * by a line rather than by five.
 *
 * Assembly is its own module because the parts are deliberately unaware of each
 * other: the guard is pure, the store is durable, the broker owns the provider,
 * the ingress owns the eight-second ceiling, and the reaper owns the leak. That
 * separation is what lets each be exercised in milliseconds; this is the one
 * place that pays for it, and it pays once.
 */

/**
 * How a session is actually cut, and how the avatar's tool loop is attached.
 *
 * A seam rather than a concrete LiveKit worker, because the worker drags
 * `@livekit/rtc-node` — a platform-specific native binary — into a service that
 * deploys from a plain `tsc` build. That is a decision to take deliberately
 * rather than as a side effect of assembling a router.
 */
export interface FaceTransport {
  /** Join the session's room and register `ask_syl` on our participant. */
  attach(input: { readonly sessionId: string; readonly askSecret: string }): Promise<void>;
  /** Leave the room, which is what stops the stream. */
  close(sessionId: string): Promise<void>;
}

/**
 * The no-transport transport.
 *
 * `attach` does nothing, so the avatar has no tool to call and the face opens
 * mute. `close` **resolves**, and that is a truthful answer rather than a
 * convenient one: with nothing attached there is nothing of ours holding the
 * session open, so closing our side genuinely succeeded and the provider's own
 * cap ends the rest. If a real transport is wired and its close fails, the
 * reaper escalates — see `idle-reaper.ts`.
 */
export const NO_TRANSPORT: FaceTransport = {
  attach: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

export interface FaceRuntimeOptions {
  readonly db: Database;
  /** The seam a face turn runs through. See `face-conversation.ts`. */
  readonly conversations: Pick<ConversationService, "ask">;
  /** Her avatar. Defaults to `SYL_FACE_AVATAR_ID`. */
  readonly avatarId?: string;
  /** `syl-chzl.2.2`'s predicate — `WarmLanes.status(commander)?.warm`. */
  readonly isLaneWarm?: () => boolean;
  /**
   * What the warm lane's live process last reported as `apiKeySource`.
   * `WarmLanes.status(commander)?.apiKeySource`. See `face-conversation.ts`.
   */
  readonly laneRail?: () => string | undefined;
  readonly transport?: FaceTransport;
  /** Injected Runway client. Defaults to a real one, built lazily by the broker. */
  readonly client?: RunwaySessionApi;
  readonly dailyCreditCeiling?: number;
  readonly idleTimeoutMs?: number;
  readonly costModel?: CostModel;
  readonly clock?: Clock;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
  readonly logError?: (event: string, fields: Record<string, unknown>) => void;
}

export interface FaceRuntime {
  readonly sessions: FaceSessionStore;
  readonly guard: FaceCostGuard;
  readonly broker: FaceSessionBroker;
  readonly ingress: AskSylIngress;
  readonly reaper: IdleReaper;
  readonly transport: FaceTransport;
  /** Start the reaper and put today's spend back into the guard. */
  start(): void;
  /** Stop the reaper. Does not settle live sessions — the ledger keeps them. */
  stop(): void;
}

export function createFaceRuntime(options: FaceRuntimeOptions): FaceRuntime {
  const clock = options.clock ?? systemClock;
  const transport = options.transport ?? NO_TRANSPORT;

  const sessions = new FaceSessionStore({ db: options.db, clock });
  const guard = new FaceCostGuard({
    now: clock,
    ...(options.dailyCreditCeiling === undefined
      ? {}
      : { dailyCreditCeiling: options.dailyCreditCeiling }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.costModel === undefined ? {} : { costModel: options.costModel }),
  });

  const broker = new FaceSessionBroker({
    guard,
    sessions,
    now: clock,
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.avatarId === undefined ? {} : { avatarId: options.avatarId }),
    ...(options.isLaneWarm === undefined ? {} : { isLaneWarm: options.isLaneWarm }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const face = new FaceConversation({
    conversations: options.conversations,
    ...(options.laneRail === undefined ? {} : { laneRail: options.laneRail }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const ingress = new AskSylIngress({
    sessions,
    answer: face.answerer(),
    now: clock,
    ...(options.isLaneWarm === undefined ? {} : { isLaneWarm: options.isLaneWarm }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const reaper = new IdleReaper({
    broker,
    sessions,
    disconnect: (sessionId) => transport.close(sessionId),
    now: clock,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.logError === undefined ? {} : { logError: options.logError }),
  });

  return {
    sessions,
    guard,
    broker,
    ingress,
    reaper,
    transport,
    start(): void {
      // Order matters: the ceiling must know what today already cost before the
      // first request can be gated against it.
      broker.seedFromLedger();
      reaper.start();
    },
    stop(): void {
      reaper.stop();
    },
  };
}
