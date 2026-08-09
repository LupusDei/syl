import type { WsDeliveryConfirmation, WsServerChatMessage } from "@syl/shared";

/**
 * The replay buffer: a bounded, monotonically numbered log of the server
 * frames a client is entitled to have missed.
 *
 * This is the machinery that makes "the phone was in a tunnel" and "the Mac
 * rebooted" into non-events rather than lost messages, and it is worth being
 * exact about the two rules that make it work.
 *
 * **1. Only replayable frames are numbered, and only numbered frames replay.**
 * Handshake frames, answers to specific requests, and `presence` are none of
 * those. `presence` in particular must never enter this log: replaying
 * "thinking" from four minutes ago asserts something about *now* that stopped
 * being true while the socket was down, and a character frozen mid-thought is
 * worse than no character at all. Numbering it would force either a forbidden
 * replay or a hole in the sequence space — and holes are precisely how gap
 * detection works, so every reconnect would look like data loss.
 *
 * **2. `complete: false` is the important case.** It means the client's gap is
 * older than the server remembers. Saying `complete: true` with a short answer
 * would tell a phone that spent a weekend in a drawer that it was caught up,
 * and everything that aged out would be silently gone.
 */

/** The frame types that are numbered and replayed. */
export type ReplayableFrame = WsServerChatMessage | WsDeliveryConfirmation;

/** A frame before it has been given its position. */
export type UnnumberedFrame =
  | Omit<WsServerChatMessage, "seq">
  | Omit<WsDeliveryConfirmation, "seq">;

/**
 * How many frames to keep.
 *
 * Bounded because an unbounded log is a memory leak with a long fuse. A few
 * hundred frames covers a tunnel, a reboot, and a normal night; anything
 * longer than that is what `GET /sync` is for, and the `complete` flag is what
 * routes a client there rather than leaving it to guess.
 */
export const DEFAULT_CAPACITY = 512;

/** The answer to a `sync` frame. */
export interface Replay {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly complete: boolean;
  readonly frames: readonly ReplayableFrame[];
}

export class FrameLog {
  readonly #capacity: number;
  #frames: ReplayableFrame[] = [];
  #lastSeq = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`FrameLog capacity must be a positive integer, got ${capacity}.`);
    }
    this.#capacity = capacity;
  }

  /** The newest sequence this log holds. Zero before anything is appended. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** The oldest sequence still held, or `lastSeq + 1` when the log is empty. */
  get oldestSeq(): number {
    return this.#frames[0]?.seq ?? this.#lastSeq + 1;
  }

  /** How many frames are held. */
  get size(): number {
    return this.#frames.length;
  }

  /**
   * Give a frame the next sequence number and remember it.
   *
   * The sequence never resets and never skips for the lifetime of the server.
   * A skip would look exactly like a dropped frame to every connected client.
   */
  append<T extends UnnumberedFrame>(frame: T): T & { readonly seq: number } {
    this.#lastSeq += 1;
    const numbered = { ...frame, seq: this.#lastSeq } as T & { readonly seq: number };

    // Safe assertion: the two members of UnnumberedFrame plus a seq are
    // exactly the two members of ReplayableFrame.
    this.#frames.push(numbered as unknown as ReplayableFrame);
    if (this.#frames.length > this.#capacity) this.#frames.shift();

    return numbered;
  }

  /**
   * Everything after `sinceSeq`.
   *
   * @param sinceSeq the client's high-water mark: it has this one, and wants
   * what follows.
   * @param limit    the most frames to return. Truncating is **not**
   * incompleteness — nothing was lost, the client simply syncs again from
   * `toSeq`. `complete` is only false when the start of the range has already
   * aged out of the buffer.
   */
  since(sinceSeq: number, limit = Number.MAX_SAFE_INTEGER): Replay {
    const wanted = Math.max(0, sinceSeq) + 1;

    // Nothing to send. Caught up, or ahead of us — a client claiming a
    // sequence we have never issued has talked to a different server
    // lifetime, and the honest answer is an empty, complete range.
    if (wanted > this.#lastSeq) {
      return { fromSeq: wanted, toSeq: this.#lastSeq, complete: true, frames: [] };
    }

    const complete = wanted >= this.oldestSeq;
    const available = this.#frames.filter((frame) => frame.seq >= wanted);
    const frames = available.slice(0, Math.max(0, limit));
    const first = frames[0];
    const last = frames.at(-1);

    return {
      fromSeq: first?.seq ?? wanted,
      toSeq: last?.seq ?? this.#lastSeq,
      complete,
      frames,
    };
  }
}
