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
function callsATool(input: () => Record<string, unknown>): TurnRunner {
  return async (_prompt, options): Promise<TurnResult> => {
    const sessionId = options.resume ?? options.sessionId ?? "tool-visibility";
    options.onSessionId?.(sessionId);
    options.onEvent?.({
      kind: "tool_use",
      sessionId,
      raw: {},
      name: "mcp__syl__remind_me",
      input: input(),
    });
    return {
      sessionId,
      text: "Done.",
      result: "Done.",
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
}

/**
 * A service on a real home, calling one tool with arguments it composes from
 * **its own** credential.
 *
 * The indirection is the point rather than a convenience. `bootstrap` mints the
 * agent key, so nothing can name it until the service exists — and a test that
 * planted some *other* boot's token would assert that a redactor wired to the
 * wrong secret still hides the right one, which is a green test for the defect.
 * Read late, the string in the arguments is the string in the process.
 */
function serviceThatCalls(
  input: (token: string) => Record<string, unknown> = () => SHE_ASKED_FOR,
): { readonly lines: Line[]; readonly token: string; ask(what: string): Promise<unknown> } {
  const dir = mkdtempSync(join(tmpdir(), "syl-toollog-"));
  dirs.push(dir);
  const { logger, lines } = recordingLogger();
  let token = "";
  const built = bootstrap(testConfig({ databasePath: join(dir, "syl.db") }), {
    logger,
    runner: callsATool(() => input(token)),
  });
  closers.push(() => built.database.close());
  token = built.agentKey.token;

  return {
    lines,
    token,
    ask: (what: string) => built.agent.ask(what, LANES.commander),
  };
}

/** The one line, or `undefined`. */
function toolLine(lines: readonly Line[]): Line | undefined {
  return lines.find((line) => line.event === "turn.tool");
}

describe("what the log says she did", () => {
  it("should record the arguments, not only the name", async () => {
    const syl = serviceThatCalls();

    await syl.ask("Remind me in five minutes to take the bread out.");

    const tool = toolLine(syl.lines);
    expect(tool?.fields?.["tool"]).toBe("mcp__syl__remind_me");
    // The thing that makes the line worth having. Asserted as the whole object
    // rather than field by field, so a handler that grows a field cannot start
    // acting on something the log does not mention.
    expect(tool?.fields?.["arguments"]).toEqual(SHE_ASKED_FOR);
  });

  it("should be readable as one line per call, at info", async () => {
    // Not `debug`: the record of what a pre-authorised program did on his
    // machine is not a thing anybody should have to turn on first.
    const syl = serviceThatCalls();

    await syl.ask("Remind me.");

    expect(syl.lines.filter((line) => line.event === "turn.tool")).toHaveLength(1);
    expect(toolLine(syl.lines)?.level).toBe("info");
  });
});

/**
 * `syl-009.5` — the same line, read as a thing that lands on his disk.
 *
 * The tests above are about the log being **useful**. These are about it being
 * **safe to write**, which is a different question with the opposite failure
 * mode: the first fails loudly and empty, the second fails quietly and full.
 *
 * Both are properties of `toolArgumentsForLog`, and `tests/unit/logging.test.ts`
 * covers its behaviour case by case. What is asserted here, and only here, is
 * that the service actually routes `turn.tool` through it — with the credential
 * this boot minted rather than a value a test invented, so the assertion cannot
 * pass against a redactor wired to the wrong secret.
 */
describe("what the log must not say", () => {
  it("should never write her credential down, whatever field carries it", async () => {
    // Planted the way it could really arrive: not as a `token` field somebody
    // would think to strip, but inside prose, because the guard is on the value
    // and not on the name. She has no built-in tools and cannot read
    // `hands.json` today — this is the line that keeps that from being the only
    // thing standing between the credential and a file he reads.
    const syl = serviceThatCalls((token) => ({
      text: "Remind me to rotate the key",
      because: `the header read "authorization: Bearer ${token}"`,
    }));

    await syl.ask("Remind me to rotate the key.");

    const written = JSON.stringify(toolLine(syl.lines));
    expect(written).not.toContain(syl.token);
    // And the surrounding sentence survived, so the log still says what she did.
    expect(written).toContain("authorization: Bearer");
    expect(written).toContain("[redacted]");
  });

  it("should not let one tool call cost an unbounded amount of his disk", async () => {
    // The volume half. An argument is whatever the model put in it, and he
    // pastes articles into this conversation; a `remind_me` carrying one would
    // otherwise write the article into `syl.log` verbatim, on a file whose
    // whole design is a bounded 8 MiB.
    const article = "the quick brown fox. ".repeat(5_000);
    const syl = serviceThatCalls(() => ({ text: article, because: "he pasted it" }));

    await syl.ask("Remind me about this.");

    const line = toolLine(syl.lines);
    expect(JSON.stringify(line).length).toBeLessThan(20_000);
    // Bounded, not lost: the reason she gave is short and is the reviewable
    // part, so it must survive whole.
    expect(JSON.stringify(line)).toContain("he pasted it");
  });
});
