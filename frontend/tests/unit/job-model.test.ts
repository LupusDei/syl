import { describe, expect, it } from "vitest";

import type { Job, JobPage, Ok, Run, RunPage } from "@syl/shared/types";

import {
  breakerTone,
  describeBreaker,
  describeBudget,
  describeLease,
  describeTrigger,
  JOB_STATES,
  jobStateTone,
  jobUrgency,
  runDetail,
  runDurationMs,
  runIsLate,
  runOutcomeTone,
  sortJobs,
} from "../../src/features/jobs/job-model";
import { fixture } from "../helpers/fixtures";

/** The shipped page, decoded exactly as the client hands it over. */
const jobs: readonly Job[] = (fixture("http/jobs.page") as Ok<JobPage>).data.items;
const runs: readonly Run[] = (fixture("http/runs.page") as Ok<RunPage>).data.items;

function jobOfKind(kind: string): Job {
  const found = jobs.find((job) => job.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} job in the fixture`);
  return found;
}

describe("JOB_STATES", () => {
  it("should offer every state the contract defines", () => {
    // The list is an exhaustive Record's keys, so a state added to the spec
    // breaks the typecheck rather than quietly vanishing from the filter.
    expect(JOB_STATES).toContain("failed");
    expect(JOB_STATES).toContain("suspended");
    expect(new Set(JOB_STATES).size).toBe(JOB_STATES.length);
  });
});

describe("jobStateTone", () => {
  it("should colour trouble as failure and progress as accent", () => {
    expect(jobStateTone("failed")).toBe("fail");
    expect(jobStateTone("abandoned")).toBe("fail");
    expect(jobStateTone("suspended")).toBe("warn");
    expect(jobStateTone("running")).toBe("accent");
    expect(jobStateTone("leased")).toBe("accent");
    expect(jobStateTone("done")).toBe("ok");
    expect(jobStateTone("pending")).toBe("pending");
  });
});

describe("runOutcomeTone", () => {
  it("should distinguish a failure from a skip", () => {
    expect(runOutcomeTone("success")).toBe("ok");
    expect(runOutcomeTone("failure")).toBe("fail");
    expect(runOutcomeTone("abandoned")).toBe("fail");
    expect(runOutcomeTone("suspended")).toBe("warn");
    expect(runOutcomeTone("skipped")).toBe("muted");
  });
});

describe("describeTrigger", () => {
  it("should keep a wall clock time and its zone together", () => {
    // An instant without its zone is the fixed-offset bug in a different
    // costume; a viewer that shows one half invites exactly that mistake.
    expect(describeTrigger(jobOfKind("morning_agenda").trigger)).toBe(
      "07:00 America/Chicago · FREQ=DAILY",
    );
  });

  it("should describe the event and manual triggers in the fixture", () => {
    expect(describeTrigger(jobOfKind("reminder_delivery").trigger)).toBe("on reminder.due");
    expect(describeTrigger(jobOfKind("research_brief").trigger)).toBe("manual");
  });

  it("should describe an interval in seconds", () => {
    expect(describeTrigger({ type: "interval", intervalMs: 900_000 })).toBe("every 900s");
  });

  it("should say so rather than guess when a field is missing", () => {
    expect(describeTrigger({ type: "wall_clock" })).toBe("??:?? no zone");
    expect(describeTrigger({ type: "interval" })).toBe("every ?");
    expect(describeTrigger({ type: "event" })).toBe("on ?");
  });
});

describe("describeBudget", () => {
  it("should call out a job that cannot spawn a turn at all", () => {
    // maxTurns: 0 is why reminder delivery cannot be delayed by a rate limit.
    expect(describeBudget(jobOfKind("reminder_delivery").budget)).toBe("no turns · no tools");
  });

  it("should count turns and tools otherwise", () => {
    expect(describeBudget(jobOfKind("morning_agenda").budget)).toBe("2 turns · 2 tools");
    expect(describeBudget({ maxTurns: 1, maxWallClockMs: 1, allowedTools: ["Read"] })).toBe(
      "1 turn · 1 tools",
    );
  });
});

describe("describeLease", () => {
  it("should name the owner of a held lease", () => {
    expect(describeLease(jobOfKind("research_brief").lease)).toBe("syl@iMac.local:41827");
  });

  it("should show an em dash when nothing holds it", () => {
    expect(describeLease(null)).toBe("—");
  });
});

describe("circuit breaker", () => {
  it("should shout about a breaker that is not closed", () => {
    const consolidation = jobOfKind("nightly_consolidation");
    expect(breakerTone(consolidation.circuitBreaker)).toBe("warn");
    expect(describeBreaker(consolidation.circuitBreaker)).toBe("half open · 2 failures");
  });

  it("should treat an open breaker as a failure", () => {
    expect(breakerTone({ state: "open", consecutiveFailures: 5, openedAt: null })).toBe("fail");
  });

  it("should stay quiet about a healthy one", () => {
    const healthy = jobOfKind("reminder_delivery").circuitBreaker;
    expect(breakerTone(healthy)).toBe("muted");
    expect(describeBreaker(healthy)).toBe("closed");
  });

  it("should warn about a closed breaker that has started failing", () => {
    expect(breakerTone({ state: "closed", consecutiveFailures: 1, openedAt: null })).toBe("warn");
  });
});

describe("sortJobs", () => {
  it("should put trouble first and never drop a row", () => {
    const sorted = sortJobs(jobs);
    expect(sorted.length).toBe(jobs.length);
    // The half-open breaker outranks the running job, which outranks the two
    // healthy pending ones.
    expect(sorted[0]?.kind).toBe("nightly_consolidation");
    expect(sorted[1]?.kind).toBe("research_brief");
  });

  it("should order the rest by soonest next run", () => {
    const sorted = sortJobs(jobs);
    expect(sorted[2]?.kind).toBe("reminder_delivery");
    expect(sorted[3]?.kind).toBe("morning_agenda");
  });

  it("should sink a job with no next run below one that has one", () => {
    const a = { ...jobOfKind("morning_agenda"), nextRunAt: null };
    const b = jobOfKind("reminder_delivery");
    expect(sortJobs([a, b])[0]?.id).toBe(b.id);
    expect(sortJobs([b, a])[0]?.id).toBe(b.id);
  });

  it("should fall back to kind when neither has a next run", () => {
    const a: Job = { ...jobOfKind("morning_agenda"), state: "pending", nextRunAt: null };
    const b: Job = { ...jobOfKind("reminder_delivery"), nextRunAt: null };
    expect(sortJobs([a, b])[0]?.kind).toBe("morning_agenda");
  });

  it("should not mutate the array it was given", () => {
    const original = [...jobs];
    sortJobs(jobs);
    expect(jobs).toEqual(original);
  });
});

describe("jobUrgency", () => {
  it("should rank a failed job above everything else", () => {
    const failed: Job = { ...jobOfKind("morning_agenda"), state: "failed" };
    const suspended: Job = { ...jobOfKind("morning_agenda"), state: "suspended" };
    expect(jobUrgency(failed)).toBeLessThan(jobUrgency(suspended));
    expect(jobUrgency(suspended)).toBeLessThan(jobUrgency(jobOfKind("reminder_delivery")));
  });
});

describe("run helpers", () => {
  it("should measure a finished run and leave an unfinished one unknown", () => {
    const finished = runs.find((run) => run.finishedAt !== null);
    const unfinished = runs.find((run) => run.finishedAt === null);
    expect(runDurationMs(finished as Run)).toBeGreaterThan(0);
    expect(runDurationMs(unfinished as Run)).toBeNull();
  });

  it("should flag the run that fired six minutes late", () => {
    const late = runs.find((run) => run.kind === "morning_agenda");
    const punctual = runs.find((run) => run.kind === "reminder_delivery");
    expect(runIsLate(late as Run)).toBe(true);
    expect(runIsLate(punctual as Run)).toBe(false);
  });

  it("should prefer the error over the summary when a run failed", () => {
    const failed: Run = {
      ...(runs[0] as Run),
      error: "APNs 503",
      summary: "what it managed to say",
    };
    expect(runDetail(failed)).toBe("APNs 503");
  });

  it("should fall back to the summary, then to nothing", () => {
    const base = runs[0] as Run;
    expect(runDetail({ ...base, error: null, summary: "a summary" })).toBe("a summary");
    expect(runDetail({ ...base, error: "", summary: "a summary" })).toBe("a summary");
    expect(runDetail({ ...base, error: null, summary: null })).toBe("");
  });
});
