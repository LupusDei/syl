import {
  RUNWAY_API_BASE,
  RUNWAY_API_VERSION,
  RunwayClient,
  type FetchLike,
  type RunwayResult,
} from "../render/runway.js";

/**
 * The client that turns her words into audio.
 *
 * ## The request shape, and how it was found
 *
 * `POST /v1/text_to_speech` refused fifteen guesses at `voice.type` before
 * anybody probed it properly. The technique that settled it is the one
 * `RUNWAY_API_INDEX.md` documents — POST an empty body, read `issues[]`, add
 * one field, read again:
 *
 *     {}                                  -> discriminator is `model`
 *     { model }                           -> `promptText` and `voice` required
 *     { model, promptText, voice: {} }    -> discriminator is `voice.type`
 *     { …, model: "zzzz" }                -> models are seed_audio,
 *                                            eleven_multilingual_v2, eleven_v3
 *
 * `voice.type` is the one field the validator will not enumerate: a
 * discriminator miss answers `{"errors":[],"note":"No matching discriminator"}`
 * with no values. It was settled from the published schema instead —
 * `https://docs.dev.runwayml.com/openapi.json`, which is public and complete,
 * cross-checked against the types in the `@runwayml/sdk` tarball and then
 * confirmed against the live validator. Three values are legal and no more:
 * `runway-preset` and `seed-preset`, each naming a stock voice from a fixed
 * enum, and `reference-audio`, which carries a clip.
 *
 * **A custom voice id is not one of them.** See `her-voice.ts` for what follows
 * from that; the short version is that her clip goes on the wire, not her id.
 *
 * ## What is reused rather than repeated
 *
 * Polling and downloading are endpoint-agnostic — `GET /v1/tasks/{id}` and a
 * signed URL — so this composes `RunwayClient` for both rather than owning a
 * second copy of them. Only the submission is different, because only the body
 * is different.
 *
 * ## Why nothing here throws
 *
 * The promise `render/runway.ts` makes, for the same reason. A throw from this
 * layer reaches the Commander as silence, or worse as Syl describing a video
 * whose audio does not exist. Every outcome is a value carrying a sentence.
 */

/** What Runway is asked to say, and in whose voice. */
export interface SpeechSpec {
  readonly model: "seed_audio";
  /** Her words, verbatim. `seed_audio` speaks this rather than interpreting it. */
  readonly promptText: string;
  /** Her reference clip, already trimmed to what the model accepts. */
  readonly referenceMp3: Buffer;
  readonly outputFormat: "mp3";
}

/** The body, exactly as it goes on the wire. Separated so a test can read it. */
export interface SpeechBody {
  readonly model: string;
  readonly promptText: string;
  readonly voice: { readonly type: "reference-audio"; readonly audioUri: string };
  readonly outputFormat: string;
}

export function speechBody(spec: SpeechSpec): SpeechBody {
  return {
    model: spec.model,
    promptText: spec.promptText,
    voice: {
      // The discriminator. The one member of this union that carries a voice
      // rather than naming a stock preset.
      type: "reference-audio",
      audioUri: `data:audio/mp3;base64,${spec.referenceMp3.toString("base64")}`,
    },
    outputFormat: spec.outputFormat,
  };
}

/** A speech task, as far as this module reads one. */
export interface SpeechTask {
  readonly id: string;
  readonly status: string;
  /** Where the finished mp3 is. Empty until it succeeds. */
  readonly output: readonly string[];
  /**
   * What it actually cost, once Runway says.
   *
   * Read from the task rather than from a rate table: there is no published
   * per-character rate for `seed_audio`, and `render/credits.ts` is explicit
   * that a confident wrong number is worse than an absent one.
   */
  readonly credits: number | null;
}

/** Her voice on the organisation, and the clip that demonstrates it. */
export interface VoicePreview {
  readonly name: string;
  readonly previewUrl: string;
}

/** What `VoiceService` needs from Runway, and nothing more. */
export interface SpeechBackend {
  submit(spec: SpeechSpec): Promise<RunwayResult<{ readonly id: string; readonly estimatedCredits: number | null }>>;
  task(id: string): Promise<RunwayResult<SpeechTask>>;
  /** Streams the finished clip to `to`, and answers with the byte count. */
  download(url: string, to: string): Promise<RunwayResult<number>>;
  /** Where to fetch her reference clip from, once. */
  preview(voiceId: string): Promise<RunwayResult<VoicePreview>>;
}

export interface SpeechClientOptions {
  readonly secret: string;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
}

/** Anything Runway said back, trimmed to something readable in a sidecar. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

export class RunwaySpeechClient implements SpeechBackend {
  readonly #secret: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  /** Composed for the two halves that are the same for every kind of task. */
  readonly #tasks: RunwayClient;

  constructor(options: SpeechClientOptions) {
    if (options.secret.trim() === "") {
      // A client with no secret would answer 401 to everything and report a
      // hundred identical failures instead of one missing credential.
      throw new Error("RunwaySpeechClient was constructed without a secret.");
    }
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? RUNWAY_API_BASE).replace(/\/+$/u, "");
    this.#tasks = new RunwayClient(options);
  }

  async submit(
    spec: SpeechSpec,
  ): Promise<RunwayResult<{ readonly id: string; readonly estimatedCredits: number | null }>> {
    const answered = await this.#json("POST", "/text_to_speech", speechBody(spec));
    if (!answered.ok) return answered;

    const body = answered.data as { id?: unknown; estimatedCost?: { credits?: unknown } };
    if (typeof body.id !== "string" || body.id === "") {
      return {
        ok: false,
        failure: {
          message:
            "Runway accepted the speech and did not say which task it is, so there is nothing to " +
            "follow. Nothing has been said.",
          retryable: true,
        },
      };
    }

    const estimate = body.estimatedCost?.credits;
    return {
      ok: true,
      data: {
        id: body.id,
        estimatedCredits: typeof estimate === "number" && Number.isFinite(estimate) ? estimate : null,
      },
    };
  }

  async task(id: string): Promise<RunwayResult<SpeechTask>> {
    const answered = await this.#json("GET", `/tasks/${encodeURIComponent(id)}`);
    if (!answered.ok) return answered;

    const body = answered.data as {
      id?: unknown;
      status?: unknown;
      output?: unknown;
      artifacts?: unknown;
      cost?: { credits?: unknown };
    };
    // Both spellings, for the reason `render/runway.ts` gives: a finished task
    // whose URL is under the field we did not check looks exactly like one that
    // produced nothing.
    const urls = Array.isArray(body.output) ? body.output : Array.isArray(body.artifacts) ? body.artifacts : [];
    const credits = body.cost?.credits;

    return {
      ok: true,
      data: {
        id: typeof body.id === "string" ? body.id : id,
        status: typeof body.status === "string" ? body.status : "UNKNOWN",
        output: urls.filter((url): url is string => typeof url === "string"),
        credits: typeof credits === "number" && Number.isFinite(credits) ? credits : null,
      },
    };
  }

  download(url: string, to: string): Promise<RunwayResult<number>> {
    return this.#tasks.download(url, to);
  }

  async preview(voiceId: string): Promise<RunwayResult<VoicePreview>> {
    const answered = await this.#json("GET", `/voices/${encodeURIComponent(voiceId)}`);
    if (!answered.ok) return answered;

    const body = answered.data as { name?: unknown; status?: unknown; previewUrl?: unknown };
    const name = typeof body.name === "string" ? body.name : voiceId;

    if (typeof body.previewUrl !== "string" || body.previewUrl === "") {
      // A voice that is still processing has no clip yet, and one that failed
      // never will. Neither is "she has no voice" — the record says which.
      return {
        ok: false,
        failure: {
          message:
            `Runway has no sample of "${name}" to fetch: the voice is ` +
            `${typeof body.status === "string" ? body.status : "in a state it did not name"}. ` +
            "So there is nothing to speak with yet.",
          retryable: body.status === "PROCESSING",
        },
      };
    }

    return { ok: true, data: { name, previewUrl: body.previewUrl } };
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
      return {
        ok: false,
        failure: {
          message:
            `Runway is not answering for ${method} ${path} ` +
            `(${error instanceof Error ? error.message : String(error)}), so nothing has been said.`,
          retryable: true,
        },
      };
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          message: `Runway answered ${String(response.status)} to ${method} ${path}: ${excerpt(text)}`,
          // 4xx is a decision — a body it will not accept, a voice that is not
          // there — and repeating it produces the same answer.
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
}
