import type { Message } from "@syl/shared";

import { LANES, type Lane, type SylAgent } from "../harness/agent.js";
import { TurnTimeoutError } from "../harness/session.js";
import { systemClock, type Clock } from "./clock.js";
import { INTERACTIVE_CONVERSATION_ID } from "./database.js";
import type { AffectHint, AppendMessage, AppendResult, MessageStore } from "./message-store.js";

/**
 * The seam that makes Syl answer.
 *
 * ## What was wrong (`syl-vls`)
 *
 * `runTurn` and `SylAgent` were reachable from exactly one place in the tree —
 * `npm run ping`, a manual dev script. The socket stored what the Commander
 * said, confirmed it, echoed it, and stopped; `role: "user"` was the only role
 * anything in `backend/src` ever appended. Both halves of the conversation
 * existed and nothing joined them, which is the same shape of defect as
 * `syl-c5q` (presence) and `syl-md5` (the delivery runtime).
 *
 * This is the join. It owns three things, and each one is a rule that was
 * learned rather than chosen.
 *
 * ## 1. A turn is slow, so it never runs inside a request
 *
 * `DEFAULT_TURN_TIMEOUT_MS` is ten minutes. An HTTP handler that awaited a turn
 * would hold a connection open for it, and a socket frame handler that awaited
 * one would block every other frame on that connection. So the write paths
 * accept the message, answer immediately, and hand it here; the reply arrives
 * later, on the socket, and is persisted on the way past.
 *
 * ## 2. One turn at a time per conversation
 *
 * Continuity is `--resume <sessionId>` against a session id stored per lane.
 * Two subprocesses resuming the same id at once are two halves of one
 * transcript, interleaved — the conversation is corrupted, and it is corrupted
 * in Claude Code's own session store where we cannot repair it. Messages are
 * therefore queued per conversation: the second waits for the first. Different
 * conversations are different lanes and run in parallel, because serialising
 * across them would let a background job block the Commander.
 *
 * ## 3. Silence is never how a failure is reported
 *
 * A turn that throws or times out leaves a persisted message saying so. The
 * Commander seeing "I could not answer that" is a nuisance; the Commander
 * seeing nothing at all and not knowing whether Syl is thinking, broken, or
 * asleep is the failure that ends trust in the thing. Same rule as never
 * silently dropping a reminder, applied one layer up.
 *
 * A turn that *succeeds* with nothing to say is a different case and is left
 * silent on purpose — "notice, do not nag". An empty message is not one the
 * store would accept anyway.
 */

/**
 * Where an accepted message goes on the wire.
 *
 * `SylSocketServer.broadcastMessage` has this shape. Set after construction for
 * the same reason `PresenceService.setSink` is: the socket server does not
 * exist until an HTTP server is listening, and this service is built in
 * `bootstrap` alongside every other store.
 */
export type MessageSink = (message: Message) => void;

/**
 * The half of `PresenceService` a turn is allowed to reach.
 *
 * Narrow on purpose. A turn knows two facts — it started, it ended — plus the
 * optional affect hint it emitted. Handing it the whole service would let the
 * reply loop start deciding what Syl's character is doing, which is exactly the
 * inversion `derivePresence` exists to prevent.
 */
export interface TurnSink {
  turnStarted(): void;
  turnEnded(): void;
  affect(hint: AffectHint | null): void;
}

/**
 * How long `close` waits for turns in flight.
 *
 * launchd sends `SIGKILL` twenty seconds after `SIGTERM`, and
 * `DEFAULT_SHUTDOWN_TIMEOUT_MS` already spends fifteen of them. A drain that
 * could outlast a ten-minute turn would guarantee being killed mid-write, so
 * this is deliberately far under both.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/** Longest failure text that reaches the conversation. */
const MAX_FAILURE_DETAIL = 400;

/** Lane names become file names in the session store, so they are checked. */
const LANE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Which conversational lane a conversation belongs to.
 *
 * The Commander's own thread is `commander` — the lane `SOUL.md` and every
 * prior turn already live in. Everything else gets a lane of its own, named by
 * the conversation's id, so a background job never interleaves with him.
 *
 * The id is sanitised rather than trusted: lane names become file names in the
 * file-backed session store, and a lane called `../../.ssh/id_rsa` must not be
 * writable. Conversation ids are service-assigned and cannot look like that
 * today; sanitising here is what keeps that from being load-bearing.
 */
export function laneFor(conversationId: string): Lane {
  if (conversationId === INTERACTIVE_CONVERSATION_ID) return LANES.commander;

  const tail = conversationId.slice(conversationId.lastIndexOf(":") + 1);
  const cleaned = tail.replace(/[^a-z0-9._-]/gi, "");
  return LANE_PATTERN.test(cleaned) ? cleaned : LANES.commander;
}

/**
 * What the Commander is told when a turn does not produce an answer.
 *
 * A timeout reads differently from a failure on purpose: nothing is known about
 * whether a timed-out turn's work happened, so it must not be reported as
 * "Claude said no". The underlying message is included because this is the
 * Commander's own machine and the detail is the most useful thing on the
 * screen — truncated, because a stack trace pasted into a chat thread is not.
 */
export function turnFailureText(error: unknown): string {
  if (error instanceof TurnTimeoutError) {
    return (
      "I lost that one. The turn ran past its time limit and I stopped it, so I " +
      "cannot tell you whether any of it happened. Ask me again and I will start over."
    );
  }

  const detail = error instanceof Error ? error.message : String(error);
  const trimmed =
    detail.length > MAX_FAILURE_DETAIL ? `${detail.slice(0, MAX_FAILURE_DETAIL)}…` : detail;
  return `I could not answer that — the turn failed: ${trimmed}`;
}

/**
 * One exchange, after the reply has been persisted and put on the wire.
 *
 * Deliberately the SETTLED exchange rather than the live one: whatever runs on
 * this has already missed its chance to affect what he sees, which is the
 * property that makes it safe to run something slow and fallible here.
 */
export interface SettledExchange {
  readonly conversationId: string;
  readonly lane: Lane;
  /** The message he sent. */
  readonly prompt: Message;
  /** The message Syl sent back. */
  readonly reply: Message;
}

/**
 * Something to do once an exchange has settled — filing what was said into
 * memory, today.
 *
 * ## Why it hangs here and not on the reply path
 *
 * Whatever this is, it must not be able to make him wait and must not be able
 * to make him see a failure. So it runs **after** the assistant message is
 * appended and published, its result is never awaited by the turn, and a
 * rejection is caught and logged.
 *
 * ## Why it is not chained onto the conversation's queue
 *
 * The queue serialises turns per conversation so two subprocesses never resume
 * one session id. Chaining a slow follow-up onto that same chain would make his
 * NEXT message wait for it, which is the latency this hook exists to avoid,
 * one message later. It is tracked separately instead — {@link
 * ConversationService.idle} waits for both, so a test stays deterministic
 * without production paying for the ordering.
 *
 * ## Why only a SUCCESSFUL turn
 *
 * A failed turn's "reply" is `turnFailureText` — an apology, not something Syl
 * said. Reading an exchange back where her half is "I could not answer that"
 * teaches nothing and risks filing the apology itself.
 */
export type AfterExchange = (exchange: SettledExchange) => void | Promise<void>;

/**
 * One turn, as reported back to a caller that WAITED for it — `syl-chzl.4.2`.
 *
 * Every existing write path is fire-and-forget: it accepts the message,
 * answers immediately, and the reply arrives later on the socket. Her live
 * face cannot work that way. The avatar's tool call is a request/response with
 * a hard eight-second ceiling on it, so something has to hand the words back.
 *
 * {@link ConversationService.ask} is that something, and it is deliberately the
 * **same queue** rather than a second path into `SylAgent`. Two routes to a
 * turn is how one of them ends up without `SOUL.md`, without her memory, or
 * without the per-conversation serialisation that stops two subprocesses
 * resuming one session id. There is one seam; the face waits on it.
 */
export interface AnsweredTurn {
  /** What she said, trimmed. Empty when a turn succeeded with nothing to say. */
  readonly spoken: string;
  /** True when `spoken` is {@link turnFailureText} rather than her words. */
  readonly failed: boolean;
  /**
   * The credential the CLI resolved, off the init frame — or `null` when no
   * turn ran (the service was closing) or the turn threw before reporting one.
   *
   * Surfaced so a caller can refuse to SPEAK an answer that came back on the
   * metered rail. Constraint 3 is enforced upstream in `runTurn`, which strips
   * the variable and asserts on it; this is the second lock, one layer out,
   * for the one caller whose output is a voice rather than a row.
   */
  readonly apiKeySource: string | null;
  /** The persisted assistant message, or `null` if there was nothing to store. */
  readonly reply: Message | null;
}

export interface ConversationServiceOptions {
  readonly messages: MessageStore;
  /** Syl herself. One agent, many lanes. */
  readonly agent: SylAgent;
  /** Told when a turn opens and closes. Omit for a service with no character. */
  readonly presence?: TurnSink;
  /** Run once an exchange has settled, off the reply path. See {@link AfterExchange}. */
  readonly afterExchange?: AfterExchange;
  /** Where a failure goes. Defaults to stderr. */
  readonly log?: (line: string, error?: unknown) => void;
  readonly drainTimeoutMs?: number;
  readonly clock?: Clock;
}

export class ConversationService {
  readonly #messages: MessageStore;
  readonly #agent: SylAgent;
  readonly #presence: TurnSink | null;
  readonly #log: (line: string, error?: unknown) => void;
  readonly #drainTimeoutMs: number;
  readonly #clock: Clock;
  readonly #afterExchange: AfterExchange | null;
  /** One promise chain per conversation. Its presence means work is pending.
   *
   * Typed loosely because `ask` needs the chain's value and `accept` does not;
   * what the map is FOR is knowing a conversation is busy, and that question
   * does not care what the turn produced. */
  readonly #queues = new Map<string, Promise<unknown>>();
  /**
   * Follow-up work in flight, off the queues on purpose.
   *
   * Held so `idle` and `close` can wait for it. Not a chain: two exchanges'
   * follow-ups are independent and serialising them would rebuild the very
   * latency the hook avoids.
   */
  readonly #settling = new Set<Promise<void>>();
  #sink: MessageSink | null = null;
  #closed = false;
  #lastActiveAt: number | null = null;

  constructor(options: ConversationServiceOptions) {
    this.#messages = options.messages;
    this.#agent = options.agent;
    this.#presence = options.presence ?? null;
    this.#afterExchange = options.afterExchange ?? null;
    this.#clock = options.clock ?? systemClock;
    this.#log =
      options.log ??
      ((line, error) => {
        if (error === undefined) console.error(`[syl] ${line}`);
        else console.error(`[syl] ${line}`, error);
      });
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  }

  /** Point published messages at the socket. See {@link MessageSink}. */
  setSink(sink: MessageSink | null): void {
    this.#sink = sink;
  }

  /** How many conversations have a turn running or queued. */
  get pending(): number {
    return this.#queues.size;
  }

  /**
   * When the Commander was last talking to Syl, or `null`.
   *
   * Set when an interactive turn is queued and again when it settles, so it
   * reads "the last moment this service was doing something for him" rather
   * than "the last time a turn started".
   *
   * **This is what drives the dream's yield signal** (`syl-cbb`).
   * `DreamJudge.shouldYield` is checked at every checkpoint boundary and
   * needed a real source; `pending > 0` alone is only true while the model is
   * actually thinking, and the gaps between his messages are longer than the
   * turns. `jobs/dream-job.ts` combines the two.
   *
   * The dream's own turns never appear here: `DreamJudge` drives `runTurn`
   * directly on the `consolidation` lane and does not go through this queue,
   * so a dream can never be mistaken for the Commander and yield to itself.
   */
  get lastActiveAt(): number | null {
    return this.#lastActiveAt;
  }

  /**
   * Write a message to its conversation.
   *
   * A thin pass-through to the store, so that both write paths reach history
   * through the same object they hand the result back to. `MessageStoreError`
   * comes out unchanged — deciding what a refusal looks like on the wire is the
   * caller's business, and the two callers answer differently.
   */
  append(input: AppendMessage): AppendResult {
    return this.#messages.append(input);
  }

  /**
   * Announce an accepted message, and answer it if it was his.
   *
   * **Both write paths must call this**, and it is the only thing that makes
   * them equivalent: a message posted over HTTP used to be stored and never
   * broadcast, so an admin console send left every attached client showing a
   * conversation missing a message until it reloaded (`syl-vls`).
   *
   * Never throws. It is called after a write has already been committed and
   * answered, so there is nothing useful a caller could do with a failure here
   * and a great deal it could break by receiving one.
   */
  accept(result: AppendResult): void {
    // A replayed send already produced its frame and its answer the first time.
    if (result.replayed) return;

    this.#publish(result.message);
    if (result.message.role !== "user") return;
    void this.#enqueue(result.message);
  }

  /**
   * Say something to her and **wait for the answer** — `syl-chzl.4.2`.
   *
   * Same store, same queue, same lane, same `SylAgent` as {@link accept}; the
   * only difference is that the caller gets the words back instead of reading
   * them off the socket later. Her live face is the one caller that needs that,
   * because a `backend_rpc` tool call is a request/response and the provider
   * stops waiting after eight seconds.
   *
   * **It queues behind whatever the conversation is already doing**, which is
   * the point rather than a side effect: a face turn and a message from his
   * phone are two turns on one conversation, and two subprocesses resuming one
   * session id corrupt the transcript in Claude Code's own store where we
   * cannot repair it. The second one waits.
   *
   * Rejects only if the append is refused. A turn that fails resolves with
   * `failed: true` and {@link turnFailureText} in `spoken`, because silence is
   * never how a failure is reported.
   */
  async ask(input: AppendMessage): Promise<AnsweredTurn> {
    const result = this.append(input);
    if (result.message.role !== "user") {
      throw new Error("ConversationService.ask takes something HE said, not something she did.");
    }

    if (result.replayed) {
      // The first send already ran this turn and published its reply. Running
      // it again would charge for and store a second answer to one question.
      return { spoken: "", failed: false, apiKeySource: null, reply: null };
    }

    this.#publish(result.message);
    return this.#enqueue(result.message);
  }

  /** Resolve once nothing is running or queued, follow-up work included. */
  async idle(): Promise<void> {
    while (this.#queues.size > 0 || this.#settling.size > 0) {
      await Promise.allSettled([...this.#queues.values(), ...this.#settling]);
    }
  }

  /**
   * Stop answering.
   *
   * Waits for what is in flight so a reply that was one second from arriving
   * still lands, and gives up after {@link DEFAULT_DRAIN_TIMEOUT_MS} so a
   * wedged turn cannot spend the whole shutdown budget. Anything still running
   * after that is abandoned rather than allowed to write into a store that is
   * being closed underneath it.
   */
  async close(): Promise<void> {
    if (this.#closed) return;

    let timer: NodeJS.Timeout | undefined;
    const expired = await Promise.race([
      this.idle().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.#drainTimeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);

    this.#closed = true;
    if (expired) {
      this.#log(
        `stopping with ${String(this.#queues.size)} conversation(s) still running a turn; ` +
          `their replies are abandoned.`,
      );
    }
  }

  // ------------------------------------------------------------- internals ---

  /**
   * Put a message on the wire.
   *
   * A sink that throws is a transport failure, and it must not cost the turn:
   * the message is already persisted and the client re-reads history on
   * reconnect.
   */
  #publish(message: Message): void {
    try {
      this.#sink?.(message);
    } catch (error) {
      this.#log(`failed to publish message ${message.id}`, error);
    }
  }

  /**
   * Queue a turn behind whatever this conversation is already doing.
   *
   * The chain is per conversation and the map entry is deleted when the tail
   * settles, so `pending` and `idle` describe what is actually happening rather
   * than what has ever happened.
   */
  #enqueue(message: Message): Promise<AnsweredTurn> {
    if (this.#closed) {
      this.#log(`not answering message ${message.id}: the conversation service has stopped.`);
      return Promise.resolve({ spoken: "", failed: true, apiKeySource: null, reply: null });
    }

    // Stamped on the way in AND on the way out. In, so the dream yields the
    // moment he says something rather than when the reply lands; out, so the
    // grace window is measured from the end of the exchange.
    this.#lastActiveAt = this.#clock();

    const key = message.conversationId;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    // `#turn` settles rather than rejecting, so one failure cannot poison the
    // chain and leave a conversation permanently unanswered.
    // `previous` cannot reject — `#turn` settles rather than throwing — but the
    // rejection handler is stated rather than assumed, because `ask` now awaits
    // this chain and a rejection escaping here would surface as a face that
    // threw rather than a face that apologised.
    const chain = previous.then(
      () => this.#turn(message),
      () => this.#turn(message),
    );
    this.#queues.set(key, chain);
    void chain.finally(() => {
      this.#lastActiveAt = this.#clock();
      if (this.#queues.get(key) === chain) this.#queues.delete(key);
    });
    return chain;
  }

  /** One turn: ask, then persist and publish whatever came back. */
  async #turn(message: Message): Promise<AnsweredTurn> {
    if (this.#closed) return { spoken: "", failed: true, apiKeySource: null, reply: null };

    const lane = laneFor(message.conversationId);
    let reply: string;
    let failed = false;
    let apiKeySource: string | null = null;

    this.#presence?.turnStarted();
    try {
      // `hisWords`, and this is the only place in the service entitled to say
      // it. `message` came off the message store, appended by an authenticated
      // write from him — so this prompt is not merely *on his lane*, it is text
      // he sent. Everything else that takes a turn is Syl waking herself up,
      // and since those turns now resume this very session the lane can no
      // longer tell the two apart. `harness/urgency.ts` is what rests on it:
      // only words he actually wrote can grant a reminder the right to pierce
      // quiet hours. See `AskOptions.hisWords`.
      const result = await this.#agent.ask(message.text, lane, { hisWords: true });
      // Read off the init frame, not off what we asked for. `runTurn` strips
      // `ANTHROPIC_API_KEY` and asserts on this; carrying it out lets the one
      // caller whose output is a VOICE refuse to speak an answer that came back
      // on the metered rail. See `AnsweredTurn.apiKeySource`.
      apiKeySource = result.init.apiKeySource;
      // `spoken`, not `text`. The CLI's result field carries only the prose after the
      // last tool call, so the moment she could create a reminder mid-answer her replies
      // began arriving with everything before the tool removed. `text` stays the raw
      // final answer for the reader, which parses it as JSON and would choke on prose.
      reply = result.spoken.trim();
    } catch (error) {
      failed = true;
      this.#log(`turn failed on lane ${lane}`, error);
      // Never silence. See the note at the top of this file.
      reply = turnFailureText(error);
    } finally {
      // In `finally` so one failure cannot pin the character on `thinking`
      // until the process restarts.
      this.#presence?.turnEnded();
    }

    if (reply === "") return { spoken: "", failed, apiKeySource, reply: null };
    if (this.#closed) {
      this.#log(`dropping a reply on lane ${lane}: the conversation service stopped mid-turn.`);
      return { spoken: reply, failed, apiKeySource, reply: null };
    }

    try {
      const appended = this.#messages.append({
        conversationId: message.conversationId,
        // Null for anything Syl originated — there is no optimistic bubble on
        // the client to reconcile against.
        clientId: null,
        role: "assistant",
        text: reply,
      });
      this.#presence?.affect(appended.affect);
      this.#publish(appended.message);
      // Last, and only on a turn that actually answered. See `AfterExchange`.
      if (!failed) {
        this.#settle({
          conversationId: message.conversationId,
          lane,
          prompt: message,
          reply: appended.message,
        });
      }
      return { spoken: reply, failed, apiKeySource, reply: appended.message };
    } catch (error) {
      this.#log(`failed to store a reply on lane ${lane}`, error);
      return { spoken: reply, failed: true, apiKeySource, reply: null };
    }
  }

  /**
   * Start the follow-up for a settled exchange and track it.
   *
   * Wrapped in `Promise.resolve().then(...)` so a hook that throws
   * SYNCHRONOUSLY is caught by the same handler as one that rejects. Without
   * that, a synchronous throw would escape into `#turn`'s `catch` and be
   * reported as "failed to store a reply", which is a lie about a message that
   * was stored perfectly.
   */
  #settle(exchange: SettledExchange): void {
    const hook = this.#afterExchange;
    if (hook === null || this.#closed) return;

    const running = Promise.resolve()
      .then(() => hook(exchange))
      .then(
        () => undefined,
        (error: unknown) => {
          this.#log(`follow-up failed for exchange on lane ${exchange.lane}`, error);
        },
      );
    this.#settling.add(running);
    void running.finally(() => this.#settling.delete(running));
  }
}
