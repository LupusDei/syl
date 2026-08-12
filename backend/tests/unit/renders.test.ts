import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import { RenderService } from "../../src/render/render-service.js";
import type { RenderBackend } from "../../src/render/runway.js";
import { sightingOf } from "../../src/render/pictures.js";
import { studioAt } from "../../src/render/studio.js";
import { Wardrobe } from "../../src/render/wardrobe.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `/renders` over a real socket.
 *
 * The route exists because the render is **asynchronous** — a flagship
 * fifteen-second clip takes minutes — and a verb that waited for it would hold
 * a whole turn open on somebody else's GPU queue. So the shape is the one
 * `backend/src/jobs/` uses for long work: ask, get a record back at once, come
 * back and look.
 *
 * Nothing here reaches Runway. The backend is a double and the studio is a
 * temp directory, so a full run of this file spends nothing.
 */

const NOW = Date.UTC(2026, 7, 11, 15, 30, 0, 0);

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let root: string;
let renders: RenderService;
let wardrobe: Wardrobe;
let keyCounter = 0;

/** A backend that always succeeds, and a `ffmpeg` that always writes a still. */
function fakeBackend(): RenderBackend {
  return {
    submit: async () => ({ ok: true, data: { id: "task-1" } }),
    task: async () => ({
      ok: true,
      data: { id: "task-1", status: "SUCCEEDED", output: ["https://cdn.invalid/x.mp4"] },
    }),
    download: async (_url, to) => {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, Buffer.alloc(2048, 3));
      return { ok: true, data: 2048 };
    },
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "syl-renders-route-"));
  const studio = studioAt(root);
  mkdirSync(dirname(studio.reference()), { recursive: true });
  writeFileSync(studio.reference(), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // The ribbon every clip opens on. It is what goes over as `promptImage`, so
  // without it on disk `start` refuses and every route below answers 4xx.
  writeFileSync(studio.opening(), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));

  renders = new RenderService({
    studio,
    backend: fakeBackend(),
    clock: fixedClock(NOW),
    sleep: async () => undefined,
    // A stand-in for ffmpeg, so the suite does not need it installed and does
    // not decode a file that is not really a video. Every ffmpeg this service
    // runs writes its output last, so one double covers pulling stills,
    // taking a closing frame and joining halves.
    ffmpeg: async (_file: string, args: readonly string[]) => {
      const out = args[args.length - 1] ?? "";
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { ok: true, message: "" };
    },
  });

  db = testDatabase();
  // The wardrobe over the SAME studio the render service has. Two studios
  // would mean the face a render is anchored on and the face `/renders/wardrobe`
  // calls current are answered from two different directories.
  wardrobe = new Wardrobe({ studio, clock: fixedClock(NOW) });
  deps = { ...testDeps(db), renders, wardrobe };
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
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
  scene: "she turns once, slowly, and lets the light run down her arm",
  framing: "close_portrait",
  because: "he said he wants to know what I look like",
});

describe("POST /renders", () => {
  it("should answer at once with a record that says it is still rendering", async () => {
    const response = await api("/renders", { method: "POST", body: ASK });
    const body = (await response.json()) as Envelope<{
      record: { name: string; status: string; video: string | null };
      spend: { renders: number };
    }>;

    expect(response.status).toBe(201);
    expect(body.data?.record.status).toBe("rendering");
    expect(body.data?.record.video).toBeNull();
    // The ledger travels with the action. He ruled out a gate; he did not rule
    // out being able to see the bill.
    expect(body.data?.spend.renders).toBe(1);
  });

  it("should refuse a framing outside the four, in the contract's failure envelope", async () => {
    const response = await api("/renders", {
      method: "POST",
      body: JSON.stringify({ scene: "s", framing: "cinematic", because: "b" }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.message).toContain("close_portrait");
  });

  it("should refuse without a reason", async () => {
    const response = await api("/renders", {
      method: "POST",
      body: JSON.stringify({ scene: "s", framing: "close_portrait" }),
    });

    expect(response.status).toBe(400);
  });

  it("should refuse an anonymous caller", async () => {
    const response = await api("/renders", { method: "POST", body: ASK, anonymous: true });
    expect(response.status).toBe(401);
  });
});

describe("GET /renders", () => {
  it("should list what she has made, newest first, with the total beside it", async () => {
    await api("/renders", { method: "POST", body: ASK });
    await renders.drain();

    const response = await api("/renders");
    const body = (await response.json()) as Envelope<{
      items: { name: string; status: string }[];
      spend: { renders: number; credits: number; usd: number };
    }>;

    expect(response.status).toBe(200);
    expect(body.data?.items.length).toBe(1);
    expect(body.data?.items[0]?.status).toBe("ready");
    expect(body.data?.spend.credits).toBe(540);
    expect(body.data?.spend.usd).toBeCloseTo(5.4, 5);
  });
});

describe("GET /renders/{name}", () => {
  it("should answer with the record and the running total", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;
    await renders.drain();

    const response = await api(`/renders/${name}`);
    const body = (await response.json()) as Envelope<{
      record: { name: string; status: string };
      spend: { renders: number };
    }>;

    expect(body.data?.record.name).toBe(name);
    expect(body.data?.record.status).toBe("ready");
    expect(body.data?.spend.renders).toBe(1);
  });

  it("should resolve `latest` so she does not have to remember a name", async () => {
    await api("/renders", { method: "POST", body: ASK });
    await renders.drain();

    const response = await api("/renders/latest");
    const body = (await response.json()) as Envelope<{ record: { status: string } }>;

    expect(response.status).toBe(200);
    expect(body.data?.record.status).toBe("ready");
  });

  it("should answer 404 for a render that is not there", async () => {
    const response = await api("/renders/syl-19700101t000000z-close-portrait");
    expect(response.status).toBe(404);
  });

  it("should refuse a name that is not a render name, without touching the disk", async () => {
    // The name addresses a file. A name that can spell `..` is a file read
    // wearing a route.
    const response = await api(`/renders/${encodeURIComponent("../../../etc/passwd")}`);
    expect(response.status).toBe(404);
  });
});

describe("GET /renders/{name}/frames", () => {
  it("should hand back several stills across the clip, as base64", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;
    await renders.drain();

    const response = await api(`/renders/${name}/frames`);
    const body = (await response.json()) as Envelope<{
      render: { name: string };
      frames: { atSeconds: number; mimeType: string; base64: string }[];
    }>;

    expect(response.status).toBe(200);
    expect(body.data?.frames.length).toBeGreaterThanOrEqual(4);
    for (const frame of body.data?.frames ?? []) {
      expect(frame.mimeType).toBe("image/jpeg");
      expect(frame.base64.length).toBeGreaterThan(0);
    }
  });

  it("should look at one named second", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;
    await renders.drain();

    const response = await api(`/renders/${name}/frames?at=6.5`);
    const body = (await response.json()) as Envelope<{ frames: { atSeconds: number }[] }>;

    expect(body.data?.frames.map((frame) => frame.atSeconds)).toEqual([6.5]);
  });

  it("should refuse to look at a render that has not finished, and say why", async () => {
    // A service whose render never lands: Runway answers `PENDING` and the
    // follower parks between polls. The shared fixture finishes instantly,
    // which is convenient for every other case and useless for this one.
    const unfinished = new RenderService({
      studio: studioAt(root),
      backend: {
        ...fakeBackend(),
        task: async () => ({ ok: true, data: { id: "task-1", status: "PENDING", output: [] } }),
      },
      clock: fixedClock(NOW),
      sleep: () => new Promise<void>(() => undefined),
    });
    const slow = await startTestApp(
      createApp(testConfig(), { ...testDeps(db), renders: unfinished }),
    );

    const created = await fetch(`${slow.baseUrl}/api/v1/renders`, {
      method: "POST",
      body: ASK,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Idempotency-Key": "slow-1",
      },
    });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;

    const response = await fetch(`${slow.baseUrl}/api/v1/renders/${name}/frames`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as Envelope<never>;

    // Not a 404 and not an empty list: "there is nothing to see yet" and "I
    // looked and there is nothing there" are different facts about her render.
    expect(response.status).toBe(409);
    expect(body.error?.message).toMatch(/not finished|still rendering/iu);

    await slow.close();
  });
});

/**
 * Her wardrobe over a real socket: what she looks like, and what her clips open
 * on, as things she chooses rather than constants an engineer moves.
 *
 * The route's whole job is the pairing of a picture with the token that names
 * it. **A sighting never travels without the image it belongs to** — that is
 * what keeps "she looked at it" a property of the mechanism rather than a
 * request in a description.
 */
describe("/renders/wardrobe", () => {
  /** A real PNG header, so a shape can be read off it as it is in her home. */
  function png(width: number, height: number, salt: number): Buffer {
    const bytes = Buffer.alloc(25);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes.writeUInt8(salt, 24);
    return bytes;
  }

  interface Shown {
    readonly id: string;
    readonly because: string;
    readonly current: boolean;
    readonly ratio: string | null;
    readonly sighting: string | null;
    readonly base64?: string;
  }

  /** Put a still where a look would have left one, and say what she saw. */
  function showHerAStill(render: string, atSeconds: number, bytes: Buffer): string {
    const dir = studioAt(root).frames(render);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `at-${atSeconds.toFixed(1).replace(".", "-")}s.jpg`), bytes);
    return sightingOf(bytes);
  }

  it("should hand back the picture beside the token that names it", async () => {
    const response = await api("/renders/wardrobe?role=face");
    const body = (await response.json()) as Envelope<{ items: readonly Shown[] }>;

    expect(response.status).toBe(200);
    const [face] = body.data?.items ?? [];
    expect(face?.id).toBe("his-guess");
    // Both, or neither. The token is what makes adoption possible, so a row
    // carrying one without the picture would turn "she looked at it" back into
    // "she read a name".
    expect(face?.base64).toEqual(expect.any(String));
    expect(face?.sighting).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("should list every face and attach pictures only to as many as it says", async () => {
    // The list is never truncated — nothing of hers disappears from a view of
    // her own history — and the images are, because they reach a turn.
    for (const salt of [3, 4, 5]) {
      const sighting = showHerAStill(`syl-earlier-${String(salt)}`, 7.6, png(512, 682, salt));
      const kept = await api("/renders/wardrobe", {
        method: "POST",
        body: JSON.stringify({ sighting, as: "face", because: `attempt ${String(salt)}` }),
      });
      expect(kept.status).toBe(201);
    }

    const response = await api("/renders/wardrobe?role=face&show=1");
    const items = ((await response.json()) as Envelope<{ items: readonly Shown[] }>).data?.items ?? [];

    expect(items).toHaveLength(4);
    expect(items.filter((item) => item.sighting !== null)).toHaveLength(1);
    // The one she is shown is the current one, which is the one she most likely
    // wants to look at.
    expect(items[0]?.current).toBe(true);
  });

  it("should refuse to adopt a picture it has never shown her", async () => {
    const response = await api("/renders/wardrobe", {
      method: "POST",
      body: JSON.stringify({ sighting: "0123456789abcdef", as: "face", because: "this one" }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.message).toMatch(/have not shown you/iu);
  });

  it("should refuse to change her face without a reason", async () => {
    const sighting = showHerAStill("syl-earlier", 7.6, png(512, 682, 9));

    const response = await api("/renders/wardrobe", {
      method: "POST",
      body: JSON.stringify({ sighting, as: "face", because: "  " }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.message).toMatch(/reason|more you/iu);
  });

  it("should make the adopted face the one the next render is anchored on", async () => {
    const sighting = showHerAStill("syl-earlier", 7.6, png(512, 682, 11));
    await api("/renders/wardrobe", {
      method: "POST",
      body: JSON.stringify({ sighting, as: "face", because: "the mouth is finally mine" }),
    });

    const created = await api("/renders", { method: "POST", body: ASK });
    const record = ((await created.json()) as Envelope<{ record: { anchor: string | null } }>).data
      ?.record;

    expect(created.status).toBe(201);
    expect(record?.anchor).toMatch(/^renders\/faces\//u);
  });

  it("should say what shape a render made through each opening would be", async () => {
    const sighting = showHerAStill("syl-earlier", 0.4, png(1120, 832, 13));
    await api("/renders/wardrobe", {
      method: "POST",
      body: JSON.stringify({
        sighting,
        as: "opening",
        name: "the-long-fall",
        because: "a wider mood",
      }),
    });

    const response = await api("/renders/wardrobe?role=opening");
    const items = ((await response.json()) as Envelope<{ items: readonly Shown[] }>).data?.items ?? [];

    expect(items.map((item) => [item.id, item.ratio])).toEqual([
      ["the-long-fall", "1112:834"],
      // The seed ribbon in this suite is four bytes of PNG magic and no header,
      // so its shape genuinely cannot be read — and it says so rather than
      // being given the shape of the one it replaced.
      ["ribbon", null],
    ]);
  });

  it("should not be mistaken for a render called wardrobe", async () => {
    // `wardrobe` matches the render-name pattern, so this route only works
    // because it is registered ahead of `/renders/:name`. A reordering would
    // turn every read of her faces into a 404 about a render.
    const response = await api("/renders/wardrobe");

    expect(response.status).toBe(200);
  });
});

describe("the log, read back", () => {
  it("should carry what she concluded beside what she made", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;
    await api(`/renders/${name}/verdicts`, {
      method: "POST",
      body: JSON.stringify({ verdict: "The light is right and the mouth is not" }),
    });

    const response = await api("/renders");
    const body = (await response.json()) as Envelope<{
      items: readonly { name: string; scene: string; duration: number; ratio: string }[];
      verdicts: readonly { render: string; verdict: string }[];
    }>;

    // A journey she cannot review is not one she can learn from: what she asked
    // for, what it came out as, and what she made of it, in one read.
    expect(body.data?.items[0]?.scene).toContain("light run down her arm");
    expect(body.data?.verdicts[0]).toEqual(
      expect.objectContaining({ render: name, verdict: "The light is right and the mouth is not" }),
    );
  });
});
