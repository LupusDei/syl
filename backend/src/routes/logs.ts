import { Router, type Request, type RequestHandler } from "express";

import type { LogEntry, LogPage } from "@syl/shared";

import { scanLog, type LogQueryOptions } from "../ops/log-query.js";
import type { LogLevel, LogRecord } from "../ops/logging.js";
import { pageOf, PagingError, resolvePage } from "../services/paging.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { pageOptionsOf } from "./devices.js";

/**
 * The structured log, over HTTP.
 *
 * ## Why this endpoint exists
 *
 * Syl runs on the Commander's machine with `--permission-mode
 * bypassPermissions`. He can talk to her from his phone and, until this route,
 * could not see what she DID — which is backwards for something pre-authorised
 * on your own hardware. `turn.tool` is the line that answers it: every tool she
 * reached for, with the turn it belonged to. "Every tool she has called today"
 * should be one request, not a `grep` over SSH.
 *
 * ## Why it is the one route with a scope
 *
 * It is the most sensitive **read** in the system, and it is sensitive in a
 * different way from everything else in the contract. `/reminders`, `/todos`,
 * `/conversations` are all the Commander's own data; a paired phone is
 * *supposed* to have them. The log is not his data — it is the record of what a
 * program did on his machine. A shoulder-surfed pairing code, or a phone that
 * left the house in someone else's pocket, must not become a transcript of the
 * machine's activity, and it is a strictly worse thing to leak than the to-do
 * list it sits beside.
 *
 * So the token needs `admin` scope, which no HTTP route can mint — see
 * `services/api-key-service.ts`. The gate is `requireScope`, mounted *behind*
 * the ordinary bearer check, so an anonymous caller still gets the
 * indistinguishable 401 and never learns the surface exists.
 *
 * ## Why it reads the file rather than a table
 *
 * The log is the artefact that survives the process. A database table would be
 * written by the same service whose failure to start is the thing most worth
 * reading about, and would be unreadable in exactly that case. `ops/log-query.
 * ts` already knows the part a shell one-liner gets wrong — that the rotations
 * run newest-to-oldest, `syl.log` then `.1` then `.5` — so this route is a
 * query-string parser in front of it and nothing more.
 */

/** Filters a caller may ask for. Everything is optional; nothing is required. */
export interface LogRouterOptions {
  /**
   * Where `syl.log` lives. `config.logDirectory`.
   *
   * A function rather than a string so a test can point it somewhere after
   * the app is built, and so a service whose log directory is created lazily
   * does not capture a path that did not exist at mount time.
   */
  readonly logDirectory: string | (() => string);
  readonly authenticate: RequestHandler;
  /** The scope gate. Separate from `authenticate` so both are visibly mounted. */
  readonly requireAdmin: RequestHandler;
  /** Overrides the reader, for a test that does not want a file. */
  readonly read?: (directory: string, options: LogQueryOptions) => readonly LogRecord[];
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * How much of one record's fields travel.
 *
 * A record is open — `LogRecord` has an index signature — and the fields are
 * whatever the call site passed. They are forwarded as an opaque object rather
 * than being modelled, because modelling them would mean the contract has to
 * change every time somebody adds a field to a log line, which is the fastest
 * possible way to train people to stop adding fields.
 */
export function toLogEntry(record: LogRecord): LogEntry {
  const { ts, level, event, pid, ...fields } = record;
  return { ts, level, event, pid, fields };
}

export function createLogRouter(options: LogRouterOptions): Router {
  const { authenticate, requireAdmin } = options;
  const directoryOf = (): string =>
    typeof options.logDirectory === "function" ? options.logDirectory() : options.logDirectory;
  const read = options.read ?? scanLog;
  const router = Router();

  // Order is the security property: a token first, then what that token is
  // for. Reversed, a caller with no token at all would be told this endpoint
  // needs admin scope, which is a fact about the service they have not earned.
  router.use("/logs", authenticate, requireAdmin);

  router.get("/logs", (request, response) => {
    const filters = logFiltersOf(request);
    let page: LogPage;
    try {
      const { limit, offset } = resolvePage(pageOptionsOf(request));
      // `limit + 1`: the extra row is how `hasMore` is answered without a
      // second pass, and it is the same convention every store here uses.
      const records = read(directoryOf(), { ...filters, offset, limit: limit + 1 });
      page = pageOf(records.map(toLogEntry), limit, offset);
    } catch (error) {
      if (error instanceof PagingError) {
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { field: error.kind === "bad_cursor" ? "cursor" : "limit", reason: error.message },
        });
      }
      throw error;
    }
    sendOk(response, page);
  });

  return router;
}

/**
 * Read the filters off the query string.
 *
 * Everything is refused rather than coerced. A `level=warning` read as "no
 * level filter" hands back a page of `debug` lines that looks like the answer
 * to a question nobody asked — and the reader concludes there were no warnings.
 * A filter that silently does not apply is worse than one that fails.
 */
export function logFiltersOf(request: Request): LogQueryOptions {
  const event = single(request, "event");
  const level = single(request, "level");
  const since = single(request, "since");
  const until = single(request, "until");

  if (level !== undefined && !LEVELS.includes(level as LogLevel)) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not a log level.", {
      details: { field: "level", reason: `must be one of ${LEVELS.join(", ")}` },
    });
  }
  const from = instantOrThrow(since, "since");
  const to = instantOrThrow(until, "until");
  if (from !== undefined && to !== undefined && from > to) {
    // Not merely empty: an inverted range is always a mistake, and answering
    // it with an empty page reads as "nothing happened then".
    throw new ApiFailure("VALIDATION_FAILED", "since must not be after until.", {
      details: { field: "since", reason: "range is inverted" },
    });
  }

  return {
    ...(event === undefined ? {} : { event }),
    // Safe assertion: membership checked immediately above.
    ...(level === undefined ? {} : { minLevel: level as LogLevel }),
    ...(from === undefined ? {} : { since: from }),
    ...(to === undefined ? {} : { until: to }),
  };
}

/** One value, or a refusal. A repeated parameter is a client bug, not a set. */
function single(request: Request, field: string): string | undefined {
  const raw = request.query[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must appear at most once.`, {
      details: { field, reason: "repeated" },
    });
  }
  return raw === "" ? undefined : raw;
}

/**
 * Normalise an instant to the exact spelling records carry.
 *
 * `scanLog` compares `ts` lexically, which is only sound if both sides have the
 * same shape. A caller sending `2026-08-10T00:00:00Z` — valid RFC 3339, no
 * milliseconds — would otherwise compare as *later* than
 * `2026-08-10T00:00:00.114Z`, because `.` sorts before `Z`. Round-tripping
 * through `Date` makes the comparison mean what the caller meant.
 */
function instantOrThrow(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must be an RFC 3339 instant.`, {
      details: { field, reason: "not a date" },
    });
  }
  return new Date(parsed).toISOString();
}
