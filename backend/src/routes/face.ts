import { Router, type Request, type RequestHandler } from "express";

import { AskSylIngress } from "../face/ask-syl.js";
import { CLIENT_STATES, type ClientReportIngress } from "../face/client-report.js";
import type { FaceCostGuard } from "../face/face-cost-guard.js";
import {
  FaceColdLaneError,
  FaceCostCeilingError,
  FaceSessionFailedError,
  type FaceSessionBroker,
} from "../face/face-session-broker.js";
import type { FaceSession, FaceSessionStore } from "../face/face-session-store.js";
import { RunwayApiError } from "../face/runway-client.js";
import { bearerToken, unauthorized } from "../middleware/auth.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, runIdempotentAsync, sendIdempotent } from "./idempotency.js";

/**
 * Her live face, over HTTP — `syl-chzl.3.5`.
 *
 * Three routes for a client, and one for the avatar. They are authenticated by
 * **two different systems**, and the split is the security argument rather than
 * a convenience:
 *
 * ```
 * POST   /face/sessions              bearer  open a face
 * GET    /face/sessions/{id}         bearer  its state, its meter, the day's spend
 * DELETE /face/sessions/{id}         bearer  close it and settle the accounting
 * POST   /face/sessions/{id}/ask     PER-SESSION CREDENTIAL — the ask_syl ingress
 * POST   /face/sessions/{id}/report  THE PAGE'S OWN KEY — what became of it
 * ```
 *
 * ## The three client routes
 *
 * An ordinary paired device. Opening a face is the Commander talking to Syl in
 * his own conversation, and the meter and the day's spend are **his money and
 * his data** — a phone gets both. So there is no scope gate here; the ordinary
 * bearer check is the whole of it, and an anonymous caller gets the same
 * indistinguishable 401 every other route gives.
 *
 * **Syl's own credential is refused, and by doing nothing.** `/face` is not in
 * `AGENT_SURFACES`, so `confineAgent` — which runs inside `requireBearerToken`
 * — turns her key away with `beyondAgentReach`. That is deliberate: a face
 * costs about $0.20 a minute, and an assistant that can open one can spend his
 * money unprompted. The default is no, and it holds because nobody added an
 * entry.
 *
 * ## The fourth route, and why it is authenticated differently
 *
 * `POST /face/sessions/{id}/ask` is the avatar asking her a question. Its
 * caller is a machine, for the minutes one session lasts, and it must not hold
 * anything that reaches the rest of the API. So it does **not** go through
 * `requireBearerToken` at all: it presents the per-session credential from
 * `face/ask-credential.ts`, which lives on the session row, expires with the
 * session, and is minted only by paying for one.
 *
 * That is why the handler is registered **before** the `router.use("/face",
 * authenticate)` line below. Order is the mechanism, so it is stated here as
 * well as commented there: register it after, and the avatar would need a
 * device token — which is to say, the credential on his phone.
 *
 * A device token gets **401** here, not 403. That is the opposite of the
 * `/logs` precedent and the reason is that this is the opposite situation: a
 * caller holding a device key is not "authenticated but under-scoped" on this
 * route, they are simply not the party this route is for, and there is no scope
 * that would ever grant it. Every rejection is the same message.
 *
 * ## What this route does NOT do
 *
 * It is not the transport. A Runway `backend_rpc` call arrives over LiveKit on
 * a socket **we dialled out on** — see the header of `face/ask-syl.ts`. This
 * door exists as a second transport sharing one gate, and it needs no inbound
 * exposure of its own: it lives on the tailnet like everything else, and no
 * Tailscale Funnel has been opened for it.
 *
 * ## The fifth route, and why it had to exist
 *
 * `POST /face/sessions/{id}/report` is the PAGE saying what became of it, and
 * it is the answer to ninety cents nobody could account for — see
 * `face/client-report.ts` for the failure and `0037` for the columns. It is
 * registered beside `/ask` and in front of the bearer middleware for the same
 * reason: its caller is a `WKWebView` that must never hold a device token.
 *
 * Its credential is **not** the ask credential. It is the short-lived session
 * key the page was already given to draw her with, so whoever can draw her face
 * may say what happened to it, and a page that somehow leaked it has leaked the
 * ability to write one word from a closed list onto a row it is already
 * paying for.
 *
 * It is deliberately not a telemetry surface: one route, one session, a closed
 * vocabulary, a bounded detail string, and no way to move a meter. It closes
 * when the session settles, structurally, because the credential is a column of
 * the session.
 */

/** Longest question the ingress will accept, in characters. */
const MAX_QUESTION = 4_000;

/** What a client is told about the day's budget. */
export interface FaceBudgetView {
  readonly creditsSpentToday: number;
  readonly creditCeiling: number;
  readonly creditsRemaining: number;
  readonly dollarsSpentToday: number;
}

export interface FaceRouterOptions {
  readonly broker: FaceSessionBroker;
  readonly sessions: FaceSessionStore;
  readonly guard: FaceCostGuard;
  readonly ingress: AskSylIngress;
  /**
   * What the page drawing her says became of it. Optional, because every
   * caller that predates `0037` built this router without one — and its
   * absence is a 404 on the report route rather than a silent accept.
   */
  readonly reports?: ClientReportIngress;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
  /**
   * Attach the server-side RPC loop once a session is open, so the avatar can
   * actually call `ask_syl`. Optional: without it the face opens and simply
   * cannot be asked anything, which is the state before the LiveKit worker is
   * wired. Never allowed to fail a session — see the call site.
   */
  readonly attachRpc?: (input: {
    readonly sessionId: string;
    readonly askSecret: string;
  }) => Promise<void>;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/** The public shape of a session row. Never the credential material. */
function sessionView(session: FaceSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    avatarId: session.avatarId,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    ended: session.ended,
    credits: session.credits,
    dollars: session.dollars,
    lastActivityAt: session.lastActivityAt,
  };
}

export function createFaceRouter(options: FaceRouterOptions): Router {
  const { broker, sessions, guard, ingress, idempotency, authenticate } = options;
  const log =
    options.log ??
    ((event: string, fields: Record<string, unknown>): void => {
      console.info(`[syl] ${event}`, fields);
    });
  const router = Router();

  const budget = (): FaceBudgetView => ({
    creditsSpentToday: guard.spentToday(),
    creditCeiling: guard.dailyCreditCeiling,
    creditsRemaining: guard.remainingCreditsToday(),
    dollarsSpentToday: Number(
      (guard.spentToday() * guard.costModel.dollarsPerCredit).toFixed(4),
    ),
  });

  // ---------------------------------------------------------------------
  // THE AVATAR'S DOOR. Registered FIRST, deliberately, so that it sits in
  // front of the bearer middleware below rather than behind it. See the
  // header: this caller is a machine holding a per-session credential, and
  // requiring a device token here would mean handing the provider the key to
  // the Commander's phone.
  // ---------------------------------------------------------------------
  router.post("/face/sessions/:faceSessionId/ask", (request, response, next) => {
    const rawId = request.params["faceSessionId"];
    const sessionId = typeof rawId === "string" ? rawId : "";
    const secret = bearerToken(request.headers.authorization);
    if (secret === null) {
      // The same indistinguishable rejection every other route gives. It says
      // nothing about whether this session exists.
      next(unauthorized());
      return;
    }

    const body: unknown = request.body;
    const raw =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)["question"]
        : undefined;
    if (typeof raw !== "string" || raw.length > MAX_QUESTION) {
      throw new ApiFailure("VALIDATION_FAILED", "question is required.", {
        details: { field: "question", reason: `a string of at most ${String(MAX_QUESTION)} characters` },
      });
    }

    void ingress
      .ask({ sessionId, secret, question: raw })
      .then((outcome) => {
        if (!outcome.ok && outcome.failure === "unauthorised") {
          next(unauthorized());
          return;
        }
        // Everything else is a 200 with something she can say. A tool call that
        // gets an HTTP error has nothing to speak, and a face with nothing to
        // speak is a face that freezes — which is the failure this whole
        // ingress is shaped to avoid.
        sendOk(response, {
          ok: outcome.ok,
          say: outcome.ok ? outcome.say : (outcome.say ?? ""),
          ...(outcome.ok ? {} : { failure: outcome.failure }),
        });
      })
      .catch(next);
  });

  // ---------------------------------------------------------------------
  // THE PAGE'S DOOR. Registered here for exactly the reason the one above is:
  // its caller is the `WKWebView` drawing her, which holds the session key and
  // must never hold a device token. See the header, and `client-report.ts`.
  // ---------------------------------------------------------------------
  if (options.reports !== undefined) {
    const reports = options.reports;
    router.post("/face/sessions/:faceSessionId/report", (request, response, next) => {
      const rawId = request.params["faceSessionId"];
      const sessionId = typeof rawId === "string" ? rawId : "";
      const secret = bearerToken(request.headers.authorization);
      if (secret === null) {
        next(unauthorized());
        return;
      }

      const body: unknown = request.body;
      const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

      const outcome = reports.report({
        sessionId,
        secret,
        state: fields["state"],
        detail: fields["detail"],
      });

      if (!outcome.ok && outcome.reason === "unknown_state") {
        throw new ApiFailure("VALIDATION_FAILED", outcome.message, {
          details: { field: "state", reason: `one of: ${CLIENT_STATES.join(", ")}` },
        });
      }
      if (!outcome.ok) {
        // The same indistinguishable 401 as everywhere else. A page that has
        // lost its credential learns nothing about why.
        next(unauthorized());
        return;
      }

      // 202, not 200: this is a note taken about a session, not a change to
      // one. Nothing the caller can read back and nothing it should retry.
      sendOk(response, { recorded: outcome.state }, 202);
    });
  }

  // Order is the security property, exactly as in `routes/logs.ts`: everything
  // registered BELOW this line requires a token, and the two routes above it
  // are the documented exceptions.
  router.use("/face", authenticate);

  // ---------------------------------------------------------------------
  // POST /face/sessions — open a face.
  // ---------------------------------------------------------------------
  router.post("/face/sessions", (request, response, next) => {
    void runIdempotentAsync(idempotency, request, async () => {
      const opened = await broker.startSession();

      // Attach the tool loop so she can actually be asked something. It must
      // never tear down a live, billable session, so a failure here is logged
      // and the session is still handed over — a face that cannot answer is
      // better than a face that was paid for and thrown away.
      if (options.attachRpc) {
        // **LOGGED ON SUCCESS TOO, and that is the point of this block.** It
        // used to log only the failure, which made a healthy attach and an
        // attach that never ran indistinguishable in the record — and on
        // 2026-08-23 that ambiguity was the reason nobody could say whether
        // the avatar had ever had a tool to call. An absence that means "fine"
        // must not look like an absence that means "never happened".
        const startedAt = Date.now();
        try {
          await options.attachRpc({
            sessionId: opened.credentials.sessionId,
            askSecret: opened.askSecret,
          });
          log("face.rpc.attached", {
            sessionId: opened.credentials.sessionId,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          log("face.rpc.attach_failed", {
            sessionId: opened.credentials.sessionId,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // No transport at all. The face will open and be mute, and a line
        // saying so is worth more than the silence that used to stand for it.
        log("face.rpc.not_attached", {
          sessionId: opened.credentials.sessionId,
          note: "no transport is wired, so the avatar has no ask_syl to call",
        });
      }

      // `credentials` and nothing else. The per-session credential is for the
      // avatar's handler; a client that held it could speak as the avatar.
      return { status: 201, data: opened.credentials };
    })
      .then((outcome) => {
        sendIdempotent(response, outcome);
      })
      .catch((error: unknown) => {
        next(asFaceFailure(error));
      });
  });

  // ---------------------------------------------------------------------
  // GET /face/sessions/{id} — state, live meter, and the day's spend.
  // ---------------------------------------------------------------------
  router.get("/face/sessions/:faceSessionId", (request, response) => {
    const session = mustFind(sessions, request);
    sendOk(response, {
      session: sessionView(session),
      meter: broker.meterSession(session),
      budget: budget(),
    });
  });

  // ---------------------------------------------------------------------
  // DELETE /face/sessions/{id} — close it and settle the accounting.
  // ---------------------------------------------------------------------
  router.delete("/face/sessions/:faceSessionId", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const session = mustFind(sessions, request);
        // Idempotent in the store, so a second DELETE returns the settled row
        // rather than charging again or refusing. Two closes of one face is a
        // client retrying, not an error.
        const outcome = broker.recordSessionEnd(session.id, "closed");
        return { status: 200, data: sessionView(outcome.session) };
      }),
    );
  });

  return router;
}

/** The session named in the path, or a 404. */
function mustFind(sessions: FaceSessionStore, request: Request): FaceSession {
  const raw = request.params["faceSessionId"];
  const id = typeof raw === "string" ? raw : "";
  const session = sessions.get(id);
  if (session === null) {
    throw new ApiFailure("NOT_FOUND", "There is no face session by that id.");
  }
  return session;
}

/**
 * Turn a broker failure into the refusal a client can act on.
 *
 * The ceiling in particular must be a **structured refusal naming the number**,
 * not a 500. A phone that gets a 500 shows a spinner and a shrug; one that gets
 * this shows her saying the budget is spent and when it resets.
 */
export function asFaceFailure(error: unknown): unknown {
  if (error instanceof FaceCostCeilingError) {
    return new ApiFailure("RATE_LIMITED", error.message, {
      details: {
        code: error.code,
        creditCeiling: error.ceiling,
        creditsSpentToday: error.spentToday,
      },
    });
  }
  if (error instanceof FaceColdLaneError) {
    return new ApiFailure("CONFLICT", error.message, { details: { code: error.code } });
  }
  if (error instanceof FaceSessionFailedError || error instanceof RunwayApiError) {
    return new ApiFailure("UPSTREAM_UNAVAILABLE", error.message);
  }
  return error;
}
