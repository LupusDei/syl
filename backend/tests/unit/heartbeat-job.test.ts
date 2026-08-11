import { afterEach, describe, expect, it } from "vitest";

import type { Job } from "@syl/shared";

import type { QuietHours } from "../../src/harness/schedule.js";
import type { TurnResult } from "../../src/harness/session.js";
import {
  createHeartbeatHandler,
  defineHeartbeatJob,
  describeHeartbeat,
  ensureHeartbeatJob,
  heartbeatPrompt,
  HEARTBEAT_INTERVAL_MS,
  REACHES_HIM,
  SENDINGS_PER_DAY,
  type HeartbeatVoice,
} from "../../src/jobs/heartbeat-job.js";
import { instant } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { JobContext } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { advertisedToolNames } from "../../src/tools/server.js";
import { mcpToolName } from "../../src/tools/config.js";
import { testDatabase } from "../helpers/service.js";

/**
 * The hourly self-ping (`syl-hb`).
 *
 * The Commander asked for "an hourly self-ping that wakes her up and lets her
 * decide what to do." Everything interesting about it is a *bound*: she may
 * think at any hour, she may reach him at very few of them, and the expected
 * answer almost every hour is nothing at all.
 *
 * So these tests are mostly about restraint rather than about behaviour —
 * what the hour does NOT do. The clock is injected everywhere and the turn
 * runner is a double, because a test that depended on the real hour would pass
 * for sixteen hours a day and fail for eight.
 */

const TZ = "America/Chicago";
const QUIET: QuietHours = { start: "22:00", end: "08:00" };

/** 09:07 CDT on Tuesday 11 August 2026 — mid-morning, well clear of the window. */
const MORNING = Date.UTC(2026, 7, 11, 14, 7);
/** 03:00 CDT the same night — deep inside the quiet window. */
const SMALL_HOURS = Date.UTC(2026, 7, 12, 8, 0);
/** 09:07 CDT the next day, for the ledger's day boundary. */
const NEXT_MORNING = MORNING + 24 * 60 * 60_000;

const databases: SylDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function store(): JobStore {
  const db = testDatabase();
  databases.push(db);
  return new JobStore({ db: db.handle });
}

/** A turn that said something and called nothing. */
function said(text: string, tools: readonly string[] = []): TurnResult {
  return {
    sessionId: "sess-heartbeat",
    text,
    spoken: text,
    costUsd: 0.01,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId: "sess-heartbeat",
      raw: {},
      model: "test",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: tools.map((name) => ({
      kind: "tool_use" as const,
      sessionId: "sess-heartbeat",
      raw: {},
      name,
      input: {},
    })),
  };
}

interface Recorder extends HeartbeatVoice {
  readonly prompts: string[];
  readonly resets: number[];
}

/** A stand-in for the heartbeat lane that records what it was asked. */
function voice(answer: TurnResult | (() => Promise<TurnResult>) = said("Nothing.")): Recorder {
  const prompts: string[] = [];
  const resets: number[] = [];
  return {
    prompts,
    resets,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      return typeof answer === "function" ? answer() : answer;
    },
    reset: () => {
      resets.push(prompts.length);
    },
  };
}

/** A finished run on this job, at an instant, that did or did not reach him. */
function pastRun(jobs: JobStore, job: Job, at: number, spoke: boolean): void {
  const run = jobs.startRun(job, instant(at), at);
  jobs.finishRun(run.id, { outcome: "success", spoke });
}

/** The context the runner hands a handler, for a pass starting now. */
function contextFor(jobs: JobStore, job: Job, now: number): JobContext {
  const run = jobs.startRun(job, instant(now), now);
  return { job, run, triggerInstant: instant(now), late: false, now };
}

describe("defineHeartbeatJob", () => {
  it("should wake her once an hour, on an interval rather than a wall time", () => {
    // A wall-clock trigger fires at the same minute every day, and a thing that
    // reliably produces something at the same time is a newsletter. Her rhythm
    // already owns two fixed slots; this must not become a third.
    const job = defineHeartbeatJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.trigger.type).toBe("interval");
    expect(job.trigger.intervalMs).toBe(HEARTBEAT_INTERVAL_MS);
    expect(HEARTBEAT_INTERVAL_MS).toBe(60 * 60_000);
    expect(job.trigger.wallTime).toBeUndefined();
  });

  it("should collapse the hours the machine was asleep into one", () => {
    // `skip`: a laptop that was shut for six hours owes her six heartbeats,
    // and six turns in a row asking "is anything wrong?" is the exact shape of
    // nagging this whole feature is trying not to be.
    const job = defineHeartbeatJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.catchUp.policy).toBe("skip");
    expect(job.deliveryClass).toBe("at_most_once");
  });

  it("should never start while the Commander or a reminder is waiting", () => {
    // One rate-limit pool, shared with his own conversation. `JobStore.due`
    // sorts `background` last.
    expect(defineHeartbeatJob(store(), { tz: TZ, quiet: QUIET }).priority).toBe("background");
  });

  it("should be scheduled an hour out rather than immediately, on a first boot", () => {
    // A heartbeat firing during startup would compete with the boot it is part
    // of, and there is nothing an hour of uptime has taught her yet.
    const job = defineHeartbeatJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.nextRunAt).not.toBeNull();
  });

  it("should declare the hands it is actually given, rather than claiming none", () => {
    // `budget.allowedTools` is the catalogue's statement of what a turn of this
    // kind can reach, and this is the kind that changed: the heartbeat lane now
    // carries an MCP surface. Derived from the server, never written out beside
    // it, so it cannot claim a verb that does not exist or miss one that does.
    const job = defineHeartbeatJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.budget.allowedTools).toEqual(advertisedToolNames().map(mcpToolName));
  });

  it("should be allowed to speak, and to spend at most one turn doing it", () => {
    const job = defineHeartbeatJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.speaks).toBe(true);
    // 24 turns a day on subscription rails is the whole cost of this feature.
    // One turn per hour is what makes that number 24 and not 240.
    expect(job.budget.maxTurns).toBe(1);
  });
});

describe("ensureHeartbeatJob", () => {
  it("should create exactly one, and then find the one it created", () => {
    // `nextRunAt` is state — the instant the last pass decided it next needed
    // to wake — and redefining the row every boot would throw it away along
    // with the circuit breaker.
    const jobs = store();

    const first = ensureHeartbeatJob(jobs, { tz: TZ, quiet: QUIET }, MORNING);
    const second = ensureHeartbeatJob(jobs, { tz: TZ, quiet: QUIET }, MORNING + 5_000);

    expect(second.id).toBe(first.id);
    expect(jobs.list({ kind: "heartbeat", limit: 10 }).items).toHaveLength(1);
  });
});

describe("REACHES_HIM", () => {
  it("should name only verbs that actually exist on her hands", () => {
    // The guard against the set rotting into a list of phantoms: a rename in
    // `tools/schemas.ts` would otherwise leave the ceiling counting nothing,
    // silently, and an unspendable ceiling is no ceiling at all.
    for (const verb of REACHES_HIM) {
      expect(advertisedToolNames(), `${verb} is not a verb she has`).toContain(verb);
    }
    expect(REACHES_HIM.length).toBeGreaterThan(0);
  });
});

describe("the prompt she is woken with", () => {
  const moment = {
    now: MORNING,
    tz: TZ,
    quiet: QUIET,
    inQuietHours: false,
    spentToday: 0,
    allowance: SENDINGS_PER_DAY,
  };

  it("should tell her the hour, in his zone and never as an offset", () => {
    const prompt = heartbeatPrompt(moment);

    expect(prompt).toContain(TZ);
    // 09:07 in Chicago, not 14:07 in UTC. An hour she has to convert is an hour
    // she will convert wrongly.
    expect(prompt).toContain("09:07");
    expect(prompt).not.toMatch(/UTC[+-]\d/);
  });

  it("should say plainly that doing nothing is the expected answer", () => {
    // The single most important sentence in the feature. Without it an hourly
    // turn is an hourly obligation to produce something, and an assistant that
    // speaks constantly gets muted.
    expect(heartbeatPrompt(moment).toLowerCase()).toContain("nothing");
  });

  it("should tell her nobody asked for this hour", () => {
    // She has never acted with nobody watching. An hour that reads like a
    // request gets answered like one.
    expect(heartbeatPrompt(moment).toLowerCase()).toMatch(/nobody|no one|unprompted|your own/);
  });

  it("should state the ceiling as a rate, and say it does not accumulate", () => {
    const prompt = heartbeatPrompt(moment);

    expect(prompt).toContain(String(SENDINGS_PER_DAY));
    expect(prompt.toLowerCase()).toMatch(/does not (roll over|accumulate)/);
  });

  it("should say what is left when some of it is spent", () => {
    const prompt = heartbeatPrompt({ ...moment, spentToday: 1 });

    expect(prompt).toMatch(/1 of 2|one of (the )?two/i);
  });

  it("should say the day is spent, without treating it as a failure", () => {
    // "You have nothing left" and "you have wasted the day" are different
    // sentences, and only one of them produces an assistant that invents
    // something to say at 4pm.
    const prompt = heartbeatPrompt({ ...moment, spentToday: SENDINGS_PER_DAY });

    expect(prompt.toLowerCase()).toContain("nothing more");
  });

  it("should name the quiet window and forbid reaching him inside it", () => {
    const prompt = heartbeatPrompt({ ...moment, now: SMALL_HOURS, inQuietHours: true });

    expect(prompt).toContain("22:00");
    expect(prompt).toContain("08:00");
    expect(prompt.toLowerCase()).toMatch(/asleep|sleep/);
  });

  it("should still invite her to think during quiet hours, and say where it goes", () => {
    // The distinction the whole window rests on: she may think at 03:00, and
    // she may not reach him. A prompt that only forbade would waste the hour.
    const prompt = heartbeatPrompt({ ...moment, now: SMALL_HOURS, inQuietHours: true });

    expect(prompt.toLowerCase()).toMatch(/think|notice/);
    // The lane resumes, so what she noticed at 03:00 is still there at 09:00.
    expect(prompt.toLowerCase()).toMatch(/keeps|still (be )?here|waits/);
  });

  it("should not tell her to reach him during quiet hours just because the day is unspent", () => {
    const prompt = heartbeatPrompt({ ...moment, now: SMALL_HOURS, inQuietHours: true });

    expect(prompt.toLowerCase()).not.toMatch(/you may reach him/);
  });
});

describe("the hour itself", () => {
  function ready(now = MORNING): {
    readonly jobs: JobStore;
    readonly job: Job;
  } {
    const jobs = store();
    const job = ensureHeartbeatJob(jobs, { tz: TZ, quiet: QUIET }, now);
    return { jobs, job };
  }

  it("should wake her with the prompt, once", async () => {
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, MORNING));

    expect(heard.prompts).toHaveLength(1);
    expect(heard.prompts[0]).toContain(TZ);
  });

  it("should record an hour with nothing in it as a success that reached nobody", async () => {
    // The common case, and the one that must be cheap and quiet.
    const { jobs, job } = ready();
    const handler = createHeartbeatHandler({
      voice: voice(said("Nothing worth saying. He is fine.")),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    const result = await handler(contextFor(jobs, job, MORNING));

    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(false);
    // Her own sentence, which is what makes the runs table readable.
    expect(result.summary).toContain("Nothing worth saying");
    expect(result.error).toBeNull();
  });

  it("should record an hour she acted in as one that reached him", async () => {
    const { jobs, job } = ready();
    const handler = createHeartbeatHandler({
      voice: voice(said("Dave's birthday is Thursday.", [mcpToolName("remind_me")])),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    const result = await handler(contextFor(jobs, job, MORNING));

    expect(result.spoke).toBe(true);
    expect(result.outcome).toBe("success");
  });

  it("should not count reading or rendering as reaching him", async () => {
    // She is encouraged to look at herself often, and looking at a to-do list
    // is not speech. Counting either against the ceiling would spend a day's
    // allowance on an hour in which she said nothing at all.
    const { jobs, job } = ready();
    const handler = createHeartbeatHandler({
      voice: voice(
        said("Looked at myself.", [mcpToolName("render_me"), mcpToolName("whats_outstanding")]),
      ),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    expect((await handler(contextFor(jobs, job, MORNING))).spoke).toBe(false);
  });

  it("should tell her how much of today's allowance is already spent", async () => {
    const { jobs, job } = ready();
    pastRun(jobs, job, MORNING - 3 * 60 * 60_000, true);
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, MORNING));

    expect(heard.prompts[0]).toMatch(/1 of 2|one of (the )?two/i);
  });

  it("should count a day in HIS zone, so a late evening is not tomorrow already", async () => {
    // 21:30 CDT is 02:30 UTC the next day — and still an hour short of the
    // quiet window, so this is about the ledger and not about his sleep.
    // Counted in UTC, his evening starts a fresh ledger and the ceiling is
    // quietly four.
    const { jobs, job } = ready();
    const evening = Date.UTC(2026, 7, 12, 2, 30); // 21:30 CDT on the 11th
    pastRun(jobs, job, MORNING, true);
    pastRun(jobs, job, MORNING + 60 * 60_000, true);
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, evening));

    expect(heard.prompts[0]?.toLowerCase()).toContain("nothing more");
  });

  it("should not let an unspent day accumulate into tomorrow", async () => {
    // Two missed sendings do not make four. A rate that banks is a timetable
    // with extra steps.
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, NEXT_MORNING));

    expect(heard.prompts[0]).toContain(String(SENDINGS_PER_DAY));
    expect(heard.prompts[0]).not.toContain("4");
  });

  it("should not carry yesterday's spending into today's ledger", async () => {
    const { jobs, job } = ready();
    pastRun(jobs, job, MORNING, true);
    pastRun(jobs, job, MORNING + 60 * 60_000, true);
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, NEXT_MORNING));

    expect(heard.prompts[0]?.toLowerCase()).not.toContain("nothing more");
  });

  it("should treat reaching him past the ceiling as a failure of the hour, not of him", async () => {
    // The bound has to have teeth, and the teeth it has are the circuit
    // breaker: an hour that overspends is recorded as a failed run, and five in
    // a row take the hour away from her. He is told nothing either way.
    const { jobs, job } = ready();
    pastRun(jobs, job, MORNING - 2 * 60 * 60_000, true);
    pastRun(jobs, job, MORNING - 60 * 60_000, true);
    const handler = createHeartbeatHandler({
      voice: voice(said("One more thing.", [mcpToolName("remind_me")])),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    const result = await handler(contextFor(jobs, job, MORNING));

    expect(result.outcome).toBe("failure");
    expect(result.spoke).toBe(true);
    expect(result.error ?? "").toMatch(/2 of 2|ceiling|allowance/i);
  });

  it("should still run inside quiet hours, because she is allowed to think", async () => {
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    const result = await handler(contextFor(jobs, job, SMALL_HOURS));

    expect(heard.prompts).toHaveLength(1);
    expect(result.outcome).toBe("success");
  });

  it("should tell her, at 03:00, that nothing she does can reach him yet", async () => {
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, SMALL_HOURS));

    expect(heard.prompts[0]?.toLowerCase()).toMatch(/sleep/);
  });

  it("should keep her thread for the day, and start a fresh one on a new day", async () => {
    // Continuity within a day is what makes "I noticed this at 03:00" survive
    // to 09:00. Continuity across months is 24 turns a day of transcript that
    // every later turn pays for.
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, MORNING));
    await handler(contextFor(jobs, job, MORNING + 60 * 60_000));
    expect(heard.resets).toEqual([]);

    await handler(contextFor(jobs, job, NEXT_MORNING));
    expect(heard.resets).toHaveLength(1);
  });

  it("should be silent to him and loud in the log when the turn dies", async () => {
    // It is not his problem that a background turn errored. It is very much
    // the log's.
    const { jobs, job } = ready();
    const lines: Array<{ level: string; event: string }> = [];
    const handler = createHeartbeatHandler({
      voice: voice(() => Promise.reject(new Error("claude exited 1"))),
      jobs,
      tz: TZ,
      quiet: QUIET,
      log: {
        log: (level, event) => {
          lines.push({ level, event: event });
        },
      },
    });

    const result = await handler(contextFor(jobs, job, MORNING));

    expect(result.outcome).toBe("failure");
    expect(result.spoke).toBe(false);
    expect(result.error).toContain("claude exited 1");
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  it("should never unschedule itself, however badly the hour went", async () => {
    // `nextRunAt: null` takes a job out of `due` forever. Omitting the field
    // lets the interval trigger compute the next hour, which is the only
    // correct answer here.
    const { jobs, job } = ready();
    const handler = createHeartbeatHandler({
      voice: voice(() => Promise.reject(new Error("boom"))),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    const result = await handler(contextFor(jobs, job, MORNING));

    expect(result.nextRunAt).toBeUndefined();
  });

  it("should not throw when the turn does, so one bad hour cannot stop the loop", async () => {
    const { jobs, job } = ready();
    const handler = createHeartbeatHandler({
      voice: voice(() => Promise.reject("a string, thrown")),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    await expect(handler(contextFor(jobs, job, MORNING))).resolves.toBeDefined();
  });
});

describe("describeHeartbeat", () => {
  it("should say the hour is running and when it next wakes", () => {
    const jobs = store();
    const job = ensureHeartbeatJob(jobs, { tz: TZ, quiet: QUIET }, MORNING);

    const [line] = describeHeartbeat(job, { tz: TZ, quiet: QUIET });

    expect(line).toContain(TZ);
    expect(line).toContain(String(SENDINGS_PER_DAY));
    expect(describeHeartbeat(job, { tz: TZ, quiet: QUIET })).toHaveLength(1);
  });
});
