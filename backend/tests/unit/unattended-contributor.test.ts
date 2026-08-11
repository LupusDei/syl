import { describe, expect, it } from "vitest";

import type { JobKind, Run } from "@syl/shared";

import { composeTurnContext, MEMORY_FENCE_END } from "../../src/harness/turn-context.js";
import {
  unattendedContributor,
  UNATTENDED_CONTRIBUTOR_ID,
  UNATTENDED_HORIZON_MS,
  UNATTENDED_KINDS,
  UNATTENDED_MAX_BYTES,
} from "../../src/jobs/unattended-contributor.js";
import { instant } from "../../src/services/clock.js";

/**
 * She could not account for her own work (`syl-agd.3`).
 *
 * The Commander found a reminder at 07:04 that he had not asked for. Syl, asked
 * about it, said plainly that she had no memory of writing it — which was true:
 * the hourly turn runs on its own lane and its own session, so nothing the
 * hourly Syl does reaches the Syl he talks to.
 *
 * That is constraint 4's spirit failing inwards. Nothing she does is supposed to
 * be invisible, and here it was invisible to her. This is the record that closes
 * it: her own runs, the ones where she actually put something in front of him,
 * in his zone, bounded.
 *
 * The clock is a parameter throughout. A test that depended on the real hour
 * would pass for two days and then start failing at the horizon.
 */

const TZ = "America/Chicago";
/** 09:00 CDT on Tuesday 11 August 2026. */
const NOW = Date.UTC(2026, 7, 11, 14, 0);
const HOUR = 60 * 60_000;

function run(options: {
  readonly at: number;
  readonly kind?: JobKind;
  readonly spoke?: boolean;
  readonly summary?: string | null;
}): Run {
  const at = instant(options.at);
  return {
    id: `run-${String(options.at)}`,
    jobId: "job-1",
    kind: options.kind ?? "heartbeat",
    triggerInstant: at,
    actualInstant: at,
    latenessMs: 0,
    outcome: "success",
    spoke: options.spoke ?? true,
    turns: 1,
    costUsd: 0.01,
    // `in` rather than `??`, so a test can ask for a run that kept NO note —
    // which `??` would quietly replace with the default.
    summary: "summary" in options ? options.summary ?? null : "Filed a reminder about Dave's birthday.",
    error: null,
    attempts: 1,
    startedAt: at,
    finishedAt: at,
    steps: [],
  };
}

describe("the record of what she did unprompted", () => {
  it("should say nothing at all when she has done nothing unprompted", () => {
    // Not a blank section. A heading over emptiness reads as a record that
    // failed to load, and `composeTurnContext` would drop it anyway.
    expect(unattendedContributor([], { now: NOW, tz: TZ })).toBeUndefined();
  });

  it("should carry the hour she reached him in, in his zone", () => {
    // The 07:04 reminder, as she would have needed to see it.
    const at = Date.UTC(2026, 7, 11, 12, 4); // 07:04 CDT
    const contribution = unattendedContributor([run({ at })], { now: NOW, tz: TZ });

    expect(contribution?.text).toContain("07:04");
    expect(contribution?.text).toContain("Dave's birthday");
    expect(contribution?.text).not.toMatch(/12:04/);
  });

  it("should be her own record and say so, rather than reading as memory of him", () => {
    // It sits below the memory fence for a reason, and the words have to agree
    // with the position: this is what she DID, not something she knows about
    // him. Annexed into her memory of him it becomes a belief about his life.
    const text = unattendedContributor([run({ at: NOW - HOUR })], { now: NOW, tz: TZ })?.text ?? "";

    expect(text.toLowerCase()).toMatch(/you did|your own/);
  });

  it("should only carry the turns in which she actually did something", () => {
    // Twenty-three hours of "nothing worth saying" is not accountability, it is
    // the transcript she was given a separate lane to avoid. What he can ask
    // about is what arrived, so what she is shown is what arrived.
    const contribution = unattendedContributor(
      [
        run({ at: NOW - HOUR, spoke: false, summary: "Nothing worth saying." }),
        run({ at: NOW - 2 * HOUR, spoke: true, summary: "Set the dentist reminder." }),
      ],
      { now: NOW, tz: TZ },
    );

    expect(contribution?.text).toContain("dentist");
    expect(contribution?.text).not.toContain("Nothing worth saying");
  });

  it("should ignore anything that is not one of her unattended turns", () => {
    // Reminder delivery speaks constantly and is not something she decided to
    // do. A record of it would drown the two kinds this is actually about.
    const contribution = unattendedContributor(
      [run({ at: NOW - HOUR, kind: "reminder_delivery", summary: "Delivered 3." })],
      { now: NOW, tz: TZ },
    );

    expect(contribution).toBeUndefined();
    expect(UNATTENDED_KINDS).toContain("heartbeat");
    expect(UNATTENDED_KINDS).toContain("morning_agenda");
  });

  it("should name the morning brief and the hourly turn differently", () => {
    // "I set that at 07:04" and "that was in your morning brief" are different
    // answers, and he can only be given the right one if she can tell them
    // apart.
    const text =
      unattendedContributor(
        [
          run({ at: NOW - HOUR, kind: "heartbeat", summary: "Filed the dentist." }),
          run({ at: NOW - 2 * HOUR, kind: "morning_agenda", summary: "Composed the brief." }),
        ],
        { now: NOW, tz: TZ },
      )?.text ?? "";

    expect(text.toLowerCase()).toContain("hour");
    expect(text.toLowerCase()).toContain("brief");
  });

  it("should forget what is far enough back that he could not be asking about it", () => {
    // The horizon is what keeps this bounded in the ordinary case rather than
    // by truncation. A reminder he found this morning is hours old, not weeks.
    const contribution = unattendedContributor(
      [run({ at: NOW - UNATTENDED_HORIZON_MS - HOUR, summary: "Ancient history." })],
      { now: NOW, tz: TZ },
    );

    expect(contribution).toBeUndefined();
  });

  it("should stay inside its declared ceiling, and say what it dropped", () => {
    // The budget in `turn-context.ts` is proven over declared maxima. A
    // contributor with no ceiling turns that proof into a decoration — and a
    // busy fortnight is an injection by volume with nothing hostile in it.
    const many = Array.from({ length: 60 }, (_, index) =>
      run({
        at: NOW - index * 60_000,
        summary: `A reasonably long sentence about what she did in hour ${String(index)}, of the kind she actually writes.`,
      }),
    );

    const contribution = unattendedContributor(many, { now: NOW, tz: TZ });

    expect(contribution).toBeDefined();
    expect(Buffer.byteLength(contribution?.text ?? "", "utf8")).toBeLessThanOrEqual(
      UNATTENDED_MAX_BYTES,
    );
    // Stated rather than quiet: otherwise she reports the half she was shown as
    // everything she did, which is a more confident version of the amnesia.
    expect(contribution?.text.toLowerCase()).toMatch(/not shown|earlier/);
  });

  it("should keep the most recent, because that is what he is asking about", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      run({
        at: NOW - index * 60_000,
        summary: `Hour ${String(index)}: a reasonably long sentence about what she did, of the kind she actually writes.`,
      }),
    );

    const text = unattendedContributor(many, { now: NOW, tz: TZ })?.text ?? "";

    expect(text).toContain("Hour 0:");
    expect(text).not.toContain("Hour 59:");
  });

  it("should still record an hour that reached him but kept no note", () => {
    // `spoke` is the fact that matters. A run with no summary still happened,
    // and "I did something at 07:04 and did not write down what" is a truthful
    // answer where silence is not.
    const text =
      unattendedContributor([run({ at: NOW - HOUR, summary: null })], { now: NOW, tz: TZ })?.text ??
      "";

    expect(text).toContain("08:00");
    expect(text.toLowerCase()).toMatch(/no note|nothing recorded/);
  });

  it("should be composed below her memory of him, never inside it", () => {
    // `SOUL.md` says everything after the fence is what she knows about the
    // Commander. Her own log landing inside that region turns a record of what
    // she did into a belief about his life — `turn-context.ts`'s documented
    // failure mode, which is why this kind has its own position.
    const contribution = unattendedContributor([run({ at: NOW - HOUR })], { now: NOW, tz: TZ });
    expect(contribution).toBeDefined();

    const { systemPrompt } = composeTurnContext({
      contributors: [
        { id: "soul", kind: "identity", text: "You are Syl." },
        { id: "working-memory", kind: "memory", text: "He has a daughter." },
        ...(contribution === undefined ? [] : [contribution]),
        { id: "tools", kind: "capability", text: "You can remind him." },
      ],
    });

    const fence = systemPrompt.indexOf(MEMORY_FENCE_END);
    const record = systemPrompt.indexOf(contribution?.text ?? "");

    expect(fence).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(fence);
    // And above her tools: what she has already done frames what it means to do
    // more of it.
    expect(record).toBeLessThan(systemPrompt.indexOf("You can remind him."));
  });

  it("should answer to a name a budget report can print", () => {
    const contribution = unattendedContributor([run({ at: NOW - HOUR })], { now: NOW, tz: TZ });

    expect(contribution?.id).toBe(UNATTENDED_CONTRIBUTOR_ID);
    expect(contribution?.kind).toBe("ledger");
  });
});
