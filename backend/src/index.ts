import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";

import type { Job, PushEnvironment } from "@syl/shared";

import { createDeliveryRuntime, describeRuntime, type DeliveryRuntime } from "./jobs/runtime.js";
import { loadConfig, type SylConfig } from "./config.js";
import {
  createContentIngestionHandler,
  ensureContentIngestionJob,
  IntakeQueue,
} from "./connections/intake-job.js";
import { createIntakeRouter } from "./connections/intake-route.js";
import { ArticleIntake } from "./connections/intake.js";
import { IntakeStore } from "./connections/intake-store.js";
import { requireBearerToken } from "./middleware/auth.js";
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
import { createLogger, type Logger } from "./ops/logging.js";
import { assessPower, describePower } from "./ops/power.js";
import { installShutdownHandlers } from "./ops/shutdown.js";
import { tailnetCertProbe } from "./ops/tailnet-cert.js";
import { createHealthRouter, databaseProbe, type HealthProbe } from "./routes/health.js";
import { createJobRouter } from "./routes/jobs.js";
import { createReminderRouter } from "./routes/reminders.js";
import { apnsCredentialsFromEnv } from "./services/apns-service.js";
import { ApiKeyService } from "./services/api-key-service.js";
import { systemClock, type Clock } from "./services/clock.js";
import { openDatabase, type SylDatabase } from "./services/database.js";
import type { Timers } from "./services/job-runner.js";
import { DeviceTokenService } from "./services/device-token-service.js";
import { IdempotencyStore } from "./services/idempotency.js";
import { JobStore } from "./services/job-store.js";
import { MessageStore } from "./services/message-store.js";
import { Outbox } from "./services/outbox.js";
import { PresenceService } from "./services/presence.js";
import { ReminderService } from "./services/reminder-service.js";
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

/** JSON bodies larger than this are refused. Syl exchanges text, not uploads. */
const MAX_BODY_BYTES = "1mb";

/** The contract's base path. Not configurable — it is part of the contract. */
export const API_BASE_PATH = "/api/v1";

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

/** Anything unmatched is a contract 404, not an HTML page. */
export const notFound: RequestHandler = (_request, response) => {
  sendFailure(
    response,
    new ApiFailure("NOT_FOUND", "No route on this service matches that request."),
  );
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
  /** Conversation history. */
  readonly messages: MessageStore;
  /** Registered push targets. */
  readonly devices: DeviceTokenService;
  /** The delivery outbox — where the never-drop guarantee lives. */
  readonly outbox: Outbox;
  /** Reminders, and the deferral invariant. */
  readonly reminders: ReminderService;
  /** Scheduled work, its runs, and the lateness of each. */
  readonly jobs: JobStore;
  /** The ledger that makes every write safe to retry. */
  readonly idempotency: IdempotencyStore;
  /** Article intake: submission, and the resumable ladder behind it. */
  readonly intake: ArticleIntake;
  /** Extra health probes. The billing check is always present. */
  readonly probes?: readonly HealthProbe[];
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
}

/** Build the Express application. */
export function createApp(config: SylConfig, deps: AppDependencies): Express {
  // Destructured in full, and reached through the names below rather than
  // through `deps.` — see the note on `AppDependencies`. Removing a use here
  // without removing the field does not compile.
  const { keys, messages, devices, outbox, reminders, jobs, idempotency, intake, probes } = deps;
  const app = express();

  // Nothing gains from telling the world which framework to look up CVEs for.
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  const authenticate = requireBearerToken({ keys });

  // Mounted onto one router so the base path appears exactly once, and so a
  // route added later cannot land outside it by forgetting the prefix.
  const api = Router();
  api.use(createHealthRouter(probes === undefined ? { config } : { config, probes }));
  // Every write router takes `idempotency`. `syl-ux1` — `POST /auth/pair` and
  // `POST /conversations/{id}/messages` were the two that did not, and a lost
  // response to the first consumed the pairing code and left the device
  // permanently unpairable.
  api.use(createAuthRouter({ keys, idempotency, authenticate }));
  api.use(createConversationRouter({ messages, idempotency, authenticate }));
  api.use(createDeviceRouter({ devices, idempotency, authenticate }));
  api.use(createDeliveryRouter({ outbox, reminders, idempotency, authenticate }));
  api.use(createReminderRouter({ reminders, idempotency, authenticate }));
  api.use(createJobRouter({ jobs, authenticate }));
  api.use(createIntakeRouter({ intake, idempotency, authenticate }));

  app.use(API_BASE_PATH, api);
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
    messages: app.messages,
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

  if (options.pairingCode !== undefined) {
    lines.push(
      `[syl] No device is paired. Pairing code: ${options.pairingCode} ` +
        `(POST ${API_BASE_PATH}/auth/pair). It expires shortly and is consumed on use.`,
    );
  }

  return lines;
}

/** What `bootstrap` may be told that the configuration cannot say. */
export interface BootstrapOptions {
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
}

/** Open the store and build the services the app needs. */
export function bootstrap(
  config: SylConfig,
  options: BootstrapOptions = {},
): {
  readonly database: SylDatabase;
  readonly deps: ServiceDependencies;
} {
  const clock = options.clock ?? systemClock;
  const database = openDatabase({ path: config.databasePath });
  const keys = new ApiKeyService({ db: database.handle, clock });
  const messages = new MessageStore({ db: database.handle, clock });
  const devices = new DeviceTokenService({ db: database.handle, clock });
  const idempotency = new IdempotencyStore({ db: database.handle, clock });
  // From the config, not from `process.env`. `loadConfig` has already refused
  // an unusable window, so nothing here can hand the outbox a quiet window
  // that throws the first time the delivery handler defers something.
  const outbox = new Outbox({ db: database.handle, clock, quietHours: config.quietHours });
  const reminders = new ReminderService({ db: database.handle, clock });
  const jobs = new JobStore({ db: database.handle, clock });
  // One zone for the whole service, and the one `loadConfig` has already
  // checked is a place rather than an offset. The quiet *window* stays
  // presence's own: `absent` is about whether Syl shows a character, which
  // starts later than the hour the outbox stops sending notifications.
  const presence = new PresenceService({ clock, timeZone: config.quietHours.tz });

  // Intake, wired end to end: the store the migration now creates, the queue
  // that is `ArticleIntake`'s long-missing scheduler, and the ladder itself.
  // `fetch` is left at its default — `safeFetch`, the SSRF guard — because the
  // only reason that parameter exists is so a test can drive the ladder
  // without a network, and a production caller substituting it would have
  // removed the control that stops a hostile link reaching the tailnet.
  const intakeQueue = new IntakeQueue();
  const intakeStore = new IntakeStore({ db: database.handle, clock });
  const intake = new ArticleIntake({ store: intakeStore, clock, scheduler: intakeQueue });
  // Everything mid-ladder when the process died is due again now. Every step
  // is idempotent, so re-running one is safe; skipping one is not.
  intakeQueue.recover(intake, clock());

  return {
    database,
    deps: {
      keys,
      messages,
      devices,
      outbox,
      reminders,
      jobs,
      idempotency,
      intake,
      presence,
      intakeQueue,
      probes: [databaseProbe(database.handle)],
    },
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

/** Syl, up: the store, the socket, and the loop that makes reminders arrive. */
export interface RunningSyl {
  readonly database: SylDatabase;
  readonly deps: ServiceDependencies;
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
  const { database, deps: bootstrapped } = bootstrap(config, options);
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

  ensureContentIngestionJob(deps.jobs, clock());

  const runtime = createDeliveryRuntime({
    jobs: deps.jobs,
    reminders: deps.reminders,
    outbox: deps.outbox,
    devices: deps.devices,
    handlers: new Map([
      [
        "content_ingestion",
        createContentIngestionHandler({ intake: deps.intake, queue: deps.intakeQueue }),
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
  const unpaired = deps.keys.list().every((key) => key.revokedAt !== null);
  const startup = unpaired
    ? describeStartup(config, { pairingCode: deps.keys.issuePairingCode().code })
    : describeStartup(config);

  const power = assessPower();

  return {
    database,
    deps,
    service,
    runtime,
    push,
    startupLines: [
      ...startup,
      ...describeRuntime(runtime),
      ...describePushEnvironment(push, { pushConfigured: runtime.pushEnabled }),
      ...describePower(power),
    ],
    startupFields: {
      version: config.version,
      nodeEnv: config.nodeEnv,
      host: config.host,
      port: config.port,
      databasePath: config.databasePath,
      credentialSource: config.credentialSource,
      subscriptionRails: config.subscriptionRails,
      timeZone: config.quietHours.tz,
      quietHours: `${config.quietHours.quiet.start}-${config.quietHours.quiet.end}`,
      pushEnabled: runtime.pushEnabled,
      pushEnvironment: push.environment,
      pushEnvironmentDeclared: push.declared,
      powerOk: power.ok,
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

  const syl = await startSyl(config);

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
