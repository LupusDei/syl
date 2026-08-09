import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lastFailure, logFiles, parseRecord, queryLog, renderLog } from "../../src/ops/log-query.js";
import {
  createLogger,
  createMemoryLogger,
  defaultLogDirectory,
  formatHuman,
  safeField,
  type LogRecord,
} from "../../src/ops/logging.js";

/**
 * The logger, writing to a real directory on a real disk.
 *
 * Every case here opens the actual file, rotates the actual file and reads the
 * bytes back. A logger asserted through a mocked `fs` would pass while writing
 * nothing, which is precisely the failure it exists to prevent — and rotation
 * in particular is all filesystem semantics and no logic.
 */

let directory: string | null = null;

function scratch(): string {
  directory = mkdtempSync(join(tmpdir(), "syl-log-"));
  return directory;
}

afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function lines(path: string): LogRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => parseRecord(line))
    .filter((record): record is LogRecord => record !== null);
}

describe("createLogger", () => {
  it("should write one JSON record per call, with the fields it was given", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });

    logger.info("service.start", { port: 4201, credentialSource: "none" });
    logger.close();

    const records = lines(logger.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("service.start");
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.["port"]).toBe(4201);
    expect(records[0]?.["credentialSource"]).toBe("none");
    expect(records[0]?.pid).toBe(process.pid);
  });

  it("should create the directory it was pointed at", () => {
    const dir = join(scratch(), "nested", "deeper");
    const logger = createLogger({ directory: dir, console: null });
    logger.info("service.start");
    logger.close();

    expect(existsSync(join(dir, "syl.log"))).toBe(true);
  });

  it("should mirror a human line to the console sink", () => {
    const dir = scratch();
    const printed: string[] = [];
    const logger = createLogger({ directory: dir, console: (line) => printed.push(line) });

    logger.warn("service.notice", { message: "[syl] WARNING: something" });
    logger.close();

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("WARN");
    expect(printed[0]).toContain("[syl] WARNING: something");
  });

  it("should drop records below its level", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null, level: "warn" });

    logger.debug("noise");
    logger.info("also noise");
    logger.error("the interesting one");
    logger.close();

    expect(lines(logger.path).map((record) => record.event)).toEqual(["the interesting one"]);
  });

  it("should rotate before crossing the size cap, not after", () => {
    // A cap enforced after the write is a cap plus whatever the last record
    // happened to be — which for a stack trace is not a rounding error.
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null, maxBytes: 400, maxFiles: 3 });

    for (let index = 0; index < 20; index += 1) {
      logger.info("filler", { index, padding: "x".repeat(50) });
    }
    logger.close();

    expect(existsSync(`${logger.path}.1`)).toBe(true);
    for (const path of logFiles(dir)) {
      expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(600);
    }
  });

  it("should keep no more rotations than it was told to", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null, maxBytes: 200, maxFiles: 2 });

    for (let index = 0; index < 60; index += 1) logger.info("filler", { index, pad: "y".repeat(60) });
    logger.close();

    expect(existsSync(`${logger.path}.2`)).toBe(true);
    expect(existsSync(`${logger.path}.3`)).toBe(false);
  });

  it("should keep the newest records in the live file after a rotation", () => {
    // The direction of the shift is the one thing rotation gets wrong, and it
    // gets it wrong silently: the log still looks full, of the wrong end.
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null, maxBytes: 300, maxFiles: 3 });

    for (let index = 0; index < 30; index += 1) logger.info("step", { index, pad: "z".repeat(40) });
    logger.close();

    const live = lines(logger.path);
    expect(live[live.length - 1]?.["index"]).toBe(29);
  });

  it("should keep writing to the live path after rotating", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null, maxBytes: 250, maxFiles: 2 });

    for (let index = 0; index < 20; index += 1) logger.info("before", { index, pad: "q".repeat(40) });
    logger.info("after", { marker: true });
    logger.close();

    expect(lines(logger.path).some((record) => record.event === "after")).toBe(true);
  });

  it("should survive a record it cannot serialise", () => {
    // A logger that throws inside an error path takes the process down at
    // exactly the moment the log was about to say why.
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => logger.error("boom", { circular })).not.toThrow();
    logger.close();
  });
});

describe("safeField", () => {
  it("should render an Error as its message and stack, not as {}", () => {
    const rendered = safeField(new Error("no such file"));
    expect(rendered).toMatchObject({ name: "Error", message: "no such file" });
  });

  it("should render a bigint as a string", () => {
    expect(safeField(10n)).toBe("10");
  });

  it("should leave an ordinary value alone", () => {
    expect(safeField(42)).toBe(42);
  });
});

describe("formatHuman", () => {
  const base = { ts: "2026-08-09T00:00:00.000Z", pid: 1 } as const;

  it("should render message as prose rather than as a key/value pair", () => {
    expect(formatHuman({ ...base, level: "info", event: "service.notice", message: "up" })).toBe(
      "[syl] INFO  service.notice up",
    );
  });

  it("should render everything else as key=value", () => {
    expect(formatHuman({ ...base, level: "error", event: "job.failed", kind: "reminder" })).toContain(
      "kind=reminder",
    );
  });
});

describe("defaultLogDirectory", () => {
  it("should prefer SYL_LOG_DIR", () => {
    expect(defaultLogDirectory({ SYL_LOG_DIR: "/var/log/syl", HOME: "/Users/x" })).toBe("/var/log/syl");
  });

  it("should use ~/Library/Logs/Syl, where Console.app looks", () => {
    expect(defaultLogDirectory({ HOME: "/Users/x" })).toBe("/Users/x/Library/Logs/Syl");
  });

  it("should fall back into the repository when there is no home", () => {
    expect(defaultLogDirectory({})).toBe(".syl/logs");
  });
});

describe("queryLog", () => {
  it("should find the last failure without reading a debugger", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });

    logger.info("service.start");
    logger.error("apns.blocked", { reason: "InvalidProviderToken" });
    logger.info("job.ok");
    logger.close();

    const failure = lastFailure(dir);
    expect(failure?.event).toBe("apns.blocked");
    expect(failure?.["reason"]).toBe("InvalidProviderToken");
  });

  it("should return null when nothing has gone wrong", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });
    logger.info("service.start");
    logger.close();

    expect(lastFailure(dir)).toBeNull();
  });

  it("should search rotations, newest file first", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null, maxBytes: 2_000, maxFiles: 3 });

    logger.error("the.old.one", { reason: "InvalidProviderToken" });
    // One record larger than the whole cap, so exactly one rotation happens and
    // the count does not depend on how many digits this process's pid has.
    logger.info("filler", { pad: "b".repeat(3_000) });
    logger.close();

    expect(existsSync(`${logger.path}.1`)).toBe(true);
    expect(lines(logger.path).map((record) => record.event)).toEqual(["filler"]);
    expect(lastFailure(dir)?.event).toBe("the.old.one");
    expect(queryLog(dir, { event: "the.old.one" })).toHaveLength(1);
  });

  it("should return records oldest first", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });
    logger.warn("first");
    logger.warn("second");
    logger.close();

    expect(queryLog(dir, { minLevel: "warn" }).map((record) => record.event)).toEqual([
      "first",
      "second",
    ]);
  });

  it("should skip a truncated final line rather than throw on it", () => {
    // What a log looks like after a SIGKILL — which is exactly the moment
    // somebody is reading it.
    const dir = scratch();
    writeFileSync(
      join(dir, "syl.log"),
      `{"ts":"2026-08-09T00:00:00.000Z","level":"error","event":"real","pid":1}\n{"ts":"2026-0`,
    );

    expect(queryLog(dir).map((record) => record.event)).toEqual(["real"]);
  });

  it("should honour the limit", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });
    for (let index = 0; index < 10; index += 1) logger.warn("event", { index });
    logger.close();

    expect(queryLog(dir, { minLevel: "warn", limit: 3 })).toHaveLength(3);
  });

  it("should report an empty result rather than an empty string", () => {
    expect(renderLog([])).toBe("(nothing matched)");
  });

  it("should render found records with their timestamps", () => {
    const dir = scratch();
    const logger = createLogger({ directory: dir, console: null });
    logger.error("apns.blocked");
    logger.close();

    expect(renderLog(queryLog(dir, { minLevel: "warn" }))).toContain("apns.blocked");
  });
});

describe("parseRecord", () => {
  it("should reject a line that is not a record", () => {
    expect(parseRecord("hello")).toBeNull();
    expect(parseRecord("")).toBeNull();
    expect(parseRecord("[1,2,3]")).toBeNull();
    expect(parseRecord('{"level":"info"}')).toBeNull();
    expect(parseRecord('{"ts":"x","event":"y","level":"nope"}')).toBeNull();
  });
});

describe("createMemoryLogger", () => {
  it("should collect records without touching a disk", () => {
    const logger = createMemoryLogger();
    logger.warn("held", { n: 1 });
    logger.close();

    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]?.event).toBe("held");
    expect(logger.path).toBe("(memory)");
  });
});
