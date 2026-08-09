import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";

import { loadConfig, type SylConfig } from "./config.js";
import { createHealthRouter } from "./routes/health.js";

/**
 * The Syl HTTP service.
 *
 * `createApp` and `startServer` are separate on purpose: the app is a pure
 * function of config and can be driven over a socket in tests without any
 * process-level state, and the listening server is the only thing that has to
 * be torn down.
 */

/** JSON bodies larger than this are refused. Syl exchanges text, not uploads. */
const MAX_BODY_BYTES = "1mb";

/** Error codes this layer can produce. The contract will formalise these. */
const ERROR_CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  404: "not_found",
  413: "payload_too_large",
  415: "unsupported_media_type",
};

/**
 * Name a status.
 *
 * A 4xx with no specific name must not come back as `internal_error` — the
 * status line would say "your request" while the body said "our bug", and
 * whoever is debugging would chase the wrong half of the system.
 */
function errorCode(status: number): string {
  return ERROR_CODES[status] ?? (status < 500 ? "client_error" : "internal_error");
}

/**
 * Pull a client-error status off a thrown value.
 *
 * `express.json()` rejects a malformed body by throwing an error carrying
 * `status: 400`. Anything without a 4xx status is our bug, not the caller's,
 * and becomes a 500.
 */
export function errorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  // Safe assertion: guarded by the `in` check, and the value is re-tested.
  const candidate = ("status" in error ? error.status : undefined) as unknown;
  if (typeof candidate === "number" && candidate >= 400 && candidate < 500) {
    return candidate;
  }
  return 500;
}

/** Anything unmatched is a 404 in the API's own vocabulary, not an HTML page. */
export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: "not_found",
    message: "No route on this service matches that request.",
  });
};

/**
 * Terminal error handler.
 *
 * Express's default renders a stack trace outside production. Syl's responses
 * go to a phone and to logs the Commander reads, so the body is always a code
 * and never internals; the detail goes to stderr where it belongs.
 */
export const onError: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = errorStatus(error);
  if (status === 500) {
    console.error("[syl] unhandled request error", error);
  }
  response.status(status).json({
    error: errorCode(status),
    message:
      status === 500
        ? "The service failed to handle that request."
        : "That request could not be accepted.",
  });
};

/** Build the Express application for a given configuration. */
export function createApp(config: SylConfig): Express {
  const app = express();

  // Nothing gains from telling the world which framework to look up CVEs for.
  app.disable("x-powered-by");

  app.use(express.json({ limit: MAX_BODY_BYTES }));
  app.use("/api", createHealthRouter(config));
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
export function startServer(config: SylConfig): Promise<Server> {
  const server = createServer(createApp(config));

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
 * Separated from `main` so the one piece of judgement in the bootstrap — that a
 * stray credential variable deserves a loud warning and not a silent start — is
 * something tests can hold onto rather than something only a human reading a
 * terminal would notice was missing.
 */
export function describeStartup(config: SylConfig): readonly string[] {
  const lines = [
    `[syl] v${config.version} listening on http://${config.host}:${config.port} (${config.nodeEnv})`,
  ];

  if (!config.subscriptionRails) {
    lines.push(
      `[syl] WARNING: ${config.credentialSource} is set in this environment. ` +
        `The harness strips it before spawning claude, but anything that reaches ` +
        `the CLI another way will bill the metered API instead of the subscription.`,
    );
  }

  return lines;
}

/** Process entry point. */
async function main(): Promise<void> {
  const config = loadConfig();
  await startServer(config);
  for (const line of describeStartup(config)) console.log(line);
}

// Run only when executed directly, so importing this module in a test starts
// nothing.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
