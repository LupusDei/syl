import { defaultLogDirectory, type LogLevel } from "../logging.js";
import { lastFailure, queryLog, renderLog } from "../log-query.js";

/**
 * `npm run logs` — what happened, without a debugger.
 *
 * The reason this is a command rather than a `grep` incantation in a runbook is
 * rotation: the newest records are in `syl.log` and the older ones are in
 * `syl.log.1` through `syl.log.5`, and a one-liner walks them in the wrong
 * order in exactly one direction — which quietly reports the wrong failure.
 *
 * Usage:
 *   npm run logs                 the last 50 records
 *   npm run logs -- --failure    the most recent warning or error, alone
 *   npm run logs -- --level warn only warnings and errors
 *   npm run logs -- --event job  only events beginning "job"
 *   npm run logs -- --dir <path> somewhere other than SYL_LOG_DIR
 */

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function isLevel(value: string | undefined): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function main(argv: readonly string[]): number {
  const directory = flag(argv, "dir") ?? defaultLogDirectory();
  const level = flag(argv, "level");
  const event = flag(argv, "event");
  const limit = Number(flag(argv, "limit") ?? "50");

  if (argv.includes("--failure")) {
    const found = lastFailure(directory);
    if (found === null) {
      console.log(`Nothing has gone wrong in ${directory}.`);
      return 0;
    }
    console.log(renderLog([found]));
    return 0;
  }

  const records = queryLog(directory, {
    ...(isLevel(level) ? { minLevel: level } : {}),
    ...(event === undefined ? {} : { event }),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
  });

  console.log(`# ${directory}`);
  console.log(renderLog(records));
  return 0;
}

process.exit(main(process.argv.slice(2)));
