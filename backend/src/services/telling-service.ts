import type { Message } from "@syl/shared";

import type { ConversationService } from "./conversation-service.js";
import { INTERACTIVE_CONVERSATION_ID } from "./database.js";
import type { AppendResult } from "./message-store.js";
import type { Outbox } from "./outbox.js";

/**
 * Her words reaching him, and nothing attached to them.
 *
 * ## The door that was never built — `syl-0x1h`
 *
 * She could reach him unprompted and did it often — the insurance nudge, the
 * dog sitter, a correction about a heart rate she had invented. None of those
 * were replies and every one of them reached him, but they arrived as
 * REMINDERS: an entry on his list plus a buzz. The only verb that wrote into
 * the conversation itself was `show_him`, and it requires a render.
 *
 * Her own diagnosis, 2026-08-17: *"my unprompted voice arrives wearing a
 * reminder's clothes, and the one door into the actual conversation has a
 * video-shaped lock on it."*
 *
 * The lock was correct and its justification was not. `show_him`'s comment said
 * `renderName` is the definition of a sending — *"words with no face is an
 * ordinary message, and she already has a conversation for those"* — and she did
 * not. She could only write into the conversation by REPLYING. That sentence
 * described a door nobody had built. This is the door.
 *
 * ## It is not a second delivery mechanism, and that is the whole design
 *
 * `SendingService` composes through this object rather than beside it, so there
 * is exactly one implementation of *her words reach his conversation and his
 * phone* and a sending is that plus a face. Two implementations would be two
 * quiet-hours gates, two notification shapes and two things to remember when
 * either changes — and the one nobody is looking at is the one that drifts.
 *
 * ```
 *   1. append the assistant message      the words are in his conversation
 *   2. publish it                        an attached client sees them now
 *   3. enqueue the push                  carrying HER SENTENCE, through the
 *                                        outbox, which is where quiet hours live
 * ```
 *
 * ## Three bounds, none of them enforced here
 *
 * **Quiet hours** are the outbox's, one step before the channel. Nothing here
 * asks what time it is, and nothing here may: a gate re-implemented beside the
 * one that already works is a gate that will disagree with it. `enqueue` takes
 * the computed release instant, so a telling composed at 03:00 is written now
 * and buzzes at 07:00.
 *
 * **Urgency** is not offered at all. `EnqueueDelivery.urgent` pierces the
 * window, `remind_me` proved that a self-judged flag is how a friend's birthday
 * wakes the house (`syl-j55`), and the safest field is the one that does not
 * exist. There is deliberately no option on {@link ComposeTelling} for it.
 *
 * **The daily ceiling** is the heartbeat's: `tell_him` is in `REACHES_HIM`
 * (`jobs/heartbeat-job.ts`), so the hour it is used in is counted, against the
 * same allowance `remind_me` and `show_him` spend from. A verb missing from
 * that list is a verb the ceiling cannot see.
 *
 * ## Why a telling has no row of its own
 *
 * The message IS the record. A sending has a row because it points at a video
 * that arrives later and can fail; a telling has nothing outstanding the moment
 * it is written. `because` therefore survives where every other reason-carrying
 * verb without a column keeps it — in the tool arguments on `turn.tool`, which
 * is the record of what she did on his machine. Required all the same: the
 * field that makes an unprompted act legible is not one to leave optional.
 */

/** What the notification says. Her name, and her sentence. */
export const HER_PUSH_TITLE = "Syl";

/**
 * How anything she starts interrupts.
 *
 * `active` rather than `time-sensitive`. A commitment breaks through Focus
 * because he undertook to do something at a time; a thing she thought of is a
 * gift, and a gift that overrides Do Not Disturb is not a gift.
 */
export const HER_PUSH_LEVEL = "active" as const;

/** Deliveries from this path, so the outbox can be read by cause. */
export const TELLING_MESSAGE_CLASS = "telling";

/** Anything wrong with the words themselves. */
export class TellingError extends Error {
  readonly kind: "empty_words" | "empty_because";

  constructor(kind: "empty_words" | "empty_because", message: string) {
    super(message);
    this.name = "TellingError";
    this.kind = kind;
  }
}

export interface ComposeTelling {
  /** What she wants to say. */
  readonly words: string;
  /** Why she is saying it, unasked. Kept in the turn record. */
  readonly because: string;
}

/** One push, as this module shapes every push she causes. */
export interface HerPush {
  readonly body: string;
  readonly messageClass: string;
  /** Derived from the thing being announced, never from the clock. */
  readonly idempotencyKey: string;
}

export interface TellingServiceOptions {
  /**
   * How the words reach the conversation AND the wire.
   *
   * `ConversationService` rather than `MessageStore`: the socket subscribes
   * itself to this object (`ws-server.ts` calls `chat.setSink`), so appending
   * through it and calling `accept` puts her words in front of an attached
   * client with no new wiring. A sink of this module's own would be one
   * bootstrap edit away from `syl-vls` — a message stored and never broadcast.
   *
   * `accept` is safe here: it publishes, then returns without queueing a turn
   * for anything that is not `role: "user"`. A telling must not make Syl answer
   * herself.
   */
  readonly chat: ConversationService;
  readonly outbox: Outbox;
  /** Defaults to the Commander's own thread. */
  readonly conversationId?: string;
  readonly log?: (line: string, error?: unknown) => void;
}

export class TellingService {
  readonly #chat: ConversationService;
  readonly #outbox: Outbox;
  readonly #conversationId: string;
  readonly #log: (line: string, error?: unknown) => void;

  constructor(options: TellingServiceOptions) {
    this.#chat = options.chat;
    this.#outbox = options.outbox;
    this.#conversationId = options.conversationId ?? INTERACTIVE_CONVERSATION_ID;
    this.#log =
      options.log ??
      ((line, error) => {
        if (error === undefined) console.error(`[syl] ${line}`);
        else console.error(`[syl] ${line}`, error);
      });
  }

  /**
   * Say something to him: his conversation, and his phone.
   *
   * Returns the message that was written. Nothing is outstanding afterwards —
   * unlike a sending, there is no video still to come — so this is the whole
   * of the act.
   *
   * @throws {TellingError} for anything wrong with the words, checked before a
   * message exists so a refusal leaves nothing behind and reaches nobody.
   */
  tell(input: ComposeTelling): Message {
    const words = input.words.trim();
    const because = input.because.trim();

    if (words === "") {
      throw new TellingError(
        "empty_words",
        "A telling has to say something. There is nothing here to put in front of him.",
      );
    }
    if (because === "") {
      throw new TellingError(
        "empty_because",
        "Every unprompted thing carries its reason — that is the difference between a gift and " +
          "a machine acting on his behalf.",
      );
    }

    const appended = this.say(words);

    // Keyed on the message's own id, so a retry writes one row rather than a
    // second buzz for one sentence.
    this.push({
      body: appended.message.text,
      messageClass: TELLING_MESSAGE_CLASS,
      idempotencyKey: `telling:${appended.message.id}`,
    });

    return appended.message;
  }

  /**
   * Put words in his conversation, as her, and on the wire.
   *
   * Public because `SendingService` composes through it: one implementation of
   * how her words arrive, whether or not a face follows them.
   *
   * `accept` never throws — it is called after a write has already been
   * committed, and there is nothing useful a caller could do with a failure
   * from it. Wrapped anyway, because "the socket was gone" must not be able to
   * cost words that are already persisted.
   */
  say(words: string): AppendResult {
    const appended = this.#chat.append({
      conversationId: this.#conversationId,
      // Null for anything Syl originated: there is no optimistic bubble on the
      // client to reconcile against.
      clientId: null,
      role: "assistant",
      text: words,
    });

    try {
      this.#chat.accept(appended);
    } catch (error) {
      this.#log(`failed to publish words she originated (message ${appended.message.id})`, error);
    }

    return appended;
  }

  /**
   * Enqueue a notification carrying her sentence.
   *
   * The body is exactly what she said — no prefix, no count, no "Syl sent you
   * a video". A notification about the app is not a notification from her, and
   * the whole point of an unprompted thing is that she thought of him.
   *
   * **Nothing here may pass `urgent`.** The window is the outbox's to compute
   * and this is the one call site that could ask it not to.
   *
   * Never throws. By the time this runs the words are persisted; failing on a
   * busy outbox would trade a missing buzz for a lost message.
   */
  push(input: HerPush): void {
    try {
      this.#outbox.enqueue({
        channel: "apns",
        messageClass: input.messageClass,
        payload: {
          title: HER_PUSH_TITLE,
          body: input.body,
          interruptionLevel: HER_PUSH_LEVEL,
        },
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      this.#log(`failed to enqueue the notification for ${input.idempotencyKey}`, error);
    }
  }
}
