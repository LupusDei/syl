import { describe, expect, it } from "vitest";

import {
  AdjutantClient,
  adjutantTimeToIso,
  MCP_PROTOCOL_VERSION,
  parseMcpBody,
  READ_LIMIT_MAX,
  type AdjutantClientOptions,
  type InboundMessage,
} from "../../src/agents/adjutant-client.js";
import { fenceReplies, REPLY_FENCE_OPEN, type AgentReply } from "../../src/agents/fencing.js";
import type { InboundReply } from "../../src/agents/replies-seen.js";

/**
 * How Syl's SERVICE talks to Adjutant on her behalf.
 *
 * The defect this whole module exists to avoid: `POST /api/messages` stamps
 * **every** message `from: "user"`. Adjutant's own route logs a warning when a
 * non-user calls it — *"agent impersonating the Commander?"* — so a client
 * built the obvious way would have Syl asking the treasurer about the
 * Commander's money **in his voice**, and the treasurer answering as though he
 * had asked. It would poison his real message history too.
 *
 * So the load-bearing test in this file is not "a message was sent". It is
 * **the sender is `syl` and can never be `user`.**
 */

/** One recorded call, in the shape the assertions want to read it. */
interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** What a canned answer looks like before it becomes a `Response`. */
interface Canned {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly text: string;
}

/** An SSE frame the way Adjutant actually answers `/mcp`. */
function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The `initialize` answer, session header and all. Captured from 4201. */
function initializeAnswer(sessionId = "session-1"): Canned {
  return {
    headers: { "content-type": "text/event-stream", "mcp-session-id": sessionId },
    text: sse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "adjutant", version: "0.2.2" },
      },
    }),
  };
}

/** The 202 with an empty body that `notifications/initialized` produces. */
const acceptedAnswer: Canned = { status: 202, text: "" };

/** A `tools/call` answer wrapping whatever the messaging tool returned. */
function toolAnswer(payload: unknown, id = 2): Canned {
  return {
    headers: { "content-type": "text/event-stream" },
    text: sse({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    }),
  };
}

/**
 * What a `direct_message` that ARRIVED returns.
 *
 * `messageId`/`timestamp` are captured from 4201's `send_message`, which is the
 * same envelope. `deliveredToSessions` and `conversationId` are the two extra
 * fields, read off Adjutant's own `DirectMessageResult`
 * (`backend/src/services/direct-message-delivery.ts`) rather than invented here.
 *
 * The count is the whole point of the new tool: `send_message`'s DM branch
 * stored and broadcast and never injected, so every send Syl ever made came
 * back looking exactly like this one with nothing having arrived anywhere.
 */
const deliveredAnswer = toolAnswer({
  messageId: "dad93396-118f-4791-be99-46220f7fe9b5",
  timestamp: "2026-08-11 01:50:15",
  conversationId: "dm:syl:treasurer",
  deliveredToSessions: 1,
});

/**
 * The same envelope from an Adjutant that does not report `sessionsFound`.
 *
 * The zero is all there is here, and a zero on its own cannot say WHICH kind
 * of nothing happened. Kept as its own fixture because that older shape is a
 * case the client still has to answer for, not a historical curiosity.
 */
const undeliveredAnswer = toolAnswer({
  messageId: "dad93396-118f-4791-be99-46220f7fe9b5",
  timestamp: "2026-08-11 01:50:15",
  conversationId: "dm:syl:treasurer",
  deliveredToSessions: 0,
});

/**
 * Nothing delivered, and Adjutant holds no session record under that name.
 *
 * `sessionsFound` is the raw registry lookup, taken before any injection is
 * attempted. It counts SESSION RECORDS, and that is all it counts — an agent
 * managed outside the session bridge is up and has no record here, so a zero
 * does not mean the agent is down.
 */
const noRecordAnswer = toolAnswer({
  messageId: "dad93396-118f-4791-be99-46220f7fe9b5",
  timestamp: "2026-08-11 01:50:15",
  conversationId: "dm:syl:treasurer",
  deliveredToSessions: 0,
  sessionsFound: 0,
});

/**
 * Nothing delivered, and sessions WERE on record — nothing accepted it.
 *
 * A rejected `sendInput`, a dead pane, a bridge that went away between the
 * lookup and the write. And `registry.findByName` returns OFFLINE records
 * too, so this equally covers an agent that stopped without its record being
 * reaped. Neither reading may be asserted.
 */
const nothingAcceptedAnswer = toolAnswer({
  messageId: "dad93396-118f-4791-be99-46220f7fe9b5",
  timestamp: "2026-08-11 01:50:15",
  conversationId: "dm:syl:treasurer",
  deliveredToSessions: 0,
  sessionsFound: 2,
});

/** An Adjutant too old to have `direct_message`'s count in its answer. */
const countlessAnswer = toolAnswer({
  messageId: "dad93396-118f-4791-be99-46220f7fe9b5",
  timestamp: "2026-08-11 01:50:15",
});

/** Kept under its old name so the tests that only need "it worked" still read. */
const sentAnswer = deliveredAnswer;

/** The contract envelope `GET /api/messages` answers in. */
function messagesAnswer(items: readonly unknown[]): Canned {
  return {
    headers: { "content-type": "application/json" },
    text: JSON.stringify({
      success: true,
      data: { items, total: items.length, hasMore: false },
      timestamp: "2026-08-11T01:50:35.076Z",
    }),
  };
}

/** One row as Adjutant serialises it, trimmed to the fields we read. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    agentId: "treasurer",
    recipient: "syl",
    role: "agent",
    body: "His health insurance is $1,485 a month.",
    createdAt: "2026-08-11 01:50:15",
    ...over,
  };
}

/** A transport that answers from a script and remembers what it was asked. */
function scripted(answers: readonly (Canned | Error)[]): {
  readonly fetch: NonNullable<AdjutantClientOptions["fetch"]>;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let next = 0;
  return {
    calls,
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const answer = answers[next++];
      if (answer === undefined) throw new Error(`no scripted answer for call ${String(next)}: ${url}`);
      if (answer instanceof Error) throw answer;
      return new Response(answer.text === "" ? null : answer.text, {
        status: answer.status ?? 200,
        headers: answer.headers ?? {},
      });
    },
  };
}

const AT = Date.parse("2026-08-11T02:00:00.000Z");

function clientWith(
  answers: readonly (Canned | Error)[],
  over: Partial<AdjutantClientOptions> = {},
): { client: AdjutantClient; calls: Recorded[] } {
  const transport = scripted(answers);
  const client = new AdjutantClient({
    baseUrl: "http://127.0.0.1:4201",
    agentId: "syl",
    fetch: transport.fetch,
    clock: () => AT,
    ...over,
  });
  return { client, calls: transport.calls };
}

describe("who the message says it is from", () => {
  it("should refuse to be built as the Commander, whatever the spelling", () => {
    // The one identity that must be structurally unreachable. `POST
    // /api/messages` gives it away for free; this client must not be able to
    // claim it even when someone configures it to.
    for (const impostor of ["user", "USER", "  user  ", "User"]) {
      expect(
        () => new AdjutantClient({ baseUrl: "http://127.0.0.1:4201", agentId: impostor }),
        `agentId "${impostor}" was accepted`,
      ).toThrow(/user/iu);
    }
  });

  it("should refuse to be built with no identity at all", () => {
    // An empty agent id would hand the session to Adjutant's generated
    // fallback, and she would send as `unknown` — untraceable rather than
    // impersonating, which is a smaller failure and still not hers.
    expect(() => new AdjutantClient({ baseUrl: "http://127.0.0.1:4201", agentId: "   " })).toThrow(
      /identity/iu,
    );
  });

  it("should carry HER id on the handshake, which is where Adjutant reads it from", async () => {
    // Adjutant's `send_message` takes no sender field at all: it resolves the
    // agent from the MCP session (`getAgentBySession`), and the session is
    // bound to the `X-Agent-Id` presented at `initialize`. So the identity of
    // every message she ever sends is decided by this one header.
    const { client, calls } = clientWith([initializeAnswer(), acceptedAnswer, sentAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(true);
    const handshake = calls[0];
    expect(handshake?.url).toBe("http://127.0.0.1:4201/mcp");
    expect(handshake?.headers["x-agent-id"]).toBe("syl");
    expect((handshake?.body as { method?: string }).method).toBe("initialize");
  });

  it("should never call the route that stamps a message from the Commander", async () => {
    // `POST /api/messages` is the Commander's own send endpoint. Nothing here
    // may reach it — not as a fallback, not on a retry, not when the MCP
    // handshake fails. This asserts over EVERY call the client made.
    const { client, calls } = clientWith([initializeAnswer(), acceptedAnswer, sentAnswer]);

    await client.ask("treasurer", "What does his insurance cost?");

    for (const call of calls) {
      expect(
        call.method === "POST" && call.url.includes("/api/messages"),
        `${call.method} ${call.url} is the impersonating route`,
      ).toBe(false);
    }
  });

  it("should send arguments that contain no sender field to be wrong about", async () => {
    // Belt and braces: even if Adjutant grew a `from` argument, this client has
    // nothing to put in it. The wire payload is `to` and `body`, and the sender
    // lives in the session.
    const { client, calls } = clientWith([initializeAnswer(), acceptedAnswer, sentAnswer]);

    await client.ask("treasurer", "What does his insurance cost?");

    const call = calls[2]?.body as { params?: { name?: string; arguments?: Record<string, unknown> } };
    expect(call.params?.name).toBe("direct_message");
    expect(Object.keys(call.params?.arguments ?? {}).sort()).toEqual(["body", "to"]);
    expect(call.params?.arguments?.["to"]).toBe("treasurer");
  });
});

/**
 * `syl-j8fa.3` — the bug the Commander reported, at its root.
 *
 * `ask_agent` accepted a message, returned an id, and nothing arrived. Two ids
 * she reported as successful (`77e6f10a…`, `149f1b91…`) exist on her side and
 * on nobody else's. The cause, measured in Adjutant's source: `send_message`'s
 * DM branch persists, broadcasts, emits a timeline event — and never injects
 * into the recipient's live session. It cannot fail, so it always succeeded.
 *
 * The severity was never the outage. It is that from her side the failure was
 * INVISIBLE, so she told him a thing was delivered when a row had been written.
 * A verb that cannot fail is the defect this project has catalogued repeatedly.
 *
 * So the load-bearing test in this section is not "the count comes back". It is
 * **a count of zero is not a success**. If that can pass while `ask` returns
 * `ok: true`, nothing has been fixed.
 */
describe("whether anybody actually received it", () => {
  it("should call the tool that DELIVERS, not the one that only stores", async () => {
    // `send_message` is left exactly as it is, so no other agent's behaviour
    // changes; `direct_message` is the new tool that injects and awaits.
    const { client, calls } = clientWith([initializeAnswer(), acceptedAnswer, deliveredAnswer]);

    await client.ask("treasurer", "What does his insurance cost?");

    const call = calls[2]?.body as { params?: { name?: string } };
    expect(call.params?.name).toBe("direct_message");
    expect(call.params?.name).not.toBe("send_message");
  });

  it("should carry how many live sessions it reached, so she can say so", async () => {
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, deliveredAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.deliveredToSessions).toBe(1);
      expect(result.data.messageId).toBe("dad93396-118f-4791-be99-46220f7fe9b5");
    }
  });

  it("should NOT call a message that reached nobody a success", async () => {
    // THE regression test for `syl-5kdv`. A stubbed transport that returns
    // `deliveredToSessions: 0` must not produce `ok: true` — with or without a
    // message id in the payload, which is exactly what she was shown before.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
  });

  it("should tell nobody-was-listening apart from the-fleet-is-unreachable", async () => {
    // Two different facts, and she says a different sentence for each: one is
    // "Adjutant is down", the other is "that agent is not running". Collapsing
    // them would have her telling him to check the wrong thing.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);
    const { client: down } = clientWith([new TypeError("fetch failed")]);

    const quiet = await client.ask("treasurer", "What does his insurance cost?");
    const unreachable = await down.ask("treasurer", "What does his insurance cost?");

    expect(quiet.ok).toBe(false);
    expect(unreachable.ok).toBe(false);
    if (!quiet.ok && !unreachable.ok) {
      expect(quiet.failure.kind).toBe("undelivered");
      expect(unreachable.failure.kind).toBe("unreachable");
      expect(quiet.failure.kind).not.toBe(unreachable.failure.kind);
    }
  });

  it("should say the message was recorded, since that much is true", async () => {
    // The honest half. It IS persisted — a reply has somewhere to land — and
    // saying so is what stops "it failed" from being its own overclaim.
    // Adjutant persists before it injects, so this holds even when the send
    // rejects, the pane is dead, or the session bridge was never initialised.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toMatch(/recorded/iu);
      expect(result.failure.message).toContain("treasurer");
      // Never the word she must not use for something that did not arrive.
      expect(result.failure.message).not.toMatch(/\bsent\b/iu);
    }
  });

  it("should not claim the agent exists, nor that it does not", async () => {
    // A zero cannot yet tell "that agent is not started" from "there is no
    // agent by that name" — Adjutant returns the same 0 for both, and
    // `sessionsFound` to separate them has been asked for and not yet built.
    //
    // Those are different sentences to the Commander: one is a typo she should
    // correct, the other is a fact he might act on. So until the field exists
    // the sentence must be true under BOTH readings, which means naming both
    // and committing to neither. Asserting either one is a coin-flip she would
    // state as fact — the same failure as the bug this bead is fixing, moved
    // from delivery to identity.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const said = result.failure.message;
      // Without the count there is nothing to say beyond what happened to the
      // message. Naming candidate explanations here — "either not started, or
      // no such agent" — reads as a diagnosis and rules out the cases it did
      // not think of, which is the same over-claim in a more helpful-looking
      // costume. So it reports the gap itself.
      expect(said).toMatch(/does not report/iu);
      expect(said).toMatch(/cannot tell|can't tell|no way to tell/iu);
      expect(said).toMatch(/nobody has read it/iu);
    }
  });

  it("should treat a MISSING count as an error, never as a zero and never as a success", async () => {
    // An Adjutant too old to have the tool must surface loudly. Reading the
    // absent field as `0` would be a lie in the safe direction and reading it
    // as success would restore the original bug in full.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, countlessAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed");
      expect(result.failure.kind).not.toBe("undelivered");
    }
  });

  it("should refuse a count that is not a whole number of sessions", async () => {
    // A string "1", a null, a boolean, a fraction, a negative. `> 0` cannot be
    // asked of a value that is not a number, and `Number("1") > 0` is the
    // coercion that would quietly let a wrong shape through.
    for (const bad of ["1", null, true, 1.5, -1]) {
      const { client } = clientWith([
        initializeAnswer(),
        acceptedAnswer,
        toolAnswer({ messageId: "m-1", timestamp: "2026-08-11 01:50:15", deliveredToSessions: bad }),
      ]);

      const result = await client.ask("treasurer", "Anything.");

      expect(result.ok, `deliveredToSessions ${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("malformed");
    }
  });

  it("should carry which kind of nothing it was, when Adjutant says", async () => {
    // `sessionsFound` is the registry lookup before any injection, and it
    // counts SESSION RECORDS. The number rides on the failure so the verb
    // above can pick its sentence without asking again.
    const { client: away } = clientWith([initializeAnswer(), acceptedAnswer, noRecordAnswer]);
    const { client: broken } = clientWith([initializeAnswer(), acceptedAnswer, nothingAcceptedAnswer]);

    const stopped = await away.ask("treasurer", "What does his insurance cost?");
    const failed = await broken.ask("treasurer", "What does his insurance cost?");

    expect(stopped.ok).toBe(false);
    expect(failed.ok).toBe(false);
    if (!stopped.ok && !failed.ok) {
      expect(stopped.failure.kind).toBe("undelivered");
      expect(failed.failure.kind).toBe("undelivered");
      expect(stopped.failure.sessionsFound).toBe(0);
      expect(failed.failure.sessionsFound).toBe(2);
    }
  });

  it("should say what Adjutant HOLDS when it holds no session record", async () => {
    // A zero here does not mean the agent is down either. An agent managed
    // outside the session bridge — a plain tmux agent on the roster — is up
    // and has no record. So this sentence is about the record and about what
    // became of the message, and says nothing about the agent.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, noRecordAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("treasurer");
      expect(result.failure.message).toMatch(/recorded/iu);
      expect(result.failure.message).toMatch(/no session on record|holds no session/iu);
      // Retrying now cannot help: nothing has anywhere to arrive.
      expect(result.failure.message).toMatch(/will not help|has to change/iu);
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("should say what Adjutant HOLDS when nothing accepted the message", async () => {
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, nothingAcceptedAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toMatch(/recorded/iu);
      expect(result.failure.message).toMatch(/on record/iu);
      // Retrying later is reasonable: something to receive it is on record.
      expect(result.failure.message).toMatch(/again|retry/iu);
      expect(result.failure.retryable).toBe(true);
    }
  });

  it("should never tell him an agent is up or down on the strength of this number", async () => {
    // `sessionsFound` describes SESSION RECORDS. It entails nothing about the
    // agent, in EITHER direction, and both gaps are real:
    //
    //   above 0 — `registry.findByName` returns offline records too (Adjutant's
    //             own image path filters `status !== "offline"` off the same
    //             call, which is the evidence). So this is equally "up and its
    //             session refused it" and "stopped, record not yet reaped".
    //   zero    — an agent managed outside the session bridge, a plain tmux
    //             agent on the roster, is up and has no record at all.
    //
    // So the assertion is symmetric and applies to every branch. Checking only
    // that a sentence avoids "stopped" would pass one that is equally wrong
    // the other way, which is how this inference keeps being made: three times
    // in one day a count has been read as meaning slightly more than it knows.
    // The sentence must REFUSE the inference explicitly, not merely dodge the
    // word — hence the last assertion.
    for (const answer of [noRecordAnswer, nothingAcceptedAnswer, undeliveredAnswer]) {
      const { client } = clientWith([initializeAnswer(), acceptedAnswer, answer]);

      const result = await client.ask("treasurer", "Anything.");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const said = result.failure.message;
        expect(said, "must not claim the agent is stopped").not.toMatch(
          /not running|not started|stopped|is away|offline|is down/iu,
        );
        expect(said, "must not claim the agent is running").not.toMatch(
          /\brunning\b|\bis up\b|\bare up\b|\blive\b|\bawake\b/iu,
        );
        expect(said, "must refuse the inference out loud").toMatch(
          /says nothing about|cannot tell|can't tell|no way to tell/iu,
        );
      }
    }
  });

  it("should say two DIFFERENT things about the two kinds of nothing", async () => {
    // The assertion that carries the weight, and it matters MORE after all the
    // stripping-out above: once neither sentence may diagnose the agent, the
    // risk is that they collapse into the same hedge and stop being worth two
    // branches. What still separates them is the NEXT ACTION — retrying later
    // is reasonable when something is on record to receive it, and futile when
    // nothing is, because something has to change first.
    //
    // Two sentences that each contain the right words and are identical to
    // each other would pass every per-phrase check while telling him nothing:
    // the same shape of hole as asserting on a boolean instead of on the text.
    const { client: away } = clientWith([initializeAnswer(), acceptedAnswer, noRecordAnswer]);
    const { client: broken } = clientWith([initializeAnswer(), acceptedAnswer, nothingAcceptedAnswer]);
    const { client: older } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);

    const stopped = await away.ask("treasurer", "Anything.");
    const failed = await broken.ask("treasurer", "Anything.");
    const unknown = await older.ask("treasurer", "Anything.");

    expect(stopped.ok).toBe(false);
    expect(failed.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!stopped.ok && !failed.ok && !unknown.ok) {
      const said = [stopped.failure.message, failed.failure.message, unknown.failure.message];
      expect(new Set(said).size, `three cases, ${String(new Set(said).size)} distinct sentences`).toBe(3);
      // And retryability follows what he can DO, not a diagnosis: only the
      // case with something on record to receive it is worth another attempt.
      expect(stopped.failure.retryable).toBe(false);
      expect(failed.failure.retryable).toBe(true);
      expect(unknown.failure.retryable).toBe(false);
    }
  });

  it("should fall back rather than guess when sessionsFound is absent", async () => {
    // An older Adjutant. Degrading to the sentence that names both readings is
    // correct here — unlike a missing DELIVERY count, a missing
    // `sessionsFound` costs only precision in a failure already being
    // reported, not the difference between arrived and vanished.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("undelivered");
      expect(result.failure.sessionsFound).toBeUndefined();
      expect(result.failure.message).toMatch(/cannot tell|can't tell|no way to tell/iu);
    }
  });

  it("should not fail the whole report over an unreadable sessionsFound", async () => {
    // THE ASYMMETRY, deliberately kept. A missing or unreadable
    // `deliveredToSessions` is `malformed`, because acting on its absence
    // means guessing whether anybody received it. An unreadable
    // `sessionsFound` only blunts a sentence that is already reporting a
    // failure, so it degrades instead of escalating. They must not behave the
    // same way.
    for (const bad of ["2", null, true, 1.5, -1]) {
      const { client } = clientWith([
        initializeAnswer(),
        acceptedAnswer,
        toolAnswer({
          messageId: "m-1",
          timestamp: "2026-08-11 01:50:15",
          deliveredToSessions: 0,
          sessionsFound: bad,
        }),
      ]);

      const result = await client.ask("treasurer", "Anything.");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind, `sessionsFound ${JSON.stringify(bad)} escalated`).toBe("undelivered");
        expect(result.failure.sessionsFound).toBeUndefined();
        expect(result.failure.message).toMatch(/cannot tell|can't tell|no way to tell/iu);
      }
    }
  });

  it("should keep every undelivered sentence free of an id and of the word sent", async () => {
    // Across all three cases at once, so a new branch cannot quietly reopen
    // either hole. `syl-5kdv` is the Commander holding two ids offered as
    // proof of arrival.
    for (const answer of [noRecordAnswer, nothingAcceptedAnswer, undeliveredAnswer]) {
      const { client } = clientWith([initializeAnswer(), acceptedAnswer, answer]);

      const result = await client.ask("treasurer", "Anything.");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.message).not.toMatch(/\bsent\b/iu);
        expect(result.failure.message).not.toContain("dad93396-118f-4791-be99-46220f7fe9b5");
      }
    }
  });

  it("should not let a message id alone stand for delivery", async () => {
    // The exact shape of the original defect: a real id, a real timestamp, and
    // nothing having arrived. The id proves a row, not a reader.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, undeliveredAnswer]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).not.toContain("dad93396-118f-4791-be99-46220f7fe9b5");
    }
  });
});

describe("the handshake", () => {
  it("should keep the session Adjutant handed back and present it on every call", async () => {
    // A `tools/list` without one answers `{"error":"Missing Mcp-Session-Id
    // header"}` — the session IS the identity, so losing it is losing her name.
    const { client, calls } = clientWith([
      initializeAnswer("session-abc"),
      acceptedAnswer,
      sentAnswer,
    ]);

    await client.ask("treasurer", "What does his insurance cost?");

    expect(calls[1]?.headers["mcp-session-id"]).toBe("session-abc");
    expect((calls[1]?.body as { method?: string }).method).toBe("notifications/initialized");
    expect(calls[2]?.headers["mcp-session-id"]).toBe("session-abc");
  });

  it("should handshake once and reuse it, rather than per message", async () => {
    // Three calls for the first ask, one for the second. A handshake per
    // message would mint a session per message, and Adjutant keeps them.
    const { client, calls } = clientWith([
      initializeAnswer(),
      acceptedAnswer,
      sentAnswer,
      toolAnswer({ messageId: "second", timestamp: "2026-08-11 01:51:00" }, 3),
    ]);

    await client.ask("treasurer", "First.");
    await client.ask("treasurer", "Second.");

    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => (call.body as { method?: string }).method === "initialize")).toHaveLength(1);
  });

  it("should shake hands again when Adjutant has forgotten the session", async () => {
    // Adjutant restarts. The session id we hold is now unknown, and every send
    // would fail forever — she would go quiet without anything being broken.
    const { client, calls } = clientWith([
      initializeAnswer("stale"),
      acceptedAnswer,
      { status: 400, headers: { "content-type": "application/json" }, text: JSON.stringify({ error: "Missing Mcp-Session-Id header" }) },
      initializeAnswer("fresh"),
      acceptedAnswer,
      toolAnswer(
        { messageId: "after-restart", timestamp: "2026-08-11 01:52:00", deliveredToSessions: 1 },
        4,
      ),
    ]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.messageId).toBe("after-restart");
    expect(calls.at(-1)?.headers["mcp-session-id"]).toBe("fresh");
  });

  it("should give up rather than loop when the second handshake fails too", async () => {
    // One retry, not a retry loop. Adjutant being down is a thing she says out
    // loud, not a thing she hammers.
    const { client, calls } = clientWith([
      initializeAnswer("stale"),
      acceptedAnswer,
      { status: 400, headers: { "content-type": "application/json" }, text: JSON.stringify({ error: "Missing Mcp-Session-Id header" }) },
      initializeAnswer("fresh"),
      acceptedAnswer,
      { status: 400, headers: { "content-type": "application/json" }, text: JSON.stringify({ error: "Missing Mcp-Session-Id header" }) },
    ]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(6);
  });

  it("should refuse to proceed when the handshake returns no session at all", async () => {
    // A 200 with no `mcp-session-id` is something that is not Adjutant
    // answering — a proxy, or a route that does not exist. Sending anyway would
    // send anonymously.
    const { client } = clientWith([
      { headers: { "content-type": "text/event-stream" }, text: sse({ jsonrpc: "2.0", id: 1, result: {} }) },
    ]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed");
      expect(result.failure.message).toMatch(/session/iu);
    }
  });
});

describe("who she may reach", () => {
  it("should refuse an agent off the roster without touching the network", async () => {
    // The roster is the decision about who can influence her. A refusal that
    // still opened a connection would mean the list was advisory.
    const { client, calls } = clientWith([]);

    const result = await client.ask("nova", "Anything.");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("refused");
      // Names who she CAN ask, so she can turn it into a sentence for him.
      expect(result.failure.message).toContain("treasurer");
      expect(result.failure.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("should refuse to READ from an agent off the roster too", async () => {
    // Reading needs no identity, so nothing about the transport stops this.
    // The roster has to.
    const { client, calls } = clientWith([]);

    const result = await client.repliesFrom("nova");

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("should refuse to address the Commander as though he were an agent", async () => {
    // `to: "user"` is a legal Adjutant recipient and it is not hers to use:
    // talking to him is `ConversationService`, not the fleet.
    const { client, calls } = clientWith([]);

    const result = await client.ask("user", "Anything.");

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("when Adjutant does not answer", () => {
  it("should say she did not ask, rather than throwing", async () => {
    // A throw crosses back as a stack trace and reaches him as silence — or
    // worse, as her saying she asked because nothing told her she had not.
    const { client } = clientWith([new TypeError("fetch failed")]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("unreachable");
      expect(result.failure.message).toMatch(/did not/iu);
      expect(result.failure.retryable).toBe(true);
    }
  });

  it("should call a timeout a timeout, because the message may have landed", async () => {
    // Materially different from unreachable: an abandoned send may still have
    // reached the treasurer, and "I do not know whether I asked" is the honest
    // sentence.
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const { client } = clientWith([timeout]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("timed_out");
  });

  it("should treat an error inside the tool result as a refusal", async () => {
    // Adjutant answers `{"error":"Unknown session"}` with HTTP 200 and no
    // `isError` flag. Parsed carelessly, that reads as a successful send.
    const { client } = clientWith([
      initializeAnswer(),
      acceptedAnswer,
      toolAnswer({ error: "Unknown session" }),
    ]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain("Unknown session");
  });

  it("should not report a message id it never got", async () => {
    // A `tools/call` that succeeds but carries no `messageId` is not a send she
    // may claim. Constraint 4's instinct: never say a thing happened silently.
    const { client } = clientWith([initializeAnswer(), acceptedAnswer, toolAnswer({ ok: true })]);

    const result = await client.ask("treasurer", "What does his insurance cost?");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("malformed");
  });
});

describe("reading what came back", () => {
  it("should read over REST, which needs no identity — the asymmetry is deliberate", async () => {
    // MCP to send, REST to read. It looks like an inconsistency and is not:
    // sending must carry her name, reading must not carry anything at all.
    const { client, calls } = clientWith([messagesAnswer([row()])]);

    const result = await client.repliesFrom("treasurer");

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/api/messages?");
    expect(calls[0]?.url).toContain("agentId=treasurer");
  });

  it("should query the SENDER, not herself, because the filter is not what it looks like", async () => {
    // Adjutant's filter is
    //   `agent_id = ? OR (role = 'user' AND recipient = ?)`.
    // So `?agentId=syl` returns what SHE sent plus what the COMMANDER sent her,
    // and an agent's reply to her — role 'agent', recipient 'syl' — matches
    // NEITHER branch. Asking for her own id would poll a query that can never
    // contain a reply. Verified against a live 4201 on 2026-08-11.
    const { client, calls } = clientWith([messagesAnswer([row()])]);

    await client.repliesFrom("treasurer");

    expect(calls[0]?.url).not.toContain("agentId=syl");
  });

  it("should keep only what was addressed to her", async () => {
    // Querying the sender means the sender's whole recent feed arrives —
    // including everything they said to the Commander, which is not hers to
    // read and never leaves this function.
    const { client } = clientWith([
      messagesAnswer([
        row({ id: "to-him", recipient: "user", body: "Status report for the Commander." }),
        row({ id: "to-her" }),
        row({ id: "to-nobody", recipient: null, body: "Broadcast." }),
      ]),
    ]);

    const result = await client.repliesFrom("treasurer");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((reply) => reply.messageId)).toEqual(["to-her"]);
    }
  });

  it("should never hand back something she said herself", async () => {
    // Her own question sits in the same conversation. Read back as a reply, she
    // would answer herself — and `fencing.ts` would attribute her words to
    // somebody else.
    const { client } = clientWith([
      messagesAnswer([
        row({ id: "hers", agentId: "syl", recipient: "treasurer", body: "What does his insurance cost?" }),
        row({ id: "theirs" }),
      ]),
    ]);

    const result = await client.repliesFrom("treasurer");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((reply) => reply.messageId)).toEqual(["theirs"]);
  });

  it("should attribute a reply to its sender and stamp when she read it", async () => {
    const { client } = clientWith([messagesAnswer([row()])]);

    const result = await client.repliesFrom("treasurer");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const reply = result.data[0];
      expect(reply?.from).toBe("treasurer");
      expect(reply?.body).toBe("His health insurance is $1,485 a month.");
      // A UTC instant, not Adjutant's space-separated local-looking string.
      expect(reply?.at).toBe("2026-08-11T01:50:15.000Z");
    }
  });

  it("should hand back something both the cursor and the fence can take as it is", () => {
    // The field names are load-bearing: a poll goes straight into
    // `RepliesSeen.unseen` and straight into `fenceReplies`, and an adapter
    // between them would be a place for the message id to change meaning.
    const reply: InboundMessage = {
      messageId: "msg-1",
      from: "treasurer",
      body: "His health insurance is $1,485 a month.",
      at: "2026-08-11T01:50:15.000Z",
    };
    const asCursorInput: InboundReply = reply;
    const asFenceInput: AgentReply = reply;

    expect(asCursorInput.messageId).toBe("msg-1");
    expect(fenceReplies([asFenceInput])).toContain(REPLY_FENCE_OPEN);
  });

  it("should drop a reply whose timestamp it cannot read rather than stamping it now", () => {
    // `RepliesSeen` refuses an unparseable `at`, and an invented one would
    // order this answer against the others by when we happened to poll.
    const { client } = clientWith([
      messagesAnswer([row({ id: "no-stamp", createdAt: 1_754_876_215 }), row()]),
    ]);

    return client.repliesFrom("treasurer").then((result) => {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.map((reply) => reply.messageId)).toEqual(["msg-1"]);
    });
  });

  it("should ask for a wide window, because the filter is applied after it", async () => {
    // `?agentId=X&limit=N` takes X's newest N messages and THEN we keep the
    // ones addressed to her. A chatty agent's traffic with the Commander can
    // push her reply out of a small window — a reply that vanishes with nothing
    // reporting a failure, which is the shape of defect constraint 4 exists for.
    const { client, calls } = clientWith([messagesAnswer([])]);

    await client.repliesFrom("treasurer");

    expect(calls[0]?.url).toContain(`limit=${String(READ_LIMIT_MAX)}`);
  });

  it("should clamp a caller's limit to what the route will actually honour", async () => {
    // Adjutant clamps to 200 server-side. Sending 5,000 would have us believe
    // we asked for a window we did not get.
    const { client, calls } = clientWith([messagesAnswer([])]);

    await client.repliesFrom("treasurer", { limit: 5_000 });

    expect(calls[0]?.url).toContain(`limit=${String(READ_LIMIT_MAX)}`);
  });

  it("should call a body that is not the contract envelope malformed", async () => {
    // Something that is not Adjutant answered — a proxy, or the wrong port.
    const { client } = clientWith([
      { headers: { "content-type": "text/html" }, text: "<html>gateway</html>" },
    ]);

    const result = await client.repliesFrom("treasurer");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("malformed");
  });

  it("should skip a row it cannot read rather than inventing fields for it", async () => {
    // A row with no body is not a reply. Passing it through as `""` would show
    // him an empty quote attributed to the treasurer.
    const { client } = clientWith([
      messagesAnswer([{ id: "broken", agentId: "treasurer", recipient: "syl" }, row()]),
    ]);

    const result = await client.repliesFrom("treasurer");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((reply) => reply.messageId)).toEqual(["msg-1"]);
  });
});

describe("where she is allowed to point this", () => {
  it("should refuse a base URL that is not this machine", () => {
    // What she asks the treasurer is a question about the Commander's money.
    // A base URL off this machine sends that question over a network, and the
    // configuration should fail loudly rather than at the first ask.
    expect(
      () => new AdjutantClient({ baseUrl: "https://adjutant.example.com", agentId: "syl" }),
    ).toThrow(/loopback/iu);
  });

  it("should accept the loopback spellings the machine actually uses", () => {
    for (const base of ["http://127.0.0.1:4201", "http://localhost:4201", "http://[::1]:4201"]) {
      expect(() => new AdjutantClient({ baseUrl: base, agentId: "syl" }), base).not.toThrow();
    }
  });
});

describe("the wire format, on its own", () => {
  it("should read a JSON-RPC message out of an SSE frame", () => {
    // Adjutant answers `/mcp` as `text/event-stream` even for a single reply.
    // `JSON.parse` on the raw body throws, and a client that fell back to "no
    // result" would report every successful send as a failure.
    expect(parseMcpBody("text/event-stream", sse({ jsonrpc: "2.0", id: 1, result: { ok: true } })))
      .toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("should read a plain JSON body too, since the header is the server's choice", () => {
    expect(parseMcpBody("application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 })))
      .toEqual({ jsonrpc: "2.0", id: 1, result: 1 });
  });

  it("should return null for a body that is neither", () => {
    expect(parseMcpBody("text/html", "<html></html>")).toBeNull();
    expect(parseMcpBody("text/event-stream", "event: ping\n\n")).toBeNull();
  });

  it("should join an SSE data field split across lines, as the format allows", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const split = `event: message\ndata: ${payload.slice(0, 10)}\ndata: ${payload.slice(10)}\n\n`;

    expect(parseMcpBody("text/event-stream", split)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });
});

describe("the timestamps Adjutant hands back", () => {
  it("should read its space-separated stamp as UTC, which is what it is", () => {
    // `createdAt: "2026-08-11 01:50:15"` is not ISO-8601 and V8 parses it as
    // LOCAL time. On this machine that is five hours out — the reply would be
    // attributed to a time the Commander was asleep. Evidence: a send made at
    // envelope time `2026-08-11T01:50:15.143Z` came back stamped
    // `2026-08-11 01:50:15`, so the stored value is UTC.
    expect(adjutantTimeToIso("2026-08-11 01:50:15")).toBe("2026-08-11T01:50:15.000Z");
  });

  it("should leave an instant that is already an instant alone", () => {
    expect(adjutantTimeToIso("2026-08-11T01:50:15.143Z")).toBe("2026-08-11T01:50:15.143Z");
  });

  it("should hand back an unreadable stamp untouched rather than invent one", () => {
    // A fabricated timestamp is a lie told confidently. A visibly odd string is
    // a thing somebody notices.
    expect(adjutantTimeToIso("sometime last week")).toBe("sometime last week");
  });
});
