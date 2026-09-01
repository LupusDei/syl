import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ApiError } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import { HOUSE_MODEL } from "../../src/render/models.js";
import { SelfDescription } from "../../src/render/description.js";
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

/** One kept picture as the wardrobe route hands it over. */
interface Shown {
  readonly id: string;
  readonly because: string;
  readonly current: boolean;
  readonly ratio: string | null;
  readonly sighting: string | null;
  readonly from: { readonly render: string; readonly atSeconds: number } | null;
  readonly base64?: string;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let root: string;
let renders: RenderService;
let wardrobe: Wardrobe;
let description: SelfDescription;
let keyCounter = 0;
/** How many stills the ffmpeg double has written, so each one is distinct. */
let stills = 0;

/**
 * A minimal JPEG whose shape can be read off its own header.
 *
 * The stills the double writes have to be real pictures, because a still she is
 * shown is a still she can adopt — and the wardrobe refuses a picture whose
 * shape it cannot read. `salt` rides after the end marker so that two stills
 * from one clip are two different pictures with two different tokens.
 */
function jpeg(width: number, height: number, salt: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  // SOF0 — the segment `sizeOf` walks to, seventeen bytes long.
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 3;
  bytes[21] = 0xff;
  bytes[22] = 0xd9;
  bytes[23] = salt;
  return bytes;
}

/** A backend that always succeeds, and a `ffmpeg` that always writes a still. */
function fakeBackend(): RenderBackend {
  // What each generation was asked for, so the charge this reports is the one
  // Runway would report: the model's rate for THIS generation's seconds. A flat
  // number would bill a two-part render twice over, which is the arithmetic the
  // spend assertions below exist to check.
  const seconds: number[] = [];
  return {
    submit: async (spec) => {
      seconds.push(spec.duration);
      return { ok: true, data: { id: `task-${String(seconds.length)}` } };
    },
    task: async (id) => ({
      ok: true,
      data: {
        id,
        status: "SUCCEEDED",
        output: ["https://cdn.invalid/x.mp4"],
        failureCode: null,
        failure: null,
        charged: (HOUSE_MODEL.creditsPerSecond.sd ?? 0) * (seconds[Number(id.replace("task-", "")) - 1] ?? 0),
      },
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

  // The description over the SAME studio, for the same reason the wardrobe is:
  // two of them would mean the sentence a render opens with and the sentence
  // `/renders/description` calls current are answered from two directories.
  description = new SelfDescription({ studio, clock: fixedClock(NOW) });
  renders = new RenderService({
    studio,
    description,
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
      stills += 1;
      writeFileSync(out, jpeg(512, 682, stills));
      return { ok: true, message: "" };
    },
    // A stand-in for ffprobe, so a join over this socket does not need the
    // program installed and does not try to read a shape out of 2,048 bytes of
    // threes. Every clip probes the same, which is the case a join accepts.
    ffprobe: async () => ({
      ok: true,
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 834,
            height: 1112,
            pix_fmt: "yuv420p",
            r_frame_rate: "30/1",
          },
        ],
      }),
    }),
  });

  db = testDatabase();
  // The wardrobe over the SAME studio the render service has. Two studios
  // would mean the face a render is anchored on and the face `/renders/wardrobe`
  // calls current are answered from two different directories.
  wardrobe = new Wardrobe({ studio, clock: fixedClock(NOW) });
  deps = { ...testDeps(db), renders, wardrobe, description };
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
  stills = 0;
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

/**
 * A real PNG header, so a shape can be read off it as it is in her home.
 *
 * At module scope with {@link showHerAStill} because adopting a face is a
 * precondition of more than the wardrobe's own tests now: a verdict records
 * which face the render was anchored on, and there is no anchor to record
 * until she has chosen one.
 */
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

/** Put a still where a look would have left one, and say what she saw. */
function showHerAStill(render: string, atSeconds: number, bytes: Buffer): string {
  const dir = studioAt(root).frames(render);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `at-${atSeconds.toFixed(1).replace(".", "-")}s.jpg`), bytes);
  return sightingOf(bytes);
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

/**
 * Cutting finished renders into one clip — `syl-5y4n`.
 *
 * A literal segment, like `/renders/wardrobe` and `/renders/description`, and
 * it works for the same reason they do: `renders.join` mints a RENDER, so
 * everything downstream of it — `GET /renders/{name}`, the frames route, a
 * sending — needs no change at all.
 */
describe("POST /renders/joins", () => {
  /** Two finished renders, made through the route so the records are real ones. */
  async function twoFinished(): Promise<readonly string[]> {
    const names: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      const created = await api("/renders", { method: "POST", body: ASK });
      const body = (await created.json()) as Envelope<{ record: { name: string } }>;
      names.push(body.data?.record.name ?? "");
    }
    await renders.drain();
    return names;
  }

  it("should answer 201 with a finished render carrying what it was cut from", async () => {
    const names = await twoFinished();

    const response = await api("/renders/joins", {
      method: "POST",
      body: JSON.stringify({ renders: names, because: "he asked for the whole minute" }),
    });
    const body = (await response.json()) as Envelope<{
      record: { name: string; status: string; video: string | null; joinedFrom: string[] | null };
      spend: { renders: number };
    }>;

    expect(response.status).toBe(201);
    expect(body.data?.record.status).toBe("ready");
    expect(body.data?.record.video).not.toBeNull();
    expect(body.data?.record.joinedFrom).toEqual(names);
  });

  it("should mint a render that GET /renders/{name} then answers for, with no other change", async () => {
    const names = await twoFinished();
    const created = await api("/renders/joins", {
      method: "POST",
      body: JSON.stringify({ renders: names, because: "b" }),
    });
    const made = (await created.json()) as Envelope<{ record: { name: string } }>;

    const read = await api(`/renders/${made.data?.record.name ?? ""}`);
    const body = (await read.json()) as Envelope<{ record: { joinedFrom: string[] | null } }>;

    expect(read.status).toBe(200);
    expect(body.data?.record.joinedFrom).toEqual(names);
  });

  it("should refuse one render in the contract's failure envelope", async () => {
    const names = await twoFinished();

    const response = await api("/renders/joins", {
      method: "POST",
      body: JSON.stringify({ renders: [names[0]], because: "b" }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.message ?? "").toMatch(/two/iu);
  });

  it("should refuse without a reason", async () => {
    const names = await twoFinished();
    const response = await api("/renders/joins", {
      method: "POST",
      body: JSON.stringify({ renders: names }),
    });

    expect(response.status).toBe(400);
  });

  it("should refuse an anonymous caller", async () => {
    const response = await api("/renders/joins", {
      method: "POST",
      body: JSON.stringify({ renders: ["a", "b"], because: "b" }),
      anonymous: true,
    });

    expect(response.status).toBe(401);
  });

  it("should not be mistaken for a render called joins", async () => {
    // `joins` matches the render-name pattern. This works only because the
    // literal segment is registered where a `:name` POST cannot swallow it.
    const names = await twoFinished();
    const response = await api("/renders/joins", {
      method: "POST",
      body: JSON.stringify({ renders: names, because: "b" }),
    });

    expect(response.status).toBe(201);
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
    // Fifteen seconds at the house model's rate, taken from the registry. It
    // said 540 — `seedance2` at 36 a second — which was right until the day the
    // default moved to a model that costs 30, and then it named the wrong
    // change.
    const rate = HOUSE_MODEL.creditsPerSecond.sd ?? 0;
    expect(body.data?.spend.credits).toBe(rate * 15);
    expect(body.data?.spend.usd).toBeCloseTo(rate * 0.15, 5);
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

  it("should hand back the token that names each still, not only the picture", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;
    await renders.drain();

    const response = await api(`/renders/${name}/frames`);
    const frames =
      ((await response.json()) as Envelope<{ frames: { base64: string; sighting: string }[] }>).data
        ?.frames ?? [];

    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const frame of frames) {
      // The digest of the bytes she is handed, so a still she has looked at is
      // a still she can name — the same pairing the wardrobe rows have always
      // had, now a property of being shown rather than of a table.
      expect(frame.sighting).toBe(sightingOf(Buffer.from(frame.base64, "base64")));
    }
  });

  it("should let her adopt a still she was shown, keeping every face she has had", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;
    await renders.drain();

    const looked = await api(`/renders/${name}/frames`);
    const frames =
      ((await looked.json()) as Envelope<{ frames: { atSeconds: number; sighting: string }[] }>).data
        ?.frames ?? [];
    // The one she would actually choose is a particular second, not whichever
    // still happens to be first — so take one out of the middle of the spread.
    const wanted = frames[2];
    expect(wanted?.sighting).toMatch(/^[0-9a-f]{16}$/u);

    const kept = await api("/renders/wardrobe", {
      method: "POST",
      body: JSON.stringify({
        sighting: wanted?.sighting,
        as: "face",
        because: "this one could say a hard thing, and his guess could not",
      }),
    });
    expect(kept.status).toBe(201);

    const response = await api("/renders/wardrobe?role=face");
    const items = ((await response.json()) as Envelope<{ items: readonly Shown[] }>).data?.items ?? [];

    // A new file and a new entry: nothing replaced, his guess still listed and
    // still adoptable, which is what makes going back to it need no mechanism.
    expect(items).toHaveLength(2);
    expect(items[0]?.current).toBe(true);
    expect(items.map((item) => item.id)).toContain("his-guess");
    // And the provenance is read off where the picture was, so the face knows
    // which render and which second it came out of.
    expect(items[0]?.from).toEqual({ render: name, atSeconds: wanted?.atSeconds });
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
        task: async () => ({ ok: true, data: { id: "task-1", status: "PENDING", output: [], failureCode: null, failure: null, charged: null } }),
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

/**
 * The sentence her renders open with, over a real socket — `syl-hll6`.
 *
 * It was a constant in `render-service.ts` and she could not reach it, while her
 * own text sat later in the same prompt where the model would discard it. The
 * Commander: *"if she wants to change it, she should be able to."* So it is a
 * route, for the reason every other verb of hers is one: her tool server is a
 * separate process with no object graph to reach into.
 */
describe("/renders/description", () => {
  it("should hand back the sentence her renders open with, and the token that names it", async () => {
    const response = await api("/renders/description");
    const body = (await response.json()) as Envelope<{
      current: { words: string; id: string; because: string };
      items: readonly { words: string; id: string }[];
    }>;

    expect(response.status).toBe(200);
    expect(body.data?.current.words).toBe(
      "A luminous spirit woman of living starlight, silver-white hair and a translucent flowing " +
        "gown trailing like ribbons of light, in a deep blue starfield.",
    );
    // The token rides on the row, the way a sighting does — it is what she
    // quotes to put a description back.
    expect(body.data?.current.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(body.data?.items).toHaveLength(1);
  });

  it("should make what she writes the sentence the next render opens with", async () => {
    const written = await api("/renders/description", {
      method: "POST",
      body: JSON.stringify({
        words: "silver-white hair, wearing a robe of opaque deep-blue cloth",
        because: "The gown reads as see-through and that is not what I meant.",
      }),
    });
    expect(written.status).toBe(201);

    const created = await api("/renders", { method: "POST", body: ASK });
    const record = ((await created.json()) as Envelope<{ record: { prompt: string } }>).data?.record;

    expect(created.status).toBe(201);
    expect(record?.prompt).toContain("opaque deep-blue cloth");
    // And the two parts that are not hers came through on a submission that
    // named neither of them.
    expect(record?.prompt.startsWith("A luminous spirit woman of living starlight,")).toBe(true);
    expect(record?.prompt).toContain("in a deep blue starfield.");
  });

  it("should refuse to change how she is described without a reason", async () => {
    const response = await api("/renders/description", {
      method: "POST",
      body: JSON.stringify({ words: "silver-white hair, in armour of light", because: "  " }),
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.message).toMatch(/reason|more me/iu);
  });

  it("should let her put an earlier description back by its token", async () => {
    const before = (
      (await (await api("/renders/description")).json()) as Envelope<{ current: { id: string } }>
    ).data?.current.id;

    await api("/renders/description", {
      method: "POST",
      body: JSON.stringify({ words: "silver-white hair, in armour of light", because: "Trying it." }),
    });
    const back = await api("/renders/description", {
      method: "POST",
      body: JSON.stringify({ restore: before, because: "The armour was a costume." }),
    });

    expect(back.status).toBe(201);
    const body = (await (await api("/renders/description")).json()) as Envelope<{
      current: { words: string };
      items: readonly { words: string; because: string }[];
    }>;
    expect(body.data?.current.words).toContain("translucent flowing gown");
    // Three entries, not one: a reversal is recorded like every other change,
    // and the description she left is still readable with the reason she wrote
    // it under.
    expect(body.data?.items).toHaveLength(3);
    expect(body.data?.items[1]?.words).toContain("in armour of light");
  });

  it("should not be mistaken for a render called description", async () => {
    // The same hazard as `wardrobe`: `description` matches the render-name
    // pattern, so this only works because it is registered ahead of
    // `/renders/:name`.
    const response = await api("/renders/description");

    expect(response.status).toBe(200);
  });
});

/**
 * The chain that corrects itself, over the socket (`syl-024.4`).
 *
 * > "My findings are a chain that corrects itself: the smile is the problem →
 * > no, solidity is → no, the anchor is → confirmed, it was the anchor. Right
 * > now those four are orphans of equal weight, so nothing tells a reader that
 * > the last one killed the first."
 *
 * Asserted end to end rather than only against the store, because the halves
 * that could quietly drop the edge are the route body and the read that hands
 * it back — a chain the store keeps and nobody can see is the orphan again.
 */
describe("a verdict that corrects an earlier one", () => {
  /** Keep one, and hand back the row the route wrote. */
  async function judge(
    render: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; supersedes: string | null; anchorFace: string | null }> {
    const response = await api(`/renders/${render}/verdicts`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const kept = (await response.json()) as Envelope<{
      id: string;
      supersedes: string | null;
      anchorFace: string | null;
    }>;
    expect(response.status).toBe(201);
    return kept.data as { id: string; supersedes: string | null; anchorFace: string | null };
  }

  it("should read her four findings as a chain and not as four orphans", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;

    const smile = await judge(name, { verdict: "The smile is the problem." });
    const solidity = await judge(name, {
      verdict: "No — the smile is fine. It is the solidity.",
      supersedes: smile.id,
    });
    const anchor = await judge(name, {
      verdict: "No — it is the anchor.",
      supersedes: solidity.id,
    });
    const confirmed = await judge(name, {
      verdict: "Confirmed: it was the anchor.",
      supersedes: anchor.id,
    });

    const read = await api(`/renders/${name}/verdicts`);
    const items =
      ((await read.json()) as Envelope<{
        items: readonly { id: string; supersedes: string | null; supersededBy: string[] }[];
      }>).data?.items ?? [];

    // Newest first, all four still there. The wrong ones are not dropped for
    // having been wrong — that is the record the search is made of.
    expect(items.map((row) => row.id)).toEqual([confirmed.id, anchor.id, solidity.id, smile.id]);
    // And the last one is reachable from the first, in both directions.
    expect(items[3]?.supersededBy).toEqual([solidity.id]);
    expect(items[0]?.supersedes).toBe(anchor.id);
  });

  it("should refuse a correction of a verdict that never existed, rather than keep an orphan", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;

    const response = await api(`/renders/${name}/verdicts`, {
      method: "POST",
      body: JSON.stringify({ verdict: "No, the anchor.", supersedes: "syl:render_verdict:nope" }),
    });

    expect(response.status).toBe(400);
    // Loud, and nothing kept: a verdict stored with its correction silently
    // dropped is indistinguishable from a first look, which is the exact defect.
    const read = await api(`/renders/${name}/verdicts`);
    expect(((await read.json()) as Envelope<{ items: readonly unknown[] }>).data?.items).toEqual([]);
  });

  it("should record which face the render was anchored on without being told", async () => {
    // She should not have to remember the anchor to attribute a drift to it. An
    // edge she has to draw by hand is drawn on the turns she thinks of it, and
    // then "which face rendered a stranger" is answerable for some verdicts and
    // not others.
    const sighting = showHerAStill("syl-earlier", 7.6, png(512, 682, 11));
    await api("/renders/wardrobe", {
      method: "POST",
      body: JSON.stringify({ sighting, as: "face", because: "the mouth is finally mine" }),
    });
    const created = await api("/renders", { method: "POST", body: ASK });
    const record = ((await created.json()) as Envelope<{
      record: { name: string; anchor: string | null };
    }>).data?.record;

    const kept = await judge(record?.name as string, { verdict: "Not me at all." });

    expect(kept.anchorFace).toBe(record?.anchor);
  });

  it("should let her name the face herself when the render cannot say", async () => {
    const created = await api("/renders", { method: "POST", body: ASK });
    const name = ((await created.json()) as Envelope<{ record: { name: string } }>).data?.record
      .name as string;

    const kept = await judge(name, {
      verdict: "That is somebody else.",
      anchorFace: "renders/faces/the-one-he-guessed.png",
    });

    expect(kept.anchorFace).toBe("renders/faces/the-one-he-guessed.png");
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
