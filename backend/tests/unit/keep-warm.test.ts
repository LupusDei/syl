import { describe, expect, it } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import { KEEP_WARM_PROMPT, createLaneWarmer, type LaneVoice } from "../../src/harness/keep-warm.js";

/**
 * `syl-chzl.2.3` — **one cheap turn, so her first sentence is not her last.**
 *
 * The lane becomes warm only BY TAKING A TURN; measured 2026-08-22, the CLI
 * emits nothing at all until a user frame arrives, so "spawn early" warms
 * nothing. Runway's `BackendRPCTool` gives up at eight seconds and a cold turn
 * has already measured 8,073ms, so a face opened on a cold lane is a face that
 * cannot answer — it is not slow, it is silent.
 *
 * Everything here is about what that turn is NOT allowed to be. It must not
 * reach him, must not spend the day's allowance that bounds how often she
 * speaks, must not leave a trace in the conversation he reads, and must stand
 * aside rather than collide with a real turn.
 */

/** A voice that records what it was asked and answers instantly. */
function voiceThat(
  options: { busy?: boolean; fail?: Error } = {},
): LaneVoice & { asked: { prompt: string; lane: string | undefined; his: boolean }[] } {
  const asked: { prompt: string; lane: string | undefined; his: boolean }[] = [];
  return {
    asked,
    ask: (prompt, lane, askOptions) => {
      asked.push({ prompt, lane, his: askOptions?.hisWords === true });
      if (options.fail) return Promise.reject(options.fail);
      return Promise.resolve({ text: "ready" });
    },
    busy: () => options.busy === true,
  };
}

describe("createLaneWarmer", () => {
  describe("when the lane is cold, which is the case it exists for", () => {
    it("should take one turn on the lane, because a lane goes warm no other way", async () => {
      const voice = voiceThat();
      const warm = createLaneWarmer({ voice, isWarm: () => false });

      await expect(warm()).resolves.toBe("warmed");
      expect(voice.asked).toHaveLength(1);
      expect(voice.asked[0]?.lane).toBe(LANES.commander);
    });

    it("should never claim the Commander said it, so it cannot buy a quiet-hours bypass", async () => {
      // `AskOptions.hisWords` is what lets a reminder pierce quiet hours by
      // quoting him. A turn taken to warm a pipe is not a thing he said, and a
      // warmer that set this could wake his house at three with its own prompt.
      const voice = voiceThat();

      await createLaneWarmer({ voice, isWarm: () => false })();

      expect(voice.asked[0]?.his).toBe(false);
    });

    it("should ask for nothing but a word back, and say so in the prompt", async () => {
      // The lane carries her real hands against her real service. A warming
      // prompt that reads like a request is a warming prompt that files a
      // reminder in his data.
      const voice = voiceThat();

      await createLaneWarmer({ voice, isWarm: () => false })();

      expect(voice.asked[0]?.prompt).toBe(KEEP_WARM_PROMPT);
      expect(KEEP_WARM_PROMPT.toLowerCase()).toContain("do not use any tool");
      expect(KEEP_WARM_PROMPT.toLowerCase()).toContain("do not");
    });
  });

  describe("when it must stand aside", () => {
    it("should take no turn at all when the lane is already warm", async () => {
      const voice = voiceThat();

      await expect(createLaneWarmer({ voice, isWarm: () => true })()).resolves.toBe("already-warm");
      expect(voice.asked).toHaveLength(0);
    });

    it("should YIELD rather than error when a real turn is already running", async () => {
      // `PersistentSession` refuses a concurrent turn with `ConcurrentTurnError`
      // — deliberately, as a bug detector rather than as backpressure. A warmer
      // that queued behind his turn would delay him for no benefit (his turn
      // warms the lane), and one that threw would turn a fine session open into
      // a failure. It stands down: the running turn is doing the warming.
      const voice = voiceThat({ busy: true });

      await expect(createLaneWarmer({ voice, isWarm: () => false })()).resolves.toBe("yielded");
      expect(voice.asked).toHaveLength(0);
    });
  });

  describe("when the turn itself fails", () => {
    it("should resolve rather than throw, so a failed warm-up never fails the open", async () => {
      // The cold gate downstream is what decides whether a face may open. This
      // is a preparation, not a gate, and a preparation that throws would turn
      // "she could not be warmed" into a 500 instead of the sentence the gate
      // already knows how to say.
      const voice = voiceThat({ fail: new Error("claude exited with code 1") });

      await expect(createLaneWarmer({ voice, isWarm: () => false })()).resolves.toBe("failed");
    });

    it("should say so where it can be read, since a silent warm-up cannot be tuned", async () => {
      const events: string[] = [];
      const voice = voiceThat({ fail: new Error("claude exited with code 1") });

      await createLaneWarmer({
        voice,
        isWarm: () => false,
        log: (event) => events.push(event),
      })();

      expect(events).toContain("lane.warm.failed");
    });
  });

  it("should warm whatever lane it was given, not only the Commander's", async () => {
    const voice = voiceThat();

    await createLaneWarmer({ voice, isWarm: () => false, lane: "agenda" })();

    expect(voice.asked[0]?.lane).toBe("agenda");
  });
});
