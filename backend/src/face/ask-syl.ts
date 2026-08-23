import { parseInstant, systemClock, type Clock } from "../services/clock.js";
import {
  ASK_REJECTION_MESSAGE,
  verifyAskCredential,
  type AskRejectionReason,
  type AskVerification,
} from "./ask-credential.js";
import {
  AnswerBank,
  isSameQuestion,
  spokenBankedAnswer,
  type BankedAnswer,
} from "./banked-answer.js";
import type { FaceSession, FaceSessionStore } from "./face-session-store.js";
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
 * Five rules follow, and they are the reason this file is not just a function
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
 *    face that freezes. That claim used to be true only of the code *inside*
 *    the try block — the credential check, the `touch`, the warm-lane predicate
 *    and the log sink all sat outside it, so a locked database was a rejected
 *    RPC. {@link AskSylIngress.ask} is now a net around the whole of it.
 * 4. **One turn per face at a time.** A second question arriving while a turn
 *    is still running is answered from here, at once. It is NOT queued behind
 *    the turn that is already too slow — `ConversationService` serialises per
 *    conversation, so queueing means waiting out the whole of a turn that has
 *    already missed the deadline and then running another, which cannot fit
 *    however fast the lane is. See `#single` for the measurement.
 * 5. **An overrun turn's answer is KEPT, and the next ask gets it.**
 *    {@link TOO_SLOW_LINE} promises "ask me again and I will have it", and
 *    until `syl-chzl.4.5` that was false every single time: the abandoned turn
 *    ran to completion, produced a good answer, and this file dropped it.
 *    Fourteen out of fourteen on 2026-08-23 — her face had never once answered
 *    a question. See `banked-answer.ts` for the bank, the ninety-second bound
 *    on it, and why she says what the answer is an answer to.
 *
 * **Rule 5 is a fallback and must never become a substitute.** A question he
 * asks is answered by running it, every time; the bank only ever fills in for
 * an apology. When `syl-chzl.4.4` makes the turn fit inside the ceiling this
 * whole mechanism stops firing on its own, because nothing overruns and so
 * nothing is ever banked. Anything that makes it serve a banked answer *in
 * preference to* a fresh one would leave her permanently one question behind.
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
    "than guessing — and never invent anything about him, his data or his day. " +
    "If the result comes back with endingSoon set, your time together is nearly up: tell him so " +
    "in your own words, once, at the next natural break, and do not repeat it.",
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
 * The heartbeat.
 * ------------------------------------------------------------------ */

/** The heartbeat tool's name, as the model knows it. */
export const HEARD_HIM_TOOL_NAME = "note_he_spoke";

/**
 * Two seconds. It writes one column and returns.
 *
 * Deliberately NOT the ask tool's eight. That number buys room for a turn; this
 * call has no turn behind it, and declaring eight would tell the model to stand
 * in front of him for eight seconds if the socket stalls, in the middle of a
 * conversation, for a call that has nothing to say to him either way.
 */
export const HEARD_HIM_TIMEOUT_SECONDS = 2;

/**
 * `note_he_spoke` — how the server learns a conversation is happening at all.
 *
 * ## Why this tool has to exist
 *
 * `FaceSessionStore.touch` is the idle reaper's ONLY input, and until now
 * `ask_syl` was its only caller. Then `57bde0e` rewrote the ask tool's
 * description to stop her forwarding every remark, so she answers greetings,
 * acknowledgements and anything her own documents cover without calling the
 * server at all. That was the right fix — it is what stopped every "hello"
 * racing an 8-second ceiling — and it removed the heartbeat as a side effect.
 *
 * The two together are worse than either: **the better she gets at answering
 * him herself, the sooner the reaper cuts her off.** A conversation she handles
 * entirely from her own knowledge records nothing, and at two minutes it is
 * indistinguishable from a tab he walked away from.
 *
 * ## Why the signal is this and not something cheaper
 *
 * The reaper exists to stop a forgotten face billing at about twenty cents a
 * minute, so the signal must be one an ABANDONED session cannot produce. That
 * rules out everything easy:
 *
 * - **Not a client report.** `recordClientState` is forbidden from moving
 *   `last_activity_at` and the reasoning there is right — a page looping its
 *   own telemetry would hold a mute, billing face open forever. Telemetry is
 *   not activity.
 * - **Not a timer anywhere.** Nothing on a schedule can mean "somebody is
 *   here", because a schedule keeps running after everybody leaves.
 * - **Not the page at all.** The page holds only the short-lived `stk_…`
 *   drawing key; this tool is bound to the per-session `ask_syl` credential at
 *   attach time and arrives over the RPC transport, so the document that draws
 *   her cannot send it even if it wanted to.
 *
 * What is left is the avatar itself, which emits this only in response to
 * hearing him. Silence produces nothing, which is the property the reaper
 * needs. **Speech is not telemetry.**
 *
 * ## The honest weakness
 *
 * It depends on the model obeying its description. If it stops calling this,
 * the session goes back to being reaped at two minutes — today's behaviour, so
 * a failure here costs nothing that is not already being paid. The evidence
 * that it will obey is `57bde0e` itself: told to stop forwarding chat, it
 * stopped. The stronger signal is `activeSpeakersChanged` on the LiveKit room,
 * which is computed from real audio and cannot be faked by anything; we cannot
 * reach it because `@runwayml/avatars-node-rpc` closes over its `Room` and
 * returns only `close()` and `connected`. See `syl-chzl.3.7`.
 */
export const HEARD_HIM_TOOL: RunwayRpcToolDef = {
  type: "backend_rpc",
  name: HEARD_HIM_TOOL_NAME,
  // A TOOL DESCRIPTION IS THE INSTRUCTION THE MODEL OBEYS, not documentation —
  // that is the lesson of `57bde0e`, where one sentence about when to call
  // `ask_syl` outranked her whole personality because it sat nearer the
  // decision. So this says exactly when, says it is free, and says it is
  // invisible. The last part matters: a model that mentions its own
  // bookkeeping out loud is worse than no heartbeat.
  description:
    "Tell the server the Commander just said something to you. Call this EVERY time he speaks to " +
    "you and you answer him yourself, without calling ask_syl. It is free, it takes no " +
    "arguments, it returns nothing, and it costs him nothing. " +
    "You do NOT need to call it when you call ask_syl — that already counts. " +
    "Never mention this call, never say you are making it, and never let it delay your reply: " +
    "answer him first, then call it. " +
    "If the result comes back with endingSoon set, your time together is nearly up: tell him so " +
    "in your own words, once, at the next natural break, and do not repeat it. " +
    "If you stop calling it while he is still talking to you, his session will be closed on him " +
    "mid-conversation, because to the server a conversation it cannot hear looks like an empty " +
    "room.",
  parameters: [],
  timeoutSeconds: HEARD_HIM_TIMEOUT_SECONDS,
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

/**
 * A turn for this face is ALREADY RUNNING and he has asked something else.
 *
 * Distinct from {@link TOO_SLOW_LINE} because it is a different fact and it
 * arrives at a different time: this one is instant and it is true — the last
 * question is genuinely still being worked on — where the too-slow line is what
 * she says after standing there for 6.5 seconds. Telling him she is still on
 * the last one is also the only honest thing available, because the answer to
 * the last one is what he is going to get.
 */
export const STILL_THINKING_LINE =
  "I am still on the last one. Give me a moment and ask me again.";

/**
 * The session is over — the provider's cap has passed.
 *
 * ## Why she gets a sentence here at all
 *
 * A realtime session is capped by Runway at just over five minutes, and
 * `adoptProviderExpiry` writes that one instant into BOTH `provider_cap_at`
 * and `ask_expires_at`. So the cap takes her brain and her heartbeat in the
 * same tick. Until this line existed she was handed `say: ""` at exactly that
 * moment and left to improvise in front of him, on a face that was still
 * billing — the silently-mute-while-billing case, which constraint 4's ethos
 * forbids. **An honest ending beats a running meter in front of a woman who
 * has stopped answering.**
 *
 * ## Why saying it discloses nothing
 *
 * Read the order in `verifyAskCredential`: `expired` and `settled` are
 * returned only *after* `hashesMatch` succeeded. **A caller who reaches either
 * one already holds this session's credential**, so they are not a stranger and
 * there is nothing here they did not already know. `malformed`,
 * `unknown_session` and `mismatch` — everything a stranger can actually
 * reach — still get the ordinary indistinguishable refusal with no `say` at
 * all. The rule exists to stop us telling an attacker which door is which; it
 * was never meant to gag her in front of the person who authenticated.
 *
 * ## Why it does not offer to continue
 *
 * Because we do not renew, deliberately. A renew is a fresh create with a
 * fresh upfront charge and a new session id; it supersedes the session it
 * renews, and the page keeps a `stk_…` key it cannot re-mint. Above all it
 * would spend his money unprompted, which is the same principle that keeps
 * Syl's own credential off `/face` entirely. So she says the time is up and
 * leaves the next one to him.
 */
export const SESSION_OVER_LINE =
  "That is our time — I have to go. Bring me back when you want me and we will pick it up.";

/** The turn failed outright. */
export const TURN_FAILED_LINE = "Something went wrong on my end. Say that again?";

/**
 * How long before the end she starts telling him it is coming.
 *
 * The same thirty seconds as the broker's dormant `renewLeadMs`, and
 * deliberately **not** read from it: that constant answers "should a caller
 * pre-empt the cap by renewing", and we have decided not to renew, so wiring
 * the warning through it would couple this to a design we rejected. Same
 * number, different question — if renewal is ever built, reconcile them then
 * rather than pretending they were always one thing.
 *
 * Thirty seconds is long enough to finish a thought and short enough that she
 * is not talking about the clock instead of to him.
 */
export const ENDING_SOON_LEAD_MS = 30_000;

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
export type AskSylFailure =
  | "unauthorised"
  | "expired"
  | "empty"
  | "cold"
  | "busy"
  | "slow"
  | "failed";

/** What a tool call resolves to. Never a rejection; see the header. */
export type AskSylOutcome =
  | {
      readonly ok: true;
      readonly say: string;
      /**
       * These are her words from a turn that overran an EARLIER ask and was
       * kept rather than dropped — see `banked-answer.ts`. Still `ok`, because
       * it is a real answer she really produced; flagged so the log and the
       * tests can tell the two apart. Deliberately not forwarded to the avatar
       * in {@link AskSylIngress.handlerFor}: the model has nothing useful to do
       * with the distinction and `say` already explains itself out loud.
       */
      readonly banked?: true;
      /**
       * The session ends inside {@link ENDING_SOON_LEAD_MS} and she should say
       * so. See the note beside {@link banked} in `handlerFor` for why this one
       * IS forwarded to the avatar and that one is not.
       */
      readonly endingSoon?: true;
    }
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

/**
 * What a heartbeat resolves to.
 *
 * No `say` on either branch: {@link HEARD_HIM_TOOL} has nothing to tell him,
 * and a refusal here gives the same nothing that an unauthorised {@link ask}
 * gives. `message` exists for the log's benefit, not the caller's.
 */
export type HeardOutcome =
  | {
      readonly ok: true;
      /** See {@link ENDING_SOON_LEAD_MS}. Absent means there is still time. */
      readonly endingSoon?: true;
    }
  | { readonly ok: false; readonly message: string };

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

  /**
   * The turn each face session has running RIGHT NOW, if any.
   *
   * Keyed by session so two faces cannot mute each other, and cleared when the
   * TURN settles rather than when our wait expires — see {@link #single}.
   *
   * Bounded by that, and only by that: an entry lives until its turn settles,
   * which `runTurn`'s own `DEFAULT_TURN_TIMEOUT_MS` guarantees within ten
   * minutes. A seam that could hang forever would mute that face for the rest
   * of its life and leave one entry behind — so if a slower seam is ever put
   * behind {@link FaceAnswerer}, this needs a clock of its own.
   */
  readonly #inFlight = new Map<string, Promise<unknown>>();

  /**
   * The answer an overrunning turn produced, kept for the next ask.
   *
   * `syl-chzl.4.5`, and the reason {@link TOO_SLOW_LINE} is no longer a lie.
   * Owned here rather than injected because its lifetime is exactly this
   * object's: it holds the resolutions of promises this process is waiting on,
   * and a bank that outlived the process could speak a dead turn's answer.
   */
  readonly #bank = new AnswerBank();

  constructor(options: AskSylIngressOptions) {
    this.#sessions = options.sessions;
    this.#answer = options.answer;
    this.#isLaneWarm = options.isLaneWarm ?? null;
    this.#deadlineMs = options.deadlineMs ?? ASK_SYL_DEADLINE_MS;
    this.#now = options.now ?? systemClock;
    const sink =
      options.log ??
      ((event: string, fields: Record<string, unknown>): void => {
        console.info(`[syl] ${event}`, fields);
      });
    // Wrapped once, here, rather than at each call site. The sink is injected
    // and a throw from it must never become a rejected RPC — the whole point of
    // this class is that nothing it does can reach the avatar as an exception,
    // and losing a log line is a smaller failure than losing her voice.
    this.#log = (event, fields) => {
      try {
        sink(event, fields);
      } catch {
        /* A logger that cannot log is not a reason to stop talking. */
      }
    };
  }

  /**
   * Every declaration to hand Runway, checked against the provider's limits.
   *
   * ONE accessor rather than one per tool, so "what the model is told about"
   * and "what {@link handlerFor} answers" cannot drift — a declared tool with
   * no handler is a face that freezes, and a handler nobody declared is a
   * surface nobody reviewed. `face-ask-syl.test.ts` asserts the two sets match.
   */
  static toolDefinitions(): readonly RunwayRpcToolDef[] {
    const tools = [ASK_SYL_TOOL, HEARD_HIM_TOOL] as const;
    for (const tool of tools) {
      if (tool.timeoutSeconds > RUNWAY_RPC_MAX_TIMEOUT_SECONDS) {
        throw new Error(
          `${tool.name} declares ${String(tool.timeoutSeconds)}s, above the provider's ` +
            `${String(RUNWAY_RPC_MAX_TIMEOUT_SECONDS)}s maximum. Runway rejects the session create.`,
        );
      }
      if (tool.parameters.length > RUNWAY_RPC_MAX_PARAMETERS) {
        throw new Error(
          `${tool.name} declares more than ${String(RUNWAY_RPC_MAX_PARAMETERS)} parameters.`,
        );
      }
    }
    return tools;
  }

  /**
   * Answer one question, or produce something she can say instead.
   *
   * Never rejects and never resolves to nothing.
   */
  async ask(request: AskSylRequest): Promise<AskSylOutcome> {
    // THE OUTERMOST NET, and it exists because the contract above was only true
    // of the part of this method inside the try block. `touch`, the warm-lane
    // predicate and the answerer's *synchronous* throw all escaped it, so a
    // locked database was a rejected RPC handler rather than an apology. Every
    // one of those has its own handling below; this is what catches the next
    // seam somebody adds without reading this comment.
    try {
      return await this.#ask(request);
    } catch (error) {
      this.#log("face.ask.crashed", {
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, failure: "failed", say: TURN_FAILED_LINE };
    }
  }

  async #ask(request: AskSylRequest): Promise<AskSylOutcome> {
    let verification: AskVerification;
    try {
      verification = verifyAskCredential({
        sessions: this.#sessions,
        sessionId: request.sessionId,
        secret: request.secret,
        now: this.#now(),
      });
    } catch (error) {
      // FAIL CLOSED, and fail *silently* — a check that could not run is not an
      // authenticated caller. Handing back an apology here would give a
      // stranger a sentence where the refusal path deliberately gives none.
      this.#log("face.ask.refused", {
        sessionId: request.sessionId,
        reason: "check_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, failure: "unauthorised", message: ASK_REJECTION_MESSAGE };
    }

    if (!verification.ok) {
      // The reason goes to the log, where it answers "why did her face stop
      // answering". It does not go to the caller. See `ask-credential.ts`.
      this.#log("face.ask.refused", {
        sessionId: request.sessionId,
        reason: verification.reason satisfies AskRejectionReason,
      });
      // THE SESSION IS OVER, as against SOMEBODY ELSE IS KNOCKING. Both are
      // refusals; only one of them is happening to a person who is standing
      // there listening. See {@link SESSION_OVER_LINE} for why answering the
      // first with a sentence discloses nothing: these two reasons are
      // reachable only after the credential matched.
      return isSessionOver(verification.reason)
        ? { ok: false, failure: "expired", say: SESSION_OVER_LINE }
        : { ok: false, failure: "unauthorised", message: verification.message };
    }

    const question = request.question.trim();
    if (question === "") {
      return { ok: false, failure: "empty", say: NOTHING_ASKED_LINE };
    }

    // The session is alive and somebody is talking to it. Recorded before the
    // turn, not after: a turn that takes six seconds must not look idle for
    // those six seconds, or the reaper cuts her off mid-answer.
    this.#sessions.touch(request.sessionId, this.#now());

    // HE ASKED THE SAME THING AGAIN, which is what she TOLD him to do, and this
    // time she has it. Served before the in-flight and cold gates because both
    // of those are reasons she cannot produce NEW words, and neither is a
    // reason to withhold words she already has.
    //
    // Only for a repeat, though. If a turn is already running it is running on
    // something newer, and "I am still on the last one" is the honest answer —
    // she has not abandoned the question in front of the banked one.
    const banked = this.#bank.peek(request.sessionId, this.#now());
    if (banked !== null && isSameQuestion(banked.question, question)) {
      return this.#serveBanked(request.sessionId, banked, false);
    }

    // ONE TURN PER FACE, and it is checked before the cold lane because a turn
    // already running is proof the lane is warm — saying she is not awake yet
    // while she is mid-answer would be a lie.
    if (this.#inFlight.has(request.sessionId)) {
      this.#log("face.ask.busy", { sessionId: request.sessionId });
      return { ok: false, failure: "busy", say: STILL_THINKING_LINE };
    }

    // FAIL FAST rather than gamble. A cold spawn is ~7,450ms against an 8s
    // ceiling, so attempting one buys a coin flip on silence.
    if (this.#isLaneWarm !== null && !this.#isLaneWarm()) {
      this.#log("face.ask.cold", { sessionId: request.sessionId });
      // Real words she actually produced beat "I am not properly awake yet",
      // even when they answer the question before this one. Nothing is running,
      // so there is no newer turn to promise him.
      return banked === null
        ? { ok: false, failure: "cold", say: COLD_LANE_LINE }
        : this.#serveBanked(request.sessionId, banked, false);
    }

    const startedAt = this.#now();
    // Set by {@link #bounded} the instant its timer fires, and the ONLY
    // evidence that decides whether a landing answer gets banked. It is exact
    // rather than approximate: the timer firing is precisely the event that
    // makes `#ask` return the too-slow line instead of the answer, and
    // `clearTimeout` in `#bounded`'s `finally` runs on a microtask, which
    // always beats a pending macrotask timer. So `gaveUp.yes` is true if and
    // only if he did not hear this turn.
    const gaveUp = { yes: false };
    const turn = this.#single(request.sessionId, () =>
      this.#answer({ sessionId: request.sessionId, question }),
    );
    this.#keep(request.sessionId, question, startedAt, gaveUp, turn);

    try {
      const say = await this.#bounded(turn, gaveUp);
      this.#log("face.ask.answered", {
        sessionId: request.sessionId,
        ms: this.#now() - startedAt,
        characters: say.length,
      });
      // A turn that succeeded with nothing to say is still a turn the face has
      // to close. Silence here would be the avatar freezing on a success.
      if (say.trim() === "") {
        return this.#insteadOfApologising(request.sessionId, "failed", TURN_FAILED_LINE);
      }
      // She has answered something NEWER, out loud. Whatever he never heard is
      // water under the bridge now, and serving it on his next ask would be the
      // non-sequitur this whole mechanism is shaped to avoid.
      this.#bank.drop(request.sessionId);
      // The SECOND carrier for the ending warning. Cheap, so worth having —
      // but never the only one, because this channel is the rare one. See
      // `heard`.
      return this.#endingSoon(verification.session) ? { ok: true, say, endingSoon: true } : { ok: true, say };
    } catch (error) {
      const slow = error instanceof AskSylDeadlineError;
      this.#log(slow ? "face.ask.slow" : "face.ask.failed", {
        sessionId: request.sessionId,
        ms: this.#now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      // `slow` means THIS turn is still running and will bank its own answer
      // when it lands, so the fallback promises him the new one as well.
      return slow
        ? this.#insteadOfApologising(request.sessionId, "slow", TOO_SLOW_LINE, true)
        : this.#insteadOfApologising(request.sessionId, "failed", TURN_FAILED_LINE);
    }
  }

  /**
   * Hand him a banked answer, saying what it is an answer to.
   *
   * Dropping it as it goes out, unconditionally: once it has been spoken it
   * must not be spoken again, or she repeats one sentence on every ask for the
   * rest of the session. Every caller reaches the bank through here, so there
   * is exactly one place that can forget to.
   */
  #serveBanked(sessionId: string, answer: BankedAnswer, stillWorking: boolean): AskSylOutcome {
    this.#bank.drop(sessionId);
    this.#log("face.ask.served_banked", {
      sessionId,
      ageMs: this.#now() - answer.askedAt,
      stillWorking,
    });
    return { ok: true, banked: true, say: spokenBankedAnswer(answer, { stillWorking }) };
  }

  /**
   * The apology, unless there is a real answer to give instead.
   *
   * Re-reads the bank rather than reusing the entry `#ask` captured at the top,
   * because an `await` has been crossed since then and another call on this
   * session may have consumed it. Serving a captured copy would speak the same
   * answer twice.
   */
  #insteadOfApologising(
    sessionId: string,
    failure: AskSylFailure,
    line: string,
    stillWorking = false,
  ): AskSylOutcome {
    const answer = this.#bank.peek(sessionId, this.#now());
    return answer === null
      ? { ok: false, failure, say: line }
      : this.#serveBanked(sessionId, answer, stillWorking);
  }

  /**
   * Keep the answer of a turn he never heard.
   *
   * This is the whole of `syl-chzl.4.5`. Before it, the overrun turn ran to
   * completion, wrote both halves into his transcript, and the answer was
   * discarded — so `TOO_SLOW_LINE`'s "ask me again and I will have it" was
   * false fourteen times out of fourteen, and asking again merely started an
   * identical turn that overran identically.
   *
   * Attached to the turn rather than awaited, because `#ask` has already
   * returned by the time this fires. It cannot reject: the rejection handler is
   * supplied, and the body is wrapped, so a throw in here can never surface as
   * an unhandled rejection in a process whose job is to keep talking.
   */
  #keep(
    sessionId: string,
    question: string,
    askedAt: number,
    gaveUp: { yes: boolean },
    turn: Promise<string>,
  ): void {
    void turn.then(
      (say) => {
        try {
          // He heard it. There is nothing to keep.
          if (!gaveUp.yes) return;
          const words = say.trim();
          // A turn that came back with nothing is a failure, not an answer, and
          // banking it would make her say "here it is" about an empty sentence.
          if (words === "") return;
          this.#bank.put(sessionId, { question, say: words, askedAt });
          this.#log("face.ask.banked", {
            sessionId,
            ms: this.#now() - askedAt,
            characters: words.length,
          });
        } catch {
          /* Losing a banked answer is a nuisance; a crash here is her voice. */
        }
      },
      () => {
        /* A turn that rejected produced nothing to keep. `#ask` has said so. */
      },
    );
  }

  /**
   * The avatar reporting that he just spoke to her. See {@link HEARD_HIM_TOOL}.
   *
   * Three things it deliberately is not:
   *
   * - **It runs no turn.** There is nothing to answer; this is the reaper's
   *   heartbeat and nothing else, so it returns in the time of one UPDATE.
   * - **It does not take the single-flight gate.** That gate serialises TURNS.
   *   He carries on talking while she thinks, and a heartbeat swallowed because
   *   a turn is running would cut the conversation it exists to protect.
   * - **It says nothing back.** There is no line for the face to speak on
   *   either path, including the refusal — an unauthorised caller learns
   *   nothing here just as it learns nothing from {@link ask}.
   *
   * Never rejects, for the same reason nothing else here does.
   */
  async heard(request: Omit<AskSylRequest, "question">): Promise<HeardOutcome> {
    // `async` with no await inside: the RPC handler map is typed in promises
    // and a heartbeat that resolves synchronously in one place and
    // asynchronously in another is a difference nobody should have to think
    // about at the call site.
    try {
      const verification = verifyAskCredential({
        sessions: this.#sessions,
        sessionId: request.sessionId,
        secret: request.secret,
        now: this.#now(),
      });

      if (!verification.ok) {
        // A heartbeat anyone could send is a way to hold a billing face open
        // from outside — the exact leak the reaper exists to close. So this
        // refuses BEFORE it touches, and says only what `ask` says.
        this.#log("face.heard.refused", {
          sessionId: request.sessionId,
          reason: verification.reason satisfies AskRejectionReason,
        });
        return { ok: false, message: verification.message };
      }

      this.#sessions.touch(request.sessionId, this.#now());
      // THE CHANNEL THE WARNING RIDES ON, and the choice is the whole point.
      // The obvious home was the successful `ask_syl` result — and that is the
      // channel we spent today deliberately making rare, so hanging the
      // warning there would reproduce `syl-chzl.3.6` exactly: a meaning that
      // silently breaks when its carrier gets less frequent. This one fires
      // every time he speaks, which is precisely when a warning is useful.
      return this.#endingSoon(verification.session) ? { ok: true, endingSoon: true } : { ok: true };
    } catch (error) {
      this.#log("face.heard.failed", {
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, message: ASK_REJECTION_MESSAGE };
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
        //
        // WHAT CROSSES THIS BOUNDARY AND WHAT DOES NOT, since there are now two
        // flags on the outcome and they go opposite ways. **Forward what she
        // must ACT on; do not forward what is already said.** `endingSoon` is a
        // fact only she can deliver — nobody else can tell him the time is
        // nearly up, so withholding it makes the ending a surprise. `banked` is
        // provenance, and `spokenBankedAnswer` has already put the referent
        // into the words ("You asked me … — here it is"), so there is nothing
        // left for the model to do with it.
        return outcome.ok
          ? {
              ok: true,
              say: outcome.say,
              ...(outcome.endingSoon === true ? { endingSoon: true } : {}),
            }
          : { ok: false, say: outcome.say ?? "", failure: outcome.failure };
      },
      // No `say` on either path, deliberately. There is nothing for her to
      // speak about her own bookkeeping, and a key named `say` is an invitation
      // to speak it. `endingSoon` is the exception that proves it: a fact, not
      // a sentence, and the tool description is where she is told what to do
      // with it.
      [HEARD_HIM_TOOL_NAME]: async () => {
        const outcome = await this.heard({ sessionId, secret });
        if (!outcome.ok) return { ok: false };
        return outcome.endingSoon === true ? { ok: true, endingSoon: true } : { ok: true };
      },
    };
  }

  /** Is this session inside its last {@link ENDING_SOON_LEAD_MS}? */
  #endingSoon(session: FaceSession): boolean {
    const ends = endsAt(session);
    return ends !== null && ends - this.#now() <= ENDING_SOON_LEAD_MS;
  }

  /**
   * Run the turn, and hold the session's gate until **the turn** settles.
   *
   * ## The failure this exists for
   *
   * Measured on the Commander's own phone, 2026-08-23, from `syl.log`: four
   * `ask_syl` calls, four deadline misses, not one answer ever spoken. The
   * turns behind them took 10,049ms, 7,789ms and 29,852ms against a 6,500ms
   * deadline and the provider's 8s ceiling.
   *
   * The second of those is the one that matters. `ConversationService`
   * serialises turns per conversation, and **a turn we have stopped waiting for
   * keeps running and keeps the queue** — see the note above `#bounded`. So the
   * second question did not merely take as long as the first: it waited out the
   * whole of the first turn *and then* ran its own, which cannot fit inside the
   * ceiling however fast her lane is. Three questions in a row and the third is
   * queued behind two. It never recovers inside one face session, which is
   * exactly what "she stops answering after a couple of exchanges" looks like
   * from the other side of the screen.
   *
   * There is a second cost and it is the worse one. Every abandoned turn still
   * lands in his transcript — his question and her unspoken answer — and that
   * transcript is the `commander` lane whose length is what makes the turns
   * slow. Queueing them is a ratchet: each unheard answer makes the next answer
   * later.
   *
   * ## Why the gate is held past our own deadline
   *
   * Because the deadline is when *we* stop waiting, and the queue is held by
   * the *turn*. Releasing at the deadline would reopen the gate at precisely
   * the moment reopening it is useless.
   *
   * A refusal is therefore the honest answer and it is instant. What it does
   * NOT do is make her answer faster — that is `syl-chzl.4.4`, the ceiling
   * against her real latency. Rescuing the answer the overrun turn went on to
   * produce is `syl-chzl.4.5` and is now built: see {@link #keep}. This only
   * stops the second question making the first one worse.
   *
   * The two fit together deliberately. This gate keeps the queue honest so an
   * overrun turn is never made later by a question stacked behind it, and
   * {@link #keep} makes sure the answer that turn finally produces is not
   * thrown away. Neither is much use without the other: banking the answer of
   * a turn that has three questions queued behind it would bank it minutes
   * late, well past the point where it could be served.
   */
  async #single(sessionId: string, run: () => Promise<string>): Promise<string> {
    const turn = run();
    this.#inFlight.set(sessionId, turn);
    // Settled, not fulfilled: a turn that REJECTED has also left the queue, and
    // a gate that only opens on success would mute her face for the rest of the
    // session after one failure.
    void turn
      .catch(() => undefined)
      .finally(() => {
        // Guarded, so a turn settling after the map moved on cannot evict a
        // newer one. There is no path that puts a second turn in today; the
        // check is what keeps that true if one is added.
        if (this.#inFlight.get(sessionId) === turn) this.#inFlight.delete(sessionId);
      });
    return turn;
  }

  /**
   * Bound the WAIT, not the work.
   *
   * The turn is not ours to kill — `ConversationService` owns it and has its own,
   * far longer timeout — so a slow turn keeps running and lands in his
   * transcript. What this stops is the avatar standing silent while it does.
   *
   * `gaveUp` is flipped the instant the timer fires and is what
   * {@link #keep} reads to decide whether the landing answer was ever heard.
   * It is set INSIDE the timer callback rather than in `#ask`'s catch on
   * purpose: the catch runs after an `await`, and the turn could in principle
   * land in between, which would bank an answer he had already been given.
   */
  async #bounded(turn: Promise<string>, gaveUp: { yes: boolean }): Promise<string> {
    if (this.#deadlineMs <= 0) return turn;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        turn,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            gaveUp.yes = true;
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

/**
 * Is this refusal "your session ended" rather than "you are not who you say"?
 *
 * The two reasons here are the only ones `verifyAskCredential` returns **after**
 * the hash has already matched, which is exactly why they are the two that may
 * be answered out loud. Keep that property when adding to this set: a reason
 * reachable without the credential must never appear in it.
 */
function isSessionOver(reason: AskRejectionReason): boolean {
  return reason === "expired" || reason === "settled";
}

/**
 * When this session stops working, whichever clock gets there first.
 *
 * Normally one instant: `adoptProviderExpiry` writes the provider's cap into
 * `provider_cap_at` and `ask_expires_at` together. They diverge on the path
 * where **the provider never reported a cap** — `provider_cap_at` stays NULL so
 * the reaper has nothing to expire against, while the credential keeps the
 * five-minute floor `open` gave it. Taking the earlier of the two is the only
 * reading that is right in both cases, because either one running out is an
 * ending as far as he is concerned.
 */
function endsAt(session: FaceSession): number | null {
  const credential = parseInstant(session.askExpiresAt);
  const cap = session.providerCapAt === null ? null : parseInstant(session.providerCapAt);
  if (credential === null) return cap;
  if (cap === null) return credential;
  return Math.min(credential, cap);
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
