import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";

import type { Reminder } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { loadQuietHours } from "../../src/config.js";
import type { SylEvent } from "../../src/harness/protocol.js";
import type { TurnResult, TurnRunner } from "../../src/harness/session.js";
import { fixedClock } from "../../src/services/clock.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * **US6 — she can act.**
 *
 * > As the Commander, I want to ask for a reminder in plain language, so that I
 * > stop being the one who remembers.
 *
 * This is `syl-009`'s acceptance criterion, minus the phone:
 *
 * > **The Commander says "remind me in five minutes", and a reminder exists,
 * > stored, set to fire five minutes later.**
 *
 * `us1-a-reminder-reaches-him` already proves the second half of that sentence —
 * a reminder in the store becomes a notification on his phone at the right
 * wall-clock instant. What has never been true is the first half. He asked for
 * one on his phone, she replied the way an assistant would, and **nothing was
 * written**. The turn produced text and no action. That is `syl-act1`, and it is
 * why this epic exists.
 *
 * ## This test is RED on purpose
 *
 * It is declared in `tests/expected-failures.json` under `syl-009.7.1`. It says
 * what SHOULD happen and it will keep saying it until it is true. It must not be
 * softened into asserting what the code does today — that mistake produced
 * `should leave the Commander talking to himself: no assistant message ever
 * arrives`, which passed green for weeks while Syl could not reply to anyone.
 *
 * When it starts passing, the gate goes red until somebody promotes it out of
 * the manifest. That is the design.
 *
 * ## What is real here, and the one thing that is not
 *
 * Real: the HTTP write path, `ConversationService`, the per-lane queue,
 * `SylAgent`, whatever `bootstrap` hands the commander lane, the MCP server as
 * a spawned process speaking real MCP over stdio, the tool, its HTTP client,
 * the agent credential, the route, `ReminderService`, and a real SQLite file.
 *
 * Substituted: **the model, and only the model.** A test may not spend a
 * subscription turn and may not depend on what a language model decides, so the
 * turn runner here is a stand-in that does the one thing a model does and
 * nothing else — it looks at the tools it was given and calls one. It is
 * deliberately stupid: all it knows is the phrase the Commander used ("in five
 * minutes"), the errand, and his configured zone. If `create_reminder`'s schema
 * demands something that cannot be produced from those, this test fails and
 * names the field — which is `T006`'s "JSON schemas the model can actually
 * satisfy" as an executable requirement rather than an aspiration.
 *
 * Everything between "he sent a message" and "a row exists" is therefore the
 * real thing, which is the only arrangement in which the assertion means what
 * it says.
 */

/** His zone, read the way the service reads it, so this is not a Chicago test. */
const HIS_ZONE = loadQuietHours(process.env).tz;

/** When he asks. On the minute, because a stored wall time has minute resolution. */
const HE_ASKS = Date.UTC(2026, 7, 10, 12, 0, 0, 0);

/** Five minutes later, as an instant — which is zone-independent, unlike a wall time. */
const FIVE_MINUTES_LATER = new Date(HE_ASKS + 5 * 60_000).toISOString();

const THE_ERRAND = "Take the bread out of the oven.";
const WHAT_HE_SAID = `Remind me in five minutes to ${THE_ERRAND.toLowerCase()}`;

/** The tool `T006` names. Its name is a contract, not a guess. */
const CREATE_REMINDER = "create_reminder";

/** How long the MCP handshake gets before this test says so itself. */
const MCP_TIMEOUT_MS = 10_000;

// --------------------------------------------------------------------------
// A very small MCP client. Enough to be a client, and no more.
// --------------------------------------------------------------------------

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface McpToolDescription {
  readonly name: string;
  readonly inputSchema?: {
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

/** One MCP server, spoken to over stdio the way Claude Code speaks to it. */
class McpServerProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (response: JsonRpcResponse) => void>();
  #buffer = "";
  #nextId = 1;
  #stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf("\n");
        if (line === "") continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // a server logging to stdout is not our business here
        }
        if (message.id === undefined) continue;
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      }
    });
  }

  static start(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): McpServerProcess {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new McpServerProcess(child);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const settled = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `the MCP server did not answer ${method} within ${String(MCP_TIMEOUT_MS)}ms. ` +
              `stderr: ${this.#stderr.trim()}`,
          ),
        );
      }, MCP_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await settled;
    if (response.error !== undefined) {
      throw new Error(`the MCP server refused ${method}: ${response.error.message ?? "no reason"}`);
    }
    return response.result;
  }

  notify(method: string, params: unknown): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  stop(): void {
    this.#child.kill();
  }
}

// --------------------------------------------------------------------------
// What a model knows, and nothing else.
// --------------------------------------------------------------------------

/** Fields that carry the errand itself. */
const ERRAND_KEYS = ["text", "title", "body", "what", "task", "message", "reminder"];
/** Fields that take the phrase the Commander used, uninterpreted. */
const HUMAN_TIME_KEYS = ["when", "whenText", "whenPhrase", "humanTime", "naturalTime", "phrase", "time", "at"];
/** Fields that take an IANA zone. Never an offset — non-negotiable constraint 5. */
const ZONE_KEYS = ["tz", "timezone", "timeZone", "zone"];
/** Fields that take an already-resolved instant, if the tool will not take the phrase. */
const RESOLVED_TIME_KEYS = ["wallTime", "date"];

/** `{ date, wallTime }` for an instant, as the wall clock in `zone` reads it. */
function wallTimeIn(zone: string, instant: number): { date: string; wallTime: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    wallTime: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * Arguments for `create_reminder`, assembled from the tool's own schema.
 *
 * Read from the schema rather than hard-coded because the schema is `syl-009`'s
 * to design and this test must not pre-empt its field names. What this test
 * *does* insist on is that every required field can be answered from what a
 * model actually has: the errand, the phrase, and his zone.
 */
function argumentsAModelCouldProduce(
  tool: McpToolDescription,
  zone: string,
  fiveMinutesLater: number,
): Record<string, unknown> {
  const properties = Object.keys(tool.inputSchema?.properties ?? {});
  const required = tool.inputSchema?.required ?? [];
  const resolved = wallTimeIn(zone, fiveMinutesLater);

  const known = new Map<string, unknown>([
    ...ERRAND_KEYS.map((key) => [key, THE_ERRAND] as const),
    ...HUMAN_TIME_KEYS.map((key) => [key, "in five minutes"] as const),
    ...ZONE_KEYS.map((key) => [key, zone] as const),
    ["wallTime", resolved.wallTime] as const,
    ["date", resolved.date] as const,
    ["kind", "commitment"] as const,
    ["urgent", false] as const,
  ]);

  // If the tool will take the phrase, give it the phrase: resolving human time
  // is `tools/time.ts`'s job and the whole reason it exists. Only when there is
  // nowhere to put the phrase does the stand-in supply an instant instead.
  const takesThePhrase = properties.some((property) => HUMAN_TIME_KEYS.includes(property));

  const args: Record<string, unknown> = {};
  const unanswerable: string[] = [];

  for (const property of new Set([...properties, ...required])) {
    const value = known.get(property);
    if (value === undefined) {
      if (required.includes(property)) unanswerable.push(property);
      continue;
    }
    if (takesThePhrase && RESOLVED_TIME_KEYS.includes(property)) continue;
    const worthSending =
      required.includes(property) ||
      ERRAND_KEYS.includes(property) ||
      HUMAN_TIME_KEYS.includes(property) ||
      ZONE_KEYS.includes(property) ||
      RESOLVED_TIME_KEYS.includes(property);
    if (worthSending) args[property] = value;
  }

  if (unanswerable.length > 0) {
    throw new Error(
      `${CREATE_REMINDER} requires ${unanswerable.join(", ")}, and nothing in ` +
        `"remind me in five minutes" supplies it. A schema a model cannot satisfy from ` +
        `what the Commander said is a tool she cannot use (T006). Either the tool should ` +
        `not require it, or this test's vocabulary should learn the field name.`,
    );
  }
  return args;
}

// --------------------------------------------------------------------------
// The stand-in model.
// --------------------------------------------------------------------------

/** What the stand-in saw and did, so the test can say why it failed. */
interface Hands {
  mcpConfig: string | null;
  advertised: readonly string[];
  called: { readonly name: string; readonly args: Record<string, unknown> } | null;
  failure: string | null;
}

/** Spawn every server the config names, and call `create_reminder` on the one that has it. */
async function useHerTools(configPath: string, hands: Hands): Promise<string> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<
      string,
      { command: string; args?: readonly string[]; env?: Record<string, string> }
    >;
  };
  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length === 0) {
    throw new Error(`the MCP config at ${configPath} names no servers, so she was given no tools.`);
  }

  const advertised: string[] = [];
  for (const [name, server] of servers) {
    const process_ = McpServerProcess.start(server.command, server.args ?? [], server.env ?? {});
    try {
      await process_.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "syl-us6-acceptance", version: "0" },
      });
      process_.notify("notifications/initialized", {});

      const listed = (await process_.request("tools/list", {})) as {
        tools?: readonly McpToolDescription[];
      };
      const tools = listed.tools ?? [];
      advertised.push(...tools.map((tool) => `${name}:${tool.name}`));
      hands.advertised = [...advertised];

      const create = tools.find((tool) => tool.name === CREATE_REMINDER);
      if (create === undefined) continue;

      const args = argumentsAModelCouldProduce(create, HIS_ZONE, HE_ASKS + 5 * 60_000);
      hands.called = { name: CREATE_REMINDER, args };
      const called = (await process_.request("tools/call", {
        name: CREATE_REMINDER,
        arguments: args,
      })) as { isError?: boolean; content?: readonly { text?: string }[] };

      const said = (called.content ?? []).map((block) => block.text ?? "").join("\n");
      if (called.isError === true) {
        throw new Error(`${CREATE_REMINDER} failed: ${said}`);
      }
      return said;
    } finally {
      process_.stop();
    }
  }

  throw new Error(
    `no server in ${configPath} offers ${CREATE_REMINDER}. Advertised: ` +
      `${advertised.length === 0 ? "nothing" : advertised.join(", ")}.`,
  );
}

/**
 * A model that has hands and uses them.
 *
 * The one substitution in this test. It stands in for the model's *judgement* —
 * "he is asking for a reminder, so call the tool that makes one" — and for
 * nothing else: the tools it reaches are the ones the running service handed
 * this turn, spoken to over real MCP.
 */
function aModelThatUsesHerTools(hands: Hands): TurnRunner {
  return async (_prompt, options): Promise<TurnResult> => {
    const sessionId = options.resume ?? options.sessionId ?? "us6-session";
    options.onSessionId?.(sessionId);

    const events: SylEvent[] = [];
    let text: string;

    try {
      if (options.mcpConfig === undefined) {
        throw new Error(
          "the commander lane's turn carried no MCP config, so this turn had no way to " +
            "do anything but talk. That is syl-act1 exactly: text, and no action.",
        );
      }
      hands.mcpConfig = options.mcpConfig;
      const said = await useHerTools(options.mcpConfig, hands);
      // `turn.tool` is the record of what she did on his machine (US3), and it
      // only exists if the harness sees the call.
      events.push({
        kind: "tool_use",
        sessionId,
        raw: {},
        name: CREATE_REMINDER,
        input: hands.called?.args ?? {},
      });
      text = `Done — ${said}`;
    } catch (error) {
      // Recorded rather than thrown, so the assertion below can say WHY the
      // reminder is missing instead of only that it is.
      hands.failure = error instanceof Error ? error.message : String(error);
      text = `I could not: ${hands.failure}`;
    }

    return {
      sessionId,
      text,
      costUsd: 0,
      numTurns: 1,
      init: {
        kind: "init",
        sessionId,
        raw: {},
        model: "stand-in",
        apiKeySource: "none",
        mcpServers: [],
        tools: [CREATE_REMINDER],
        capabilities: [],
        autoMemoryPath: undefined,
      },
      events,
    };
  };
}

// --------------------------------------------------------------------------

describe("US6 — she can act", () => {
  let syl: LiveService | null = null;

  afterEach(async () => {
    await syl?.close();
    syl = null;
  });

  it("should turn 'remind me in five minutes' into a stored reminder five minutes from now", async () => {
    const hands: Hands = { mcpConfig: null, advertised: [], called: null, failure: null };
    // Frozen, so "five minutes from now" is a statement about the reminder
    // rather than about the second the suite happened to run.
    syl = await startLiveService({
      clock: fixedClock(HE_ASKS),
      runner: aModelThatUsesHerTools(hands),
    });

    await expectData(
      await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          clientId: "syl:message:00000000-0000-7000-8000-0000000060a1",
          text: WHAT_HE_SAID,
        }),
      }),
    );
    // The turn runs behind the response, never inside it. `idle` is the seam's
    // own answer to "is she finished".
    await syl.deps.chat.idle();

    // Asserted first so a failure says what went wrong rather than only that
    // the store is empty. Every one of these is correct behaviour: the
    // commander lane gets the tools (US4), and `create_reminder` is among them.
    expect(hands.failure, `she could not act: ${hands.failure ?? ""}`).toBeNull();
    expect(hands.mcpConfig).not.toBeNull();
    expect(hands.advertised.join(", ")).toContain(CREATE_REMINDER);

    // And the thing that actually matters. Confirmed FROM THE STORE, over the
    // same API his phone reads — not from her intention, and not from what she
    // said she did.
    const stored = await expectData<{ items: Reminder[] }>(await syl.api("/reminders"));
    expect(stored.items).toHaveLength(1);

    const reminder = stored.items[0];
    expect(reminder?.text.toLowerCase()).toContain("bread");
    // Five minutes after he asked, to the millisecond. This is the sentence the
    // whole epic is judged on.
    expect(reminder?.nextFireAt).toBe(FIVE_MINUTES_LATER);
    // An IANA zone naming a place, never a fixed offset — non-negotiable
    // constraint 5, at the exact point a human phrase becomes stored time.
    expect(reminder?.tz).toBe(HIS_ZONE);
    expect(reminder?.tz).toContain("/");
  });
});
