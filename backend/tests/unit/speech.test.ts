import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FetchLike } from "../../src/render/runway.js";
import { RunwaySpeechClient, speechBody } from "../../src/voice/speech.js";

/**
 * The client that turns her words into audio.
 *
 * **No test here reaches Runway or spends a credit.** `fetch` is injected, the
 * same seam `render/runway.ts` stands on.
 *
 * Every fixture below is **real captured output** from `api.dev.runwayml.com`
 * on 2026-08-11, not something shaped from our own types — which is the whole
 * point, since the request shape was unknown and had to be probed out of the
 * validator. The 400 is the validator's own answer to an empty body; it is kept
 * because it is the thing that would tell us the wire format had drifted.
 */

/** `POST /v1/text_to_speech` with `{}`. This is how the schema was found. */
const EMPTY_BODY_400 = JSON.stringify({
  error: "Validation of body failed",
  issues: [
    {
      expected: "string",
      code: "invalid_type",
      path: ["model"],
      message: "Invalid input: expected string, received undefined",
    },
    {
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: "model",
      path: ["model"],
      message: "Invalid input",
    },
  ],
  docUrl: "https://docs.dev.runwayml.com/api",
});

/** The answer to a well-formed submission. */
const SUBMITTED = JSON.stringify({
  id: "3086d332-1963-4c9d-8103-0f90efa72e20",
  estimatedCost: { credits: 5 },
});

const RUNNING = JSON.stringify({
  id: "3086d332-1963-4c9d-8103-0f90efa72e20",
  createdAt: "2026-08-11T06:12:01.171Z",
  status: "RUNNING",
  progress: 0.45,
  estimatedCost: { credits: 5 },
});

const SUCCEEDED = JSON.stringify({
  id: "3086d332-1963-4c9d-8103-0f90efa72e20",
  createdAt: "2026-08-11T06:12:01.171Z",
  status: "SUCCEEDED",
  output: ["https://dnznrvs05pmza.cloudfront.net/seed_audio/eb6cacd5/text_to_speech.mp3?_jwt=x"],
  cost: { credits: 5 },
});

/** `GET /v1/voices/{id}`, trimmed of the description. */
const VOICE = JSON.stringify({
  id: "93b52581-17ab-4905-bb5a-4fa730a7757a",
  name: "Syl High Pitch",
  description: "A bright, warm, quick, sultry, young adult female voice.",
  createdAt: "2026-08-09T00:08:43.995Z",
  status: "READY",
  previewUrl: "https://d2jqrm6oza8nb6.cloudfront.net/generated-voice-sample/voice_sample.mp3?_jwt=x",
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly authorization: string;
}

function fakeFetch(
  answers: readonly { readonly status: number; readonly body: string }[],
): FetchLike & { readonly calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      authorization: headers["Authorization"] ?? "",
    });
    const answer = answers[Math.min(index, answers.length - 1)] ?? { status: 200, body: "{}" };
    index += 1;
    return new Response(answer.body, { status: answer.status });
  };
  return Object.assign(fetcher, { calls });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-speech-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("speechBody", () => {
  it("should send the model, the words, and the reference clip as a data URI", () => {
    const body = speechBody({
      model: "seed_audio",
      promptText: "I made something.",
      referenceMp3: Buffer.from([0xff, 0xfb, 0x10]),
      outputFormat: "mp3",
    });

    expect(body.model).toBe("seed_audio");
    expect(body.promptText).toBe("I made something.");
    expect(body.outputFormat).toBe("mp3");
    // The discriminator. Three values are valid on this endpoint and this is
    // the only one that carries a voice rather than naming a stock preset.
    expect(body.voice.type).toBe("reference-audio");
    expect(body.voice.audioUri).toBe(`data:audio/mp3;base64,${Buffer.from([0xff, 0xfb, 0x10]).toString("base64")}`);
  });
});

describe("RunwaySpeechClient", () => {
  it("should refuse to exist without a secret rather than 401 on every call", () => {
    expect(() => new RunwaySpeechClient({ secret: "  " })).toThrow(/secret/u);
  });

  it("should post to text_to_speech and answer with the task id and the estimate", async () => {
    const fetcher = fakeFetch([{ status: 200, body: SUBMITTED }]);
    const client = new RunwaySpeechClient({ secret: "s3cret", fetch: fetcher });

    const submitted = await client.submit({
      model: "seed_audio",
      promptText: "I made something.",
      referenceMp3: Buffer.from([0xff]),
      outputFormat: "mp3",
    });

    expect(submitted).toEqual({
      ok: true,
      data: { id: "3086d332-1963-4c9d-8103-0f90efa72e20", estimatedCredits: 5 },
    });
    expect(fetcher.calls[0]?.url).toBe("https://api.dev.runwayml.com/v1/text_to_speech");
    expect(fetcher.calls[0]?.method).toBe("POST");
  });

  it("should never put the secret anywhere but the Authorization header", async () => {
    const fetcher = fakeFetch([{ status: 200, body: SUBMITTED }]);
    const client = new RunwaySpeechClient({ secret: "s3cret", fetch: fetcher });

    await client.submit({
      model: "seed_audio",
      promptText: "I made something.",
      referenceMp3: Buffer.from([0xff]),
      outputFormat: "mp3",
    });

    expect(fetcher.calls[0]?.authorization).toBe("Bearer s3cret");
    expect(fetcher.calls[0]?.body).not.toContain("s3cret");
    expect(fetcher.calls[0]?.url).not.toContain("s3cret");
  });

  it("should carry the validator's own words back when the body is rejected", async () => {
    const client = new RunwaySpeechClient({ secret: "s3cret", fetch: fakeFetch([{ status: 400, body: EMPTY_BODY_400 }]) });

    const submitted = await client.submit({
      model: "seed_audio",
      promptText: "I made something.",
      referenceMp3: Buffer.from([0xff]),
      outputFormat: "mp3",
    });

    expect(submitted.ok).toBe(false);
    if (!submitted.ok) {
      expect(submitted.failure.message).toContain("Validation of body failed");
      // A 400 is a decision. Repeating it produces the same answer.
      expect(submitted.failure.retryable).toBe(false);
      expect(submitted.failure.message).not.toContain("s3cret");
    }
  });

  it("should read a task that is still running and one that has finished", async () => {
    const client = new RunwaySpeechClient({
      secret: "s3cret",
      fetch: fakeFetch([
        { status: 200, body: RUNNING },
        { status: 200, body: SUCCEEDED },
      ]),
    });

    const running = await client.task("3086d332-1963-4c9d-8103-0f90efa72e20");
    expect(running.ok && running.data.status).toBe("RUNNING");
    expect(running.ok && running.data.output).toEqual([]);

    const done = await client.task("3086d332-1963-4c9d-8103-0f90efa72e20");
    expect(done.ok && done.data.status).toBe("SUCCEEDED");
    expect(done.ok && done.data.credits).toBe(5);
    expect(done.ok && done.data.output[0]).toContain("text_to_speech.mp3");
  });

  it("should stream a finished clip to disk and answer with the byte count", async () => {
    const client = new RunwaySpeechClient({
      secret: "s3cret",
      fetch: fakeFetch([{ status: 200, body: "not really an mp3" }]),
    });
    const to = join(root, "speech.mp3");

    const downloaded = await client.download("https://example.invalid/x.mp3", to);

    expect(downloaded).toEqual({ ok: true, data: 17 });
    expect(readFileSync(to, "utf8")).toBe("not really an mp3");
  });

  it("should answer with the voice's preview clip so her sample can be fetched once", async () => {
    const fetcher = fakeFetch([{ status: 200, body: VOICE }]);
    const client = new RunwaySpeechClient({ secret: "s3cret", fetch: fetcher });

    const preview = await client.preview("93b52581-17ab-4905-bb5a-4fa730a7757a");

    expect(preview.ok && preview.data.name).toBe("Syl High Pitch");
    expect(preview.ok && preview.data.previewUrl).toContain("voice_sample.mp3");
    expect(fetcher.calls[0]?.url).toBe(
      "https://api.dev.runwayml.com/v1/voices/93b52581-17ab-4905-bb5a-4fa730a7757a",
    );
  });

  it("should refuse a voice that is not ready rather than handing back an empty preview", async () => {
    const client = new RunwaySpeechClient({
      secret: "s3cret",
      fetch: fakeFetch([
        {
          status: 200,
          body: JSON.stringify({ id: "x", name: "Syl", status: "PROCESSING", createdAt: "2026-08-09T00:08:43.995Z" }),
        },
      ]),
    });

    const preview = await client.preview("x");
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.failure.message).toContain("PROCESSING");
  });
});
