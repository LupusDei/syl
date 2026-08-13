import { isLoopbackUrl, type FetchLike } from "../tools/client.js";
import { systemClock, type Clock } from "../services/clock.js";
import { mayReach, notOnTheRoster } from "./roster.js";

/**
 * How Syl's SERVICE talks to Adjutant on her behalf.
 *
 * Her turn never sees any of this. Adjutant's MCP surface is `set_status`,
 * `report_progress`, `create_bead`, `spawn_worker` — thirty coordination verbs,
 * and **a model infers what it is from its verbs**. That is precisely how she
 * came to describe herself as "an engineer on this codebase". So the service
 * does the talking and she gets two narrow verbs of her own, which is the same
 * shape as everything else here that works: the model proposes, the service
 * acts.
 *
 * ## The defect this module exists to avoid
 *
 * `POST /api/messages` stamps **every** message `from: "user"` — it is the
 * Commander's own send endpoint, and Adjutant's route logs a warning when a
 * non-user calls it, in as many words: *"agent impersonating the Commander?"*.
 * Used here, Syl would ask the treasurer about the Commander's money **in his
 * voice**, and the treasurer would answer as though he had asked. It would
 * poison his real message history at the same time.
 *
 * Nothing in this file may reach that route, and there is no fallback to it.
 *
 * ## Why sending goes over MCP and reading goes over REST
 *
 * This looks like an inconsistency. It is not.
 *
 * **Sending must carry her name.** Adjutant's `send_message` tool takes no
 * sender argument at all: it resolves the agent from the MCP session
 * (`getAgentBySession`), and the session is bound to the `X-Agent-Id` header
 * presented at `initialize`. So the identity of every message she sends is
 * decided by the handshake — which is why there is a handshake, and why a
 * `tools/list` with no session answers `{"error":"Missing Mcp-Session-Id
 * header"}`.
 *
 * **Reading must carry nothing.** `GET /api/messages` is an unauthenticated
 * read of a store on this machine. Speaking MCP to it would buy an identity
 * nobody checks and a session to keep alive.
 *
 * ## What `?agentId=` actually means, which is not what it looks like
 *
 * Adjutant's store filters on
 *
 * ```sql
 * agent_id = ? OR (role = 'user' AND recipient = ?)
 * ```
 *
 * so `?agentId=syl` returns **what she sent** plus **what the Commander sent
 * her** — and an agent's reply to her, which is `role = 'agent'` with
 * `recipient = 'syl'`, matches neither branch. Polling her own id would poll a
 * query that can never contain a reply. Verified against a live Adjutant on
 * 2026-08-11 by sending a message and failing to find it from the recipient's
 * side.
 *
 * So {@link AdjutantClient.repliesFrom} queries the **sender** and keeps the
 * rows addressed to her. The sender's other traffic arrives as a consequence
 * and is dropped here; none of it is stored, and none of it is shown.
 */

/** The MCP revision Adjutant answered on 2.1.226-era 0.2.2. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Where Adjutant's MCP server lives, relative to its base URL. */
export const MCP_PATH = "/mcp";

/** The read side. Deliberately NOT the POST of the same path. */
export const MESSAGES_PATH = "/api/messages";

/**
 * The widest window `GET /api/messages` will honour.
 *
 * Adjutant clamps `limit` to 200 server-side, and the query returns the
 * sender's newest `limit` messages **before** we filter to the ones addressed
 * to Syl. A chatty agent's traffic with the Commander can therefore push her
 * reply out of a narrow window — a reply that vanishes with nothing reporting a
 * failure, which is exactly the shape of defect constraint 4 exists for. So the
 * default is the maximum, and a caller asking for more is clamped rather than
 * quietly given less than it asked for.
 */
export const READ_LIMIT_MAX = 200;

/** How long to wait for a service on the same machine. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The one identity this client may never claim. */
const THE_COMMANDER = "user";

export interface AdjutantClientOptions {
  /** Adjutant's origin, e.g. `http://127.0.0.1:4201`. Loopback only. */
  readonly baseUrl: string;
  /** Who she is on the fleet. `syl`. Never `user`. */
  readonly agentId: string;
  /** `X-Project-Root`, which is how Adjutant scopes an agent to a project. */
  readonly projectRoot?: string;
  /** Injected. `globalThis.fetch` fits. */
  readonly fetch?: FetchLike;
  /** Injected, so "when she read it" is a value a test can hold still. */
  readonly clock?: Clock;
  readonly timeoutMs?: number;
}

/**
 * How a call went wrong, at the grain that decides what she says about it.
 *
 * The same four kinds `tools/client.ts` uses, and for the same reason: the
 * split is by **what she should say and do**, not by where in the stack it
 * happened. `timed_out` is separate from `unreachable` because an abandoned
 * send may nonetheless have reached the treasurer, and "I do not know whether I
 * asked" is a different sentence from "I did not ask".
 */
export type AdjutantFailureKind = "refused" | "unreachable" | "timed_out" | "malformed";

export interface AdjutantFailure {
  readonly kind: AdjutantFailureKind;
  /** What she was trying to do, in plain words. */
  readonly operation: string;
  /** A complete sentence she can say out loud. Never empty. */
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * What a call produced. Never an exception.
 *
 * A throw would cross back to a turn as a stack trace and reach the Commander
 * as silence — or worse, as her saying she asked because nothing told her she
 * had not. The one exception is the constructor, where a bad base URL or a bad
 * identity is a programming error rather than a runtime outcome.
 */
export type AdjutantResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: AdjutantFailure };

/** What Adjutant confirms when a message lands. */
export interface SentMessage {
  readonly messageId: string;
  /** Adjutant's own stamp, normalised to an instant. */
  readonly at: string;
}

/**
 * One message addressed to Syl by another agent.
 *
 * The field names are not arbitrary. This is deliberately assignable to **both**
 * `InboundReply` (`agents/replies-seen.ts`, which needs `messageId`/`from`/`at`)
 * and `AgentReply` (`agents/fencing.ts`, which needs `from`/`body`/`at`), so a
 * poll can go straight into the cursor and straight into the fence with no
 * adapter between them. An adapter there is a place for the id to change
 * meaning, and the id is the unit of exactly-once.
 *
 * There is no "when we read it" field for the same reason: `RepliesSeen` stamps
 * `seenAt` itself, and two nearly-identical timestamps owned by two modules is
 * the kind of pair that drifts.
 */
export interface InboundMessage {
  /** Adjutant's id for the message. Its `id` field. */
  readonly messageId: string;
  /** The sender's agent id. Adjutant calls this field `agentId`. */
  readonly from: string;
  readonly body: string;
  /** When Adjutant recorded it, as an ISO-8601 instant. */
  readonly at: string;
  /**
   * The thread the sender replied on, when they set one.
   *
   * Carried through UNPARSED and absent far more often than not: an agent
   * answering the ordinary way — `send_message` to her name — sets no thread at
   * all, and requiring one would be a protocol only she implements. It is here
   * because it costs nothing and is the *certain* carrier when it is present.
   * `agents/answers.ts` decides what a correlation id means.
   */
  readonly threadId?: string;
  /** Whatever the sender attached. Same story as `threadId`. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * One message SHE sent, read back out of Adjutant.
 *
 * This is how the register of outstanding questions is derived rather than
 * stored (`syl-j8fa.5`). `ask_agent` runs in the tool subprocess, which has no
 * database handle and reaches Syl's service only over HTTP — so a local table
 * of questions would need a route, a migration and a second copy of something
 * Adjutant already holds. It holds it because the answer is going to land in
 * the same store: what she asked and what came back are one conversation, and
 * splitting them across two databases is how they drift.
 *
 * The consequence worth stating: losing Syl's own database loses which answers
 * she has been SHOWN, and loses nothing about what she ASKED.
 */
export interface OutboundMessage {
  readonly messageId: string;
  /** Who she addressed it to. Adjutant calls this field `recipient`. */
  readonly to: string;
  readonly body: string;
  /** When Adjutant recorded it, as an ISO-8601 instant. */
  readonly at: string;
  readonly threadId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** What may ride along with a message she sends. */
export interface SendOptions {
  /**
   * The thread this message belongs to.
   *
   * Set by `ask_agent` to the question's correlation id, so an answer that
   * comes back on the same thread is tied to the question that provoked it
   * rather than floating loose in a list of DMs.
   */
  readonly threadId?: string;
  /** Structured detail Adjutant stores verbatim. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** How wide a read window to ask for. */
export interface ReadOptions {
  readonly limit?: number;
}

/**
 * Adjutant's `created_at`, as an instant.
 *
 * It is stored as `"2026-08-11 01:50:15"` — space-separated, no zone. That is
 * not ISO-8601, and V8 parses it as **local** time, which on this machine is
 * five hours out: a reply would be attributed to a time the Commander was
 * asleep. The stored value is UTC — a send whose response envelope was stamped
 * `2026-08-11T01:50:15.143Z` came back as `2026-08-11 01:50:15`.
 *
 * An unparseable stamp is returned untouched. A fabricated timestamp is a lie
 * told confidently; a visibly odd string is a thing somebody notices.
 */
export function adjutantTimeToIso(raw: string): string {
  const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/u.exec(raw.trim());
  const candidate = bare === null ? raw.trim() : `${bare[1] ?? ""}T${bare[2] ?? ""}Z`;
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}

/**
 * The JSON-RPC message inside an answer from `/mcp`, or `null`.
 *
 * Adjutant answers `text/event-stream` **even for a single reply**, so a client
 * that ran `JSON.parse` over the raw body would throw on every successful call
 * and report each one as a failure. Plain JSON is accepted too, because which
 * framing to use is the server's choice and it may change it.
 */
export function parseMcpBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    // SSE allows one field to be split across several `data:` lines, joined
    // with newlines. Rare for a single JSON payload, cheap to honour, and
    // silently truncating would be indistinguishable from a malformed answer.
    const data = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.trim() === "") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A JSON-RPC answer, as far as this module reads one. */
interface RpcAnswer {
  readonly result?: { readonly content?: readonly { readonly text?: string }[] };
  readonly error?: { readonly message?: string };
}

function isRpcAnswer(value: unknown): value is RpcAnswer {
  return typeof value === "object" && value !== null;
}

/** One row of `GET /api/messages`, as far as this module reads one. */
interface MessageRow {
  readonly id?: unknown;
  readonly agentId?: unknown;
  readonly recipient?: unknown;
  readonly body?: unknown;
  readonly createdAt?: unknown;
  readonly threadId?: unknown;
  readonly metadata?: unknown;
}

/**
 * The two optional carriers, present only when Adjutant actually has them.
 *
 * Spread into the result rather than defaulted, because `exactOptionalProperty`
 * distinguishes "absent" from "explicitly undefined" and a matcher that had to
 * handle both would have two ways to say the same nothing.
 */
function carriers(row: MessageRow): {
  threadId?: string;
  metadata?: Readonly<Record<string, unknown>>;
} {
  return {
    ...(typeof row.threadId === "string" && row.threadId !== "" ? { threadId: row.threadId } : {}),
    ...(typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? { metadata: row.metadata as Readonly<Record<string, unknown>> }
      : {}),
  };
}

function failure(
  kind: AdjutantFailureKind,
  operation: string,
  message: string,
  retryable: boolean,
): { readonly ok: false; readonly failure: AdjutantFailure } {
  return { ok: false, failure: { kind, operation, message, retryable } };
}

export class AdjutantClient {
  readonly #baseUrl: string;
  readonly #agentId: string;
  readonly #projectRoot: string | undefined;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #origin: string;

  /** The session that carries her name. `null` until the first handshake. */
  #sessionId: string | null = null;
  #nextRequestId = 1;

  constructor(options: AdjutantClientOptions) {
    const agentId = options.agentId.trim();

    // The one identity that must be structurally unreachable. `POST
    // /api/messages` gives it away for free; this client must not be able to
    // claim it even when somebody configures it to. Case-folded because
    // Adjutant's own comparisons are exact and `User` would slip past a
    // literal check while still being read as him by anyone reading the log.
    if (agentId.toLowerCase() === THE_COMMANDER) {
      throw new Error(
        'Syl cannot speak to Adjutant as "user". That is the Commander himself, and a message ' +
          "carrying his name would ask the treasurer about his money in his voice — and land in " +
          "his own message history as something he said.",
      );
    }
    if (agentId === "") {
      throw new Error(
        "Syl's Adjutant client was given no identity. Adjutant falls back to a generated agent " +
          "id when none is presented, so every message she sent would be untraceable rather than " +
          "hers.",
      );
    }

    // `new URL` throws on nonsense, which is the right outcome: a client built
    // against an unparseable address can never make one successful call, so
    // failing here turns a silent hundred failures into one loud one.
    const url = new URL(options.baseUrl);
    if (!isLoopbackUrl(url)) {
      throw new Error(
        `Syl's Adjutant client refuses ${url.origin}: it must be loopback. What she asks the ` +
          "treasurer is a question about the Commander's money, and a base URL off this machine " +
          "puts that question on a network.",
      );
    }

    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#origin = url.host;
    this.#agentId = agentId;
    this.#projectRoot = options.projectRoot;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Who Adjutant will say this message is from. */
  get agentId(): string {
    return this.#agentId;
  }

  /**
   * Put something to a named agent, as Syl.
   *
   * The roster decides who she may reach, and it decides it **before** any
   * connection is opened — a refusal that still made a request would mean the
   * list was advisory.
   */
  async ask(
    who: string,
    body: string,
    options: SendOptions = {},
  ): Promise<AdjutantResult<SentMessage>> {
    const operation = `ask ${who}`;
    if (!mayReach(who)) {
      return failure("refused", operation, notOnTheRoster(who), false);
    }

    // No `from`, no `role`, no sender of any kind: there is nothing here to be
    // wrong about. Adjutant reads the sender off the session established by
    // `#handshake`, and that session carries `X-Agent-Id: syl`.
    const called = await this.#callTool(
      "send_message",
      {
        to: who,
        body,
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      },
      operation,
    );
    if (!called.ok) return called;

    const payload = called.data;
    const messageId = payload["messageId"];
    if (typeof messageId !== "string" || messageId === "") {
      return failure(
        "malformed",
        operation,
        `Adjutant accepted the message for ${who} but did not say which message it was, so ` +
          "there is no way to tell whether it landed. Treat it as unsent.",
        false,
      );
    }

    const stamp = payload["timestamp"];
    return {
      ok: true,
      data: {
        messageId,
        at: typeof stamp === "string" ? adjutantTimeToIso(stamp) : new Date(this.#clock()).toISOString(),
      },
    };
  }

  /**
   * What a named agent has said **to her**.
   *
   * Queries the sender rather than herself — see the module note on what
   * `?agentId=` actually filters on. Everything the sender said to somebody
   * else arrives as a consequence of that query and is dropped here.
   */
  async repliesFrom(who: string, options: ReadOptions = {}): Promise<AdjutantResult<readonly InboundMessage[]>> {
    const operation = `read what ${who} said`;
    if (!mayReach(who)) {
      return failure("refused", operation, notOnTheRoster(who), false);
    }

    const limit = Math.min(Math.max(options.limit ?? READ_LIMIT_MAX, 1), READ_LIMIT_MAX);
    const query = new URLSearchParams({ agentId: who, limit: String(limit) });

    const answered = await this.#send(
      `${this.#baseUrl}${MESSAGES_PATH}?${query.toString()}`,
      { method: "GET", headers: { accept: "application/json" } },
      operation,
    );
    if (!answered.ok) return answered;

    let parsed: unknown;
    try {
      parsed = JSON.parse(answered.data.text);
    } catch {
      parsed = null;
    }

    const items = (parsed as { data?: { items?: unknown } } | null)?.data?.items;
    if (!Array.isArray(items)) {
      return failure(
        "malformed",
        operation,
        `Adjutant answered on ${this.#origin} with something that is not its message envelope. ` +
          "Something that is not Adjutant is listening there.",
        false,
      );
    }

    const replies: InboundMessage[] = [];
    for (const item of items as readonly MessageRow[]) {
      // Addressed to her, and not written by her. Her own question sits in the
      // same conversation; read back as a reply she would answer herself, and
      // `fencing.ts` would attribute her words to somebody else.
      if (item.recipient !== this.#agentId) continue;
      if (item.agentId === this.#agentId) continue;

      // A row missing any of these is not a reply. Passing it through with
      // defaults would show him an empty quote attributed to the treasurer.
      const { id, agentId, body, createdAt } = item;
      if (typeof id !== "string" || typeof agentId !== "string" || typeof body !== "string") continue;

      // A reply with no readable timestamp is dropped rather than stamped with
      // "now": `RepliesSeen` refuses an `at` it cannot parse, and an invented
      // one would order this answer against the others by when we happened to
      // poll.
      if (typeof createdAt !== "string") continue;

      replies.push({
        messageId: id,
        from: agentId,
        body,
        at: adjutantTimeToIso(createdAt),
        ...carriers(item),
      });
    }

    return { ok: true, data: replies };
  }

  /**
   * What SHE has said to the fleet — the register of questions she is owed
   * answers to, derived rather than kept.
   *
   * `?agentId=<her>` is the one query where the filter Adjutant actually runs
   * — `agent_id = ? OR (role = 'user' AND recipient = ?)` — works in our
   * favour: the first branch is everything she sent. The second branch drags in
   * what the Commander said to her, which is his conversation and not this, so
   * rows she did not write are dropped here.
   *
   * See {@link OutboundMessage} for why the register lives in Adjutant at all.
   * The window is the same clamp as {@link repliesFrom} and is the only bound
   * on how far back a question can be recognised — she asks rarely, so 200 of
   * her own messages is a long memory, and a question that has fallen out of it
   * is one nobody is waiting on.
   */
  async sent(options: ReadOptions = {}): Promise<AdjutantResult<readonly OutboundMessage[]>> {
    const operation = "read what she has asked";
    const limit = Math.min(Math.max(options.limit ?? READ_LIMIT_MAX, 1), READ_LIMIT_MAX);
    const query = new URLSearchParams({ agentId: this.#agentId, limit: String(limit) });

    const answered = await this.#send(
      `${this.#baseUrl}${MESSAGES_PATH}?${query.toString()}`,
      { method: "GET", headers: { accept: "application/json" } },
      operation,
    );
    if (!answered.ok) return answered;

    let parsed: unknown;
    try {
      parsed = JSON.parse(answered.data.text);
    } catch {
      parsed = null;
    }

    const items = (parsed as { data?: { items?: unknown } } | null)?.data?.items;
    if (!Array.isArray(items)) {
      return failure(
        "malformed",
        operation,
        `Adjutant answered on ${this.#origin} with something that is not its message envelope. ` +
          "Something that is not Adjutant is listening there.",
        false,
      );
    }

    const outgoing: OutboundMessage[] = [];
    for (const item of items as readonly MessageRow[]) {
      // Written by her, and addressed to somebody. Anything else in this page
      // is the Commander's half of her own conversation.
      if (item.agentId !== this.#agentId) continue;

      const { id, recipient, body, createdAt } = item;
      if (typeof id !== "string" || typeof recipient !== "string" || typeof body !== "string") {
        continue;
      }
      if (recipient === "" || typeof createdAt !== "string") continue;

      outgoing.push({
        messageId: id,
        to: recipient,
        body,
        at: adjutantTimeToIso(createdAt),
        ...carriers(item),
      });
    }

    return { ok: true, data: outgoing };
  }

  /**
   * One `tools/call`, with the session established first and re-established once.
   *
   * The retry is not an optimisation. Adjutant restarting invalidates the
   * session id we hold, and without this every send would fail forever with
   * nothing broken — she would simply go quiet. One retry, never a loop: a
   * neighbour being down is a thing she says out loud, not a thing she hammers.
   */
  async #callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    operation: string,
  ): Promise<AdjutantResult<Readonly<Record<string, unknown>>>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.#session(operation);
      if (!session.ok) return session;

      const answered = await this.#rpc(
        { method: "tools/call", params: { name, arguments: args } },
        session.data,
        operation,
      );

      if (!answered.ok) {
        if (answered.sessionGone && attempt === 0) {
          this.#sessionId = null;
          continue;
        }
        return { ok: false, failure: answered.failure };
      }

      return this.#toolPayload(answered.data, operation);
    }

    // Unreachable in practice: the loop either returns or continues exactly
    // once. Present because a `for` that falls through must still be a value.
    return failure(
      "unreachable",
      operation,
      `Adjutant on ${this.#origin} kept losing the session, so ${operation} did not happen.`,
      true,
    );
  }

  /** What a tool's `content[0].text` carried, or why it is not usable. */
  #toolPayload(
    answer: RpcAnswer,
    operation: string,
  ): AdjutantResult<Readonly<Record<string, unknown>>> {
    const text = answer.result?.content?.[0]?.text;
    if (typeof text !== "string") {
      return failure(
        "malformed",
        operation,
        `Adjutant answered ${operation} without any content, so there is nothing to say happened.`,
        false,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return failure("malformed", operation, `Adjutant's answer to ${operation} was not readable.`, false);
    }

    if (typeof payload !== "object" || payload === null) {
      return failure("malformed", operation, `Adjutant's answer to ${operation} was not readable.`, false);
    }

    // Adjutant reports a refused tool call as `{"error": "..."}` inside a
    // *successful* HTTP 200 with no `isError` flag. Read carelessly, that is
    // indistinguishable from a message that landed.
    const record = payload as Record<string, unknown>;
    const error = record["error"];
    if (typeof error === "string") {
      return failure("refused", operation, `Adjutant refused ${operation}: ${error}`, false);
    }

    return { ok: true, data: record };
  }

  /** The live session id, shaking hands first if there is not one. */
  async #session(operation: string): Promise<AdjutantResult<string>> {
    const held = this.#sessionId;
    if (held !== null) return { ok: true, data: held };

    const answered = await this.#send(
      `${this.#baseUrl}${MCP_PATH}`,
      {
        method: "POST",
        headers: this.#mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.#nextRequestId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: this.#agentId, version: "0" },
          },
        }),
      },
      operation,
    );
    if (!answered.ok) return answered;

    const sessionId = answered.data.response.headers.get("mcp-session-id");
    if (sessionId === null || sessionId === "") {
      return failure(
        "malformed",
        operation,
        `Adjutant on ${this.#origin} answered the handshake without an Mcp-Session-Id, so there ` +
          "is no session to carry Syl's identity. Sending anyway would send anonymously, and " +
          "she will not do that.",
        false,
      );
    }

    this.#sessionId = sessionId;

    // The notification a client owes the server after `initialize`. Fire and
    // do not read: it answers 202 with an empty body, and a server that
    // tolerates its absence is not a reason to skip sending it.
    const acknowledged = await this.#send(
      `${this.#baseUrl}${MCP_PATH}`,
      {
        method: "POST",
        headers: { ...this.#mcpHeaders(), "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      },
      operation,
    );
    if (!acknowledged.ok) {
      this.#sessionId = null;
      return acknowledged;
    }

    return { ok: true, data: sessionId };
  }

  /** One JSON-RPC request on an established session. */
  async #rpc(
    request: { readonly method: string; readonly params: unknown },
    sessionId: string,
    operation: string,
  ): Promise<
    | { readonly ok: true; readonly data: RpcAnswer }
    | { readonly ok: false; readonly failure: AdjutantFailure; readonly sessionGone: boolean }
  > {
    const answered = await this.#send(
      `${this.#baseUrl}${MCP_PATH}`,
      {
        method: "POST",
        headers: { ...this.#mcpHeaders(), "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.#nextRequestId++, ...request }),
      },
      operation,
    );
    if (!answered.ok) {
      return { ok: false, failure: answered.failure, sessionGone: answered.sessionGone };
    }

    const message = parseMcpBody(
      answered.data.response.headers.get("content-type") ?? "",
      answered.data.text,
    );
    if (!isRpcAnswer(message)) {
      return {
        ok: false,
        sessionGone: false,
        failure: {
          kind: "malformed",
          operation,
          message:
            `Adjutant on ${this.#origin} answered ${operation} with a body that is not JSON-RPC. ` +
            "Something that is not Adjutant is listening there.",
          retryable: false,
        },
      };
    }

    const error = message.error;
    if (error !== undefined) {
      return {
        ok: false,
        sessionGone: false,
        failure: {
          kind: "refused",
          operation,
          message: `Adjutant refused ${operation}: ${error.message ?? "no reason given"}`,
          retryable: false,
        },
      };
    }

    return { ok: true, data: message };
  }

  /**
   * The headers every `/mcp` request carries.
   *
   * `X-Agent-Id` is the whole security argument of this module: Adjutant binds
   * the session to it at `initialize`, and `send_message` resolves the sender
   * from the session. It is sent on every request rather than only the
   * handshake so a re-handshake after a restart cannot accidentally omit it.
   */
  #mcpHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-agent-id": this.#agentId,
      ...(this.#projectRoot === undefined ? {} : { "x-project-root": this.#projectRoot }),
    };
  }

  /**
   * One HTTP call, and every way it can end.
   *
   * `sessionGone` is separated out here rather than sniffed by the caller
   * because it is the one failure that is worth doing something about
   * automatically: a 400 or 404 whose body mentions the session means Adjutant
   * restarted, not that anything is wrong with what we asked.
   */
  async #send(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<
    | { readonly ok: true; readonly data: { readonly response: Response; readonly text: string } }
    | { readonly ok: false; readonly failure: AdjutantFailure; readonly sessionGone: boolean }
  > {
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      const aborted =
        error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return {
        ok: false,
        sessionGone: false,
        failure: aborted
          ? {
              kind: "timed_out",
              operation,
              message:
                `Adjutant did not answer within ${String(this.#timeoutMs)}ms, so it is not clear ` +
                `whether ${operation} happened. Worth checking rather than simply repeating.`,
              retryable: true,
            }
          : {
              kind: "unreachable",
              operation,
              message:
                `Adjutant is not answering on ${this.#origin}, so ${operation} did not happen. ` +
                "It may be restarting.",
              retryable: true,
            },
      };
    }

    const text = await response.text().catch(() => "");

    if (!response.ok) {
      const sessionGone =
        (response.status === 400 || response.status === 404) && /session/iu.test(text);
      return {
        ok: false,
        sessionGone,
        failure: {
          kind: "refused",
          operation,
          message:
            `Adjutant answered ${String(response.status)} to ${operation}, so it did not happen. ` +
            (sessionGone
              ? "The session carrying Syl's identity is no longer known to it."
              : `It said: ${text.slice(0, 200).trim() || "nothing"}.`),
          retryable: sessionGone,
        },
      };
    }

    return { ok: true, data: { response, text } };
  }
}
