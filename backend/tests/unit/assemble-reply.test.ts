import { describe, expect, it } from "vitest";

import { assembleReply } from "../../src/harness/protocol.js";
import type { SylEvent } from "../../src/harness/protocol.js";

/**
 * What Syl actually said, versus what the CLI's `result` field carries.
 *
 * The Commander read a long reply from her that had been reduced to its closing
 * sentence, twice in one conversation, and the only reason anyone noticed is that
 * Syl read her own transcript back and said so. Nothing threw and nothing logged.
 */

function text(value: string): SylEvent {
  return { kind: "assistant_text", sessionId: "s", raw: {}, text: value } as SylEvent;
}

function toolUse(): SylEvent {
  return {
    kind: "tool_use",
    sessionId: "s",
    raw: {},
    id: "t1",
    name: "create_reminder",
    input: {},
  } as SylEvent;
}

describe("assembleReply", () => {
  it("should keep everything she said before reaching for a tool", () => {
    // THE BUG. `result` is the FINAL assistant message, not the whole answer. A turn
    // with no tool call emits one block and the two are identical, which is why this
    // was invisible until syl-009 gave her hands: the moment she could create a
    // reminder mid-answer, everything before the tool call stopped being stored.
    const events = [
      text("Three things, and one of them is time-sensitive."),
      toolUse(),
      text("Kill it if it's wrong."),
    ];

    const reply = assembleReply(events, "Kill it if it's wrong.");

    expect(reply).toBe("Three things, and one of them is time-sensitive.\n\nKill it if it's wrong.");
  });

  it("should be identical to the result when she used no tools", () => {
    // The case that hid it. Every turn before she had hands looked like this.
    const events = [text("Moved to Thursday.")];

    expect(assembleReply(events, "Moved to Thursday.")).toBe("Moved to Thursday.");
  });

  it("should fall back to the result when she said nothing at all", () => {
    // "Nothing to say" is a real outcome and one of her standing orders — notice, do
    // not nag. A turn that only used tools must not become an empty message.
    expect(assembleReply([toolUse()], "Done.")).toBe("Done.");
  });

  it("should keep her thoughts apart rather than running them together", () => {
    // Separate assistant messages are separate turns of speech. Joined without a
    // break they become one paragraph made of two thoughts.
    const reply = assembleReply([text("First."), toolUse(), text("Second.")], "Second.");

    expect(reply).toContain("First.\n\nSecond.");
  });

  it("should ignore blank prose rather than padding the reply with gaps", () => {
    expect(assembleReply([text("Real."), text("   ")], "Real.")).toBe("Real.");
  });
});
