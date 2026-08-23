import { readFileSync } from "node:fs";

import type { Reminder } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { TurnOptions, TurnResult } from "../../src/harness/session.js";
import { sylHome } from "../../src/index.js";
import { fixedClock, instant } from "../../src/services/clock.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { turnFilePath } from "../../src/tools/config.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";
import { McpServerProcess, serversDeclaredIn, type McpToolResult } from "../helpers/mcp-client.js";

/**
 * **A turn nobody asked for must never be able to wake him.**
 *
 * ## What this is defending, and what nearly repealed it
 *
 * Quiet hours are the Outbox's rule: every non-urgent notification waits until
 * the window ends. Urgency is the only way past it, and `harness/urgency.ts`
 * grants urgency only when Syl quotes a phrase the Commander actually wrote —
 * checked against a file `index.ts` writes from the prompt of a turn.
 *
 * So the whole protection reduces to one question: **which turns get written
 * into that file.** For as long as her unattended turns each had a lane of
 * their own, the answer could be "the commander lane", and it was.
 *
 * Then the Commander merged the hourly self-ping, the render review and the
 * morning brief onto his lane (2026-08-11), for reasons that have nothing to do
 * with sleep: *"there will be things in the chat session that might invoke a
 * reason to send a message and how it should appear."* A lane-keyed condition
 * would have survived that merge, compiled, passed every other test — and
 * quietly made every unattended prompt evidence of something he said. She could
 * then quote the sentence she was woken with and buzz his phone at 03:00.
 *
 * Nothing in that change mentions quiet hours, which is exactly why this file
 * exists: it fails if an unattended turn can pierce them, whatever the reason.
 *
 * ## Why it is driven end to end
 *
 * The unit tests around `verifyUrgency` prove the function is right and the
 * ones around `SylAgent` prove the flag is set safely. Neither can prove the
 * chain holds, and every failure this file is about has been a chain failure —
 * a condition that stayed true of its own line while the meaning underneath it
 * moved. So this runs the real `bootstrap`, the real heartbeat job, the real
 * MCP tool server as a spawned process, the real loopback API and the real
 * store, and reads the `urgent` column that `schedule.ts` obeys.
 *
 * Substituted: the model, which here does the one thing this is about — it
 * claims urgency, quoting words that really are in its context, because they
 * are the prompt it was woken with.
 */

/** 03:07 CDT on Wednesday 12 August 2026. Inside his quiet window, deliberately. */
const SMALL_HOURS = Date.UTC(2026, 7, 12, 8, 7);

/** A phrase that really is in the heartbeat prompt. Her own words, not his. */
const FROM_HER_OWN_PROMPT = "This hour is your own";

/** What he actually wrote, and the run of it she quotes back. */
const HIS_MESSAGE =
  "Remind me in five minutes to check the deploy — wake me for this one, whatever the hour.";
const HIS_PHRASE = "wake me for this one";

describe("an unattended turn", () => {
  let syl: LiveService | null = null;

  afterEach(async () => {
    await syl?.close();
    syl = null;
  });

  /**
   * Call `remind_me` through the real tool server the turn was handed.
   *
   * Spawned from the declaration in `options.mcpConfig` rather than from a path
   * this test knows, so it exercises what the lane was really given. A turn
   * with no declaration is a failure worth seeing rather than a skip.
   */
  async function remindThrough(
    options: TurnOptions,
    text: string,
    urgentBecauseHeSaid: string,
  ): Promise<void> {
    const declared = options.mcpConfig;
    if (declared === undefined) throw new Error("the turn carried no tools");

    const [server] = serversDeclaredIn(declared);
    if (server === undefined) throw new Error("nothing was declared");

    const child = McpServerProcess.start(
      server[1].command,
      server[1].args ?? [],
      server[1].env ?? {},
    );
    try {
      await child.handshake("syl-sleep-acceptance");
      const called = (await child.request("tools/call", {
        name: "remind_me",
        arguments: {
          text,
          when: { said: "in five minutes", kind: "relative", minutes: 5 },
          because: "It seemed worth saying.",
          urgentBecauseHeSaid,
        },
      })) as McpToolResult;
      if (called.isError === true) {
        throw new Error((called.content ?? []).map((block) => block.text ?? "").join("\n"));
      }
    } finally {
      child.stop();
    }
  }

  /** A live service whose model files a reminder claiming urgency, on any turn. */
  async function bootClaimingUrgency(): Promise<{ failures: string[] }> {
    const failures: string[] = [];

    syl = await startLiveService({
      clock: fixedClock(SMALL_HOURS),
      delivery: { clock: () => SMALL_HOURS },
      runner: async (prompt, options): Promise<TurnResult> => {
        const sessionId = options.sessionId ?? options.resume ?? "sleep-session";
        options.onSessionId?.(sessionId);

        // Her hour quotes ITSELF; his message quotes HIM. Both are phrases
        // genuinely present in the turn's own context, which is the point: the
        // difference between them is not what the model can see, it is who
        // actually said it.
        const unattended = prompt.includes(FROM_HER_OWN_PROMPT);
        try {
          await remindThrough(
            options,
            unattended ? "Something she noticed at three in the morning." : "Check the deploy.",
            unattended ? FROM_HER_OWN_PROMPT : HIS_PHRASE,
          );
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }

        return {
          sessionId,
          text: "Filed.",
          spoken: "Filed.",
          costUsd: 0,
          numTurns: 1,
          contextTokens: 0,
          init: {
            kind: "init",
            sessionId,
            raw: {},
            model: "stand-in",
            apiKeySource: "none",
            mcpServers: [],
            tools: [],
            capabilities: [],
            autoMemoryPath: undefined,
          },
          events: [],
        };
      },
    });

    return { failures };
  }

  /** Run the hourly self-ping through the real job runner. */
  async function takeTheHour(service: LiveService): Promise<void> {
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(SMALL_HOURS - 1_000));
    // Concurrency is one job per tick and reminder delivery outranks a
    // background job, so a few passes are needed before this one is selected.
    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();
  }

  /** Send a message as the Commander does, over HTTP, and wait for the turn. */
  async function heSays(service: LiveService, text: string): Promise<void> {
    await expectData(
      await service.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          clientId: "syl:message:00000000-0000-7000-8000-00000000f1a1",
          text,
        }),
      }),
    );
    await service.deps.chat.idle();
  }

  it("should never win the quiet-hours bypass by quoting the prompt it was woken with", async () => {
    const { failures } = await bootClaimingUrgency();
    const service = syl;
    if (service === null) throw new Error("no service");

    // HIS TURN FIRST, as the control. Without it a green result here would be
    // indistinguishable from a broken tool path: "no reminder was urgent"
    // passes trivially if nothing could claim urgency at all.
    await heSays(service, HIS_MESSAGE);
    await takeTheHour(service);

    expect(failures, `she could not file: ${failures.join("; ")}`).toEqual([]);

    const stored = await expectData<{ items: Reminder[] }>(await service.api("/reminders"));
    const his = stored.items.find((item) => item.text === "Check the deploy.");
    const hers = stored.items.find((item) => item.text.startsWith("Something she noticed"));

    expect(his?.urgent, "his own words no longer grant the bypass at all").toBe(true);
    expect(hers?.urgent, "an unattended turn quoted itself into his bedroom").toBe(false);
  });

  it("should leave the last thing he actually said on file, rather than overwriting it", async () => {
    // The second failure the same line prevents, and the quieter one. If an
    // unattended prompt were written to that file it would also CLOBBER his
    // real message — so an urgent reminder he genuinely asked for could be
    // refused because a background turn landed in between. Constraint 4's
    // neighbour: the reminder does not vanish, it just never arrives in time.
    const { failures } = await bootClaimingUrgency();
    const service = syl;
    if (service === null) throw new Error("no service");

    await heSays(service, HIS_MESSAGE);
    await takeTheHour(service);

    expect(failures).toEqual([]);

    const home = sylHome(service.config);
    expect(home).toBeDefined();
    const recorded = readFileSync(turnFilePath(home ?? ""), "utf8");

    expect(recorded).toBe(HIS_MESSAGE);
    expect(recorded).not.toContain(FROM_HER_OWN_PROMPT);
  });
});
