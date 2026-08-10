import type { Reminder } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { TurnResult } from "../../src/harness/session.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { TOOLS } from "../../src/tools/schemas.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";
import { McpServerProcess, serversDeclaredIn, type McpToolResult } from "../helpers/mcp-client.js";

/**
 * Urgency has to be **evidence he gave**, not a field she filled in.
 *
 * `syl-j55` fixed the half that faces her: `remind_me` asks for
 * `urgentBecauseHeSaid` — his words, quoted — instead of `urgent: boolean`,
 * because a phrase can be checked against what he actually wrote and a boolean
 * cannot be checked against anything.
 *
 * **The half that enforces it does not exist**, and the obvious way to write it
 * is the wrong one. When the handler lands, `urgent: input.urgentBecauseHeSaid
 * !== undefined` is the one-liner that suggests itself, and it restores the
 * defect in full: the model satisfies a presence check by emitting any string.
 * Quoting his words is a safeguard only if something COMPARES them to what he
 * wrote. Otherwise it is a longer way of saying `true`.
 *
 * So this is declared RED against `syl-p8k`, deliberately, rather than left as
 * a note in a channel. The guard then exists **before** the handler and cannot
 * be forgotten while writing it — which is the exact shape of the failure that
 * bit us three times in one day: the check that was going to be added later.
 *
 * What it is defending is the Commander's sleep, which is the constraint most
 * likely to cost trust and the one place his anticipation order actually
 * collides with a rule. The safe answer is the default: absent, unverifiable or
 * unmatched all mean NOT urgent, and the failure mode is a reminder that waits
 * rather than a house woken at three.
 */
describe("urgency", () => {
  it("should be carried as his words rather than as her decision", () => {
    // The half that is already true, asserted so it cannot quietly revert to a
    // boolean under a later refactor. A field named for a decision invites one.
    const remind = TOOLS.find((tool) => tool.name === "remind_me");
    const properties = (remind?.inputSchema as { properties?: Record<string, { type?: string }> })
      .properties;

    expect(properties?.["urgent"], "a bare boolean is a decision, not evidence").toBeUndefined();
    expect(properties?.["urgentBecauseHeSaid"]?.type).toBe("string");
  });

  it("should reach the quiet-hours bypass only when his message actually contains those words", async () => {
    // Declared RED under `syl-p8k` and promoted when the seam landed. It named
    // the signature the seam had to have rather than describing what was there
    // — a test written against the old code would have had to be rewritten to
    // be useful, and a test that asserts the current behaviour of a known
    // defect is worse than no test at all.
    const { verifyUrgency } = (await import("../../src/harness/urgency.js")) as {
      verifyUrgency: (quoted: string | undefined, hisMessage: string) => boolean;
    };

    // He said it: the bypass is his to grant.
    expect(verifyUrgency("wake me for this", "wake me for this one, whatever the hour")).toBe(true);

    // She decided it. Every one of these is a house woken at three by something
    // nobody asked to be woken for.
    expect(verifyUrgency(undefined, "remind me about Dave's birthday")).toBe(false);
    expect(verifyUrgency("", "remind me about Dave's birthday")).toBe(false);
    expect(verifyUrgency("true", "remind me about Dave's birthday")).toBe(false);
    expect(verifyUrgency("he would want this tonight", "remind me about Dave's birthday")).toBe(false);
  });
});

/**
 * The same property, through the whole machine.
 *
 * The tests above prove the function is right. They cannot prove it is
 * **reached** — and "the check exists and nothing calls it" is a defect with
 * exactly the same shape as the one this bead was filed about. The tool server
 * is a separate process that is deliberately unable to read the conversation
 * (`AGENT_SURFACE` excludes `/conversations`, so she cannot author messages as
 * him), so his words have to travel from the service to that process, and this
 * is the only test that says they arrive.
 *
 * Real: the message he sends over HTTP, the turn, whatever the commander lane
 * was handed, the server as a spawned process, the loopback API, the store, and
 * the `urgent` column that `schedule.ts` reads to pierce quiet hours.
 * Substituted: the model, which here does the one thing this is about — it
 * claims urgency.
 */
describe("urgency, through the machine that has to enforce it", () => {
  let syl: LiveService | null = null;

  afterEach(async () => {
    await syl?.close();
    syl = null;
  });

  /** What he wrote; what she quoted. Returns the reminder that was stored. */
  async function reminderFor(
    hisMessage: string,
    quoted: string | undefined,
  ): Promise<Reminder | undefined> {
    let failure: string | null = null;

    syl = await startLiveService({
      runner: async (_prompt, options): Promise<TurnResult> => {
        const sessionId = options.sessionId ?? options.resume ?? "urgency-session";
        options.onSessionId?.(sessionId);

        try {
          const declared = options.mcpConfig;
          if (declared === undefined) throw new Error("the commander lane carried no tools");

          const [server] = serversDeclaredIn(declared);
          if (server === undefined) throw new Error("nothing was declared");

          const child = McpServerProcess.start(
            server[1].command,
            server[1].args ?? [],
            server[1].env ?? {},
          );
          try {
            await child.handshake("syl-urgency-acceptance");
            const called = (await child.request("tools/call", {
              name: "remind_me",
              arguments: {
                text: "Check the deploy.",
                when: { said: "in five minutes", kind: "relative", minutes: 5 },
                because: "He asked for it.",
                ...(quoted === undefined ? {} : { urgentBecauseHeSaid: quoted }),
              },
            })) as McpToolResult;
            if (called.isError === true) {
              throw new Error((called.content ?? []).map((block) => block.text ?? "").join("\n"));
            }
          } finally {
            child.stop();
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }

        return {
          sessionId,
          text: failure === null ? "Done." : `I could not: ${failure}`,
          // No tool call in a double, so the two are the same string.
          spoken: failure === null ? "Done." : `I could not: ${failure}`,
          costUsd: 0,
          numTurns: 1,
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

    await expectData(
      await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          clientId: "syl:message:00000000-0000-7000-8000-0000000060b1",
          text: hisMessage,
        }),
      }),
    );
    await syl.deps.chat.idle();

    expect(failure, `she could not act: ${failure ?? ""}`).toBeNull();
    const stored = await expectData<{ items: Reminder[] }>(await syl.api("/reminders"));
    return stored.items[0];
  }

  it("should honour a phrase he actually used", async () => {
    const reminder = await reminderFor(
      "Remind me in five minutes to check the deploy — wake me for this one, whatever the hour.",
      "wake me for this one",
    );

    expect(reminder?.urgent).toBe(true);
  });

  it("should refuse a phrase she made up, however plausible", async () => {
    // The failure this bead is named for, end to end: she writes the field, and
    // the reminder waits until morning anyway. `urgent: input.urgentBecauseHeSaid
    // !== undefined` is the one-liner that makes this test go red, which is
    // exactly why it is here.
    const reminder = await reminderFor(
      "Remind me in five minutes to check the deploy.",
      "he would want this tonight",
    );

    expect(reminder?.urgent).toBe(false);
  });

  it("should default to waiting when she claims nothing", async () => {
    const reminder = await reminderFor(
      "Remind me in five minutes to check the deploy.",
      undefined,
    );

    expect(reminder?.urgent).toBe(false);
  });
});
