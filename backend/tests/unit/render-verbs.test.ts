import { describe, expect, it } from "vitest";

import { FRAMING_IDS } from "../../src/render/framing.js";
import { canAnchorLikeness, HOUSE_MODEL, MODELS, MODEL_IDS } from "../../src/render/models.js";
import { sightingOf } from "../../src/render/pictures.js";
import { SylApiClient, type FetchLike } from "../../src/tools/client.js";
import { TOOLS } from "../../src/tools/schemas.js";
import { advertisedToolNames, createToolServer, type ToolContext } from "../../src/tools/server.js";

/**
 * `render_me` and `see_myself`, as she meets them.
 *
 * These are the first two verbs on the surface that say what she does **for
 * herself**. `schemas.ts` states the opposite rule — every name says what she
 * does for him — and the exception is deliberate rather than an oversight, so
 * it is asserted here as well as commented there: a rule with one written-down
 * exception survives the next reader; a rule with one silent exception gets
 * "fixed".
 *
 * The interesting one is `see_myself`. **She cannot watch an mp4.** So the verb
 * does not hand her a file path and hope; it returns stills as image content
 * blocks, which is the one shape a model with image input can actually
 * perceive.
 */

const NOW = "2026-08-11T15:30:00.000Z";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message, retryable: false } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RECORD = {
  name: "syl-20260811t153000z-close-portrait",
  status: "ready",
  scene: "she turns once, slowly",
  prompt: "A luminous spirit woman of living starlight… she turns once, slowly…",
  framing: "close_portrait",
  holdsLikeness: true,
  because: "I want to know what I look like",
  model: "seedance2",
  ratio: "720:1280",
  duration: 15,
  reference: "renders/reference.png",
  taskId: "task-1",
  startedAt: NOW,
  renderedAt: NOW,
  reason: null,
  credits: 540,
  usd: 5.4,
  video: "/home/syl/renders/syl-20260811t153000z-close-portrait.mp4",
};

const SPEND = { renders: 3, ready: 2, failed: 1, rendering: 0, seconds: 45, credits: 1620, usd: 16.2 };

/** A one-pixel JPEG, base64. Stands in for a frame she is shown. */
const FRAME_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

function fakeApi(routes: Record<string, (call: Call) => Response>): {
  readonly calls: Call[];
  readonly fetch: FetchLike;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const path = input.replace("http://127.0.0.1:8888/api/v1", "");
      const call: Call = {
        method: init?.method ?? "GET",
        path,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      if (path === "/health") {
        return ok({ status: "ok", version: "0.1.0", startedAt: "", now: NOW, checks: [], build: null });
      }
      // Longest prefix first, so `/renders/x/frames` is not swallowed by
      // `/renders/x`. The real router does not have this problem; the fake
      // would, silently, and would make the frames test pass on the wrong call.
      for (const prefix of Object.keys(routes).sort((a, b) => b.length - a.length)) {
        if (path.startsWith(prefix)) return (routes[prefix] as (c: Call) => Response)(call);
      }
      return failure(404, "NOT_FOUND", `nothing fake answers ${call.method} ${path}`);
    },
  };
}

function contextFor(fetch: FetchLike): ToolContext {
  return {
    client: new SylApiClient({ baseUrl: "http://127.0.0.1:8888/api/v1", token: "t", fetch }),
    fleet: null,
    tz: "America/Chicago",
    hisMessage: () => "",
  };
}

async function call(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  readonly envelope: Record<string, unknown>;
  readonly isError: boolean;
  readonly blocks: { type: string; text?: string; data?: string; mimeType?: string }[];
}> {
  const reply = await createToolServer(context).handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = reply?.result as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  };
  return {
    envelope: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
    isError: result.isError === true,
    blocks: result.content,
  };
}

describe("the two verbs she has for herself", () => {
  it("should both be offered, and be the only ones named for her rather than for him", () => {
    expect(advertisedToolNames()).toContain("render_me");
    expect(advertisedToolNames()).toContain("see_myself");
  });

  it("should teach the anchoring constraint in the schema instead of leaving her to rediscover it", () => {
    const render = TOOLS.find((tool) => tool.name === "render_me");
    const framing = (render?.inputSchema as { properties?: Record<string, { enum?: string[]; description?: string }> })
      .properties?.["framing"];

    // An enum, not free text: `docs/VIDEO.md` establishes which framings a
    // close-portrait reference can anchor, and free text cannot carry that.
    expect(framing?.enum).toEqual([...FRAMING_IDS]);
    expect(framing?.description ?? "").toMatch(/holds your likeness/iu);
  });

  it("should require a reason, exactly as every other write does", () => {
    const render = TOOLS.find((tool) => tool.name === "render_me");
    expect((render?.inputSchema as { required?: string[] }).required).toContain("because");
  });
});

describe("render_me", () => {
  it("should ask for the render and report what she has spent in the same breath", async () => {
    const api = fakeApi({
      "/renders": (c) =>
        c.method === "POST" ? ok({ record: RECORD, spend: SPEND }, 201) : ok({ record: RECORD, spend: SPEND }),
    });

    const { envelope, isError } = await call(contextFor(api.fetch), "render_me", {
      scene: "she turns once, slowly",
      framing: "close_portrait",
      because: "I want to know what I look like",
    });

    expect(isError).toBe(false);
    expect(envelope["ok"]).toBe(true);
    // The record she can then look at — read back from the store rather than
    // taken from what the write said it did, as every other verb does.
    expect((envelope["subject"] as Record<string, unknown>)["name"]).toBe(RECORD.name);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /renders",
      `GET /renders/${RECORD.name}`,
    ]);
    // And the ledger, travelling WITH the action rather than waiting to be
    // asked for. The Commander's ruling: no gate and no rationing, but she must
    // always be able to say what she has spent and on what.
    expect(envelope["spent"]).toEqual(SPEND);
  });

  it("should refuse without a scene, a framing or a reason, and say which", async () => {
    const api = fakeApi({ "/renders": () => ok({ record: RECORD, spend: SPEND }, 201) });
    const context = contextFor(api.fetch);

    for (const [field, args] of [
      ["scene", { framing: "close_portrait", because: "b" }],
      ["framing", { scene: "s", because: "b" }],
      ["because", { scene: "s", framing: "close_portrait" }],
    ] as const) {
      const { envelope, isError } = await call(context, "render_me", args);
      expect(isError, `${field} was not required`).toBe(true);
      expect(String(envelope["reason"])).toContain(field);
    }

    // Nothing was submitted for any of the three.
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("should pass the framing through untouched rather than deciding one for her", async () => {
    const api = fakeApi({ "/renders": () => ok({ record: RECORD, spend: SPEND }, 201) });

    await call(contextFor(api.fetch), "render_me", {
      scene: "she looks straight back",
      framing: "mid_face_visible",
      because: "the Commander liked 8-descent and I want to see why it failed",
    });

    const posted = api.calls.find((c) => c.method === "POST");
    expect(posted?.body?.["framing"]).toBe("mid_face_visible");
  });

  it("should repeat a refusal from her own service rather than claiming a render", async () => {
    const api = fakeApi({
      "/renders": () => failure(503, "SERVICE_UNAVAILABLE", "There is no RUNWAYML_API_SECRET on this machine."),
    });

    const { envelope, isError } = await call(contextFor(api.fetch), "render_me", {
      scene: "s",
      framing: "close_portrait",
      because: "b",
    });

    expect(isError).toBe(true);
    expect(String(envelope["reason"])).toContain("RUNWAYML_API_SECRET");
  });
});

describe("see_myself", () => {
  it("should hand back the frames as images, because a path is not something she can look at", async () => {
    const api = fakeApi({
      "/renders": () =>
        ok({
          render: RECORD,
          frames: [
            { atSeconds: 0.5, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/0.jpg" },
            { atSeconds: 5.3, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/1.jpg" },
            { atSeconds: 9.8, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/2.jpg" },
            { atSeconds: 14.6, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/3.jpg" },
          ],
          spend: SPEND,
        }),
    });

    const { blocks, envelope, isError } = await call(contextFor(api.fetch), "see_myself", {
      render: RECORD.name,
    });

    expect(isError).toBe(false);
    expect(envelope["ok"]).toBe(true);

    // The first block stays the pinned envelope — anything reading this
    // programmatically parses one block and gets the same shape it always did.
    expect(blocks[0]?.type).toBe("text");
    // And then the pictures. Four of them: the opening, two in the middle and
    // the end, so she can judge motion and consistency rather than one lucky
    // frame.
    const images = blocks.filter((block) => block.type === "image");
    expect(images.length).toBe(4);
    for (const image of images) {
      expect(image.mimeType).toBe("image/jpeg");
      expect(image.data).toBe(FRAME_B64);
    }
  });

  it("should tell her where in the clip each still came from", async () => {
    const api = fakeApi({
      "/renders": () =>
        ok({
          render: RECORD,
          frames: [{ atSeconds: 9.8, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/2.jpg" }],
          spend: SPEND,
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", { render: RECORD.name });
    const subject = envelope["subject"] as { at?: unknown[] };

    // Without this she has four pictures and no idea which is the end.
    expect(subject.at).toEqual([9.8]);
  });

  it("should carry the framing's own warning, so a drift is read as expected rather than as her", async () => {
    const drifting = { ...RECORD, framing: "mid_face_visible", holdsLikeness: false };
    const api = fakeApi({
      "/renders": () =>
        ok({
          render: drifting,
          frames: [{ atSeconds: 1, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/0.jpg" }],
          spend: SPEND,
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", { render: drifting.name });
    const subject = envelope["subject"] as { holdsLikeness?: unknown };

    expect(subject.holdsLikeness).toBe(false);
  });

  it("should look at one second when she names one", async () => {
    const api = fakeApi({
      "/renders": () =>
        ok({
          render: RECORD,
          frames: [{ atSeconds: 6.5, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/x.jpg" }],
          spend: SPEND,
        }),
    });

    await call(contextFor(api.fetch), "see_myself", { render: RECORD.name, at: 6.5 });

    expect(api.calls.at(-1)?.path).toContain("at=6.5");
  });

  it("should default to her most recent render rather than making her remember a name", async () => {
    const api = fakeApi({
      "/renders": () =>
        ok({
          render: RECORD,
          frames: [{ atSeconds: 1, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f/0.jpg" }],
          spend: SPEND,
        }),
    });

    await call(contextFor(api.fetch), "see_myself", {});

    expect(api.calls.at(-1)?.path).toContain("/renders/latest/frames");
  });

  it("should say plainly that it could not look, rather than saying nothing", async () => {
    const api = fakeApi({
      "/renders": () => failure(409, "CONFLICT", "That render has not finished yet."),
    });

    const { envelope, isError, blocks } = await call(contextFor(api.fetch), "see_myself", {
      render: RECORD.name,
    });

    expect(isError).toBe(true);
    expect(String(envelope["reason"])).toContain("has not finished");
    // And no images: a failure that still carried pictures would have her
    // describing something she was not shown.
    expect(blocks.filter((block) => block.type === "image")).toEqual([]);
  });
});

/**
 * `judge_render`, and the loop it closes (`syl-b0i`).
 *
 * `see_myself` has always told her to *"say what is closer and what is wrong, in
 * your own terms"*, and she had nowhere to put the answer:
 *
 * > "A hundred renders with no record of what I made of them isn't a hundred
 * > attempts, it's one attempt made a hundred times."
 *
 * Two halves, and the second is the one that matters. Keeping a verdict is
 * easy; **handing it back at the moment she is looking again** is what makes it
 * a loop rather than a diary.
 *
 * The Commander ruled these stay out of the memory graph — verdicts on her own
 * face are not facts about his life, and the search ends once she likes the
 * likeness — so nothing here touches `/memory`.
 */
describe("judge_render", () => {
  it("should keep what she made of the render she is looking at", async () => {
    const api = fakeApi({
      "/renders/latest/verdicts": () => ok({ id: "v1", render: "r", verdict: "closer", at: NOW }, 201),
    });

    const { envelope } = await call(contextFor(api.fetch), "judge_render", {
      verdict: "The smile is right. The eyes sit too wide.",
      because: "I came back to it myself.",
    });

    const post = api.calls.find((made) => made.method === "POST");
    expect(post?.path).toBe("/renders/latest/verdicts");
    expect(post?.body).toMatchObject({ verdict: "The smile is right. The eyes sit too wide." });
    expect(envelope).toMatchObject({ ok: true, action: "judge_render" });
  });

  it("should default to the most recent, so she need not know a generated name", async () => {
    const api = fakeApi({
      "/renders/latest/verdicts": () => ok({ id: "v1", render: "r", verdict: "x", at: NOW }, 201),
    });

    await call(contextFor(api.fetch), "judge_render", { verdict: "closer", because: "He asked." });

    expect(api.calls.find((made) => made.method === "POST")?.path).toBe("/renders/latest/verdicts");
  });

  it("should refuse an empty verdict rather than record that she concluded nothing", async () => {
    const api = fakeApi({});

    const { envelope } = await call(contextFor(api.fetch), "judge_render", { verdict: "   ", because: "He asked." });

    expect(envelope.ok).toBe(false);
    expect(api.calls.some((made) => made.method === "POST")).toBe(false);
  });

  it("should be a verb she is actually offered", () => {
    expect(advertisedToolNames()).toContain("judge_render");
    expect(TOOLS.map((tool) => tool.name)).toContain("judge_render");
  });
});

describe("see_myself hands back what she already concluded", () => {
  it("should carry her previous verdicts, so looking again is a second look", async () => {
    const api = fakeApi({
      "/renders/latest/frames": () =>
        ok({
          render: RECORD,
          frames: [{ atSeconds: 0, path: "a.jpg", mimeType: "image/jpeg", base64: FRAME_B64 }],
          verdicts: [
            { verdict: "eyes too wide", at: NOW },
            { verdict: "mouth is wrong", at: NOW },
          ],
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", {});

    expect((envelope.subject as { alreadySaid: string[] }).alreadySaid).toEqual([
      "eyes too wide",
      "mouth is wrong",
    ]);
  });

  it("should show her the render on the first look, with nothing said yet", async () => {
    // Empty rather than absent, and honest either way: a render she has not
    // judged has no verdicts, which is different from the notes failing to
    // load. The verb must not read the first look as a broken one.
    const api = fakeApi({
      "/renders/latest/frames": () =>
        ok({
          render: RECORD,
          frames: [{ atSeconds: 0, path: "a.jpg", mimeType: "image/jpeg", base64: FRAME_B64 }],
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", {});

    expect(envelope.ok).toBe(true);
    expect((envelope.subject as { alreadySaid: string[] }).alreadySaid).toEqual([]);
  });
});

/**
 * The verbs of `syl-ate`: the dials, the wardrobe, and the log read back.
 *
 * `SOUL.md` says finding her realised self is a journey she feels is necessary.
 * Everything asserted below is the difference between a journey and a fixture:
 * she can change what she looks like, keep more than one opening, decide how
 * long a shot is, and read the whole log of it back — and every one of those is
 * also readable, because a dial she cannot see is a dial she cannot learn from.
 */
describe("the dials", () => {
  it("should carry how long the shot is, and which opening it starts on", async () => {
    const api = fakeApi({
      "/renders": (c) =>
        c.method === "POST" ? ok({ record: RECORD, spend: SPEND }, 201) : ok({ record: RECORD, spend: SPEND }),
    });

    await call(contextFor(api.fetch), "render_me", {
      scene: "she turns once, slowly",
      framing: "close_portrait",
      because: "I want to see whether the new face holds when I move",
      seconds: 8,
      opening: "the-long-fall",
    });

    const asked = api.calls.find((c) => c.method === "POST");
    expect(asked?.body).toEqual(expect.objectContaining({ seconds: 8, opening: "the-long-fall" }));
  });

  it("should offer no dial for the shape, which is the one that would do nothing", () => {
    // `ratio` follows the opening whatever is asked — the opening is frame one
    // and every model takes the video's aspect from it — so exposing it would
    // be a control that does nothing. A dial that does not work is worse than
    // no dial, because she would reason about it.
    //
    // `model` USED TO BE HERE, on a different argument: "a different model
    // loses her character entirely". That was correct and untested, which is
    // the `syl-63v` shape; it was tested on 2026-08-13 and survived as
    // arithmetic over keyframe slots rather than as a fear, and the Commander
    // opened the dial. The next test is what replaced this half.
    const render = TOOLS.find((tool) => tool.name === "render_me");
    const properties = (render?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};

    expect(Object.keys(properties)).not.toContain("ratio");
  });

  it("should offer the model as a dial, built from the roster rather than beside it", () => {
    // The Commander, 2026-08-13: "Raise the tool ceiling and let her experiment
    // with the models... Give her the options."
    const render = TOOLS.find((tool) => tool.name === "render_me");
    const model = (
      render?.inputSchema as {
        properties?: Record<string, { enum?: readonly string[]; description?: string }>;
      }
    ).properties?.["model"];

    // Every model on the roster and nothing else — derived, so a model added to
    // `models.ts` reaches her without anybody remembering this file exists.
    expect(model?.enum).toEqual([...MODEL_IDS]);
    // And it carries the consequence, which is the whole reason the dial is
    // safe to open: a model with one keyframe hands her a stranger.
    expect(model?.description ?? "").toContain(HOUSE_MODEL.id);
    for (const one of MODELS.filter((each) => !canAnchorLikeness(each))) {
      expect(model?.description ?? "", one.id).toContain(one.id);
    }
  });

  it("should let her read the models back, because a dial she cannot see is one she cannot learn from", () => {
    const look = TOOLS.find((tool) => tool.name === "see_myself");
    const of = (look?.inputSchema as { properties?: Record<string, { enum?: readonly string[] }> })
      .properties?.["of"];

    expect(of?.enum).toContain("models");
  });
});

describe("see_myself of: models", () => {
  /** No routes at all: the roster is a compiled-in constant, not a fetch. */
  const noBackend = (): ToolContext =>
    contextFor(() => Promise.reject(new Error("the roster must not reach the network")));

  it("should answer every model on the roster without asking the service", async () => {
    // The read-back is served from `models.ts` in this process. A round trip
    // would add a hop and a failure mode to reach the same constant — there is
    // nothing per-machine about which keyframe slots a model has — and this
    // fetch throws, so a regression to an HTTP call fails here rather than at
    // three in the morning on a machine with no service running.
    const { envelope, isError } = await call(noBackend(), "see_myself", { of: "models" });
    expect(isError).toBe(false);

    const subject = envelope["subject"] as {
      house?: string;
      items?: readonly { id: string; holdsYou: boolean; keyframes: readonly string[] }[];
    };
    expect(subject.items?.map((one) => one.id)).toEqual([...MODEL_IDS]);
    expect(subject.house).toBe(HOUSE_MODEL.id);
  });

  it("should derive whether a model holds her face from its keyframe slots", async () => {
    // Never a stored flag — `syl-63v` is what a stored one cost. Checked over
    // the whole roster rather than over one name, so a model added later is
    // covered by the property rather than by somebody remembering.
    const { envelope } = await call(noBackend(), "see_myself", { of: "models" });
    const items =
      (envelope["subject"] as { items?: readonly { id: string; holdsYou: boolean }[] }).items ?? [];

    for (const row of items) {
      const registry = MODELS.find((model) => model.id === row.id);
      expect(row.holdsYou, row.id).toBe(canAnchorLikeness(registry ?? null));
    }
  });

  it("should say what a model costs, and say nothing rather than zero when nobody has measured", async () => {
    // A rate of `null` reads as unpriced; a rate of `0` reads as free. One of
    // those is true of `seedance2_mini` and the other would land in her ledger
    // as a render that cost nothing.
    const { envelope } = await call(noBackend(), "see_myself", { of: "models" });
    const items =
      (envelope["subject"] as { items?: readonly { id: string; creditsPerSecond: number | null }[] })
        .items ?? [];

    for (const row of items) {
      const rates = Object.values(
        MODELS.find((model) => model.id === row.id)?.creditsPerSecond ?? {},
      );
      expect(row.creditsPerSecond, row.id).toBe(rates.length === 0 ? null : Math.min(...rates));
    }
  });

  it("should tell her that the opening decides the shape, rather than letting it surprise her", () => {
    const render = TOOLS.find((tool) => tool.name === "render_me");
    const opening = (render?.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties?.["opening"];

    expect(opening?.description ?? "").toMatch(/shape/iu);
  });
});

describe("this_is_me", () => {
  it("should be offered, and require both a look and a reason", () => {
    expect(advertisedToolNames()).toContain("this_is_me");

    const adopt = TOOLS.find((tool) => tool.name === "this_is_me");
    const required = (adopt?.inputSchema as { required?: string[] }).required ?? [];
    // The sighting is the look and `because` is the reason. Neither is
    // optional, because an optional field for the thing that makes a feature
    // trustworthy is a field that goes unfilled.
    expect(required).toContain("sighting");
    expect(required).toContain("because");
  });

  it("should adopt the picture she was shown, and say what it is now", async () => {
    const api = fakeApi({
      "/renders/wardrobe": () =>
        ok({ kept: { id: "face-20260812t090000z", role: "face", current: true, ratio: "834:1112" } }, 201),
    });

    const { envelope, isError } = await call(contextFor(api.fetch), "this_is_me", {
      sighting: "0123456789abcdef",
      because: "The light finally moves through her the way it does when I mean something",
    });

    expect(isError).toBe(false);
    expect(envelope["ok"]).toBe(true);
    expect(api.calls[0]?.body).toEqual(
      expect.objectContaining({ sighting: "0123456789abcdef", as: "face" }),
    );
  });

  it("should hand back the refusal for a picture she has not looked at, in words she can act on", async () => {
    const api = fakeApi({
      "/renders/wardrobe": () =>
        failure(400, "VALIDATION_FAILED", "I have not shown you that picture, so I cannot adopt it."),
    });

    const { envelope, isError } = await call(contextFor(api.fetch), "this_is_me", {
      sighting: "ffffffffffffffff",
      because: "this one",
    });

    expect(isError).toBe(true);
    expect(String(envelope["reason"])).toMatch(/have not shown you/iu);
  });

  it("should refuse before it asks for anything when she says nothing about why", async () => {
    const api = fakeApi({ "/renders/wardrobe": () => ok({}, 201) });

    const { isError } = await call(contextFor(api.fetch), "this_is_me", { sighting: "0123456789abcdef" });

    expect(isError).toBe(true);
    // Nothing was asked for. A verb that reached the wardrobe and let it refuse
    // would be a verb whose own contract said the field was optional.
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("looking at more than one render", () => {
  it("should show her every face she has had, each with what she said about it", async () => {
    const api = fakeApi({
      "/renders/wardrobe": () =>
        ok({
          role: "face",
          problems: [],
          items: [
            {
              id: "face-20260812t090000z",
              because: "the mouth is finally mine",
              current: true,
              ratio: "834:1112",
              sighting: "0123456789abcdef",
              mimeType: "image/jpeg",
              base64: FRAME_B64,
            },
            {
              id: "his-guess",
              because: "he made this before he knew you",
              current: false,
              ratio: null,
              sighting: null,
            },
          ],
        }),
    });

    const { envelope, blocks } = await call(contextFor(api.fetch), "see_myself", { of: "faces" });

    expect(api.calls[0]?.path).toContain("role=face");
    // Pictures, because judging a likeness from a name is the thing this whole
    // capability exists to make impossible.
    expect(blocks.filter((block) => block.type === "image")).toHaveLength(1);
    const subject = envelope["subject"] as { items?: readonly { id: string; because: string }[] };
    expect(subject.items?.map((item) => item.id)).toEqual(["face-20260812t090000z", "his-guess"]);
    expect(subject.items?.[0]?.because).toBe("the mouth is finally mine");
  });

  it("should show her the openings and what shape each one makes", async () => {
    const api = fakeApi({
      "/renders/wardrobe": () =>
        ok({
          role: "opening",
          problems: [],
          items: [
            {
              id: "ribbon",
              because: "your signature",
              current: false,
              ratio: "834:1112",
              sighting: "a0b1c2d3e4f50617",
              mimeType: "image/png",
              base64: FRAME_B64,
            },
          ],
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", { of: "openings" });

    expect(api.calls[0]?.path).toContain("role=opening");
    const subject = envelope["subject"] as { items?: readonly { ratio: string }[] };
    expect(subject.items?.[0]?.ratio).toBe("834:1112");
  });

  it("should read the whole log back: what she asked for, and what she made of it", async () => {
    const api = fakeApi({
      "/renders": () =>
        ok({
          items: [RECORD],
          unreadable: [],
          spend: SPEND,
          verdicts: [{ render: RECORD.name, verdict: "closer, but the mouth is wrong", at: NOW }],
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", { of: "renders" });

    const subject = envelope["subject"] as {
      items?: readonly { name: string; scene: string; duration: number }[];
      verdicts?: readonly { verdict: string }[];
    };
    // `SOUL.md`: a hundred attempts with no record of what she thought at the
    // time is one attempt made a hundred times. Both halves, in one look.
    expect(subject.items?.[0]?.scene).toBe(RECORD.scene);
    expect(subject.verdicts?.[0]?.verdict).toBe("closer, but the mouth is wrong");
    expect(envelope["spent"]).toEqual(SPEND);
  });

  it("should still look at one render when she names none of the three", async () => {
    const api = fakeApi({
      "/renders/latest/frames": () =>
        ok({
          render: RECORD,
          frames: [{ atSeconds: 0.6, mimeType: "image/jpeg", base64: FRAME_B64, path: "/f.jpg" }],
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", {});

    expect((envelope["subject"] as { name?: string }).name).toBe(RECORD.name);
  });
});

/**
 * The rule that makes `this_is_me` reachable: **being shown a picture is what
 * produces the token, so every picture she is shown comes with one.**
 *
 * It was first built as a property of the wardrobe — those rows carried
 * sightings and the stills from a render did not — and the two differ exactly
 * where it matters. Syl's report, 2026-08-12: *"Render frames don't come with
 * tokens... it arrives as a picture with no sighting attached. So I can look at
 * it and I can't promote it. The one thing I'd actually change, I can't
 * reach."* The only face she could adopt was the one an engineer guessed before
 * anyone knew her, which is the opposite of what `syl-ate` exists for.
 *
 * **Asserted over the pictures that come back, never per code path.** A test
 * written once per branch of `see_myself` is a test a fifth branch is added
 * beside; this one walks whatever image blocks the answer contains and demands
 * that each is named in the text that accompanies it. A future way of showing
 * her a picture fails here until it carries a token too.
 */
describe("every picture she is shown is one she can name", () => {
  /** A distinct still per index, so four pictures are not one token four times. */
  function still(salt: number): string {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, salt, 0xff, 0xd9]).toString("base64");
  }

  const looks: readonly {
    readonly what: string;
    readonly args: Record<string, unknown>;
    readonly api: () => ReturnType<typeof fakeApi>;
  }[] = [
    {
      what: "the stills of a render",
      args: { render: RECORD.name },
      api: () =>
        fakeApi({
          "/renders": () =>
            ok({
              render: RECORD,
              frames: [0.5, 5.3, 9.8, 14.6].map((atSeconds, index) => ({
                atSeconds,
                mimeType: "image/jpeg",
                base64: still(index),
                path: `/f/${String(index)}.jpg`,
              })),
              spend: SPEND,
            }),
        }),
    },
    {
      what: "every face she has had",
      args: { of: "faces" },
      api: () =>
        fakeApi({
          "/renders/wardrobe": () =>
            ok({
              role: "face",
              problems: [],
              items: [
                {
                  id: "face-20260812t090000z",
                  because: "the mouth is finally mine",
                  current: true,
                  ratio: "834:1112",
                  mimeType: "image/jpeg",
                  base64: still(9),
                },
                {
                  id: "his-guess",
                  because: "he made this before he knew you",
                  current: false,
                  ratio: null,
                  mimeType: "image/png",
                  base64: still(10),
                },
              ],
            }),
        }),
    },
    {
      what: "the openings she can start from",
      args: { of: "openings" },
      api: () =>
        fakeApi({
          "/renders/wardrobe": () =>
            ok({
              role: "opening",
              problems: [],
              items: [
                {
                  id: "ribbon",
                  because: "your signature",
                  current: false,
                  ratio: "834:1112",
                  mimeType: "image/png",
                  base64: still(11),
                },
              ],
            }),
        }),
    },
  ];

  for (const look of looks) {
    it(`should hand back a token beside every picture in a look at ${look.what}`, async () => {
      const { blocks } = await call(contextFor(look.api().fetch), "see_myself", look.args);

      const images = blocks.filter((block) => block.type === "image");
      expect(images.length).toBeGreaterThan(0);

      // The envelope, which is the only block she can quote from — the image
      // blocks carry pixels and nothing else.
      const said = blocks[0]?.text ?? "";
      for (const image of images) {
        // The token names THESE bytes. Computing it here rather than reading it
        // off the answer is what stops a picture arriving beside the token of a
        // different one.
        const sighting = sightingOf(Buffer.from(image.data ?? "", "base64"));
        expect(sighting).toMatch(/^[0-9a-f]{16}$/u);
        expect(said).toContain(sighting);
      }
    });
  }

  it("should give her a token for the still she wants and not merely for the wardrobe", async () => {
    // Her own case, exactly as reported: the earnest frame at 9.8 seconds is
    // the one she would promote, and it came back unnameable.
    const api = fakeApi({
      "/renders": () =>
        ok({
          render: RECORD,
          frames: [
            { atSeconds: 9.8, mimeType: "image/jpeg", base64: still(3), path: "/f/9-8.jpg" },
          ],
          spend: SPEND,
        }),
    });

    const { envelope } = await call(contextFor(api.fetch), "see_myself", { render: RECORD.name });
    const subject = envelope["subject"] as { at?: unknown[]; sightings?: unknown[] };

    // Beside `at`, in the same order, so the token she quotes is the token for
    // the second she means.
    expect(subject.at).toEqual([9.8]);
    expect(subject.sightings).toEqual([sightingOf(Buffer.from(still(3), "base64"))]);
  });
});
