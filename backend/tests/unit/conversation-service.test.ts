import type { Message } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LANES, SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import { TurnTimeoutError, type TurnOptions, type TurnResult } from "../../src/harness/session.js";
import {
  ConversationService,
  laneFor,
  turnFailureText,
} from "../../src/services/conversation-service.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import type { MessageStore } from "../../src/services/message-store.js";
import { testDatabase, testMessages } from "../helpers/service.js";

/**
 * The seam that makes Syl answer.
 *
 * `syl-vls`: `runTurn` and `SylAgent` were reachable from exactly one place in
 * the tree — `npm run ping` — so nothing in the service ever wrote a message
 * with `role: "assistant"`. This is the component that closes that gap, and the
 * three properties it has to hold are all here:
 *
 * 1. **One turn at a time per conversation.** Continuity is `--resume` against a
 *    session id stored per lane; two subprocesses resuming the same id at once
 *    interleave two halves of one transcript.
 * 2. **A failure is never silence.** A turn that throws or times out leaves a
 *    persisted message saying so. A request that vanishes is the same class of
 *    defect as a dropped reminder.
 * 3. **The reply reaches every attached client**, through the one sink both
 *    write paths publish on.
 *
 * The runner here is a double rather than `fake-claude`, deliberately: what
 * these tests are about is *ordering and failure handling around* a turn, and
 * that needs a turn whose start and finish the test controls to the
 * millisecond. The wire format and the subprocess are `session.test.ts`'s
 * business, and the end-to-end path through a real spawn is asserted in
 * `us2-he-can-talk-to-her`.
 */

const OTHER_CONVERSATION = "syl:conversation:00000000-0000-7000-8000-0000000000aa";

let db: SylDatabase;
let messages: MessageStore;
let published: Message[];
let logged: string[];

/** Collect a log line and whatever was thrown with it, as one string. */
function record(line: string, error?: unknown): void {
  logged.push(error === undefined ? line : `${line}: ${String(error)}`);
}

beforeEach(() => {
  db = testDatabase();
  messages = testMessages(db);
  published = [];
  logged = [];
});

afterEach(() => {
  db.close();
});

/** A completed turn, in the shape `runTurn` returns one. */
function result(text: string, sessionId = "session-1"): TurnResult {
  return {
    sessionId,
    text,
    costUsd: 0,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId,
      raw: {},
      model: "claude-haiku-4-5",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: [],
  };
}

/** A promise a test resolves by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Harness {
  readonly service: ConversationService;
  /** Every prompt the runner was asked, in the order it was asked. */
  readonly prompts: string[];
  /** The turns that were open at each moment a turn began. */
  readonly overlaps: number[];
  readonly presence: string[];
}

/** A service whose runner is a function the test supplies. */
function harness(
  run: (prompt: string, options: TurnOptions) => Promise<TurnResult>,
  extra: { readonly presence?: boolean } = {},
): Harness {
  const prompts: string[] = [];
  const overlaps: number[] = [];
  const presence: string[] = [];
  let inFlight = 0;

  const agent = new SylAgent({
    store: memorySessionStore(),
    runner: async (prompt, options) => {
      prompts.push(prompt);
      inFlight += 1;
      overlaps.push(inFlight);
      try {
        return await run(prompt, options);
      } finally {
        inFlight -= 1;
      }
    },
  });

  const service = new ConversationService({
    messages,
    agent,
    log: record,
    ...(extra.presence === true
      ? {
          presence: {
            turnStarted: () => presence.push("started"),
            turnEnded: () => presence.push("ended"),
            affect: (hint) => presence.push(`affect:${hint === null ? "none" : hint.state}`),
          },
        }
      : {}),
  });
  service.setSink((message) => published.push(message));

  return { service, prompts, overlaps, presence };
}

/** Append a message from the Commander and hand it to the service. */
function say(service: ConversationService, text: string, options: { conversationId?: string } = {}) {
  const appended = service.append({
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    clientId: null,
    role: "user",
    text,
  });
  service.accept(appended);
  return appended;
}

describe("laneFor", () => {
  it("should put the Commander's own thread in the commander lane", () => {
    // The lane whose transcript is the conversation, and the one `SOUL.md` and
    // every prior turn belong to.
    expect(laneFor(INTERACTIVE_CONVERSATION_ID)).toBe(LANES.commander);
  });

  it("should give every other conversation its own lane, named by its id", () => {
    // A job conversation must not interleave with the Commander's, which is the
    // whole reason lanes exist.
    expect(laneFor(OTHER_CONVERSATION)).toBe("00000000-0000-7000-8000-0000000000aa");
    expect(laneFor(OTHER_CONVERSATION)).not.toBe(laneFor(INTERACTIVE_CONVERSATION_ID));
  });

  it("should refuse to build a lane name out of path characters", () => {
    // Lane names become file names in the file-backed session store. A
    // conversation id is service-assigned and cannot look like this today, but
    // the sanitising is what keeps that from being load-bearing.
    expect(laneFor("syl:conversation:../../.ssh/id_rsa")).not.toContain("/");
    expect(laneFor("syl:conversation:...")).toBe(LANES.commander);
  });
});

describe("ConversationService", () => {
  describe("accepting what the Commander said", () => {
    it("should publish the message and answer it", async () => {
      const { service, prompts } = harness(() => Promise.resolve(result("I am here.")));

      say(service, "Syl, are you awake?");
      await service.idle();

      expect(prompts).toEqual(["Syl, are you awake?"]);

      const roles = published.map((message) => message.role);
      expect(roles).toEqual(["user", "assistant"]);
      expect(published[1]?.text).toBe("I am here.");
      // Null for anything Syl originated — the contract's own words. A client
      // reconciles an optimistic bubble by `clientId`, and there was no bubble.
      expect(published[1]?.clientId).toBeNull();

      const stored = messages.list(INTERACTIVE_CONVERSATION_ID);
      expect(stored.items.map((message) => message.role)).toEqual(["assistant", "user"]);
    });

    it("should do nothing at all for a message the store had already seen", async () => {
      // The phone's outbox retries by design. A replayed send is the same
      // message, and answering it twice is the failure that makes retrying
      // dangerous.
      const { service, prompts } = harness(() => Promise.resolve(result("Once.")));

      const first = service.append({ clientId: "c-1", role: "user", text: "Did you get that?" });
      service.accept(first);
      await service.idle();

      const replay = service.append({ clientId: "c-1", role: "user", text: "Did you get that?" });
      expect(replay.replayed).toBe(true);
      service.accept(replay);
      await service.idle();

      expect(prompts).toHaveLength(1);
      expect(published.filter((message) => message.role === "assistant")).toHaveLength(1);
    });

    it("should never answer its own answer", async () => {
      // The loop that would otherwise run forever: an assistant message is
      // published like any other and must not start a turn.
      const { service, prompts } = harness(() => Promise.resolve(result("hello")));

      service.accept(service.append({ role: "assistant", text: "Unprompted." }));
      await service.idle();

      expect(prompts).toEqual([]);
      expect(published.map((message) => message.role)).toEqual(["assistant"]);
    });

    it("should stay quiet when the turn had nothing to say", async () => {
      // "Notice, do not nag" — silence is a valid answer, and an empty message
      // is not one the store would even accept.
      const { service } = harness(() => Promise.resolve(result("   ")));

      say(service, "Anything I should know?");
      await service.idle();

      expect(published.map((message) => message.role)).toEqual(["user"]);
      expect(messages.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(1);
    });

    it("should survive a sink that throws, and still have stored the reply", async () => {
      // A socket that fails mid-write must not cost the persisted answer: the
      // client re-reads history on reconnect and the message has to be in it.
      const { service } = harness(() => Promise.resolve(result("Stored anyway.")));
      service.setSink(() => {
        throw new Error("that socket went away");
      });

      say(service, "Still there?");
      await service.idle();

      const stored = messages.list(INTERACTIVE_CONVERSATION_ID);
      expect(stored.items.map((message) => message.text)).toContain("Stored anyway.");
    });
  });

  describe("one turn at a time", () => {
    it("should never run two turns at once on the same conversation", async () => {
      // Continuity is `--resume` against one stored session id. Two subprocesses
      // resuming it at once produce one corrupted transcript.
      const gate = deferred<TurnResult>();
      const { service, prompts, overlaps } = harness((prompt) =>
        prompt === "first" ? gate.promise : Promise.resolve(result("second reply")),
      );

      say(service, "first");
      say(service, "second");

      // The second is queued behind the first, which has not returned.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prompts).toEqual(["first"]);

      gate.resolve(result("first reply"));
      await service.idle();

      expect(prompts).toEqual(["first", "second"]);
      expect(Math.max(...overlaps)).toBe(1);
      expect(published.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([
        "first reply",
        "second reply",
      ]);
    });

    it("should let two different conversations run at the same time", async () => {
      // Different lanes are different session ids and different transcripts.
      // Serialising across them would make a background job block the
      // Commander's own conversation.
      const gate = deferred<TurnResult>();
      const { service, prompts } = harness((prompt) =>
        prompt === "held" ? gate.promise : Promise.resolve(result("free")),
      );
      const job = messages.createJobConversation("a background thread");

      say(service, "held");
      say(service, "free", { conversationId: job.id });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prompts).toEqual(["held", "free"]);

      gate.resolve(result("held reply"));
      await service.idle();
    });

    it("should keep answering after a turn has failed", async () => {
      // A queue that stalls on the first rejection is a queue that answers one
      // message and then nothing, forever.
      let calls = 0;
      const { service } = harness(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(result("second"));
      });

      say(service, "one");
      await service.idle();
      say(service, "two");
      await service.idle();

      expect(calls).toBe(2);
      expect(published.at(-1)?.text).toBe("second");
    });
  });

  describe("when the turn fails", () => {
    it("should say so in the conversation rather than going quiet", async () => {
      const { service } = harness(() => Promise.reject(new Error("claude exited with code 1")));

      say(service, "What is on for today?");
      await service.idle();

      const assistant = published.filter((message) => message.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.text).toContain("claude exited with code 1");

      // And it is on disk, so the phone sees it on a cold launch too.
      const stored = messages.list(INTERACTIVE_CONVERSATION_ID);
      expect(stored.items.map((message) => message.role)).toEqual(["assistant", "user"]);
      expect(logged.join("\n")).toContain("claude exited with code 1");
    });

    it("should say something different when the turn was killed for making no progress", async () => {
      // A timeout is not "Claude said no": nothing is known about whether the
      // work happened, and the message has to leave the Commander able to tell.
      const { service } = harness(() => Promise.reject(new TurnTimeoutError(1_000, true)));

      say(service, "Take your time.");
      await service.idle();

      const assistant = published.filter((message) => message.role === "assistant");
      expect(assistant[0]?.text).toBe(turnFailureText(new TurnTimeoutError(1_000, true)));
      expect(assistant[0]?.text).not.toBe(turnFailureText(new Error("something else")));
    });

    it("should not put a wall of stack trace in the Commander's conversation", async () => {
      const { service } = harness(() => Promise.reject(new Error("x".repeat(10_000))));

      say(service, "brevity please");
      await service.idle();

      const assistant = published.filter((message) => message.role === "assistant");
      expect(assistant[0]?.text.length).toBeLessThan(1_000);
    });
  });

  describe("presence", () => {
    it("should open and close a turn around the work, in that order", async () => {
      const { service, presence } = harness(() => Promise.resolve(result("done")), {
        presence: true,
      });

      say(service, "think about it");
      await service.idle();

      expect(presence[0]).toBe("started");
      expect(presence).toContain("ended");
      expect(presence.indexOf("started")).toBeLessThan(presence.indexOf("ended"));
    });

    it("should close the turn even when it failed", async () => {
      // Otherwise one failure pins the character on `thinking` until the
      // process restarts.
      const { service, presence } = harness(() => Promise.reject(new Error("nope")), {
        presence: true,
      });

      say(service, "think about it");
      await service.idle();

      expect(presence.filter((entry) => entry === "ended")).toHaveLength(1);
    });

    it("should offer the affect hint the turn emitted", async () => {
      // The hint is stripped from the text by the store on the way in; this is
      // the one caller that can pass it on.
      const { service, presence } = harness(
        () => Promise.resolve(result("<!--affect: concerned 0.6-->That is the third late night.")),
        { presence: true },
      );

      say(service, "I am up again");
      await service.idle();

      expect(presence).toContain("affect:concerned");
      expect(published.at(-1)?.text).toBe("That is the third late night.");
    });
  });

  describe("stopping", () => {
    it("should wait for a turn that is already running", async () => {
      const gate = deferred<TurnResult>();
      const { service } = harness(() => gate.promise);

      say(service, "mid-flight");
      const closing = service.close();
      gate.resolve(result("finished during shutdown"));
      await closing;

      expect(published.at(-1)?.text).toBe("finished during shutdown");
    });

    it("should stop waiting rather than hold the process open forever", async () => {
      // launchd sends SIGKILL twenty seconds after SIGTERM. A drain that
      // outlasts that budget is a drain that guarantees being killed mid-write.
      const gate = deferred<TurnResult>();
      const wedged = new ConversationService({
        messages,
        agent: new SylAgent({ store: memorySessionStore(), runner: () => gate.promise }),
        drainTimeoutMs: 10,
        log: record,
      });
      wedged.setSink((message) => published.push(message));

      wedged.accept(wedged.append({ role: "user", text: "wedged" }));
      await wedged.close();

      expect(logged.join("\n")).toContain("still running");
      // Released so the runner's promise settles rather than leaking into the
      // next test; the service has already stopped listening for it.
      gate.resolve(result("too late"));
    });

    it("should start no new turn once it has stopped", async () => {
      const { service, prompts } = harness(() => Promise.resolve(result("ok")));
      await service.close();

      say(service, "after the end");
      await service.idle();

      expect(prompts).toEqual([]);
      // The message itself is still stored and still published — refusing to
      // answer is not a reason to lose what he said.
      expect(published.map((message) => message.role)).toEqual(["user"]);
      expect(logged.join("\n")).toContain("not answering");
    });
  });
});
