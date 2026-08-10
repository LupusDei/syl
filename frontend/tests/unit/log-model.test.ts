import type { LogEntry } from "@syl/shared/types";
import { describe, expect, it } from "vitest";

import {
  describeEntry,
  EVENT_FILTERS,
  formatFields,
  isToolCall,
  levelTone,
  LOG_LEVELS,
  startOfLocalDay,
  tallyTools,
  toolOf,
} from "../../src/features/logs/log-model";

/**
 * The judgements the logs viewer makes, without a DOM.
 *
 * The one that matters is `turn.tool`: Syl runs pre-authorised on the
 * Commander's machine, so that line is the record of what she did with the
 * permission, and every function here treats it as the primary row.
 */

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2026-08-10T13:04:00.000Z",
    level: "info",
    event: "turn.tool",
    pid: 4242,
    fields: { tool: "Bash" },
    ...overrides,
  };
}

describe("LOG_LEVELS", () => {
  it("should list every level the contract defines, in severity order", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("levelTone", () => {
  it("should make an error the loudest thing on the row", () => {
    expect(levelTone("error")).toBe("fail");
    expect(levelTone("warn")).toBe("warn");
  });

  it("should keep debug quiet, so it cannot compete with a real failure", () => {
    expect(levelTone("debug")).toBe("muted");
  });

  it("should treat info as unremarkable rather than as a problem", () => {
    expect(levelTone("info")).toBe("ok");
  });
});

describe("EVENT_FILTERS", () => {
  it("should offer tool calls first, because that is the question the view answers", () => {
    expect(EVENT_FILTERS[1]?.prefix).toBe("turn.tool");
  });

  it("should offer an unfiltered option, so nothing is permanently hidden", () => {
    expect(EVENT_FILTERS.some((filter) => filter.prefix === "")).toBe(true);
  });

  it("should use prefixes that are real event families rather than invented names", () => {
    // The contract filters on a prefix of the dotted event name. A label that
    // did not correspond to one would produce a filter that silently matches
    // nothing.
    const prefixes = EVENT_FILTERS.map((filter) => filter.prefix).filter((p) => p !== "");
    expect(prefixes).toEqual(["turn.tool", "turn", "chat", "job", "service"]);
  });

  it("should explain each one, since the difference between turn and turn.tool is not obvious", () => {
    for (const filter of EVENT_FILTERS) {
      expect(filter.summary.length).toBeGreaterThan(10);
    }
  });
});

describe("isToolCall", () => {
  it("should recognise the event that says what she did", () => {
    expect(isToolCall(entry())).toBe(true);
  });

  it("should not match the rest of the turn family", () => {
    // A prefix match here would light up `turn.start` and `turn.done` as tool
    // calls, and the tally below would count turns instead of tools.
    expect(isToolCall(entry({ event: "turn.start" }))).toBe(false);
    expect(isToolCall(entry({ event: "turn.done" }))).toBe(false);
  });

  it("should not match an unrelated event", () => {
    expect(isToolCall(entry({ event: "service.start" }))).toBe(false);
  });
});

describe("toolOf", () => {
  it("should read the tool name off a tool call", () => {
    expect(toolOf(entry({ fields: { tool: "Read" } }))).toBe("Read");
  });

  it("should be null for an event that is not a tool call", () => {
    expect(toolOf(entry({ event: "turn.done", fields: { tool: "Read" } }))).toBeNull();
  });

  it("should be null rather than a placeholder when the field is missing or wrong", () => {
    // A tool call whose tool cannot be read is a real anomaly — the logger
    // wrote a shape nothing expects. "unknown tool" would bury it among the
    // genuine ones.
    expect(toolOf(entry({ fields: {} }))).toBeNull();
    expect(toolOf(entry({ fields: { tool: "" } }))).toBeNull();
    expect(toolOf(entry({ fields: { tool: 7 } }))).toBeNull();
  });
});

describe("describeEntry", () => {
  it("should show the tool for a tool call", () => {
    expect(describeEntry(entry({ fields: { tool: "mcp__adjutant__send_message" } }))).toBe(
      "mcp__adjutant__send_message",
    );
  });

  it("should show the message for an event that carries one", () => {
    expect(
      describeEntry(entry({ event: "chat", fields: { message: "accepted a message" } })),
    ).toBe("accepted a message");
  });

  it("should fall back to the fields rather than to an empty cell", () => {
    // A viewer that shows nothing for an event it has not been taught about
    // hides the new thing, which is always the interesting thing.
    expect(describeEntry(entry({ event: "job.late", fields: { kind: "agenda", lateMs: 41000 } }))).toBe(
      "kind=agenda lateMs=41000",
    );
  });

  it("should render an empty field bag as an empty string, not as 'undefined'", () => {
    expect(describeEntry(entry({ event: "service.stop", fields: {} }))).toBe("");
  });
});

describe("formatFields", () => {
  it("should render a nested value as JSON rather than as [object Object]", () => {
    expect(formatFields({ error: { name: "Error", message: "boom" } })).toBe(
      'error={"name":"Error","message":"boom"}',
    );
  });

  it("should keep strings bare, so a message is readable", () => {
    expect(formatFields({ message: "the tunnel dropped" })).toBe("message=the tunnel dropped");
  });

  it("should render null without losing the key", () => {
    expect(formatFields({ sessionId: null })).toBe("sessionId=null");
  });
});

describe("tallyTools", () => {
  it("should count each tool, most used first", () => {
    const tally = tallyTools([
      entry({ fields: { tool: "Bash" } }),
      entry({ fields: { tool: "Read" } }),
      entry({ fields: { tool: "Bash" } }),
      entry({ fields: { tool: "Bash" } }),
    ]);

    expect(tally).toEqual([
      { tool: "Bash", count: 3 },
      { tool: "Read", count: 1 },
    ]);
  });

  it("should count nothing but tool calls", () => {
    const tally = tallyTools([
      entry({ event: "turn.start", fields: { sessionId: "abc" } }),
      entry({ event: "turn.done", fields: { turns: 4 } }),
    ]);

    expect(tally).toEqual([]);
  });

  it("should break a tie by name, so the summary line does not reshuffle on reload", () => {
    const tally = tallyTools([
      entry({ fields: { tool: "Write" } }),
      entry({ fields: { tool: "Bash" } }),
    ]);

    expect(tally.map((item) => item.tool)).toEqual(["Bash", "Write"]);
  });

  it("should be empty for an empty page rather than throwing", () => {
    expect(tallyTools([])).toEqual([]);
  });
});

describe("startOfLocalDay", () => {
  it("should return the local midnight before the given moment, as an instant", () => {
    const now = new Date(2026, 7, 10, 14, 30, 0);
    const start = startOfLocalDay(now);

    expect(new Date(start).getFullYear()).toBe(2026);
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getMinutes()).toBe(0);
    expect(start.endsWith("Z")).toBe(true);
  });

  it("should be the Commander's midnight, not UTC's", () => {
    // The failure this exists to stop: a query built from
    // `toISOString().slice(0, 10)` starts five hours late in Chicago, and the
    // records it drops are the early-morning ones — which is when the agenda
    // job runs.
    const now = new Date(2026, 7, 10, 14, 30, 0);
    const naive = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

    if (now.getTimezoneOffset() !== 0) {
      expect(startOfLocalDay(now)).not.toBe(naive);
    }
    expect(new Date(startOfLocalDay(now)).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("should never be more than a day before the given moment", () => {
    const now = new Date(2026, 7, 10, 0, 0, 1);
    const delta = now.getTime() - new Date(startOfLocalDay(now)).getTime();

    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
