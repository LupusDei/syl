import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdjutantClient, OutboundMessage } from "../../src/agents/adjutant-client.js";
import {
  ASK_BUDGET_WINDOW_MS,
  MAX_QUESTIONS_PER_AGENT_PER_WINDOW,
  newCorrelationId,
  questionsSentTo,
  refLine,
} from "../../src/agents/answers.js";
import { readCommanderSpoke, turnGatePath, writeTurnFacts } from "../../src/tools/config.js";
import { SylApiClient } from "../../src/tools/client.js";
import { createToolServer, type ToolContext } from "../../src/tools/server.js";

/**
 * AN INBOUND MESSAGE MUST NEVER CAUSE AN OUTBOUND ONE. `syl-014.3.5`.
 *
 * Two agents holding a conversation on the Commander's subscription is the
 * failure, and **CLAUDE.md constraint 1 is the strongest constraint in the
 * project**: subscription rails only, never the metered API. The cost is not
 * bounded by politeness. An exchange that looks reasonable turn by turn can run
 * all night, and the first evidence is a bill or a rate limit rather than an
 * alert.
 *
 * This was theoretical until `syl-j8fa.5`. Nothing routed a peer's words into
 * her turn, so an inbound message could not cause an outbound one because
 * inbound messages did not arrive. The return leg closed that loop, so this is
 * the assertion that has to close it back.
 *
 * ## Two layers, and they fail differently
 *
 * **The gate** stops the LOOP: `ask_agent` refuses on any turn the Commander
 * did not himself speak on. A reply lands on an unattended turn and there is no
 * route from it to another message, so the cycle cannot turn once.
 *
 * **The budget** stops the BURST, which the gate does nothing about: one turn he
 * did start can call `ask_agent` fifty times, and the gate is per turn. It is
 * also what still holds if the gate is ever bypassed, because it is computed
 * from Adjutant's own record rather than from anything in this process.
 *
 * Neither is a sentence in a prompt telling her not to. An instruction is not
 * an assertion, and this epic is about the difference.
 */

const NOW = Date.UTC(2026, 7, 13, 9, 0, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "syl-gate-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The per-turn fact, and why it must be written on EVERY turn
// ---------------------------------------------------------------------------

describe("the turn gate", () => {
  it("should say he spoke on a turn carrying his words", () => {
    writeTurnFacts(home, "Ask the treasurer what the insurance costs.", true);

    expect(readCommanderSpoke(turnGatePath(home))).toBe(true);
  });

  it("should say he did NOT speak on an unattended turn", () => {
    writeTurnFacts(home, "It is 09:00. Anything to do?", false);

    expect(readCommanderSpoke(turnGatePath(home))).toBe(false);
  });

  it("should be rewritten on EVERY turn, so it can never go stale", () => {
    // THE DEFECT THIS ORDERING PREVENTS. `his-message.txt` is deliberately left
    // alone by an unattended turn — `harness/urgency.ts` wants whatever he last
    // actually said, and that is the safe direction there. Copying that
    // behaviour here would be the opposite of safe: the hourly turn would
    // inherit "he spoke" from a conversation an hour ago, and the loop this
    // file exists to break would run on every heartbeat.
    writeTurnFacts(home, "Ask the treasurer what the insurance costs.", true);
    expect(readCommanderSpoke(turnGatePath(home))).toBe(true);

    writeTurnFacts(home, "It is 10:00. Anything to do?", false);
    expect(readCommanderSpoke(turnGatePath(home))).toBe(false);
  });

  it("should still leave his own words alone on an unattended turn", () => {
    // The urgency seam's property, asserted here because this function is now
    // the one place that writes both files and could break it in passing.
    writeTurnFacts(home, "Wake me if the roof falls in.", true);
    writeTurnFacts(home, "It is 03:00. Anything to do?", false);

    expect(readCommanderSpoke(turnGatePath(home))).toBe(false);
  });

  it("should read a missing gate as 'he did not speak'", () => {
    // The safe direction, and the same default as every other read across this
    // seam. A tool server that cannot find the file must refuse rather than
    // assume the permissive case.
    expect(readCommanderSpoke(join(home, "nothing-here.json"))).toBe(false);
  });

  it("should read an unreadable or nonsense gate as 'he did not speak'", () => {
    const path = turnGatePath(home);
    writeTurnFacts(home, "anything", true);
    writeFileSync(path, "{ this is not json", "utf8");

    expect(readCommanderSpoke(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The budget, computed from Adjutant rather than from this process
// ---------------------------------------------------------------------------

describe("how many questions she may put to one agent", () => {
  const question = (to: string, at: number): OutboundMessage => ({
    messageId: `out-${String(at)}`,
    to,
    body: `Something?\n\n${refLine(newCorrelationId())}`,
    at: iso(at),
  });

  it("should count the questions she has put to that agent inside the window", () => {
    const sent = [
      question("treasurer", NOW - 60_000),
      question("treasurer", NOW - 120_000),
      question("raynor", NOW - 60_000),
    ];

    expect(questionsSentTo("treasurer", sent, NOW)).toBe(2);
  });

  it("should not count questions older than the window", () => {
    const sent = [
      question("treasurer", NOW - ASK_BUDGET_WINDOW_MS - 1),
      question("treasurer", NOW - 60_000),
    ];

    expect(questionsSentTo("treasurer", sent, NOW)).toBe(1);
  });

  it("should not count an ordinary message as a question", () => {
    // Only a message carrying a correlation id is a question. She is entitled
    // to say something to an agent without it counting against a budget for
    // things she is owed answers to.
    const sent: OutboundMessage[] = [
      { messageId: "out-1", to: "treasurer", body: "Thanks.", at: iso(NOW - 60_000) },
      question("treasurer", NOW - 30_000),
    ];

    expect(questionsSentTo("treasurer", sent, NOW)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The verb itself
// ---------------------------------------------------------------------------

describe("ask_agent cannot be reached by an inbound message", () => {
  interface Fleet {
    readonly asked: { who: string; body: string }[];
    readonly client: ToolContext["fleet"];
  }

  const fleet = (
    sent: readonly OutboundMessage[] = [],
    readFails = false,
  ): Fleet => {
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

  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    client: new SylApiClient({
      baseUrl: "http://127.0.0.1:8888/api/v1",
      token: "test-token",
      fetch: () => {
        throw new Error("ask_agent must not touch Syl's own API.");
      },
    }),
    tz: "America/Chicago",
    hisMessage: () => "",
    commanderSpoke: () => true,
    fleet: null,
    ...over,
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
          question: "What is he paying for health insurance?",
          because: "He asked me to find out.",
        },
      },
    });
    const result = answered?.result as { content: { text: string }[] };
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  };

  it("should refuse on a turn the Commander did not speak on, WITHOUT sending", async () => {
    // THE ASSERTION. A reply from another agent reaches her on an unattended
    // turn — that is the whole point of the return leg — and from that turn
    // there is no route to another outbound message. The cycle cannot turn
    // once.
    const { asked, client } = fleet();

    const envelope = await ask(context({ fleet: client, commanderSpoke: () => false }));

    expect(envelope["ok"]).toBe(false);
    expect(asked).toEqual([]);
  });

  it("should say WHY it refused, in something she can repeat to him", async () => {
    const { client } = fleet();

    const envelope = await ask(context({ fleet: client, commanderSpoke: () => false }));

    // She has to be able to turn this into a sentence. "Forbidden" is a shrug,
    // and a refusal she cannot explain is one he reads as a fault.
    expect(String(envelope["reason"])).toMatch(/ask|him|next time you talk|when he/i);
  });

  it("should ask when he is in the loop", async () => {
    const { asked, client } = fleet();

    const envelope = await ask(context({ fleet: client, commanderSpoke: () => true }));

    expect(envelope["ok"]).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("should refuse once she has spent the budget on that agent, even on his own turn", async () => {
    // THE BURST, which the gate does nothing about: one turn he DID start can
    // call this verb as many times as the model likes.
    const spent = Array.from({ length: MAX_QUESTIONS_PER_AGENT_PER_WINDOW }, (_, i) => ({
      messageId: `out-${String(i)}`,
      to: "treasurer",
      body: `Something?\n\n${refLine(newCorrelationId())}`,
      at: iso(NOW - 60_000),
    }));
    const { asked, client } = fleet(spent);

    const envelope = await ask(context({ fleet: client }));

    expect(envelope["ok"]).toBe(false);
    expect(asked).toEqual([]);
  });

  it("should still allow a different agent when one agent's budget is spent", async () => {
    // The budget is per agent on purpose. "She has asked the treasurer three
    // times this hour" says nothing about whether raynor should hear from her.
    const spent = Array.from({ length: MAX_QUESTIONS_PER_AGENT_PER_WINDOW }, (_, i) => ({
      messageId: `out-${String(i)}`,
      to: "raynor",
      body: `Something?\n\n${refLine(newCorrelationId())}`,
      at: iso(NOW - 60_000),
    }));
    const { asked, client } = fleet(spent);

    const envelope = await ask(context({ fleet: client }));

    expect(envelope["ok"]).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("should fail CLOSED when it cannot read what she has already sent", async () => {
    // A spend guard that opens when its evidence is unavailable is not a guard.
    // Adjutant being unreadable means the budget cannot be checked, and the
    // cost of guessing wrong is his subscription rather than one lost answer.
    const { asked, client } = fleet([], true);

    const envelope = await ask(context({ fleet: client }));

    expect(envelope["ok"]).toBe(false);
    expect(asked).toEqual([]);
  });
});
