import type { Clock } from "../services/clock.js";
import { systemClock } from "../services/clock.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Database } from "../services/sqlite.js";
import { AskSylIngress } from "./ask-syl.js";
import { FaceConversation } from "./face-conversation.js";
import { FaceCostGuard, type CostModel } from "./face-cost-guard.js";
import { FaceSessionBroker } from "./face-session-broker.js";
import { ClientReportIngress } from "./client-report.js";
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
  /**
   * Leave EVERY room. The service's half of the lifecycle, at shutdown.
   *
   * Optional so a transport that holds nothing — {@link NO_TRANSPORT}, and every
   * fake in the tests — needs no ceremony. A transport that DOES hold rooms and
   * omits this leaves participants of ours in live sessions that only the
   * provider's cap will end.
   */
  closeAll?(): Promise<void>;
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

/**
 * What a transport needs from the runtime it is being built into.
 *
 * The real transport (`face/rpc-transport.ts`) binds the `ask_syl` handler to
 * the ingress and fetches room credentials through the broker — both of which
 * are constructed *here*. So a caller cannot hand in a finished transport
 * without duplicating the assembly, and a factory is the seam that avoids it.
 */
export interface FaceTransportDeps {
  readonly ingress: AskSylIngress;
  readonly broker: FaceSessionBroker;
}

export interface FaceRuntimeOptions {
  readonly db: Database;
  /** The seam a face turn runs through. See `face-conversation.ts`. */
  readonly conversations: Pick<ConversationService, "ask">;
  /** Her avatar. Defaults to `SYL_FACE_AVATAR_ID`. */
  readonly avatarId?: string;
  /** `syl-chzl.2.2`'s predicate — `WarmLanes.status(commander)?.warm`. */
  readonly isLaneWarm?: () => boolean;
  /**
   * `syl-chzl.2.3` — one cheap turn taken when a session opens, so the first
   * real question does not pay the cold cost. `harness/keep-warm.ts` builds it.
   *
   * Handed to the broker rather than called here, because the moment that
   * matters is `startSession`, before its cold gate: everything else in this
   * runtime happens after a session already exists.
   */
  readonly warmLane?: () => Promise<unknown>;
  /**
   * What the warm lane's live process last reported as `apiKeySource`.
   * `WarmLanes.status(commander)?.apiKeySource`. See `face-conversation.ts`.
   */
  readonly laneRail?: () => string | undefined;
  /**
   * How a session is cut and how the avatar's tool loop is attached.
   *
   * A **factory** as well as a value, because the real one needs the ingress and
   * the broker this function builds. Defaults to {@link NO_TRANSPORT}, which
   * opens a mute face — see the note on it for why that still closes honestly.
   */
  readonly transport?: FaceTransport | ((deps: FaceTransportDeps) => FaceTransport);
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
  /** What the page drawing her says became of it. See `client-report.ts`. */
  readonly reports: ClientReportIngress;
  readonly reaper: IdleReaper;
  readonly transport: FaceTransport;
  /**
   * The sink every part of the face writes to.
   *
   * Exposed so `routes/face.ts` writes to the SAME place as the broker, the
   * reaper and the transport. It used to default to `console.info` in each of
   * five constructors independently, which meant the whole subsystem wrote to
   * stdout while `syl.log` and `GET /logs` had nothing about her face in them.
   * One runtime, one sink, and a caller that forgets is a type error.
   */
  readonly log: (event: string, fields: Record<string, unknown>) => void;
  /** The same, for the lines an operator is meant to be woken by. */
  readonly logError: (event: string, fields: Record<string, unknown>) => void;
  /** Start the reaper and put today's spend back into the guard. */
  start(): void;
  /**
   * Stop the reaper and leave every room.
   *
   * Does **not** settle live sessions — the ledger keeps them, and
   * `liveSessions()` is how the next boot finds what a dead process left
   * running. Leaving the rooms is a different thing from settling the rows:
   * one stops us paying attention, the other stops us being in the call.
   */
  stop(): Promise<void>;
}

export function createFaceRuntime(options: FaceRuntimeOptions): FaceRuntime {
  const clock = options.clock ?? systemClock;

  const sessions = new FaceSessionStore({ db: options.db, clock });
  const guard = new FaceCostGuard({
    now: clock,
    ...(options.dailyCreditCeiling === undefined
      ? {}
      : { dailyCreditCeiling: options.dailyCreditCeiling }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.costModel === undefined ? {} : { costModel: options.costModel }),
  });

  // The transport is built FROM the broker (it needs `connectBackend`) and the
  // broker supersedes THROUGH the transport (it needs `close`). One of the two
  // references has to be late-bound; this is it, and it is a `let` rather than
  // a second factory because the alternative is duplicating the assembly this
  // module exists to hold in one place.
  let wired: FaceTransport | null = null;

  const broker = new FaceSessionBroker({
    guard,
    sessions,
    now: clock,
    // One face at a time. See `FaceSessionBroker.#supersedeLive`: a second long
    // press must end the first face rather than bill alongside it, and it must
    // actually cut the stream before it settles the row.
    disconnect: async (sessionId: string): Promise<void> => {
      await wired?.close(sessionId);
    },
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.avatarId === undefined ? {} : { avatarId: options.avatarId }),
    ...(options.isLaneWarm === undefined ? {} : { isLaneWarm: options.isLaneWarm }),
    ...(options.warmLane === undefined ? {} : { warmLane: options.warmLane }),
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

  // Built AFTER the ingress and the broker, because the real transport binds to
  // both. A plain value is still accepted — every test passes one.
  const transport =
    typeof options.transport === "function"
      ? options.transport({ ingress, broker })
      : (options.transport ?? NO_TRANSPORT);
  wired = transport;

  // What the page drawing her says became of it (`0037`). Built here beside the
  // ingress it deliberately does NOT share a credential with — see
  // `client-report.ts`.
  const reports = new ClientReportIngress({
    sessions,
    now: clock,
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
    reports,
    reaper,
    transport,
    log:
      options.log ??
      ((event: string, fields: Record<string, unknown>): void => {
        console.info(`[syl] ${event}`, fields);
      }),
    logError:
      options.logError ??
      ((event: string, fields: Record<string, unknown>): void => {
        console.error(`[syl] ${event}`, fields);
      }),
    start(): void {
      // Order matters: the ceiling must know what today already cost before the
      // first request can be gated against it.
      broker.seedFromLedger();
      reaper.start();
    },
    async stop(): Promise<void> {
      reaper.stop();
      await transport.closeAll?.();
    },
  };
}
