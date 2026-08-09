import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Logs that are readable at 3am by someone who did not write this.
 *
 * Two sinks, on purpose, because they answer different questions:
 *
 * - **A rotated JSON-lines file** that this process owns and can therefore
 *   rotate. Machine-readable, so "what was the last failure" is `grep` rather
 *   than a debugger, and bounded, so a service that has been up for a year has
 *   not filled the disk.
 * - **stdout**, one human line per event, which is what launchd captures into
 *   `StandardOutPath` and what a person tails.
 *
 * The duplication is deliberate. Rotating a file that launchd holds open does
 * not work — launchd keeps writing to the renamed inode and the "current" file
 * stays empty forever — so the file we rotate has to be one we opened
 * ourselves. That is the single trap in this module and it is the reason it
 * exists at all rather than being `console.log` plus `newsyslog`.
 *
 * Rotation is by size and happens *before* a write that would cross the
 * threshold, so the cap is a real cap rather than a cap plus one record.
 */

/** Severity, ordered. `warn` and above are what an operator is looking for. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** One record, as it appears on a line of the JSON log. */
export interface LogRecord {
  /** ISO-8601 UTC, so lines sort lexically and survive a timezone change. */
  readonly ts: string;
  readonly level: LogLevel;
  /**
   * A dotted, stable name — `service.start`, `shutdown.timeout`. Stable is the
   * point: it is what a search is built on, and a prose message is not.
   */
  readonly event: string;
  readonly pid: number;
  readonly [field: string]: unknown;
}

/** Where the logs live, and how much of them is kept. */
export interface LogSinkOptions {
  /** Directory for `syl.log` and its rotations. Created if missing. */
  readonly directory: string;
  /** Base filename. Rotations are `<name>.1`, `<name>.2`, ... */
  readonly filename?: string;
  /** Rotate once the file would exceed this. */
  readonly maxBytes?: number;
  /** How many rotations to keep besides the live file. */
  readonly maxFiles?: number;
  /** Lines at or above this go to the JSON file. */
  readonly level?: LogLevel;
  /** Where the human mirror goes. `null` for none. Defaults to stdout. */
  readonly console?: ((line: string) => void) | null;
  /** For tests. Defaults to the wall clock. */
  readonly now?: () => number;
}

export const DEFAULT_LOG_FILENAME = "syl.log";
/** 8 MiB per file, five rotations: ~48 MiB worst case. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5;

/**
 * Where logs go when nothing says otherwise.
 *
 * `~/Library/Logs` is where macOS expects them and where Console.app looks, and
 * it is writable by a LaunchAgent without any privilege at all. Overridden by
 * `SYL_LOG_DIR`.
 */
export function defaultLogDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["SYL_LOG_DIR"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const home = env["HOME"]?.trim();
  if (home !== undefined && home !== "") return join(home, "Library", "Logs", "Syl");
  return join(".syl", "logs");
}

/**
 * Render a record as the one line a human reads.
 *
 * `message` is special: it is rendered bare rather than as `message=...`,
 * because it is the field that exists for a person and quoting prose as a
 * key/value pair is how a readable log becomes an unreadable one. Everything
 * else is `key=value`, which is what makes the mirror greppable too.
 */
export function formatHuman(record: LogRecord): string {
  const { ts, level, event, pid, message, ...rest } = record;
  void ts;
  void pid;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const parts = [`[syl] ${level.toUpperCase().padEnd(5)} ${event}`];
  if (typeof message === "string") parts.push(message);
  if (fields !== "") parts.push(fields);
  return parts.join(" ");
}

/**
 * A value that is safe to put on a log line.
 *
 * `JSON.stringify` throws on a circular structure and silently drops a
 * `BigInt`, and a logger that throws inside an error path takes the process
 * down at exactly the moment the log was going to say why. Errors become their
 * message and stack, because an `Error` serialises to `{}` and that has cost
 * more than one person an afternoon.
 */
export function safeField(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? null };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
  /** The live file's path, for a message that tells a human where to look. */
  readonly path: string;
  close(): void;
}

/**
 * Open the log file and return a logger that owns it.
 *
 * Synchronous writes, deliberately. The last thing a process logs is usually
 * the most interesting thing it ever logged, and an asynchronous write queued
 * behind a `process.exit` is a line that never reaches the disk.
 */
export function createLogger(options: LogSinkOptions): Logger {
  const filename = options.filename ?? DEFAULT_LOG_FILENAME;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const threshold = LEVEL_RANK[options.level ?? "info"];
  const now = options.now ?? Date.now;
  const mirror =
    options.console === null ? null : (options.console ?? ((line: string) => process.stdout.write(`${line}\n`)));

  const path = join(options.directory, filename);
  mkdirSync(dirname(path), { recursive: true });

  let fd: number | null = openSync(path, "a");
  let size = existsSync(path) ? statSync(path).size : 0;

  /**
   * Shift `syl.log` to `syl.log.1` and everything else up one, dropping the
   * oldest.
   *
   * The descriptor is closed *before* the rename and reopened after, so the
   * live file is always the one at `path` — the trap that makes rotating a
   * launchd-held file impossible is the one we are stepping around here.
   */
  const rotate = (): void => {
    if (fd !== null) closeSync(fd);
    fd = null;
    for (let index = maxFiles; index >= 1; index -= 1) {
      const older = `${path}.${String(index)}`;
      const newer = index === 1 ? path : `${path}.${String(index - 1)}`;
      if (!existsSync(newer)) continue;
      if (index === maxFiles && existsSync(older)) unlinkSync(older);
      renameSync(newer, older);
    }
    fd = openSync(path, "a");
    size = 0;
  };

  const write = (record: LogRecord): void => {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      // `JSON.stringify` throws on a circular structure, and the object most
      // likely to be circular is the one attached to an error — a request, a
      // socket, a store. Losing the *record* over that would mean the log goes
      // quiet exactly when it matters, so the event survives and only the
      // fields are dropped.
      line = `${JSON.stringify({
        ts: record.ts,
        level: record.level,
        event: record.event,
        pid: record.pid,
        unserialisable: error instanceof Error ? error.message : "fields could not be serialised",
      })}\n`;
    }
    const bytes = Buffer.byteLength(line);
    // Before the write, not after: a cap enforced afterwards is a cap plus
    // whatever the last record happened to be, which for a stack trace is not
    // a rounding error.
    if (fd !== null && size + bytes > maxBytes && size > 0) rotate();
    if (fd === null) return;
    try {
      writeSync(fd, line);
      size += bytes;
    } catch {
      // A log write must never be the thing that kills the service. A full
      // disk is bad; a full disk that also stops reminders is worse.
    }
  };

  const log = (level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) safe[key] = safeField(value);
    const record: LogRecord = {
      ts: new Date(now()).toISOString(),
      level,
      event,
      pid: process.pid,
      ...safe,
    };
    write(record);
    mirror?.(formatHuman(record));
  };

  return {
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    path,
    close: () => {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

/** A logger that keeps records in memory. For tests, and for `--dry-run`. */
export function createMemoryLogger(): Logger & { readonly records: readonly LogRecord[] } {
  const records: LogRecord[] = [];
  const log = (level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) safe[key] = safeField(value);
    records.push({ ts: new Date().toISOString(), level, event, pid: process.pid, ...safe });
  };
  return {
    records,
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    path: "(memory)",
    close: () => undefined,
  };
}
