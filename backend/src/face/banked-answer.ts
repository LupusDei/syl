/**
 * The answer an overrunning turn produced, kept so the next ask can serve it —
 * `syl-chzl.4.5`.
 *
 * ## The promise this exists to make true
 *
 * When a turn overruns the 6.5s deadline, her face says:
 *
 * > "That one is taking me longer than I can stand here for. **Ask me again
 * > and I will have it.**"
 *
 * She did not have it. The overrun turn kept running, computed a perfectly
 * good answer, banked it in his transcript and dropped it on the floor; asking
 * again started a fresh turn that overran identically. Fourteen out of fourteen
 * on 2026-08-23 — her face had never once answered a question.
 *
 * That is worse than a vague apology, because he changes his behaviour on the
 * strength of it: he asks again, and waits, and gets nothing. The sentence is
 * right. This is the system catching up to it.
 *
 * It is also constraint 4's ethos in a new place. *Never silently drop a
 * reminder* is the written rule; the principle under it is that **the system
 * does not get to quietly discard things it produced for him**. A computed
 * answer thrown away because a network deadline passed is exactly that shape.
 *
 * ## Why this lives in memory and not on disk
 *
 * The bank's whole content is the resolution of a promise held by this process.
 * If the process dies the turn dies with it, so there is nothing a durable bank
 * could hold that a restart would not have invalidated anyway — and a row that
 * outlived its process would let a *dead* turn's answer be spoken minutes
 * later, which is the failure this module is bounding, not causing.
 *
 * So: a `Map`, no migration, and a lifetime short enough that durability is not
 * a question anyone asks.
 *
 * ## Why it is pure
 *
 * No clock, no store, no logger. Every instant is a parameter. The staleness
 * model is the risky part of this feature and it is exercised exhaustively in
 * microseconds, without the ingress test having to reason about wall time.
 */

/**
 * How long a banked answer may be served for, measured from **when he asked**.
 *
 * ## Why ninety seconds
 *
 * Measured on his own phone (2026-08-23, `syl.log`): the turns that overran
 * took 7,789ms, 10,049ms and 29,852ms. He hears the apology at ~7s, and then
 * there is a human pause plus the avatar's own turnaround before the next
 * `ask_syl` lands. So the worst realistic gap between his question and the
 * answer being served is around forty seconds, against a worst measured turn of
 * thirty.
 *
 * Ninety is a little over double that. Under it the mechanism does not fail on
 * the case it exists for, with room for a turn slower than any yet measured.
 *
 * The *upper* limit is conversational rather than technical. Past about a
 * minute and a half, "you asked me about X" stops being her finishing a
 * sentence and starts being her interrupting a different one — and the content
 * genuinely rots: "what is on today" answered ninety seconds later is still
 * true, answered ten minutes later he may have ticked two things off it. An
 * answer served against the wrong moment is worse than no answer, which is why
 * this is a hard bound and not a heuristic.
 *
 * ## Why it runs from the ASK and not from the answer landing
 *
 * Because the thing that hurts him is the gap between asking and hearing, and
 * that is what this bounds. It also scales the right way on its own: a turn
 * that took thirty seconds leaves sixty seconds of bank life, a fast one leaves
 * nearly ninety. A slow turn's answer is older the moment it exists, and it
 * should expire sooner.
 */
export const BANKED_ANSWER_LIFETIME_MS = 90_000;

/**
 * The most sessions that may hold a banked answer at once.
 *
 * The sweep already bounds the map by "face sessions that overran in the last
 * ninety seconds", which is small — one concurrent face is the normal case and
 * more than a handful is itself the emergency the cost guard exists for. But
 * that is an *argument*, and this is a *structure*: it holds even if a clock
 * stops moving or a caller passes the same instant forever.
 */
export const MAX_BANKED_SESSIONS = 64;

/** An answer computed for a question the Commander never heard the answer to. */
export interface BankedAnswer {
  /** Exactly what he asked, as it was transcribed. Spoken back to him. */
  readonly question: string;
  /** What her turn said. Her words, unedited — see {@link spokenBankedAnswer}. */
  readonly say: string;
  /** Epoch ms at which HE ASKED. The lifetime runs from here, not from now. */
  readonly askedAt: number;
}

/**
 * One slot per face session, take-once, self-sweeping.
 *
 * **One slot, not a queue.** A backlog of unheard answers would be served in
 * the order it accumulated, which is precisely the disorienting non-sequitur
 * this feature has to avoid. The newest unheard answer is the only one with any
 * chance of still being wanted.
 */
export class AnswerBank {
  readonly #answers = new Map<string, BankedAnswer>();

  /** Keep an answer against the session whose turn produced it. */
  put(sessionId: string, answer: BankedAnswer): void {
    this.#sweep(answer.askedAt);
    // Re-inserting moves the key to the end of the Map's insertion order, which
    // is what makes the cap below evict the genuinely oldest entry.
    this.#answers.delete(sessionId);
    this.#answers.set(sessionId, answer);
    while (this.#answers.size > MAX_BANKED_SESSIONS) {
      const oldest = this.#answers.keys().next();
      if (oldest.done === true) break;
      this.#answers.delete(oldest.value);
    }
  }

  /**
   * The session's unexpired answer, left in place.
   *
   * Sweeping, so an expired answer does not merely read as absent — it is
   * *gone*. An entry that is hidden from one reader is an entry some later code
   * path can still find.
   */
  peek(sessionId: string, now: number): BankedAnswer | null {
    this.#sweep(now);
    return this.#answers.get(sessionId) ?? null;
  }

  /**
   * The session's unexpired answer, removed.
   *
   * Take-once is what stops her repeating one banked answer on every subsequent
   * ask for the rest of the session.
   */
  take(sessionId: string, now: number): BankedAnswer | null {
    const answer = this.peek(sessionId, now);
    if (answer !== null) this.#answers.delete(sessionId);
    return answer;
  }

  /** Forget a session's answer, because something newer has superseded it. */
  drop(sessionId: string): void {
    this.#answers.delete(sessionId);
  }

  /** How many sessions hold an answer. For tests and for the log. */
  size(): number {
    return this.#answers.size;
  }

  /** Every session's expired answer, not only the one being read. */
  #sweep(now: number): void {
    for (const [sessionId, answer] of this.#answers) {
      if (now - answer.askedAt >= BANKED_ANSWER_LIFETIME_MS) this.#answers.delete(sessionId);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Saying it out loud.
 * ------------------------------------------------------------------ */

/**
 * Longer than this and she is reading his own rambling back at him instead of
 * answering. Generous, because real spoken questions are short and clipping is
 * the worse failure of the two.
 */
const SPOKEN_QUESTION_LIMIT = 160;

/** His question, shortened and de-punctuated enough to be said aloud. */
function forSpeaking(question: string): string {
  const collapsed = question.replace(/\s+/gu, " ").trim();
  // Trailing punctuation only. Interior punctuation is his phrasing and gets to
  // stay — she is quoting him, not transcribing him again.
  const stripped = collapsed.replace(/[\p{P}\p{S}\s]+$/gu, "");
  if (stripped === "") return "";

  // Only the FIRST letter is lowered, so the sentence she builds reads as
  // speech rather than as a quotation. Lowering the whole thing would turn
  // "Grace" into "grace", which is a different word.
  const spoken = stripped.charAt(0).toLowerCase() + stripped.slice(1);
  if (spoken.length <= SPOKEN_QUESTION_LIMIT) return spoken;

  const cut = spoken.slice(0, SPOKEN_QUESTION_LIMIT);
  const boundary = cut.lastIndexOf(" ");
  // Half a word spoken aloud is gibberish, so the clip lands on a space.
  const clipped = boundary > 0 ? cut.slice(0, boundary) : cut;
  return `${clipped.replace(/[\p{P}\p{S}]+$/gu, "")}…`;
}

export interface SpeakBankedOptions {
  /**
   * Whether a NEWER turn is running behind this answer.
   *
   * True on the deadline-fallback path — he asked something else, that turn
   * overran too, and this old answer is what she has to offer meanwhile. Saying
   * so is the honest thing and it primes the next ask, which is what makes the
   * recovery continue rather than stall.
   */
  readonly stillWorking: boolean;
}

/**
 * The banked answer, prefaced with what it is an answer to.
 *
 * **The preface is the whole safety argument for serving a late answer.** Up to
 * ninety seconds have passed and he may have moved on; an answer arriving with
 * no referent reads as a non-sequitur and is worse than silence. With one, the
 * worst case is a mild "oh — right, that", and the best case is her keeping the
 * promise she made when she ran out of time.
 *
 * It is spoken aloud, so it has to sound like her. Nothing here may mention a
 * cache, a queue, a timeout or a session: those are true facts about the
 * machine and none of them is a thing a person says.
 *
 * **Her own words are never touched.** This wraps `say`; it does not edit it.
 * `face-conversation.ts` is the only thing allowed to author her speech.
 */
export function spokenBankedAnswer(
  answer: Pick<BankedAnswer, "question" | "say">,
  options: SpeakBankedOptions,
): string {
  const spoken = forSpeaking(answer.question);
  const opener = spoken === "" ? "That last one you asked me" : `You asked me ${spoken}`;
  const tail = options.stillWorking
    ? "here it is, while I finish the new one."
    : "here it is.";
  return `${opener} — ${tail} ${answer.say.trim()}`;
}

/* ------------------------------------------------------------------ *
 * Did he repeat himself?
 * ------------------------------------------------------------------ */

/** Letters and digits, lowered, everything else collapsed to one space. */
function normalise(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Is this the same question he asked before, near enough?
 *
 * **Used for exactly one cheap decision** — whether to burn a turn on the new
 * question — and never to gate whether the banked answer is served.
 *
 * That restriction is the point. Speech transcription varies run to run, and
 * the case this whole feature exists for is the one where he was *told* to ask
 * again and therefore rephrased: "what is on today", "so what have I got",
 * "what's on my plate". Any matcher tight enough to be safe produces false
 * negatives on precisely those, so a matcher that gated serving would make the
 * feature work approximately never. Fourteen out of fourteen is not a record
 * that leaves room to be clever.
 *
 * Put where it is, the errors are both mild and both survivable: a false
 * negative costs one redundant turn, a false positive costs one dropped
 * follow-up question that he can simply ask again.
 *
 * Two blank questions are never "the same". An empty normalisation carries no
 * information, and treating it as a match would make every unparseable
 * utterance a repeat of every other one.
 */
export function isSameQuestion(a: string, b: string): boolean {
  const left = normalise(a);
  return left !== "" && left === normalise(b);
}
