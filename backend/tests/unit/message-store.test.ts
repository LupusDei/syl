import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import {
  decodeCursor,
  encodeCursor,
  MAX_PAGE_LIMIT,
  MessageStore,
  MessageStoreError,
  stripAffectHint,
} from "../../src/services/message-store.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

let db: SylDatabase;
let now: number;
let store: MessageStore;

beforeEach(() => {
  db = testDatabase();
  now = TEST_NOW;
  store = new MessageStore({ db: db.handle, clock: () => now });
});

afterEach(() => {
  db.close();
});

/** Append `count` assistant messages, one millisecond apart. */
function fill(count: number, conversationId?: string): void {
  for (let i = 1; i <= count; i += 1) {
    now += 1;
    store.append(
      conversationId === undefined
        ? { role: "assistant", text: `message ${i}` }
        : { conversationId, role: "assistant", text: `message ${i}` },
    );
  }
}

describe("append", () => {
  it("should stamp the interactive conversation when none is named", () => {
    const result = store.append({ role: "user", text: "Remind me to call the pharmacy at 4." });

    expect(result.message.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
    expect(result.replayed).toBe(false);
  });

  it("should give the first message in a thread sequence 1", () => {
    expect(store.append({ role: "user", text: "hello" }).message.seq).toBe(1);
  });

  it("should number messages consecutively within a conversation", () => {
    fill(3);

    const seqs = store.list(INTERACTIVE_CONVERSATION_ID).items.map((m) => m.seq);
    expect(seqs).toEqual([3, 2, 1]);
  });

  it("should keep sequences independent between conversations", () => {
    // Two threads each start at 1. A shared counter would make a client's
    // "I have up to seq 40" mean different things in different threads.
    const job = store.createJobConversation("nightly consolidation");
    store.append({ role: "user", text: "in the interactive lane" });
    const inJob = store.append({ conversationId: job.id, role: "system", text: "in the job lane" });

    expect(inJob.message.seq).toBe(1);
  });

  it("should refuse a message for a conversation that does not exist", () => {
    expect(() =>
      store.append({
        conversationId: "syl:conversation:00000000-0000-7000-8000-0000000000ff",
        role: "user",
        text: "orphan",
      }),
    ).toThrow(MessageStoreError);
  });

  it("should refuse to write a message with no text", () => {
    expect(() => store.append({ role: "user", text: "   " })).toThrow(/some text/);
  });

  it("should return the stored message rather than writing a second one on a retry", () => {
    // The mobile outbox retries by design. Without this a flaky tunnel turns
    // one message into three.
    const first = store.append({ clientId: "c-1", role: "user", text: "hello" });
    now += 5_000;
    const retry = store.append({ clientId: "c-1", role: "user", text: "hello" });

    expect(retry.replayed).toBe(true);
    expect(retry.message).toEqual(first.message);
    expect(store.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(1);
  });

  it("should let the same clientId exist in two different conversations", () => {
    const job = store.createJobConversation("research");
    store.append({ clientId: "c-1", role: "user", text: "one" });

    const other = store.append({
      conversationId: job.id,
      clientId: "c-1",
      role: "user",
      text: "two",
    });

    expect(other.replayed).toBe(false);
  });

  it("should let many server-authored messages have no clientId at all", () => {
    fill(3);

    expect(store.list(INTERACTIVE_CONVERSATION_ID).items.every((m) => m.clientId === null)).toBe(
      true,
    );
  });

  it("should move the conversation's counters in step with the messages", () => {
    fill(2);

    const conversation = store.conversation(INTERACTIVE_CONVERSATION_ID);
    expect(conversation?.messageCount).toBe(2);
    expect(conversation?.lastMessageAt).toBe(new Date(now).toISOString());
    expect(conversation?.updatedAt).toBe(new Date(now).toISOString());
  });

  it("should leave the counters untouched when the write fails", () => {
    // A count that disagrees with the rows makes every client that trusts it
    // believe it is missing history.
    db.handle.exec("DROP TRIGGER messages_fts_ai");
    db.handle.exec("DROP TABLE messages_fts");
    db.handle.exec(
      "CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN SELECT raise(ABORT, 'no index'); END",
    );

    expect(() => store.append({ role: "user", text: "hello" })).toThrow();
    expect(store.conversation(INTERACTIVE_CONVERSATION_ID)?.messageCount).toBe(0);
  });

  it("should strip an affect hint before the text is ever stored", () => {
    // The marker drives the presence frame and must never cross the wire as
    // message content.
    const result = store.append({
      role: "assistant",
      text: "<!--affect: concerned 0.6-->You've moved this one twice.",
    });

    expect(result.message.text).toBe("You've moved this one twice.");
    expect(result.affect).toEqual({ state: "concerned", intensity: 0.6 });
    expect(JSON.stringify(store.list(INTERACTIVE_CONVERSATION_ID))).not.toContain("affect:");
  });

  it("should report no affect when a message carries no hint", () => {
    expect(store.append({ role: "user", text: "plain" }).affect).toBeNull();
  });
});

describe("get", () => {
  it("should return a message by id", () => {
    const appended = store.append({ role: "user", text: "hello" });

    expect(store.get(appended.message.id)).toEqual(appended.message);
  });

  it("should be null for an id that does not exist", () => {
    expect(store.get("syl:message:00000000-0000-7000-8000-0000000000ff")).toBeNull();
  });
});

describe("list", () => {
  it("should return newest first", () => {
    fill(3);

    expect(store.list(INTERACTIVE_CONVERSATION_ID).items.map((m) => m.text)).toEqual([
      "message 3",
      "message 2",
      "message 1",
    ]);
  });

  it("should report an empty page for a thread with nothing in it", () => {
    expect(store.list(INTERACTIVE_CONVERSATION_ID)).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("should page with a cursor that walks the whole thread exactly once", () => {
    fill(5);

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: ReturnType<MessageStore["list"]> = store.list(INTERACTIVE_CONVERSATION_ID, {
        limit: 2,
        cursor,
      });
      seen.push(...result.items.map((m) => m.seq));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  it("should report hasMore only while there is more", () => {
    fill(3);

    const first = store.list(INTERACTIVE_CONVERSATION_ID, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = store.list(INTERACTIVE_CONVERSATION_ID, { limit: 2, cursor: first.nextCursor });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("should not leak one conversation's messages into another's page", () => {
    const job = store.createJobConversation("research");
    fill(2);
    fill(1, job.id);

    expect(store.list(job.id).items).toHaveLength(1);
    expect(store.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(2);
  });

  it("should refuse a cursor it did not issue rather than silently starting over", () => {
    // Treating an unreadable cursor as "from the beginning" makes a paginating
    // client loop forever.
    expect(() => store.list(INTERACTIVE_CONVERSATION_ID, { cursor: "nonsense" })).toThrow(
      /cursor/,
    );
  });

  it("should refuse an unreasonable page size", () => {
    expect(() => store.list(INTERACTIVE_CONVERSATION_ID, { limit: 0 })).toThrow(/limit/);
    expect(() =>
      store.list(INTERACTIVE_CONVERSATION_ID, { limit: MAX_PAGE_LIMIT + 1 }),
    ).toThrow(/limit/);
    expect(() => store.list(INTERACTIVE_CONVERSATION_ID, { limit: 1.5 })).toThrow(/limit/);
  });
});

describe("search", () => {
  it("should find a message by a word in it", () => {
    store.append({ role: "user", text: "Remind me to call the pharmacy at 4 today." });
    now += 1;
    store.append({ role: "assistant", text: "Done — 4:00 this afternoon." });

    const found = store.search("pharmacy");

    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("pharmacy");
  });

  it("should keep the index in step when a message is deleted", () => {
    // External-content FTS5 sees nothing unless the triggers fire, and a stale
    // index reports results rather than failing.
    const appended = store.append({ role: "user", text: "pharmacy" });
    db.handle.prepare("DELETE FROM messages WHERE id = ?").run(appended.message.id);

    expect(store.search("pharmacy")).toEqual([]);
  });

  it("should keep the index in step when a message is edited", () => {
    const appended = store.append({ role: "user", text: "pharmacy" });
    db.handle.prepare("UPDATE messages SET text = ? WHERE id = ?").run(
      "greengrocer",
      appended.message.id,
    );

    expect(store.search("pharmacy")).toEqual([]);
    expect(store.search("greengrocer")).toHaveLength(1);
  });

  it("should return nothing for an empty query rather than everything", () => {
    fill(3);

    expect(store.search("   ")).toEqual([]);
  });

  it("should answer a query FTS5 cannot parse with no results, not an error", () => {
    // The caller is a person typing into a box, not a program.
    fill(1);

    expect(store.search('unbalanced "quote')).toEqual([]);
  });

  it("should not treat a query as SQL", () => {
    store.append({ role: "user", text: "pharmacy" });

    expect(() => store.search("'; DROP TABLE messages; --")).not.toThrow();
    expect(db.handle.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });
});

describe("conversations", () => {
  it("should find the interactive conversation seeded by migration 0001", () => {
    const conversation = store.conversation(INTERACTIVE_CONVERSATION_ID);

    expect(conversation?.lane).toBe("interactive");
    expect(conversation?.messageCount).toBe(0);
  });

  it("should be null for a conversation that does not exist", () => {
    expect(store.conversation("syl:conversation:00000000-0000-7000-8000-0000000000ff")).toBeNull();
  });

  it("should open a job lane with a server-assigned id", () => {
    const conversation = store.createJobConversation("nightly consolidation");

    expect(conversation.lane).toBe("job");
    expect(conversation.title).toBe("nightly consolidation");
    expect(conversation.messageCount).toBe(0);
    expect(store.conversation(conversation.id)).toEqual(conversation);
  });

  it("should list every lane, most recently touched first", () => {
    // The interactive conversation is seeded by migration 0001 with the
    // database's own `now`, which is real wall-clock time and therefore ahead
    // of the fixed test clock for most of the day. Ordering is what is under
    // test, so the new row is stamped after the seeded one rather than after
    // an instant that happens to be in the past.
    const seeded = store.conversation(INTERACTIVE_CONVERSATION_ID);
    now = Date.parse(seeded?.updatedAt ?? "") + 1_000;
    const job = store.createJobConversation("research");

    const listed = store.listConversations();

    expect(listed.items[0]?.id).toBe(job.id);
    expect(listed.items).toHaveLength(2);
  });

  it("should filter to one lane when asked", () => {
    store.createJobConversation("research");

    expect(store.listConversations({ lane: "interactive" }).items).toHaveLength(1);
    expect(store.listConversations({ lane: "job" }).items).toHaveLength(1);
  });

  it("should page conversations without repeating one", () => {
    for (let i = 0; i < 4; i += 1) {
      now += 1_000;
      store.createJobConversation(`job ${i}`);
    }

    const first = store.listConversations({ limit: 2 });
    const second = store.listConversations({ limit: 2, cursor: first.nextCursor });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    const ids = [...first.items, ...second.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("should refuse a cursor it did not issue", () => {
    expect(() => store.listConversations({ cursor: "nonsense" })).toThrow(/cursor/);
  });
});

describe("stripAffectHint", () => {
  it("should leave text with no hint alone", () => {
    expect(stripAffectHint("just words")).toEqual({ text: "just words", affect: null });
  });

  it("should read the state and intensity", () => {
    expect(stripAffectHint("<!--affect: delighted 0.9-->done").affect).toEqual({
      state: "delighted",
      intensity: 0.9,
    });
  });

  it("should default the intensity when the hint carries none", () => {
    expect(stripAffectHint("<!--affect: alert-->done").affect).toEqual({
      state: "alert",
      intensity: 1,
    });
  });

  it("should clamp an intensity outside 0..1 rather than passing it through", () => {
    // A server sending 1.4 is wrong, but a client rendering it as a scale
    // factor produces something visibly broken.
    expect(stripAffectHint("<!--affect: alert 1.4-->x").affect?.intensity).toBe(1);
    expect(stripAffectHint("<!--affect: alert -3-->x").affect?.intensity).toBe(0);
  });

  it("should remove a hint that appears mid-text", () => {
    expect(stripAffectHint("before <!--affect: idle 0.2--> after").text).toBe("before  after");
  });

  it("should still remove the marker when the intensity is malformed", () => {
    // Leaving the marker in because a number failed to parse puts the
    // machinery on screen, which is the one outcome that must not happen.
    const stripped = stripAffectHint("<!--affect: alert ...-->x");

    expect(stripped.text).toBe("x");
    expect(stripped.affect).toEqual({ state: "alert", intensity: 1 });
  });
});

describe("cursors", () => {
  it("should round-trip a sequence number", () => {
    expect(decodeCursor(encodeCursor(1283))).toBe(1283);
  });

  it("should match the shape the contract's fixture shows", () => {
    expect(encodeCursor(1283)).toBe("eyJzZXEiOjEyODN9");
  });

  it("should reject anything it did not produce", () => {
    expect(decodeCursor("nonsense")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(Buffer.from('{"seq":"x"}').toString("base64"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"seq":0}').toString("base64"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"seq":1.5}').toString("base64"))).toBeNull();
    expect(decodeCursor(Buffer.from("[1]").toString("base64"))).toBeNull();
    expect(decodeCursor(Buffer.from("null").toString("base64"))).toBeNull();
  });
});
