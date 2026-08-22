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
 * ## The rail is checked twice, in both directions
 *
 * Constraint 3: `ANTHROPIC_API_KEY` must be stripped from any child process and
 * `apiKeySource === "none"` asserted, because a set key silently outranks the
 * claude.ai login and reroutes billing to the metered API.
 *
 * `runTurn` enforces that at the spawn. This module adds the two locks that
 * only matter for a caller whose output is a **voice**:
 *
 * 1. **Before**: if the variable is set in *this* process, the turn is refused
 *    and never run. "Refused rather than run" is the bead's wording and it is
 *    the right way round — a turn already spawned has already been billed.
 * 2. **After**: if the CLI reports any source but `none`, the answer is not
 *    spoken. It stays in the transcript, because it happened; it does not come
 *    out of her mouth.
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
        ? `ANTHROPIC_API_KEY is set in this process, so a spawned turn would bill the metered ` +
          `API rather than the claude.ai subscription. Refusing to run the turn at all.`
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
   * Reads `ANTHROPIC_API_KEY`. Injected so the pre-flight refusal is testable
   * without mutating the real environment out from under a parallel test file.
   */
  readonly readEnv?: () => string | undefined;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export class FaceConversation {
  readonly #conversations: FaceConversationSeam;
  readonly #conversationId: string | undefined;
  readonly #readEnv: () => string | undefined;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(options: FaceConversationOptions) {
    this.#conversations = options.conversations;
    this.#conversationId = options.conversationId ?? HIS_CONVERSATION;
    this.#readEnv = options.readEnv ?? ((): string | undefined => process.env["ANTHROPIC_API_KEY"]);
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

    // LOCK ONE, before anything is spawned. See the header.
    const key = this.#readEnv();
    if (key !== undefined && key !== "") {
      this.#log("face.turn.refused", { sessionId: input.sessionId, why: "api_key_set" });
      throw new FaceRailRefusedError("ANTHROPIC_API_KEY", "before");
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
