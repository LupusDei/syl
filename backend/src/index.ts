import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";

import type { Job, PushEnvironment } from "@syl/shared";

import {
  createNightlyDreamHandler,
  createYieldSignal,
  describeDream,
  ensureNightlyDreamJob,
  type NightDreamer,
} from "./jobs/dream-job.js";
import { createDeliveryRuntime, describeRuntime, type DeliveryRuntime } from "./jobs/runtime.js";
import { AdjutantClient } from "./agents/adjutant-client.js";
import { loadConfig, type SylConfig } from "./config.js";
import {
  createContentIngestionHandler,
  ensureContentIngestionJob,
  IntakeQueue,
} from "./connections/intake-job.js";
import { createIntakeRouter } from "./connections/intake-route.js";
import { ADMIN_BASE_PATH, createAdminRouter } from "./routes/admin.js";
import { describeAdmin, inspectAdminBundle } from "./ops/admin-bundle.js";
import { readBuildInfo, selfBuildStampPath } from "./ops/build-info.js";
import { ArticleIntake } from "./connections/intake.js";
import { IntakeStore } from "./connections/intake-store.js";
import { anyAuthenticatedDevice, requireBearerToken } from "./middleware/auth.js";
import { createAttachmentRouter, UPLOAD_BODY_LIMIT_BYTES } from "./routes/attachments.js";
import { createAuthRouter } from "./routes/auth.js";
import { createConversationRouter } from "./routes/conversations.js";
import { createDeliveryRouter } from "./routes/deliveries.js";
import { createDeviceRouter } from "./routes/devices.js";
import { ApiFailure, sendFailure } from "./routes/envelope.js";
import {
  assertPushEnvironment,
  assessPushEnvironment,
  describePushEnvironment,
  pushEnvironmentProbe,
  type PushEnvironmentAssertion,
} from "./ops/apns-environment.js";
import { assertContainer, describeContainer } from "./ops/container.js";
import { createLogger, toolArgumentsForLog, type Logger } from "./ops/logging.js";
import { assessPower, describePower } from "./ops/power.js";
import { installShutdownHandlers } from "./ops/shutdown.js";
import { tailnetCertProbe } from "./ops/tailnet-cert.js";
import { createGoalRouter } from "./routes/goals.js";
import { createHealthRouter, databaseProbe, type HealthProbe } from "./routes/health.js";
import { createJobRouter } from "./routes/jobs.js";
import { createLogRouter } from "./routes/logs.js";
import { createMemoryRouter, type MemoryViews } from "./routes/memory.js";
import { createReminderRouter } from "./routes/reminders.js";
import { createSyncRouter } from "./routes/sync.js";
import { createTodoRouter } from "./routes/todos.js";
import { fileSessionStore, LANES, memorySessionStore, SylAgent, type Lane } from "./harness/agent.js";
import { runTurn, type TurnOptions, type TurnRunner } from "./harness/session.js";
import {
  mcpToolName,
  toolConfigPath,
  writeToolConfig,
  writeTurnMessage,
} from "./tools/config.js";
import { advertisedToolNames } from "./tools/server.js";
import { autoMemoryOff } from "./memory/auto-memory.js";
import { DreamJudge } from "./memory/dream/judge.js";
import { DreamLog } from "./memory/dream/log.js";
import { DreamSweep } from "./memory/dream/sweep.js";
import { ConversationExtractor, ExtractionStore } from "./memory/extract-apply.js";
import { MemoryGraph } from "./memory/graph.js";
import { WorkingMemory } from "./memory/working.js";
import { MemoryMetrics } from "./memory/metrics.js";
import { EdgeWeights } from "./memory/weights.js";
import { withMemoryIndex } from "./memory/index-guarantee.js";
import { apnsCredentialsFromEnv } from "./services/apns-service.js";
import { ensureAgentKey, type AgentCredential } from "./services/agent-key.js";
import { ApiKeyService } from "./services/api-key-service.js";
import { AttachmentStore } from "./services/attachment-store.js";
import { systemClock, type Clock } from "./services/clock.js";
import { ConversationService } from "./services/conversation-service.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "./services/database.js";
import type { Timers } from "./services/job-runner.js";
import { DeviceTokenService } from "./services/device-token-service.js";
import { GoalService } from "./services/goal-service.js";
import { IdempotencyStore } from "./services/idempotency.js";
import { JobStore } from "./services/job-store.js";
import { MemoryRuntime } from "./services/memory-runtime.js";
import { MessageStore } from "./services/message-store.js";
import { Outbox } from "./services/outbox.js";
import { PresenceService } from "./services/presence.js";
import { ReminderService } from "./services/reminder-service.js";
import { SyncService, type SyncResolvers } from "./services/sync-service.js";
import { TodoService } from "./services/todo-service.js";
import { SylSocketServer, WS_PATH } from "./services/ws-server.js";

/**
 * The Syl HTTP service.
 *
 * `createApp` and `startServer` are separate on purpose: the app is a pure
 * function of its configuration and dependencies and can be driven over a
 * socket in tests without any process-level state, and the listening server is
 * the only thing that has to be torn down.
 *
 * Everything is mounted under `/api/v1`, which is the base path in
 * `shared/openapi.yaml`. Two clients are being written against that spec right
 * now; serving the same routes one path segment away would be a silent
 * incompatibility that only appears at integration time.
 */

/**
 * JSON bodies larger than this are refused.
 *
 * This used to say "Syl exchanges text, not uploads", and for every route but
 * one it still does. `POST /attachments` is the exception and it is mounted
 * with its own, larger parser at its own path — see `createApp`. Keeping the
 * general limit at one megabyte is the point: an upload surface that widened
 * the ceiling for `POST /reminders` at the same time would be a surface that
 * had quietly changed what every other endpoint accepts.
 */
const MAX_BODY_BYTES = "1mb";

/** The contract's base path. Not configurable — it is part of the contract. */
export const API_BASE_PATH = "/api/v1";

/**
 * What this process was built from, read once when the module loads.
 *
 * Module scope rather than per-app, because it describes the *artifact* and
 * cannot change while the process lives. Reading it per request would mean
 * asking the working tree instead of the build, which is precisely the mistake
 * the stamp exists to make impossible. `null` under `tsx` and in every test —
 * that is what "not a build" correctly looks like.
 */
const SELF_BUILD = readBuildInfo(selfBuildStampPath(), {
  onWarn: (message) => {
    console.warn(`[syl] ${message}`);
  },
});

/**
 * Pull a client-error status off a thrown value.
 *
 * `express.json()` rejects a malformed body by throwing an error carrying
 * `status: 400`, and refuses an oversized one with `413`. Anything without a
 * 4xx status is our bug, not the caller's.
 *
 * @returns the status, or `null` if this was not the client's fault.
 */
export function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  // Safe assertion: guarded by the `in` check, and the value is re-tested.
  const candidate = ("status" in error ? error.status : undefined) as unknown;
  if (typeof candidate === "number" && candidate >= 400 && candidate < 500) {
    return candidate;
  }
  return null;
}

/**
 * Turn anything thrown into a failure with a place in the contract.
 *
 * Every response body Syl emits is one of the contract's two envelopes,
 * including the ones Express would otherwise render itself. A client that
 * cannot parse one of the two is entitled to conclude it is not talking to Syl
 * at all — which is only a useful conclusion if it is true.
 */
export function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;

  const status = clientErrorStatus(error);
  if (status === null) return new ApiFailure("INTERNAL", "The service failed to handle that request.");
  if (status === 413) {
    return new ApiFailure("VALIDATION_FAILED", "That request body is larger than this service accepts.");
  }
  return new ApiFailure("VALIDATION_FAILED", "That request could not be parsed.");
}

/**
 * What the terminal 404 says, as a constant.
 *
 * This is a **discriminator**, not a message. Every mounted route answers
 * *something* — a typed refusal, an authentication failure, a page — and only
 * an unmounted path falls all the way through to here. That makes this exact
 * string the one reliable way to ask "is this path routed at all?" over HTTP,
 * which is what `contract-conformance.test.ts` walks the whole contract
 * asking. Exported so the guard matches the service's own value rather than a
 * copy of its prose: a test that asserts on a string it also authored proves
 * nothing about the service (`syl-c1m`).
 */
export const NO_ROUTE_MESSAGE = "No route on this service matches that request.";

/** Anything unmatched is a contract 404, not an HTML page. */
export const notFound: RequestHandler = (_request, response) => {
  sendFailure(response, new ApiFailure("NOT_FOUND", NO_ROUTE_MESSAGE));
};

/**
 * Terminal error handler.
 *
 * Express's default renders a stack trace outside production. Syl's responses
 * go to a phone and to logs the Commander reads, so the body is always a code
 * and never internals; the detail goes to stderr where it belongs.
 */
export const onError: ErrorRequestHandler = (error, _request, response, _next) => {
  const failure = toFailure(error);
  if (failure.code === "INTERNAL") {
    console.error("[syl] unhandled request error", error);
  }
  sendFailure(response, failure);
};

/**
 * What `createApp` needs that configuration cannot supply.
 *
 * Every field here is destructured in full by `createApp`. That is not a
 * style choice: `noUnusedLocals` is on, so a dependency declared here and
 * never handed to a router is a **compile error** rather than something a
 * reader has to notice. Three separate seams in this service were "constructed
 * and connected to nothing" at once (`syl-1o7`, `syl-c5q`, and idempotency
 * reaching three routers of five); a convention that bootstrap should wire
 * everything is what allowed all three, so this is a rule the compiler holds.
 */
export interface AppDependencies {
  /** Bearer tokens. Required: an app with no auth is not a thing Syl ships. */
  readonly keys: ApiKeyService;
  /** Conversation history, for reading it. */
  readonly messages: MessageStore;
  /**
   * Conversation history, for writing to it — and the only path by which Syl
   * ever says anything. See `services/conversation-service.ts`.
   */
  readonly chat: ConversationService;
  /** Registered push targets. */
  readonly devices: DeviceTokenService;
  /** The delivery outbox — where the never-drop guarantee lives. */
  readonly outbox: Outbox;
  /** Reminders, and the deferral invariant. */
  readonly reminders: ReminderService;
  /** To-dos: what *he* must do, as opposed to what Syl must do. */
  readonly todos: TodoService;
  /** Goals, and the tree they self-nest into. */
  readonly goals: GoalService;
  /** The change feed a device that has been offline catches up from. */
  readonly sync: SyncService;
  /** Scheduled work, its runs, and the lateness of each. */
  readonly jobs: JobStore;
  /** The ledger that makes every write safe to retry. */
  readonly idempotency: IdempotencyStore;
  /** Article intake: submission, and the resumable ladder behind it. */
  readonly intake: ArticleIntake;
  /**
   * The memory graph, the weight law, the derived panel and the dream log.
   *
   * One field rather than four, because they are one surface: the admin's
   * memory viewer reads all four and writes through two of them, and splitting
   * them here would put four names in `createApp`'s destructure for one
   * feature. See `routes/memory.ts`.
   */
  readonly memory: MemoryViews;
  /**
   * Images and video: the bytes on disk and the rows that describe them.
   *
   * Also handed to `MessageStore`, which is what makes `Message.attachments`
   * anything other than an empty array. Two references to one object rather
   * than two stores over one table — the row-to-wire mapping lives in exactly
   * one file.
   */
  readonly attachments: AttachmentStore;
  /** Extra health probes. The billing check is always present. */
  readonly probes?: readonly HealthProbe[];
  /**
   * The clock every store in this app was built on. Omit for the real one.
   *
   * It reaches exactly one route, and that route is the reason it is here:
   * `GET /health` reports `now`, and `now` was `systemClock` no matter what the
   * rest of the service was running on. A frozen store beside a live health
   * endpoint is two clocks in one process, and `syl-009` made that visible
   * rather than merely untidy — the tool server has no clock of its own and
   * asks Syl what time it is, so "the service's now" became a load-bearing
   * answer instead of a line on a status page.
   */
  readonly clock?: Clock;
}

/**
 * Everything `bootstrap` constructs: the app's dependencies, plus the ones only
 * the live socket has a use for.
 *
 * Split from {@link AppDependencies} so the exhaustive destructure in
 * `createApp` stays exhaustive. `presence` has no HTTP surface — it exists to
 * put frames on the WebSocket — so listing it there would force `createApp` to
 * name a dependency it cannot use, which would defeat the check.
 */
export interface ServiceDependencies extends AppDependencies {
  /**
   * Syl's character, derived from facts the service already owns.
   *
   * Constructed here rather than inside `startServer` because it is state: it
   * holds `since`, the affect window and the delighted-once-a-day interval,
   * and a socket server that restarts must not reset what Syl was doing.
   */
  readonly presence: PresenceService;
  /**
   * Which intake source is advanced next.
   *
   * Not an HTTP concern — it is the `content_ingestion` job's work list, and
   * the route only ever puts things into it via `intake.submit`.
   */
  readonly intakeQueue: IntakeQueue;
  /**
   * The half of memory that needs `vec0` and a model: the store, the retriever,
   * the semantic proposer — plus the supersession ledger, which needs neither.
   *
   * Not an HTTP concern today. It exists here because `syl-63n` was a whole
   * epic with no call site: the tables migrated, the triggers fired, and
   * nothing ever wrote a node. See `services/memory-runtime.ts` for why the
   * searchable half is built lazily and this one is not simply four more lines
   * beside `MemoryViews`.
   */
  readonly memoryRuntime: MemoryRuntime;
}

/** Build the Express application. */
export function createApp(config: SylConfig, deps: AppDependencies): Express {
  // Destructured in full, and reached through the names below rather than
  // through `deps.` — see the note on `AppDependencies`. Removing a use here
  // without removing the field does not compile.
  const {
    keys,
    messages,
    chat,
    devices,
    outbox,
    reminders,
    todos,
    goals,
    sync,
    jobs,
    idempotency,
    intake,
    memory,
    attachments,
    probes,
    clock,
  } = deps;
  const app = express();

  // Nothing gains from telling the world which framework to look up CVEs for.
  app.disable("x-powered-by");
  // The upload path, and only the upload path, accepts more than text. Mounted
  // FIRST and scoped to its own prefix: body-parser marks a request it has
  // already read, so the general parser below sees this one as done and never
  // applies its own smaller limit. Written as two visible lines in bootstrap
  // rather than as a condition inside one parser, because "which routes may
  // receive thirteen megabytes" is a question worth answering by reading the
  // mount order.
  app.use(`${API_BASE_PATH}/attachments`, express.json({ limit: UPLOAD_BODY_LIMIT_BYTES }));
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  // One authenticated chokepoint for the whole contract, and the agent
  // confinement rides inside it — see `middleware/auth.ts`. The base path is
  // passed rather than imported because that module cannot import this one.
  const authenticate = requireBearerToken({ keys, basePath: API_BASE_PATH });

  // Mounted onto one router so the base path appears exactly once, and so a
  // route added later cannot land outside it by forgetting the prefix.
  const api = Router();
  // `build` is read once, here, from the stamp inside the `dist/` this process
  // was loaded from. Never from git at request time: the running service must
  // report what it was BUILT FROM, and the working tree is a different — and
  // in the stale-build case, contradictory — question.
  api.use(
    createHealthRouter({
      config,
      ...(probes === undefined ? {} : { probes }),
      // The service's own clock, so `now` is the instant the stores are
      // stamping rows with rather than whatever the wall says. Her tool server
      // is a separate process and reads its clock from here — see
      // `tools/server.ts` — so a second clock in this process is a reminder
      // scheduled against a different "now" than the one it will fire on.
      ...(clock === undefined ? {} : { clock }),
      build: SELF_BUILD,
      turnsInFlight: () => chat.pending,
    }),
  );
  // Every write router takes `idempotency`. `syl-ux1` — `POST /auth/pair` and
  // `POST /conversations/{id}/messages` were the two that did not, and a lost
  // response to the first consumed the pairing code and left the device
  // permanently unpairable.
  api.use(createAuthRouter({ keys, idempotency, authenticate }));
  api.use(createConversationRouter({ messages, chat, idempotency, authenticate }));
  // Mounted before the routes that reference an attachment id, though nothing
  // depends on that ordering: both live under distinct prefixes.
  api.use(createAttachmentRouter({ attachments, idempotency, authenticate }));
  api.use(createDeviceRouter({ devices, idempotency, authenticate }));
  api.use(createDeliveryRouter({ outbox, reminders, idempotency, authenticate }));
  api.use(createReminderRouter({ reminders, idempotency, authenticate }));
  api.use(createTodoRouter({ todos, idempotency, authenticate }));
  api.use(createGoalRouter({ goals, idempotency, authenticate }));
  // Read-only, so no idempotency ledger: there is nothing here to run twice.
  api.use(createSyncRouter({ sync, authenticate }));
  api.use(createJobRouter({ jobs, authenticate }));
  // The one route in the contract that a paired phone may not call. Both
  // middlewares are named here rather than hidden inside the router, so the
  // service's own bootstrap shows that the log is gated and by what. See
  // `routes/logs.ts` for why this surface is different from every other read.
  api.use(
    createLogRouter({
      logDirectory: config.logDirectory,
      authenticate,
      requireAdmin: anyAuthenticatedDevice,
    }),
  );
  // The graph, the sky the phone draws from it, and the surface that corrects
  // it. **Authenticated, and nothing further** — the Commander's ruling of
  // 2026-08-10 removed the second key from this surface, because the view he
  // asked for specifically, so he could judge the inferred engine, was one he
  // could not open from the device he actually carries. Both middlewares named
  // here rather than hidden inside the router, so the bootstrap shows what is
  // required and by what. See `routes/memory.ts` for the full argument and for
  // what the old one was.
  api.use(
    createMemoryRouter({
      memory,
      idempotency,
      authenticate,
      authorize: anyAuthenticatedDevice,
    }),
  );
  api.use(createIntakeRouter({ intake, idempotency, authenticate }));

  app.use(API_BASE_PATH, api);

  // The admin, AFTER the contract and scoped to its own prefix. Static serving
  // is strictly additive: the SPA's history fallback lives inside this router,
  // so Express cannot dispatch to it for a URL outside `/admin` — which is what
  // stops a catch-all answering `/api/v1/anything` with an HTML page. See
  // `routes/admin.ts`, and the ordering cases in `tests/unit/admin.test.ts`.
  app.use(ADMIN_BASE_PATH, createAdminRouter({ root: config.adminDir }));

  app.use(notFound);
  app.use(onError);

  return app;
}

/** A listening service: HTTP and the WebSocket that shares its port. */
export interface RunningService {
  readonly server: Server;
  readonly sockets: SylSocketServer;
  /** Stop both, and stop the character's timer. */
  close(): Promise<void>;
}

/**
 * The port a listener actually got.
 *
 * Asked of the socket rather than read from the configuration, because the
 * configuration says `0` for every test — "give me whatever is free" — and the
 * answer is the kernel's. Her hands are declared against this number, so
 * reading the wrong one is a tool server that connects to nothing.
 */
function portOf(service: RunningService): number {
  const address = service.server.address();
  if (address === null || typeof address === "string") {
    throw new Error(
      "The service is listening on something that is not a TCP port, so Syl's own API has no " +
        "address to be reached at and her tools cannot be declared.",
    );
  }
  return address.port;
}

/**
 * Start listening.
 *
 * Resolves only once the socket is accepting connections, and rejects instead
 * of hanging if the port is taken — a promise that settles either way is what
 * makes this safe to `await` in a test.
 *
 * The WebSocket shares the HTTP server rather than binding a second port. Same
 * origin, same bearer token, one thing to expose over the tunnel.
 */
export async function startServer(
  config: SylConfig,
  deps: ServiceDependencies,
): Promise<RunningService> {
  // `presence` named, everything else forwarded. A field added to
  // `ServiceDependencies` and not named here lands in `createApp`, which
  // destructures exhaustively and will not compile without a use for it.
  const { presence, ...app } = deps;

  const server = createServer(createApp(config, app));
  const sockets = new SylSocketServer({
    server,
    keys: app.keys,
    chat: app.chat,
    // The socket tells presence that somebody arrived...
    presence,
  });
  // ...and presence tells the socket what to say about it. Two directions, one
  // join, made here because this is the first moment both halves exist. Every
  // presence frame the Commander will ever see passes through these two lines;
  // without them both components work perfectly and no frame is ever sent
  // (`syl-c5q`).
  presence.setSink((frame) => {
    sockets.announcePresence(frame);
  });
  // The conversation service needs no line here: `SylSocketServer` subscribes
  // to it in its own constructor, because that direction has exactly one
  // possible publisher and a join nobody has to remember is a join that cannot
  // be forgotten. See the note there.

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    server,
    sockets,
    close: async () => {
      // The sink goes first. `sockets.close()` drops every client, which is a
      // presence change, and settling it into a socket server that is halfway
      // through closing is not a frame anybody wants.
      presence.setSink(null);
      presence.close();
      // Before the socket closes, not after: a turn that is one second from
      // finishing should still reach the clients that are still attached. The
      // drain is bounded well under launchd's twenty-second kill clock, and
      // `sockets.close()` is what unsubscribes it afterwards.
      await app.chat.close();
      await sockets.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * The lines to print once the service is up.
 *
 * Separated from `main` so the two pieces of judgement in the bootstrap — that
 * a stray credential variable deserves a loud warning, and that a service with
 * no paired device must say how to pair one — are things tests can hold onto
 * rather than things only a human reading a terminal would notice were
 * missing.
 */
export function describeStartup(
  config: SylConfig,
  options: { readonly pairingCode?: string } = {},
): readonly string[] {
  const lines = [
    `[syl] v${config.version} listening on http://${config.host}:${config.port}${API_BASE_PATH} (${config.nodeEnv})`,
    `[syl] websocket on ws://${config.host}:${config.port}${WS_PATH}`,
    // The credential source, on the startup line, always — not only when it is
    // wrong. It is the one invariant that costs real money if it quietly stops
    // being true, and "it says none every morning" is a thing a person notices
    // stopping. A warning that only appears on failure is a warning nobody has
    // ever seen and therefore does not miss.
    `[syl] credentials: ${config.credentialSource} ` +
      `(${config.subscriptionRails ? "claude.ai subscription" : "METERED API"})`,
  ];

  if (!config.subscriptionRails) {
    lines.push(
      `[syl] WARNING: ${config.credentialSource} is set in this environment. ` +
        `The harness strips it before spawning claude, but anything that reaches ` +
        `the CLI another way will bill the metered API instead of the subscription.`,
    );
  }

  // Stated on every boot rather than only when it is on, for the same reason
  // the credential source is: "she cannot reach anyone" is a fact about what
  // she can do today, and a line that only appears in one of the two states is
  // a line nobody reads as an answer.
  lines.push(
    config.adjutant === null
      ? "[syl] fleet: off. She cannot reach other agents. Set SYL_ADJUTANT_URL to change that."
      : `[syl] fleet: ${config.adjutant.baseUrl} as "${config.adjutant.agentId}" — ` +
          `never as the Commander.`,
  );

  if (options.pairingCode !== undefined) {
    lines.push(
      `[syl] No device is paired. Pairing code: ${options.pairingCode} ` +
        `(POST ${API_BASE_PATH}/auth/pair). It expires shortly and is consumed on use.`,
    );
  } else {
    // The line that matters on every boot *after* the first. A code is printed
    // only while nothing is paired, which used to leave no way at all to pair a
    // second device or re-pair a reinstalled one — the service had already
    // decided not to offer a code and nothing could ask it for another.
    lines.push("[syl] To pair another device, run `npm run pair` on this machine.");
  }

  return lines;
}

/**
 * Whether this machine still needs to be told how to pair a phone.
 *
 * The question is **"is a DEVICE paired"**, not "is any key live", and the
 * difference became load-bearing the moment the service started minting its own
 * `agent` credential at boot. The old spelling — every key in the table is
 * revoked — was correct while every key was a phone. With Syl's own key present
 * from the first boot, a brand-new machine would have concluded that something
 * was already paired, printed no code, and left the Commander looking at a
 * service he had no way into. Nothing would have failed; there would simply
 * have been no line.
 *
 * Exported so that is a test rather than a line in a startup function nobody
 * can call.
 */
export function needsPairingCode(keys: ApiKeyService): boolean {
  return keys.liveKeysWithScope("device").length === 0;
}

/**
 * The repo root, from `backend/src/index.ts`.
 *
 * `SOUL.md`, `.mcp.json` and `.syl/` live at the root of the monorepo rather
 * than inside the backend workspace, and `npm run ping` reaches them the same
 * way.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Syl's standing orders, appended to the system prompt on every turn.
 *
 * Optional by design: a service with no `SOUL.md` is a service with a
 * characterless assistant, which is a degraded Syl rather than a broken one.
 * Refusing to start over a missing markdown file would be the wrong trade.
 */
export function readSoul(root: string = REPO_ROOT): string | undefined {
  try {
    const soul = readFileSync(join(root, "SOUL.md"), "utf8").trim();
    return soul === "" ? undefined : soul;
  } catch {
    return undefined;
  }
}

/**
 * Where each lane's Claude Code session id lives between turns.
 *
 * Beside the operational store, so a deployment that points `SYL_DB_PATH` at a
 * backed-up directory gets its conversational continuity backed up with it. An
 * in-memory database is a test, and a test that wrote session files into the
 * repo would leak state between runs.
 */
/**
 * The directory Syl takes her turns in.
 *
 * Deliberately NOT the source tree. Claude Code reads the working directory it
 * is given — project instructions, SessionStart hooks, memories — so launching
 * her turns from the repository handed her an engineering brief and a beads
 * workflow on top of her own soul, and she reported herself accordingly.
 *
 * Derived from the database path so it follows `SYL_DB_PATH` rather than being
 * a second thing to configure, and created if absent because a cwd that does
 * not exist fails the spawn rather than falling back.
 *
 * In-memory (tests) keeps the process cwd: a temp home would leave directories
 * behind and the tests do not spawn a real CLI anyway.
 */
export function sylHome(config: SylConfig): string | undefined {
  if (config.databasePath === IN_MEMORY) return undefined;
  const home = dirname(config.databasePath);
  mkdirSync(home, { recursive: true });
  return home;
}

export function sessionStoreFor(config: SylConfig): ReturnType<typeof memorySessionStore> {
  if (config.databasePath === IN_MEMORY) return memorySessionStore();
  return fileSessionStore(join(dirname(config.databasePath), "sessions"));
}

/** What `bootstrap` may be told that the configuration cannot say. */
export interface BootstrapOptions {
  /**
   * Where a turn's life gets written down.
   *
   * Omitted, the service was a BLACK BOX: it logged startup and failures and
   * nothing in between. The Commander asked her a question from his phone,
   * watched the logs, and saw no message arrive, no turn begin, and no tool
   * run — because none of that was ever written. `ConversationService` took an
   * optional `log` and `bootstrap` never passed one.
   *
   * An assistant that acts on your machine with a pre-authorised session is
   * exactly the thing you must be able to watch. "It is working, trust me" is
   * not a property; it is the absence of one.
   */
  readonly logger?: Logger;
  /**
   * The clock every store runs on. Omit for the real one.
   *
   * `syl-md5`: `bootstrap` took no clock, so `startLiveService` could not use
   * it for any story about *when* something happens and kept a second copy of
   * this constructor list instead. A duplicated wiring list guarded by a test
   * that compares field names catches a *missing* store and cannot catch a
   * differently-*configured* one, which is the failure that matters.
   */
  readonly clock?: Clock;
  /**
   * Options forwarded to every conversational turn.
   *
   * The one a test always supplies is `claudeBin`, pointed at the fake in
   * `tests/helpers/fake-claude.ts`. Nothing in the suite may reach the real
   * CLI: it costs money, it needs a login, and it is not deterministic.
   */
  readonly turn?: TurnOptions;
  /**
   * What actually runs a turn. Defaults to `runTurn` — a real subprocess.
   *
   * The seam exists because a turn is the one dependency in this service that
   * is a *process*: most suites want Syl present and answering nothing, and
   * paying a node spawn per message across a hundred test files is how a suite
   * acquires load-dependent flakiness. The tests that are about her answering
   * use `turn.claudeBin` and the real runner instead, so the wire format is
   * still exercised against a captured transcript.
   */
  readonly runner?: TurnRunner;
  /** Standing orders. Defaults to `SOUL.md` at the repo root, when there is one. */
  readonly soul?: string;
}

/** What `bootstrap` produces: the store, the services, and Syl's own key. */
export interface Bootstrapped {
  readonly database: SylDatabase;
  readonly deps: ServiceDependencies;
  /**
   * Syl herself, on her default lane.
   *
   * Returned rather than reachable only through `chat` so that a test can take
   * a turn on **every** lane and check what it carried. The container is a
   * property of each turn's options, and `ConversationService` only ever drives
   * the commander lane — so without this the heartbeat, agenda and
   * consolidation lanes could only be asserted about by rebuilding the wiring
   * in the test, which is the one thing a wiring test must not do.
   */
  readonly agent: SylAgent;
  /**
   * Syl's own credential, minted here and held nowhere else.
   *
   * **Deliberately NOT a field on `ServiceDependencies`.** Every field there is
   * destructured by `createApp` and handed to a router; putting the agent token
   * in that bag would make it something a route could reach, which is the exact
   * property this credential exists to not have. It is returned beside the
   * dependencies instead, so the only callers are `startSyl` and a test.
   *
   * See `services/agent-key.ts` for why it cannot be obtained over the network.
   */
  readonly agentKey: AgentCredential;
  /**
   * The MCP declaration the commander lane was actually given, or `undefined`.
   *
   * The resolved value — `options.turn.mcpConfig` if a caller overrode it, the
   * path under her home otherwise — and therefore the same string that reaches
   * `TurnOptions.mcpConfig` and `--mcp-config`. It is `undefined` for an
   * in-memory store, which has no home to put a declaration in.
   *
   * Returned so the boot notice can be a FUNCTION of it (`syl-009.9`). The one
   * line that states her tool surface at startup said "no MCP" as a constant,
   * and went on saying it after `syl-009.3` handed her hands — a false security
   * claim in the only place that makes one. `startSyl` passes this to
   * `describeContainer`, so the notice and the turn cannot disagree.
   *
   * NOT a field on `ServiceDependencies`, for the same reason `agentKey` is
   * not: everything there is handed to a router, and which lane holds the tools
   * is not a route's business.
   */
  readonly hands: string | undefined;
  /**
   * How she reaches the rest of the fleet, or `undefined` because she may not.
   *
   * **`undefined` is the default**, and nothing here waits on Adjutant or asks
   * whether it is running: constructing this opens no connection. She is the
   * Commander's assistant first and a fleet client second, so a machine with no
   * Adjutant boots exactly as it did before this existed.
   *
   * Returned beside the dependencies rather than in them, for now, because
   * `ServiceDependencies` is destructured straight into routers and nothing
   * routes here yet. `syl-014.2` gives it its first consumer and can move it
   * then — an unused field in that bag would be a capability every route could
   * reach for no reason.
   */
  readonly adjutant: AdjutantClient | undefined;
}

/** Open the store and build the services the app needs. */
export function bootstrap(config: SylConfig, options: BootstrapOptions = {}): Bootstrapped {
  // BEFORE THE DATABASE IS OPENED, because a refusal has to be a refusal — and
  // because a service that opens a store, binds a port and only then declines
  // is a service somebody restarts until it works.
  //
  // Skipped for an in-memory store, which means a test: there is no `~/.syl`
  // then, `cwd` stays at `process.cwd()`, and that is this repository. Asserting
  // would fail every test in the suite for a container that does not exist. The
  // live service always has a real path.
  const home = sylHome(config);
  // Where her hands are declared, decided here and nowhere else. Under her
  // home, absolute, derived from configuration — see `tools/config.ts`, and
  // `ops/container.ts` for the boot that refuses anything else.
  //
  // `undefined` for an in-memory store, which means a test: there is no home
  // to put it in, so no lane is given hands and every existing suite keeps the
  // surface it had. The live service always has a real path.
  const handsPath = home === undefined ? undefined : toolConfigPath(home);
  if (home !== undefined) {
    // The MCP config is checked alongside the directory because it is the one
    // door that is deliberately going to be opened. `--tools ""` empties the
    // built-ins and nothing else — an MCP server attached to a turn keeps every
    // tool it exposes — so when `syl-009` hands her a narrow named surface, the
    // file declaring it must live under her home rather than in this source
    // tree. A capability read from a checked-out branch is a capability that
    // changes when somebody switches branches.
    //
    // The path checked is the path the commander lane is actually given —
    // `options.turn` may override it, and an override that pointed into the
    // repository has to be refused for the same reason ours would be.
    assertContainer(home, {
      ...(() => {
        const declared = options.turn?.mcpConfig ?? handsPath;
        return declared === undefined ? {} : { mcpConfig: declared };
      })(),
    });
  }
  const clock = options.clock ?? systemClock;
  // `allowExtension` must be asked for at CONSTRUCTION — `node:sqlite` offers no
  // way to turn it on later. Without it this connection can never load `vec0`,
  // so the memory store's vector half would simply be absent on the running
  // service while every unit test stayed green, because the tests open their own
  // connection and do pass the flag. Silent, and invisible from the test suite:
  // `syl-63n`. Granting it is not loading anything — `memory/store.ts` still has
  // to call `enableLoadExtension(true)` immediately before, and re-disables it
  // once `vec0` is in.
  const database = openDatabase({ path: config.databasePath, allowExtension: true });
  const keys = new ApiKeyService({ db: database.handle, clock });
  // Her hands, before anything that might want them. A boot that reached the
  // listening socket without a credential would answer every request and
  // quietly be unable to act — the failure `syl-act1` is about.
  const agentKey = ensureAgentKey({ keys });

  // Before `MessageStore`, which takes it: a message's pictures are read
  // through this object, so the wiring is one direction and there is no cycle
  // to break later.
  const attachments = new AttachmentStore({
    db: database.handle,
    clock,
    blobDir: config.attachmentDir,
  });
  const messages = new MessageStore({ db: database.handle, clock, attachments });
  const devices = new DeviceTokenService({ db: database.handle, clock });
  const idempotency = new IdempotencyStore({ db: database.handle, clock });
  // From the config, not from `process.env`. `loadConfig` has already refused
  // an unusable window, so nothing here can hand the outbox a quiet window
  // that throws the first time the delivery handler defers something.
  const outbox = new Outbox({ db: database.handle, clock, quietHours: config.quietHours });
  const reminders = new ReminderService({ db: database.handle, clock });
  const todos = new TodoService({ db: database.handle, clock });
  const goals = new GoalService({ db: database.handle, clock });
  const jobs = new JobStore({ db: database.handle, clock });
  // The sync feed reads every resource through the store that owns it, rather
  // than mapping rows a second time. A second mapping is a second place for
  // the wire shape to drift, and drift between the contract and the service is
  // the bug this whole endpoint was blocked behind (`syl-c1m`).
  const sync = new SyncService({ db: database.handle, clock, resolvers: syncResolvers({ messages, reminders, todos, goals, devices, outbox, jobs }) });
  // One zone for the whole service, and the one `loadConfig` has already
  // checked is a place rather than an offset. The quiet *window* stays
  // presence's own: `absent` is about whether Syl shows a character, which
  // starts later than the hour the outbox stops sending notifications.
  const presence = new PresenceService({ clock, timeZone: config.quietHours.tz });

  // Syl herself, and the seam that lets her answer. `SylAgent` opts into
  // `bypassPermissions` because this is the Commander's own trusted
  // conversation; anything that reads fetched content goes through
  // `runReaderTurn` instead and never comes near this object.
  const soul = options.soul ?? readSoul();
  const log = options.logger;

  // What she is DOING, as it happens.
  //
  // The harness already emits an event per step of a turn; nothing was
  // listening. So a turn that took nine seconds and called three tools looked,
  // from the logs, exactly like a turn that never happened. Tool calls matter
  // most: this session runs pre-authorised, so `turn.tool` is the record of
  // what she actually did on the machine — and the only way to notice her
  // reaching for something she should not.
  //
  // A caller-supplied `onEvent` still wins; this composes rather than replaces,
  // because tests pass their own and would otherwise lose it.
  const observe = (event: Parameters<NonNullable<TurnOptions["onEvent"]>>[0]): void => {
    options.turn?.onEvent?.(event);
    if (log === undefined) return;
    // THE ARGUMENTS, not only the name (`syl-009.5.1`). "She called remind_me"
    // is not a record of what she did on his machine — what she did is *the
    // arguments*: what the reminder says, when it fires, whether it claimed
    // urgency, and the reason she attached. Without them the log can tell him
    // that something happened and never what, which is the same shape of
    // uselessness as a service that logged nothing between startup and failure.
    //
    // Through `toolArgumentsForLog`, because the destination is a file HE READS
    // (`syl-009.5`). The credential handed to `secrets` is the one this process
    // actually minted a few lines up rather than a pattern that might match it
    // — the same "derive the claim from the thing itself" the container check
    // and `harness/capability.ts` are built on — so there is no second copy of
    // the secret to keep in step, and a field name nobody predicted is covered
    // because the guard is on the VALUE.
    if (event.kind === "tool_use") {
      log.info("turn.tool", {
        tool: event.name,
        arguments: toolArgumentsForLog(event.input, { secrets: [agentKey.token] }),
      });
    }
    else if (event.kind === "init") log.info("turn.start", { sessionId: event.sessionId });
    else if (event.kind === "api_error") log.error("turn.api_error", { message: event.message });
    else if (event.kind === "result") {
      log.log(event.isError ? "error" : "info", "turn.done", {
        turns: event.numTurns,
        costUsd: event.costUsd,
        isError: event.isError,
      });
    }
  };

  // The graph and the projection over it. Constructed before the agent because
  // the agent's `recall` closes over the projection: what she remembers has to
  // exist before the thing that speaks from it.
  const memoryGraph = new MemoryGraph({ db: database.handle, clock });
  // What she remembers about him, distilled nightly from the graph's hot region.
  // Constructed here rather than inside SylAgent because the consolidation job
  // regenerates it and the admin reads it — one owner, three readers.
  const workingMemory = new WorkingMemory({ db: database.handle, graph: memoryGraph, clock });

  // Pulled out of the caller's overrides rather than spread with the rest,
  // because it is the ONE option that must not reach every lane. A test that
  // supplies one is asking for the commander lane to have hands; it is not
  // asking for the dream to have them, and a plain spread cannot tell those
  // apart. See `tests/integration/mcp-config-wiring.test.ts`.
  const { mcpConfig: overriddenHands, ...turnOverrides } = options.turn ?? {};
  const commanderHands = overriddenHands ?? handsPath;

  /** The declaration a lane is given by name, or nothing at all. */
  const handsFor = (lane: Lane): string | undefined =>
    lane === LANES.commander ? commanderHands : undefined;

  /**
   * Write down what he said, for the one check that cannot be made without it.
   *
   * `harness/urgency.ts` decides whether a reminder may pierce quiet hours by
   * comparing the phrase she quoted to what he actually wrote. The tool server
   * is a different process and is deliberately unable to read the conversation
   * — `AGENT_SURFACE` excludes `/conversations` exactly so she cannot author
   * messages as him — so his words have to travel to it, and this is the only
   * seam that has both the message and the knowledge that this turn has hands.
   *
   * Only for a turn carrying a declaration, so no lane without hands leaves a
   * trace of his messages on disk for a reader that does not exist.
   */
  const recordHisWords =
    (runner: TurnRunner): TurnRunner =>
    async (prompt, turnOptions) => {
      if (home !== undefined && turnOptions.mcpConfig !== undefined) {
        writeTurnMessage(home, prompt);
      }
      return runner(prompt, turnOptions);
    };

  const agent = new SylAgent({
    store: sessionStoreFor(config),
    // Read fresh on every turn, not captured here: the projection is rebuilt
    // each night and this service outlives the night. It is composed UNDER the
    // soul so it arrives as memory she holds rather than as a briefing she was
    // handed — the distinction that had her answering "what is your
    // personality?" by describing her own configuration file.
    recall: () => workingMemory.preamble(),
    // OFF, and this is the second half of `--tools ""` rather than a separate
    // decision. Auto-memory is Claude Code's OWN subsystem: pointing it at a
    // directory injects instructions to READ and MAINTAIN memory files, and
    // those instructions require the very tools we removed.
    //
    // Instructed to act and given nothing to act with, the model performs the
    // tool call in prose. Measured, three runs of three, asked only "who are
    // you?": she emitted a fabricated `Read`, then a fabricated `ls` output
    // listing a directory that does not exist. With this one line flipped and
    // nothing else changed, she answered as herself. See `syl-010.4.5`.
    //
    // Two flags decided by two tracks on the same day, each correct alone and
    // incoherent together. The lesson is cheap to state and was not cheap to
    // find: REMOVING A CAPABILITY IS NOT DONE UNTIL EVERY INSTRUCTION THAT
    // ASSUMED IT IS ALSO GONE. An order she cannot obey does not fail loudly;
    // it gets acted out.
    //
    // Nothing is lost. `memory/extraction.ts` replaced this path deliberately:
    // the model proposes, the SERVICE writes, and the writing needs no tool in
    // her hands. That is strictly better than trusting a turn to maintain its
    // own memory file, because the authority to write now lives with the code
    // that can be tested.
    autoMemory: autoMemoryOff(),
    ...(soul === undefined ? {} : { soul }),
    // Both halves are load-bearing and neither survives alone: `onEvent` is how
    // the service observes a turn at all, and the index wrapper is what makes a
    // written memory findable again.
    // HER OWN DIRECTORY, not wherever the service happened to be launched.
    //
    // cwd defaulted to process.cwd(), which is this repository, and Claude Code
    // loads what it finds there: CLAUDE.md's engineering instructions, the
    // SessionStart hook that injects the beads workflow, and the beads
    // memories. Asked who she was, she answered "running as Claude Code inside
    // /Users/Reason/code/ai/syl... an engineer on this codebase" — which was
    // not confusion, it was an accurate description of where she was standing.
    // No soul file out-argues the room. `~/.syl` is already her home: her
    // database, her sessions and her memory all live there.
    //
    // A FUNCTION OF THE LANE, because the tool surface is (`syl-009.3.3`). See
    // `handsFor` below: the commander lane is handed a declaration and the
    // other three are handed nothing, and one shared options object could not
    // say that.
    turnOptions: (lane: Lane): TurnOptions => {
      const hands = handsFor(lane);
      return {
        ...turnOverrides,
        ...(home === undefined ? {} : { cwd: home }),
        // HER HANDS, ON HIS OWN LANE AND NO OTHER.
        //
        // The dream must not be able to write a reminder while judging what
        // matters; the heartbeat and the agenda read rather than act; and the
        // extraction turn is a sealed reader that never comes near this object
        // at all. Those are not three separate decisions — they are one, and
        // this is where it is made.
        //
        // `strictMcpConfig` is redundant beside a config (`runTurn` adds
        // `--strict-mcp-config` whenever one is set) and is stated anyway: it
        // is what makes "she was handed the reminder verbs" mean "she was
        // handed the reminder verbs AND NOTHING ELSE", and the last time it
        // was left implicit she answered the Commander through Adjutant.
        ...(hands === undefined ? {} : { mcpConfig: hands, strictMcpConfig: true }),
        // NO BUILT-IN TOOLS. The Commander's call, 2026-08-10, after she twice
        // described herself as an engineer on this codebase: everything she
        // owns — to-dos, goals, reminders, the daily rhythm — runs through the
        // service, so her turns need to think and speak, not act.
        //
        // `--tools ""`, not `--allowedTools`: the latter pre-approves names on
        // a surface that still exists; only the former makes a turn incapable
        // of acting. It also bounds what `bypassPermissions` can reach, which
        // CLAUDE.md has had as the outstanding follow-up for a while.
        //
        // KNOWN COST, measured not assumed: Claude Code's auto-memory is
        // written BY THE MODEL through the Write tool. With no tools she cannot
        // write one — verified live: `--tools ""` yields `tools: []`, the model
        // makes no tool call when told to remember something, and no file
        // appears. So conversational memory does not accumulate while this
        // holds. Reversing it is this one line.
        tools: "",
        // NONE OF THE MACHINE'S SETTINGS. `cwd` and `tools` were two thirds of
        // the container; this is the third, and it is the one that was still
        // open after the other two were fixed. Hooks and plugins are not read
        // from the working directory, so moving her home did nothing to them:
        // a live turn in `~/.syl` with an empty tool surface still had
        // `bd prime` and the "Adjutant Agent Protocol" injected at SessionStart
        // from the *user-level* settings and an installed plugin. See
        // `TurnOptions.settingSources` for the captures.
        settingSources: "",
        onEvent: observe,
      };
    },
    // What she is TOLD she can do, derived from what she was actually handed.
    // `--tools ""` empties the built-ins only, so without this the lane holding
    // `remind_me` would be told it has no way to act — `NO_HANDS_YET` becoming
    // the exact lie it was written to prevent.
    hands: (lane: Lane) =>
      handsFor(lane) === undefined ? [] : advertisedToolNames().map(mcpToolName),
    // Wrapped, never bypassed — including when a test substitutes the runner,
    // because "was the index maintained?" is a question about the service and
    // not about which runner ran. Whether a memory can be found again is a
    // guarantee this service holds; leaving it to the model lost the
    // Commander's canary on a haiku turn (`syl-03d`).
    runner: withMemoryIndex(recordHisWords(options.runner ?? runTurn)),
  });
  // How conversation becomes graph.
  //
  // Auto-memory used to do this — Claude Code writes what a turn learned into
  // `MEMORY.md` — and it is written BY THE MODEL through the Write tool. With
  // `tools: ""` above there is no Write tool, so there is no auto-memory, so
  // nothing filled the graph and the nightly dream swept an empty one. The
  // answer is not to give the hands back; it is the split this project uses
  // everywhere else: the model judges what matters, the service writes it.
  const extractor = new ConversationExtractor({
    store: new ExtractionStore({ db: database.handle, graph: memoryGraph, clock }),
    // The extraction turn is a READER turn — no tools, no MCP, no
    // pre-authorisation, auto-memory off, session never resumed — because a
    // conversation contains whatever he pasted into it. It needs the same
    // `claudeBin`/`model` overrides the tests give every other turn, and
    // nothing else: `cwd` is deliberately NOT forwarded, since a turn with no
    // tools cannot read the directory it stands in.
    turnOptions: {
      ...(options.turn?.model === undefined ? {} : { model: options.turn.model }),
      ...(options.turn?.claudeBin === undefined ? {} : { claudeBin: options.turn.claudeBin }),
    },
    // Closes the loop the same day. `regenerate` costs no tokens and writes
    // only when the digest moved, so rebuilding here rather than waiting for
    // the nightly consolidation is free — and without it a fact he states at
    // ten in the morning does not reach her prompt until midnight.
    onGraphChanged: () => {
      workingMemory.regenerate();
    },
    ...(log === undefined
      ? {}
      : {
          log: (line: string, detail?: unknown) => {
            if (detail === undefined) log.info("memory", { message: line });
            else log.error("memory", { message: line, error: String(detail) });
          },
        }),
  });

  const chat = new ConversationService({
    messages,
    agent,
    presence,
    // After the reply is persisted and on the wire, never before: his answer
    // must not wait on filing, and a failed extraction must not fail his
    // conversation. `ConversationExtractor.extract` never rejects.
    afterExchange: (exchange) =>
      extractor
        .extract({
          conversationId: exchange.conversationId,
          transcript: [
            { id: exchange.prompt.id, role: "user", text: exchange.prompt.text },
            { id: exchange.reply.id, role: "assistant", text: exchange.reply.text },
          ],
        })
        .then(() => undefined),
    // Was omitted entirely, so the only thing that ever reached a file was a
    // failure — and only via a default that writes to stderr.
    ...(log === undefined
      ? {}
      : {
          log: (line: string, error?: unknown) => {
            if (error === undefined) log.info("chat", { message: line });
            else log.error("chat", { message: line, error: String(error) });
          },
        }),
  });

  // Intake, wired end to end: the store the migration now creates, the queue
  // that is `ArticleIntake`'s long-missing scheduler, and the ladder itself.
  // `fetch` is left at its default — `safeFetch`, the SSRF guard — because the
  // only reason that parameter exists is so a test can drive the ladder
  // without a network, and a production caller substituting it would have
  // removed the control that stops a hostile link reaching the tailnet.
  // The memory surface the admin reads and corrects. Every one of these is a
  // thin object over the same handle — `MemoryMetrics` in particular is a
  // derived view that writes nothing — so building them here costs a
  // constructor and keeps the route free of store construction.
  const memory: MemoryViews = {
    graph: memoryGraph,
    weights: new EdgeWeights({ graph: memoryGraph, clock }),
    metrics: new MemoryMetrics({ db: database.handle, clock }),
    dreams: new DreamLog({ db: database.handle, clock }),
  };

  // The rest of `syl-005`, which had no call site at all until `syl-63n`: the
  // hybrid store, the retriever, the embedder and the supersession ledger.
  //
  // Only the ledger is built here and now. Everything else is behind
  // `MemoryRuntime.searchable()`, and the reason is the boot path: the store
  // needs `vec0` — a native extension `sqlite-vec` ships as a per-platform
  // OPTIONAL dependency, so "absent" is a state `npm install` reports success
  // for — and the retriever needs a 300M-parameter model. Neither may be
  // allowed to decide whether this service starts. Syl holds reminder-delivery
  // guarantees; a `/health` that waits on model weights, or a boot that fails
  // because a machine has no `vec0` binary, has broken something considerably
  // more important than search. `services/memory-runtime.ts` has the argument
  // in full.
  const memoryRuntime = new MemoryRuntime({
    db: database.handle,
    graph: memoryGraph,
    clock,
    ...(log === undefined
      ? {}
      : {
          warn: (line: string, error: unknown) =>
            log.error("memory", { message: line, error: String(error) }),
        }),
  });

  // The fleet, if he has turned it on. `config.adjutant` is `null` unless
  // `SYL_ADJUTANT_URL` is set, so this is `undefined` on every machine that has
  // not asked for it — and a set-but-unusable value never reaches here, because
  // `loadConfig` refused the start. Nothing is connected, probed or awaited:
  // the client is stateless until its first call, which is what makes "Adjutant
  // is down" a sentence she says rather than a boot that fails.
  const adjutant =
    config.adjutant === null
      ? undefined
      : new AdjutantClient({
          baseUrl: config.adjutant.baseUrl,
          agentId: config.adjutant.agentId,
          clock,
          ...(config.adjutant.projectRoot === undefined
            ? {}
            : { projectRoot: config.adjutant.projectRoot }),
        });

  const intakeQueue = new IntakeQueue();
  const intakeStore = new IntakeStore({ db: database.handle, clock });
  const intake = new ArticleIntake({ store: intakeStore, clock, scheduler: intakeQueue });
  // Everything mid-ladder when the process died is due again now. Every step
  // is idempotent, so re-running one is safe; skipping one is not.
  intakeQueue.recover(intake, clock());

  return {
    database,
    agent,
    agentKey,
    // What was decided, not what was intended — the boot notice is derived from
    // this and from nothing else. See `Bootstrapped.hands` and `syl-009.9`.
    hands: commanderHands,
    adjutant,
    deps: {
      keys,
      messages,
      chat,
      devices,
      outbox,
      reminders,
      todos,
      goals,
      sync,
      jobs,
      idempotency,
      intake,
      memory,
      memoryRuntime,
      attachments,
      presence,
      intakeQueue,
      // The same clock every store above was built on — not a second one. See
      // the field on `AppDependencies` for what a second one costs.
      clock,
      probes: [databaseProbe(database.handle)],
    },
  };
}

/** The stores `GET /sync` reads each resource type through. */
export interface SyncSources {
  readonly messages: MessageStore;
  readonly reminders: ReminderService;
  readonly todos: TodoService;
  readonly goals: GoalService;
  readonly devices: DeviceTokenService;
  readonly outbox: Outbox;
  readonly jobs: JobStore;
}

/**
 * Point each resource type at the store that owns it.
 *
 * Exported so a test can assert the map is **total** — `SyncResolvers` is a
 * `Record` over the contract's `SyncResourceType`, so a type added to the
 * contract without a source here does not compile, and one wired to the wrong
 * store is what the round-trip test in `sync-service.test.ts` catches.
 *
 * Every function returns the resource's wire shape or `null`, and `null` is
 * what `op: "delete"` is derived from.
 */
export function syncResolvers(sources: SyncSources): SyncResolvers {
  const { messages, reminders, todos, goals, devices, outbox, jobs } = sources;
  // Safe assertion: each store returns the contract type for that resource,
  // and `SyncChange.resource` is that same object seen as an open record.
  const as = <T>(value: T | null): Record<string, unknown> | null =>
    value === null ? null : (value as unknown as Record<string, unknown>);

  return {
    conversation: (id) => as(messages.conversation(id)),
    message: (id) => as(messages.get(id)),
    reminder: (id) => as(reminders.get(id)),
    todo: (id) => as(todos.get(id)),
    goal: (id) => as(goals.get(id)),
    device: (id) => as(devices.get(id)),
    delivery: (id) => as(outbox.get(id)),
    job: (id) => as(jobs.get(id)),
    run: (id) => as(jobs.run(id)),
  };
}

/**
 * Overrides for the delivery runtime alone.
 *
 * The runtime is the one component that talks to a third party on a timer, so
 * it is the one component whose *destination* and *cadence* a test has to be
 * able to redirect. Everything else here is a function of the config.
 */
export interface DeliveryOverrides {
  /**
   * The runtime's own clock, when it must differ from the stores'.
   *
   * A story about *when* a reminder fires needs the stores frozen — so that
   * what an HTTP write records is deterministic — while the loop that decides
   * whether anything is due walks forward. That asymmetry is the whole shape of
   * a timing test, and it is the reason this is separate from `clock`.
   */
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly origins?: Readonly<Record<PushEnvironment, string>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly warn?: (line: string) => void;
  readonly onError?: (error: unknown, job: Job | null) => void;
}

export interface StartSylOptions extends BootstrapOptions {
  readonly delivery?: DeliveryOverrides;
}

/**
 * The dreamer, assembled at the moment a night actually starts.
 *
 * **Built per run rather than at boot**, because a `DreamSweep` needs the
 * semantic proposer and that needs `vec0` loaded and (on first use) a model.
 * Doing it here means a machine that cannot load the extension gets a failed,
 * retried, visible run — not a service that would not start. `null` is exactly
 * that case, and `createNightlyDreamHandler` turns it into a recorded failure.
 *
 * Four things about this wiring are load-bearing and none of them is obvious:
 *
 * 1. **The yield signal is the Commander's own conversation queue.**
 *    `DreamJudge` takes `shouldYield` and, until now, nothing drove it — so the
 *    dream would have kept judging while he was talking to her at 03:00, on the
 *    one rate-limit pool they share. `ConversationService` is the only path an
 *    interactive turn takes, and the dream's own turns do not take it.
 * 2. **No `cwd` is passed.** The judge runs on the `consolidation` lane, which
 *    is in `MEMORYLESS_LANES`, and it already sends `autoMemoryOff()` — the
 *    lane must not be handed a writable memory directory or the dream reads its
 *    own reflections back as experience (QA finding C1, and constraint 7's
 *    spirit).
 * 3. **Every turn is `runTurn`**, which strips `ANTHROPIC_API_KEY` and asserts
 *    `apiKeySource === "none"`. A night is many turns and every one of them
 *    stays on subscription rails (constraint 1).
 * 4. **A substituted turn runner reaches the dream too.** `DreamJudge` imports
 *    the real `runTurn` when it is given none, so a caller that replaced the
 *    runner everywhere else — every test that boots the service — would have
 *    had exactly one path left that spawns the real CLI, and it is the one that
 *    spawns it a hundred and eighty times a night.
 */
function buildDreamJudge(
  config: SylConfig,
  deps: ServiceDependencies,
  clock: Clock,
  options: StartSylOptions,
): NightDreamer | null {
  const searchable = deps.memoryRuntime.trySearchable();
  if (searchable === null) return null;

  const sweep = new DreamSweep({
    graph: deps.memory.graph,
    log: deps.memory.dreams,
    weights: deps.memory.weights,
    semantic: searchable.semantic,
    clock,
  });

  const claudeBin = options.turn?.claudeBin;

  return new DreamJudge({
    sweep,
    log: deps.memory.dreams,
    clock,
    sessionStore: sessionStoreFor(config),
    // Both bounds. The Commander talking pauses it; the quiet window closing
    // ENDS it — and that second one is what keeps a six-hour night off the
    // concurrency-one job runner, which reminder delivery shares (`syl-ncx`).
    shouldYield: createYieldSignal({
      conversations: deps.chat,
      clock,
      window: { tz: config.quietHours.tz, quiet: config.quietHours.quiet },
    }),
    // Unwrapped by `withMemoryIndex`, unlike the agent's: a judgment turn runs
    // with `--tools ""` and cannot write a memory, so there is no index to
    // maintain and nothing for the wrapper to do.
    ...(options.runner === undefined ? {} : { runTurn: options.runner }),
    ...(claudeBin === undefined ? {} : { turnOptions: { claudeBin } }),
  });
}

/** Syl, up: the store, the socket, and the loop that makes reminders arrive. */
export interface RunningSyl {
  readonly database: SylDatabase;
  readonly deps: ServiceDependencies;
  /**
   * Syl's own credential for this process's lifetime.
   *
   * Carried here so the tool wiring can reach it and nothing else can. It is
   * deliberately absent from `startupFields` and `startupLines`: a token in the
   * rotated JSON log is a token on disk, which is the one place this credential
   * is never allowed to be.
   */
  readonly agentKey: AgentCredential;
  readonly service: RunningService;
  readonly runtime: DeliveryRuntime;
  /** The lines to print. Returned rather than printed, so a test can read them. */
  readonly startupLines: readonly string[];
  /**
   * The same start, as fields rather than prose.
   *
   * This is the record that goes into the rotated JSON log, and it is what
   * anyone will actually query six months from now. `credentialSource` is in
   * here for the reason given on `describeStartup`.
   */
  readonly startupFields: Readonly<Record<string, unknown>>;
  /** What the APNs environment assertion concluded. */
  readonly push: PushEnvironmentAssertion;
  /** Stop the loop, then the socket. Leaves the database open. */
  close(): Promise<void>;
}

/**
 * Start the whole of Syl.
 *
 * **This is what `main` is.** `syl-md5`: the six lines that decide whether
 * reminders run on the Commander's machine used to live inside `main`, which
 * reads `process.env`, binds the real port and returns nothing — so no test
 * could call it, and the most critical path in the system could only ever run
 * for the first time in front of him. They are here now, and every journey
 * boots through this function.
 *
 * Order is load-bearing and each step is here rather than in `bootstrap`
 * because it needs the one before it:
 *
 * 1. the socket, so the service can answer before it starts working;
 * 2. `ensureContentIngestionJob`, **before** the first tick, so that tick
 *    already sees whatever was mid-ladder when the process last died;
 * 3. `runner.start()`, awaited — awaiting it means every instant that passed
 *    while the machine was down has been considered before the service claims
 *    to be up. A runner that starts scheduling before it has looked at what it
 *    missed silently swallows whatever was due.
 */
export async function startSyl(
  config: SylConfig,
  options: StartSylOptions = {},
): Promise<RunningSyl> {
  const { database, deps: bootstrapped, agentKey, hands } = bootstrap(config, options);
  const delivery = options.delivery ?? {};
  const clock = delivery.clock ?? options.clock ?? systemClock;

  // Before the port is bound, because a refusal has to be a refusal. A service
  // that binds, answers health checks and then declines to push is exactly the
  // silent failure this assertion exists to prevent.
  //
  // `pushConfigured` is read from the same environment the runtime will read,
  // not from `process.env`, so a test that redirects APNs is asserting about
  // the credentials it actually supplied.
  const deliveryEnv = delivery.env ?? process.env;
  let push: PushEnvironmentAssertion;
  let deps: ServiceDependencies;
  try {
    const pushConfigured = apnsCredentialsFromEnv(deliveryEnv) !== null;
    push = assertPushEnvironment(
      assessPushEnvironment({
        declared: config.pushEnvironment,
        nodeEnv: config.nodeEnv,
        pushConfigured,
        allowSandbox: config.allowSandboxPush,
        registered: bootstrapped.devices.targets(),
      }),
    );
    deps = {
      ...bootstrapped,
      probes: [
        ...(bootstrapped.probes ?? []),
        pushEnvironmentProbe({
          environment: push.environment,
          pushConfigured,
          targets: () => bootstrapped.devices.targets(),
        }),
        tailnetCertProbe({ path: config.certStatusPath, now: () => clock() }),
      ],
    };
  } catch (error) {
    // The store was opened by `bootstrap` a few lines up. Leaving it open on a
    // refused start leaks a WAL and, in a test suite, a file handle per case.
    database.close();
    throw error;
  }

  const service = await startServer(config, deps);

  // HER HANDS, DECLARED — and this is the earliest moment it can be done.
  //
  // The declaration has to carry two things nothing knew a moment ago: the
  // PORT, which is the kernel's answer and is `0` in the configuration of every
  // test, and her CREDENTIAL, which `agent-key.ts` mints fresh on every boot
  // because the previous plaintext died with the previous process. So the file
  // is written after the listener exists and before anything can take a turn —
  // `bootstrap` decided the path, this decides the contents, and the commander
  // lane was handed the path rather than the file.
  //
  // `127.0.0.1` rather than `config.host`: she talks to loopback whatever the
  // service binds. Her credential must never leave the machine it was minted
  // on, not even to the tailnet, which is not a boundary between his own
  // devices. `tools/client.ts` refuses a non-loopback base at construction;
  // this is the same rule where the value is chosen.
  const handsHome = sylHome(config);
  if (handsHome !== undefined) {
    writeToolConfig({
      home: handsHome,
      baseUrl: `http://127.0.0.1:${String(portOf(service))}${API_BASE_PATH}`,
      token: agentKey.token,
      tz: config.quietHours.tz,
    });
  }

  ensureContentIngestionJob(deps.jobs, clock());
  // The dream, on a clock at last (`syl-cbb`). One row, a `wall_clock` trigger
  // in the Commander's own zone, and a `once_per_window` catch-up over the
  // quiet window — so it runs in the gap and, if it is missed, waits for the
  // next gap rather than spending turns at breakfast.
  const dreamSchedule = { tz: config.quietHours.tz, quiet: config.quietHours.quiet };
  const dreamJob = ensureNightlyDreamJob(deps.jobs, dreamSchedule, clock());

  const runtime = createDeliveryRuntime({
    jobs: deps.jobs,
    reminders: deps.reminders,
    outbox: deps.outbox,
    devices: deps.devices,
    // The third presence seam, and the last one made here (`syl-8l7`). The
    // socket says whether anyone is watching, the conversation service says
    // whether a turn is open, and the delivery loop is the only thing that
    // knows a notification actually broke through to him.
    presence: deps.presence,
    handlers: new Map([
      [
        "content_ingestion",
        createContentIngestionHandler({ intake: deps.intake, queue: deps.intakeQueue }),
      ],
      [
        "nightly_consolidation",
        createNightlyDreamHandler({
          log: deps.memory.dreams,
          ...dreamSchedule,
          judge: () => buildDreamJudge(config, deps, clock, options),
        }),
      ],
    ]),
    clock,
    ...(delivery.timers === undefined ? {} : { timers: delivery.timers }),
    ...(delivery.origins === undefined ? {} : { origins: delivery.origins }),
    ...(delivery.env === undefined ? {} : { env: delivery.env }),
    ...(delivery.warn === undefined ? {} : { warn: delivery.warn }),
    ...(delivery.onError === undefined ? {} : { onError: delivery.onError }),
  });
  await runtime.runner.start();

  // A pairing code is only printed when there is nothing paired. Printing one
  // on every boot would train the Commander to ignore it, and a code shown
  // repeatedly is a code that is eventually shown to somebody else.
  const startup = needsPairingCode(deps.keys)
    ? describeStartup(config, { pairingCode: deps.keys.issuePairingCode().code })
    : describeStartup(config);

  const power = assessPower();
  // Looked at once, for the startup lines. The route re-checks per request, so
  // this is a report rather than a decision — a build that lands while the
  // service is running still serves.
  const admin = inspectAdminBundle(config.adminDir);

  return {
    database,
    deps,
    agentKey,
    service,
    runtime,
    push,
    startupLines: [
      ...startup,
      // Where she thinks and what she can reach from there, said out loud, once
      // per boot — and BOTH halves derived. `hands` is the declaration
      // `bootstrap` resolved and gave the commander lane, so the notice cannot
      // drift from the turn the way the old constant "no MCP" did (`syl-009.9`).
      ...describeContainer(sylHome(config), hands),
      ...describeRuntime(runtime),
      // Re-read: `ensureNightlyDreamJob` returns the row as it was found, and
      // the runner's first tick has already run since then.
      ...describeDream(deps.jobs.get(dreamJob.id) ?? dreamJob, dreamSchedule),
      ...describePushEnvironment(push, { pushConfigured: runtime.pushEnabled }),
      ...describePower(power),
      ...describeAdmin(admin),
    ],
    startupFields: {
      version: config.version,
      nodeEnv: config.nodeEnv,
      host: config.host,
      port: config.port,
      databasePath: config.databasePath,
      // The room she thinks in, as a field rather than as prose — this is the
      // one a log query six months from now can group on, and the one whose
      // absence meant nobody could answer "where do her turns run?" without
      // reading a launchd plist.
      turnHome: sylHome(config) ?? process.cwd(),
      credentialSource: config.credentialSource,
      subscriptionRails: config.subscriptionRails,
      timeZone: config.quietHours.tz,
      quietHours: `${config.quietHours.quiet.start}-${config.quietHours.quiet.end}`,
      pushEnabled: runtime.pushEnabled,
      pushEnvironment: push.environment,
      pushEnvironmentDeclared: push.declared,
      powerOk: power.ok,
      adminDir: admin.root,
      adminBundlePresent: admin.present,
    },
    close: async () => {
      // The loop first. A tick that begins while the socket is closing has
      // nothing to gain and a database underneath it that may be going away.
      await runtime.stop();
      await service.close();
    },
  };
}

/**
 * Process entry point.
 *
 * Everything interesting is in `startSyl`, which a test can call. What is left
 * here is the three things that are genuinely process-level and cannot be:
 * opening the log file, honouring `SIGTERM`, and deciding what an unstartable
 * configuration does to the exit code.
 *
 * `EX_CONFIG` (78) rather than 1 on a bad configuration, because launchd's
 * `KeepAlive` will restart this immediately and forever; a distinct code is
 * what tells the difference between "it crashed" and "it will crash again in
 * ten seconds until somebody edits a plist" when reading `launchctl print`.
 */
export async function main(options: { readonly logger?: Logger } = {}): Promise<RunningSyl> {
  const config = loadConfig();
  const logger = options.logger ?? createLogger({ directory: config.logDirectory });

  /**
   * What a shutdown closes, late-bound — because the HANDLERS have to be
   * installed before there is anything to close.
   *
   * This used to run after `startSyl`, which was a real hole rather than a
   * stylistic detail. `startSyl` starts the HTTP listener, so between it
   * returning and this line the service ANSWERED HEALTH CHECKS while a
   * `SIGTERM` still took Node's default action and killed it outright.
   * Readiness advertised a guarantee that was not yet true.
   *
   * It showed up as `expected 143 to be +0` in the process-level test —
   * intermittently, and only under load, because load is what widens the
   * window. Installing first collapses it: by the time anything can observe
   * the service at all, the signal is already honoured.
   *
   * A signal arriving while `startSyl` is still constructing therefore finds a
   * no-op close and exits promptly, which is correct — there is no in-flight
   * work to drain, and exiting 0 beats dying by signal.
   */
  let close = async (): Promise<void> => undefined;

  installShutdownHandlers({
    close: () => close(),
    log: (event, fields) => {
      logger.log(event === "shutdown.complete" || event === "shutdown.begin" ? "info" : "error", event, fields);
    },
  });

  const syl = await startSyl(config, { logger });

  close = async () => {
    await syl.close();
    syl.database.close();
    // The logger is deliberately left open. Closing it here closed the file
    // descriptor *before* `shutdown.complete` was written, so the log ended
    // at `shutdown.begin` and every clean stop was indistinguishable from a
    // hang. Found by the process-level test, which is the only place it was
    // visible. `process.exit` flushes and closes it a moment later.
  };

  logger.info("service.start", { ...syl.startupFields, logPath: logger.path });
  for (const line of syl.startupLines) {
    const level = line.includes("WARNING") ? "warn" : "info";
    logger.log(level, "service.notice", { message: line });
  }

  return syl;
}

/** Run `main`, and turn anything it throws into an exit code and a line. */
async function runAsEntryPoint(): Promise<void> {
  try {
    await main();
  } catch (error) {
    // Straight to stderr rather than through the logger: the failures that land
    // here are configuration failures, and `loadConfig` throwing is the reason
    // there is no logger to use.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(78);
  }
}

// Run only when executed directly, so importing this module in a test starts
// nothing.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAsEntryPoint();
}
