import { systemClock, type Clock } from "../services/clock.js";
import { verifyAskCredential, type AskRejectionReason } from "./ask-credential.js";
import type { FaceSessionStore } from "./face-session-store.js";
import {
  RUNWAY_RPC_MAX_PARAMETERS,
  RUNWAY_RPC_MAX_TIMEOUT_SECONDS,
  type RunwayRpcToolDef,
} from "./runway-client.js";

/**
 * `ask_syl` — the one thing the avatar is allowed to ask the server, and the
 * only path by which her face gets any words at all.
 *
 * ## Where the call comes from, which is not where you would guess
 *
 * A Runway `backend_rpc` tool is **not a webhook.** Verified against
 * `@runwayml/avatars-node-rpc@0.1.0`: `createRpcHandler` calls
 * `POST /realtime_sessions/{id}/connect_backend`, opens a LiveKit `Room` with
 * the credentials that come back, and calls `localParticipant
 * .registerRpcMethod(name, handler)`. **Every byte of that is outbound.** The
 * avatar's model performs an RPC to a participant already inside the room; the
 * provider never dials us.
 *
 * So this ingress needs **no inbound network exposure, no public hostname and
 * no tunnel**. See the report on `syl-chzl.3` and `docs/RUNBOOK.md`: Tailscale
 * Funnel was scoped for this and is not required.
 *
 * The HTTP route in `routes/face.ts` exists anyway, guarded by the same
 * credential and the same code path, because a second transport that shares one
 * gate is worth having and a second transport with a *second* gate is not.
 *
 * ## The eight-second ceiling is the whole design
 *
 * Runway caps `timeoutSeconds` at {@link RUNWAY_RPC_MAX_TIMEOUT_SECONDS} — 8.
 * Measured (`28746b5`): her **warm** turn is ~1,635ms and a **cold** spawn is
 * ~7,450ms. A cold turn does not fit, and one that overruns leaves the avatar
 * standing there with nothing to say, which is the failure mode this whole
 * epic exists to avoid.
 *
 * Three rules follow, and they are the reason this file is not just a function
 * call:
 *
 * 1. **A cold lane is refused instantly.** Not attempted, not raced — refused,
 *    with something sayable, in under a millisecond. Gambling ~7.5s against an
 *    8s ceiling is choosing silence most of the time.
 * 2. **The wait is bounded strictly INSIDE the provider's ceiling** by
 *    {@link ASK_SYL_DEADLINE_MS}, so our answer is on the wire before Runway
 *    gives up. A handler that returns at 7.9s has done all the work and still
 *    produced silence.
 * 3. **Every path returns something she can say.** There is no branch here that
 *    resolves to nothing and none that rejects. A tool call that throws is a
 *    face that freezes.
 */

/** The tool's name, as the model knows it. */
export const ASK_SYL_TOOL_NAME = "ask_syl";

/**
 * What we declare to Runway. The provider's maximum, deliberately: there is no
 * benefit in asking it to give up sooner than it is willing to.
 */
export const ASK_SYL_TIMEOUT_SECONDS = RUNWAY_RPC_MAX_TIMEOUT_SECONDS;

/**
 * Our own deadline, **strictly inside** the declared one.
 *
 * 6.5s against a declared 8s leaves 1.5s of headroom for the RPC round trip and
 * for whatever the provider does with the answer. A handler that finishes at
 * 7.9s has done every bit of the work and produced silence anyway, which is the
 * most expensive way to fail available to this file.
 */
export const ASK_SYL_DEADLINE_MS = 6_500;

/** The tool declaration handed to Runway at session-create. */
export const ASK_SYL_TOOL: RunwayRpcToolDef = {
  type: "backend_rpc",
  name: ASK_SYL_TOOL_NAME,
  // WHEN TO CALL THIS IS THE WHOLE PERFORMANCE BUDGET, and the first version of
  // this string said "call this for EVERY question". It was written before she
  // had a knowledge base, when forwarding everything was the only way she could
  // be right. With her documents attached it became the reason every single
  // remark — including "hello" — raced an 8-second ceiling against a turn that
  // measures 3-7 seconds warm, so the Commander heard the timeout line
  // regardless of what he asked.
  //
  // A tool description is not documentation. It is the instruction the model
  // actually obeys, and it outranked her personality because it is nearer the
  // decision.
  description:
    "Ask Syl's own mind, for anything LIVE. Call this ONLY when the answer depends on something " +
    "that changes: his to-dos, reminders, goals, calendar, health, what happened today, what he " +
    "said earlier, or anything you would otherwise be guessing at. " +
    "DO NOT call it for things your own documents already answer — who you are, who he is, his " +
    "people, his work, what he is trying to do, how you speak. Answer those yourself, at once. " +
    "DO NOT call it for greetings, acknowledgements, chat, or anything conversational. " +
    "When you do call it, say you are checking before you call, so he knows which of you he is " +
    "talking to. Speak the answer you get back. If it says something went wrong, say that rather " +
    "than guessing — and never invent anything about him, his data or his day.",
  parameters: [
    {
      name: "question",
      type: "string",
      description:
        "Exactly what the Commander just said, transcribed. Do not summarise it, do not " +
        "rephrase it and do not add context of your own.",
    },
  ],
  timeoutSeconds: ASK_SYL_TIMEOUT_SECONDS,
};

/* ------------------------------------------------------------------ *
 * What she says when the answer did not arrive.
 * ------------------------------------------------------------------ */

/**
 * The lane is cold, so there is no chance of answering inside the ceiling.
 *
 * Honest about the shape of the problem without being a status page. The point
 * is that he hears *a person saying something* rather than watching a face
 * stare at him.
 */
export const COLD_LANE_LINE =
  "Give me a second — I am not properly awake yet. Ask me again in a moment.";

/** The turn is still running and the provider will not wait any longer. */
export const TOO_SLOW_LINE =
  "That one is taking me longer than I can stand here for. Ask me again and I will have it.";

/** The turn failed outright. */
export const TURN_FAILED_LINE = "Something went wrong on my end. Say that again?";

/** Nothing to answer. */
export const NOTHING_ASKED_LINE = "I did not catch that. Say it again?";

/* ------------------------------------------------------------------ *
 * The seam.
 * ------------------------------------------------------------------ */

/**
 * How a question becomes an answer.
 *
 * Injected, and deliberately the *only* source of speech on the success path.
 * `face-conversation.ts` supplies the real one, routed through
 * `services/conversation-service.ts` so `SOUL.md`, her memory and the reader
 * fence hold. Nothing in this file may author an answer — the four lines above
 * are all failures, and every one of them says so.
 */
export type FaceAnswerer = (input: {
  readonly sessionId: string;
  readonly question: string;
}) => Promise<string>;

/** Why an `ask_syl` call did not produce her words. */
export type AskSylFailure = "unauthorised" | "empty" | "cold" | "slow" | "failed";

/** What a tool call resolves to. Never a rejection; see the header. */
export type AskSylOutcome =
  | { readonly ok: true; readonly say: string }
  | {
      readonly ok: false;
      readonly failure: AskSylFailure;
      /**
       * What she should say instead. **Absent when the caller was not
       * authenticated** — someone who has not proved they hold this session's
       * credential is given nothing at all, not even a sentence.
       */
      readonly say?: string;
      /** The one indistinguishable message, on an unauthorised call. */
      readonly message?: string;
    };

export interface AskSylIngressOptions {
  readonly sessions: FaceSessionStore;
  /** How a question becomes an answer. See {@link FaceAnswerer}. */
  readonly answer: FaceAnswerer;
  /**
   * Whether her lane is warm enough to answer inside the ceiling.
   *
   * `syl-chzl.2.2`'s predicate. Omitted means "assume warm", which is what a
   * deployment without the persistent lane gets — it will then hit the deadline
   * and say so, which is the loud failure rather than the silent one.
   */
  readonly isLaneWarm?: () => boolean;
  /** Defaults to {@link ASK_SYL_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  readonly now?: Clock;
  /** Where every call goes. A tool call nobody can see is a tool call nobody can debug. */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/** One `ask_syl` call, as it arrives from either transport. */
export interface AskSylRequest {
  readonly sessionId: string;
  /** The per-session credential. See `ask-credential.ts`. */
  readonly secret: string;
  readonly question: string;
}

/**
 * The ingress.
 *
 * Transport-agnostic on purpose: `routes/face.ts` calls {@link ask} with a
 * bearer token off an HTTP request, and the LiveKit RPC handler calls it with
 * the secret it was attached with. **One gate, two doors** — a second
 * verification path is how the two drift apart and one of them ends up weaker.
 */
export class AskSylIngress {
  readonly #sessions: FaceSessionStore;
  readonly #answer: FaceAnswerer;
  readonly #isLaneWarm: (() => boolean) | null;
  readonly #deadlineMs: number;
  readonly #now: Clock;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(options: AskSylIngressOptions) {
    this.#sessions = options.sessions;
    this.#answer = options.answer;
    this.#isLaneWarm = options.isLaneWarm ?? null;
    this.#deadlineMs = options.deadlineMs ?? ASK_SYL_DEADLINE_MS;
    this.#now = options.now ?? systemClock;
    this.#log =
      options.log ??
      ((event, fields) => {
        console.info(`[syl] ${event}`, fields);
      });
  }

  /** The declaration to hand Runway. Checked against the provider's limits. */
  static toolDefinition(): RunwayRpcToolDef {
    if (ASK_SYL_TOOL.timeoutSeconds > RUNWAY_RPC_MAX_TIMEOUT_SECONDS) {
      throw new Error(
        `ask_syl declares ${String(ASK_SYL_TOOL.timeoutSeconds)}s, above the provider's ` +
          `${String(RUNWAY_RPC_MAX_TIMEOUT_SECONDS)}s maximum. Runway rejects the session create.`,
      );
    }
    if (ASK_SYL_TOOL.parameters.length > RUNWAY_RPC_MAX_PARAMETERS) {
      throw new Error(`ask_syl declares more than ${String(RUNWAY_RPC_MAX_PARAMETERS)} parameters.`);
    }
    return ASK_SYL_TOOL;
  }

  /**
   * Answer one question, or produce something she can say instead.
   *
   * Never rejects and never resolves to nothing.
   */
  async ask(request: AskSylRequest): Promise<AskSylOutcome> {
    const verification = verifyAskCredential({
      sessions: this.#sessions,
      sessionId: request.sessionId,
      secret: request.secret,
      now: this.#now(),
    });

    if (!verification.ok) {
      // The reason goes to the log, where it answers "why did her face stop
      // answering". It does not go to the caller. See `ask-credential.ts`.
      this.#log("face.ask.refused", {
        sessionId: request.sessionId,
        reason: verification.reason satisfies AskRejectionReason,
      });
      return { ok: false, failure: "unauthorised", message: verification.message };
    }

    const question = request.question.trim();
    if (question === "") {
      return { ok: false, failure: "empty", say: NOTHING_ASKED_LINE };
    }

    // The session is alive and somebody is talking to it. Recorded before the
    // turn, not after: a turn that takes six seconds must not look idle for
    // those six seconds, or the reaper cuts her off mid-answer.
    this.#sessions.touch(request.sessionId, this.#now());

    // FAIL FAST rather than gamble. A cold spawn is ~7,450ms against an 8s
    // ceiling, so attempting one buys a coin flip on silence.
    if (this.#isLaneWarm !== null && !this.#isLaneWarm()) {
      this.#log("face.ask.cold", { sessionId: request.sessionId });
      return { ok: false, failure: "cold", say: COLD_LANE_LINE };
    }

    const startedAt = this.#now();
    try {
      const say = await this.#bounded(
        this.#answer({ sessionId: request.sessionId, question }),
      );
      this.#log("face.ask.answered", {
        sessionId: request.sessionId,
        ms: this.#now() - startedAt,
        characters: say.length,
      });
      // A turn that succeeded with nothing to say is still a turn the face has
      // to close. Silence here would be the avatar freezing on a success.
      return say.trim() === ""
        ? { ok: false, failure: "failed", say: TURN_FAILED_LINE }
        : { ok: true, say };
    } catch (error) {
      const slow = error instanceof AskSylDeadlineError;
      this.#log(slow ? "face.ask.slow" : "face.ask.failed", {
        sessionId: request.sessionId,
        ms: this.#now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return slow
        ? { ok: false, failure: "slow", say: TOO_SLOW_LINE }
        : { ok: false, failure: "failed", say: TURN_FAILED_LINE };
    }
  }

  /**
   * The handler map for `@runwayml/avatars-node-rpc`'s `createRpcHandler`.
   *
   * The credential is bound here, at attach time, because the handler is
   * created per session by us. That means the LiveKit path presents a real
   * credential to a real verifier rather than being trusted for arriving on a
   * socket — the same gate the HTTP door uses, so the two cannot drift.
   */
  handlerFor(
    sessionId: string,
    secret: string,
  ): Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> {
    return {
      [ASK_SYL_TOOL_NAME]: async (args: Record<string, unknown>) => {
        const raw = args["question"];
        const outcome = await this.ask({
          sessionId,
          secret,
          question: typeof raw === "string" ? raw : "",
        });
        // The model reads this and speaks `say`. `ok` is there so the persona
        // can tell an answer from an apology; there is no path that returns
        // neither.
        return outcome.ok
          ? { ok: true, say: outcome.say }
          : { ok: false, say: outcome.say ?? "", failure: outcome.failure };
      },
    };
  }

  /**
   * Bound the WAIT, not the work.
   *
   * The turn is not ours to kill — `ConversationService` owns it and has its own,
   * far longer timeout — so a slow turn keeps running and lands in his
   * transcript. What this stops is the avatar standing silent while it does.
   */
  async #bounded(turn: Promise<string>): Promise<string> {
    if (this.#deadlineMs <= 0) return turn;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        turn,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new AskSylDeadlineError(this.#deadlineMs));
          }, this.#deadlineMs);
          // Unreffed so a lost race cannot hold the process open.
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The turn did not finish inside the window the provider will wait. */
export class AskSylDeadlineError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(
      `Her turn did not answer within ${String(deadlineMs)}ms, and the avatar's tool call cannot ` +
        `wait past ${String(ASK_SYL_TIMEOUT_SECONDS)}s.`,
    );
    this.name = "AskSylDeadlineError";
    this.deadlineMs = deadlineMs;
  }
}
