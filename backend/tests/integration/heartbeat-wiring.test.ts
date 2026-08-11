import { readFileSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { TurnOptions, TurnResult } from "../../src/harness/session.js";
import { sylHome } from "../../src/index.js";
import { HEARTBEAT_INTERVAL_MS, SENDINGS_PER_DAY } from "../../src/jobs/heartbeat-job.js";
import { fixedClock, instant } from "../../src/services/clock.js";
import { turnFilePath } from "../../src/tools/config.js";
import { silentRunner } from "../helpers/service.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * The hourly self-ping, as scheduled by the running service (`syl-hb`).
 *
 * `LANES.heartbeat` has existed since the harness was written, described as
 * *"scheduled 'is anything wrong?' checks"*, and **nothing has ever fired it**.
 * That is the same shape as `content_ingestion` before `intake-job.ts` and the
 * dream before `syl-cbb`: a lane with no engine, which no unit test of either
 * half can see.
 *
 * So this file boots the service the way `main` does and asks the questions
 * only the assembly can answer — is there a row, does the runner reach a
 * handler for it, and does the turn it takes carry the hands the widening was
 * argued for. A `JobKind` with a row and no registered handler fails every
 * occurrence on sight with "No handler is registered".
 *
 * Nothing here spawns a real `claude`: turns run through `silentRunner` in
 * process, which is Syl present and choosing to say nothing — the outcome this
 * feature expects most hours anyway.
 */

/** 09:07 CDT on Tuesday 11 August 2026. Mid-morning, clear of the window. */
const MORNING = Date.UTC(2026, 7, 11, 14, 7);

describe("the heartbeat, as scheduled by the running service", () => {
  const running: LiveService[] = [];
  const leftovers: string[] = [];

  afterEach(async () => {
    for (const service of running.splice(0)) await service.close();
    for (const path of leftovers.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** A live service on a frozen clock, recording every turn its runner saw. */
  async function boot(
    at: number = MORNING,
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

  it("should define exactly one heartbeat job on the way up", async () => {
    const { service } = await boot();

    const jobs = service.deps.jobs.list({ kind: "heartbeat", limit: 10 }).items;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextRunAt).not.toBeNull();
  });

  it("should wake her on an interval rather than at a time he could set his watch by", async () => {
    // Her rhythm already owns two fixed slots. A third thing that reliably
    // arrives at 09:00 is a newsletter, and a newsletter gets muted.
    const { service } = await boot();

    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];

    expect(job?.trigger.type).toBe("interval");
    expect(job?.trigger.intervalMs).toBe(HEARTBEAT_INTERVAL_MS);
    // A place, never an offset. Constraint 5 — the ledger is counted in it.
    expect(job?.trigger.tz).toBe(service.config.quietHours.tz);
    expect(job?.trigger.tz).toContain("/");
  });

  it("should not take a turn during the boot it is part of", async () => {
    // The first wake is an hour out. A service that restarts often would
    // otherwise spend a turn on every restart, competing with the startup.
    const { service, turns } = await boot();

    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];

    expect(turns).toHaveLength(0);
    expect(job?.nextRunAt).toBe(instant(MORNING + HEARTBEAT_INTERVAL_MS));
  });

  it("should never start while the Commander or a reminder is waiting", async () => {
    const { service } = await boot();

    expect(service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0]?.priority).toBe(
      "background",
    );
  });

  it("should reach a registered handler, rather than failing every hour on sight", async () => {
    const { service } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    expect(job).toBeDefined();

    // Make it due. `release` writes `nextRunAt` through verbatim.
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    // Concurrency is one job per tick and reminder delivery outranks a
    // background job, so a few passes are needed before this one is selected.
    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const runs = service.deps.jobs.listRuns({ jobId: job?.id ?? "", limit: 20 }).items;

    expect(runs.length).toBeGreaterThan(0);
    // The failure this whole file exists to catch.
    for (const run of runs) expect(run.error ?? "").not.toContain("No handler is registered");
  });

  it("should take one turn and record that it reached nobody", async () => {
    const { service, turns } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    expect(turns).toHaveLength(1);
    expect(service.deps.jobs.listRuns({ jobId: job?.id ?? "", limit: 5 }).items[0]?.spoke).toBe(
      false,
    );
  });

  it("should hand that turn the hands the widening was argued for", async () => {
    // The point of the hour is that she can act in it. This is the assertion
    // that the lane gating in `bootstrap` actually reaches the turn the job
    // takes, rather than only the turn a test asks for by name.
    const { service, turns } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const [, options] = turns[0] ?? [];
    expect(options?.mcpConfig).toBeDefined();
    // And still nothing ambient, and still no built-ins: the widening is one
    // named declaration, not a relaxation of the container.
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.tools).toBe("");
    expect(options?.settingSources).toBe("");
  });

  it("should never let a heartbeat prompt be recorded as something HE said", async () => {
    // The one that protects his sleep. `harness/urgency.ts` checks a claimed
    // urgent phrase against the file holding his last message, and the Outbox
    // holds every non-urgent notification until the window ends — so if a
    // heartbeat's own prompt landed in that file, she could quote the words she
    // was woken with and wake him at 03:00 with a sentence he never wrote.
    //
    // It used to hold because the hour ran on a lane of its own. It runs on HIS
    // LANE now, so the lane says nothing about who spoke and this holds because
    // of `AskOptions.hisWords`, which the hour does not set. See
    // `tests/acceptance/an-unattended-turn-cannot-wake-him.test.ts` for the
    // same property driven all the way to the `urgent` column.
    const { service, turns } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const [prompt] = turns[0] ?? [];
    expect(prompt).toContain("This hour is your own");

    const home = sylHome(service.config);
    expect(home).toBeDefined();
    let recorded = "";
    try {
      recorded = readFileSync(turnFilePath(home ?? ""), "utf8");
    } catch {
      // No file at all is the strongest form of the same answer: nothing on
      // this machine has ever claimed he said anything.
      recorded = "";
    }
    expect(recorded).not.toContain("This hour is your own");
  });

  it("should tell her what she has already spent, from the runs table and no new store", async () => {
    const { service, turns } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const [prompt] = turns[0] ?? [];
    expect(prompt).toContain(String(SENDINGS_PER_DAY));
    expect(prompt).toContain(service.config.quietHours.tz);
  });

  it("should still take its hour inside the quiet window, and reach him at none of it", async () => {
    // She may think at 03:00. What she may not do is arrive — and that is the
    // Outbox's existing rule rather than a second implementation here.
    const night = Date.UTC(2026, 7, 12, 8, 0); // 03:00 CDT
    const { service, turns } = await boot(night);
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(night - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.[0].toLowerCase()).toContain("asleep");
    // The window the outbox is holding everything until, from the same config.
    expect(turns[0]?.[0]).toContain(service.config.quietHours.quiet.end);
  });

  it("should put nothing in front of him for an hour in which she said nothing", async () => {
    // The heartbeat's reply is a return value that the handler records. It must
    // never become a notification, which is what would put an hourly "nothing
    // to report" on his phone.
    const { service } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    expect(service.deps.outbox.list({ limit: 50 }).items).toHaveLength(0);
  });

  it("should take its turns on the thread the Commander talks to", async () => {
    // The Commander's ruling, 2026-08-11: *"running the hourly checkin on a
    // different thread is wrong for now — resume the same session… much of her
    // personality lives in that thread."* The hour used to have a lane of its
    // own, and the cost of that was the hour deciding whether to say something
    // to him with no sight of how he had been spoken to.
    const { service, turns } = await boot();
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(MORNING - 1_000));

    for (let i = 0; i < 10; i += 1) await service.runtime.runner.tick();

    expect(turns.length).toBeGreaterThan(0);
    for (const [, options] of turns) expect(options.lane).toBe("commander");
    // One session across the passes: the lane resumes, so the hours are one
    // conversation — his — rather than a stranger every hour.
    const sessions = new Set(turns.map(([, options]) => options.sessionId ?? options.resume));
    expect(sessions.size).toBe(1);
  });

  it("should stand aside rather than hold his thread through the morning brief", async () => {
    // *"I just suspect the hourly heartbeat at night won't have much value and
    // might even conflict with the dreaming or morning routines."* — the
    // Commander, 2026-08-11. He asked for the collision to go, not for the
    // overnight hours to go: she may still file things at 03:00.
    //
    // The collision that is real is the brief. It must exist before the 07:00
    // note announces it and it starts `COMPOSE_LEAD_MS` ahead for exactly that
    // reason, so an hour still talking at 06:45 spends that lead on itself —
    // and now holds the same session the brief has to resume.
    const justBeforeTheBrief = Date.UTC(2026, 7, 12, 11, 40); // 06:40 CDT
    const { service, turns } = await boot(justBeforeTheBrief);
    const job = service.deps.jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(justBeforeTheBrief - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    expect(turns).toHaveLength(0);
    const run = service.deps.jobs.listRuns({ jobId: job?.id ?? "", limit: 5 }).items[0];
    // A yielded hour is a success and costs nothing. Recorded as a failure it
    // would walk the job's circuit breaker towards taking the hour away
    // altogether, which is a punishment for good manners.
    expect(run?.outcome).toBe("success");
    expect(run?.summary ?? "").toContain("morning_agenda");
    expect(run?.error).toBeNull();
  });
});
