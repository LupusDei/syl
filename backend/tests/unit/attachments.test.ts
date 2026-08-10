import { deflateSync } from "node:zlib";

import type { ApiError, Attachment, MessagePage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import { UPLOAD_BODY_LIMIT_BYTES } from "../../src/routes/attachments.js";
import { MAX_ATTACHMENT_BYTES } from "../../src/services/attachment-store.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `POST /attachments` and `GET /attachments/{id}`.
 *
 * Two properties, and they pull against each other:
 *
 * 1. A picture the Commander sent has to arrive, render at the right size, and
 *    be cheap to fetch again.
 * 2. **The service must never believe a word the uploader says about the
 *    file.** The type, the extension, the dimensions — all of it is decided by
 *    the bytes, and this is the surface where that either holds or does not.
 *
 * The images below are real PNGs, assembled from the format specification with
 * a real CRC and a real deflate stream. A placeholder string would exercise the
 * routing and none of the sniffing, which is the only part worth testing here.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

const CRC = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const byte of body) c = (CRC[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable RGB PNG. */
function png(width = 40, height = 25): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) raw[offset + 1 + x * 3] = (x * 6 + y * 3) % 256;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let keyCounter = 0;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function post(
  body: unknown,
  options: { readonly token?: string; readonly idempotencyKey?: string } = {},
): Promise<Response> {
  keyCounter += 1;
  const key = options.idempotencyKey ?? `attachment-test-${String(keyCounter)}`;
  const authorization = options.token ?? token;
  return fetch(`${running.baseUrl}/api/v1/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
      ...(authorization === "" ? {} : { authorization: `Bearer ${authorization}` }),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

/** Upload a real PNG and return the row the service made of it. */
async function upload(image: Buffer = png()): Promise<Attachment> {
  const response = await post({
    kind: "image",
    mimeType: "image/png",
    data: image.toString("base64"),
  });
  const body = (await response.json()) as Envelope<Attachment>;
  if (body.data === undefined) throw new Error(`upload failed: ${JSON.stringify(body)}`);
  return body.data;
}

describe("POST /api/v1/attachments", () => {
  it("should store a real image and answer with the row it made of it", async () => {
    const response = await post({
      kind: "image",
      mimeType: "image/png",
      data: png(40, 25).toString("base64"),
      // Deliberately wrong, and deliberately ignored: the file's own header is
      // the only source that cannot disagree with the file.
      width: 1,
      height: 1,
    });
    const body = (await response.json()) as Envelope<Attachment>;

    expect(response.status).toBe(201);
    expect(body.data?.kind).toBe("image");
    expect(body.data?.mimeType).toBe("image/png");
    expect(body.data?.width).toBe(40);
    expect(body.data?.height).toBe(25);
    expect(body.data?.durationMs).toBeNull();
    expect(body.data?.id).toMatch(/^syl:attachment:/u);
  });

  it("should refuse a file whose bytes disagree with the type it declared", async () => {
    // The refusal the whole magic-byte cross-check exists to produce.
    const response = await post({
      kind: "image",
      mimeType: "image/jpeg",
      data: png().toString("base64"),
    });
    const body = (await response.json()) as Envelope<Attachment>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details).toMatchObject({ field: "mimeType", reason: "mime-mismatch" });
  });

  it("should refuse bytes that are not a format it stores, whatever they claim", async () => {
    const response = await post({
      kind: "image",
      mimeType: "image/png",
      data: Buffer.from("<svg onload=alert(1)></svg>", "utf8").toString("base64"),
    });
    const body = (await response.json()) as Envelope<Attachment>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ reason: "unsupported-type" });
  });

  it("should name the data-URI mistake rather than silently storing garbage", async () => {
    // `Buffer.from(x, "base64")` skips anything outside the alphabet, so a
    // data URI decodes to *something* and fails later as "unsupported type" —
    // a diagnosis that sends the client looking at the wrong thing entirely.
    const response = await post({
      kind: "image",
      mimeType: "image/png",
      data: `data:image/png;base64,${png().toString("base64")}`,
    });
    const body = (await response.json()) as Envelope<Attachment>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ field: "data" });
  });

  it("should refuse a write with no Idempotency-Key, like every other write", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "image", mimeType: "image/png", data: png().toString("base64") }),
    });
    const body = (await response.json()) as Envelope<Attachment>;

    expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("should store one file when the outbox sends the same upload twice", async () => {
    // The phone retries by design, and a duplicate upload is not a second
    // picture — it is the same picture and a wasted thirteen megabytes.
    const data = png().toString("base64");
    const body = { kind: "image", mimeType: "image/png", data };
    const first = await post(body, { idempotencyKey: "retried-upload" });
    const second = await post(body, { idempotencyKey: "retried-upload" });

    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.status).toBe(first.status);
    const one = (await first.json()) as Envelope<Attachment>;
    const two = (await second.json()) as Envelope<Attachment>;
    expect(two.data?.id).toBe(one.data?.id);
    expect(deps.attachments.list().length).toBe(1);
  });

  it("should refuse an anonymous upload", async () => {
    const response = await post(
      { kind: "image", mimeType: "image/png", data: png().toString("base64") },
      { token: "" },
    );
    const body = (await response.json()) as Envelope<Attachment>;

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("should accept a paired device's own token, which is the whole point", async () => {
    // `GET /logs` is the one operation a phone may not call, and the argument
    // there is that the log is not the Commander's data. A picture in his own
    // conversation is. A scope gate here would make Phase 6 impossible for the
    // only client that exists — see the note in `routes/attachments.ts`.
    const response = await post({
      kind: "image",
      mimeType: "image/png",
      data: png().toString("base64"),
    });

    expect(response.status).toBe(201);
  });

  it("should size the body limit from the store's ceiling, not independently", async () => {
    // A middleware limit chosen beside the store's would refuse files the
    // store accepts — a 413 from a layer the client cannot see — or admit
    // bodies the store then refuses after they have crossed the tunnel.
    expect(UPLOAD_BODY_LIMIT_BYTES).toBeGreaterThan((MAX_ATTACHMENT_BYTES * 4) / 3);
  });
});

describe("GET /api/v1/attachments/{attachmentId}", () => {
  it("should answer the bytes themselves, not an envelope", async () => {
    const image = png(40, 25);
    const attachment = await upload(image);
    const response = await get(`/attachments/${encodeURIComponent(attachment.id)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
  });

  it("should refuse an id it never issued in the contract's failure envelope", async () => {
    const response = await get(
      "/attachments/syl%3Aattachment%3A00000000-0000-7000-8000-0000000000ff",
    );
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(404);
    // The half that matters most: a FAILURE from this route is still JSON, so
    // `Content-Type` remains the discriminator between "Syl refused" and
    // "something that is not Syl answered".
    expect(response.headers.get("content-type")).toMatch(/application\/json/u);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("should refuse a variant it does not have rather than serving the full file", async () => {
    // `testDeps` wires a store with no thumbnailer, which is also every
    // non-macOS machine. A silent fallback here would turn a 60 KB request
    // into a 4 MB one, invisibly, on the connection least able to afford it.
    const attachment = await upload();
    expect(attachment.hasThumbnail).toBe(false);

    const response = await get(`/attachments/${encodeURIComponent(attachment.id)}?variant=thumb`);
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("should refuse a variant it has never heard of", async () => {
    // A `variant=thumbnail` read as "original" hands back the full file to a
    // caller who asked for a preview and cannot tell that it happened.
    const attachment = await upload();
    const response = await get(
      `/attachments/${encodeURIComponent(attachment.id)}?variant=thumbnail`,
    );
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ field: "variant" });
  });

  it("should answer 304 to a client that already holds the bytes", async () => {
    // The bytes at an id never change, so this is honest rather than
    // optimistic — and it is the difference between a re-render costing
    // nothing and costing the picture again.
    const attachment = await upload();
    const first = await get(`/attachments/${encodeURIComponent(attachment.id)}`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();

    expect(etag).toContain(attachment.sha256);
    const second = await get(`/attachments/${encodeURIComponent(attachment.id)}`, {
      "if-none-match": etag,
    });
    expect(second.status).toBe(304);
  });

  it("should refuse an anonymous read", async () => {
    const attachment = await upload();
    const response = await fetch(
      `${running.baseUrl}/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
    );
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("attachments on a message", () => {
  async function send(body: unknown): Promise<Response> {
    keyCounter += 1;
    return fetch(
      `${running.baseUrl}/api/v1/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "Idempotency-Key": `send-test-${String(keyCounter)}`,
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("should carry the picture back on the message that claimed it", async () => {
    const attachment = await upload();
    const sent = await send({
      clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
      text: "Here is the shelf, after.",
      attachmentIds: [attachment.id],
    });
    expect(sent.status).toBe(201);

    const page = (await (
      await get(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`)
    ).json()) as Envelope<MessagePage>;
    const message = page.data?.items.find((item) => item.text === "Here is the shelf, after.");

    expect(message?.attachments.map((item) => item.id)).toEqual([attachment.id]);
  });

  it("should send back an empty array, never a missing field, on a message with no picture", async () => {
    // The one distinction a client must never have to make: "nothing
    // attached" and "this build does not send the field" look identical and
    // mean opposite things.
    await send({ clientId: "no-attachments-here", text: "Just words." });

    const page = (await (
      await get(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`)
    ).json()) as Envelope<MessagePage>;
    const message = page.data?.items.find((item) => item.text === "Just words.");

    expect(message?.attachments).toEqual([]);
  });

  it("should refuse a send naming an attachment that does not exist", async () => {
    const response = await send({
      clientId: "points-at-nothing",
      text: "With a ghost attached.",
      attachmentIds: ["syl:attachment:00000000-0000-7000-8000-0000000000ff"],
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ reason: "unknown-attachment" });
  });

  it("should refuse to hang one picture on two messages", async () => {
    const attachment = await upload();
    await send({ clientId: "first-claim", text: "Mine.", attachmentIds: [attachment.id] });
    const second = await send({
      clientId: "second-claim",
      text: "Also mine.",
      attachmentIds: [attachment.id],
    });
    const body = (await second.json()) as Envelope<never>;

    expect(second.status).toBe(409);
    expect(body.error?.code).toBe("CONFLICT");
  });

  it("should refuse an empty attachmentIds array rather than treating it as absent", async () => {
    const response = await send({
      clientId: "empty-array",
      text: "I meant to attach something.",
      attachmentIds: [],
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ field: "attachmentIds" });
  });

  it("should leave no message behind when the attachments it named are refused", async () => {
    // The transaction is the point. A message that arrived without the picture
    // its author attached is worse than a send that failed, because only the
    // second one is visible to them.
    const attachment = await upload();
    await send({ clientId: "first-claim", text: "Mine.", attachmentIds: [attachment.id] });
    await send({ clientId: "doomed", text: "Doomed.", attachmentIds: [attachment.id] });

    const page = (await (
      await get(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`)
    ).json()) as Envelope<MessagePage>;

    expect(page.data?.items.some((item) => item.text === "Doomed.")).toBe(false);
  });
});
