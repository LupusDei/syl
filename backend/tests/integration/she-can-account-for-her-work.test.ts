import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Job } from "@syl/shared";

import { LANES } from "../../src/harness/agent.js";
import type { TurnOptions } from "../../src/harness/session.js";
import { bootstrap } from "../../src/index.js";
import { fixedClock, instant } from "../../src/services/clock.js";
import type { JobStore } from "../../src/services/job-store.js";
import { silentRunner, testConfig } from "../helpers/service.js";

/**
 * She can account for her own work (`syl-agd.3`).
 *
 * The Commander found a reminder at 07:04 he had not asked for, asked Syl about
 * it, and she said honestly that she had no memory of writing it. She was right:
 * the hourly turn runs on `LANES.heartbeat` with its own session, and nothing on
 * that lane had ever reached the lane he talks to.
 *
 * `unattended-contributor.test.ts` covers the record's shape. What only the
 * assembly can answer is whether the lane he talks to is actually handed it, and
 * whether the lanes that are NOT him are left alone — so this drives the real
 * `bootstrap`, on a real home, and reads the system prompt each lane carried.
 *
 * The clock is injected. A test that used the real one would place the 07:04
 * run relative to today and start failing at the horizon two days later.
 */

/** 09:00 CDT on Tuesday 11 August 2026. */
const NOW = Date.UTC(2026, 7, 11, 14, 0);
/** 07:04 CDT the same morning: the hour he asked about. */
const THE_HOUR_HE_ASKED_ABOUT = Date.UTC(2026, 7, 11, 12, 4);

const temps: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Booted {
  readonly jobs: JobStore;
  /** Take a turn on `lane` and hand back the options it carried. */
  ask(lane: string): Promise<TurnOptions>;
}

function boot(): Booted {
  const home = mkdtempSync(join(tmpdir(), "syl-account-"));
  temps.push(home);

  let last: TurnOptions | undefined;
  const built = bootstrap(testConfig({ databasePath: join(home, "syl.db") }), {
    clock: fixedClock(NOW),
    runner: (prompt, options) => {
      last = options;
      return silentRunner(prompt, options);
    },
  });
  closers.push(() => built.database.close());

  return {
    jobs: built.deps.jobs,
    ask: async (lane) => {
      await built.agent.ask("did you make this?", lane);
      return last ?? {};
    },
  };
}

/** An hour of hers that reached him, recorded the way the handler records one. */
function anHourSheReachedHimIn(jobs: JobStore, at: number, said: string): void {
  const job: Job = jobs.define({
    kind: "heartbeat",
    priority: "background",
    trigger: { type: "interval", intervalMs: 60 * 60_000, tz: "America/Chicago" },
    deliveryClass: "at_most_once",
    catchUp: { policy: "skip" },
    budget: { maxTurns: 1, maxWallClockMs: 60_000, allowedTools: [] },
    speaks: true,
  });
  const run = jobs.startRun(job, instant(at), at);
  jobs.finishRun(run.id, { outcome: "success", spoke: true, summary: said });
}

describe("what she did while nobody was watching", () => {
  it("should give the lane he talks to the hour he is asking about", async () => {
    const booted = boot();
    anHourSheReachedHimIn(
      booted.jobs,
      THE_HOUR_HE_ASKED_ABOUT,
      "Filed a reminder about the dentist — he mentioned it in March.",
    );

    const options = await booted.ask(LANES.commander);

    expect(options.systemPrompt ?? "").toContain("07:04");
    expect(options.systemPrompt ?? "").toContain("dentist");
  });

  it("should say nothing at all when she has done nothing unprompted", async () => {
    // The ordinary state of a new install. A heading over emptiness reads as a
    // record that failed to load.
    const options = await boot().ask(LANES.commander);

    expect(options.systemPrompt ?? "").not.toContain("while nobody was watching");
  });

  it("should not spend the same bytes on a lane nobody is questioning", async () => {
    // The hourly turn already remembers its own day inside its own thread, the
    // dream must carry nothing it did not judge, and the extraction turn is a
    // sealed reader. Every lane in `LANES`, so a new one cannot slip in
    // untested.
    const booted = boot();
    anHourSheReachedHimIn(booted.jobs, THE_HOUR_HE_ASKED_ABOUT, "Filed a reminder, dentist.");

    for (const lane of Object.values(LANES)) {
      if (lane === LANES.commander) continue;
      const options = await booted.ask(lane);
      expect(options.systemPrompt ?? "", `${lane} carried her unattended record`).not.toContain(
        "while nobody was watching",
      );
    }
  });

  it("should be read fresh, so an hour that happens mid-conversation is visible next turn", async () => {
    // A function call per turn rather than a value captured at construction:
    // this service outlives every hour it is recording.
    const booted = boot();

    expect((await booted.ask(LANES.commander)).systemPrompt ?? "").not.toContain("dentist");

    anHourSheReachedHimIn(booted.jobs, THE_HOUR_HE_ASKED_ABOUT, "Filed a reminder, dentist.");

    expect((await booted.ask(LANES.commander)).systemPrompt ?? "").toContain("dentist");
  });
});
