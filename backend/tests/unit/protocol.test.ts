import { describe, it, expect } from "vitest";

import {
  buildUserFrame,
  createLineDecoder,
  parseEvent,
  type ApiErrorEvent,
  type AssistantTextEvent,
  type InitEvent,
  type ResultEvent,
  type ToolUseEvent,
} from "../../src/harness/protocol.js";

/**
 * Fixtures below are trimmed from REAL `claude -p --output-format stream-json`
 * output captured on Claude Code 2.1.226 (see adj-itvob). Per Constitution
 * Rule 1 these are real wire shapes, not hand-written from the TS types —
 * the whole point is to catch drift between our types and the actual CLI.
 */

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/private/tmp",
  session_id: "4e5d6382-ceb3-43ef-bb7e-64bc149f7591",
  tools: ["Task", "Bash", "Read"],
  mcp_servers: [
    { name: "plugin:adjutant-agent:adjutant", status: "connected" },
    { name: "plugin:vercel:vercel", status: "needs-auth" },
  ],
  model: "claude-haiku-4-5",
  permissionMode: "default",
  apiKeySource: "none",
  claude_code_version: "2.1.226",
  capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"],
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_01",
    model: "claude-haiku-4-5",
    role: "assistant",
    type: "message",
    content: [{ type: "text", text: "PONG" }],
    usage: { input_tokens: 4, output_tokens: 2 },
  },
  parent_tool_use_id: null,
  session_id: "4e5d6382",
  uuid: "af696f0d",
});

const ASSISTANT_TOOL_USE_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_02",
    role: "assistant",
    type: "message",
    content: [
      { type: "text", text: "Checking the calendar." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/tmp/a.md" } },
    ],
  },
  session_id: "4e5d6382",
});

/** The real billing failure observed during the spike — it arrives as ASSISTANT
 * text with an `error` field, so naive parsers surface it as a normal reply. */
const API_ERROR_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "f13bd7fc",
    model: "<synthetic>",
    role: "assistant",
    type: "message",
    content: [{ type: "text", text: "Credit balance is too low" }],
  },
  session_id: "4e5d6382",
  error: "billing_error",
  is_api_error_message: true,
});

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 272,
  num_turns: 1,
  session_id: "4e5d6382",
  total_cost_usd: 0.0197421,
  usage: { input_tokens: 4, output_tokens: 2 },
  result: "PONG",
});

const HOOK_LINE = JSON.stringify({
  type: "system",
  subtype: "hook_started",
  hook_name: "SessionStart:startup",
  session_id: "4e5d6382",
});

describe("parseEvent", () => {
  it("should map a system/init line to an init event exposing session, model and auth source", () => {
    const event = parseEvent(INIT_LINE) as InitEvent;
    expect(event.kind).toBe("init");
    expect(event.sessionId).toBe("4e5d6382-ceb3-43ef-bb7e-64bc149f7591");
    expect(event.model).toBe("claude-haiku-4-5");
    expect(event.apiKeySource).toBe("none");
    expect(event.capabilities).toContain("msg_lifecycle_v1");
  });

  it("should expose the auto-memory directory the CLI actually resolved", () => {
    // `memory_paths.auto` is the only evidence that a requested memory
    // directory was honoured: the CLI discards one it does not like and falls
    // back to its own default with no warning and no non-zero exit.
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-opus-5",
      apiKeySource: "none",
      memory_paths: { auto: "/srv/syl/memory/" },
    });

    expect((parseEvent(line) as InitEvent).autoMemoryPath).toBe("/srv/syl/memory/");
  });

  it("should report no auto-memory directory when the init frame carries none", () => {
    // Verified on 2.1.226: `autoMemoryEnabled:false` removes the whole
    // `memory_paths` key rather than emptying it.
    expect((parseEvent(INIT_LINE) as InitEvent).autoMemoryPath).toBeUndefined();
  });

  it("should expose connected MCP servers from init so the caller can verify the Adjutant bridge", () => {
    const event = parseEvent(INIT_LINE) as InitEvent;
    expect(event.mcpServers).toEqual([
      { name: "plugin:adjutant-agent:adjutant", status: "connected" },
      { name: "plugin:vercel:vercel", status: "needs-auth" },
    ]);
  });

  it("should concatenate assistant text blocks into a single text event", () => {
    const event = parseEvent(ASSISTANT_TEXT_LINE) as AssistantTextEvent;
    expect(event.kind).toBe("assistant_text");
    expect(event.text).toBe("PONG");
  });

  it("should emit a tool_use event when the assistant calls a tool", () => {
    const event = parseEvent(ASSISTANT_TOOL_USE_LINE) as ToolUseEvent;
    expect(event.kind).toBe("tool_use");
    expect(event.name).toBe("Read");
    expect(event.input).toEqual({ file_path: "/tmp/a.md" });
  });

  it("should classify an api-error assistant message as api_error, NOT as assistant text", () => {
    // Regression guard: this exact payload ("Credit balance is too low") looks
    // like an ordinary reply. Treating it as one would let a billing/auth
    // failure be delivered to the user as if Syl had answered.
    const event = parseEvent(API_ERROR_LINE) as ApiErrorEvent;
    expect(event.kind).toBe("api_error");
    expect(event.errorType).toBe("billing_error");
    expect(event.message).toBe("Credit balance is too low");
  });

  it("should map a result line to a result event carrying cost and error state", () => {
    const event = parseEvent(RESULT_LINE) as ResultEvent;
    expect(event.kind).toBe("result");
    expect(event.isError).toBe(false);
    expect(event.costUsd).toBeCloseTo(0.0197421);
    expect(event.numTurns).toBe(1);
    expect(event.result).toBe("PONG");
  });

  it("should classify hook chatter as a hook event so callers can filter the noise", () => {
    const event = parseEvent(HOOK_LINE);
    expect(event?.kind).toBe("hook");
  });

  it("should return null for blank lines and non-JSON noise rather than throwing", () => {
    expect(parseEvent("")).toBeNull();
    expect(parseEvent("   ")).toBeNull();
    expect(parseEvent("⚠ claude.ai connectors are disabled")).toBeNull();
    expect(parseEvent("{not json")).toBeNull();
  });

  it("should surface an unrecognized message type as unknown instead of dropping it silently", () => {
    const event = parseEvent(JSON.stringify({ type: "future_thing", session_id: "s1" }));
    expect(event?.kind).toBe("unknown");
  });
});

describe("createLineDecoder", () => {
  it("should return complete lines from a single chunk containing several", () => {
    const decode = createLineDecoder();
    const lines = decode(`${HOOK_LINE}\n${RESULT_LINE}\n`);
    expect(lines).toHaveLength(2);
  });

  it("should reassemble a JSON object split across chunk boundaries", () => {
    // The failure this guards against: stdout chunks do not align to newlines,
    // so a naive `chunk.split("\n")` corrupts long init payloads intermittently.
    const decode = createLineDecoder();
    const mid = Math.floor(INIT_LINE.length / 2);
    expect(decode(INIT_LINE.slice(0, mid))).toEqual([]);
    const lines = decode(`${INIT_LINE.slice(mid)}\n`);
    expect(lines).toHaveLength(1);
    expect(parseEvent(lines[0]!)?.kind).toBe("init");
  });

  it("should hold a trailing partial line until its newline arrives", () => {
    const decode = createLineDecoder();
    expect(decode(`${HOOK_LINE}\n{"type":"resu`)).toHaveLength(1);
    expect(decode('lt","is_error":false,"session_id":"s"}\n')).toHaveLength(1);
  });

  it("should skip empty lines produced by consecutive newlines", () => {
    const decode = createLineDecoder();
    expect(decode(`${HOOK_LINE}\n\n\n`)).toEqual([HOOK_LINE]);
  });
});

describe("buildUserFrame", () => {
  it("should produce a newline-terminated user message the CLI accepts on stdin", () => {
    const frame = buildUserFrame("Reply with exactly: PONG");
    expect(frame.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(frame) as {
      type: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content[0]).toEqual({ type: "text", text: "Reply with exactly: PONG" });
  });

  it("should escape newlines and quotes so multi-line prompts stay on one wire line", () => {
    const frame = buildUserFrame('line one\nline "two"');
    expect(frame.split("\n")).toHaveLength(2); // body + trailing newline only
    const parsed = JSON.parse(frame) as {
      message: { content: Array<{ text: string }> };
    };
    expect(parsed.message.content[0]?.text).toBe('line one\nline "two"');
  });

  it("should reject an empty prompt rather than sending a turn the model cannot answer", () => {
    expect(() => buildUserFrame("   ")).toThrow(/empty/i);
  });
});
