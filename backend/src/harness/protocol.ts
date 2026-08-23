/**
 * Codec for Claude Code's `--output-format stream-json` wire protocol.
 *
 * This module is deliberately free of I/O. `session.ts` owns the subprocess;
 * this owns the bytes. Keeping the split means the wire format — where the
 * genuinely subtle bugs live (chunk boundaries, error messages disguised as
 * replies) — is unit-testable without spawning anything.
 *
 * Shapes here were derived from real CLI output on Claude Code 2.1.226, not
 * from documentation. Treat the `raw` field on every event as the source of
 * truth when the CLI adds fields we do not model yet.
 */

/** A parsed line from the CLI's stdout. */
export type SylEvent =
  | InitEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ApiErrorEvent
  | ResultEvent
  | HookEvent
  | UnknownEvent;

interface BaseEvent {
  /** Session this event belongs to. Empty string if the CLI omitted it. */
  readonly sessionId: string;
  /** The undecoded object, so callers can reach fields we do not model. */
  readonly raw: unknown;
}

/** Handshake. The CLI emits exactly one of these per session, first. */
export interface InitEvent extends BaseEvent {
  readonly kind: "init";
  readonly model: string;
  /**
   * Which credential the CLI resolved. `"none"` means it fell back to the
   * claude.ai login (subscription rails); `"ANTHROPIC_API_KEY"` means an env
   * var shadowed it. See `assertSubscriptionAuth`.
   */
  readonly apiKeySource: string;
  readonly mcpServers: ReadonlyArray<{ name: string; status: string }>;
  readonly tools: readonly string[];
  readonly capabilities: readonly string[];
  /**
   * The auto-memory directory the CLI actually resolved (`memory_paths.auto`),
   * or `undefined` when auto-memory is off for this session.
   *
   * This is the field that makes a redirected memory directory *verifiable*.
   * The CLI silently discards an `autoMemoryDirectory` it does not like and
   * falls back to `~/.claude/projects/<sanitised-cwd>/memory/` with no warning
   * and no exit code, so the request going out is not evidence of anything —
   * this is. See `memory/auto-memory.ts`.
   */
  readonly autoMemoryPath: string | undefined;
}

/** Assistant prose intended for the user. */
export interface AssistantTextEvent extends BaseEvent {
  readonly kind: "assistant_text";
  readonly text: string;
}

/** The assistant invoked a tool. */
export interface ToolUseEvent extends BaseEvent {
  readonly kind: "tool_use";
  readonly name: string;
  readonly input: unknown;
}

/**
 * An API/billing/auth failure. These arrive shaped like ordinary assistant
 * messages and are only distinguishable by an `error` field, so they must be
 * separated here — otherwise a failure is delivered to the user as an answer.
 */
export interface ApiErrorEvent extends BaseEvent {
  readonly kind: "api_error";
  readonly message: string;
  readonly errorType: string | undefined;
}

/** Terminal event for a turn. */
export interface ResultEvent extends BaseEvent {
  readonly kind: "result";
  readonly isError: boolean;
  readonly result: string;
  readonly costUsd: number;
  readonly numTurns: number;
  /**
   * Everything the turn had to replay — fresh input, cache reads and cache
   * writes added together.
   *
   * The three are summed because they are one quantity for the only question
   * anyone asks of this number: **how big is this conversation now**. Which
   * third it landed in is a caching detail that moves between turns of the same
   * size (a cache miss on his lane is the same 861,739 tokens as the hit before
   * it, and cost 29,852ms instead of 7,789ms), so reading any one of them alone
   * makes the same thread look like three different threads.
   *
   * `0` when the CLI reported no usage at all. Callers must read that as "not
   * stated" and never as "empty" — see `LaneContextSizes.record`.
   */
  readonly contextTokens: number;
}

/** SessionStart hook chatter. Usually noise; surfaced so callers may log it. */
export interface HookEvent extends BaseEvent {
  readonly kind: "hook";
  readonly subtype: string;
}

/** A message type this codec does not model yet. Never dropped silently. */
export interface UnknownEvent extends BaseEvent {
  readonly kind: "unknown";
  readonly type: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How much context a turn replayed, from the CLI's own `usage` block.
 *
 * Summed rather than picked apart; see {@link ResultEvent.contextTokens}. A
 * missing or malformed `usage` yields `0`, which every caller is required to
 * read as "not stated" — `harness/compaction.ts` refuses to act on it, which is
 * the safe direction for a decision worth 104 seconds of his lane.
 */
function contextTokensOf(usage: unknown): number {
  if (!isObject(usage)) return 0;
  return (
    num(usage["input_tokens"]) +
    num(usage["cache_read_input_tokens"]) +
    num(usage["cache_creation_input_tokens"])
  );
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Parse one line of CLI stdout into a typed event.
 *
 * Returns `null` for blank lines and non-JSON noise — the CLI writes human
 * warnings (e.g. the connectors notice) to the same stream, and those must not
 * crash the reader.
 */
export function parseEvent(line: string): SylEvent | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;

  const sessionId = str(raw["session_id"]);
  const type = str(raw["type"]);

  if (type === "system") {
    const subtype = str(raw["subtype"]);
    if (subtype === "init") {
      const servers = Array.isArray(raw["mcp_servers"]) ? raw["mcp_servers"] : [];
      const memoryPaths = isObject(raw["memory_paths"]) ? raw["memory_paths"] : {};
      const autoMemoryPath = memoryPaths["auto"];
      return {
        kind: "init",
        sessionId,
        raw,
        model: str(raw["model"]),
        apiKeySource: str(raw["apiKeySource"]),
        tools: strArray(raw["tools"]),
        capabilities: strArray(raw["capabilities"]),
        autoMemoryPath: typeof autoMemoryPath === "string" ? autoMemoryPath : undefined,
        mcpServers: servers.filter(isObject).map((s) => ({
          name: str(s["name"]),
          status: str(s["status"]),
        })),
      };
    }
    return { kind: "hook", sessionId, raw, subtype };
  }

  if (type === "assistant") {
    const message = isObject(raw["message"]) ? raw["message"] : {};
    const blocks = Array.isArray(message["content"]) ? message["content"] : [];

    const text = blocks
      .filter(isObject)
      .filter((b) => b["type"] === "text")
      .map((b) => str(b["text"]))
      .join("");

    // Checked BEFORE returning text: an api-error message carries ordinary
    // text blocks, so order matters. See the regression test.
    if (raw["is_api_error_message"] === true || typeof raw["error"] === "string") {
      return {
        kind: "api_error",
        sessionId,
        raw,
        message: text,
        errorType: typeof raw["error"] === "string" ? raw["error"] : undefined,
      };
    }

    const toolUse = blocks.filter(isObject).find((b) => b["type"] === "tool_use");
    if (toolUse) {
      return {
        kind: "tool_use",
        sessionId,
        raw,
        name: str(toolUse["name"]),
        input: toolUse["input"],
      };
    }

    return { kind: "assistant_text", sessionId, raw, text };
  }

  if (type === "result") {
    return {
      kind: "result",
      sessionId,
      raw,
      isError: raw["is_error"] === true,
      result: str(raw["result"]),
      costUsd: num(raw["total_cost_usd"]),
      numTurns: num(raw["num_turns"]),
      contextTokens: contextTokensOf(raw["usage"]),
    };
  }

  return { kind: "unknown", sessionId, raw, type };
}

/**
 * Create a stateful decoder that turns arbitrary stdout chunks into complete
 * lines.
 *
 * Process stdout does not respect line boundaries — a single JSON object
 * routinely spans two `data` events. Splitting each chunk independently
 * corrupts long payloads (the init frame especially) intermittently, which is
 * exactly the kind of bug that only shows up under load.
 */
export function createLineDecoder(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const parts = buffer.split("\n");
    // The final element is either "" (chunk ended on a newline) or a partial
    // line; either way it stays buffered for the next chunk.
    buffer = parts.pop() ?? "";
    return parts.filter((line) => line.trim() !== "");
  };
}

/**
 * Build a user-message frame for the CLI's `--input-format stream-json` stdin.
 *
 * `JSON.stringify` escapes embedded newlines, which is what keeps a multi-line
 * prompt on a single wire line.
 */
export function buildUserFrame(text: string): string {
  if (text.trim() === "") {
    throw new Error("buildUserFrame: refusing to send an empty prompt");
  }
  const frame = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Guard that the session resolved to subscription credentials.
 *
 * A set `ANTHROPIC_API_KEY` always outranks the claude.ai login, so a stale key
 * silently reroutes billing to the API — the failure mode recorded in
 * adj-t64m9. Callers that require subscription rails should assert this on the
 * init event rather than discovering it in a billing statement.
 */
export function assertSubscriptionAuth(init: InitEvent): void {
  if (init.apiKeySource !== "none") {
    throw new Error(
      `Syl requires subscription auth but Claude Code resolved credentials from ` +
        `"${init.apiKeySource}". Unset that variable so the claude.ai login is used.`,
    );
  }
}

/**
 * Everything the assistant actually said this turn, in order.
 *
 * **The `result` field is the FINAL assistant message, not the whole answer**, and
 * that distinction was invisible until Syl grew hands. A turn with no tool call
 * emits one block of prose and `result` is identical to it. A turn that reaches
 * for a tool emits prose, then `tool_use`, then more prose — and `result` carries
 * only the part after the tool.
 *
 * So the moment `syl-009` let her create a reminder mid-answer, her answers began
 * arriving with everything before the tool call missing. The Commander saw a long
 * reply reduced to its closing sentence, twice in one conversation, and the only
 * reason it was ever noticed is that Syl read her own transcript back and said so.
 * Nothing threw, nothing logged, and the message looked like a message.
 *
 * Joined with a blank line because these are separate assistant messages rather
 * than fragments of one — the model emitted them as distinct turns of speech, and
 * running them together would make one paragraph out of two thoughts.
 *
 * @param events every event decoded from the turn, in arrival order.
 * @param fallback the `result` string, used when a turn produced no prose at all —
 *   which is a real outcome, since "nothing to say" is one of Syl's standing orders.
 */
export function assembleReply(events: readonly SylEvent[], fallback: string): string {
  const spoken = events
    .filter((event): event is AssistantTextEvent => event.kind === "assistant_text")
    .map((event) => event.text.trim())
    .filter((text) => text !== "");

  return spoken.length === 0 ? fallback : spoken.join("\n\n");
}
