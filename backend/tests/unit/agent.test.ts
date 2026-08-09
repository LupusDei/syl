import { describe, it, expect, vi } from "vitest";

import { SylAgent, type SessionStore } from "../../src/harness/agent.js";
import type { TurnOptions, TurnResult, TurnRunner } from "../../src/harness/session.js";

function fakeResult(sessionId: string, text = "ok"): TurnResult {
  return {
    sessionId,
    text,
    costUsd: 0.001,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId,
      raw: {},
      model: "claude-haiku-4-5",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
    },
    events: [],
  };
}

function memoryStore(initial?: string): SessionStore {
  let value = initial;
  return {
    read: () => value,
    write: (id) => {
      value = id;
    },
  };
}

/** Options passed to the Nth runner call, asserted to exist. */
function optionsOfCall(runner: ReturnType<typeof vi.fn<TurnRunner>>, index: number): TurnOptions {
  const call = runner.mock.calls[index];
  if (!call) throw new Error(`expected runner call #${index}`);
  return call[1];
}

describe("SylAgent", () => {
  it("should omit resume on the first turn when no session has been stored", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-1"));
    const agent = new SylAgent({ runner, store: memoryStore() });

    await agent.ask("hello");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(optionsOfCall(runner, 0).resume).toBeUndefined();
  });

  it("should resume the stored session on the next turn so context carries over", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-1"));
    const agent = new SylAgent({ runner, store: memoryStore() });

    await agent.ask("first");
    await agent.ask("second");

    expect(optionsOfCall(runner, 1).resume).toBe("sess-1");
  });

  it("should persist the session id so continuity survives a process restart", async () => {
    const store = memoryStore();
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-42"));

    await new SylAgent({ runner, store }).ask("first");
    // A brand-new agent instance stands in for a restarted process.
    await new SylAgent({ runner, store }).ask("second");

    expect(optionsOfCall(runner, 1).resume).toBe("sess-42");
  });

  it("should forward the soul as the system prompt on every turn", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("s"));
    const agent = new SylAgent({ runner, store: memoryStore(), soul: "be helpful" });

    await agent.ask("hi");

    expect(optionsOfCall(runner, 0).systemPrompt).toBe("be helpful");
  });

  it("should drop a stale session id when resuming fails, so a bad id cannot wedge the agent permanently", async () => {
    // Guards the failure where a session is expired or pruned: without this the
    // agent retries the same dead id forever and never speaks again.
    const runner = vi
      .fn<TurnRunner>()
      .mockRejectedValueOnce(new Error("No conversation found with session ID: dead"))
      .mockResolvedValueOnce(fakeResult("sess-new"));
    const agent = new SylAgent({ runner, store: memoryStore("dead") });

    const result = await agent.ask("hello");

    expect(runner).toHaveBeenCalledTimes(2);
    expect(optionsOfCall(runner, 0).resume).toBe("dead");
    expect(optionsOfCall(runner, 1).resume).toBeUndefined();
    expect(result.sessionId).toBe("sess-new");
  });

  it("should propagate a non-resume failure rather than silently starting a fresh session", async () => {
    // A billing or auth failure must surface. Retrying without resume would
    // hide it and burn a second turn for nothing.
    const runner = vi
      .fn<TurnRunner>()
      .mockRejectedValue(new Error("Claude API error (billing_error): Credit balance is too low"));
    const agent = new SylAgent({ runner, store: memoryStore("sess-1") });

    await expect(agent.ask("hello")).rejects.toThrow(/billing_error/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("should clear the stored session on reset so the next turn starts clean", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-2"));
    const agent = new SylAgent({ runner, store: memoryStore("sess-1") });

    agent.reset();
    await agent.ask("hi");

    expect(optionsOfCall(runner, 0).resume).toBeUndefined();
  });
});
