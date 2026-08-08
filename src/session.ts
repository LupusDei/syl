import { spawn } from "node:child_process";

import { resolveClaudeBinFromProcess } from "./claude-bin.js";

import {
  assertSubscriptionAuth,
  buildUserFrame,
  createLineDecoder,
  parseEvent,
  type InitEvent,
  type SylEvent,
} from "./protocol.js";

/**
 * Runs a single conversational turn against Claude Code.
 *
 * ## Why one process per turn
 *
 * Measured behaviour on Claude Code 2.1.226: in `-p` (print) mode with
 * `--input-format stream-json`, the CLI does not finish a turn until stdin
 * reaches EOF. Holding the pipe open to send a second message simply stalls —
 * verified by holding stdin open for 25s and watching the turn complete only
 * on close.
 *
 * So a turn is: spawn, send one prompt, close stdin, read to completion.
 * Continuity across turns comes from `--resume <sessionId>`, using Claude
 * Code's own session store rather than a process we have to keep alive.
 *
 * That trade lands well for an assistant: there is no daemon to supervise, a
 * crash costs at most one turn, and a heartbeat is just another turn.
 */
export interface TurnOptions {
  /** Working directory for the agent. Defaults to the current process cwd. */
  readonly cwd?: string;
  /** Model id, e.g. "claude-haiku-4-5". Omit to use the CLI default. */
  readonly model?: string;
  /** Standing orders appended to the system prompt (Syl's soul). */
  readonly systemPrompt?: string;
  /** Path to an MCP config JSON file. Plugin MCP servers load regardless. */
  readonly mcpConfig?: string;
  /** Prior session id, to continue an existing conversation. */
  readonly resume?: string;
  /** Override the `claude` binary path. */
  readonly claudeBin?: string;
  /**
   * Claude Code permission mode. Defaults to `bypassPermissions`.
   *
   * The CLI default requires interactive approval, and in `-p` mode there is
   * nobody to approve — so every MCP call is denied and the assistant burns
   * turns discovering it cannot act. Unattended means pre-authorised.
   */
  readonly permissionMode?: string;
  /**
   * Ignore ambient MCP configuration and use only `mcpConfig`. Defaults to true
   * when `mcpConfig` is set.
   *
   * Without it the session inherits every MCP server the user happens to have
   * configured, and the model burns dozens of turns searching a tool surface
   * it does not need.
   */
  readonly strictMcpConfig?: boolean;
  /**
   * Fail fast if the CLI resolved an API key instead of the claude.ai login.
   * Defaults to true — this harness exists to stay on subscription rails.
   */
  readonly requireSubscriptionAuth?: boolean;
  /** Called for every decoded event as it arrives. */
  readonly onEvent?: (event: SylEvent) => void;
}

export interface TurnResult {
  /** Session id to feed back as `resume` on the next turn. */
  readonly sessionId: string;
  /** The assistant's final text for this turn. */
  readonly text: string;
  /** Reported cost. On subscription rails this is an estimate, not a charge. */
  readonly costUsd: number;
  readonly numTurns: number;
  readonly init: InitEvent;
  readonly events: readonly SylEvent[];
}

/** Contract for a turn runner, so callers can substitute a fake in tests. */
export type TurnRunner = (prompt: string, options: TurnOptions) => Promise<TurnResult>;

export async function runTurn(prompt: string, options: TurnOptions = {}): Promise<TurnResult> {
  const frame = buildUserFrame(prompt); // validates before spawning anything

  // Anthropic's credential precedence puts a set API key ahead of the
  // claude.ai login unconditionally, so a stale key silently reroutes billing
  // to the metered API. Strip both (adj-t64m9).
  const env = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];

  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (options.model) args.push("--model", options.model);
  if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
  if (options.mcpConfig) args.push("--mcp-config", options.mcpConfig);
  if (options.mcpConfig && options.strictMcpConfig !== false) args.push("--strict-mcp-config");
  args.push("--permission-mode", options.permissionMode ?? "bypassPermissions");
  if (options.resume) args.push("--resume", options.resume);

  const claudeBin = options.claudeBin ?? resolveClaudeBinFromProcess();
  const child = spawn(claudeBin, args, {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const events: SylEvent[] = [];
  let init: InitEvent | undefined;
  let apiError: Error | undefined;
  let stderr = "";

  const decode = createLineDecoder();
  child.stdout.on("data", (chunk: string) => {
    for (const line of decode(chunk)) {
      const event = parseEvent(line);
      if (!event) continue;
      events.push(event);
      options.onEvent?.(event);

      if (event.kind === "init") {
        init = event;
        if (options.requireSubscriptionAuth !== false) {
          try {
            assertSubscriptionAuth(event);
          } catch (error) {
            apiError = error as Error;
            child.kill();
          }
        }
      }

      // An api_error arrives shaped like a normal assistant message. Capture it
      // so the turn rejects instead of relaying a failure as if it were an answer.
      if (event.kind === "api_error") {
        apiError = new Error(
          `Claude API error${event.errorType ? ` (${event.errorType})` : ""}: ${event.message}`,
        );
      }
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // The turn only completes on stdin EOF — see the note above.
  child.stdin.write(frame);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  if (apiError) throw apiError;
  if (!init) {
    throw new Error(
      `claude exited with code ${exitCode ?? "null"} before the init handshake. stderr: ${stderr.trim()}`,
    );
  }

  const result = events.find((event) => event.kind === "result");
  if (!result || result.kind !== "result") {
    throw new Error(`claude produced no result event (exit ${exitCode ?? "null"}). stderr: ${stderr.trim()}`);
  }
  if (result.isError) {
    throw new Error(`Claude turn failed: ${result.result || stderr.trim() || "unknown error"}`);
  }

  return {
    sessionId: init.sessionId,
    text: result.result,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    init,
    events,
  };
}
