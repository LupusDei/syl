import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";

import { loadConfig, type SylConfig } from "./config.js";
import { requireBearerToken } from "./middleware/auth.js";
import { createAuthRouter } from "./routes/auth.js";
import { ApiFailure, sendFailure } from "./routes/envelope.js";
import { createHealthRouter, databaseProbe, type HealthProbe } from "./routes/health.js";
import { ApiKeyService } from "./services/api-key-service.js";
import { openDatabase, type SylDatabase } from "./services/database.js";

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

/** What `createApp` needs that configuration cannot supply. */
export interface AppDependencies {
  /** Bearer tokens. Required: an app with no auth is not a thing Syl ships. */
  readonly keys: ApiKeyService;
  /** Extra health probes. The billing check is always present. */
  readonly probes?: readonly HealthProbe[];
}

/** Build the Express application. */
export function createApp(config: SylConfig, deps: AppDependencies): Express {
  const app = express();

  // Nothing gains from telling the world which framework to look up CVEs for.
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  const authenticate = requireBearerToken({ keys: deps.keys });

  // Mounted onto one router so the base path appears exactly once, and so a
  // route added later cannot land outside it by forgetting the prefix.
  const api = Router();
  api.use(
    createHealthRouter(
      deps.probes === undefined ? { config } : { config, probes: deps.probes },
    ),
  );
  api.use(createAuthRouter({ keys: deps.keys, authenticate }));

  app.use(API_BASE_PATH, api);
  app.use(notFound);
  app.use(onError);

  return app;
}

/**
 * Start listening.
 *
 * Resolves only once the socket is accepting connections, and rejects instead
 * of hanging if the port is taken — a promise that settles either way is what
 * makes this safe to `await` in a test.
 */
export function startServer(config: SylConfig, deps: AppDependencies): Promise<Server> {
  const server = createServer(createApp(config, deps));

  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
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

/** Open the store and build the services the app needs. */
export function bootstrap(config: SylConfig): {
  readonly database: SylDatabase;
  readonly deps: AppDependencies;
} {
  const database = openDatabase({ path: config.databasePath });
  const keys = new ApiKeyService({ db: database.handle });

  return {
    database,
    deps: { keys, probes: [databaseProbe(database.handle)] },
  };
}

/** Process entry point. */
async function main(): Promise<void> {
  const config = loadConfig();
  const { deps } = bootstrap(config);
  await startServer(config, deps);

  // A pairing code is only printed when there is nothing paired. Printing one
  // on every boot would train the Commander to ignore it, and a code shown
  // repeatedly is a code that is eventually shown to somebody else.
  const unpaired = deps.keys.list().every((key) => key.revokedAt !== null);
  const startup = unpaired
    ? describeStartup(config, { pairingCode: deps.keys.issuePairingCode().code })
    : describeStartup(config);

  for (const line of startup) console.log(line);
}

// Run only when executed directly, so importing this module in a test starts
// nothing.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
