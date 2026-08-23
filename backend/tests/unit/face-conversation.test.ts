import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FaceConversation,
  FaceRailRefusedError,
  METERED_RAIL_LINE,
} from "../../src/face/face-conversation.js";
import { LANES, SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import type { TurnResult } from "../../src/harness/session.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import type { MessageStore } from "../../src/services/message-store.js";
import { testDatabase, testMessages } from "../helpers/service.js";

/**
 * The point of the whole attach-point argument, made into a test.
 *
 * Attaching at the LiveKit layer rather than a provider's avatar SDK was chosen
 * so the provider's model never gets the talking seat. That is a claim about
 * wiring, and wiring rots. These assertions fail when somebody re-wires it.
 */
describe("FaceConversation", () => {
  let database: SylDatabase;
  let messages: MessageStore;
  let conversations: ConversationService;
  let turns: { prompt: string; options: Record<string, unknown> }[];

  /** What the fake CLI reports back. Overridable per test. */
  let apiKeySource: string;
  let reply: string;
  let onTurn: (() => Promise<void>) | null;

  function turnResult(prompt: string): TurnResult {
    return {
      sessionId: "session-1",
      text: reply,
      spoken: reply,
      costUsd: 0,
      numTurns: 1,
      contextTokens: 0,
      init: {
        type: "system",
        subtype: "init",
        sessionId: "session-1",
        model: "claude-opus-4",
        cwd: "/tmp",
        tools: [],
        mcpServers: [],
        permissionMode: "bypassPermissions",
        apiKeySource,
        slashCommands: [],
        outputStyle: "default",
      } as unknown as TurnResult["init"],
      events: [],
      // Recorded so a test can see the prompt reached the harness unchanged.
      ...(prompt === "" ? {} : {}),
    };
  }

  beforeEach(() => {
    apiKeySource = "none";
    reply = "Two things are due before lunch.";
    onTurn = null;
    turns = [];

    database = testDatabase();
    messages = testMessages(database);

    const agent = new SylAgent({
      store: memorySessionStore(),
      runner: async (prompt: string, options): Promise<TurnResult> => {
        turns.push({ prompt, options: options as unknown as Record<string, unknown> });
        if (onTurn) await onTurn();
        return turnResult(prompt);
      },
    });

    conversations = new ConversationService({ messages, agent, log: () => undefined });
  });

  afterEach(() => {
    database.close();
  });

  function face(overrides: Partial<ConstructorParameters<typeof FaceConversation>[0]> = {}) {
    return new FaceConversation({
      conversations,
      log: () => undefined,
      ...overrides,
    });
  }

  describe("her face speaks through her, not past her", () => {
    it("should give the face what her turn said", async () => {
      const said = await face().answer({ sessionId: "rts_1", question: "What is on today?" });

      expect(said).toBe("Two things are due before lunch.");
    });

    it("should run the turn on HER OWN lane, the one SOUL.md and her memory live on", async () => {
      await face().answer({ sessionId: "rts_1", question: "What is on today?" });

      // Not a lane of the face's own. `SylAgent` appends SOUL.md and resumes
      // the commander session; a face lane would be a second Syl with no past.
      expect(turns[0]?.options["lane"]).toBe(LANES.commander);
    });

    it("should send exactly what he said, with nothing prepended by the face", async () => {
      await face().answer({ sessionId: "rts_1", question: "Did the deploy go out?" });

      expect(turns[0]?.prompt).toBe("Did the deploy go out?");
    });

    it("should tell the harness these are HIS words, so urgency rules apply", async () => {
      await face().answer({ sessionId: "rts_1", question: "Remind me at six." });

      expect(turns[0]?.options["hisWords"]).toBe(true);
    });
  });

  describe("the transcript", () => {
    it("should append BOTH halves, so what she said with her face is in one thread with the rest", async () => {
      await face().answer({ sessionId: "rts_1", question: "What is on today?" });

      // `list` answers newest first, so this reads bottom-up.
      const page = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
      expect(page.items.map((message) => [message.role, message.text])).toEqual([
        ["assistant", "Two things are due before lunch."],
        ["user", "What is on today?"],
      ]);
    });

    it("should put a face turn in the Commander's own conversation, not one of its own", async () => {
      await face().answer({ sessionId: "rts_1", question: "What is on today?" });

      const page = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
      expect(page.items).toHaveLength(2);
    });

    it("should keep the failure in the transcript too, rather than leaving a gap", async () => {
      onTurn = () => Promise.reject(new Error("the harness is wedged"));

      await expect(
        face().answer({ sessionId: "rts_1", question: "What is on today?" }),
      ).rejects.toThrow();

      const page = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
      expect(page.items).toHaveLength(2);
      expect(page.items[0]?.text).toMatch(/could not answer/i);
    });
  });

  describe("the payment rail", () => {
    it("should refuse to speak a turn that came back on the metered API", async () => {
      apiKeySource = "ANTHROPIC_API_KEY";

      await expect(
        face().answer({ sessionId: "rts_1", question: "What is on today?" }),
      ).rejects.toBeInstanceOf(FaceRailRefusedError);
    });

    it("should refuse BEFORE running a turn when the warm lane is on the wrong rail", async () => {
      const refused = face({ laneRail: () => "ANTHROPIC_API_KEY" });

      await expect(
        refused.answer({ sessionId: "rts_1", question: "What is on today?" }),
      ).rejects.toBeInstanceOf(FaceRailRefusedError);
      // Not run. Constraint 3 says a set key silently outranks the claude.ai
      // login, so the only safe thing to do with one is not to spawn.
      expect(turns).toHaveLength(0);
    });

    it("should not put anything in the transcript for a turn it refused to run", async () => {
      const refused = face({ laneRail: () => "ANTHROPIC_API_KEY" });

      await expect(refused.answer({ sessionId: "rts_1", question: "Hello?" })).rejects.toThrow();

      const page = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
      expect(page.items).toHaveLength(0);
    });

    it("should run normally when the warm lane reports the subscription rail", async () => {
      const allowed = face({ laneRail: () => "none" });

      await expect(
        allowed.answer({ sessionId: "rts_1", question: "Hello?" }),
      ).resolves.toBeTypeOf("string");
    });

    it("should run when there is no live warm process to have reported anything", async () => {
      // `undefined` is not evidence of a problem — it means the lane is cold.
      // The post-flight lock is what catches a bad rail in that case, and
      // refusing here would take her face offline whenever she is idle.
      const allowed = face({ laneRail: () => undefined });

      await expect(
        allowed.answer({ sessionId: "rts_1", question: "Hello?" }),
      ).resolves.toBeTypeOf("string");
    });

    it("should NOT refuse merely because this process has ANTHROPIC_API_KEY set", async () => {
      // `runTurn` deletes it from the child, so the parent holding one changes
      // nothing about what is billed. This assertion exists because the guard
      // was written the wrong way round first and took the face offline on
      // every machine with a key in its shell.
      const previous = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-in-the-parent";
      try {
        await expect(
          face().answer({ sessionId: "rts_1", question: "Hello?" }),
        ).resolves.toBeTypeOf("string");
      } finally {
        if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = previous;
      }
    });

    it("should name the rail in the refusal, so a log line says which one", async () => {
      apiKeySource = "temporary credentials";

      await expect(
        face().answer({ sessionId: "rts_1", question: "Hello?" }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof FaceRailRefusedError && error.apiKeySource === "temporary credentials",
      );
    });

    it("should offer something sayable for the refusal rather than a stack trace", () => {
      expect(METERED_RAIL_LINE).toMatch(/[.?!]$/);
    });
  });

  describe("one turn at a time", () => {
    it("should make a second face turn wait for the first", async () => {
      let releaseFirst: (() => void) | null = null;
      let running = 0;
      let concurrentPeak = 0;

      onTurn = async () => {
        running += 1;
        concurrentPeak = Math.max(concurrentPeak, running);
        if (releaseFirst === null) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        running -= 1;
      };

      const subject = face();
      const first = subject.answer({ sessionId: "rts_1", question: "One?" });
      const second = subject.answer({ sessionId: "rts_1", question: "Two?" });

      // Let the first turn get inside the runner.
      await vi.waitFor(() => {
        expect(releaseFirst).not.toBeNull();
      });
      (releaseFirst as unknown as () => void)();

      await Promise.all([first, second]);

      expect(concurrentPeak).toBe(1);
      expect(turns.map((turn) => turn.prompt)).toEqual(["One?", "Two?"]);
    });

    it("should serialise a face turn behind a message from his phone", async () => {
      let releaseFirst: (() => void) | null = null;
      onTurn = async () => {
        if (releaseFirst === null) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      };

      // His phone, through the ordinary fire-and-forget path.
      conversations.accept(
        conversations.append({ role: "user", text: "From the phone.", clientId: null }),
      );
      const spoken = face().answer({ sessionId: "rts_1", question: "From the face." });

      await vi.waitFor(() => {
        expect(releaseFirst).not.toBeNull();
      });
      (releaseFirst as unknown as () => void)();
      await spoken;
      await conversations.idle();

      expect(turns.map((turn) => turn.prompt)).toEqual(["From the phone.", "From the face."]);
    });
  });

  describe("a turn with nothing in it", () => {
    it("should refuse an empty question rather than spending a turn on it", async () => {
      await expect(face().answer({ sessionId: "rts_1", question: "   " })).rejects.toThrow();

      expect(turns).toHaveLength(0);
    });

    it("should report a turn that succeeded with nothing to say as a failure to the face", async () => {
      reply = "";

      await expect(face().answer({ sessionId: "rts_1", question: "Hello?" })).rejects.toThrow();
    });
  });

  describe("as an answerer", () => {
    it("should be usable directly as the ingress's FaceAnswerer", async () => {
      const answerer = face().answerer();

      await expect(answerer({ sessionId: "rts_1", question: "Hello?" })).resolves.toBe(
        "Two things are due before lunch.",
      );
    });
  });
});
