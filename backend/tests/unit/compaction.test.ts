import { describe, expect, it, vi } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import {
  COMMANDER_CONTEXT_BUDGET_TOKENS,
  COMPACT_PROMPT,
  LaneContextSizes,
  compactLane,
  describeCompaction,
  recordLaneContext,
  whyNotCompact,
} from "../../src/harness/compaction.js";
import type { TurnResult } from "../../src/harness/session.js";

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "s1",
    text: "",
    spoken: "",
    costUsd: 0,
    numTurns: 1,
    contextTokens: 0,
    init: {
      kind: "init",
      sessionId: "s1",
      raw: {},
      model: "claude-opus-5",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryDirectory: undefined,
    } as unknown as TurnResult["init"],
    events: [],
    ...overrides,
  };
}

describe("LaneContextSizes", () => {
  it("should report nothing for a lane it has never seen", () => {
    expect(new LaneContextSizes().tokens(LANES.commander)).toBeUndefined();
  });

  it("should report the context the last turn on that lane actually cost", () => {
    const sizes = new LaneContextSizes();
    sizes.record(LANES.commander, 861_739);
    expect(sizes.tokens(LANES.commander)).toBe(861_739);
  });

  it("should keep lanes apart, so the dream's size never speaks for his", () => {
    const sizes = new LaneContextSizes();
    sizes.record(LANES.commander, 800_000);
    sizes.record(LANES.consolidation, 12_000);
    expect(sizes.tokens(LANES.commander)).toBe(800_000);
    expect(sizes.tokens(LANES.consolidation)).toBe(12_000);
  });

  it("should ignore a turn that reported no context, rather than recording a zero", () => {
    const sizes = new LaneContextSizes();
    sizes.record(LANES.commander, 500_000);
    sizes.record(LANES.commander, 0);
    // A zero is "the CLI did not say", not "the thread is empty". Recording it
    // would make an over-budget lane look fresh and silently stop compaction.
    expect(sizes.tokens(LANES.commander)).toBe(500_000);
  });
});

describe("recordLaneContext", () => {
  it("should record what the turn reported, for the lane the turn was on", async () => {
    const sizes = new LaneContextSizes();
    const runner = recordLaneContext(sizes)(async () => turn({ contextTokens: 420_000 }));
    await runner("hello", { lane: LANES.commander });
    expect(sizes.tokens(LANES.commander)).toBe(420_000);
  });

  it("should pass the turn's result through untouched", async () => {
    const sizes = new LaneContextSizes();
    const result = turn({ text: "hello", contextTokens: 10 });
    const runner = recordLaneContext(sizes)(async () => result);
    expect(await runner("hi", { lane: LANES.commander })).toBe(result);
  });

  it("should record nothing for a turn that names no lane", async () => {
    const sizes = new LaneContextSizes();
    const runner = recordLaneContext(sizes)(async () => turn({ contextTokens: 99_000 }));
    await runner("hi", {});
    expect(sizes.tokens(LANES.commander)).toBeUndefined();
  });

  it("should not swallow a failing turn", async () => {
    const sizes = new LaneContextSizes();
    const runner = recordLaneContext(sizes)(async () => {
      throw new Error("claude died");
    });
    await expect(runner("hi", { lane: LANES.commander })).rejects.toThrow("claude died");
  });
});

describe("whyNotCompact", () => {
  const over = COMMANDER_CONTEXT_BUDGET_TOKENS + 1;

  it("should allow a compaction when the lane is over budget, quiet and idle", () => {
    expect(whyNotCompact({ tokens: over, inQuietHours: true, busy: false })).toBeNull();
  });

  it("should refuse while the lane is under budget", () => {
    expect(
      whyNotCompact({ tokens: COMMANDER_CONTEXT_BUDGET_TOKENS - 1, inQuietHours: true, busy: false }),
    ).toMatch(/budget/i);
  });

  it("should refuse when nothing is known about the lane's size", () => {
    // Absence routes to "do not", the safe direction: a 104-second turn is not
    // something to take on a guess.
    expect(whyNotCompact({ tokens: undefined, inQuietHours: true, busy: false })).toMatch(/not known/i);
  });

  it("should refuse OUTSIDE quiet hours however big the thread is", () => {
    // The compaction turn measured 104,504ms against the real binary. Taken in
    // the afternoon it holds his lane — and therefore his face — for nearly two
    // minutes. The whole point of scheduling it is that nobody is waiting.
    expect(whyNotCompact({ tokens: over, inQuietHours: false, busy: false })).toMatch(/quiet hours/i);
  });

  it("should refuse while a turn is already on the lane, rather than queueing behind him", () => {
    expect(whyNotCompact({ tokens: over, inQuietHours: true, busy: true })).toMatch(/busy/i);
  });
});

describe("compactLane", () => {
  it("should ask the lane to compact using the CLI's own command", async () => {
    const ask = vi.fn(async () => turn({ contextTokens: 8_873 }));
    await compactLane({ ask, before: 861_739 });
    expect(ask).toHaveBeenCalledWith(COMPACT_PROMPT);
  });

  it("should report what the thread cost before and after", async () => {
    const outcome = await compactLane({
      ask: async () => turn({ contextTokens: 8_873 }),
      before: 861_739,
    });
    expect(outcome).toMatchObject({ ok: true, before: 861_739, after: 8_873 });
  });

  it("should NOT invent an 'after' of zero when the compaction turn reports no usage", async () => {
    // MEASURED, not assumed: a `/compact` turn's result frame carries no
    // `usage` block. Read as a number, it announces a fabricated saving —
    // "861,739 → 0 tokens (861,739 saved)" — with total confidence.
    const outcome = await compactLane({ ask: async () => turn({ contextTokens: 0 }), before: 861_739 });
    expect(outcome.ok).toBe(true);
    expect(outcome.after).toBeUndefined();
  });

  it("should not call a zero-reporting compaction a failure to shrink", async () => {
    const outcome = await compactLane({ ask: async () => turn({ contextTokens: 0 }), before: 861_739 });
    expect(outcome.error).toBeNull();
  });

  it("should never reset the lane — it has no way to", async () => {
    // The one thing this must not become. Every unattended job resumes
    // `commander`; a reset there deletes the Commander's conversation, which is
    // why no `Voice` in this project offers the method. `compactLane` is handed
    // an `ask` and nothing else, so there is no reset for it to call.
    const deps = { ask: async () => turn(), before: 861_739 };
    expect(Object.keys(deps)).toEqual(["ask", "before"]);
    expect("reset" in deps).toBe(false);
  });

  it("should report a failed compaction rather than throwing at the job", async () => {
    const outcome = await compactLane({
      ask: async () => {
        throw new Error("resume failed");
      },
      before: 861_739,
    });
    expect(outcome).toMatchObject({ ok: false, before: 861_739 });
    expect(outcome.error).toMatch(/resume failed/);
  });

  it("should say so when compaction did not actually shrink the thread", async () => {
    // A compaction that ran and changed nothing must not be reported as a win:
    // the next hour would compact again, every night, forever.
    const outcome = await compactLane({
      ask: async () => turn({ contextTokens: 861_800 }),
      before: 861_739,
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.error).toMatch(/did not shrink/i);
  });
});

describe("describeCompaction", () => {
  it("should say the size is not yet known rather than claim a number it lacks", () => {
    const line = describeCompaction({ ok: true, before: 861_739, after: undefined, error: null });
    expect(line).toMatch(/861,739/);
    expect(line).not.toMatch(/0 tokens/);
    expect(line).toMatch(/does not report/i);
  });

  it("should name both numbers when it has both", () => {
    const line = describeCompaction({ ok: true, before: 861_739, after: 8_873, error: null });
    expect(line).toMatch(/852,866 saved/);
  });

  it("should always say that nothing was deleted", () => {
    const line = describeCompaction({ ok: true, before: 861_739, after: undefined, error: null });
    expect(line).toMatch(/Nothing was deleted/i);
    expect(line).toMatch(/transcript is unchanged on disk/i);
  });
});

describe("LaneContextSizes.forget", () => {
  it("should drop what it knew, so an unknown size refuses a second sweep", () => {
    const sizes = new LaneContextSizes();
    sizes.record(LANES.commander, 861_739);
    sizes.forget(LANES.commander);
    expect(sizes.tokens(LANES.commander)).toBeUndefined();
    expect(whyNotCompact({ tokens: sizes.tokens(LANES.commander), inQuietHours: true, busy: false })).toMatch(
      /not known/i,
    );
  });

  it("should leave other lanes alone", () => {
    const sizes = new LaneContextSizes();
    sizes.record(LANES.commander, 861_739);
    sizes.record(LANES.consolidation, 9_000);
    sizes.forget(LANES.commander);
    expect(sizes.tokens(LANES.consolidation)).toBe(9_000);
  });
});
