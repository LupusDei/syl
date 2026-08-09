import type { ApiError, Job, JobPage, Run, RunPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { TEST_NOW, testConfig, testDatabase, testDeps } from "../helpers/service.js";

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(path: string): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function defineReminderJob(): Job {
  return deps.jobs.define({
    kind: "reminder_delivery",
    priority: "reminder",
    trigger: { type: "interval", intervalMs: 30_000 },
    deliveryClass: "at_least_once",
    catchUp: { policy: "never_expires" },
    budget: { maxTurns: 0, maxWallClockMs: 5_000, allowedTools: [] },
    speaks: true,
  });
}

describe("GET /api/v1/jobs", () => {
  it("should list what is scheduled", async () => {
    const job = defineReminderJob();
    const body = (await (await api("/jobs")).json()) as Envelope<JobPage>;

    expect(body.data?.items).toHaveLength(1);
    expect(body.data?.items[0]?.id).toBe(job.id);
    // The strongest statement in the catalogue: a job that cannot spawn a turn
    // cannot be delayed by a rate limit.
    expect(body.data?.items[0]?.budget.maxTurns).toBe(0);
  });

  it("should filter by kind and by state", async () => {
    defineReminderJob();
    expect(
      ((await (await api("/jobs?kind=heartbeat")).json()) as Envelope<JobPage>).data?.items,
    ).toHaveLength(0);
    expect(
      ((await (await api("/jobs?state=pending")).json()) as Envelope<JobPage>).data?.items,
    ).toHaveLength(1);
  });

  it("should refuse a kind outside the closed catalogue", async () => {
    const response = await api("/jobs?kind=obey_the_article");
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<JobPage>).error?.code).toBe("VALIDATION_FAILED");
  });

  it("should refuse a state the contract does not define", async () => {
    expect((await api("/jobs?state=thinking")).status).toBe(400);
  });

  it("should refuse a cursor it did not issue", async () => {
    expect((await api("/jobs?cursor=nope")).status).toBe(400);
  });

  it("should require authentication", async () => {
    expect((await fetch(`${running.baseUrl}/api/v1/jobs`)).status).toBe(401);
  });
});

describe("GET /api/v1/jobs/{jobId}", () => {
  it("should return the job", async () => {
    const job = defineReminderJob();
    const body = (await (await api(`/jobs/${job.id}`)).json()) as Envelope<Job>;
    expect(body.data?.kind).toBe("reminder_delivery");
  });

  it("should answer 404 for an id it does not have", async () => {
    expect((await api("/jobs/syl:job:00000000-0000-7000-8000-0000000000ff")).status).toBe(404);
    expect((await api("/jobs/nonsense")).status).toBe(404);
  });
});

describe("GET /api/v1/jobs/{jobId}/runs", () => {
  it("should return runs with the gap between scheduled and actual", async () => {
    // That gap is the metric that says whether the trigger design works, and
    // it is invisible unless recorded from day one.
    const job = defineReminderJob();
    const run = deps.jobs.startRun(job, job.nextRunAt ?? "", TEST_NOW + 30_000 + 391_000);
    deps.jobs.finishRun(run.id, { outcome: "success", spoke: true });

    const body = (await (await api(`/jobs/${job.id}/runs`)).json()) as Envelope<RunPage>;
    expect(body.data?.items[0]?.latenessMs).toBe(391_000);
    expect(body.data?.items[0]?.outcome).toBe("success");
  });

  it("should answer 404 for a job it does not have", async () => {
    expect(
      (await api("/jobs/syl:job:00000000-0000-7000-8000-0000000000ff/runs")).status,
    ).toBe(404);
  });

  it("should refuse a cursor it did not issue", async () => {
    const job = defineReminderJob();
    expect((await api(`/jobs/${job.id}/runs?cursor=nope`)).status).toBe(400);
  });
});

describe("GET /api/v1/runs/{runId}", () => {
  it("should return one run with its ordered steps", async () => {
    const job = defineReminderJob();
    const run = deps.jobs.startRun(job, job.nextRunAt ?? "", TEST_NOW);
    deps.jobs.appendStep(run.id, {
      index: 0,
      sessionId: "1f4c9a2b-7d31-4e88-b0a5-6c2e9f0d3a17",
      numTurns: 1,
      outcome: "success",
      startedAt: new Date(TEST_NOW).toISOString(),
    });

    const body = (await (await api(`/runs/${run.id}`)).json()) as Envelope<Run>;
    expect(body.data?.steps).toHaveLength(1);
    expect(body.data?.steps[0]?.sessionId).toBe("1f4c9a2b-7d31-4e88-b0a5-6c2e9f0d3a17");
  });

  it("should answer 404 for an id it does not have", async () => {
    expect((await api("/runs/syl:run:00000000-0000-7000-8000-0000000000ff")).status).toBe(404);
    expect((await api("/runs/nonsense")).status).toBe(404);
  });

  it("should require authentication", async () => {
    expect(
      (await fetch(`${running.baseUrl}/api/v1/runs/syl:run:00000000-0000-7000-8000-0000000000ff`))
        .status,
    ).toBe(401);
  });
});
