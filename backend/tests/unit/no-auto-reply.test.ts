import { describe, expect, it } from "vitest";

import type { AdjutantClient, OutboundMessage } from "../../src/agents/adjutant-client.js";
import {
  askBudget,
  ASK_BUDGET_WINDOW_MS,
  MAX_QUESTIONS_PER_AGENT_PER_WINDOW,
  MAX_QUESTIONS_PER_WINDOW,
  newCorrelationId,
  questionsSentTo,
  refLine,
} from "../../src/agents/answers.js";
import { SylApiClient } from "../../src/tools/client.js";
import { createToolServer, type ToolContext } from "../../src/tools/server.js";

/**
 * AN INBOUND MESSAGE MUST NEVER CAUSE AN UNBOUNDED CHAIN. `syl-014.3.5`.
 *
 * Two agents holding a conversation on the Commander's subscription is the
 * failure, and **CLAUDE.md constraint 1 is the strongest constraint here**:
 * subscription rails only, never the metered API.
 *
 * Theoretical until `syl-j8fa.5`. Nothing routed a peer's words into her turn,
 * so an inbound message could not cause an outbound one because inbound
 * messages did not arrive. The return leg closed that loop.
 *
 * ## What is deliberately NOT asserted
 *
 * That a reply cannot cause a message. **The follow-up question is the verb
 * working**: "What does his insurance cost?" / "Which policy?" / "The auto
 * one." A rule forbidding the second question delivers something that can hear
 * and may not speak twice, which is barely better than the megaphone this epic
 * started from.
 *
 * ## What bounds it, in order of how much work each does
 *
 * 1. **Her cadence.** Replies surface on her turns and her unattended turns are
 *    hourly, so a loop cannot run faster than one exchange an hour. The
 *    machine-speed runaway is not available, and no code here is what stops it.
 * 2. **The budget below**, which bounds the case her cadence does not touch at
 *    all: the burst inside a single turn.
 * 3. **The fence** (`agents/fencing.ts`), which bounds AUTHORITY rather than
 *    cost — nothing in a reply can give her an order.
 *
 * None of the three is a sentence in a prompt telling her not to. An
 * instruction is not an assertion, and this epic is about the difference.
 */

const NOW = Date.UTC(2026, 7, 13, 9, 0, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

/** A question she put to an agent, as Adjutant recorded it. */
function question(to: string, at: number): OutboundMessage {
  return {
    messageId: `out-${to}-${String(at)}`,
    to,
    body: `Something?\n\n${refLine(newCorrelationId())}`,
    at: iso(at),
  };
}

/** `count` questions to one agent, all inside the window. */
function questions(to: string, count: number): OutboundMessage[] {
  return Array.from({ length: count }, (_, i) => question(to, NOW - (i + 1) * 1_000));
}

/**
 * The same, against the wall clock.
 *
 * The handler reads `Date.now()` — the budget is a claim about the last hour of
 * real time, and there is no clock on `ToolContext` to inject. So the tests
 * that drive the VERB build their history relative to now, and the tests that
 * drive the pure functions pass an explicit instant and stay deterministic.
 * Freezing the wrong one of those would be a test that passes because it was
 * written today.
 */
function recentQuestions(to: string, count: number): OutboundMessage[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => question(to, now - (i + 1) * 1_000));
}

// ---------------------------------------------------------------------------
// Counting what actually left the machine
// ---------------------------------------------------------------------------

describe("questionsSentTo", () => {
  it("should count the questions she put to that agent inside the window", () => {
    expect(questionsSentTo("treasurer", [...questions("treasurer", 2), ...questions("raynor", 1)], NOW)).toBe(2);
  });

  it("should count every recipient when asked for the whole fleet", () => {
    expect(questionsSentTo(null, [...questions("treasurer", 2), ...questions("raynor", 1)], NOW)).toBe(3);
  });

  it("should not count questions older than the window", () => {
    const sent = [question("treasurer", NOW - ASK_BUDGET_WINDOW_MS - 1), question("treasurer", NOW - 1_000)];

    expect(questionsSentTo("treasurer", sent, NOW)).toBe(1);
  });

  it("should not count an ordinary message as a question", () => {
    // Only a message carrying a correlation id is a question. She may say
    // thank you to an agent without spending the budget for things she is owed
    // an answer to.
    const sent: OutboundMessage[] = [
      { messageId: "out-1", to: "treasurer", body: "Thanks.", at: iso(NOW - 1_000) },
      question("treasurer", NOW - 2_000),
    ];

    expect(questionsSentTo("treasurer", sent, NOW)).toBe(1);
  });

  it("should count a question whose timestamp it cannot read", () => {
    // The alternative is a budget with a hole that anything malformed falls
    // through, which is the shape of every guard this project has had to fix.
    const sent: OutboundMessage[] = [
      { messageId: "out-1", to: "treasurer", body: `?\n\n${refLine(newCorrelationId())}`, at: "not a date" },
    ];

    expect(questionsSentTo("treasurer", sent, NOW)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The ceiling, and what she is left holding when she reaches it
// ---------------------------------------------------------------------------

describe("askBudget", () => {
  it("should let a real exchange happen rather than stopping at the first follow-up", () => {
    // THE POINT OF THE NUMBER. Ask, be told something that raises a follow-up,
    // ask the follow-up. A ceiling that bit before this would have destroyed
    // the conversation it was meant to protect.
    for (let already = 0; already < MAX_QUESTIONS_PER_AGENT_PER_WINDOW; already += 1) {
      expect(askBudget("treasurer", questions("treasurer", already), NOW), `after ${String(already)}`).toBeNull();
    }
  });

  it("should stop her once she has asked one agent enough", () => {
    const reason = askBudget("treasurer", questions("treasurer", MAX_QUESTIONS_PER_AGENT_PER_WINDOW), NOW);

    expect(reason).not.toBeNull();
  });

  it("should surface to HIM rather than fail silently", () => {
    // The refusal IS the surfacing: it is what she has instead of another
    // message. A ceiling that produced a bare failure would look to her like a
    // broken verb and to him like nothing at all.
    const reason = askBudget("treasurer", questions("treasurer", MAX_QUESTIONS_PER_AGENT_PER_WINDOW), NOW) ?? "";

    expect(reason).toContain("treasurer");
    expect(reason).toMatch(/tell me|check with you|worth pressing/i);
    // And it says what did NOT happen, which is the sentence this project keeps
    // finding missing.
    expect(reason).toMatch(/have not asked/i);
  });

  it("should still let her reach a different agent when one agent's budget is spent", () => {
    // Per agent on purpose. What she has asked the treasurer says nothing about
    // whether raynor should hear from her.
    expect(askBudget("raynor", questions("treasurer", MAX_QUESTIONS_PER_AGENT_PER_WINDOW), NOW)).toBeNull();
  });

  it("should stop a burst that sprays the roster instead of pressing one agent", () => {
    // The per-agent cap alone does not bound this: five agents at three each is
    // fifteen messages out of a single turn, and every one of them is within
    // its own ceiling.
    const sprayed = [
      ...questions("treasurer", 2),
      ...questions("raynor", 2),
      ...questions("artanis", 2),
    ];
    expect(sprayed).toHaveLength(MAX_QUESTIONS_PER_WINDOW);

    expect(askBudget("tassadar", sprayed, NOW)).not.toBeNull();
  });

  it("should let her ask again once the window has passed", () => {
    // A ceiling that never releases is a capability removed rather than
    // bounded.
    const old = Array.from({ length: MAX_QUESTIONS_PER_WINDOW }, (_, i) =>
      question("treasurer", NOW - ASK_BUDGET_WINDOW_MS - (i + 1)),
    );

    expect(askBudget("treasurer", old, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

describe("ask_agent — a reply cannot start an unbounded chain", () => {
  interface Fleet {
    readonly asked: { who: string; body: string }[];
    readonly client: ToolContext["fleet"];
  }

  const fleet = (sent: readonly OutboundMessage[] = [], readFails = false): Fleet => {
    const asked: { who: string; body: string }[] = [];
    return {
      asked,
      client: {
        ask: async (who: string, body: string) => {
          asked.push({ who, body });
          return { ok: true as const, data: { messageId: "msg-1", at: iso(NOW) } };
        },
        sent: async () =>
          readFails
            ? {
                ok: false as const,
                failure: {
                  kind: "unreachable" as const,
                  operation: "read what she has asked",
                  message: "Adjutant is not answering.",
                  retryable: true,
                },
              }
            : { ok: true as const, data: sent },
      } as unknown as AdjutantClient,
    };
  };

  const context = (client: ToolContext["fleet"]): ToolContext => ({
    client: new SylApiClient({
      baseUrl: "http://127.0.0.1:8888/api/v1",
      token: "test-token",
      fetch: () => {
        throw new Error("ask_agent must not touch Syl's own API.");
      },
    }),
    tz: "America/Chicago",
    hisMessage: () => "",
    fleet: client,
  });

  const ask = async (ctx: ToolContext): Promise<Record<string, unknown>> => {
    const answered = await createToolServer(ctx).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_agent",
        arguments: {
          who: "treasurer",
          question: "Which policy did you mean?",
          because: "They asked me to be specific.",
        },
      },
    });
    const result = answered?.result as { content: { text: string }[] };
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  };

  it("should allow the follow-up question, which is the verb working", async () => {
    const { asked, client } = fleet(recentQuestions("treasurer", 1));

    const envelope = await ask(context(client));

    expect(envelope["ok"]).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("should refuse past the ceiling WITHOUT sending, and say so in her own words", async () => {
    const { asked, client } = fleet(recentQuestions("treasurer", MAX_QUESTIONS_PER_AGENT_PER_WINDOW));

    const envelope = await ask(context(client));

    expect(envelope["ok"]).toBe(false);
    expect(asked).toEqual([]);
    expect(String(envelope["reason"])).toMatch(/have not asked/i);
    // Not retryable: nothing the model does this turn changes the count, and a
    // model that retried would spend the turn discovering that.
    expect(envelope["retryable"]).toBe(false);
  });

  it("should fail CLOSED when it cannot read what she has already sent", async () => {
    // A spend guard that opens when its evidence is unavailable is not a guard,
    // and the thing on the other side of it is his subscription.
    const { asked, client } = fleet([], true);

    const envelope = await ask(context(client));

    expect(envelope["ok"]).toBe(false);
    expect(asked).toEqual([]);
  });

  it("should check the budget BEFORE anything leaves the process", async () => {
    // The roster is checked before the transport for the same reason. A guard
    // that fires after the send is a record of what happened, not a bound.
    const { asked, client } = fleet(recentQuestions("treasurer", MAX_QUESTIONS_PER_AGENT_PER_WINDOW));

    await ask(context(client));
    await ask(context(client));

    expect(asked).toEqual([]);
  });
});
