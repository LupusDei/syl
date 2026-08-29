import type { RequestHandler } from "express";

import type { LogLevel, Logger } from "../ops/logging.js";

/**
 * One line per request, so "did his phone reach us" has an answer.
 *
 * ## Why this exists
 *
 * The Commander's to-do completions stopped arriving on 2026-08-25 and were not
 * noticed for three days. The phone believed it had sent them; the service
 * showed them open. The question that would have settled it in a minute — did
 * the requests arrive and fail, or never leave the device? — could not be asked
 * of this service at all, because it wrote nothing about the requests it
 * served. **A log that is silent about both outcomes reports neither**, and the
 * investigation had to start from the phone with no way to corroborate anything
 * found there.
 *
 * ## What it may say, and what it may never say
 *
 * The destination is `~/Library/Logs/Syl/syl.log` — a file the Commander reads
 * and that `GET /logs` serves. That makes restraint part of the design rather
 * than a courtesy:
 *
 *   * **Method, path, status, duration.** Enough to answer the question above
 *     and to see a route failing.
 *   * **The idempotency key**, when the request carries one. It is the only
 *     field that ties three attempts at one write together, which is exactly
 *     the shape a stuck outbox produces — and it is a value this service minted
 *     the semantics of, not a secret.
 *   * **Nothing else.** No bodies, no headers, and **no query string**. The
 *     query is dropped wholesale rather than filtered, because a filter guards
 *     the parameter names somebody thought of and hands the next one through;
 *     the same argument `toolArgumentsForLog` makes for guarding values rather
 *     than field names, reached from the other side. Today no route puts a
 *     credential in a query. This middleware must stay correct on the day one
 *     does.
 *
 * ## Two details that are easy to get wrong
 *
 * **It listens on `close`, not on `finish`.** `finish` fires when a response
 * has been written; a client that hangs up mid-request never produces one. That
 * is the case most likely to be a lost write, so a middleware built on `finish`
 * would be silent about precisely the requests worth knowing about. `close`
 * fires either way and `writableFinished` says which happened.
 *
 * **It is mounted before the body parsers.** A body that is malformed or over
 * the limit is refused by `express.json()` with a 400 or a 413, and a log
 * mounted after it would not see either — a phone sending something this build
 * cannot parse would look, from here, like a phone that never called.
 */

/** The event name. Stable, because it is what a search is built on. */
export const REQUEST_EVENT = "http.request";

export interface RequestLogOptions {
  readonly log: Logger;
  /**
   * Paths logged at `debug` instead of `info`, matched as prefixes.
   *
   * For the liveness poll, which a watchdog makes every thirty seconds forever.
   * Quiet by configuration rather than by omission: the line still exists, and
   * lowering the sink's level brings it back. A path dropped in code cannot be
   * recovered by anyone debugging at 3am.
   */
  readonly quiet?: readonly string[];
}

/** Log every request once it is over, however it ended. */
export function logRequests(options: RequestLogOptions): RequestHandler {
  const { log } = options;
  const quiet = options.quiet ?? [];

  return (request, response, next) => {
    const started = process.hrtime.bigint();
    // `originalUrl` rather than `path`: this is mounted at the root, and `path`
    // is relative to the mount point of whatever router is running when it is
    // read. Everything from `?` on is discarded — see the note above.
    const path = request.originalUrl.split("?")[0] ?? request.originalUrl;
    const key = request.header("Idempotency-Key");

    response.once("close", () => {
      const answered = response.writableFinished;
      const level: LogLevel = !answered
        ? "warn"
        : response.statusCode >= 500
          ? "error"
          : quiet.some((prefix) => path.startsWith(prefix))
            ? "debug"
            : "info";

      log.log(level, REQUEST_EVENT, {
        method: request.method,
        path,
        status: response.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
        // Absent rather than null. A field that is present on every line as
        // `null` is a field a `grep` has to step over on every line.
        ...(key === undefined || key === "" ? {} : { idempotencyKey: key }),
        // Only when it is true, and it is the whole reason for `close`.
        ...(answered ? {} : { aborted: true }),
      });
    });

    next();
  };
}
