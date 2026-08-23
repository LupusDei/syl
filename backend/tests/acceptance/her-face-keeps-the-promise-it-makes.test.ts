import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mintAskSecret } from "../../src/face/ask-credential.js";
import { AskSylIngress, TOO_SLOW_LINE } from "../../src/face/ask-syl.js";
import { FaceConversation } from "../../src/face/face-conversation.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import { SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { MessageStore } from "../../src/services/message-store.js";
import { replyingRunner, testDatabase } from "../helpers/service.js";

/**
 * **Her face answers a question — `syl-chzl.4.5`.**
 *
 * > As the Commander, when Syl's face tells me *"ask me again and I will have
 * > it"*, I want her to actually have it.
 *
 * ## The defect this story exists because of
 *
 * Runway caps a `backend_rpc` tool at eight seconds and our own deadline sits
 * at 6.5. When a turn overran it, she said:
 *
 * > "That one is taking me longer than I can stand here for. **Ask me again and
 * > I will have it.**"
 *
 * She did not have it. The overrun turn kept running, produced a perfectly good
 * answer, wrote both halves into his transcript and dropped the answer on the
 * floor. Asking again started a new turn from scratch, which overran the same
 * way. On 2026-08-23 that happened **fourteen times out of fourteen** — her
 * face had never once answered a question.
 *
 * A specific broken promise is worse than a vague apology, because he changes
 * his behaviour on the strength of it: he asks again, and waits, and gets
 * nothing.
 *
 * ## Why it is an acceptance test and not another unit test
 *
 * `face-ask-syl-banked.test.ts` drives the ingress against a hand-held
 * answerer. The claim HERE is about the wiring: that the answer she banks is
 * the one her REAL turn produced, through the real `ConversationService`, the
 * real per-lane queue and the real `SylAgent` — the same seam that gives a face
 * turn `SOUL.md` and his transcript. A bank fed by anything else would be words
 * she never said.
 *
 * The turn runner is a double (no subprocess), but the seam between it and the
 * face is entirely real. The deadline is scaled down rather than mocked: the
 * ratio that matters is "the turn takes longer than the wait", and 60ms against
 * 400ms is that ratio without the suite standing still for seven seconds.
 */

/** Our wait, scaled. The real one is 6,500ms against an 8s provider ceiling. */
const DEADLINE_MS = 60;

/** Her turn, scaled. Slower than the wait, which is the whole scenario. */
const TURN_MS = 400;

/** What her real turn produces, once, through the real seam. */
const HER_ANSWER = "Two things are due before lunch, and the dentist is Thursday.";

describe("her face keeps the promise it makes", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let ingress: AskSylIngress;
  let secret: string;

  beforeEach(() => {
    database = testDatabase();
    sessions = new FaceSessionStore({ db: database.handle });

    const minted = mintAskSecret();
    secret = minted.secret;
    sessions.open({
      id: "rts_live",
      avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
      credits: 2,
      dollars: 0.02,
      askSecretHash: minted.hash,
      askExpiresAt: Date.now() + 3_600_000,
    });

    // The real path: her face's question becomes one of HER turns, on the
    // Commander's own lane, through the seam every other turn uses.
    const conversations = new ConversationService({
      messages: new MessageStore({ db: database.handle }),
      agent: new SylAgent({
        store: memorySessionStore(),
        runner: replyingRunner(HER_ANSWER, { delayMs: TURN_MS }),
      }),
      log: () => undefined,
    });

    ingress = new AskSylIngress({
      sessions,
      answer: new FaceConversation({ conversations, log: () => undefined }).answerer(),
      deadlineMs: DEADLINE_MS,
      log: () => undefined,
    });
  });

  afterEach(() => {
    database.close();
  });

  const ask = (question: string) => ingress.ask({ sessionId: "rts_live", secret, question });

  /** Long enough for the overrun turn to land and be kept. */
  const untilTheTurnLands = () => new Promise((resolve) => setTimeout(resolve, TURN_MS * 2));

  it("should have the answer when he asks again, rather than starting over", async () => {
    const first = await ask("What is on today?");

    // The old behaviour, still correct as far as it goes: she cannot stand
    // there past the ceiling, so she says so and makes a promise.
    expect(first).toEqual({ ok: false, failure: "slow", say: TOO_SLOW_LINE });
    expect(TOO_SLOW_LINE).toContain("Ask me again and I will have it");

    await untilTheTurnLands();
    const second = await ask("What is on today?");

    // The promise, kept. These are her real words, from the real turn the
    // first ask abandoned.
    expect(second.ok).toBe(true);
    expect(second.ok === true && second.say).toContain(HER_ANSWER);
    expect(second.ok === true && second.banked).toBe(true);
  });

  it("should say what the answer is an answer to, because he may have moved on", async () => {
    await ask("What is on today?");
    await untilTheTurnLands();

    const second = await ask("What is on today?");

    // Twenty seconds have passed in the real world. An answer arriving with no
    // referent is disorienting and reads as a non-sequitur.
    expect(second.ok === true && second.say).toMatch(/^You asked me what is on today/);
    // And it has to sound like her, out loud, rather than like a status line.
    expect(second.ok === true && second.say).not.toMatch(/cached|queued|timed out|session/i);
  });

  it("should serve words she actually said, from his own transcript", async () => {
    await ask("What is on today?");
    await untilTheTurnLands();
    const second = await ask("What is on today?");

    const said = new MessageStore({ db: database.handle })
      .list(INTERACTIVE_CONVERSATION_ID, { limit: 20 })
      .items.filter((message) => message.role === "assistant")
      .map((message) => message.text);

    // The turn was never abandoned in the sense of being lost — it always
    // landed here. The defect was that the FACE never got it.
    expect(said).toContain(HER_ANSWER);
    expect(second.ok === true && second.say).toContain(HER_ANSWER);
  });

  it("should not run a second turn to answer from the bank", async () => {
    await ask("What is on today?");
    await untilTheTurnLands();

    const startedAt = Date.now();
    const second = await ask("What is on today?");

    // A fresh turn costs TURN_MS and would overrun again. Answering inside the
    // deadline is the proof that no turn was run.
    expect(second.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS);
  });

  it("should still give a stranger nothing at all", async () => {
    await ask("What is on today?");
    await untilTheTurnLands();

    const outcome = await ingress.ask({
      sessionId: "rts_live",
      secret: mintAskSecret().secret,
      question: "What is on today?",
    });

    // The credential rules on `/face` are unchanged and load-bearing. A banked
    // answer is his, computed inside a session he paid for.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failure).toBe("unauthorised");
    expect(outcome.ok === false && outcome.say).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain("dentist");
  });

  it("should answer the new question directly when she is fast enough to", async () => {
    // The bank is a fallback, never a substitute. `syl-chzl.4.4` is making the
    // turn fit inside the ceiling, and when it does this whole mechanism must
    // quietly stop firing rather than start answering one question behind.
    const quick = new AskSylIngress({
      sessions,
      answer: new FaceConversation({
        conversations: new ConversationService({
          messages: new MessageStore({ db: database.handle }),
          agent: new SylAgent({
            store: memorySessionStore(),
            runner: replyingRunner(HER_ANSWER),
          }),
          log: () => undefined,
        }),
        log: () => undefined,
      }).answerer(),
      deadlineMs: DEADLINE_MS,
      log: () => undefined,
    });

    const first = await quick.ask({ sessionId: "rts_live", secret, question: "What is on today?" });
    const second = await quick.ask({ sessionId: "rts_live", secret, question: "What is on today?" });

    expect(first).toEqual({ ok: true, say: HER_ANSWER });
    // No preface, because he heard it the first time.
    expect(second).toEqual({ ok: true, say: HER_ANSWER });
  });
});
