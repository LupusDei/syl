import type { ApiError, Message } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_QUIET_HOURS } from "../../src/config.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import { fixedClock } from "../../src/services/clock.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import {
  TELLING_MESSAGE_CLASS,
  TellingError,
  TellingService,
} from "../../src/services/telling-service.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * The door `show_him` never was — `syl-0x1h`.
 *
 * She could reach him unprompted and did it often, and every one of those
 * arrived as a REMINDER: an entry on his list plus a buzz. The only verb that
 * wrote into the conversation itself was `show_him`, and it requires a render —
 * so she could not say a paragraph about his insurance without also making a
 * fifteen-second film about it. Her own words: *"my unprompted voice arrives
 * wearing a reminder's clothes, and the one door into the actual conversation
 * has a video-shaped lock on it."*
 *
 * A telling is that door: her words, in his conversation and on his phone, with
 * nothing attached. **The delivery is not a second mechanism** — `SendingService`
 * composes through this same object, so there is one implementation of "her
 * words reach him" and a sending is that plus a face.
 *
 * The things these tests exist to hold, none of which is plumbing:
 *
 * - it goes through the OUTBOX, so quiet hours bound it exactly as they bound
 *   every other way she reaches his phone;
 * - it cannot claim urgency for itself, so nothing here can pierce that window;
 * - it buzzes ONCE per telling, whatever re-drives it;
 * - a failure of the notification never costs the words, which is constraint 4
 *   applied one noun along.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

/** 03:00 in Chicago on 2026-08-12 — the middle of the default quiet window. */
const SMALL_HOURS = Date.UTC(2026, 7, 12, 8, 0);
/** 14:00 in Chicago the same day. He is awake. */
const AFTERNOON = Date.UTC(2026, 7, 12, 19, 0);
/** 07:00 in Chicago, the instant the window releases, on that date. */
const WINDOW_ENDS = "2026-08-12T12:00:00.000Z";

let db: SylDatabase;

beforeEach(() => {
  db = testDatabase();
});

afterEach(() => {
  db.close();
});

interface Bench {
  readonly teller: TellingService;
  readonly outbox: Outbox;
  readonly messages: MessageStore;
}

/**
 * A teller over the real stores, with an outbox on the clock a test chooses.
 *
 * Real stores rather than doubles for the reason `testDeps` gives: the
 * interesting failures at this layer are the store's — a CHECK that fires, a
 * UNIQUE that does — and a double has none of them.
 */
function tellerAt(now: number, options: { readonly quiet?: boolean } = {}): Bench {
  const base = testDeps(db);
  const outbox = new Outbox({
    db: db.handle,
    clock: fixedClock(now),
    ...(options.quiet === true ? { quietHours: DEFAULT_QUIET_HOURS } : {}),
  });
  return {
    teller: new TellingService({ chat: base.chat, outbox, log: () => undefined }),
    outbox,
    messages: base.messages,
  };
}

/** How many messages his own thread holds right now. */
function historyLength(messages: MessageStore): number {
  return messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 50 }).items.length;
}

describe("TellingService — her words, and no face on them", () => {
  it("should put what she said in his conversation and carry it to his phone", () => {
    const { teller, outbox, messages } = tellerAt(AFTERNOON);

    const said = teller.tell({
      words: "Your auto policy renews on the 3rd and the quote you were given expires before it.",
      because: "He asked me to watch for this in March.",
    });

    // Half one: it is in the conversation, as HER, on his own thread — and it
    // is really in the store rather than only in the value handed back.
    expect(said.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
    expect(said.role).toBe("assistant");
    expect(messages.get(said.id)?.text).toContain("auto policy");

    // Half two: it is on his phone, carrying her sentence verbatim — never a
    // notice about the app.
    const queued = outbox.list({ limit: 10 }).items;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.channel).toBe("apns");
    expect(queued[0]?.messageClass).toBe(TELLING_MESSAGE_CLASS);
    expect(queued[0]?.payload.body).toBe(said.text);
    expect(queued[0]?.payload.title).toBe("Syl");
  });

  it("should refuse with nothing to say, and leave nothing behind", () => {
    const { teller, outbox, messages } = tellerAt(AFTERNOON);
    const before = historyLength(messages);

    expect(() => teller.tell({ words: "   ", because: "He asked." })).toThrow(TellingError);

    // Refused before anything was written. A verb that refuses after it has
    // acted has not refused.
    expect(historyLength(messages)).toBe(before);
    expect(outbox.list({ limit: 10 }).items).toEqual([]);
  });

  it("should refuse a telling that does not say why it exists", () => {
    // The same rule every other unprompted write follows. This one reaches him
    // without his asking, which is exactly where he cannot tell a good instinct
    // from a wrong one without the reason.
    const { teller, outbox, messages } = tellerAt(AFTERNOON);
    const before = historyLength(messages);

    expect(() => teller.tell({ words: "The dog sitter has not confirmed.", because: " " })).toThrow(
      TellingError,
    );

    expect(historyLength(messages)).toBe(before);
    expect(outbox.list({ limit: 10 }).items).toEqual([]);
  });

  it("should hold a telling made at three in the morning until he is awake", () => {
    // THE INTEGRATION POINT THAT MATTERS MOST. Quiet hours bound what may REACH
    // him, never what may run — so the words are written now and the buzz is
    // deferred by the outbox, exactly as a sending's is. A new door into his
    // phone that ignored this would be a 3am notification.
    const { teller, outbox } = tellerAt(SMALL_HOURS, { quiet: true });

    teller.tell({ words: "I worked something out about the zoo trip.", because: "It kept me up." });

    const queued = outbox.list({ limit: 10 }).items;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.nextAttemptAt).toBe(WINDOW_ENDS);
    expect(Date.parse(queued[0]?.nextAttemptAt ?? "")).toBeGreaterThan(SMALL_HOURS);
  });

  it("should never claim urgency for itself, whatever she puts in the words", () => {
    // She does not get to decide that something wakes him. `remind_me` proved
    // that a self-judged flag pierces the window (`syl-j55`); a verb with no
    // flag at all cannot, and this is what says the flag was never added later.
    const { teller, outbox } = tellerAt(SMALL_HOURS, { quiet: true });

    teller.tell({ words: "URGENT: wake up.", because: "She thought it was urgent." });

    expect(outbox.list({ limit: 10 }).items[0]?.nextAttemptAt).toBe(WINDOW_ENDS);
  });

  it("should buzz him once for one telling, however often the push is re-driven", () => {
    const { teller, outbox } = tellerAt(AFTERNOON);

    const said = teller.tell({ words: "Twice would be a nuisance.", because: "He asked." });
    // Keyed on the message's own id, so re-driving it is a no-op rather than a
    // second buzz for one sentence.
    teller.push({
      body: said.text,
      messageClass: TELLING_MESSAGE_CLASS,
      idempotencyKey: `telling:${said.id}`,
    });

    expect(outbox.list({ limit: 10 }).items).toHaveLength(1);
  });

  it("should keep the words when the notification cannot be enqueued", () => {
    // Constraint 4's shape: the words are already his by the time anything is
    // enqueued, and losing them to a failure of the decoration is the same
    // injury as a vanished reminder with a nicer excuse.
    const base = testDeps(db);
    const broken = {
      enqueue: () => {
        throw new Error("the outbox is on fire");
      },
    } as unknown as Outbox;
    const teller = new TellingService({ chat: base.chat, outbox: broken, log: () => undefined });

    const said = teller.tell({ words: "This still stands.", because: "He asked." });

    expect(base.messages.get(said.id)?.text).toBe("This still stands.");
  });
});

describe("POST /tellings", () => {
  let deps: AppDependencies;
  let running: RunningApp;
  let token: string;
  let keyCounter = 0;

  beforeEach(async () => {
    deps = testDeps(db);
    running = await startTestApp(createApp(testConfig(), deps));
    token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  });

  afterEach(async () => {
    await running.close();
  });

  async function post(body: unknown): Promise<{ status: number; envelope: Envelope<Message> }> {
    keyCounter += 1;
    const response = await fetch(`${running.baseUrl}/api/v1/tellings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Idempotency-Key": `telling-${String(keyCounter)}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, envelope: (await response.json()) as Envelope<Message> };
  }

  it("should answer with the message the STORE has, not the one it built", async () => {
    const { status, envelope } = await post({
      words: "The dog sitter still has not confirmed for the 14th.",
      because: "You said you would chase it and I have not seen you do it.",
    });

    expect(status).toBe(201);
    expect(envelope.success).toBe(true);
    expect(envelope.data?.role).toBe("assistant");
    expect(envelope.data?.text).toContain("dog sitter");
    // And it is really in his history, which is the whole deliverable.
    expect(deps.messages.get(envelope.data?.id ?? "")?.text).toBe(envelope.data?.text);
  });

  it("should refuse a telling with nothing in it", async () => {
    const { status, envelope } = await post({ words: "  ", because: "He asked." });

    expect(status).toBe(400);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe("VALIDATION_FAILED");
  });

  it("should refuse a telling that does not say why", async () => {
    const { status, envelope } = await post({ words: "Something I noticed." });

    expect(status).toBe(400);
    expect(envelope.error?.code).toBe("VALIDATION_FAILED");
  });
});
