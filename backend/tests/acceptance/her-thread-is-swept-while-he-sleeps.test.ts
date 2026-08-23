import { describe, expect, it, vi } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import {
  COMMANDER_CONTEXT_BUDGET_TOKENS,
  COMPACT_PROMPT,
  LaneContextSizes,
  recordLaneContext,
} from "../../src/harness/compaction.js";
import { createHeartbeatHandler } from "../../src/jobs/heartbeat-job.js";
import type { TurnResult } from "../../src/harness/session.js";
import type { JobContext } from "../../src/services/job-runner.js";

/**
 * **Her face has to be able to answer, and at 861,739 tokens it cannot.**
 *
 * `syl-chzl.4.4`. Measured on CLI 2.1.235 against the real binary, resuming his
 * real lane: first token 9,147-15,819ms at 861,739 tokens, against a 6,500ms
 * deadline inside Runway's hard 8s ceiling. Not one `face.ask.answered` line
 * existed in the whole log.
 *
 * This file is about the sweep that keeps the thread inside the budget, and
 * about the four things it must never become. Each of those has cost somebody
 * real time somewhere in this project, and the one that matters most is the
 * one the Commander ruled on himself: **nothing may reset that lane.**
 */

const TZ = "America/Chicago";
const QUIET = { start: "23:00", end: "07:00" } as const;

/** 03:07 America/Chicago — inside quiet hours, where the sweep belongs. */
const ASLEEP = Date.parse("2026-08-24T08:07:00.000Z");
/** 14:07 America/Chicago — awake, where it must not happen. */
const AWAKE = Date.parse("2026-08-24T19:07:00.000Z");

function turn(contextTokens: number): TurnResult {
  return {
    sessionId: "382a8e0d-faae-4713-ad7e-bd45aa671467",
    text: "",
    spoken: "",
    costUsd: 0,
    numTurns: 1,
    contextTokens,
    init: { kind: "init", sessionId: "s", raw: {}, model: "m", apiKeySource: "none", mcpServers: [], tools: [], capabilities: [] } as unknown as TurnResult["init"],
    events: [],
  };
}

function jobContext(now: number): JobContext {
  return {
    now,
    run: { id: "run-1" },
    job: { kind: "heartbeat" },
  } as unknown as JobContext;
}

const jobs = {
  listRuns: () => ({ items: [] }),
  list: () => ({ items: [] }),
} as unknown as Parameters<typeof createHeartbeatHandler>[0]["jobs"];

function handlerWith(opts: {
  tokens: number | undefined;
  busy?: boolean;
  ask?: (prompt: string) => Promise<TurnResult>;
}) {
  const asked: string[] = [];
  const ask = vi.fn(async (prompt: string) => {
    asked.push(prompt);
    return opts.ask ? opts.ask(prompt) : turn(8_873);
  });
  const sizes = new LaneContextSizes();
  if (opts.tokens !== undefined) sizes.record(LANES.commander, opts.tokens);
  const voice = { ask, busy: () => opts.busy ?? false };
  const handler = createHeartbeatHandler({
    voice: voice as never,
    jobs,
    tz: TZ,
    quiet: QUIET,
    contextSizes: sizes,
  });
  return { handler, asked, ask, voice, sizes };
}

const OVER = COMMANDER_CONTEXT_BUDGET_TOKENS + 1;

describe("her thread is swept while he sleeps", () => {
  it("should compact his thread when it is over budget and he is asleep", async () => {
    const { handler, asked } = handlerWith({ tokens: 861_739 });
    const result = await handler(jobContext(ASLEEP));

    expect(asked).toEqual([COMPACT_PROMPT]);
    expect(result.outcome).toBe("success");
    expect(result.summary).toMatch(/861,739/);
    expect(result.summary).toMatch(/8,873/);
  });

  it("should state what it rewrote and that nothing was deleted", async () => {
    // Constraint 4's ethos: a lossy operation states what it did. The run
    // ledger is where an operator finds out the thread was rewritten.
    const { handler } = handlerWith({ tokens: 861_739 });
    const result = await handler(jobContext(ASLEEP));
    expect(result.summary).toMatch(/861,739/);
    expect(result.summary).toMatch(/Nothing was deleted/i);
    expect(result.summary).toMatch(/transcript is unchanged on disk/i);
  });

  it("should NOT sweep again the next hour on a size the sweep made stale", async () => {
    // The defect this caught, found by measuring rather than reasoning: a
    // `/compact` turn reports NO usage, so nothing learns the new size. Left
    // alone the lane keeps its PRE-sweep size — still over budget — and
    // compacts again at 04:07, 05:07 and 06:07, each run announcing a saving
    // computed from a number that no longer describes anything.
    const { handler, asked, sizes } = handlerWith({ tokens: 861_739, ask: async () => turn(0) });

    await handler(jobContext(ASLEEP));
    expect(asked).toEqual([COMPACT_PROMPT]);
    expect(sizes.tokens(LANES.commander)).toBeUndefined();

    // The next hour: the size is unknown, so the hour takes its ORDINARY turn
    // and does not compact a second time.
    await handler(jobContext(ASLEEP + 3_600_000));
    expect(asked.filter((p) => p === COMPACT_PROMPT)).toHaveLength(1);
  });

  it("should forget the stale size even when the compaction FAILED", async () => {
    // Whatever went wrong, what we believed about the thread is now a guess.
    const { handler, sizes } = handlerWith({
      tokens: 861_739,
      ask: async () => {
        throw new Error("resume failed");
      },
    });
    await handler(jobContext(ASLEEP));
    expect(sizes.tokens(LANES.commander)).toBeUndefined();
  });

  it("should NEVER reset the lane — that would delete his conversation", async () => {
    // The Commander's ruling, 2026-08-11: every unattended turn resumes his
    // thread, so a reset here throws his conversation away. `HeartbeatVoice` is
    // `Pick<SylAgent, "ask" | "busy">` and offers no `reset` at all, which is
    // the structural half; this is the behavioural half, and it goes red if a
    // future version reaches for one.
    const reset = vi.fn();
    const { handler, voice } = handlerWith({ tokens: 861_739 });
    Object.assign(voice, { reset });
    await handler(jobContext(ASLEEP));
    expect(reset).not.toHaveBeenCalled();
  });

  it("should leave the thread alone while he is awake, however large it is", async () => {
    // Compaction measured 104,504ms. Taken in the afternoon it holds his lane —
    // and therefore his face — for nearly two minutes. This is exactly why
    // `--autocompact` was rejected: it fires on whichever turn crosses the
    // threshold, and that turn is eventually one of his.
    const { handler, asked } = handlerWith({ tokens: 861_739 });
    await handler(jobContext(AWAKE));
    expect(asked).not.toContain(COMPACT_PROMPT);
  });

  it("should stand aside rather than compact while a turn of his is on the lane", async () => {
    const { handler, asked } = handlerWith({ tokens: OVER, busy: true });
    await handler(jobContext(ASLEEP));
    expect(asked).not.toContain(COMPACT_PROMPT);
  });

  it("should not compact a thread that is within budget", async () => {
    const { handler, asked } = handlerWith({ tokens: COMMANDER_CONTEXT_BUDGET_TOKENS - 1 });
    await handler(jobContext(ASLEEP));
    expect(asked).not.toContain(COMPACT_PROMPT);
  });

  it("should not compact on a guess when no turn has reported a size", async () => {
    const { handler, asked } = handlerWith({ tokens: undefined });
    await handler(jobContext(ASLEEP));
    expect(asked).not.toContain(COMPACT_PROMPT);
  });

  it("should record a compaction that did not shrink the thread as a FAILURE", async () => {
    // Otherwise she spends 104 seconds every night achieving nothing, with a
    // green run record claiming the housekeeping is being done.
    const { handler } = handlerWith({ tokens: 861_739, ask: async () => turn(861_800) });
    const result = await handler(jobContext(ASLEEP));
    expect(result.outcome).toBe("failure");
    expect(result.error).toMatch(/did not shrink/i);
  });

  it("should survive a failed compaction without failing loudly at him", async () => {
    const { handler } = handlerWith({
      tokens: 861_739,
      ask: async () => {
        throw new Error("resume failed");
      },
    });
    const result = await handler(jobContext(ASLEEP));
    expect(result.outcome).toBe("failure");
    expect(result.spoke).toBe(false);
  });

  it("should never leave the hour unscheduled, whatever the sweep did", async () => {
    // `nextRunAt: null` writes `next_run_at = NULL` and takes the job out of
    // `due` forever — constraint 4's silent drop, arriving through housekeeping.
    for (const ask of [
      async () => turn(8_873),
      async () => {
        throw new Error("boom");
      },
    ]) {
      const { handler } = handlerWith({ tokens: 861_739, ask });
      const result = await handler(jobContext(ASLEEP));
      expect(result.nextRunAt ?? undefined).toBeUndefined();
    }
  });

  it("should learn the thread's size from every turn, warm lane included", async () => {
    // The measurement has to sit OUTSIDE the warm-lane router. His lane is the
    // warm one and the only one big enough to matter; measured round the
    // fallback instead, the sweep would never fire and nothing would say so.
    const sizes = new LaneContextSizes();
    const runner = recordLaneContext(sizes)(async () => turn(420_000));
    await runner("anything", { lane: LANES.commander });
    expect(sizes.tokens(LANES.commander)).toBe(420_000);
  });
});
