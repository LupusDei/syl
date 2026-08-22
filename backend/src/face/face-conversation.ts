import type { AnsweredTurn, ConversationService } from "../services/conversation-service.js";
import type { FaceAnswerer } from "./ask-syl.js";

/**
 * A face turn is one of HER turns — `syl-chzl.4.2`.
 *
 * ## What this file is defending
 *
 * Attaching at the LiveKit layer rather than at a provider's avatar SDK was
 * chosen for exactly one reason: **the provider's model never gets the talking
 * seat.** One layer up, the vendor's weights answer the Commander, and
 * `SOUL.md`, her memory graph and the reader fence are all bypassed at once.
 *
 * That is a claim about *wiring*, and wiring rots. This module is where the
 * claim becomes a tested property, and `face-conversation.test.ts` is the
 * assertion that fails when somebody re-wires it.
 *
 * ## How it holds
 *
 * By going through `services/conversation-service.ts` — **the same seam every
 * other turn uses** — and by having no other path to an answer. There is no
 * `SylAgent` here, no `runTurn`, no personality string, and no branch that can
 * produce words she did not say. Four things follow from using that seam rather
 * than reimplementing it:
 *
 * - `SylAgent` appends `SOUL.md` and resumes the `commander` session, so a face
 *   turn has her standing orders and everything said today.
 * - Both halves land in the transcript, so what she said with her face is in
 *   one thread with what she said in text.
 * - One turn runs at a time per conversation, so a face turn and a message from
 *   his phone cannot become two subprocesses resuming one session id.
 * - The memory index and his-words recording wrap the runner once, for every
 *   caller, rather than once per caller.
 *
 * ## The rail is checked twice, and NOT in the obvious place
 *
 * Constraint 3: `ANTHROPIC_API_KEY` must be stripped from any child process and
 * `apiKeySource === "none"` asserted, because a set key silently outranks the
 * claude.ai login and reroutes billing to the metered API.
 *
 * `runTurn` already does both at the spawn — `delete env["ANTHROPIC_API_KEY"]`
 * on the child, and `assertSubscriptionAuth` on the init frame. This module
 * adds the two locks that only matter for a caller whose output is a **voice**:
 *
 * 1. **Before**: if the **warm lane's live process** last reported anything but
 *    `none`, the turn is refused and never run. That is the pre-flight signal,
 *    and it is a real one: a warm lane holds a long-lived child, so what it
 *    reported at its last init is what the next turn will bill against.
 * 2. **After**: if the CLI reports any source but `none`, the answer is not
 *    spoken. It stays in the transcript, because it happened; it does not come
 *    out of her mouth.
 *
 * **What is deliberately NOT checked is this process's own environment.** The
 * obvious guard — refuse if `ANTHROPIC_API_KEY` is set here — is wrong, and it
 * was written that way first. `runTurn` strips the variable from the child, so
 * a key in the parent's environment does not reach Claude Code and does not
 * change what is billed. Refusing on it would take her face offline on every
 * machine whose shell happens to export one, which is most developer machines
 * and was in fact this very agent's own environment. A guard that fires on a
 * condition the system already handles is not caution, it is an outage with a
 * good excuse.
 */

/** Her own thread, by default. `laneFor` maps it to the `commander` lane. */
const HIS_CONVERSATION = undefined;

/** What she says when a turn came back on the wrong rail. */
export const METERED_RAIL_LINE =
  "I have stopped myself there — something rerouted how I am being billed, and I will not " +
  "keep talking until that is sorted.";

/** A turn came back on, or would have gone out on, the metered API. */
export class FaceRailRefusedError extends Error {
  readonly code = "FACE_METERED_RAIL";
  readonly apiKeySource: string;

  constructor(apiKeySource: string, when: "before" | "after") {
    super(
      when === "before"
        ? `Her warm lane is running on "${apiKeySource}", so the next turn would bill the ` +
          `metered API rather than the claude.ai subscription. Refusing to run it at all.`
        : `Refusing to speak a turn billed through "${apiKeySource}": Syl runs on subscription ` +
          `rails and requires apiKeySource === "none".`,
    );
    this.name = "FaceRailRefusedError";
    this.apiKeySource = apiKeySource;
  }
}

/** A turn produced no words for the face to speak. */
export class FaceTurnSilentError extends Error {
  constructor(reason: string) {
    super(`Her turn gave the face nothing to say: ${reason}`);
    this.name = "FaceTurnSilentError";
  }
}

/** The slice of `ConversationService` a face turn uses. Nothing wider. */
export type FaceConversationSeam = Pick<ConversationService, "ask">;

export interface FaceConversationOptions {
  readonly conversations: FaceConversationSeam;
  /**
   * Which conversation a face turn belongs to. Defaults to the Commander's own
   * thread, which is the only correct answer today and is a parameter so that
   * a test does not have to reach for a global.
   */
  readonly conversationId?: string;
  /**
   * What the warm lane's live process last reported as `apiKeySource`.
   *
   * `WarmLanes.status(LANES.commander)?.apiKeySource`. `undefined` means there
   * is no live process to have reported anything, which is not evidence of a
   * problem — the turn runs and the post-flight lock catches it.
   */
  readonly laneRail?: () => string | undefined;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export class FaceConversation {
  readonly #conversations: FaceConversationSeam;
  readonly #conversationId: string | undefined;
  readonly #laneRail: (() => string | undefined) | null;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(options: FaceConversationOptions) {
    this.#conversations = options.conversations;
    this.#conversationId = options.conversationId ?? HIS_CONVERSATION;
    this.#laneRail = options.laneRail ?? null;
    this.#log =
      options.log ??
      ((event, fields) => {
        console.info(`[syl] ${event}`, fields);
      });
  }

  /**
   * Run one face turn and hand back what she said.
   *
   * Throws rather than returning an apology: `AskSylIngress` owns what the
   * avatar says when a turn does not produce words, and two modules both
   * choosing a failure line is how they disagree. This one's job is to answer
   * or to explain why it will not.
   */
  async answer(input: { readonly sessionId: string; readonly question: string }): Promise<string> {
    const question = input.question.trim();
    if (question === "") {
      throw new FaceTurnSilentError("there was nothing in the question to answer");
    }

    // LOCK ONE, before anything is spawned. See the header for why the signal
    // is the warm lane's last init frame and not this process's environment.
    const rail = this.#laneRail?.();
    if (rail !== undefined && rail !== "none") {
      this.#log("face.turn.refused", {
        sessionId: input.sessionId,
        why: "wrong_rail",
        when: "before",
        apiKeySource: rail,
      });
      throw new FaceRailRefusedError(rail, "before");
    }

    const turn: AnsweredTurn = await this.#conversations.ask({
      ...(this.#conversationId === undefined ? {} : { conversationId: this.#conversationId }),
      clientId: null,
      role: "user",
      text: question,
    });

    // LOCK TWO, between the answer arriving and the answer being said. The turn
    // stays in the transcript — it happened — but it does not come out of her
    // mouth.
    if (turn.apiKeySource !== null && turn.apiKeySource !== "none") {
      this.#log("face.turn.refused", {
        sessionId: input.sessionId,
        why: "wrong_rail",
        apiKeySource: turn.apiKeySource,
      });
      throw new FaceRailRefusedError(turn.apiKeySource, "after");
    }

    if (turn.failed) {
      // Her apology is already persisted by the seam. The face gets the
      // exception so `AskSylIngress` chooses what she says out loud.
      throw new FaceTurnSilentError(turn.spoken);
    }
    if (turn.spoken.trim() === "") {
      throw new FaceTurnSilentError("the turn succeeded with nothing to say");
    }

    return turn.spoken;
  }

  /** This object as the ingress's seam. See {@link FaceAnswerer}. */
  answerer(): FaceAnswerer {
    return (input) => this.answer(input);
  }
}
