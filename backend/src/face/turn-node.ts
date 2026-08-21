/**
 * Her turn, in the model-node seat of a LiveKit session.
 *
 * ## The one property everything here is built on
 *
 * **There is no token streaming.** `--output-format stream-json` streams
 * *events*, not tokens: measured at `28746b5`, the gap between her first
 * assistant text and the `result` frame is 2-15ms, and a 131-character answer
 * arrived as ONE assistant event with the result 31ms behind it. The complete
 * answer lands in one piece when the turn is done.
 *
 * LiveKit's model node is an `AsyncIterableIterator<ChatChunk>`, and **nothing
 * in that interface requires more than one chunk** (T002, recorded on
 * `syl-chzl.1.2` and in `specs/016-her-face-live/findings.md`). So this adapter
 * awaits the whole answer, pushes exactly one chunk, and closes.
 *
 * Two things follow, and both are prohibitions:
 *
 * - **Nothing here may wait for incremental deltas.** There are none, so code
 *   that waits for them waits forever.
 * - **Nothing here may buffer-and-chunk the finished answer** to imitate
 *   streaming. That adds latency to hide a property of the system, and the
 *   hiding is the problem. Phase 5's covering behaviour is the honest version.
 *
 * ## Why this file does not depend on `@livekit/agents`
 *
 * The types below MIRROR `@livekit/agents@1.7.0`, `agents/src/llm/llm.ts` —
 * they are not a design of our own. The package is deliberately **not** a
 * dependency of this workspace: at 1.7.0 it drags in `@livekit/av` and
 * `@livekit/local-inference` (both platform-specific native binaries), `sharp`,
 * `fluent-ffmpeg`, ten OpenTelemetry packages and the `openai` client. This
 * service deploys via launchd from a plain `tsc` build, and a native module
 * tree landing in it is a decision to take deliberately rather than as a side
 * effect of an adapter.
 *
 * Everything this file exports is **structurally assignable** to the real
 * interface, so wiring it up later is a thin subclass in the process that
 * actually runs the agent worker:
 *
 * ```ts
 * class LiveKitSylLLM extends LLM {
 *   label() { return node.label(); }
 *   chat(options) {
 *     return new (class extends LLMStream {
 *       async run() { for await (const c of node.chat(options)) this.output.put(c); }
 *     })(this, { ...options, connOptions });
 *   }
 * }
 * ```
 *
 * ## What it is NOT allowed to be
 *
 * The whole reason to attach at this layer rather than let a provider's model
 * do the talking is that `SOUL.md`, her memory graph and the reader fence stay
 * in the loop. **There is no personality string here and there is no path to an
 * answer that does not run her turn.** The only source of speech on the success
 * path is {@link FaceTurnRunner}; the only text this module authors is what she
 * says when a turn *failed*, and that is injectable so `syl-chzl.4.3` can own
 * the wording.
 */

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ *
 * The LiveKit shapes, mirrored.
 * ------------------------------------------------------------------ */

/** `@livekit/agents` `ChatRole`. */
export type ChatRole = "developer" | "system" | "user" | "assistant";

/** `@livekit/agents` `ChoiceDelta`. */
export interface ChoiceDelta {
  readonly role: ChatRole;
  readonly content?: string;
}

/** `@livekit/agents` `CompletionUsage`, for shape fidelity. Never emitted:
 * the CLI reports cost and turn counts, not the token breakdown this wants,
 * and a zero-filled usage record is a claim nobody measured. */
export interface CompletionUsage {
  readonly completionTokens: number;
  readonly promptTokens: number;
  readonly promptCachedTokens: number;
  readonly totalTokens: number;
}

/** `@livekit/agents` `ChatChunk`. */
export interface ChatChunk {
  readonly id: string;
  readonly delta?: ChoiceDelta;
  readonly usage?: CompletionUsage;
}

/**
 * As much of a `ChatItem` as this adapter reads.
 *
 * Structural on purpose: the real `ChatMessage` is a class with a `textContent`
 * getter, and a `FunctionCall` sitting beside it in the same array is not a
 * message at all. Reading `type` and `role` rather than `instanceof` keeps this
 * testable without constructing LiveKit's classes.
 */
export interface ChatItemLike {
  readonly type?: string;
  readonly role?: string;
  readonly content?: unknown;
  readonly textContent?: string | undefined;
  /** A `ChatItem` carries more than this reads — a `FunctionCall` has `name`
   * and `args`, an `AgentHandoffItem` has neither. Stated rather than left out,
   * so passing a real one is not a type error at the seam. */
  readonly [key: string]: unknown;
}

/** As much of a `ChatContext` as this adapter reads. */
export interface ChatContextLike {
  readonly items: readonly ChatItemLike[];
}

/** The argument LiveKit passes to `LLM.chat`. Everything but `chatCtx` is
 * ignored: her turn's tool surface is decided by the harness, per lane, and a
 * `toolCtx` arriving from the session must not be able to widen it. */
export interface ChatOptions {
  readonly chatCtx: ChatContextLike;
}

/* ------------------------------------------------------------------ *
 * The seam.
 * ------------------------------------------------------------------ */

/** What the adapter asks for. */
export interface FaceTurnRequest {
  /** The Commander's latest utterance, transcribed. */
  readonly prompt: string;
  /**
   * The session id the previous face turn ran on, when there was one.
   *
   * Advisory: a runner that owns its own continuity (`SylAgent`, and through it
   * `ConversationService`) may resume something else. What is not advisory is
   * {@link FaceTurnAnswer.sessionId} — see {@link SylLLM.sessionId}.
   */
  readonly resume?: string;
}

/** What the adapter gets back: one whole answer, and the evidence about it. */
export interface FaceTurnAnswer {
  /** Everything she said this turn, complete. */
  readonly text: string;
  /** The session the turn ACTUALLY ran on. Adopted for the next turn. */
  readonly sessionId: string;
  /**
   * Which credential the CLI resolved, from the init frame's `apiKeySource`.
   *
   * **Required, and required for a reason.** This adapter spawns nothing, so it
   * cannot strip `ANTHROPIC_API_KEY` itself — constraint 3 is enforced upstream
   * in `runTurn`. What it can do is refuse to *speak* an answer that came back
   * on the wrong rail, and a field that could be omitted would be a check a
   * runner could skip by saying nothing. See {@link FaceTurnRefusedError}.
   */
  readonly apiKeySource: string;
}

/**
 * The injected "run a turn" seam.
 *
 * **This adapter never spawns anything.** The harness already owns process
 * handling, session lifecycle, the `ANTHROPIC_API_KEY` strip and the timeout;
 * duplicating any of it here would produce a second, quieter copy of the rules.
 * `syl-chzl.4.2` supplies the real one, routed through
 * `services/conversation-service.ts` so `SOUL.md`, her memory and the fence
 * hold.
 */
export type FaceTurnRunner = (request: FaceTurnRequest) => Promise<FaceTurnAnswer>;

/* ------------------------------------------------------------------ *
 * Failures.
 * ------------------------------------------------------------------ */

/** A turn produced no result in time. Distinct from a turn that failed:
 * nothing is known about whether the work happened. */
export class FaceTurnTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Her turn produced no answer within ${timeoutMs}ms and the face stopped waiting for it.`);
    this.name = "FaceTurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A turn came back on the wrong payment rail and its answer was not spoken. */
export class FaceTurnRefusedError extends Error {
  readonly apiKeySource: string;

  constructor(apiKeySource: string) {
    super(
      `Refusing to speak a turn billed through "${apiKeySource}": Syl runs on subscription ` +
        `rails and requires apiKeySource === "none". A set ANTHROPIC_API_KEY silently ` +
        `outranks the claude.ai login.`,
    );
    this.name = "FaceTurnRefusedError";
    this.apiKeySource = apiKeySource;
  }
}

/** Nothing in the chat context to ask her about. */
export class FaceTurnEmptyError extends Error {
  constructor() {
    super("The session opened a turn with no user utterance in the chat context.");
    this.name = "FaceTurnEmptyError";
  }
}

/**
 * What she says when a turn did not produce an answer.
 *
 * Deliberately plain and deliberately short — `syl-chzl.4.3` owns the real
 * wording, and this exists so that the failure path is never silence in the
 * meantime. A face that freezes forever because a turn died is the worst
 * failure mode this adapter can have.
 */
export const DEFAULT_FAILURE_LINE = "Something went wrong on my end. Say that again?";

/** Milliseconds a face turn may take before the stream gives up on it.
 *
 * Far below `DEFAULT_TURN_TIMEOUT_MS`: a research turn may legitimately run for
 * minutes, but somebody is looking at her face, and a face waiting a minute for
 * a wedged turn is indistinguishable from a broken app. */
export const DEFAULT_FACE_TURN_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ *
 * The prompt.
 * ------------------------------------------------------------------ */

/** Text out of a `ChatContent[]`, which may hold images and audio frames too. */
function textOf(item: ChatItemLike): string | undefined {
  if (typeof item.textContent === "string" && item.textContent.trim() !== "") {
    return item.textContent;
  }
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content.filter((part): part is string => typeof part === "string");
  const joined = parts.join(" ").trim();
  return joined === "" ? undefined : joined;
}

/**
 * The latest thing the Commander said, out of the context the session hands us.
 *
 * **Only the latest**, and that is the point. Her session already holds the
 * history — it is a `--resume` against Claude Code's own transcript — so
 * replaying the whole `chatCtx` as a prompt would say everything to her twice
 * and pay for it twice. The context is the session's record; the transcript is
 * hers; this adapter carries the new sentence between them.
 *
 * Exported so the walk is a test rather than an assumption: a `FunctionCall`
 * sitting after his last message must not be mistaken for speech.
 */
export function lastUserUtterance(chatCtx: ChatContextLike): string | undefined {
  for (let i = chatCtx.items.length - 1; i >= 0; i -= 1) {
    const item = chatCtx.items[i];
    if (!item) continue;
    if (item.type !== undefined && item.type !== "message") continue;
    if (item.role !== "user") continue;
    const text = textOf(item);
    if (text !== undefined) return text;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The stream.
 * ------------------------------------------------------------------ */

export interface SylLLMOptions {
  /** How a turn is run. See {@link FaceTurnRunner}. */
  readonly runTurn: FaceTurnRunner;
  /** An existing face conversation to continue. */
  readonly sessionId?: string;
  /** Ceiling on one turn. Defaults to {@link DEFAULT_FACE_TURN_TIMEOUT_MS};
   * zero or less disables it. */
  readonly timeoutMs?: number;
  /** What she says when a turn failed. Defaults to {@link DEFAULT_FAILURE_LINE}. */
  readonly sayOnFailure?: (error: unknown) => string;
  /** Told about every failed turn, so a face that apologises is also a log line. */
  readonly onTurnFailed?: (error: unknown) => void;
}

/**
 * One turn's worth of stream: exactly one chunk, then done.
 *
 * Implements `AsyncIterableIterator<ChatChunk>` directly rather than extending
 * LiveKit's `LLMStream`, for the dependency reason at the top of this file. The
 * observable behaviour is the same one `LLMStream` provides — a queue that a
 * `run()` fills and closes — with the queue collapsed to its one real slot,
 * because a turn produces one answer.
 */
export class SylLLMStream implements AsyncIterableIterator<ChatChunk> {
  #chunk: ChatChunk | undefined;
  #done = false;
  #closed = false;
  #failure: unknown;
  /** Resolved when the turn has settled one way or the other. Every pull
   * awaits it, so a pull can never outlive the turn or precede it. */
  readonly #settled: Promise<void>;

  constructor(chatCtx: ChatContextLike, llm: SylLLM) {
    this.#settled = this.#run(chatCtx, llm);
  }

  /** Why the turn produced no answer, if it did not. `undefined` on success. */
  get failure(): unknown {
    return this.#failure;
  }

  /**
   * Run the turn and put its answer in the slot.
   *
   * Never rejects: every path here ends with something sayable in the slot,
   * because the alternative is a face that stops moving and never explains why.
   * The error is kept on {@link failure} and handed to `onTurnFailed`, so it is
   * survivable rather than invisible.
   */
  async #run(chatCtx: ChatContextLike, llm: SylLLM): Promise<void> {
    try {
      const prompt = lastUserUtterance(chatCtx);
      if (prompt === undefined) throw new FaceTurnEmptyError();

      const answer = await llm.take(prompt);
      // ONE chunk, whole. See the note at the top of this file before changing
      // this into a loop.
      this.#chunk = { id: randomUUID(), delta: { role: "assistant", content: answer.text } };
    } catch (error) {
      this.#failure = error;
      llm.reportFailure(error);
      this.#chunk = { id: randomUUID(), delta: { role: "assistant", content: llm.failureLine(error) } };
    }
  }

  async next(): Promise<IteratorResult<ChatChunk>> {
    if (this.#done || this.#closed) return { done: true, value: undefined };
    await Promise.race([this.#settled, this.#closedPromise()]);
    if (this.#closed) return { done: true, value: undefined };
    this.#done = true;
    const chunk = this.#chunk;
    // Cannot happen — `#run` always fills the slot — but `noUncheckedIndexedAccess`
    // strictness of thought applies to a field that a refactor could leave empty.
    if (chunk === undefined) return { done: true, value: undefined };
    return { done: false, value: chunk };
  }

  #closeSignal: (() => void) | undefined;

  /** A promise that settles when {@link close} is called, so an interruption
   * releases a pull that is waiting on a turn nobody is listening to. */
  #closedPromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.#closed) resolve();
      else this.#closeSignal = resolve;
    });
  }

  /** Stop. Any pull in flight completes as done. */
  close(): void {
    this.#closed = true;
    this.#closeSignal?.();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ChatChunk> {
    return this;
  }
}

/**
 * Syl, presented to a LiveKit session as a model.
 *
 * Structurally what `@livekit/agents`' abstract `LLM` requires of a subclass —
 * `label()` and `chat()` — with the session id held here rather than on the
 * stream, because it has to outlive a turn.
 */
export class SylLLM {
  readonly #runTurn: FaceTurnRunner;
  readonly #timeoutMs: number;
  readonly #sayOnFailure: (error: unknown) => string;
  readonly #onTurnFailed: ((error: unknown) => void) | undefined;
  #sessionId: string | undefined;

  constructor(options: SylLLMOptions) {
    this.#runTurn = options.runTurn;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_FACE_TURN_TIMEOUT_MS;
    this.#sayOnFailure = options.sayOnFailure ?? (() => DEFAULT_FAILURE_LINE);
    this.#onTurnFailed = options.onTurnFailed;
    this.#sessionId = options.sessionId;
  }

  label(): string {
    return "syl.SylLLM";
  }

  /**
   * The session the next turn will continue, once there has been one.
   *
   * Updated from the session the turn ACTUALLY ran on, never from the one we
   * asked for — the same call `SylAgent.#remember` makes. If the runner
   * declines the id offered and reports another, following the offered one
   * would resume a conversation she is not in.
   *
   * **A failed turn does not clear it.** A failure is not a lost conversation,
   * and dropping the id here would silently start a new thread on the next
   * thing he says — she would have forgotten the last minute of a conversation
   * she is still having.
   */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** Open a turn. Returns immediately; the turn runs behind the stream. */
  chat(options: ChatOptions): SylLLMStream {
    return new SylLLMStream(options.chatCtx, this);
  }

  /**
   * Run one turn against the seam: ask, bound the wait, adopt the session, check
   * the rail. Resolves only with an answer that may be spoken.
   *
   * Everything a turn is allowed to change about this object happens here and
   * nowhere else, so {@link SylLLMStream} is left with one job — putting an
   * answer into a chunk. That matters for the rail check in particular: the
   * refusal has to be between the answer arriving and the answer being said,
   * and there is exactly one place that can be.
   *
   * @internal — {@link SylLLMStream} is the only caller. Public because a
   * `#private` method is not reachable from a sibling class.
   */
  async take(prompt: string): Promise<FaceTurnAnswer> {
    const request: FaceTurnRequest = {
      prompt,
      ...(this.#sessionId === undefined ? {} : { resume: this.#sessionId }),
    };

    const answer = await this.#bounded(this.#runTurn(request));

    // Adopted before the rail is checked, deliberately: a refused turn still
    // HAPPENED, and a conversation that exists on Claude Code's side with no id
    // on ours is a conversation nothing can ever reach again. Same argument as
    // `runTurn`'s pre-spawn `onSessionId`.
    this.#sessionId = answer.sessionId;

    // Read off what the CLI reported, not off what we asked for. Constraint 3
    // is enforced upstream — this adapter spawns nothing and cannot strip the
    // variable — so what it enforces is that an answer billed to the metered
    // API is never spoken, whatever it says.
    if (answer.apiKeySource !== "none") throw new FaceTurnRefusedError(answer.apiKeySource);

    return answer;
  }

  /** The ceiling. The turn is not ours to kill — the harness owns that, and has
   * its own, longer timeout — so this bounds the WAIT and not the work. */
  async #bounded(turn: Promise<FaceTurnAnswer>): Promise<FaceTurnAnswer> {
    if (this.#timeoutMs <= 0) return turn;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        turn,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new FaceTurnTimeoutError(this.#timeoutMs)), this.#timeoutMs);
          // Unreffed so a lost race cannot hold the process open.
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @internal — see {@link take}. */
  reportFailure(error: unknown): void {
    this.#onTurnFailed?.(error);
  }

  /** @internal — see {@link take}. */
  failureLine(error: unknown): string {
    return this.#sayOnFailure(error);
  }
}
