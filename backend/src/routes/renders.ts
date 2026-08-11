import { Router, type Request, type RequestHandler } from "express";

import { FRAMING_IDS } from "../render/framing.js";
import type { RenderService } from "../render/render-service.js";
import { isRenderName } from "../render/studio.js";
import { RenderVerdicts, VerdictError } from "../render/verdicts.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotentAsync, sendIdempotent } from "./idempotency.js";

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
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

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

export function createRenderRouter(options: RenderRouterOptions): Router {
  const { renders, idempotency, authenticate, verdicts } = options;
  const router = Router();

  router.use("/renders", authenticate);

  router.get("/renders", (_request, response) => {
    // `unreadable` rides along beside the records for the same reason `spend`
    // does: a list that silently omitted a file it could not parse would be a
    // ledger with a hole in it, and `SOUL.md` keeps every attempt. It is empty
    // on every ordinary machine, so it costs her nothing to carry.
    sendOk(response, {
      items: renders.list(),
      unreadable: renders.unreadable(),
      spend: renders.spend(),
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
    const name = asked === "latest" ? (renders.latest()?.name ?? null) : asked;
    if (name === null) throw new ApiFailure("NOT_FOUND", "There is no render by that name.");

    const body = bodyOf(request);
    const verdict = typeof body["verdict"] === "string" ? body["verdict"] : "";
    try {
      response.status(201);
      sendOk(response, verdicts.record({ render: name, verdict }));
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
