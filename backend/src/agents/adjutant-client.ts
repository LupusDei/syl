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

/**
 * Every Adjutant tool this client calls, in one place a test can read.
 *
 * `tests/unit/adjutant-tools-exist.test.ts` asserts each of these appears in a
 * captured `tools/list`, and scans this file for a bare string literal reaching
 * `#callTool`, so a tool name cannot be added without passing through here.
 *
 * ## Why the constant exists at all
 *
 * `ask` called `direct_message` for over a day against a running Adjutant that
 * does not register it, and every `ask_agent` failed — seven attempts, hourly,
 * with findings queued behind them. **The client was right.** `direct_message`
 * is built, tested and correct on the Adjutant branch
 * `feat/syl-j8fa-direct-message`; it has simply never been merged, so
 * `messaging.ts` on main registers it zero times. Our two halves shipped
 * separately, and nothing between a string literal here and a tool registry in
 * another service could notice.
 *
 * So the tool names are declared rather than scattered, and a test holds them
 * against what a live Adjutant actually advertises. See that test for why the
 * red it produces must be fixed by MERGING and not by re-capturing.
 */
export const ADJUTANT_TOOLS = {
  /**
   * Deliver to an agent's live session AND report how many injections landed.
   *
   * Deliberately not `send_message` — see {@link AdjutantClient.ask} for the
   * argument, which is `syl-5kdv` and is the Commander's explicit preference.
   * **Pending the Adjutant merge above**, so the guard test is currently red on
   * purpose.
   */
  directMessage: "direct_message",
} as const;

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
 * The first four are the kinds `tools/client.ts` uses, and for the same reason:
 * the split is by **what she should say and do**, not by where in the stack it
 * happened. `timed_out` is separate from `unreachable` because an abandoned
 * send may nonetheless have reached the treasurer, and "I do not know whether I
 * asked" is a different sentence from "I did not ask".
 *
 * `undelivered` is the fifth, added by `syl-j8fa.3`, and it is the only one
 * that is not a fault. Adjutant answered, accepted the message and wrote it
 * down — and **nobody was running to read it**. It has to be its own kind
 * because the sentence she says is different in the way that matters to him:
 * `unreachable` means the fleet is down and everything is affected;
 * `undelivered` means one recipient did not receive it and everything else is
 * fine. Folding it into `unreachable` would send him to check the wrong
 * machine, and folding it into success is the defect `syl-5kdv` reported.
 *
 * ## The distinction `undelivered` cannot yet make, and where it will go
 *
 * `deliveredToSessions: 0` is Adjutant's answer both for *an agent that exists
 * and is not started* and for *the message not surviving the hand-off to an
 * agent that is perfectly well*. Adjutant now separates them with
 * {@link AdjutantFailure.sessionsFound}, and the two want different sentences
 * because they want different things FROM HIM: start it, versus it is up and
 * this is worth another try.
 *
 * Carried as a number on the failure rather than as a sixth kind, which is
 * where an earlier note here pointed. The reason is that `kind` answers "what
 * should she say and do" and both of these answer it the same way — *the
 * message is filed and nobody read it* — while differing only in the detail
 * that picks the sentence. A kind per detail is how a four-member union
 * becomes a twelve-member one nobody switches on exhaustively.
 */
export type AdjutantFailureKind =
  | "refused"
  | "unreachable"
  | "timed_out"
  | "malformed"
  | "undelivered";

export interface AdjutantFailure {
  readonly kind: AdjutantFailureKind;
  /** What she was trying to do, in plain words. */
  readonly operation: string;
  /** A complete sentence she can say out loud. Never empty. */
  readonly message: string;
  readonly retryable: boolean;
  /**
   * How many of the recipient's sessions Adjutant FOUND, before it tried.
   *
   * Only ever present on `undelivered`, and only when Adjutant reported it.
   * Zero means the recipient is not running. Above zero, with nothing
   * delivered, means the recipient is running and the message did not survive
   * the hand-off — a rejected `sendInput`, a dead pane, a bridge that went
   * away between the lookup and the write.
   *
   * **Absent is a real state and must stay one.** An older Adjutant does not
   * send the field, and the honest answer there is the sentence that names
   * both possibilities. Note the asymmetry with `deliveredToSessions`, which
   * is a hard failure when missing: acting on THAT absence means guessing
   * whether anybody received the message, whereas this one only costs
   * precision in a failure already being reported. They are different
   * because the cost of being wrong about them is different.
   */
  readonly sessionsFound?: number;
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
  /**
   * How many of the recipient's live sessions the text actually reached.
   *
   * Always `>= 1` here: a `SentMessage` is only ever built for a message that
   * arrived somewhere, and zero is an {@link AdjutantFailure} of kind
   * `undelivered` instead. The field exists so she can say *how many*, not so
   * a caller can decide whether it worked — that decision has already been
   * made by the time this type exists.
   */
  readonly deliveredToSessions: number;
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

/** How much of an unreadable answer to quote back. Enough to name the cause. */
export const UNREADABLE_EXCERPT_MAX = 300;

/**
 * "I could not read this, and here is what it was."
 *
 * The second half is the whole point — see the call site in `#toolPayload` for
 * the day it cost. An empty body is called out as empty rather than rendered as
 * a pair of quotes with nothing between them, because "it said nothing" and "it
 * said something I could not read" are different faults with different causes
 * and send a reader to different places.
 */
function unreadable(operation: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return `Adjutant's answer to ${operation} was empty, so there is nothing to say happened.`;
  }

  const excerpt =
    trimmed.length > UNREADABLE_EXCERPT_MAX
      ? `${trimmed.slice(0, UNREADABLE_EXCERPT_MAX)}…`
      : trimmed;

  return `Adjutant's answer to ${operation} was not readable. It said: ${excerpt}`;
}

/**
 * `n sessions on record`, or `one session on record`.
 *
 * Deliberately not "live sessions". `registry.findByName` returns OFFLINE
 * session records too — Adjutant's own image path filters `status !== "offline"`
 * off the same call, which is the evidence — so a record is not a listener.
 */
function sessionsOnRecord(count: number): string {
  return count === 1 ? "one session on record" : `${String(count)} sessions on record`;
}

/**
 * Nothing arrived, said in whichever of three ways is true.
 *
 * The three differ in **what he could do about it**, which is the only reason
 * to distinguish them at all. A failure he cannot act on differently from
 * another failure does not need its own sentence.
 *
 * ## `sessionsFound` counts SESSION RECORDS, and nothing else
 *
 * It entails nothing about whether the agent is running, **in either
 * direction**, and both gaps are real:
 *
 * - Above zero, `registry.findByName` returns OFFLINE records too — Adjutant's
 *   own image path filters `status !== "offline"` off the same call, which is
 *   the evidence. So it reads equally as "up, and its session refused the
 *   message" and as "stopped, and its record has not been reaped".
 * - At zero, an agent managed outside the session bridge — a plain tmux agent
 *   on the roster — is up and has no record at all.
 *
 * So none of these sentences says whether the agent is there. Saying "they are
 * not running" would send him to start something that may be up; saying "their
 * session is up but unreachable" would tell him something is up that may have
 * stopped. Those are the SAME defect pointing opposite ways, both invisible to
 * him, and **the fix for a sentence that guesses is not a better guess.**
 *
 * They still divide into three, because they differ in WHAT HE CAN DO — which
 * is the only thing worth spending a branch on:
 *
 * - `sessionsFound === 0` — nothing is on record to receive it, so retrying
 *   now cannot help; something has to change first.
 * - `sessionsFound > 0` — something is on record and did not take it, so
 *   another attempt later is reasonable.
 * - absent — an older Adjutant. It cannot even say that much, and it says so.
 *
 * Each also refuses the inference **out loud** rather than merely avoiding the
 * word. Three times in one day a count here has been read as meaning slightly
 * more than it knows, twice by the person who had just caught the previous
 * one. The inference is natural enough that dodging it silently is not
 * protection.
 */
function undelivered(
  operation: string,
  who: string,
  sessionsFound: number | undefined,
): { readonly ok: false; readonly failure: AdjutantFailure } {
  const recorded = `Adjutant recorded the message for ${who}, but`;

  if (sessionsFound === 0) {
    return {
      ok: false,
      failure: {
        kind: "undelivered",
        operation,
        message:
          `Adjutant recorded the message for ${who} but holds no session on record for them, ` +
          "so there was nowhere to put it and nobody has read it. That says nothing about " +
          `whether ${who} is there. Trying again now will not help; something has to change ` +
          "first.",
        retryable: false,
        sessionsFound,
      },
    };
  }

  if (sessionsFound !== undefined) {
    return {
      ok: false,
      failure: {
        kind: "undelivered",
        operation,
        message:
          `Adjutant recorded the message for ${who} and holds ` +
          `${sessionsOnRecord(sessionsFound)} for them, but could not put it into any of them, ` +
          "so nobody has read it. A session on record does not mean anybody is at it, so that " +
          `says nothing about whether ${who} is there. Trying again may work.`,
        // The one undelivered case where another attempt is not futile.
        retryable: true,
        sessionsFound,
      },
    };
  }

  return {
    ok: false,
    failure: {
      kind: "undelivered",
      operation,
      // No count at all. Listing candidate explanations here would read as a
      // diagnosis and would silently exclude whatever was not on the list, so
      // it reports the gap itself instead.
      message:
        `${recorded} nothing accepted it, and this Adjutant does not report what it holds for ` +
        `${who}, so I cannot tell whether anything was there to receive it. Nobody has read it.`,
      retryable: false,
    },
  };
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
   *
   * ## Why this calls `direct_message` and not `send_message`
   *
   * `syl-5kdv`, reported by the Commander with two ids she had told him were
   * successful and which nobody ever received. Measured in Adjutant's source:
   * `send_message`'s DM branch persists, broadcasts, emits a timeline event,
   * pushes APNS when the recipient is him — and **never injects into the
   * recipient's live session**. There is no failure path in it, so every send
   * she ever made came back successful whether or not a soul was listening.
   *
   * `direct_message` (`syl-j8fa.2`) wraps `deliverDirectMessage`, which does
   * both halves, and answers with `deliveredToSessions`. **That count, not the
   * message id, is what decides whether this worked.** An id proves a row was
   * written. It has never proved a reader.
   *
   * The count is genuine arrival rather than a headcount: the tool awaits the
   * real `sendInput` calls and counts only the ones that resolved true, so a
   * rejected send and a dead pane both come back as zero. The `body` is
   * injected with a `[DM from syl] ` prefix, which is what gives the recipient
   * a name to reply to — the reply path (`syl-j8fa.5`) depends on it, this
   * method does not.
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
    // `direct_message`, never `send_message`: only the former injects into the
    // recipient's live session and reports how many injections actually landed.
    // The optional `threadId`/`metadata` carry the correlation id, which is what
    // lets an answer be matched back to the question that provoked it — so the
    // delivering tool and the correlated one have to be the same call.
    const called = await this.#callTool(
      ADJUTANT_TOOLS.directMessage,
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

    // Read AFTER the id, so that by the time anything below says "recorded"
    // there is an id proving a row exists to be recorded.
    //
    // Absent is NOT zero. An Adjutant too old to have the tool, or one whose
    // answer shape has drifted, must arrive as something visibly wrong rather
    // than as a confident "nobody was listening" — and certainly not as the
    // silent success this whole bead exists to remove. `Number.isInteger`
    // rather than `typeof === "number"` because a fraction of a session is as
    // unreadable as a string, and it rejects `NaN` for free.
    const reached = payload["deliveredToSessions"];
    if (!Number.isInteger(reached) || (reached as number) < 0) {
      return failure(
        "malformed",
        operation,
        `Adjutant took the message for ${who} but did not say whether it reached anyone, so ` +
          "there is no way to tell it apart from one that vanished. Treat it as unsent, and " +
          "check that Adjutant is new enough to deliver rather than only file.",
        false,
      );
    }

    const deliveredToSessions = reached as number;
    if (deliveredToSessions === 0) {
      // Not a fault, and not a success. The message is on disk — Adjutant
      // persists before it injects, so this holds even for a rejected send, a
      // dead pane, or a session bridge that was never initialised — and no
      // running session read it. Both halves are true and she needs both.
      //
      // WHICH KIND of nothing it was comes from `sessionsFound`, the registry
      // lookup taken before any injection is attempted.
      //
      // Read leniently, and DELIBERATELY unlike `deliveredToSessions` above.
      // That one is a hard failure when missing because acting on its absence
      // means guessing whether anybody received the message. This one only
      // sharpens a sentence that is already reporting a failure, so an older
      // Adjutant that omits it, or a value that cannot be read, degrades to
      // the sentence that names both readings rather than escalating. Making
      // the two behave alike in either direction would be wrong: strict here
      // turns a cosmetic gap into an outage, lenient there restores the
      // original bug.
      const found = payload["sessionsFound"];
      const sessionsFound =
        Number.isInteger(found) && (found as number) >= 0 ? (found as number) : undefined;

      return undelivered(operation, who, sessionsFound);
    }

    const stamp = payload["timestamp"];
    return {
      ok: true,
      data: {
        messageId,
        at: typeof stamp === "string" ? adjutantTimeToIso(stamp) : new Date(this.#clock()).toISOString(),
        deliveredToSessions,
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
      // **A PARSE FAILURE MUST REPORT WHAT IT FAILED TO PARSE.**
      //
      // This sentence used to end at "was not readable", and that cost a day.
      // Adjutant reports an unknown tool as ordinary prose — `MCP error -32602:
      // Tool direct_message not found` — which is not JSON, so `JSON.parse`
      // threw and this branch reported OUR failure to read the answer. Every
      // word of it was true and it described the wrong side of the call: the
      // diagnosis was sitting in `text`, discarded unread, seven times over
      // five hours. It sent one reader to look at the transport and another to
      // check whether Adjutant was down, and the real answer — *the tool does
      // not exist* — was in the string we threw away.
      //
      // So the raw text goes in the sentence. Truncated, because this reaches
      // a turn and eventually him — but present, because "not readable" plus
      // the thing she could not read is a diagnosis, and "not readable" alone
      // is a dead end pointing at the wrong subject.
      return failure("malformed", operation, unreadable(operation, text), false);
    }

    if (typeof payload !== "object" || payload === null) {
      // Valid JSON that is not an object — a bare string, a number, `null`.
      // Same rule: say what came back. `JSON.stringify` rather than the raw
      // text so a quoted string is visibly a quoted string.
      return failure("malformed", operation, unreadable(operation, JSON.stringify(payload)), false);
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
