import type { Message } from "@syl/shared";

import { LANES, type Lane, type SylAgent } from "../harness/agent.js";
import { TurnTimeoutError } from "../harness/session.js";
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

export interface ConversationServiceOptions {
  readonly messages: MessageStore;
  /** Syl herself. One agent, many lanes. */
  readonly agent: SylAgent;
  /** Told when a turn opens and closes. Omit for a service with no character. */
  readonly presence?: TurnSink;
  /** Where a failure goes. Defaults to stderr. */
  readonly log?: (line: string, error?: unknown) => void;
  readonly drainTimeoutMs?: number;
}

export class ConversationService {
  readonly #messages: MessageStore;
  readonly #agent: SylAgent;
  readonly #presence: TurnSink | null;
  readonly #log: (line: string, error?: unknown) => void;
  readonly #drainTimeoutMs: number;
  /** One promise chain per conversation. Its presence means work is pending. */
  readonly #queues = new Map<string, Promise<void>>();
  #sink: MessageSink | null = null;
  #closed = false;

  constructor(options: ConversationServiceOptions) {
    this.#messages = options.messages;
    this.#agent = options.agent;
    this.#presence = options.presence ?? null;
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
    this.#enqueue(result.message);
  }

  /** Resolve once nothing is running or queued. */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) {
      await Promise.allSettled([...this.#queues.values()]);
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
  #enqueue(message: Message): void {
    if (this.#closed) {
      this.#log(`not answering message ${message.id}: the conversation service has stopped.`);
      return;
    }

    const key = message.conversationId;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    // `#turn` settles rather than rejecting, so one failure cannot poison the
    // chain and leave a conversation permanently unanswered.
    const chain = previous.then(() => this.#turn(message));
    this.#queues.set(key, chain);
    void chain.finally(() => {
      if (this.#queues.get(key) === chain) this.#queues.delete(key);
    });
  }

  /** One turn: ask, then persist and publish whatever came back. */
  async #turn(message: Message): Promise<void> {
    if (this.#closed) return;

    const lane = laneFor(message.conversationId);
    let reply: string;

    this.#presence?.turnStarted();
    try {
      const result = await this.#agent.ask(message.text, lane);
      reply = result.text.trim();
    } catch (error) {
      this.#log(`turn failed on lane ${lane}`, error);
      // Never silence. See the note at the top of this file.
      reply = turnFailureText(error);
    } finally {
      // In `finally` so one failure cannot pin the character on `thinking`
      // until the process restarts.
      this.#presence?.turnEnded();
    }

    if (reply === "") return;
    if (this.#closed) {
      this.#log(`dropping a reply on lane ${lane}: the conversation service stopped mid-turn.`);
      return;
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
    } catch (error) {
      this.#log(`failed to store a reply on lane ${lane}`, error);
    }
  }
}
