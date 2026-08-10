import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { loadQuietHours } from "../../src/config.js";
import { nextDailyOccurrence } from "../../src/harness/schedule.js";
import { fixedClock, instant } from "../../src/services/clock.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * The dream, on a clock (`syl-cbb`).
 *
 * `DreamJudge.dream({ night, tz })` was complete, tested end to end against a
 * fake CLI, and called by nothing. That is the same shape as `content_ingestion`
 * before `intake-job.ts` and as the memory epic before `syl-63n`: a mechanism
 * with no engine, which no test of the mechanism can see.
 *
 * So this file boots the service the way `main` does and asks the two questions
 * only the assembly can answer — **is there a job row**, and **does the runner
 * that exists reach a handler for it**. A `JobKind` with a row and no
 * registered handler fails every occurrence on sight with "No handler is
 * registered", which is precisely the failure `intake-job.ts` was written to
 * fix and precisely the one a unit test of either half cannot produce.
 *
 * Nothing here spawns a real `claude`. The graph is empty, so the sweep
 * proposes nothing and the judge takes zero turns — and `startSyl` hands the
 * judge whatever runner it was given anyway, which is the fourth note in
 * `buildDreamJudge`'s comment and is asserted below.
 */

/** The window the service will actually boot with, from the same reader it uses. */
const QUIET = loadQuietHours(process.env);

/** Half an hour into the quiet window, resolved in the zone rather than by arithmetic. */
const IN_THE_WINDOW =
  nextDailyOccurrence(QUIET.quiet.start, new Date(Date.UTC(2026, 7, 9, 12)), QUIET.tz).getTime() +
  30 * 60_000;

describe("the dream, as scheduled by the running service", () => {
  const running: LiveService[] = [];
  const leftovers: string[] = [];

  afterEach(async () => {
    for (const service of running.splice(0)) await service.close();
    for (const path of leftovers.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function boot(at: number): Promise<LiveService> {
    const service = await startLiveService({
      clock: fixedClock(at),
      delivery: { clock: () => at },
    });
    running.push(service);
    if (service.directory !== null) leftovers.push(service.directory);
    return service;
  }

  it("should define exactly one nightly_consolidation job on the way up", async () => {
    const service = await boot(IN_THE_WINDOW);

    const jobs = service.deps.jobs.list({ kind: "nightly_consolidation", limit: 10 }).items;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextRunAt).not.toBeNull();
  });

  it("should schedule it on the wall clock, in the Commander's zone and never an offset", async () => {
    const service = await boot(IN_THE_WINDOW);

    const job = service.deps.jobs.list({ kind: "nightly_consolidation", limit: 1 }).items[0];

    expect(job?.trigger.type).toBe("wall_clock");
    expect(job?.trigger.tz).toBe(service.config.quietHours.tz);
    // A place, not an offset. Constraint 5.
    expect(job?.trigger.tz).toContain("/");
  });

  it("should confine it to the quiet window the service was configured with", async () => {
    const service = await boot(IN_THE_WINDOW);

    const job = service.deps.jobs.list({ kind: "nightly_consolidation", limit: 1 }).items[0];

    expect(job?.catchUp.policy).toBe("once_per_window");
    expect(job?.catchUp.windowStart).toBe(service.config.quietHours.quiet.start);
    expect(job?.catchUp.windowEnd).toBe(service.config.quietHours.quiet.end);
    // Background, so it never starts while anything interactive is pending.
    expect(job?.priority).toBe("background");
  });

  it("should reach a registered handler, rather than failing every night on sight", async () => {
    const service = await boot(IN_THE_WINDOW);
    const job = service.deps.jobs.list({ kind: "nightly_consolidation", limit: 1 }).items[0];
    expect(job).toBeDefined();

    // Make it due. `release` writes `nextRunAt` through verbatim.
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(IN_THE_WINDOW - 1_000));

    // Concurrency is one job per tick and the reminder job outranks this one,
    // so a few passes are needed before the background job is the one selected.
    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const runs = service.deps.jobs
      .listRuns({ jobId: job?.id ?? "", limit: 20 })
      .items.filter((run) => run.kind === "nightly_consolidation");

    expect(runs.length).toBeGreaterThan(0);
    // The failure this whole file exists to catch.
    for (const run of runs) expect(run.error ?? "").not.toContain("No handler is registered");
  });

  it("should record a night that had nothing to consolidate as a success, and spend no turns", async () => {
    const service = await boot(IN_THE_WINDOW);
    const job = service.deps.jobs.list({ kind: "nightly_consolidation", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(IN_THE_WINDOW - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const run = service.deps.jobs
      .listRuns({ jobId: job?.id ?? "", limit: 20 })
      .items.find((candidate) => candidate.kind === "nightly_consolidation");

    expect(run?.outcome).toBe("success");
    // An empty graph proposes nothing, so the judge never spawns a subprocess —
    // which is also why this file can run in an ordinary `npm test`.
    expect(run?.turns).toBe(0);
    expect(run?.spoke).toBe(false);
  });

  it("should have written the night into the dream log, and nothing into the graph", async () => {
    const service = await boot(IN_THE_WINDOW);
    const job = service.deps.jobs.list({ kind: "nightly_consolidation", limit: 1 }).items[0];
    service.deps.jobs.release(job?.id ?? "", "success", null, instant(IN_THE_WINDOW - 1_000));

    for (let i = 0; i < 5; i += 1) await service.runtime.runner.tick();

    const sessions = service.deps.memory.dreams.list({ limit: 10 }).items;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]?.outcome).toBe("completed");
    expect(sessions[0]?.endedAt).not.toBeNull();
    // Constraint 7: the log is telemetry ABOUT the graph, never written INTO it.
    expect(
      service.database.handle.prepare("SELECT COUNT(*) AS n FROM memory_nodes").get(),
    ).toEqual({ n: 0 });
  });

  it("should carry the searchable half of memory, constructed lazily and never at boot", async () => {
    const service = await boot(IN_THE_WINDOW);

    // Nothing has asked for it yet: the boot did not load `vec0` and did not
    // touch a model. `syl-63n`.
    expect(service.deps.memoryRuntime.lastFailure).toBeNull();

    const searchable = service.deps.memoryRuntime.searchable();

    expect(searchable.store.dimensions).toBeGreaterThan(0);
    expect(service.deps.memoryRuntime.ready).toBe(true);
    // The one thing `openDatabase({ allowExtension: true })` buys: a store on
    // the SERVICE's own connection, which is the connection that could never
    // load `vec0` before.
    expect(searchable.store.reconcile().clean).toBe(true);
  });

  it("should give the service a working supersession ledger without any of that", async () => {
    const service = await boot(IN_THE_WINDOW);

    const subject = service.deps.memory.graph.addNode({ kind: "fact", label: "the gutter" });
    const value = service.deps.memory.graph.addNode({
      kind: "fact",
      label: "the gutter was replaced",
    });

    const result = service.deps.memoryRuntime.ledger.assert({
      subject: subject.id,
      relation: "state",
      value: "replaced",
      valueNode: value.id,
    });

    expect(result.current.value).toBe("replaced");
    expect(service.deps.memoryRuntime.ready).toBe(false);
  });
});
