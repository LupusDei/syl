import { readStructured, type ReaderTurnOptions } from "../harness/reader.js";
import { systemClock, type Clock } from "../services/clock.js";
import { UnreadableDocument, chunkDocument, parseDocument, DEFAULT_CHUNK_CHARS } from "./document.js";
import { EXTRACT_INSTRUCTION, asChunkExtract, type ChunkExtract } from "./extract.js";
import { FetchRefused, safeFetch, type FetchResult } from "./fetch.js";
import {
  contentHashOf,
  type IntakeChannel,
  type IntakeSource,
  type IntakeStore,
  type StoredExtract,
} from "./intake-store.js";
import { readingOf, type Reading } from "./intake-view.js";
import { classifyRetention, type RetentionClass } from "./retention.js";

/**
 * Article intake, end to end.
 *
 * ## The thesis this implements
 *
 * > The model that reads the untrusted text has no tools and no memory. The
 * > model that has tools and memory never reads the untrusted text.
 *
 * Every byte a source produces reaches a model through exactly one call in
 * this file — `readStructured`, which runs `runReaderTurn`: `--tools ""`, no
 * MCP config, no pre-authorisation, a session that is never resumed, and a
 * reply that is schema-validated or thrown away. **Nothing here may ever call
 * `runTurn`.** If a future step needs to summarise a source for the Commander,
 * it summarises the *extract*, which has already crossed the gate.
 *
 * ## A book is not one turn
 *
 * {@link ArticleIntake.advance} performs **exactly one step** and returns. A
 * thirty-chapter book is thirty calls, spread over as many nights as it takes;
 * an article is three. Each step is idempotent — re-running it converges on
 * the same rows rather than adding more — so a crash resumes rather than
 * restarting, and nothing is lost.
 *
 * That makes intake a queue of small resumable jobs, which is exactly the
 * shape the job runner (`syl-002.3.1`) exists to drive. It is not built here:
 * see {@link IntakeScheduler} for the interface intake needs from it, and note
 * that two schedulers would be worse than none.
 *
 * ## Failures are sorted into permanent and retryable
 *
 * An SSRF refusal, a redirect off-host, an unparseable document and a reply
 * that fails the schema gate are all permanent: repeating them produces the
 * same answer and costs another turn. A timeout or a transport error is not.
 * A retryable failure leaves the stage where it was, with the reason recorded,
 * so the same step runs again later instead of the source silently dying.
 *
 * ## And a failure is a sentence Syl wrote, never one the page did
 *
 * `syl-r1t`. The reason a step stopped is stored on the source and read back
 * by anything that asks about it — including, since `read_this`, a turn that
 * holds MCP tools. Two of the throwers on this ladder quote text an attacker
 * controls: `ReaderOutputError` carries the first 120 characters of the reply,
 * and the schema gate refuses an unexpected key **by naming it**. Both are
 * written by whoever wrote the document, and a refusal is precisely where
 * nobody looks for a payload.
 *
 * So {@link safeReason} decides what may be stored, from the error's class
 * rather than from its message, and everything else becomes a fixed sentence.
 * The full detail is not lost — it goes to `onQuarantined`, which reaches the
 * operator's log. `AGENT_SURFACE` keeps `/logs` out of Syl's reach, so that is
 * a channel the payload cannot arrive back through.
 */

/**
 * What intake needs from the job system, which is being built in another lane.
 *
 * Deliberately the smallest possible surface: intake never wants to know about
 * timers, concurrency or catch-up policy — it wants to say "call me again for
 * this source, no sooner than then" and go away.
 */
export interface IntakeScheduler {
  schedule(job: { readonly sourceId: string; readonly notBefore: number }): void;
}

/**
 * Where a validated extract goes next.
 *
 * The memory graph is child A's and does not exist yet. Until it does, the
 * graft step calls this and marks the source done; the extracts stay in the
 * store with their provenance, which is what a later graft will read.
 */
export interface GraftSink {
  graft(input: {
    readonly source: IntakeSource;
    readonly extracts: readonly StoredExtract[];
  }): void | Promise<void>;
}

/**
 * Reader options an intake caller may set.
 *
 * Everything except the one that could disarm the boundary.
 */
export type SafeReaderOptions = Omit<ReaderTurnOptions, "requireEmptyToolSurface">;

/** How long to wait before retrying a step that failed for a transient reason. */
export const RETRY_DELAY_MS = 5 * 60_000;

export interface ArticleIntakeOptions {
  readonly store: IntakeStore;
  readonly clock?: Clock;
  /**
   * The fetcher. Defaults to {@link safeFetch}, which is the SSRF guard.
   *
   * Injectable so a test can drive the ladder without a network, and for no
   * other reason: **a caller that substitutes an unguarded fetch here has
   * removed the control that stops a hostile link reaching the tailnet.**
   */
  readonly fetch?: (url: string) => Promise<FetchResult>;
  /**
   * Passed through to the reader turn — a `claudeBin` override, a model, a
   * timeout.
   *
   * `requireEmptyToolSurface` is deliberately **not** in this type and is not
   * forwarded. `runReaderTurn` accepts it so its own tests can reach the checks
   * further down; letting an intake caller set it would turn the one assertion
   * that survives a CLI change into an option somebody can switch off.
   */
  readonly readerOptions?: SafeReaderOptions;
  readonly scheduler?: IntakeScheduler;
  readonly graft?: GraftSink;
  /** Characters per reader turn. Defaults to {@link DEFAULT_CHUNK_CHARS}. */
  readonly chunkChars?: number;
  /** Refuse a document that would need more turns than this. */
  readonly maxChunks?: number;
  /**
   * Where the detail of a failure goes when the stored sentence cannot carry
   * it. Defaults to `console.warn`.
   *
   * This is the operator's channel, and it is the reason {@link safeReason} is
   * a quarantine rather than a deletion: whatever was thrown is still readable
   * by the person debugging it, and unreachable from the one surface where it
   * would be an instruction.
   */
  readonly onQuarantined?: (detail: string, sourceId: string) => void;
}

/** A link to ingest. */
export interface IntakeRequest {
  readonly url: string;
  readonly channel: IntakeChannel;
  /**
   * Who asked. An authorisation fact and never a trust fact: the sender being
   * the Commander establishes that the request is allowed, never that the
   * payload may do anything.
   */
  readonly requestedBy: string;
  /** Overrides the classifier. */
  readonly retention?: RetentionClass;
}

/** What one step did. */
export interface AdvanceResult {
  readonly source: IntakeSource;
  /** True when this call moved the ladder forward. */
  readonly progressed: boolean;
  /** Why the step stopped, if it did. */
  readonly failure: { readonly message: string; readonly retryable: boolean } | null;
}

/** Refusals that will produce the same answer next time. */
const PERMANENT_FETCH_REASONS = new Set([
  "scheme",
  "malformed_url",
  "blocked_address",
  "cross_host_redirect",
  "too_many_redirects",
  "too_large",
]);

/** How many chunks a single article may become before Syl refuses it. */
export const DEFAULT_MAX_CHUNKS = 200;

export class ArticleIntake {
  readonly #store: IntakeStore;
  readonly #clock: Clock;
  readonly #fetch: (url: string) => Promise<FetchResult>;
  readonly #readerOptions: SafeReaderOptions;
  readonly #scheduler: IntakeScheduler | null;
  readonly #graft: GraftSink | null;
  readonly #chunkChars: number;
  readonly #maxChunks: number;
  readonly #onQuarantined: (detail: string, sourceId: string) => void;

  constructor(options: ArticleIntakeOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#fetch = options.fetch ?? ((url) => safeFetch(url));
    this.#readerOptions = options.readerOptions ?? {};
    this.#scheduler = options.scheduler ?? null;
    this.#graft = options.graft ?? null;
    this.#chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
    this.#maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.#onQuarantined =
      options.onQuarantined ??
      ((detail, sourceId): void => {
        console.warn(`[syl] intake ${sourceId} stopped: ${detail}`);
      });
  }

  /**
   * Accept a link, assign its retention class, and record it at the first step.
   *
   * Nothing is fetched here. Submission is cheap and synchronous so the caller
   * — an HTTP handler, the mail poller — can answer immediately; the work
   * happens when someone calls {@link advance}.
   */
  submit(request: IntakeRequest): { readonly source: IntakeSource; readonly created: boolean } {
    const decision = classifyRetention({ url: request.url, requested: request.retention });

    const result = this.#store.create({
      url: request.url,
      channel: request.channel,
      requestedBy: request.requestedBy,
      retention: decision.retention,
      retentionReason: decision.reason,
    });

    if (result.created) this.#ask(result.source.id, 0);
    return result;
  }

  /**
   * One source by id, or `null`.
   *
   * The read side of the ladder, so a caller that has a source id — the HTTP
   * route, the job handler deciding whether a step will spawn a turn — does
   * not need its own handle on the store, and cannot reach the writes.
   */
  get(sourceId: string): IntakeSource | null {
    return this.#store.get(sourceId);
  }

  /**
   * One source and everything it has read, in the shape a turn may hold.
   *
   * **This is what `read_this` answers with, and the difference from
   * {@link get} is a security boundary rather than a convenience.** The row
   * carries the page's own `<title>`, which is raw response bytes; a
   * {@link Reading} has nowhere to put it. See `intake-view.ts`.
   */
  reading(sourceId: string): Reading | null {
    const source = this.#store.get(sourceId);
    return source === null ? null : readingOf(source, this.#store.extracts(sourceId));
  }

  /**
   * How many sources one principal has submitted since an instant.
   *
   * The count behind the ceiling on ad-hoc reading. Here rather than in the
   * route for the same reason {@link get} is: a caller with a source id should
   * not need its own handle on the store, and must not be able to reach the
   * writes to get one.
   */
  readsSince(requestedBy: string, since: string): number {
    return this.#store.countSince(requestedBy, since);
  }

  /** Sources that still have a step to run, oldest first. */
  pending(): readonly IntakeSource[] {
    return this.#store.pending();
  }

  /**
   * Perform exactly one step of one source's ladder.
   *
   * One step, not "as many as fit": that is what keeps a book from becoming a
   * turn nobody can afford and what lets the job runner interleave, pause and
   * resume it.
   */
  async advance(sourceId: string): Promise<AdvanceResult> {
    const source = this.#store.get(sourceId);
    if (source === null) {
      throw new Error(`advance: there is no intake source ${sourceId}.`);
    }

    switch (source.stage) {
      case "fetch":
        return this.#fetchStep(source);
      case "read":
        return this.#readStep(source);
      case "graft":
        return this.#graftStep(source);
      default:
        // Terminal. Idempotent by construction: asking again does nothing.
        return { source, progressed: false, failure: null };
    }
  }

  /**
   * Run steps until the source is terminal or nothing more can be done now.
   *
   * For tests and for a caller with no job runner. Production drives
   * {@link advance} from the queue so a long document cannot monopolise a
   * process.
   */
  async drain(sourceId: string, options: { readonly maxSteps?: number } = {}): Promise<IntakeSource> {
    const maxSteps = options.maxSteps ?? this.#maxChunks + 8;

    for (let step = 0; step < maxSteps; step += 1) {
      const result = await this.advance(sourceId);
      if (!result.progressed) return result.source;
    }

    throw new Error(`drain: ${sourceId} did not finish within ${maxSteps} steps.`);
  }

  // ------------------------------------------------------------- the steps ---

  /** Fetch, parse and chunk. No model runs in this step. */
  async #fetchStep(source: IntakeSource): Promise<AdvanceResult> {
    let fetched: FetchResult;
    try {
      fetched = await this.#fetch(source.url);
    } catch (error) {
      const refusal = error instanceof FetchRefused ? error : null;
      const retryable = refusal === null || !PERMANENT_FETCH_REASONS.has(refusal.reason);
      return this.#failFrom(source, error, retryable);
    }

    if (fetched.status < 200 || fetched.status >= 300) {
      // 4xx is the server saying no and 5xx is the server saying not now.
      return this.#fail(source, `${source.url} answered ${fetched.status}.`, fetched.status >= 500);
    }

    let chunks;
    let title: string | null;
    let mediaType: string;
    try {
      const parsed = parseDocument(fetched.body, fetched.headers["content-type"]);
      title = parsed.title;
      mediaType = parsed.mediaType;
      chunks = chunkDocument(parsed.text, { maxChars: this.#chunkChars });
    } catch (error) {
      // An unreadable document reads the same way every time, and so does a
      // parse that threw for any other reason. Nothing here is worth a retry.
      return this.#failFrom(source, error, false);
    }

    if (chunks.length === 0) {
      return this.#fail(source, "That document had no readable text in it.", false);
    }
    if (chunks.length > this.#maxChunks) {
      return this.#fail(
        source,
        `That document would take ${chunks.length} reader turns, over the ${this.#maxChunks} limit.`,
        false,
      );
    }

    this.#store.putChunks(source.id, chunks);
    const updated = this.#store.update(source.id, {
      stage: "read",
      title,
      mediaType,
      bytes: fetched.bytes,
      contentHash: contentHashOf(fetched.body),
      chunkCount: chunks.length,
      failure: null,
    });

    this.#ask(source.id, 0);
    return { source: updated, progressed: true, failure: null };
  }

  /**
   * Read one chunk, in a turn that cannot act.
   *
   * This is the only place in intake where a model sees a source's words, and
   * `readStructured` is the only way it is allowed to. The reply is validated
   * by {@link asChunkExtract} or discarded — there is no best-effort parse.
   */
  async #readStep(source: IntakeSource): Promise<AdvanceResult> {
    const chunks = this.#store.chunks(source.id);
    const done = new Set(this.#store.extracts(source.id).map((extract) => extract.chunkIndex));
    const next = chunks.find((chunk) => !done.has(chunk.index));

    if (next === undefined) {
      const updated = this.#store.update(source.id, { stage: "graft", failure: null });
      this.#ask(source.id, 0);
      return { source: updated, progressed: true, failure: null };
    }

    let extract: ChunkExtract;
    try {
      extract = await readStructured(
        { instruction: EXTRACT_INSTRUCTION, untrusted: next.text },
        asChunkExtract,
        this.#readerOptions,
      );
    } catch (error) {
      // Every reader failure is permanent for this source: a capability error
      // means the boundary itself is not holding and must not be retried in a
      // loop, and a schema failure means the reply was discarded on purpose.
      //
      // THE ONE CATCH ON THIS LADDER THAT HOLDS ATTACKER-WRITTEN TEXT. What
      // was thrown here quotes the reply, and the reply was composed under the
      // influence of the document. `#failFrom` stores a sentence chosen from
      // the error's class and sends the rest to the operator.
      return this.#failFrom(source, error, false);
    }

    this.#store.putExtract({
      sourceId: source.id,
      chunkIndex: next.index,
      start: next.start,
      end: next.end,
      retention: source.retention,
      extract,
    });

    this.#ask(source.id, 0);
    return {
      source: this.#store.update(source.id, { failure: null }),
      progressed: true,
      failure: null,
    };
  }

  /** Hand the validated extracts on, and close the ladder. */
  async #graftStep(source: IntakeSource): Promise<AdvanceResult> {
    const extracts = this.#store.extracts(source.id);

    if (this.#graft !== null) {
      try {
        await this.#graft.graft({ source, extracts });
      } catch (error) {
        // The graph being unavailable is not the source's fault.
        return this.#failFrom(source, error, true);
      }
    }

    return {
      source: this.#store.update(source.id, { stage: "done", failure: null }),
      progressed: true,
      failure: null,
    };
  }

  // ------------------------------------------------------------- internals ---

  /**
   * Record a failure from whatever was thrown, quarantining the detail.
   *
   * The stored sentence comes from {@link safeReason}, which reads the error's
   * CLASS and not its message. The message itself goes to the operator, so
   * nothing is lost and nothing an attacker wrote is kept where Syl can read
   * it back.
   */
  #failFrom(source: IntakeSource, error: unknown, retryable: boolean): AdvanceResult {
    const detail = message(error);
    const stored = safeReason(error);
    if (detail !== stored) this.#onQuarantined(detail, source.id);
    return this.#fail(source, stored, retryable);
  }

  /** Record a failure, and decide whether the same step runs again. */
  #fail(source: IntakeSource, reason: string, retryable: boolean): AdvanceResult {
    const updated = this.#store.update(source.id, {
      failure: reason,
      ...(retryable ? {} : { stage: "failed" as const }),
    });

    if (retryable) this.#ask(source.id, RETRY_DELAY_MS);

    return { source: updated, progressed: false, failure: { message: reason, retryable } };
  }

  /** Ask the job system to call `advance` again. A no-op without one. */
  #ask(sourceId: string, delayMs: number): void {
    this.#scheduler?.schedule({ sourceId, notBefore: this.#clock() + delayMs });
  }
}

/** Whatever was thrown, as a sentence. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one sentence a failure is allowed to leave on the source.
 *
 * **An allowlist by error class, and it has to be.** The alternative — scanning
 * a message for anything that looks like page text — is a filter, and a filter
 * has to be right about every input while an allowlist only has to be right
 * about the classes it names. Anything unrecognised gets the fixed sentence,
 * so a new thrower added next month is quarantined by default rather than
 * trusted by default.
 *
 * What is allowed through, and why each is safe:
 *
 * - **{@link FetchRefused}** is assembled from the submitted URL, the host, the
 *   address class and numeric limits. On every reason but `transport` no body
 *   has been read at all, and `transport` carries Node's own socket error.
 *   None of it is under the document's control, and it is the most useful
 *   refusal she can be given: "that address is on your tailnet" is an answer.
 * - **{@link UnreadableDocument}** has two messages, both literals in
 *   `document.ts`, and no model runs before it is thrown.
 *
 * What is deliberately NOT allowed through is everything from the reader:
 * `ReaderOutputError` quotes the reply's first 120 characters, and the schema
 * gate refuses an unexpected key by naming it. Both are chosen by whoever wrote
 * the page.
 */
export function safeReason(error: unknown): string {
  if (error instanceof FetchRefused) return error.message;
  if (error instanceof UnreadableDocument) return error.message;
  // Everything else, including every way a reader turn can fail. Said in her
  // own words rather than as a code, because she has to repeat it to him — and
  // said the same way whether the reply was malformed, oversized or hostile,
  // because telling those apart is the operator's job and the log's.
  return "Syl read that page and what came back was not something she could keep, so it was discarded.";
}
