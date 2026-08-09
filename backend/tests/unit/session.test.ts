import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TURN_TIMEOUT_MS,
  TurnTimeoutError,
  newSessionId,
  runTurn,
  type TurnOptions,
} from "../../src/harness/session.js";
import type { SylEvent } from "../../src/harness/protocol.js";
import {
  flagValue,
  loadFixture,
  makeFakeClaude,
  type FakeClaude,
  type FakeClaudeConfig,
  type FakeClaudeInvocation,
} from "../helpers/fake-claude.js";

/**
 * `runTurn` is the subprocess driver — the one place in the harness where the
 * failure modes are process failure modes. These tests drive it against a real
 * child process (see `helpers/fake-claude.ts` for why) replaying transcripts
 * captured from Claude Code 2.1.226.
 */

const PONG = loadFixture("turn-pong");

/** Session id baked into the `turn-pong` capture. */
const PONG_SESSION = "14846aeb-eae5-47fe-80f2-61185042c969";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fakes: FakeClaude[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
});

/** A fake registered for cleanup. */
function fake(config: FakeClaudeConfig): FakeClaude {
  const created = makeFakeClaude(config);
  fakes.push(created);
  return created;
}

/** A fake that replays a whole captured transcript after stdin EOF. */
function replaying(lines: readonly string[], extra: FakeClaudeConfig = {}): FakeClaude {
  return fake({ after: lines, exitCode: 0, ...extra });
}

function invocationOf(f: FakeClaude): FakeClaudeInvocation {
  const invocation = f.invocation();
  if (!invocation) throw new Error("the fake claude binary was never spawned");
  return invocation;
}

/** Every test overrides the binary; nothing here may reach the real CLI. */
function options(f: FakeClaude, extra: TurnOptions = {}): TurnOptions {
  return { claudeBin: f.bin, ...extra };
}

describe("runTurn", () => {
  describe("a completed turn", () => {
    it("should return the assistant text, session id and cost from a real captured transcript", async () => {
      const f = replaying(PONG, { echoSessionId: false });

      const result = await runTurn("Reply with exactly: PONG", options(f));

      expect(result.text).toBe("PONG");
      expect(result.sessionId).toBe(PONG_SESSION);
      expect(result.costUsd).toBeCloseTo(0.0339971);
      expect(result.numTurns).toBe(1);
      expect(result.init.model).toBe("claude-haiku-4-5");
      expect(result.init.apiKeySource).toBe("none");
    });

    it("should send the prompt as a single user frame and close stdin, since the turn only ends on EOF", async () => {
      const f = replaying(PONG);

      await runTurn("line one\nline two", options(f));

      const { stdin } = invocationOf(f);
      // One line: JSON.stringify escapes the embedded newline. If it did not,
      // the CLI would see two malformed frames.
      expect(stdin.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdin)).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "line one\nline two" }] },
      });
    });

    it("should surface every decoded event to onEvent in arrival order", async () => {
      const f = replaying(PONG);
      const seen: SylEvent["kind"][] = [];

      const result = await runTurn("hi", options(f, { onEvent: (event) => seen.push(event.kind) }));

      expect(seen[0]).toBe("hook");
      expect(seen).toContain("init");
      expect(seen.at(-1)).toBe("result");
      expect(seen).toEqual(result.events.map((event) => event.kind));
    });

    it("should reassemble events split across chunk boundaries", async () => {
      // Process stdout does not respect line boundaries. 64-byte chunks split
      // the ~5KB init frame across roughly eighty `data` events.
      const f = replaying(PONG, { chunkChars: 64 });

      const result = await runTurn("hi", options(f));

      expect(result.text).toBe("PONG");
      expect(result.init.tools).toHaveLength(30);
    });
  });

  describe("billing safety", () => {
    it("should strip ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the child environment", async () => {
      // Non-negotiable constraint 3 (adj-t64m9): a set key outranks the
      // claude.ai login unconditionally and silently reroutes billing.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-reach-the-child");
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "should-not-reach-the-child");
      const f = replaying(PONG);

      try {
        await runTurn("hi", options(f));
        const invocation = invocationOf(f);
        expect(invocation.sawApiKey).toBe(false);
        expect(invocation.sawAuthToken).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should reject when the CLI resolved an API key instead of the claude.ai login", async () => {
      const f = replaying(withApiKeySource(PONG, "ANTHROPIC_API_KEY"));

      await expect(runTurn("hi", options(f))).rejects.toThrow(/subscription auth/i);
    });

    it("should allow an API-key session when the caller explicitly opts out of the guard", async () => {
      const f = replaying(withApiKeySource(PONG, "ANTHROPIC_API_KEY"));

      const result = await runTurn("hi", options(f, { requireSubscriptionAuth: false }));

      expect(result.init.apiKeySource).toBe("ANTHROPIC_API_KEY");
    });
  });

  describe("argv", () => {
    it("should always request stream-json in both directions with --verbose", async () => {
      // --verbose is mandatory alongside --output-format stream-json in -p mode;
      // the CLI errors out without it and the message is easy to miss.
      const f = replaying(PONG);

      await runTurn("hi", options(f));

      expect(invocationOf(f).argv.slice(0, 6)).toEqual([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ]);
    });

    it("should forward model, system prompt, mcp config and resume when given", async () => {
      const f = replaying(PONG);

      await runTurn(
        "hi",
        options(f, {
          model: "claude-haiku-4-5",
          systemPrompt: "be brief",
          mcpConfig: "/tmp/mcp.json",
          resume: "prior-session",
        }),
      );

      const { argv } = invocationOf(f);
      expect(flagValue(argv, "--model")).toBe("claude-haiku-4-5");
      expect(flagValue(argv, "--append-system-prompt")).toBe("be brief");
      expect(flagValue(argv, "--mcp-config")).toBe("/tmp/mcp.json");
      expect(flagValue(argv, "--resume")).toBe("prior-session");
      // Ambient MCP servers are excluded by default whenever we supply a config.
      expect(argv).toContain("--strict-mcp-config");
    });

    it("should omit every optional flag when no options are given", async () => {
      const f = replaying(PONG);

      await runTurn("hi", options(f));

      const { argv } = invocationOf(f);
      for (const flag of ["--model", "--append-system-prompt", "--mcp-config", "--resume", "--tools"]) {
        expect(argv).not.toContain(flag);
      }
    });

    it("should set the tool surface only when asked, and pass an empty one through intact", async () => {
      // `--tools ""` is a meaningful value, not an absent one. A falsiness check
      // anywhere on this path silently restores the full tool surface to a turn
      // that asked for none, which is the exact failure the reader guards against.
      const f = replaying(PONG);

      await runTurn("hi", options(f, { tools: "" }));

      expect(flagValue(invocationOf(f).argv, "--tools")).toBe("");
    });

    it("should not grant bypassPermissions unless the caller asks for it", async () => {
      // Correct for a headless turn nobody can approve, and dangerous the moment
      // untrusted text enters a prompt — so it must be an explicit decision at
      // the call site, never something a new caller inherits by accident.
      const f = replaying(PONG);

      await runTurn("hi", options(f));

      expect(invocationOf(f).argv).not.toContain("--permission-mode");
    });

    it("should pass a permission mode the caller chose explicitly", async () => {
      const f = replaying(PONG);

      await runTurn("hi", options(f, { permissionMode: "bypassPermissions" }));

      expect(flagValue(invocationOf(f).argv, "--permission-mode")).toBe("bypassPermissions");
    });

    it("should run in the requested working directory", async () => {
      const f = replaying(PONG);

      await runTurn("hi", options(f, { cwd: tmpRealPath() }));

      expect(invocationOf(f).cwd).toBe(tmpRealPath());
    });
  });

  describe("session id", () => {
    it("should settle the session id before spawning, so a crash cannot lose the conversation", async () => {
      // The window this closes: the CLI creates the session on disk, then the
      // process dies before emitting init. Learning the id from init means the
      // caller has nothing to resume and no way to find what was created.
      const f = fake({ exitCode: 1, stderr: "boom\n" });
      const announced: string[] = [];

      await runTurn("hi", options(f, { onSessionId: (id) => announced.push(id) })).catch(() => undefined);

      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatch(UUID);
      // Announced before the spawn — the id the child was given is the id the
      // caller already holds.
      expect(flagValue(invocationOf(f).argv, "--session-id")).toBe(announced[0]);
    });

    it("should create the conversation under a caller-supplied id", async () => {
      const f = replaying(PONG);
      const wanted = "11111111-2222-4333-8444-555555555555";

      const result = await runTurn("hi", options(f, { sessionId: wanted }));

      expect(flagValue(invocationOf(f).argv, "--session-id")).toBe(wanted);
      // Verified against Claude Code 2.1.226: the CLI honours --session-id
      // exactly and echoes it on both the init and result frames.
      expect(result.sessionId).toBe(wanted);
    });

    it("should mint a fresh uuid per turn when the caller supplies none", async () => {
      const first = replaying(PONG);
      const second = replaying(PONG);

      await runTurn("hi", options(first));
      await runTurn("hi", options(second));

      const a = flagValue(invocationOf(first).argv, "--session-id");
      const b = flagValue(invocationOf(second).argv, "--session-id");
      expect(a).toMatch(UUID);
      expect(b).toMatch(UUID);
      expect(a).not.toBe(b);
    });

    it("should resume rather than re-create when continuing an existing conversation", async () => {
      // --session-id creates; --resume continues. Sending both would ask the CLI
      // to create a session that already exists.
      const f = replaying(PONG);

      await runTurn("hi", options(f, { resume: "prior-session", sessionId: "ignored" }));

      const { argv } = invocationOf(f);
      expect(flagValue(argv, "--resume")).toBe("prior-session");
      expect(argv).not.toContain("--session-id");
    });

    it("should announce the resumed id too, so callers see one id per turn either way", async () => {
      const f = replaying(PONG);
      const announced: string[] = [];

      await runTurn("hi", options(f, { resume: "prior-session", onSessionId: (id) => announced.push(id) }));

      expect(announced).toEqual(["prior-session"]);
    });

    it("should produce ids the CLI will accept, which means real uuids", () => {
      // `--session-id <uuid>` is validated by the CLI; anything else is rejected
      // outright, and it would be rejected at spawn time rather than here.
      expect(newSessionId()).toMatch(UUID);
      expect(newSessionId()).not.toBe(newSessionId());
    });
  });

  describe("failures", () => {
    it("should reject an empty prompt before spawning anything", async () => {
      const f = replaying(PONG);

      await expect(runTurn("   ", options(f))).rejects.toThrow(/empty prompt/i);
      expect(f.invocation()).toBeUndefined();
    });

    it("should report the exit code and stderr when the CLI dies before the init handshake", async () => {
      const f = fake({ exitCode: 1, stderr: "error: --verbose is required\n" });

      await expect(runTurn("hi", options(f))).rejects.toThrow(
        /exited with code 1 before the init handshake.*--verbose is required/s,
      );
    });

    it("should reject when the CLI produced an init but no result event", async () => {
      const f = replaying(PONG.filter((line) => !line.includes('"type":"result"')));

      await expect(runTurn("hi", options(f))).rejects.toThrow(/no result event/i);
    });

    it("should reject rather than relay an api_error dressed up as an assistant reply", async () => {
      // Captured shape: an ordinary assistant message carrying an `error` field.
      // A naive reader hands the user a billing failure as though it were an answer.
      const apiError = JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_01",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Credit balance is too low" }],
        },
        is_api_error_message: true,
        error: "billing_error",
        session_id: PONG_SESSION,
      });
      const f = replaying(insertBeforeResult(PONG, apiError));

      await expect(runTurn("hi", options(f))).rejects.toThrow(/billing_error/);
    });

    it("should reject when the result event reports an error", async () => {
      const f = replaying(
        PONG.map((line) =>
          line.includes('"type":"result"')
            ? line.replace('"is_error":false', '"is_error":true').replace('"result":"PONG"', '"result":"turn aborted"')
            : line,
        ),
      );

      await expect(runTurn("hi", options(f))).rejects.toThrow(/turn aborted/);
    });

    it("should reject with a usable message when the binary does not exist", async () => {
      await expect(runTurn("hi", { claudeBin: "/nonexistent/claude" })).rejects.toThrow(/ENOENT/);
    });

    it("should survive a CLI that exits without ever reading stdin", async () => {
      // How the CLI behaves when it rejects its own arguments. The prompt then
      // lands on a closed pipe, and an unhandled EPIPE would take the whole
      // process down and bury the exit code that actually explains the failure.
      const f = fake({ ignoreStdin: true, exitCode: 2, stderr: "error: unknown option '--nope'\n" });

      await expect(runTurn("hi", options(f))).rejects.toThrow(/unknown option/);
    });
  });

  describe("timeout", () => {
    it("should kill a wedged CLI and reject with a TurnTimeoutError", async () => {
      // The failure this exists for: the CLI is alive, holding its pipes open,
      // and will never produce a result. Before this, the only kill path was the
      // auth guard, so the turn hung forever and took its caller with it.
      const f = fake({ hang: true });

      const error = await runTurn("hi", options(f, { timeoutMs: 150 })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurnTimeoutError);
      expect((error as TurnTimeoutError).timeoutMs).toBe(150);
      expect((error as Error).message).toMatch(/150 ?ms/);
    });

    it("should time out even after a healthy init, when the CLI wedges mid-turn", async () => {
      // Init arriving is not proof of progress. A turn can stall after the
      // handshake and there is no result event to wait for.
      const initLine = PONG.find((line) => line.includes('"subtype":"init"'));
      if (!initLine) throw new Error("fixture is missing its init line");
      const f = fake({ before: [initLine], hang: true });

      await expect(runTurn("hi", options(f, { timeoutMs: 150 }))).rejects.toBeInstanceOf(TurnTimeoutError);
    });

    it("should leave no orphaned child behind after a timeout", async () => {
      const f = fake({ hang: true });

      // Long enough for the child to boot and record its pid; the point here is
      // the kill, and a timeout that fires during node's startup proves nothing.
      //
      // This was 1_000, which is a wall-clock assumption about how fast node
      // starts — true on an idle machine and false under the full suite, where
      // dozens of processes compete. When startup lost that race the timeout
      // fired first, no pid was ever recorded, and the failure surfaced as
      // `expected undefined to be greater than 0`: not the kill misbehaving,
      // but the test never reaching the thing it was written to check.
      //
      // The comment above already named the hazard and then picked a number
      // that did not honour it. 5s is still a wall-clock guess, but it sits far
      // enough above worst-case startup under load to be one in name only, and
      // the suite-wide 20s test timeout leaves it room.
      await runTurn("hi", options(f, { timeoutMs: 5_000 })).catch(() => undefined);

      // The fake records its own pid; if the kill did not land it is still alive.
      const pid = invocationOf(f).pid;
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false);
      });
    });

    it("should not disturb a turn that finishes inside its window", async () => {
      const f = replaying(PONG, { exitDelayMs: 50 });

      const result = await runTurn("hi", options(f, { timeoutMs: 5_000 }));

      expect(result.text).toBe("PONG");
    });

    it("should treat a non-positive timeout as no timeout at all", async () => {
      // An explicit opt-out for a genuinely long turn. It must not degrade into
      // "times out immediately", which is how an off-by-one here would present.
      const f = replaying(PONG, { exitDelayMs: 50 });

      const result = await runTurn("hi", options(f, { timeoutMs: 0 }));

      expect(result.text).toBe("PONG");
    });

    it("should apply a default timeout generous enough for a real research turn", async () => {
      expect(DEFAULT_TURN_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
      expect(DEFAULT_TURN_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60_000);
    });
  });
});

/** Rewrite the captured init line's credential source. One field, real shape. */
function withApiKeySource(lines: readonly string[], source: string): string[] {
  return lines.map((line) =>
    line.includes('"subtype":"init"') ? line.replace('"apiKeySource":"none"', `"apiKeySource":"${source}"`) : line,
  );
}

function insertBeforeResult(lines: readonly string[], extra: string): string[] {
  const index = lines.findIndex((line) => line.includes('"type":"result"'));
  const copy = [...lines];
  copy.splice(index === -1 ? copy.length : index, 0, extra);
  return copy;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** macOS resolves /tmp through a symlink; the child reports the real path. */
function tmpRealPath(): string {
  return realpathSync(tmpdir());
}
