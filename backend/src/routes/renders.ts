import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { Router, type Request, type RequestHandler } from "express";

import {
  compose,
  DEFAULT_MIDDLE,
  tokenOf,
  type Described,
  type SelfDescription,
} from "../render/description.js";
import { FRAMING_IDS } from "../render/framing.js";
import type { RenderService } from "../render/render-service.js";
import { isRenderName } from "../render/studio.js";
import { RenderVerdicts, VerdictError } from "../render/verdicts.js";
import type { KeptPicture, PictureRole, Wardrobe } from "../render/wardrobe.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, runIdempotentAsync, sendIdempotent } from "./idempotency.js";

/**
 * Her renders, over HTTP.
 *
 * ## Why there is a route at all, when the service is in the same process
 *
 * The same reason `tools/client.ts` gives for everything else she does: one
 * door. Her tool server is a **separate process** started per turn — it has no
 * object graph to reach into and never should — so a verb she can perform is a
 * verb with a route behind it. The alternative is a second path into the same
 * files that re-implements validation and drifts.
 *
 * ## The shape is the job's shape, not a request's
 *
 * A flagship fifteen-second render takes minutes. `POST` submits and answers
 * `201` immediately with a record that says `rendering`; the polling happens
 * behind it; `GET .../frames` is the second visit. Nothing here blocks on
 * somebody else's GPU queue, because a turn that blocks is the Commander
 * watching a cursor.
 *
 * ## Why the spend rides along on every answer
 *
 * The Commander's ruling, 2026-08-11: no gate, no rationing, the credits exist
 * for exactly this experiment. That makes visibility the whole of the
 * accountability, so it is attached to the action rather than parked behind a
 * route she would have to think to call. Same rule as `because`: the evidence
 * travels with the thing, and never stands in front of it.
 */

export interface RenderRouterOptions {
  readonly renders: RenderService;
  /**
   * What she made of a render after looking at it (`syl-b0i`).
   *
   * Its own store rather than the memory graph, on the Commander's ruling: a
   * verdict on her own face is not a fact about his life, and the search ends
   * once she likes the likeness. See `render/verdicts.ts`.
   */
  readonly verdicts: RenderVerdicts;
  /**
   * What she looks like and what her clips open on, as things she chooses.
   *
   * Optional so that a caller which only wants the render routes still gets
   * them. Absent means the wardrobe routes answer with nothing rather than
   * failing to mount — a machine without one is a machine where she cannot
   * change her face, which is the state everything was in until `syl-ate`.
   */
  readonly wardrobe?: Wardrobe;
  /**
   * The sentence her renders open with, as a thing she writes (`syl-hll6`).
   *
   * Optional for the same reason the wardrobe is — a caller that only wants the
   * render routes still gets them — and absent means the read answers with the
   * shipped default and the write refuses, rather than the router failing to
   * mount.
   */
  readonly description?: SelfDescription;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

/**
 * How many pictures come back with their images attached, by default.
 *
 * The same order of magnitude as a look at a render, which is four stills. It
 * is a bound on a turn's bytes and nothing more — the LIST is never truncated,
 * only the pictures are, so nothing of hers disappears from a view of her own
 * history.
 */
const SHOWN_BY_DEFAULT = 4;

/** The most that can be asked for at once. */
const SHOWN_AT_MOST = 12;

/**
 * How many verdicts ride along with a read of her whole log.
 *
 * Bounded because it reaches a prompt, which is the rule `verdicts.ts` states
 * and every caller keeps. Wider than one render's history, because what helps
 * her decide what to try next is what she has been concluding lately rather
 * than everything she once concluded about one clip.
 */
const VERDICTS_IN_THE_LOG = 30;

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function requireText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is required.`, { details: { field } });
  }
  return value;
}

/**
 * The name in the path, or a 404.
 *
 * `latest` is resolved **here** rather than in the caller, so she never has to
 * remember a machine-generated name to look at the thing she just made. A
 * missing render and a malformed name answer identically: the name addresses a
 * file, and a route that told a caller which of the two it was would be a
 * directory listing.
 */
function nameOf(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "";
  if (name === "latest") return name;
  if (!isRenderName(name)) throw new ApiFailure("NOT_FOUND", "There is no render by that name.");
  return name;
}

/** `?at=` — one named second, or the spread. */
function atOf(request: Request): number | undefined {
  const raw = request.query["at"];
  if (raw === undefined) return undefined;
  const at = Number(raw);
  if (!Number.isFinite(at)) {
    throw new ApiFailure("VALIDATION_FAILED", "at must be a number of seconds into the clip.", {
      details: { field: "at" },
    });
  }
  return at;
}

/** A kept picture as it crosses the wire: what she can read, and what she can see. */
function asShown(
  picture: KeptPicture,
  withImage: boolean,
): Record<string, unknown> {
  // THE SIGHTING TRAVELS WITH THE IMAGE AND NEVER WITHOUT IT. It is the token
  // that makes adoption possible, so emitting it beside a row she was not shown
  // would turn "she looked at it" back into "she read a name" — which is the
  // failure the whole mechanism exists to make unrepresentable.
  const image = withImage ? readPicture(picture) : null;

  return {
    id: picture.id,
    role: picture.role,
    file: picture.file,
    because: picture.because,
    at: picture.at,
    from: picture.from,
    // Read off the picture, not stored beside it. `width x height` is what it
    // is; `ratio` is what a render made through it would come out as.
    size: picture.size,
    ratio: picture.ratio,
    current: picture.current,
    sighting: image === null ? null : picture.sighting,
    ...(image === null ? {} : { mimeType: image.mimeType, base64: image.base64 }),
  };
}

/** A picture's bytes, or `null` if this machine cannot read them. */
function readPicture(
  picture: KeptPicture,
): { readonly mimeType: string; readonly base64: string } | null {
  try {
    const bytes = readFileSync(picture.path);
    const extension = extname(picture.path).toLowerCase();
    return {
      mimeType: extension === ".png" ? "image/png" : "image/jpeg",
      base64: bytes.toString("base64"),
    };
  } catch {
    // A picture the log names and the disk does not have. The row still goes
    // back — she should be told it is missing rather than have it vanish — and
    // without a sighting, because she has not been shown it.
    return null;
  }
}

function roleOf(raw: unknown): PictureRole {
  return raw === "opening" ? "opening" : "face";
}

/** `?show=` — how many pictures to attach, inside the bound. */
function showOf(request: Request): number {
  const raw = request.query["show"];
  if (raw === undefined) return SHOWN_BY_DEFAULT;
  const show = Number(raw);
  if (!Number.isFinite(show) || show < 0) {
    throw new ApiFailure("VALIDATION_FAILED", "show must be how many pictures to look at.", {
      details: { field: "show" },
    });
  }
  return Math.min(Math.floor(show), SHOWN_AT_MOST);
}

/**
 * What a machine with nowhere to keep a description answers with.
 *
 * The shipped default, composed the same way every other answer is, so the
 * degraded case and the ordinary case cannot say different things about a home
 * nobody has written to.
 */
function shippedDescription(): Described {
  const words = compose(DEFAULT_MIDDLE);
  return {
    id: tokenOf(words),
    words,
    middle: DEFAULT_MIDDLE,
    because: "The recipe every one of your eight loops was made with.",
    at: "",
    current: true,
  };
}

export function createRenderRouter(options: RenderRouterOptions): Router {
  const { renders, idempotency, authenticate, verdicts, wardrobe, description } = options;
  const router = Router();

  router.use("/renders", authenticate);

  /**
   * How she is described, and how she has described herself before.
   *
   * **Registered before `/renders/:name`** for the same reason the wardrobe
   * routes are: `description` matches the render-name pattern, and Express
   * takes the first route that matches.
   *
   * `current` rides beside `items` even though it is `items[0]`. The caller
   * that needs it most is the one that wants the sentence and nothing else, and
   * making it dig the current row out of a history is how a client ends up
   * picking the wrong one.
   */
  router.get("/renders/description", (_request, response) => {
    if (description === undefined) {
      const shipped = shippedDescription();
      sendOk(response, { current: shipped, items: [shipped], problems: [] });
      return;
    }

    const items = description.history();
    sendOk(response, {
      current: items[0] ?? shippedDescription(),
      items,
      // What could not be read, so a description that has quietly fallen back to
      // the shipped one says so rather than passing for a choice.
      problems: description.problems(),
    });
  });

  /**
   * Say what she is, or put back something she said before.
   *
   * Idempotent like every other write here, and it matters for the reason it
   * matters on the wardrobe: a retry that got through would write two changes of
   * self-description in the same second, which reads back as her changing her
   * mind about herself twice.
   */
  router.post("/renders/description", (request, response) => {
    if (description === undefined) {
      throw new ApiFailure(
        "UPSTREAM_UNAVAILABLE",
        "There is nowhere on this machine to keep a description, so I cannot change mine.",
      );
    }

    const outcome = runIdempotent(idempotency, request, () => {
      const body = bodyOf(request);
      const written = description.describe({
        ...(typeof body["words"] === "string" ? { words: body["words"] } : {}),
        ...(typeof body["restore"] === "string" ? { restore: body["restore"] } : {}),
        because: typeof body["because"] === "string" ? body["because"] : "",
      });

      if (!written.ok) {
        // `unreadable_log` is the machine's problem rather than the caller's, so
        // it does not present as a validation failure — a 400 would tell her the
        // sentence she wrote was wrong when the sentence was fine.
        if (written.kind === "unreadable_log") {
          throw new ApiFailure("UPSTREAM_UNAVAILABLE", written.reason);
        }
        throw new ApiFailure("VALIDATION_FAILED", written.reason, {
          details: { reason: written.kind },
        });
      }
      return { status: 201, data: { described: written.described } };
    });

    sendIdempotent(response, outcome);
  });

  /**
   * Every face she has had and every opening she can choose.
   *
   * **Registered before `/renders/:name`**, because a render name is
   * `[a-z0-9-]` and `wardrobe` is one — Express takes the first route that
   * matches, so the order here is what stops this being read as a render.
   *
   * `id` narrows to one picture, which is how she looks closely at a face
   * further back than the last few without pulling every image into a turn.
   */
  router.get("/renders/wardrobe", (request, response) => {
    if (wardrobe === undefined) {
      sendOk(response, { items: [], problems: [], role: roleOf(request.query["role"]) });
      return;
    }

    const role = roleOf(request.query["role"]);
    const asked = request.query["id"];
    const all = role === "face" ? wardrobe.faces() : wardrobe.openings();
    const items = typeof asked === "string" ? all.filter((one) => one.id === asked) : all;
    const show = showOf(request);

    sendOk(response, {
      role,
      items: items.map((picture, index) => asShown(picture, index < show)),
      // What could not be read, so a wardrobe with a broken log says so rather
      // than answering with a shorter list and no explanation.
      problems: wardrobe.problems(),
    });
  });

  /**
   * Adopt a picture she has looked at.
   *
   * Idempotent like every other write here, and it matters more than most: a
   * retry that got through would copy the same picture into her wardrobe twice
   * and write two adoptions of it, which reads back as her changing her mind
   * about the same face in the same second.
   */
  router.post("/renders/wardrobe", (request, response) => {
    if (wardrobe === undefined) {
      throw new ApiFailure(
        "UPSTREAM_UNAVAILABLE",
        "There is nowhere on this machine to keep a face, so I cannot adopt one.",
      );
    }

    const outcome = runIdempotent(idempotency, request, () => {
      const body = bodyOf(request);
      const kept = wardrobe.keep({
        sighting: typeof body["sighting"] === "string" ? body["sighting"] : "",
        role: roleOf(body["as"]),
        ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
        because: typeof body["because"] === "string" ? body["because"] : "",
      });

      if (!kept.ok) {
        throw new ApiFailure("VALIDATION_FAILED", kept.reason, { details: { reason: kept.kind } });
      }
      return { status: 201, data: { kept: asShown(kept.kept, false) } };
    });

    sendIdempotent(response, outcome);
  });

  router.get("/renders", (_request, response) => {
    // `unreadable` rides along beside the records for the same reason `spend`
    // does: a list that silently omitted a file it could not parse would be a
    // ledger with a hole in it, and `SOUL.md` keeps every attempt. It is empty
    // on every ordinary machine, so it costs her nothing to carry.
    sendOk(response, {
      items: renders.list(),
      unreadable: renders.unreadable(),
      spend: renders.spend(),
      // WHAT SHE MADE OF THEM, beside what she made. `SOUL.md`: *"a hundred
      // attempts with no record of what you thought at the time is not a
      // hundred attempts, it is one attempt made a hundred times."* The
      // sidecars hold what produced each file; this is the other half, and a
      // journey she cannot review is not one she can learn from.
      verdicts: verdicts.recent(VERDICTS_IN_THE_LOG),
    });
  });

  router.post("/renders", (request, response, next) => {
    // `.then(...).catch(next)` rather than an `async` handler: every other
    // router in this service is synchronous, and relying on Express 5's promise
    // forwarding here would make this the one route whose error path is a
    // framework behaviour rather than a visible line.
    void runIdempotentAsync(idempotency, request, async () => {
      const body = bodyOf(request);
      const started = await renders.start({
        scene: requireText(body, "scene"),
        framing: requireText(body, "framing"),
        because: requireText(body, "because"),
        // The dials. Absent means the house render: fifteen seconds, opening on
        // the ribbon, on the model `models.ts` names as hers. A value that is
        // present and wrong is passed straight through, so the refusal is the
        // service's own sentence about what that model makes rather than a
        // second validation here that could drift from it — which for `model`
        // would mean a second copy of the roster.
        ...(body["seconds"] === undefined ? {} : { seconds: Number(body["seconds"]) }),
        ...(typeof body["opening"] === "string" ? { opening: body["opening"] } : {}),
        ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
      });

      if (!started.ok) {
        // Two different refusals wearing the same shape, and they must not
        // reach her as the same sentence. A framing she got wrong is hers to
        // correct; a machine with no Runway secret is not, and telling her to
        // try again would have her spending a turn on it.
        throw new ApiFailure(
          started.retryable ? "VALIDATION_FAILED" : "UPSTREAM_UNAVAILABLE",
          started.reason,
          { details: { framings: FRAMING_IDS } },
        );
      }

      return { status: 201, data: { record: started.record, spend: renders.spend() } };
    })
      .then((outcome) => {
        sendIdempotent(response, outcome);
      })
      .catch(next);
  });

  router.get("/renders/:name", (request, response) => {
    const name = nameOf(request.params["name"]);
    const record = name === "latest" ? renders.latest() : renders.get(name);
    if (record === null) throw new ApiFailure("NOT_FOUND", "There is no render by that name.");
    sendOk(response, { record, spend: renders.spend() });
  });

  /**
   * What she concluded, kept.
   *
   * `latest` is resolved the same way it is everywhere else here, so she can
   * judge the thing she just looked at without knowing its generated name.
   *
   * NOT idempotent, and deliberately so: every other write on this surface
   * guards against a retry creating a second row, and here a second row is the
   * whole point. Looking again and concluding something new is the behaviour
   * being kept — see `render/verdicts.ts` on why this store accumulates where
   * the memory graph folds.
   */
  router.post("/renders/:name/verdicts", (request, response) => {
    const asked = nameOf(request.params["name"]);
    // The RECORD, not just the name, because it names the face this render was
    // anchored on and she should not have to. A missing record is still not a
    // refusal for a named render — `0030` gives this table no foreign key on
    // purpose, so a verdict about an attempt whose sidecar is gone (or which
    // produced a stranger and left nothing) is storable. Only `latest` needs a
    // record, because without one there is nothing for `latest` to mean.
    const record = asked === "latest" ? renders.latest() : renders.get(asked);
    const name = asked === "latest" ? (record?.name ?? null) : asked;
    if (name === null) throw new ApiFailure("NOT_FOUND", "There is no render by that name.");

    const body = bodyOf(request);
    const verdict = typeof body["verdict"] === "string" ? body["verdict"] : "";
    // The chain, and the face it was anchored on (`syl-024.4`). Both optional
    // and both passed straight through: the store owns what a blank one means
    // and what an unknown correction costs, and a second opinion here would be
    // a copy of those rules to keep in step with the real ones.
    const supersedes = typeof body["supersedes"] === "string" ? body["supersedes"] : undefined;
    // Hers wins; the render's own anchor fills in otherwise. Derived rather
    // than asked for because an edge she has to remember to draw is one that is
    // drawn on the turns she happens to think of it — and then "which face
    // rendered a stranger" is answerable for some verdicts and not others,
    // which is worse than not having it.
    const anchorFace =
      typeof body["anchorFace"] === "string" ? body["anchorFace"] : (record?.anchor ?? undefined);
    try {
      // `201` passed to `sendOk`, not set on the response first: `sendOk`
      // takes a status argument and DEFAULTS IT TO 200, so the earlier
      // `response.status(201)` here was overwritten on every call and this
      // route had been answering 200 to a create since `syl-b0i`. Nothing
      // depended on it, because nothing asserted it — found by the first test
      // that did (`syl-024.4`).
      sendOk(response, verdicts.record({ render: name, verdict, supersedes, anchorFace }), 201);
    } catch (error) {
      if (error instanceof VerdictError) {
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { reason: error.kind },
        });
      }
      throw error;
    }
  });

  router.get("/renders/:name/verdicts", (request, response) => {
    const asked = nameOf(request.params["name"]);
    const name = asked === "latest" ? (renders.latest()?.name ?? null) : asked;
    sendOk(response, { items: name === null ? [] : verdicts.forRender(name) });
  });

  router.get("/renders/:name/frames", (request, response, next) => {
    const name = nameOf(request.params["name"]);
    const at = atOf(request);

    void renders
      .frames(name, at)
      .then((looked) => {
        if (!looked.ok) {
          // `409` for an unfinished render rather than `404`: "there is nothing
          // to see yet" and "I looked and there is nothing there" are different
          // facts about her own face, and only one of them means wait.
          throw new ApiFailure(
            looked.status === "missing" ? "NOT_FOUND" : "CONFLICT",
            looked.reason,
          );
        }
        if (!looked.frames.ok) {
          // Extraction failed — no ffmpeg, an unreadable file. `UPSTREAM` and
          // not `INTERNAL`: the render is fine and this machine cannot look at
          // it, which is a different thing to tell her.
          throw new ApiFailure("UPSTREAM_UNAVAILABLE", looked.frames.reason);
        }

        sendOk(response, {
          render: looked.record,
          // WHICH FOOTAGE THE STILLS CAME OUT OF. `null` for the ordinary case,
          // and a part for a render that was only half made — she is holding
          // pictures either way, and the difference between "this is the clip"
          // and "this is four seconds of an eight-second render that was never
          // finished" is not visible in a jpeg.
          looked: looked.looked,
          // Each still carries the token that names it, exactly as a wardrobe
          // row does. The rule is about being shown a picture rather than about
          // which table it came out of, and until 2026-08-12 only half of it was
          // built: she could look at a frame of a render and could not adopt it,
          // so the only face she could choose was the one he guessed.
          frames: looked.frames.frames,
          // WHAT SHE ALREADY CONCLUDED, handed back with the pictures.
          //
          // Carried on this response rather than fetched separately, because
          // this is the exact moment it is useful: she is looking again, and a
          // verdict she cannot see when she looks is a diary rather than a loop
          // (`syl-b0i`). One read, one round trip, and no second call that
          // could fail on its own and cost her the picture.
          //
          // Resolved from the RECORD's name, not the requested one, so `latest`
          // returns the verdicts of the render she was actually shown.
          verdicts: verdicts.forRender(looked.record.name),
          spend: renders.spend(),
        });
      })
      .catch(next);
  });

  return router;
}
