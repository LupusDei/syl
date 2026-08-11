import { readFileSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { TurnOptions, TurnResult } from "../../src/harness/session.js";
import { sylHome } from "../../src/index.js";
import { ANNOUNCEMENT_WALL_TIME, MORNING_AGENDA_WALL_TIME } from "../../src/jobs/agenda-job.js";
import { fixedClock, instant } from "../../src/services/clock.js";
import { turnFilePath } from "../../src/tools/config.js";
import { silentRunner } from "../helpers/service.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * The morning brief, as scheduled by the running service (`syl-agd`).
 *
 * `LANES.agenda` had existed since the harness was written and `morning_agenda`
 * had been in the job catalogue since `0007_jobs.sql`. **Nothing defined the job
 * and nothing scheduled it** — the same shape as `content_ingestion` before
 * `intake-job.ts`, the dream before `syl-cbb`, and the heartbeat before
 * `syl-hb`: a lane with no engine, which no unit test of either half can see.
 *
 * So this file boots the service the way `main` does and asks the questions only
 * the assembly can answer — is there a row, does the runner reach a handler for
 * it, does the turn carry the hands the widening was argued for, and does it
 * land before the note that announces it. A `JobKind` with a row and no
 * registered handler fails every occurrence on sight with "No handler is
 * registered".
 *
 * Nothing here spawns a real `claude`: turns run through `silentRunner`.
 */

/** 06:45 CDT on Tuesday 11 August 2026 — the slot itself. */
const AT_THE_SLOT = Date.UTC(2026, 7, 11, 11, 45);

describe("the morning brief, as scheduled by the running service", () => {
  const running: LiveService[] = [];
  const leftovers: string[] = [];

  afterEach(async () => {
    for (const service of running.splice(0)) await service.close();
    for (const path of leftovers.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** A live service on a frozen clock, recording every turn its runner saw. */
  async function boot(
    at: number = AT_THE_SLOT,
  ): Promise<{ readonly service: LiveService; readonly turns: Array<[string, TurnOptions]> }> {
    const turns: Array<[string, TurnOptions]> = [];
    const service = await startLiveService({
      clock: fixedClock(at),
      delivery: { clock: () => at },
      runner: (prompt: string, options: TurnOptions): Promise<TurnResult> => {
        turns.push([prompt, options]);
        return silentRunner(prompt, options);
      },
    });
    running.push(service);
    if (service.directory !== null) leftovers.push(service.directory);
    return { service, turns };
  }

  /** Make the brief due, then run enough passes for it to be selected. */
  async function composeNow(
    service: LiveService,
    at: number = AT_THE_SLOT,
  ): Promise<void> {
    const job = service.deps.jobs.list({ kind: "morning_agenda", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(at - 1_000));
    // Concurrency is one job per tick and reminder delivery outranks everything
    // scheduled, so a few passes are needed before this one is selected.
    for (let i = 0; i < 6; i += 1) await service.runtime.runner.tick();
  }

  it("should define exactly one morning agenda job on the way up", async () => {
    // The defect, as one assertion. There was no row at all.
    const { service } = await boot();

    const jobs = service.deps.jobs.list({ kind: "morning_agenda", limit: 10 }).items;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextRunAt).not.toBeNull();
  });

  it("should compose it at a wall time in his zone, ahead of the note that announces it", async () => {
    const { service } = await boot();

    const job = service.deps.jobs.list({ kind: "morning_agenda", limit: 1 }).items[0];

    expect(job?.trigger.type).toBe("wall_clock");
    expect(job?.trigger.wallTime).toBe(MORNING_AGENDA_WALL_TIME);
    expect((job?.trigger.wallTime ?? "") < ANNOUNCEMENT_WALL_TIME).toBe(true);
    // A place, never an offset. Constraint 5 — otherwise the brief crosses to
    // the wrong side of the announcement at every DST boundary.
    expect(job?.trigger.tz).toBe(service.config.quietHours.tz);
    expect(job?.trigger.tz).toContain("/");
  });

  it("should reach a registered handler, rather than failing every morning on sight", async () => {
    const { service } = await boot();
    await composeNow(service);

    const job = service.deps.jobs.list({ kind: "morning_agenda", limit: 1 }).items[0];
    const runs = service.deps.jobs.listRuns({ jobId: job?.id ?? "", limit: 20 }).items;

    expect(runs.length).toBeGreaterThan(0);
    // The failure this whole file exists to catch.
    for (const run of runs) expect(run.error ?? "").not.toContain("No handler is registered");
  });

  it("should take one turn, on the thread the Commander talks to", async () => {
    // *"The morning routine update should also be on the same lane for now"* —
    // the Commander, 2026-08-11, extending to the brief the ruling he had
    // already made about the hour and the render review. It composes his day
    // with his conversation in view rather than from outside it.
    const { service, turns } = await boot();
    await composeNow(service);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.[1].lane).toBe("commander");
    // And still not marked as words he said — see the sleep test below. Being
    // on his lane is exactly what stopped being evidence of that.
    expect(turns[0]?.[1].hisWords).toBe(false);
  });

  it("should hand that turn the hands the widening was argued for", async () => {
    // A brief she cannot file exists only in a run record nobody reads. This is
    // the assertion that the lane gating in `bootstrap` reaches the turn the job
    // actually takes, rather than only a turn a test asks for by name.
    const { service, turns } = await boot();
    await composeNow(service);

    const [, options] = turns[0] ?? [];
    expect(options?.mcpConfig).toBeDefined();
    // And still nothing ambient, and still no built-ins: the widening is one
    // named declaration, not a relaxation of the container.
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.tools).toBe("");
    expect(options?.settingSources).toBe("");
  });

  it("should send her to look at his day rather than hand her a copy of it", async () => {
    const { service, turns } = await boot();
    await composeNow(service);

    const [prompt] = turns[0] ?? [];
    expect(prompt).toContain("whats_outstanding");
    expect(prompt).toContain(service.config.quietHours.tz);
    expect(prompt).toContain(ANNOUNCEMENT_WALL_TIME);
  });

  it("should never let an agenda prompt be recorded as something HE said", async () => {
    // The same protection the heartbeat has, for the same reason:
    // `harness/urgency.ts` checks a claimed urgent phrase against the file
    // holding his last message, and a prompt of hers in that file is a sentence
    // she can quote to pierce his sleep.
    //
    // It used to hold because this was a different lane from his. It is HIS
    // LANE now, so what holds it is `AskOptions.hisWords` — the question asked
    // directly instead of inferred from where the turn was running.
    const { service, turns } = await boot();
    await composeNow(service);

    const [prompt] = turns[0] ?? [];
    expect(prompt).toContain("This is the morning brief");

    const home = sylHome(service.config);
    expect(home).toBeDefined();
    let recorded = "";
    try {
      recorded = readFileSync(turnFilePath(home ?? ""), "utf8");
    } catch {
      // No file at all is the strongest form of the same answer.
      recorded = "";
    }
    expect(recorded).not.toContain("This is the morning brief");
  });

  it("should put nothing in front of him for a morning in which she composed nothing", async () => {
    // `silentRunner` files nothing, which is the empty morning. It must not
    // become a notification saying the brief is ready when it is not.
    const { service } = await boot();
    await composeNow(service);

    expect(service.deps.outbox.list({ limit: 50 }).items).toHaveLength(0);
  });

  it("should not take a turn during the boot it is part of", async () => {
    // A service that restarts at 10:00 must not compose a brief about a morning
    // that has already happened, on every restart.
    const { turns } = await boot(Date.UTC(2026, 7, 11, 15, 0));

    expect(turns).toHaveLength(0);
  });
});
