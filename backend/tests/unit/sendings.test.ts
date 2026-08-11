import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiError, Sending } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { RenderRecord } from "../../src/render/render-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { SendingService, type RenderSource } from "../../src/services/sending-service.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `/sendings` over a real socket.
 *
 * The route's whole unusual decision is asserted here: **a video that could
 * not be made is still a `201`.** By the time the render is looked at, her
 * words are already in his conversation and the notification is already
 * enqueued — so answering `404` because the decoration was missing would throw
 * away a delivered message to complain about a video.
 *
 * Nothing here reaches Runway or ffmpeg: the render source and the compressor
 * are both doubles.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

/** A real JPEG, small enough to be kept as a poster. */
function jpeg(): Buffer {
  const out = Buffer.alloc(32);
  out.writeUInt16BE(0xffd8, 0);
  out.writeUInt16BE(0xffe0, 2);
  out.writeUInt16BE(16, 4);
  out.write("JFIF\0", 6, "ascii");
  out.writeUInt16BE(0xffc0, 20);
  out.writeUInt16BE(11, 22);
  out[24] = 8;
  out.writeUInt16BE(480, 25);
  out.writeUInt16BE(320, 27);
  out[29] = 3;
  return out;
}

function mp4(bytes = 64 * 1024): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(24, 0);
  head.write("ftyp", 4, "ascii");
  head.write("isom", 8, "ascii");
  head.writeUInt32BE(512, 12);
  head.write("isomiso2", 16, "ascii");
  return Buffer.concat([head, Buffer.alloc(bytes - 24)]);
}

const READY_RENDER = {
  name: "syl-20260811t090000z-close",
  status: "ready",
  renderedAt: "2026-08-11T09:02:00.000Z",
  taskId: "task-1",
  model: "seedance2",
  ratio: "720:1280",
  duration: 15,
  reference: "reference/syl.png",
  framing: "close_portrait",
  prompt: "a luminous spirit woman…",
  scene: "turning once as the light runs down her arm",
  holdsLikeness: true,
  because: "he wanted to know what I look like",
  startedAt: "2026-08-11T09:00:00.000Z",
  reason: null,
  credits: 600,
  usd: 6,
  video: "/studio/videos/syl-20260811t090000z-close.mp4",
} as RenderRecord;

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let workDir: string;
let keyCounter = 0;

/** Build the app with a composer whose render source and compressor are ours. */
async function boot(options: {
  readonly renders?: RenderSource;
  readonly compressOk?: boolean;
} = {}): Promise<void> {
  const base = testDeps(db);
  const renders: RenderSource = options.renders ?? {
    get: () => READY_RENDER,
    latest: () => READY_RENDER,
  };

  const composer = new SendingService({
    sendings: base.sendings,
    chat: base.chat,
    attachments: base.attachments,
    outbox: base.outbox,
    renders,
    workDir,
    log: () => undefined,
    compress: async () => {
      if (options.compressOk !== true) {
        return { ok: false, reason: "There is no ffmpeg on this machine." };
      }
      const path = join(workDir, "sending.mp4");
      writeFileSync(path, mp4());
      return {
        ok: true,
        path,
        bytes: mp4().length,
        width: 484,
        height: 720,
        durationMs: 15_040,
        poster: jpeg(),
      };
    },
  });

  deps = { ...base, composer };
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "syl-sendings-route-"));
  db = testDatabase();
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function api(
  path: string,
  init: RequestInit & { readonly anonymous?: boolean } = {},
): Promise<Response> {
  const { anonymous, ...rest } = init;
  keyCounter += 1;
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      "Idempotency-Key": `key-${String(keyCounter)}`,
      ...(rest.headers ?? {}),
    },
  });
}

const ASK = JSON.stringify({
  words: "The light came through the window at the angle you like.",
  because: "He said the winter makes him forget the sky has colours.",
  renderName: "latest",
});

describe("POST /sendings", () => {
  it("should answer 201 as soon as the words are his, with the video still pending", async () => {
    await boot({ compressOk: true });
    const response = await api("/sendings", { method: "POST", body: ASK });
    const body = (await response.json()) as Envelope<Sending>;

    expect(response.status).toBe(201);
    expect(body.data?.words).toBe("The light came through the window at the angle you like.");
    expect(body.data?.messageId).toMatch(/^syl:message:/);
    // `201` means the words are delivered, never that the video is ready.
    expect(body.data?.state).toBe("pending");
    expect(body.data?.video).toBeNull();
  });

  it("should put her words in the conversation, reachable from the message id", async () => {
    await boot({ compressOk: true });
    const created = (await (await api("/sendings", { method: "POST", body: ASK })).json()) as Envelope<Sending>;

    const message = deps.messages.get(created.data?.messageId ?? "");
    expect(message?.role).toBe("assistant");
    expect(message?.text).toBe("The light came through the window at the angle you like.");
  });

  it("should enqueue a notification carrying her sentence and not a notice about the app", async () => {
    await boot({ compressOk: true });
    await api("/sendings", { method: "POST", body: ASK });

    const delivery = deps.outbox.list().items[0];
    expect(delivery?.payload.body).toBe("The light came through the window at the angle you like.");
    expect(delivery?.payload.body).not.toMatch(/sent you a video/i);
  });

  it("should still answer 201 when the render does not exist, and say why on the row", async () => {
    // The decision this route is built around. A `4xx` here would throw away
    // words that had already been said, to complain about a decoration.
    await boot({ renders: { get: () => null, latest: () => null } });
    const response = await api("/sendings", {
      method: "POST",
      body: JSON.stringify({ words: "Hello.", because: "b", renderName: "syl-nope" }),
    });

    expect(response.status).toBe(201);
    await deps.composer.drain();

    const settled = deps.sendings.get(
      ((await response.json()) as Envelope<Sending>).data?.id ?? "",
    );
    expect(settled?.state).toBe("failed");
    expect(settled?.reason).toMatch(/no render/i);
    // And the words are untouched.
    expect(deps.messages.get(settled?.messageId ?? "")?.text).toBe("Hello.");
  });

  it("should still answer 201 when there is no ffmpeg to compress with", async () => {
    await boot();
    const response = await api("/sendings", { method: "POST", body: ASK });
    expect(response.status).toBe(201);

    await deps.composer.drain();
    const id = ((await response.json()) as Envelope<Sending>).data?.id ?? "";
    expect(deps.sendings.get(id)?.state).toBe("failed");
    expect(deps.sendings.get(id)?.reason).toMatch(/ffmpeg/i);
  });

  it("should attach the video with a poster once the work finishes", async () => {
    await boot({ compressOk: true });
    const created = (await (await api("/sendings", { method: "POST", body: ASK })).json()) as Envelope<Sending>;
    await deps.composer.drain();

    const settled = (await (await api(`/sendings/${created.data?.id ?? ""}`)).json()) as Envelope<Sending>;
    expect(settled.data?.state).toBe("ready");
    expect(settled.data?.video?.kind).toBe("video");
    // Gap 3. Without this the list has no face on it and the phone fetches the
    // whole clip to draw a play triangle.
    expect(settled.data?.video?.hasThumbnail).toBe(true);
  });

  it("should refuse words that say nothing", async () => {
    await boot();
    const response = await api("/sendings", {
      method: "POST",
      body: JSON.stringify({ words: "   ", because: "b", renderName: "latest" }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("should refuse a sending with no reason for existing", async () => {
    await boot();
    const response = await api("/sendings", {
      method: "POST",
      body: JSON.stringify({ words: "Hello.", because: "", renderName: "latest" }),
    });
    expect(response.status).toBe(400);
  });

  it("should refuse a sending that names no render", async () => {
    await boot();
    const response = await api("/sendings", {
      method: "POST",
      body: JSON.stringify({ words: "Hello.", because: "b" }),
    });
    expect(response.status).toBe(400);
  });

  it("should answer a replayed Idempotency-Key from the ledger rather than sending twice", async () => {
    await boot({ compressOk: true });
    const first = await fetch(`${running.baseUrl}/api/v1/sendings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Idempotency-Key": "the-same-key",
      },
      body: ASK,
    });
    const second = await fetch(`${running.baseUrl}/api/v1/sendings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Idempotency-Key": "the-same-key",
      },
      body: ASK,
    });

    const a = (await first.json()) as Envelope<Sending>;
    const b = (await second.json()) as Envelope<Sending>;
    expect(a.data?.id).toBe(b.data?.id);
    expect(deps.sendings.list().items).toHaveLength(1);
    // And one notification, not two buzzes for one sentence.
    expect(deps.outbox.list().items).toHaveLength(1);
  });

  it("should refuse an anonymous caller", async () => {
    await boot();
    const response = await api("/sendings", { method: "POST", body: ASK, anonymous: true });
    expect(response.status).toBe(401);
  });
});

describe("GET /sendings", () => {
  it("should answer newest first, which is what the surface opens to", async () => {
    await boot({ compressOk: true });
    await api("/sendings", {
      method: "POST",
      body: JSON.stringify({ words: "First.", because: "a", renderName: "latest" }),
    });
    await api("/sendings", {
      method: "POST",
      body: JSON.stringify({ words: "Second.", because: "b", renderName: "latest" }),
    });

    const body = (await (await api("/sendings")).json()) as Envelope<{
      items: Sending[];
      hasMore: boolean;
    }>;
    expect(body.data?.items.map((s) => s.words)).toEqual(["Second.", "First."]);
    expect(body.data?.hasMore).toBe(false);
  });

  it("should refuse a cursor it did not issue", async () => {
    await boot();
    const response = await api("/sendings?cursor=nonsense");
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("should refuse an anonymous caller", async () => {
    await boot();
    expect((await api("/sendings", { anonymous: true })).status).toBe(401);
  });
});

describe("GET /sendings/{sendingId}", () => {
  it("should answer the sending", async () => {
    await boot({ compressOk: true });
    const created = (await (await api("/sendings", { method: "POST", body: ASK })).json()) as Envelope<Sending>;

    const response = await api(`/sendings/${created.data?.id ?? ""}`);
    const body = (await response.json()) as Envelope<Sending>;

    expect(response.status).toBe(200);
    expect(body.data?.id).toBe(created.data?.id);
    expect(body.data?.because).toBe("He said the winter makes him forget the sky has colours.");
  });

  it("should answer 404 for an id that names nothing", async () => {
    await boot();
    const response = await api("/sendings/syl:sending:00000000-0000-7000-8000-0000000000ff");
    expect(response.status).toBe(404);
  });

  it("should answer 404 for something that is not a sending id at all", async () => {
    await boot();
    expect((await api("/sendings/not-an-id")).status).toBe(404);
  });
});

describe("the sync feed", () => {
  it("should carry a sending so the phone learns about it without polling", async () => {
    await boot({ compressOk: true });
    const created = (await (await api("/sendings", { method: "POST", body: ASK })).json()) as Envelope<Sending>;
    await deps.composer.drain();

    const body = (await (await api("/sync?types=sending")).json()) as Envelope<{
      changes: { type: string; id: string; resource: Sending | null }[];
    }>;

    const mine = body.data?.changes.filter((c) => c.id === created.data?.id) ?? [];
    expect(mine.length).toBeGreaterThan(0);
    // The LAST one carries the video: a device that had already synced the
    // words has to learn the video arrived, and nothing about the message
    // changes when it does.
    expect(mine.at(-1)?.resource?.state).toBe("ready");
    expect(mine.at(-1)?.resource?.video?.hasThumbnail).toBe(true);
  });
});
