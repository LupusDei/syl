import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  lastFailure,
  logFiles,
  parseRecord,
  queryLog,
  renderLog,
  scanLog,
} from "../../src/ops/log-query.js";
import {
  createLogger,
  createMemoryLogger,
  defaultLogDirectory,
  formatHuman,
  safeField,
  toolArgumentsForLog,
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

/**
 * `syl-009.5` — the arguments are the audit, and the log is a file he reads.
 *
 * `turn.tool` carries what Syl actually did on the Commander's machine, which
 * is the only reason the line is worth writing. The same property makes it the
 * one place a value she was handled can end up on his disk, and the one place
 * a pasted article can cost eight megabytes of log. Both guards live here
 * rather than at the call site, so a second caller of `turn.tool` — a second
 * lane with hands, a job that logs a call — cannot get a weaker version.
 */
describe("toolArgumentsForLog", () => {
  /** A stand-in with the shape of the real thing: 32 hex characters. */
  const CREDENTIAL = "9f2c17ab".repeat(4);

  it("should keep the arguments intact, because they are the audit", () => {
    // The control. A redactor that emptied the line would satisfy every
    // assertion below and destroy the thing the line exists for.
    const asked = {
      text: "Take the bread out of the oven.",
      because: "He asked for it, just now.",
      when: { said: "in five minutes", kind: "relative", minutes: 5 },
    };

    expect(toolArgumentsForLog(asked, { secrets: [CREDENTIAL] })).toEqual(asked);
  });

  it("should remove her credential wherever it appears, however it is nested", () => {
    // Matched as a VALUE, not by field name. A guard keyed on names like
    // `token` covers the field somebody thought of and waves through the next.
    const redacted = toolArgumentsForLog(
      {
        text: `curl -H "authorization: Bearer ${CREDENTIAL}"`,
        nested: { deeper: [{ note: CREDENTIAL }] },
      },
      { secrets: [CREDENTIAL] },
    );

    expect(JSON.stringify(redacted)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(redacted)).toContain("[redacted]");
    // And the rest of the sentence survives, so the log still says what she did.
    expect(JSON.stringify(redacted)).toContain("authorization: Bearer");
  });

  it("should redact BEFORE it truncates, so a cut cannot leave half a secret", () => {
    // The ordering bug this function is arranged to avoid. Truncating first
    // puts the first N characters of the credential on the line and reads, in
    // the log, exactly like a guard that worked.
    const rendered = JSON.stringify(
      toolArgumentsForLog({ text: `${"a".repeat(30)}${CREDENTIAL}` }, {
        secrets: [CREDENTIAL],
        maxStringLength: 40,
      }),
    );

    expect(rendered).not.toContain(CREDENTIAL.slice(0, 10));
    expect(rendered).toContain("[redacted]");
  });

  it("should cut a long string and say how much it dropped", () => {
    // "Trailing off" and "there was more" are different facts, and only the
    // second lets him decide whether he needs the rest.
    const rendered = toolArgumentsForLog({ text: "x".repeat(5_000) }, { maxStringLength: 100 }) as {
      text: string;
    };

    expect(rendered.text.startsWith("x".repeat(100))).toBe(true);
    expect(rendered.text).toContain("+4900 more characters");
  });

  it("should keep the field names when the whole call is too large to write down", () => {
    // The shape nobody predicts: not one long string but ten thousand short
    // ones. Which verb was called with which fields is still the audit, so the
    // keys survive and the values do not.
    const rendered = toolArgumentsForLog(
      { because: "he said so", items: Array.from({ length: 5_000 }, (_, index) => `item-${String(index)}`) },
      { maxBytes: 500 },
    ) as { omitted: string; fields: readonly string[] };

    expect(rendered.fields).toEqual(["because", "items"]);
    expect(rendered.omitted).toMatch(/too large for the log/u);
  });

  it("should ignore an empty secret, which would otherwise match everywhere", () => {
    // A caller that passes a credential it has not minted yet must not blank
    // the log. An empty needle is inside every string.
    expect(toolArgumentsForLog({ text: "hello" }, { secrets: [""] })).toEqual({ text: "hello" });
  });

  it("should never throw, whatever it is handed", () => {
    // Same rule as `safeField`: a logger that dies inside an error path takes
    // the process down at the moment the log was about to say why.
    expect(() => toolArgumentsForLog(undefined)).not.toThrow();
    expect(toolArgumentsForLog(null)).toBeNull();
    expect(toolArgumentsForLog(7)).toBe(7);
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

/**
 * The paging and time-range half of the reader, which `GET /logs` is built on.
 *
 * Written against a hand-laid file rather than through `createLogger`, because
 * every case here is about *which* records come back for a given `ts`, and a
 * logger stamping them from the wall clock cannot be asked that question.
 */
describe("scanLog", () => {
  /** Nine records, one per minute, newest last on disk. */
  function nineMinutes(): string {
    const dir = scratch();
    const lines: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const ts = `2026-08-10T13:0${String(index)}:00.000Z`;
      const level = index === 4 ? "error" : "info";
      lines.push(
        JSON.stringify({ ts, level, event: index % 2 === 0 ? "turn.tool" : "turn.done", pid: 1, index }),
      );
    }
    writeFileSync(join(dir, "syl.log"), `${lines.join("\n")}\n`);
    return dir;
  }

  it("should return records newest first, which is the opposite of queryLog", () => {
    const dir = nineMinutes();

    expect(scanLog(dir).map((record) => record["index"])).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(queryLog(dir).map((record) => record["index"])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("should skip `offset` matches counting from the newest", () => {
    const dir = nineMinutes();

    // Page two of a three-per-page walk: the fourth, fifth and sixth newest.
    expect(scanLog(dir, { offset: 3, limit: 3 }).map((record) => record["index"])).toEqual([5, 4, 3]);
  });

  it("should apply the offset AFTER the filters, not before", () => {
    // The failure this pins: skipping rows and then filtering them makes page
    // two of a filtered view show a near-random subset, and the reader has no
    // way to notice — the page is full and the rows are real.
    const dir = nineMinutes();

    expect(
      scanLog(dir, { event: "turn.tool", offset: 2, limit: 2 }).map((record) => record["index"]),
    ).toEqual([4, 2]);
  });

  it("should include both ends of a time range", () => {
    const dir = nineMinutes();

    expect(
      scanLog(dir, {
        since: "2026-08-10T13:02:00.000Z",
        until: "2026-08-10T13:04:00.000Z",
      }).map((record) => record["index"]),
    ).toEqual([4, 3, 2]);
  });

  it("should combine a time range with a level and an event prefix", () => {
    const dir = nineMinutes();

    expect(
      scanLog(dir, {
        since: "2026-08-10T13:01:00.000Z",
        minLevel: "warn",
        event: "turn",
      }).map((record) => record["index"]),
    ).toEqual([4]);
  });

  it("should return nothing rather than everything when the range matches nothing", () => {
    // A filter that silently stops applying is worse than one that returns
    // nothing: an empty page says "not then", a full one says "here is your
    // answer" and is wrong.
    const dir = nineMinutes();

    expect(scanLog(dir, { since: "2027-01-01T00:00:00.000Z" })).toEqual([]);
    expect(scanLog(dir, { until: "2020-01-01T00:00:00.000Z" })).toEqual([]);
  });

  it("should not truncate at a clock that stepped backwards", () => {
    // Records descend in time as the scan runs — until an NTP correction or a
    // VM resume writes an older `ts` after a newer one. Stopping the walk at
    // the first out-of-range record would silently drop everything past the
    // step, and the answer would look complete.
    const dir = scratch();
    writeFileSync(
      join(dir, "syl.log"),
      [
        JSON.stringify({ ts: "2026-08-10T13:00:00.000Z", level: "info", event: "before", pid: 1 }),
        JSON.stringify({ ts: "2026-08-10T09:00:00.000Z", level: "info", event: "stepped", pid: 1 }),
        JSON.stringify({ ts: "2026-08-10T13:00:01.000Z", level: "info", event: "after", pid: 1 }),
      ].join("\n"),
    );

    expect(scanLog(dir, { since: "2026-08-10T12:00:00.000Z" }).map((r) => r.event)).toEqual([
      "after",
      "before",
    ]);
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
