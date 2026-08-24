import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The one client in this project that talks to a metered API.
 *
 * ## Why this does not break constraint 1
 *
 * *Subscription payment rails only* is about the thing that talks to Anthropic:
 * her thinking is billed to the claude.ai login and never to a per-token API,
 * and nothing here changes that. Renders are billed to a **separate Runway
 * account**, under a separate key, from a grant bought for exactly this. That
 * is why `RUNWAYML_API_SECRET` is its own variable and why `docs/VIDEO.md`
 * calls this "the one place in the project that spends metered money" rather
 * than a violation of the rule.
 *
 * ## Why the transport is injected
 *
 * So that no test can spend a credit or reach the network. `fetch` is a
 * constructor argument, every test passes a double, and the only place the real
 * one is reached for is a running service with a secret in its environment.
 *
 * ## Why nothing here throws
 *
 * The same promise `tools/client.ts` makes. A throw from this layer crosses the
 * MCP boundary as a stack trace and reaches the Commander as silence — or
 * worse, as Syl describing a video that does not exist. Every outcome is a
 * value carrying a sentence.
 */

export const RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1";

/** The version header Runway pins behaviour on. Same as `generate.mjs`. */
export const RUNWAY_API_VERSION = "2024-11-06";

/** Statuses that mean the story is over, however it ended. */
const TERMINAL: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELED", "CANCELLED"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** How a call went wrong, in a form she can turn into a sentence. */
export interface RunwayFailure {
  /** A complete sentence. Never empty, and never carrying the secret. */
  readonly message: string;
  readonly retryable: boolean;
}

export type RunwayResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: RunwayFailure };

/**
 * One picture and where in the clip it is pinned.
 *
 * Runway takes `promptImage` either as a bare URI — the first frame — or as an
 * array of these, which pins the first and last frames independently. Each
 * position may be used once; a repeat is a 400 naming `promptImage`, which is
 * how the array was confirmed to be validated rather than ignored.
 */
export interface PositionedImage {
  /** A data URI, or any URI Runway accepts. */
  readonly uri: string;
  readonly position: "first" | "last";
}

/**
 * The picture or pictures the video is built from.
 *
 * A bare string is frame one and nothing else. The array form is what lets a
 * clip open on the ribbon and still arrive at her face — see
 * `framing.ts`'s `LikenessAnchor`.
 */
export type PromptImage = string | readonly PositionedImage[];

/** Everything every model on the roster takes. Mirrors `POST /image_to_video`. */
interface SubmitCommon {
  readonly model: string;
  /**
   * The frames Runway is given, as data URIs.
   *
   * **Not a style hint.** Whatever is at `first` is literally frame one, and
   * seedance2 takes the video's aspect from it — measured 2026-08-11, and it
   * silently overrules `ratio`. When a `last` picture is sent too it is fitted
   * into that same shape rather than changing it.
   *
   * **Only the positions the model declares.** `grok_imagine_1_5` answers
   * *"Too big: expected array to have <=1 items"* to the two-slot form, so the
   * array is built from `ModelNote.positions` rather than from a habit.
   */
  readonly promptImage: PromptImage;
  readonly promptText: string;
  readonly duration: number;
}

/** A model whose geometry is a ratio. Every seedance. */
export interface SubmitByRatio extends SubmitCommon {
  readonly ratio: string;
  readonly resolution?: never;
}

/** A model whose geometry is a resolution band. `grok_imagine_1_5`. */
export interface SubmitByResolution extends SubmitCommon {
  readonly resolution: string;
  readonly ratio?: never;
}

/**
 * What Runway is asked for, shaped the way the chosen model is shaped.
 *
 * **A union rather than two optional fields, because the two keys are mutually
 * exclusive at the API and the validator is strict about it**: `ratio` on
 * `grok_imagine_1_5` is an *Unrecognized key*, and `resolution` on any seedance
 * is the same. `ModelNote.shape` says which arm a model takes, so sending the
 * wrong key is now a compile error rather than a 400 discovered by a render.
 */
export type SubmitSpec = SubmitByRatio | SubmitByResolution;

/** A task, as far as this module reads one. */
export interface RunwayTask {
  readonly id: string;
  readonly status: string;
  /** Where the finished video is. Empty until it succeeds. */
  readonly output: readonly string[];
  /**
   * Runway's own code for why it refused, exactly as Runway spelled it.
   *
   * `null` on a task that did not fail, and `null` rather than `""` so that
   * "this did not fail" and "this failed and said nothing" stay different
   * facts.
   *
   * **Kept because not keeping it cost a day.** Five renders failed across two
   * durations on 23-24 August and every one was recorded as our own sentence,
   * *"Runway ended this render as FAILED."* — which contains none of theirs. So
   * five failures with at least two distinct causes were indistinguishable, and
   * a wrong cause was reported for them with confidence. What was being read
   * was our summary of an error nobody had kept.
   */
  readonly failureCode: string | null;
  /** What Runway said, in its own words. Trimmed if it is long; never rewritten. */
  readonly failure: string | null;
}

/**
 * What kind of problem a refusal is, which decides whose problem it is.
 *
 * - `moderation` — a model provider declined the prompt. **Not a bug**, and it
 *   must not read as one: there is nothing here to fix, only something to say
 *   differently. Sending someone to hunt for a defect in a working system is
 *   the specific harm of conflating this with the one below.
 * - `rejected_input` — the request was refused as invalid. Ours, and a real
 *   defect somewhere in what we sent.
 * - `upstream` — Runway's own machinery broke. Nobody's fault here, and the one
 *   kind where trying again is a reasonable answer.
 * - `unknown` — a code nobody has classified. Deliberately its own answer
 *   rather than a default into any of the three: a guess here becomes a
 *   sentence she says to him as fact.
 */
export type FailureKind = "moderation" | "rejected_input" | "upstream" | "unknown";

/**
 * Which of the four a code is.
 *
 * **Order is load-bearing.** `INPUT_PREPROCESSING.SAFETY.THIRD_PARTY` — a real
 * captured code, from the render that was moderated — matches both the safety
 * rule and the input rule, and reading it as an input fault turns a decision
 * somebody else made into a bug hunt for something that is not broken. Safety
 * is therefore asked first.
 *
 * Matched on segments rather than on whole strings, because Runway composes
 * these from parts and the same fact appears in more than one arrangement.
 */
export function failureKindOf(code: string | null): FailureKind {
  if (code === null || code.trim() === "") return "unknown";
  const segments = code.toUpperCase().split(/[.\-_\s]+/u);
  const has = (word: string): boolean => segments.includes(word);

  if (has("SAFETY") || has("MODERATION") || has("MODERATED")) return "moderation";
  if (has("VALIDATION") || has("PREPROCESSING") || has("INVALID")) return "rejected_input";
  if (has("INTERNAL")) return "upstream";
  return "unknown";
}

/**
 * What `RenderService` needs from Runway, and nothing more.
 *
 * The seam the tests stand on. Declared as an interface rather than as "the
 * class, mocked" so a double is a value with three methods rather than a
 * partial impersonation of an HTTP client.
 */
export interface RenderBackend {
  submit(spec: SubmitSpec): Promise<RunwayResult<{ readonly id: string }>>;
  task(id: string): Promise<RunwayResult<RunwayTask>>;
  /** Streams the finished render to `to`, and answers with the byte count. */
  download(url: string, to: string): Promise<RunwayResult<number>>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RunwayClientOptions {
  readonly secret: string;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
}

/** Anything Runway said back, trimmed to something readable in a sidecar. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * Something Runway said, or `null` because it said nothing.
 *
 * A non-string is `null` rather than `String(value)`: an object stringified
 * into a failure message reads as `[object Object]` in the one field whose
 * whole job is to be quotable.
 */
function said(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const kept = excerpt(value);
  return kept === "" ? null : kept;
}

export class RunwayClient implements RenderBackend {
  readonly #secret: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(options: RunwayClientOptions) {
    if (options.secret.trim() === "") {
      // A client with no secret would answer 401 to everything and report a
      // hundred identical failures instead of one missing credential. The
      // *absence* of a secret is handled a layer up, where it is an ordinary
      // state of a machine rather than a programming error.
      throw new Error("RunwayClient was constructed without a secret.");
    }
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? RUNWAY_API_BASE).replace(/\/+$/u, "");
  }

  async submit(spec: SubmitSpec): Promise<RunwayResult<{ readonly id: string }>> {
    const answered = await this.#json("POST", "/image_to_video", spec);
    if (!answered.ok) return answered;

    const id = (answered.data as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return {
        ok: false,
        failure: {
          message:
            "Runway accepted the render and did not say which task it is, so there is nothing " +
            "to follow. Nothing has been rendered.",
          retryable: true,
        },
      };
    }
    return { ok: true, data: { id } };
  }

  async task(id: string): Promise<RunwayResult<RunwayTask>> {
    const answered = await this.#json("GET", `/tasks/${encodeURIComponent(id)}`);
    if (!answered.ok) return answered;

    const body = answered.data as {
      id?: unknown;
      status?: unknown;
      output?: unknown;
      artifacts?: unknown;
      failure?: unknown;
      failureCode?: unknown;
    };
    // Both spellings, because the API has used both and `generate.mjs` reads
    // both. A finished render whose URL is under the field we did not check
    // looks exactly like a render that produced nothing.
    const urls = Array.isArray(body.output) ? body.output : Array.isArray(body.artifacts) ? body.artifacts : [];

    return {
      ok: true,
      data: {
        id: typeof body.id === "string" ? body.id : id,
        status: typeof body.status === "string" ? body.status : "UNKNOWN",
        output: urls.filter((url): url is string => typeof url === "string"),
        // Both trimmed by `excerpt` rather than dropped when they run long.
        // Truncating loses the tail of an explanation; replacing it with our
        // own words loses the explanation.
        failureCode: said(body.failureCode),
        failure: said(body.failure),
      },
    };
  }

  async download(url: string, to: string): Promise<RunwayResult<number>> {
    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (error) {
      return { ok: false, failure: { message: this.#unreachable("the finished render", error), retryable: true } };
    }

    if (!response.ok || response.body === null) {
      return {
        ok: false,
        failure: {
          message: `Runway answered ${String(response.status)} for the finished render, so it is not on disk.`,
          retryable: response.status >= 500,
        },
      };
    }

    let bytes = 0;
    try {
      const counted = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      counted.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      await pipeline(counted, createWriteStream(to));
    } catch (error) {
      // A partial file is worse than none: a truncated mp4 on disk reads to
      // every later check as a finished render, and `see_myself` would go and
      // pull frames out of it.
      await rm(to, { force: true });
      return {
        ok: false,
        failure: {
          message: `The render stopped downloading part-way (${
            error instanceof Error ? error.message : String(error)
          }), so nothing was kept.`,
          retryable: true,
        },
      };
    }

    return { ok: true, data: bytes };
  }

  /** One JSON call, and every way it can end. */
  async #json(method: string, path: string, body?: unknown): Promise<RunwayResult<unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          // Note what is NOT here: this object never reaches a message, a log
          // line or a sidecar. The secret goes on the wire and nowhere else.
          Authorization: `Bearer ${this.#secret}`,
          "X-Runway-Version": RUNWAY_API_VERSION,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { ok: false, failure: { message: this.#unreachable(`${method} ${path}`, error), retryable: true } };
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          message: `Runway answered ${String(response.status)} to ${method} ${path}: ${excerpt(text)}`,
          // 4xx is a decision — out of credits, a moderated prompt — and
          // repeating it produces the same answer and, on some of them, the
          // same charge. 5xx is worth trying again.
          retryable: response.status >= 500 || response.status === 429,
        },
      };
    }

    try {
      return { ok: true, data: text === "" ? {} : (JSON.parse(text) as unknown) };
    } catch {
      return {
        ok: false,
        failure: {
          message: `Runway answered ${method} ${path} with something that is not JSON: ${excerpt(text)}`,
          retryable: false,
        },
      };
    }
  }

  #unreachable(what: string, error: unknown): string {
    return (
      `Runway is not answering for ${what} (${error instanceof Error ? error.message : String(error)}), ` +
      "so nothing has been rendered."
    );
  }
}
