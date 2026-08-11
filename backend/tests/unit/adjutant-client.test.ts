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

/** A `tools/call` answer wrapping whatever `send_message` returned. */
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

/** What a successful `send_message` returns. Captured from 4201. */
const sentAnswer = toolAnswer({
  messageId: "dad93396-118f-4791-be99-46220f7fe9b5",
  timestamp: "2026-08-11 01:50:15",
});

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
    expect(call.params?.name).toBe("send_message");
    expect(Object.keys(call.params?.arguments ?? {}).sort()).toEqual(["body", "to"]);
    expect(call.params?.arguments?.["to"]).toBe("treasurer");
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
      toolAnswer({ messageId: "after-restart", timestamp: "2026-08-11 01:52:00" }, 4),
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
