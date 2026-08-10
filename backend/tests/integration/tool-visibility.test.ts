import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import type { TurnResult, TurnRunner } from "../../src/harness/session.js";
import { bootstrap } from "../../src/index.js";
import type { LogLevel, Logger } from "../../src/ops/logging.js";
import { testConfig } from "../helpers/service.js";

/**
 * **US3 — what she did is visible.** `syl-009.5.1`.
 *
 * > Every tool call lands in the log as `turn.tool` **with its arguments**.
 *
 * The arguments are the whole line. "She called `remind_me`" is not a record of
 * what she did on his machine — what she *did* is the arguments: what the
 * reminder says, when it fires, whether it claimed urgency, and the reason she
 * attached. Without them the log can tell him something happened and never
 * what, which is the same uselessness as the service that logged startup and
 * failure and nothing in between.
 *
 * This session runs pre-authorised. `turn.tool` is the only independent record
 * of what a program with `bypassPermissions` did while nobody was watching, and
 * `/logs` is admin-scoped precisely so it stays independent of her.
 */

const closers: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Line {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

/** A logger that keeps its lines instead of writing them. */
function recordingLogger(): { readonly logger: Logger; readonly lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: LogLevel) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      lines.push({ level, event, fields });
    };
  return {
    lines,
    logger: {
      log: (level, event, fields) => lines.push({ level, event, fields }),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      path: "/dev/null",
      close: () => undefined,
    },
  };
}

/** The reminder she made, as the arguments she made it with. */
const SHE_ASKED_FOR = {
  text: "Take the bread out of the oven.",
  when: { said: "in five minutes", kind: "relative", minutes: 5 },
  because: "He asked for it, just now.",
};

/** A turn that calls one tool and says so, the way the harness reports it. */
const callsATool: TurnRunner = async (_prompt, options): Promise<TurnResult> => {
  const sessionId = options.resume ?? options.sessionId ?? "tool-visibility";
  options.onSessionId?.(sessionId);
  options.onEvent?.({
    kind: "tool_use",
    sessionId,
    raw: {},
    name: "mcp__syl__remind_me",
    input: SHE_ASKED_FOR,
  });
  return {
    sessionId,
    text: "Done.",
    costUsd: 0,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId,
      raw: {},
      model: "stand-in",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: [],
  };
};

describe("what the log says she did", () => {
  it("should record the arguments, not only the name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syl-toollog-"));
    dirs.push(dir);
    const { logger, lines } = recordingLogger();
    const built = bootstrap(testConfig({ databasePath: join(dir, "syl.db") }), {
      logger,
      runner: callsATool,
    });
    closers.push(() => built.database.close());

    await built.agent.ask("Remind me in five minutes to take the bread out.", LANES.commander);

    const tool = lines.find((line) => line.event === "turn.tool");
    expect(tool?.fields?.["tool"]).toBe("mcp__syl__remind_me");
    // The thing that makes the line worth having. Asserted as the whole object
    // rather than field by field, so a handler that grows a field cannot start
    // acting on something the log does not mention.
    expect(tool?.fields?.["arguments"]).toEqual(SHE_ASKED_FOR);
  });

  it("should be readable as one line per call, at info", async () => {
    // Not `debug`: the record of what a pre-authorised program did on his
    // machine is not a thing anybody should have to turn on first.
    const dir = mkdtempSync(join(tmpdir(), "syl-toollog-"));
    dirs.push(dir);
    const { logger, lines } = recordingLogger();
    const built = bootstrap(testConfig({ databasePath: join(dir, "syl.db") }), {
      logger,
      runner: callsATool,
    });
    closers.push(() => built.database.close());

    await built.agent.ask("Remind me.", LANES.commander);

    expect(lines.filter((line) => line.event === "turn.tool")).toHaveLength(1);
    expect(lines.find((line) => line.event === "turn.tool")?.level).toBe("info");
  });
});
