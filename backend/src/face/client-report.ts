import { createHash, timingSafeEqual } from "node:crypto";

import { systemClock, type Clock } from "../services/clock.js";
import type { FaceSessionStore } from "./face-session-store.js";

/**
 * What happened to her face on the CLIENT — `syl-chzl.7.6`.
 *
 * ## Why this route exists at all
 *
 * On 2026-08-23 two sessions opened on the Commander's phone, ninety cents,
 * both reaped, `last_activity_at` equal to `opened_at` to the millisecond on
 * both rows. She was never asked anything. Everything the server could see was
 * healthy — the sessions were created against her real avatar, the credential
 * was minted, the provider cap was set, `GET /face/live` answered 200 on the
 * tailnet — and the failure was somewhere between the `WKWebView` and the
 * provider, where the server has no eyes at all.
 *
 * A blank server-side record is compatible with "it worked" and with "the
 * document never ran", and those two being indistinguishable is what made the
 * cause unnameable. **An absence that means "fine" and an absence that means
 * "never happened" must not look the same.** This is the smallest thing that
 * separates them: the page says what became of it, in one word from a closed
 * list, and the word lands on the session row and in the log.
 *
 * ## Deliberately not a telemetry surface
 *
 * One route, one purpose, one session, and it dies with the session.
 *
 * - **The vocabulary is closed.** {@link CLIENT_STATES} and nothing else; an
 *   unrecognised word is refused rather than stored, so this cannot quietly
 *   become a free-text pipe from a web view into the Commander's database.
 * - **The detail is bounded** at {@link MAX_DETAIL} characters and is never
 *   interpreted — it is an error message from a page, which is to say a string
 *   an attacker-influenced import graph may have chosen.
 * - **It expires with the session**, structurally, because the credential it
 *   checks is a column of the session row. Settling the session closes the
 *   route for that session with no sweeper to run.
 * - **It moves no meter and no money.** Reporting is not activity — see
 *   {@link FaceSessionStore.recordClientState} for why that separation is
 *   load-bearing rather than tidy.
 *
 * ## The credential, and why there is no new one
 *
 * The page already holds the short-lived `stk_…` session key: it is what it
 * draws her with. So **whoever can draw her face may say what happened to it**,
 * and nobody else can. Minting a third per-session secret would have meant one
 * more field going outward, one more thing to leak, and one more expiry to get
 * right — for a caller that is already authenticated by construction.
 *
 * It is emphatically **not** the `ask_syl` credential. A browser holding that
 * could speak as the avatar and drive her turns; a browser holding this can
 * write one word from a closed list onto the row it is already paying for.
 *
 * ## What a rejected caller learns
 *
 * Nothing, by exactly the argument in `ask-credential.ts`: one message for
 * every failure, a constant-time comparison, and an unknown session compared
 * against a decoy rather than returning early — so the timing does not answer
 * the question the message refuses to.
 */

/**
 * Every word the page may say about itself, and the order is the lifecycle.
 *
 * Closed on purpose. The set is small enough to read in one go, which is the
 * property that makes a log query over it worth writing, and each entry names
 * a *distinct* failure someone can act on rather than a severity.
 */
export const CLIENT_STATES = [
  /** The document parsed and its module script began. Proves the page ran. */
  "booting",
  /** The page was opened with no session in it. Should be unreachable. */
  "no_session",
  /** react, react-dom and the avatar SDK all imported. */
  "sdk_loaded",
  /** The SDK's import graph failed — the likeliest failure on a phone. */
  "sdk_failed",
  /**
   * About to call `getUserMedia`. **Reported BEFORE the call, deliberately.**
   *
   * This is the state that would have named the 2026-08-23 crash in one
   * session instead of two. iOS does not refuse a capture the app has not
   * declared a usage description for — it **terminates the process** (TCC
   * SIGABRT), so the last word the server ever hears is whatever was sent
   * before the request. A state reported after the call can never describe the
   * failure that kills the caller.
   */
  "mic_requested",
  /** `getUserMedia` was refused. **A conversation with no microphone is mute.** */
  "mic_denied",
  /**
   * The page's fence stripped a `video` constraint from a media request.
   *
   * Measurement, not an error: it is how we know the SDK asks for the camera
   * even when told `video: false`. See the fence in `routes/face-page.ts`.
   */
  "camera_blocked",
  /** The microphone was granted, so his half of the call can exist. */
  "mic_granted",
  /** The avatar component is mounted and joining. */
  "connecting",
  /** The SDK reported a live connection. */
  "connected",
  /**
   * **She can be HEARD.** A media element carrying sound is actually moving.
   *
   * The state that closes the worst window this surface has had. Her voice
   * comes out of `RoomAudioRenderer`, a sibling of the avatar's video inside
   * `AvatarSession`, and it plays a remote audio track the instant it
   * subscribes — with no dependence at all on the video track that `playing`
   * waits for. On 2026-08-23 the Commander heard her about twenty-five seconds
   * before the layer holding her rose, which is being billed to talk to a
   * black screen.
   *
   * So this is reported separately and the phone presents her on it with no
   * grace: a face he can hear must be a face he can see.
   */
  "audible",
  /** Connected, and a media element is actually playing frames. */
  "playing",
  /**
   * **Her picture changed size after the first frame.** The one repeatable word.
   *
   * `playing` reports the FIRST frame, and a first frame is the worst frame a
   * WebRTC stream ever sends — the encoder starts at a low rung and scales up
   * over the following seconds. The Commander's 2026-08-23 session reported
   * `278x180` at 8675ms, and it is genuinely unknown whether that is the stream
   * or the ramp. `syl-chzl.11` turns on the answer: 278px stretched across a
   * phone is a softness defect quite separate from the crop, and 1.544 is
   * neither 16:9 nor 4:3, so even the aspect may still move.
   *
   * One sample cannot tell those apart. This is the second, and the third — the
   * page speaks only when the size actually CHANGES, so **a steady stream says
   * nothing, and the silence is the finding.** Each detail carries the first
   * size beside the current one, because the session row keeps only the last
   * state and the row should still tell the whole curve.
   *
   * **The exception to one-report-per-state, and it is capped.** The page spends
   * a budget of four rather than checking a flag; see `tellResized` in
   * `routes/face-page.ts` for why the allowance is a function nobody else can
   * borrow rather than an argument every caller could pass.
   *
   * Telemetry, not lifecycle: it arrives long after she is on screen, it is not
   * on the phone's ladder, and `LiveFaceModel` ignores it by the same route it
   * ignores any word it does not know.
   */
  "resized",
  /**
   * A media element exists, has data, and is paused — the WKWebView autoplay
   * signature. Everything else looks perfect and nothing ever moves.
   */
  "autoplay_blocked",
  /** Connected, and no media element ever appeared to play. */
  "no_media",
  /** The SDK reported an error. */
  "failed",
  /** The room dropped, or she finished. */
  "ended",
  /** The host tore the page down. The ordinary end. */
  "left",
] as const;

export type ClientState = (typeof CLIENT_STATES)[number];

const CLIENT_STATE_SET: ReadonlySet<string> = new Set<string>(CLIENT_STATES);

/** Is this one of the words the page is allowed to say? */
export function isClientState(value: unknown): value is ClientState {
  return typeof value === "string" && CLIENT_STATE_SET.has(value);
}

/** Longest detail string kept. Anything past this is cut, never refused. */
export const MAX_DETAIL = 500;

/**
 * Longest credential accepted before it is dismissed as malformed.
 *
 * A bound rather than a shape check. The provider owns the format of its own
 * key and `stk_` is an observation, not a promise — pinning it here would make
 * a provider rename look like an authentication failure. Length is the only
 * property we are entitled to assume.
 */
const MAX_SECRET = 512;

/** The one message every rejection produces. */
export const REPORT_REJECTION_MESSAGE = "This face session did not accept that credential.";

/** Compared against when there is nothing real to compare against. */
const DECOY_HASH = createHash("sha256").update("syl:face:report:decoy", "utf8").digest("hex");

/** SHA-256, hex. The only form of the session key that touches disk. */
export function hashSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

/** Constant-time equality over two hex digests. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Why a report was refused. Internal — for the log, never for the caller. */
export type ReportRejectionReason =
  | "malformed"
  | "unknown_session"
  | "no_credential"
  | "settled"
  | "mismatch";

export type ReportOutcome =
  | { readonly ok: true; readonly state: ClientState }
  | {
      readonly ok: false;
      readonly reason: ReportRejectionReason | "unknown_state";
      /** {@link REPORT_REJECTION_MESSAGE}, except for a bad state. */
      readonly message: string;
    };

export interface ClientReportInput {
  readonly sessionId: string;
  readonly secret: string;
  readonly state: unknown;
  readonly detail?: unknown;
}

export interface ClientReportIngressOptions {
  readonly sessions: Pick<FaceSessionStore, "get" | "recordClientState">;
  readonly now?: Clock;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * The gate and the write, in one object, for the same reason `AskSylIngress`
 * is one: two doors onto one gate is fine, two gates is how they drift.
 */
export class ClientReportIngress {
  readonly #sessions: Pick<FaceSessionStore, "get" | "recordClientState">;
  readonly #now: Clock;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(options: ClientReportIngressOptions) {
    this.#sessions = options.sessions;
    this.#now = options.now ?? systemClock;
    this.#log =
      options.log ??
      ((event, fields) => {
        console.info(`[syl] ${event}`, fields);
      });
  }

  /**
   * Record one word about a live session.
   *
   * Never throws. The caller is a page that is already failing at something;
   * an exception here would replace one invisible failure with two.
   */
  report(input: ClientReportInput): ReportOutcome {
    // **AUTHENTICATE FIRST, VALIDATE SECOND**, which is the `/logs` ordering
    // one layer in and is not a style choice. A caller with no credential must
    // get the ordinary indistinguishable rejection and learn nothing — not even
    // that this route has a vocabulary. Reversed, an agent token or a stranger
    // could tell a route that exists from one that does not by the difference
    // between a 400 and a 401, which is exactly what the confinement sweep in
    // `agent-credential.test.ts` refuses to allow.
    const verified = this.#verify(input.sessionId, input.secret);
    if (verified !== null) {
      // Logged with the reason the caller is not told, because "why did her
      // face stop reporting" is a question the operator is owed.
      this.#log("face.client.report_refused", {
        sessionId: input.sessionId,
        reason: verified,
        state: typeof input.state === "string" ? input.state : null,
      });
      return { ok: false, reason: verified, message: REPORT_REJECTION_MESSAGE };
    }

    if (!isClientState(input.state)) {
      // Distinguishable, and only ever seen by a caller that has already proved
      // it holds this session's key. A closed vocabulary is what stops this
      // becoming a free-text pipe from a web view into his database.
      return {
        ok: false,
        reason: "unknown_state",
        message: `A face client reports one of: ${CLIENT_STATES.join(", ")}.`,
      };
    }

    const detail = typeof input.detail === "string" ? input.detail.slice(0, MAX_DETAIL) : null;
    this.#sessions.recordClientState(input.sessionId, input.state, detail, this.#now());

    // `warn` is not available here — one sink, one shape — so the level lives
    // in the event name. A stalled face is a `face.client.stalled` search.
    this.#log(STALLED.has(input.state) ? "face.client.stalled" : "face.client.state", {
      sessionId: input.sessionId,
      state: input.state,
      ...(detail === null || detail === "" ? {} : { detail }),
    });
    return { ok: true, state: input.state };
  }

  /** `null` when the credential is good, otherwise why it is not. */
  #verify(sessionId: string, secret: string): ReportRejectionReason | null {
    if (secret === "" || secret.length > MAX_SECRET) return "malformed";

    const presented = hashSessionKey(secret);
    const session = this.#sessions.get(sessionId);

    if (session === null) {
      // Compared anyway, so an unknown session costs what a known one costs.
      hashesMatch(presented, DECOY_HASH);
      return "unknown_session";
    }
    if (session.sessionKeyHash === null) {
      hashesMatch(presented, DECOY_HASH);
      return "no_credential";
    }
    if (!hashesMatch(presented, session.sessionKeyHash)) return "mismatch";
    // Last, and after the comparison, so a settled session is not an oracle for
    // which ids exist. `closedAt` is what closes this route with the session.
    if (session.closedAt !== null) return "settled";
    return null;
  }
}

/**
 * The states that mean *she is on his screen and nothing is happening*.
 *
 * They are logged under their own event name so the one query worth having —
 * "did a face stall, and why" — is a search for a word rather than a filter
 * over every state the page passes through on a healthy call.
 */
const STALLED: ReadonlySet<string> = new Set<string>([
  "sdk_failed",
  "mic_denied",
  "autoplay_blocked",
  "no_media",
  "failed",
  "no_session",
]);
