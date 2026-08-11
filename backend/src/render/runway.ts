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

/** What Runway is asked for. Mirrors `POST /image_to_video`. */
export interface SubmitSpec {
  readonly model: string;
  /**
   * The frames Runway is given, as data URIs.
   *
   * **Not a style hint.** Whatever is at `first` is literally frame one, and
   * seedance2 takes the video's aspect from it — measured 2026-08-11, and it
   * silently overrules `ratio`. When a `last` picture is sent too it is fitted
   * into that same shape rather than changing it.
   */
  readonly promptImage: PromptImage;
  readonly promptText: string;
  readonly ratio: string;
  readonly duration: number;
}

/** A task, as far as this module reads one. */
export interface RunwayTask {
  readonly id: string;
  readonly status: string;
  /** Where the finished video is. Empty until it succeeds. */
  readonly output: readonly string[];
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

    const body = answered.data as { id?: unknown; status?: unknown; output?: unknown; artifacts?: unknown };
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
