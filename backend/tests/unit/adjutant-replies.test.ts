import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InboundMessage, OutboundMessage } from "../../src/agents/adjutant-client.js";
import {
  AgentAnswers,
  correlationIdsIn,
  isCorrelationId,
  QUESTION_TTL_MS,
  refLine,
  type FleetReader,
} from "../../src/agents/answers.js";
import { MAX_REPLY_BYTES } from "../../src/agents/fencing.js";
import { RepliesSeen } from "../../src/agents/replies-seen.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { newId } from "../../src/services/id.js";
import { SylApiClient } from "../../src/tools/client.js";
import { createToolServer, type ToolContext } from "../../src/tools/server.js";
import { testDatabase, TEST_NOW } from "../helpers/service.js";

/**
 * THE RETURN LEG. `syl-j8fa.5`.
 *
 * `ask_agent` could speak and could not hear. She sent questions to the fleet
 * and, in her own words, has never received an answer — nothing routed a reply
 * back. A verb that can only speak is not a conversation, and fixing delivery
 * alone leaves her asking into a void she cannot see.
 *
 * ## The property these tests exist for
 *
 * **An answer is surfaced exactly once, and the cursor moves only for what was
 * actually surfaced.** Advancing it on READ rather than on SURFACE swallows
 * replies silently — which is the same failure class as the bug this whole epic
 * exists to fix, a system reporting success while losing the thing. It is
 * CLAUDE.md constraint 4 with a different noun.
 *
 * ## Why the shape is poll-and-stage rather than wait
 *
 * Her turns are subprocess-bounded and an answer may take minutes or hours, so
 * she must never block on one. The answer arrives on a LATER turn: `collect()`
 * reads and stages, `surface()` puts what it staged in front of her and records
 * it as shown. Those two are deliberately different moments, and every test
 * below is about the gap between them.
 */

const NOW = TEST_NOW;
const iso = (ms: number): string => new Date(ms).toISOString();

let db: SylDatabase;
let seen: RepliesSeen;

beforeEach(() => {
  db = testDatabase();
  seen = new RepliesSeen({ db: db.handle, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// A fleet she can drive by hand
// ---------------------------------------------------------------------------

interface FakeFleet extends FleetReader {
  /** What she has sent, newest last. */
  readonly outgoing: OutboundMessage[];
  /** What has been said to her, per sender. */
  readonly incoming: InboundMessage[];
  /** How many times each read path was called. */
  readonly reads: { sent: number; replies: number };
}

function fakeFleet(): FakeFleet {
  const outgoing: OutboundMessage[] = [];
  const incoming: InboundMessage[] = [];
  const reads = { sent: 0, replies: 0 };

  return {
    outgoing,
    incoming,
    reads,
    sent: async () => {
      reads.sent += 1;
      return { ok: true, data: [...outgoing] };
    },
    repliesFrom: async (who: string) => {
      reads.replies += 1;
      return { ok: true, data: incoming.filter((message) => message.from === who) };
    },
  };
}

/** A question she asked, as Adjutant recorded it. */
function question(
  fleet: FakeFleet,
  over: { to?: string; question?: string; at?: number; correlationId?: string } = {},
): string {
  const correlationId = over.correlationId ?? newId("agent_question");
  const asked = over.question ?? "What is he paying for health insurance?";
  fleet.outgoing.push({
    messageId: `out-${String(fleet.outgoing.length)}`,
    to: over.to ?? "treasurer",
    body: `${asked}\n\n${refLine(correlationId)}`,
    at: iso(over.at ?? NOW - 60_000),
    threadId: correlationId,
    metadata: { correlationId },
  });
  return correlationId;
}

/** Something an agent said to her. */
function reply(
  fleet: FakeFleet,
  over: Partial<InboundMessage> & { readonly id?: string } = {},
): InboundMessage {
  const message: InboundMessage = {
    messageId: over.id ?? over.messageId ?? `in-${String(fleet.incoming.length)}`,
    from: over.from ?? "treasurer",
    body: over.body ?? "It is $1,485 a month.",
    at: over.at ?? iso(NOW),
    ...(over.threadId === undefined ? {} : { threadId: over.threadId }),
    ...(over.metadata === undefined ? {} : { metadata: over.metadata }),
  };
  fleet.incoming.push(message);
  return message;
}

function answersOver(fleet: FakeFleet): AgentAnswers {
  return new AgentAnswers({ fleet, seen, clock: fixedClock(NOW) });
}

// ---------------------------------------------------------------------------
// What "carries one of her correlation ids" means
// ---------------------------------------------------------------------------

describe("correlationIdsIn", () => {
  const id = newId("agent_question");

  it("should find the id an agent echoed in the thread it replied on", () => {
    expect(correlationIdsIn({ body: "It is $1,485.", threadId: id })).toEqual([id]);
  });

  it("should find the id an agent passed back in metadata", () => {
    expect(correlationIdsIn({ body: "It is $1,485.", metadata: { inReplyTo: id } })).toEqual([id]);
  });

  it("should find the id quoted in the body, which is the carrier that needs nothing of anyone", () => {
    // The load-bearing one. The recipient answers the ORDINARY way — Adjutant
    // `send_message` to her name — and the only thing they ever saw of the
    // question is the text injected into their session. So the ref has to
    // survive as text, or the protocol is one only she implements.
    expect(correlationIdsIn({ body: `Re ${id}: it is $1,485 a month.` })).toEqual([id]);
  });

  it("should find nothing at all in a message that carries no id", () => {
    expect(correlationIdsIn({ body: "Are you around?" })).toEqual([]);
  });

  it("should not accept an id of some other type as a correlation id", () => {
    // `syl:reminder:...` is a real id for a real thing and it is not this. A
    // matcher that took any id would tie an answer to a question that was never
    // asked.
    expect(isCorrelationId(newId("reminder"))).toBe(false);
    expect(isCorrelationId(newId("agent_question"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The five acceptance criteria
// ---------------------------------------------------------------------------

describe("AgentAnswers — an answer finds its way back to her", () => {
  it("should surface a reply carrying a known correlation id, labelled with the question it answers", async () => {
    // "Labelled" is not decoration. An answer she cannot connect to its question
    // is nearly useless to her: she has asked several agents several things, and
    // "$1,485 a month" on its own is a number with no subject.
    const fleet = fakeFleet();
    const id = question(fleet, { question: "What is he paying for health insurance?" });
    reply(fleet, { threadId: id, body: "It is $1,485 a month." });

    const answers = answersOver(fleet);
    await answers.collect();
    const contributed = answers.surface();

    expect(contributed).toBeDefined();
    expect(contributed?.kind).toBe("reports");
    expect(contributed?.text).toContain("It is $1,485 a month.");
    expect(contributed?.text).toContain("What is he paying for health insurance?");
    expect(contributed?.text).toContain("treasurer");
  });

  it("should surface that reply ONCE, and not again on the next turn", async () => {
    const fleet = fakeFleet();
    const id = question(fleet);
    reply(fleet, { threadId: id, body: "It is $1,485 a month." });

    const answers = answersOver(fleet);
    await answers.collect();

    expect(answers.surface()?.text).toContain("$1,485");

    // A second turn. Adjutant still holds the same reply and still hands it
    // back — its read side has no cursor of its own — so "already shown" is
    // entirely ours to answer.
    await answers.collect();
    expect(answers.surface()).toBeUndefined();
  });

  it("should not mistake a DM carrying no correlation id for an answer", async () => {
    // The recipient answers the ordinary way and may quote nothing back, so an
    // unmatched DM from an agent she is waiting on is still filed against the
    // question — that is rule 4, and without it a fleet that never echoes the
    // ref leaves her back in the void.
    //
    // What must NOT happen is that a guess is relayed as a fact. Presenting
    // somebody's passing remark as the treasurer's answer about the Commander's
    // money is a false confirmation, which is the defect this epic is about.
    const fleet = fakeFleet();
    question(fleet, { question: "What is he paying for health insurance?" });
    reply(fleet, { body: "Morning. Anything you need from me today?" });

    const answers = answersOver(fleet);
    await answers.collect();
    const contributed = answers.surface();

    expect(contributed?.text).toContain("Morning. Anything you need");
    expect(contributed?.text).toContain("DID NOT SAY WHICH QUESTION");
    expect(contributed?.text).not.toMatch(/, answering what you asked/u);
    // And she is still waiting: nothing has told her the question was addressed.
    expect(answers.outstanding().map((q) => q.question)).toEqual([
      "What is he paying for health insurance?",
    ]);
  });

  it("should not surface a DM from an agent it is not waiting on as an answer at all", async () => {
    // There is nothing to attach it to. Rule 4 is a guess between her own
    // outstanding questions, not a licence to call any message an answer.
    const fleet = fakeFleet();
    const id = question(fleet, { to: "raynor" });
    reply(fleet, { from: "raynor", threadId: id, body: "Done." });
    reply(fleet, { from: "raynor", body: "Also, unrelated: nice weather." });

    const answers = answersOver(fleet);
    await answers.collect();

    const contributed = answers.surface();
    expect(contributed?.text).toContain("Done.");
    expect(contributed?.text).not.toContain("nice weather");
  });

  it("should file an unmatched reply against the most recent question asked before it arrived", async () => {
    const fleet = fakeFleet();
    question(fleet, { question: "What did the roof cost?", at: NOW - 3 * 60_000 });
    question(fleet, { question: "And the gutters?", at: NOW - 2 * 60_000 });
    // Asked AFTER the reply landed, so it cannot be what the reply is about.
    question(fleet, { question: "One more thing.", at: NOW + 60_000 });
    reply(fleet, { body: "About nine thousand.", at: iso(NOW) });

    const answers = answersOver(fleet);
    await answers.collect();

    const text = answers.surface()?.text ?? "";
    expect(text).toContain("And the gutters?");
    expect(text).not.toContain("One more thing.");
  });

  it("should say how many other questions were outstanding when it guessed", async () => {
    // THE AMBIGUOUS CASE, named rather than hidden. Two questions to one agent
    // and a reply that says which one it answers is a coin toss — so she is
    // told it was one, and how many others it might have been.
    const fleet = fakeFleet();
    question(fleet, { question: "What did the roof cost?", at: NOW - 3 * 60_000 });
    question(fleet, { question: "And the gutters?", at: NOW - 2 * 60_000 });
    reply(fleet, { body: "About nine thousand.", at: iso(NOW) });

    const answers = answersOver(fleet);
    await answers.collect();

    expect(answers.surface()?.text).toMatch(/1 other question is outstanding/u);
  });

  it("should keep both questions outstanding when a reply only guessed at one of them", async () => {
    const fleet = fakeFleet();
    question(fleet, { question: "What did the roof cost?", at: NOW - 3 * 60_000 });
    question(fleet, { question: "And the gutters?", at: NOW - 2 * 60_000 });
    reply(fleet, { body: "About nine thousand.", at: iso(NOW) });

    const answers = answersOver(fleet);
    await answers.collect();
    answers.surface();

    expect(answers.outstanding()).toHaveLength(2);
  });

  it("should prefer the id the agent actually quoted over the question it would have guessed", async () => {
    // Rules 1-3 are facts and rule 4 is a guess. A reply that says which
    // question it answers must never be overruled by recency.
    const fleet = fakeFleet();
    const roof = question(fleet, { question: "What did the roof cost?", at: NOW - 3 * 60_000 });
    question(fleet, { question: "And the gutters?", at: NOW - 2 * 60_000 });
    reply(fleet, { body: `About nine thousand. ${roof}`, at: iso(NOW) });

    const answers = answersOver(fleet);
    await answers.collect();

    const text = answers.surface()?.text ?? "";
    expect(text).toContain("answering what you asked them");
    expect(text).toContain("What did the roof cost?");
  });

  it("should surface a reply that arrived while a turn was in flight on the NEXT turn, not lose it", async () => {
    // The whole shape of the verb. She does not block: a turn composes from what
    // has already been staged, and anything that lands mid-turn is waiting for
    // the turn after. What must never happen is that it lands in the gap and is
    // gone.
    const fleet = fakeFleet();
    const id = question(fleet);

    const answers = answersOver(fleet);
    await answers.collect();
    // Turn one: nothing has been said yet.
    expect(answers.surface()).toBeUndefined();

    // ... and the treasurer answers while turn one is still running.
    reply(fleet, { threadId: id, body: "It is $1,485 a month." });

    await answers.collect();
    expect(answers.surface()?.text).toContain("$1,485");
  });

  it("should leave the cursor exactly where it was for a message it read but did not surface", async () => {
    // THE CORRECTNESS RISK, stated as a test. Advancing on read rather than on
    // surface silently swallows replies — a system reporting success while
    // losing the thing, which is the bug this whole epic exists to fix.
    const fleet = fakeFleet();
    const id = question(fleet, { at: NOW - 120_000 });
    // Answered, plainly, with the ref quoted back — so this one IS surfaced and
    // nothing is outstanding with the treasurer afterwards.
    reply(fleet, { id: "in-answer", threadId: id, body: "It is $1,485 a month.", at: iso(NOW - 60_000) });
    // And then they say something else, which answers nothing and is READ on
    // every single poll from now until Adjutant forgets it.
    reply(fleet, { id: "in-chatter", body: "Morning. Anything you need?", at: iso(NOW) });

    const answers = answersOver(fleet);
    await answers.collect();
    answers.surface();

    // The ledger IS the cursor here — `RepliesSeen.lastFrom` derives it rather
    // than mutating a watermark, precisely so that reading cannot move it. A
    // watermark would now sit at the chatter, which is LATER than the answer,
    // and the next real answer stamped in between would be swallowed.
    expect(seen.lastFrom("treasurer")?.messageId).toBe("in-answer");
    expect(seen.unseen([{ messageId: "in-chatter", from: "treasurer", at: iso(NOW) }])).toHaveLength(
      1,
    );

    // And reading it again, on turn after turn, still does not move anything.
    await answers.collect();
    expect(answers.surface()).toBeUndefined();
    expect(seen.unseen([{ messageId: "in-chatter", from: "treasurer", at: iso(NOW) }])).toHaveLength(
      1,
    );
  });

  it("should not record an answer there was no room to show her this turn", async () => {
    // The same failure one layer in. `replyContributor` drops the oldest answers
    // when they do not all fit and SAYS SO — "nothing has been lost" is a
    // promise, and recording a dropped answer as seen is how it becomes a lie.
    const fleet = fakeFleet();
    const older = question(fleet, { question: "What did the roof cost?" });
    const newer = question(fleet, { question: "What is the insurance?" });
    reply(fleet, {
      id: "in-older",
      threadId: older,
      body: "a".repeat(MAX_REPLY_BYTES),
      at: iso(NOW - 30_000),
    });
    reply(fleet, {
      id: "in-newer",
      threadId: newer,
      body: "b".repeat(MAX_REPLY_BYTES),
      at: iso(NOW),
    });

    const answers = answersOver(fleet);
    await answers.collect();
    const contributed = answers.surface();

    expect(contributed?.kept.map((kept) => kept.body[0])).toEqual(["b"]);
    // The one that did not fit is still owed to her, so the ledger must not
    // claim she has seen it.
    expect(seen.unseen([{ messageId: "in-older", from: "treasurer", at: iso(NOW - 30_000) }])).toHaveLength(1);

    // And it arrives on the turn after, which is what "nothing has been lost"
    // has to mean.
    expect(answers.surface()?.text).toContain("a".repeat(50));
  });
});

// ---------------------------------------------------------------------------
// How long an unanswered question stays worth surfacing
// ---------------------------------------------------------------------------

describe("AgentAnswers — how long a question stays outstanding", () => {
  it("should count a question she asked yesterday as still outstanding", async () => {
    const fleet = fakeFleet();
    question(fleet, { at: NOW - 24 * 60 * 60 * 1000 });

    const answers = answersOver(fleet);
    await answers.collect();

    expect(answers.outstanding().map((q) => q.who)).toEqual(["treasurer"]);
  });

  it("should stop counting a question as outstanding once the expiry has passed", async () => {
    const fleet = fakeFleet();
    question(fleet, { at: NOW - QUESTION_TTL_MS - 1 });

    const answers = answersOver(fleet);
    await answers.collect();

    expect(answers.outstanding()).toEqual([]);
  });

  it("should still recognise an answer to a question older than the expiry, rather than dropping it", async () => {
    // Expiry DEMOTES, it does not delete — the same instinct as CLAUDE.md
    // constraints 4 and 6. It decides when she stops WAITING; it never decides
    // when she stops HEARING. An answer that took nine days is still an answer,
    // and the alternative is a reply that vanishes with nothing reporting it.
    const fleet = fakeFleet();
    const id = question(fleet, { at: NOW - QUESTION_TTL_MS - 1 });
    reply(fleet, { threadId: id, body: "Sorry — it is $1,485 a month." });

    const answers = answersOver(fleet);
    await answers.collect();

    expect(answers.surface()?.text).toContain("$1,485");
  });

  it("should stop counting a question as outstanding once it has been answered", async () => {
    const fleet = fakeFleet();
    const id = question(fleet);
    reply(fleet, { threadId: id, body: "It is $1,485 a month." });

    const answers = answersOver(fleet);
    await answers.collect();

    expect(answers.outstanding()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading is a thing that can fail, and failing must not lose anything
// ---------------------------------------------------------------------------

describe("AgentAnswers.collect — when the fleet is not answering", () => {
  it("should keep what it had already staged when a poll fails", async () => {
    const fleet = fakeFleet();
    const id = question(fleet);
    reply(fleet, { threadId: id, body: "It is $1,485 a month." });

    const answers = answersOver(fleet);
    await answers.collect();

    const broken: FleetReader = {
      sent: async () => ({
        ok: false,
        failure: {
          kind: "unreachable",
          operation: "read what she sent",
          message: "Adjutant is not answering.",
          retryable: true,
        },
      }),
      repliesFrom: fleet.repliesFrom.bind(fleet),
    };
    const stubborn = new AgentAnswers({
      fleet: broken,
      seen,
      clock: fixedClock(NOW),
    });
    // A fresh object has staged nothing, so this asserts the weaker half: a
    // failed read is a failure, never an empty success that looks like "nobody
    // answered".
    expect(await stubborn.collect()).toBe(0);

    // The object that HAD staged something still has it after a failed poll.
    await answers.collect();
    expect(answers.surface()?.text).toContain("$1,485");
  });

  it("should never throw out of collect, whatever the fleet does", async () => {
    const exploding: FleetReader = {
      sent: async () => {
        throw new Error("the socket died");
      },
      repliesFrom: async () => {
        throw new Error("the socket died");
      },
    };
    const answers = new AgentAnswers({
      fleet: exploding,
      seen,
      clock: fixedClock(NOW),
    });

    // Reading the fleet is background work on her turn path. A throw here
    // reaches the Commander as a turn that failed for a reason that has nothing
    // to do with what he asked.
    await expect(answers.collect()).resolves.toBe(0);
  });

  it("should not run two collections at once when refresh is called from every turn", async () => {
    const fleet = fakeFleet();
    question(fleet);

    const answers = answersOver(fleet);
    const both = Promise.all([answers.refresh(), answers.refresh()]);
    await both;

    // One in flight at a time. `refresh` is fired from the turn path without
    // being awaited, and a turn taken every minute must not stack up polls
    // against a service on the same machine.
    expect(fleet.reads.sent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The send half: a question that can be answered has to say which question it is
// ---------------------------------------------------------------------------

describe("ask_agent — stamping a question so an answer can find its way home", () => {
  interface Send {
    readonly who: string;
    readonly body: string;
    readonly options?: unknown;
  }

  const askContext = (sends: Send[]): ToolContext => ({
    client: new SylApiClient({
      baseUrl: "http://127.0.0.1:8888/api/v1",
      token: "test-token",
      fetch: () => {
        throw new Error("ask_agent must not touch Syl's own API.");
      },
    }),
    tz: "America/Chicago",
    hisMessage: () => "",
    fleet: {
      ask: async (who: string, body: string, options?: unknown) => {
        sends.push({ who, body, ...(options === undefined ? {} : { options }) });
        return { ok: true as const, data: { messageId: "msg-1", at: iso(NOW) } };
      },
      // Nothing asked yet, so the ask budget (`syl-014.3.5`) is untouched and
      // these tests are about the stamping alone.
      sent: async () => ({ ok: true as const, data: [] }),
    } as unknown as ToolContext["fleet"],
  });

  const ask = async (context: ToolContext): Promise<Record<string, unknown>> => {
    const answered = await createToolServer(context).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_agent",
        arguments: {
          who: "treasurer",
          question: "What is he paying for health insurance?",
          because: "He asked me to find out.",
        },
      },
    });
    const result = answered?.result as { content: { text: string }[] };
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  };

  it("should put a correlation id in the TEXT, the only carrier the recipient ever sees", async () => {
    // Adjutant injects the message BODY into the recipient's session. A thread
    // id they never see is a thread id they cannot echo, so a protocol resting
    // on it alone is one only she implements — and the point of this design is
    // that the recipient answers the ordinary way, with nothing asked of them.
    const sends: Send[] = [];
    await ask(askContext(sends));

    expect(sends).toHaveLength(1);
    const body = sends[0]?.body ?? "";
    expect(body).toContain("What is he paying for health insurance?");
    expect(correlationIdsIn({ body })).toHaveLength(1);
  });

  it("should carry the same id on the thread and in metadata, for a client that keeps them", async () => {
    const sends: Send[] = [];
    await ask(askContext(sends));

    const body = sends[0]?.body ?? "";
    const [id] = correlationIdsIn({ body });
    const options = sends[0]?.options as {
      readonly threadId?: string;
      readonly metadata?: Record<string, unknown>;
    };

    expect(options.threadId).toBe(id);
    expect(correlationIdsIn({ body: "", metadata: options.metadata })).toEqual([id]);
  });

  it("should tell her which question she asked, so she can recognise the answer when it comes", async () => {
    const sends: Send[] = [];
    const envelope = await ask(askContext(sends));

    const subject = envelope["subject"] as Record<string, unknown>;
    expect(isCorrelationId(String(subject["correlationId"]))).toBe(true);
    // Still not an answer. Nothing has been answered, and a verb that implied
    // otherwise would have her telling him the treasurer said something.
    expect(subject["answer"]).toBeUndefined();
  });
});
