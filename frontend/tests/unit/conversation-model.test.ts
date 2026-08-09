import { describe, expect, it } from "vitest";

import type { Conversation, ConversationPage, Message, MessagePage, Ok } from "@syl/shared/types";

import {
  asTranscript,
  CONVERSATION_LANES,
  conversationTitle,
  filterMessages,
  hasSequenceGap,
  laneTone,
  matchesQuery,
  roleTone,
  sortConversations,
} from "../../src/features/conversations/conversation-model";
import { fixture } from "../helpers/fixtures";

const lanes: readonly Conversation[] = (fixture("http/conversations.page") as Ok<ConversationPage>)
  .data.items;
const messages: readonly Message[] = (fixture("http/messages.page") as Ok<MessagePage>).data.items;

function laneOf(kind: Conversation["lane"]): Conversation {
  const found = lanes.find((conversation) => conversation.lane === kind);
  if (found === undefined) throw new Error(`no ${kind} lane in the fixture`);
  return found;
}

describe("CONVERSATION_LANES", () => {
  it("should offer both lanes the contract defines", () => {
    expect([...CONVERSATION_LANES]).toEqual(["interactive", "job"]);
  });
});

describe("conversationTitle", () => {
  it("should name the Commander's untitled thread rather than leave it blank", () => {
    expect(conversationTitle(laneOf("interactive"))).toBe("The Commander's thread");
  });

  it("should use the title a job lane carries", () => {
    expect(conversationTitle(laneOf("job"))).toBe("Research brief: local-first sync on iOS");
  });

  it("should fall back for an untitled job lane", () => {
    expect(conversationTitle({ ...laneOf("job"), title: null })).toBe("Untitled job lane");
    expect(conversationTitle({ ...laneOf("job"), title: "" })).toBe("Untitled job lane");
  });
});

describe("laneTone and roleTone", () => {
  it("should mark the interactive lane as the one that matters most", () => {
    expect(laneTone("interactive")).toBe("accent");
    expect(laneTone("job")).toBe("muted");
  });

  it("should distinguish the three message roles", () => {
    expect(roleTone("user")).toBe("accent");
    expect(roleTone("assistant")).toBe("ok");
    expect(roleTone("system")).toBe("muted");
  });
});

describe("sortConversations", () => {
  it("should keep the Commander's thread first", () => {
    // A research run from last night must not push his own thread below the
    // fold.
    const sorted = sortConversations([laneOf("job"), laneOf("interactive")]);
    expect(sorted[0]?.lane).toBe("interactive");
  });

  it("should order job lanes by most recent activity", () => {
    const older: Conversation = {
      ...laneOf("job"),
      id: "syl:conversation:older",
      lastMessageAt: "2020-01-01T00:00:00.000Z",
    };
    expect(sortConversations([older, laneOf("job")])[0]?.id).toBe(laneOf("job").id);
  });

  it("should fall back to updatedAt when a lane has no messages", () => {
    const silent: Conversation = {
      ...laneOf("job"),
      id: "syl:conversation:silent",
      lastMessageAt: null,
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    expect(sortConversations([laneOf("job"), silent])[0]?.id).toBe(silent.id);
  });

  it("should not mutate its argument", () => {
    const original = [...lanes];
    sortConversations(lanes);
    expect(lanes).toEqual(original);
  });
});

describe("matchesQuery", () => {
  const message = messages[0] as Message;

  it("should match nothing away when the query is blank", () => {
    expect(matchesQuery(message, "")).toBe(true);
    expect(matchesQuery(message, "   ")).toBe(true);
  });

  it("should match on text, case-insensitively", () => {
    expect(matchesQuery(message, "PHARMACY")).toBe(matchesQuery(message, "pharmacy"));
  });

  it("should match on role and on id, which is what you paste from a log", () => {
    expect(matchesQuery(message, message.role)).toBe(true);
    expect(matchesQuery(message, message.id)).toBe(true);
  });

  it("should reject what it does not contain", () => {
    expect(matchesQuery(message, "zzzz-not-here")).toBe(false);
  });
});

describe("filterMessages", () => {
  it("should keep every message for a blank query", () => {
    expect(filterMessages(messages, "").length).toBe(messages.length);
  });

  it("should narrow to the matching messages", () => {
    const filtered = filterMessages(messages, "pharmacy");
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.role).toBe("user");
  });
});

describe("asTranscript", () => {
  it("should read oldest first, whatever order the page arrived in", () => {
    // The API returns newest-first by default; a transcript does not read that
    // way.
    const ordered = asTranscript(messages);
    expect(ordered[0]?.seq).toBeLessThan(ordered[ordered.length - 1]?.seq ?? 0);
  });

  it("should not mutate its argument", () => {
    const original = [...messages];
    asTranscript(messages);
    expect(messages).toEqual(original);
  });
});

describe("hasSequenceGap", () => {
  it("should see no gap in a contiguous page", () => {
    expect(hasSequenceGap(messages)).toBe(false);
  });

  it("should notice a hole in the sequence", () => {
    const first = messages[0] as Message;
    expect(hasSequenceGap([first, { ...first, id: "syl:message:x", seq: first.seq + 5 }])).toBe(true);
  });

  it("should say no gap for zero or one message", () => {
    expect(hasSequenceGap([])).toBe(false);
    expect(hasSequenceGap([messages[0] as Message])).toBe(false);
  });
});
