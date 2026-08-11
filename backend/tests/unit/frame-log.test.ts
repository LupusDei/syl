import type { Message, WsServerChatMessage } from "@syl/shared";
import { describe, expect, it } from "vitest";

import { FrameLog } from "../../src/services/frame-log.js";

/** A message shaped like the ones the store produces. */
function message(seq: number): Message {
  return {
    id: `syl:message:0198f2c0-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    conversationId: "syl:conversation:00000000-0000-7000-8000-000000000001",
    clientId: null,
    role: "assistant",
    text: `message ${seq}`,
    createdAt: "2026-08-09T07:00:03.114Z",
    seq,
    attachments: [],
  };
}

/** Append `count` chat frames and return the log. */
function filled(count: number, capacity?: number): FrameLog {
  const log = capacity === undefined ? new FrameLog() : new FrameLog(capacity);
  for (let i = 1; i <= count; i += 1) {
    log.append({
      type: "chat_message",
      ts: "2026-08-09T07:00:03.114Z",
      message: message(i),
    } satisfies Omit<WsServerChatMessage, "seq">);
  }
  return log;
}

describe("FrameLog", () => {
  it("should refuse a capacity that cannot hold anything", () => {
    expect(() => new FrameLog(0)).toThrow(RangeError);
    expect(() => new FrameLog(-1)).toThrow(RangeError);
    expect(() => new FrameLog(1.5)).toThrow(RangeError);
  });

  it("should start at sequence zero, before anything has been issued", () => {
    expect(new FrameLog().lastSeq).toBe(0);
  });
});

describe("append", () => {
  it("should number frames from one, consecutively", () => {
    const log = new FrameLog();

    const first = log.append({ type: "chat_message", ts: "t", message: message(1) });
    const second = log.append({ type: "chat_message", ts: "t", message: message(2) });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(log.lastSeq).toBe(2);
  });

  it("should keep numbering forwards after the buffer starts discarding", () => {
    // A skip in the sequence looks exactly like a dropped frame to every
    // connected client, so eviction must not disturb the counter.
    const log = filled(10, 3);

    expect(log.lastSeq).toBe(10);
    expect(log.size).toBe(3);
    expect(log.oldestSeq).toBe(8);
  });

  it("should not mutate the frame it was given", () => {
    const log = new FrameLog();
    const frame = { type: "chat_message" as const, ts: "t", message: message(1) };

    log.append(frame);

    expect("seq" in frame).toBe(false);
  });
});

describe("since", () => {
  it("should return everything after the client's high-water mark", () => {
    const log = filled(5);

    const replay = log.since(2);

    expect(replay.frames.map((f) => f.seq)).toEqual([3, 4, 5]);
    expect(replay.fromSeq).toBe(3);
    expect(replay.toSeq).toBe(5);
    expect(replay.complete).toBe(true);
  });

  it("should return everything when the client has seen nothing", () => {
    const log = filled(3);

    expect(log.since(0).frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("should return an empty, complete range for a client that is caught up", () => {
    const log = filled(3);

    expect(log.since(3)).toEqual({ fromSeq: 4, toSeq: 3, complete: true, frames: [] });
  });

  it("should answer a client claiming a sequence we never issued without pretending", () => {
    // A client that talked to a different server lifetime. The honest answer
    // is an empty range, not a replay of everything.
    const log = filled(3);

    const replay = log.since(99);

    expect(replay.frames).toEqual([]);
    expect(replay.complete).toBe(true);
  });

  it("should report complete: false when the gap is older than the buffer remembers", () => {
    // A phone that spent a weekend in a drawer takes this path. A client that
    // is told `complete: true` here silently misses everything that aged out.
    const log = filled(10, 3);

    const replay = log.since(2);

    expect(replay.complete).toBe(false);
  });

  it("should still return what it does have when the range is incomplete", () => {
    const log = filled(10, 3);

    expect(log.since(2).frames.map((f) => f.seq)).toEqual([8, 9, 10]);
  });

  it("should call a range complete when it starts exactly at the oldest held frame", () => {
    const log = filled(10, 3);

    expect(log.oldestSeq).toBe(8);
    expect(log.since(7).complete).toBe(true);
    expect(log.since(6).complete).toBe(false);
  });

  it("should treat a truncating limit as complete, since nothing was lost", () => {
    // The client simply syncs again from toSeq. Reporting incompleteness here
    // would send it to GET /sync for no reason.
    const log = filled(10);

    const replay = log.since(0, 4);

    expect(replay.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4]);
    expect(replay.toSeq).toBe(4);
    expect(replay.complete).toBe(true);
  });

  it("should let successive limited syncs walk the whole log exactly once", () => {
    const log = filled(9);

    const seen: number[] = [];
    let cursor = 0;
    for (let round = 0; round < 10 && cursor < log.lastSeq; round += 1) {
      const replay = log.since(cursor, 4);
      seen.push(...replay.frames.map((f) => f.seq));
      cursor = replay.toSeq;
    }

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("should treat a negative sinceSeq as the beginning rather than throwing", () => {
    const log = filled(2);

    expect(log.since(-5).frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("should answer an empty log with an empty, complete range", () => {
    expect(new FrameLog().since(0)).toEqual({
      fromSeq: 1,
      toSeq: 0,
      complete: true,
      frames: [],
    });
  });
});
