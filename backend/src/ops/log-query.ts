import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_LOG_FILENAME,
  DEFAULT_MAX_FILES,
  formatHuman,
  type LogLevel,
  type LogRecord,
} from "./logging.js";

/**
 * Reading the log back.
 *
 * The point of a structured log is that "what went wrong last night" is a query
 * rather than an exercise in scrolling. This module is that query, and it is
 * here rather than in a shell one-liner because the rotation order — live file
 * newest, `.1` next, `.5` oldest — is a thing a one-liner gets wrong in exactly
 * one direction and then quietly reports the wrong failure.
 *
 * Tolerant by construction: a truncated final line is what a log looks like
 * after a `SIGKILL`, and that is precisely the moment somebody is reading it.
 * An unparsable line is skipped, never thrown on.
 */

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/** Parse one line, or `null` if it is not a record. */
export function parseRecord(line: string): LogRecord | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // Safe assertion: guarded above, and every field read is re-tested.
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate["ts"] !== "string") return null;
  if (typeof candidate["event"] !== "string") return null;
  if (!isLogLevel(candidate["level"])) return null;
  return candidate as unknown as LogRecord;
}

/**
 * The files that make up the log, newest first.
 *
 * The live file, then `.1` through `.maxFiles`. A gap does not stop the walk:
 * a rotation interrupted by a power cut can leave one missing, and refusing to
 * look at the rest because of it would hide the very failure being chased.
 */
export function logFiles(directory: string, options: LogQueryOptions = {}): readonly string[] {
  const filename = options.filename ?? DEFAULT_LOG_FILENAME;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const paths = [join(directory, filename)];
  for (let index = 1; index <= maxFiles; index += 1) {
    paths.push(join(directory, `${filename}.${String(index)}`));
  }
  return paths.filter((path) => existsSync(path));
}

export interface LogQueryOptions {
  readonly filename?: string;
  readonly maxFiles?: number;
  /** Only records at or above this level. */
  readonly minLevel?: LogLevel;
  /** Only records whose `event` starts with this. */
  readonly event?: string;
  /** At most this many, most recent last. */
  readonly limit?: number;
}

/**
 * Records matching a query, oldest first.
 *
 * Files are read newest-first and stopped as soon as `limit` is satisfied, so
 * asking for the last failure does not read a year of logs to find it.
 */
export function queryLog(directory: string, options: LogQueryOptions = {}): readonly LogRecord[] {
  const limit = options.limit ?? 100;
  const floor = LEVEL_RANK[options.minLevel ?? "debug"];
  const collected: LogRecord[] = [];

  for (const path of logFiles(directory, options)) {
    if (collected.length >= limit) break;
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = contents.split("\n");
    // Backwards: the newest record in a file is its last line.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (collected.length >= limit) break;
      const record = parseRecord(lines[index] ?? "");
      if (record === null) continue;
      if (LEVEL_RANK[record.level] < floor) continue;
      if (options.event !== undefined && !record.event.startsWith(options.event)) continue;
      collected.push(record);
    }
  }

  return collected.reverse();
}

/** The most recent `warn`-or-worse record, or `null` if there has not been one. */
export function lastFailure(directory: string, options: LogQueryOptions = {}): LogRecord | null {
  const found = queryLog(directory, { ...options, minLevel: "warn", limit: 1 });
  return found[0] ?? null;
}

/** The human rendering of a query result. What the CLI prints. */
export function renderLog(records: readonly LogRecord[]): string {
  if (records.length === 0) return "(nothing matched)";
  return records.map((record) => `${record.ts} ${formatHuman(record)}`).join("\n");
}
