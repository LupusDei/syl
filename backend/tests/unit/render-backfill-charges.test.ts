import { describe, expect, it } from "vitest";

import {
  applyBackfill,
  needsBackfill,
  planBackfill,
  type BackfillIo,
  type RenderChange,
} from "../../src/render/backfill-charges.js";
import type { RenderPart, RenderRecord } from "../../src/render/render-service.js";
import type { RunwayResult, RunwayTask } from "../../src/render/runway.js";

/**
 * Correcting what his old records say a render cost.
 *
 * **This tool edits his history, so the tests are mostly about what it refuses
 * to do.** The correction itself is arithmetic; the part that can hurt him is
 * writing a file, and every guard below exists because the alternative is
 * discovering afterwards that the backup was taken after the write, or that a
 * record nobody predicted was quietly "fixed".
 */

function part(overrides: Partial<RenderPart> = {}): RenderPart {
  return {
    taskId: "4b3c1a1f",
    prompt: "A luminous spirit woman of living starlight…",
    duration: 4,
    first: "renders/opening-ribbon.png",
    last: "renders/faces/unflinching.jpg",
    video: "/home/syl/renders/parts/a-1.mp4",
    credits: 120,
    charged: null,
    status: "ready",
    failureCode: null,
    failure: null,
    ...overrides,
  };
}

/** The 23 August shape: one half made and charged, one refused for nothing. */
function halfMade(overrides: Partial<RenderRecord> = {}): RenderRecord {
  return {
    name: "syl-20260823t181004073z-close-portrait",
    status: "partial",
    renderedAt: null,
    taskId: "4b3c1a1f",
    model: "seedance2_5",
    ratio: "834:1112",
    resolution: null,
    keyframes: 2,
    duration: 8,
    reference: "renders/opening-ribbon.png",
    anchor: "renders/faces/unflinching.jpg",
    framing: "close_portrait",
    prompt: "…",
    scene: "…",
    holdsLikeness: true,
    because: "…",
    startedAt: "2026-08-23T18:10:04.073Z",
    reason: "Runway ended this render as FAILED.",
    credits: 240,
    usd: 2.4,
    estimated: 240,
    video: null,
    parts: [
      part(),
      part({ taskId: "c7c678c8", video: null, status: "failed", failure: "Invalid input" }),
    ],
    ...overrides,
  };
}

/** A backend that answers with the charges the real tasks reported. */
function charges(byTask: Record<string, number | null | "gone">) {
  return async (taskId: string): Promise<RunwayResult<RunwayTask>> => {
    const answer = byTask[taskId];
    if (answer === undefined || answer === "gone") {
      return { ok: false, failure: { message: `Runway answered 404 for ${taskId}.`, retryable: false } };
    }
    return {
      ok: true,
      data: { id: taskId, status: "SUCCEEDED", output: [], failureCode: null, failure: null, charged: answer },
    };
  };
}

/** A disk in memory, which records the ORDER things happened in. */
function fakeDisk(sidecars: Record<string, string>) {
  const events: string[] = [];
  const backups = new Map<string, string>();
  const written = new Map<string, string>();
  const io: BackfillIo = {
    readSidecar: (name) => sidecars[name] ?? "",
    backup: (name, bytes) => {
      events.push(`backup:${name}`);
      backups.set(name, bytes);
      return `/backups/${name}.json`;
    },
    readBackup: (name) => backups.get(name) ?? "",
    writeSidecar: (name, bytes) => {
      events.push(`write:${name}`);
      written.set(name, bytes);
    },
  };
  return { io, events, backups, written };
}

describe("which records it is willing to touch", () => {
  it("should correct only the renders that did not finish", () => {
    // Where the rate card is KNOWN to be wrong: a generation that failed cost
    // nothing and the estimate charged him for it in full. A finished render
    // was charged very near its estimate, and rewriting forty of those is a
    // large edit to his history for no gain.
    expect(needsBackfill(halfMade({ status: "partial" }))).toBe(true);
    expect(needsBackfill(halfMade({ status: "failed" }))).toBe(true);
    expect(needsBackfill(halfMade({ status: "ready" }))).toBe(false);
    expect(needsBackfill(halfMade({ status: "rendering" }))).toBe(false);
  });
});

describe("what it would change", () => {
  it("should show the before and the after for every record it would touch", async () => {
    const plan = await planBackfill({
      records: [halfMade()],
      task: charges({ "4b3c1a1f": 120, c7c678c8: 0 }),
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [change] = plan.changes;
    // The number he was actually owed: 240 recorded, 120 charged.
    expect(change?.before).toBe(240);
    expect(change?.after).toBe(120);
    expect(change?.parts.map((one) => one.charged)).toEqual([120, 0]);
  });

  it("should ignore a generation that never reached Runway rather than asking about it", async () => {
    const never = halfMade({
      parts: [part(), part({ taskId: null, video: null, status: "failed" })],
    });

    const plan = await planBackfill({ records: [never], task: charges({ "4b3c1a1f": 120 }) });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changes[0]?.parts).toHaveLength(1);
  });

  it("should stop the whole run when a task cannot be asked about", async () => {
    // Including a task Runway no longer knows. That is a fact nobody can
    // recover, and carrying on would correct four records and leave the fifth
    // wrong while reporting success.
    const plan = await planBackfill({
      records: [halfMade()],
      task: charges({ "4b3c1a1f": 120, c7c678c8: "gone" }),
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.surprises[0]).toContain("c7c678c8");
  });

  it("should refuse to guess when Runway reports no cost at all", async () => {
    const plan = await planBackfill({
      records: [halfMade()],
      task: charges({ "4b3c1a1f": null, c7c678c8: 0 }),
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.surprises[0]).toMatch(/no cost|will not guess/iu);
  });

  it("should never overwrite a charge that was already observed", async () => {
    // A record written by the fixed code holds an observation. Replacing it
    // with a second opinion is the one thing this must never do.
    const already = halfMade({ parts: [part({ charged: 120 }), part({ taskId: "c7c678c8", charged: 0 })] });

    const plan = await planBackfill({
      records: [already],
      task: charges({ "4b3c1a1f": 999, c7c678c8: 0 }),
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.surprises[0]).toContain("already records a charge");
  });

  it("should report every surprise at once, not the first one it hits", async () => {
    const plan = await planBackfill({
      records: [halfMade()],
      task: charges({ "4b3c1a1f": "gone", c7c678c8: null }),
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.surprises).toHaveLength(2);
  });
});

describe("writing it, and the backup that has to come first", () => {
  const NAME = "syl-20260823t181004073z-close-portrait";

  function sidecarBytes(): string {
    return `${JSON.stringify(
      {
        name: NAME,
        status: "failed",
        prompt: "the prompt that must survive above all",
        scene: "…",
        credits: 240,
        usd: 2.4,
        parts: [
          { taskId: "4b3c1a1f", credits: 120, video: "/parts/a-1.mp4" },
          { taskId: "c7c678c8", credits: 120, video: null },
        ],
      },
      null,
      2,
    )}\n`;
  }

  const CHANGE: RenderChange = {
    name: NAME,
    before: 240,
    after: 120,
    parts: [
      { taskId: "4b3c1a1f", recorded: 120, charged: 120 },
      { taskId: "c7c678c8", recorded: 120, charged: 0 },
    ],
  };

  it("should copy every sidecar it will touch BEFORE it writes any of them", async () => {
    // Not "back each one up as you go". A run that died half-way would leave
    // some records corrected, some backed up, and no single place holding the
    // original of everything.
    const second: RenderChange = { ...CHANGE, name: "syl-20260823t181519158z-close-portrait" };
    const disk = fakeDisk({ [NAME]: sidecarBytes(), [second.name]: sidecarBytes() });

    const applied = applyBackfill([CHANGE, second], disk.io);

    expect(applied.ok).toBe(true);
    expect(disk.events).toEqual([
      `backup:${NAME}`,
      `backup:${second.name}`,
      `write:${NAME}`,
      `write:${second.name}`,
    ]);
  });

  it("should refuse the whole run when a backup does not read back identical", async () => {
    // THE GUARD THAT CANNOT BE SKIPPED. Without reading it back off the disk,
    // "there is a backup" is a belief rather than a fact.
    const disk = fakeDisk({ [NAME]: sidecarBytes() });
    const io: BackfillIo = { ...disk.io, readBackup: () => "something else entirely" };

    const applied = applyBackfill([CHANGE], io);

    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.refused).toMatch(/not a backup|Nothing has been written/iu);
    expect(disk.events.filter((event) => event.startsWith("write:"))).toHaveLength(0);
  });

  it("should refuse the whole run when the backup cannot be read at all", async () => {
    const disk = fakeDisk({ [NAME]: sidecarBytes() });
    const io: BackfillIo = {
      ...disk.io,
      readBackup: () => {
        throw new Error("ENOENT");
      },
    };

    const applied = applyBackfill([CHANGE], io);

    expect(applied.ok).toBe(false);
    expect(disk.events.filter((event) => event.startsWith("write:"))).toHaveLength(0);
  });

  it("should write the charge onto each half and correct the record's total", async () => {
    const disk = fakeDisk({ [NAME]: sidecarBytes() });

    applyBackfill([CHANGE], disk.io);

    const after = JSON.parse(disk.written.get(NAME) ?? "{}") as {
      credits: number;
      usd: number;
      parts: { taskId: string; charged: number }[];
    };
    expect(after.credits).toBe(120);
    expect(after.usd).toBeCloseTo(1.2, 5);
    expect(after.parts.map((one) => one.charged)).toEqual([120, 0]);
  });

  it("should carry every other field across untouched, the prompt above all", async () => {
    // The sidecar exists because eight loops were made and their prompts were
    // lost. A tool that corrected a number and cost a prompt would be a worse
    // version of the defect it is fixing.
    const disk = fakeDisk({ [NAME]: sidecarBytes() });

    applyBackfill([CHANGE], disk.io);

    const before = JSON.parse(sidecarBytes()) as Record<string, unknown>;
    const after = JSON.parse(disk.written.get(NAME) ?? "{}") as Record<string, unknown>;
    expect(after["prompt"]).toBe(before["prompt"]);
    expect(after["scene"]).toBe(before["scene"]);
    expect(after["status"]).toBe(before["status"]);
    // The halves keep their own fields; only `charged` is added.
    const half = (after["parts"] as Record<string, unknown>[])[0] ?? {};
    expect(half["video"]).toBe("/parts/a-1.mp4");
    expect(half["credits"]).toBe(120);
  });
});
