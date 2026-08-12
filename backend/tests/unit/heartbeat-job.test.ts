import { afterEach, describe, expect, it } from "vitest";

import type { Job } from "@syl/shared";

import { DEFAULT_QUIET_HOURS } from "../../src/config.js";
import type { QuietHours } from "../../src/harness/schedule.js";
import type { TurnResult } from "../../src/harness/session.js";
import {
  createHeartbeatHandler,
  defineHeartbeatJob,
  describeHeartbeat,
  ensureHeartbeatJob,
  heartbeatPrompt,
  HEARTBEAT_INTERVAL_MS,
  OUTRANKS_THE_HOUR,
  REACHES_HIM,
  SENDINGS_PER_DAY,
  whatOutranksTheHour,
  YIELD_WINDOW_MS,
  type HeartbeatVoice,
} from "../../src/jobs/heartbeat-job.js";
import { COMPOSE_LEAD_MS, ensureMorningAgendaJob } from "../../src/jobs/agenda-job.js";
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

/**
 * His window, not a copy of it.
 *
 * These tests are about the hour NOT reaching him while he is asleep, so the
 * thing under test is the real window; a literal here would keep passing
 * against yesterday's sleep after he changed it. The instants below are named
 * for where they sit relative to it, and each stays on its own side.
 */
const QUIET: QuietHours = DEFAULT_QUIET_HOURS.quiet;

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
  /**
   * Every time the thread was thrown away — which must now be never.
   *
   * `HeartbeatVoice` no longer offers `reset`, so the handler CANNOT call it:
   * the hour happens in the Commander's own conversation now, and clearing it
   * deletes what he has been saying. The double offers one anyway, on purpose.
   * A guarantee that rests only on a method being absent from a `Pick` is a
   * guarantee that widening the `Pick` silently repeals, and this array is what
   * goes red when that happens.
   */
  readonly resets: number[];
  reset(): void;
  /** Set to make the lane look occupied — the Commander mid-turn on it. */
  occupied: boolean;
}

/** A stand-in for his thread, as the hourly wake sees it. */
function voice(answer: TurnResult | (() => Promise<TurnResult>) = said("Nothing.")): Recorder {
  const prompts: string[] = [];
  const resets: number[] = [];
  const recorder: Recorder = {
    prompts,
    resets,
    occupied: false,
    busy: () => recorder.occupied,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      return typeof answer === "function" ? answer() : answer;
    },
    reset: () => {
      resets.push(prompts.length);
    },
  };
  return recorder;
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

  it("should point her at the verb that shows her what is outstanding", () => {
    // The hour used to carry the time, the allowance and the quiet window, and
    // NOT ONE reminder, to-do or goal. She was asked whether anything was worth
    // doing while unable to see anything at all — so the answer was structurally
    // "nothing", every hour, and it looked like restraint.
    //
    // Named rather than pasted: she already has `whats_outstanding`, and what it
    // returns is true at the moment she calls it. A list built into the prompt
    // is true whenever the prompt was built, and she has no way to tell.
    const prompt = heartbeatPrompt(moment);

    expect(prompt).toContain("whats_outstanding");
  });

  it("should name the things the hour is over: his reminders, to-dos and goals", () => {
    // Not just a verb she could call. An hour that does not say what is hers to
    // notice is an hour she has no reason to spend the call on.
    const prompt = heartbeatPrompt(moment).toLowerCase();

    expect(prompt).toContain("reminders");
    expect(prompt).toContain("to-dos");
    expect(prompt).toContain("goals");
  });

  it("should still point her at his day when he is asleep", () => {
    // 03:00 is the hour she is most able to think and least able to interrupt.
    // Taking the look away inside the window would leave the one uninterrupted
    // hour of the night as the blindest.
    expect(heartbeatPrompt({ ...moment, now: SMALL_HOURS, inQuietHours: true })).toContain(
      "whats_outstanding",
    );
  });

  it("should state the ceiling as a rate, and say it does not accumulate", () => {
    const prompt = heartbeatPrompt(moment);

    expect(prompt).toContain(String(SENDINGS_PER_DAY));
    expect(prompt.toLowerCase()).toMatch(/does not (roll over|accumulate)/);
  });

  it("should say what is left when some of it is spent", () => {
    const prompt = heartbeatPrompt({ ...moment, spentToday: 1 });

    // Derived, not spelled. This assertion used to read `/1 of 2|one of two/`
    // and broke the day the allowance changed — a test stating the number it is
    // guarding cannot survive the number moving.
    expect(prompt).toMatch(new RegExp(`1 of ${String(SENDINGS_PER_DAY)}`, "i"));
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

    // Both ends, taken from the window: she cannot respect an hour she has not
    // been told, and a hardcoded pair here would go on asserting that she was
    // told the old one.
    expect(prompt).toContain(QUIET.start);
    expect(prompt).toContain(QUIET.end);
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

    expect(heard.prompts[0]).toMatch(new RegExp(`1 of ${String(SENDINGS_PER_DAY)}`, "i"));
  });

  it("should count a day in HIS zone, so a late evening is not tomorrow already", async () => {
    // 21:30 CDT is 02:30 UTC the next day — and still an hour short of the
    // quiet window, so this is about the ledger and not about his sleep.
    // Counted in UTC, his evening starts a fresh ledger and the ceiling is
    // quietly four.
    const { jobs, job } = ready();
    const evening = Date.UTC(2026, 7, 12, 2, 30); // 21:30 CDT on the 11th
    // Spend the whole allowance, whatever it is. Seeding a fixed number of runs
    // encodes the allowance in the fixture, which is how this test broke when
    // the ceiling moved from two to four.
    for (let spent = 0; spent < SENDINGS_PER_DAY; spent += 1) {
      pastRun(jobs, job, MORNING + spent * 60 * 60_000, true);
    }
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, evening));

    expect(heard.prompts[0]?.toLowerCase()).toContain("nothing more");
  });

  it("should not let an unspent day accumulate into tomorrow", async () => {
    // An unspent day does not double tomorrow's ceiling. A rate that banks is a
    // timetable with extra steps.
    //
    // The forbidden number is DERIVED — it used to be the literal `4`, chosen
    // when the allowance was two, and it became the allowance itself the day
    // that changed. A magic number is only impossible until it is not.
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, NEXT_MORNING));

    expect(heard.prompts[0]).toContain(String(SENDINGS_PER_DAY));
    expect(heard.prompts[0]).not.toContain(String(SENDINGS_PER_DAY * 2));
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
    // Spend the ceiling exactly, whatever it is — seeding a fixed count encodes
    // the allowance in the fixture and stops testing the bound the day it moves.
    for (let spent = 0; spent < SENDINGS_PER_DAY; spent += 1) {
      pastRun(jobs, job, MORNING - (spent + 1) * 60 * 60_000, true);
    }
    const handler = createHeartbeatHandler({
      voice: voice(said("One more thing.", [mcpToolName("remind_me")])),
      jobs,
      tz: TZ,
      quiet: QUIET,
    });

    const result = await handler(contextFor(jobs, job, MORNING));

    expect(result.outcome).toBe("failure");
    expect(result.spoke).toBe(true);
    expect(result.error ?? "").toMatch(
      new RegExp(`${String(SENDINGS_PER_DAY)} of ${String(SENDINGS_PER_DAY)}|ceiling|allowance`, "i"),
    );
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

  it("should never throw away the thread it is running in, not even on a new day", async () => {
    // The hour used to clear its own thread at each local midnight, because a
    // lane of its own carrying 24 turns a day forever is a transcript every
    // later turn pays to re-read. That thread is the Commander's now — his
    // ruling of 2026-08-11 — and the same call is his conversation being
    // deleted, once a day, by a background job he never sees.
    //
    // The `Pick` no longer offers `reset`, so this cannot compile its way back.
    // The assertion is here for the day someone widens the `Pick`.
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, MORNING));
    await handler(contextFor(jobs, job, MORNING + 60 * 60_000));
    await handler(contextFor(jobs, job, NEXT_MORNING));

    expect(heard.prompts).toHaveLength(3);
    expect(heard.resets).toEqual([]);
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

describe("standing aside", () => {
  /**
   * The hour is the lowest-priority thing on the Commander's thread and has to
   * behave like it (`syl-hb`, his ruling of 2026-08-11: the overnight hours
   * stay, the collisions go).
   *
   * Everything here is about NOT running, which is the harder half to test and
   * the easier half to get wrong in the dangerous direction — a guard that
   * yields too readily takes the hour away silently and every signal stays
   * green.
   */
  function withAgendaAt(now: number): { readonly jobs: JobStore; readonly heard: Recorder } {
    const jobs = store();
    ensureHeartbeatJob(jobs, { tz: TZ, quiet: QUIET }, now);
    ensureMorningAgendaJob(jobs, { tz: TZ, quiet: QUIET }, now);
    return { jobs, heard: voice() };
  }

  it("should stand aside while the Commander is mid-turn on the same thread", async () => {
    // He outranks everything, and there is no schedule to read: the only
    // evidence that he is talking is that a turn holds the lane. Without this
    // the hour queues behind him and his NEXT message waits on a turn nobody
    // asked for.
    const { jobs, heard } = withAgendaAt(MORNING);
    heard.occupied = true;

    expect(whatOutranksTheHour({ voice: heard, jobs }, MORNING)).toMatch(/commander/i);
  });

  it("should stand aside when the morning brief is about to compose", async () => {
    // The collision the Commander named. The brief must exist before the 07:00
    // note announces it and starts COMPOSE_LEAD_MS ahead for exactly that
    // reason, so an hour still talking at 06:45 spends that lead on itself.
    const { jobs, heard } = withAgendaAt(MORNING);
    const composeAt = jobs.list({ kind: "morning_agenda", limit: 1 }).items[0]?.nextRunAt ?? "";
    const justBefore = Date.parse(composeAt) - COMPOSE_LEAD_MS / 2;

    expect(whatOutranksTheHour({ voice: heard, jobs }, justBefore)).toMatch(/morning_agenda/);
  });

  it("should take its hour when the brief is further off than the window", async () => {
    // The other half, and the one that matters more: a guard that never lets
    // the hour run is not a guard, it is a deletion.
    const { jobs, heard } = withAgendaAt(MORNING);
    const composeAt = jobs.list({ kind: "morning_agenda", limit: 1 }).items[0]?.nextRunAt ?? "";
    const wellBefore = Date.parse(composeAt) - YIELD_WINDOW_MS - 60_000;

    expect(whatOutranksTheHour({ voice: heard, jobs }, wellBefore)).toBeNull();
  });

  it("should still take its hour in the middle of the night, because she may file overnight", async () => {
    // *"I think she should be able to file things over night."* Nothing here
    // refuses an hour for being at night — quiet hours bound what may REACH
    // him, never what may happen, and the dream and the brief both run inside
    // the window by design.
    const { jobs, heard } = withAgendaAt(SMALL_HOURS);

    expect(whatOutranksTheHour({ voice: heard, jobs }, SMALL_HOURS)).toBeNull();
  });

  it("should not stand aside for a job stuck due in the past, which would silence it forever", async () => {
    // The trap in the obvious version of this guard. `JobStore.due` sorts
    // `background` last and the runner takes one job a pass, so the hour being
    // picked at all already means nothing that outranks it is due — and a job
    // wedged overdue (an open circuit breaker, a handler failing every time)
    // would otherwise take the hour away permanently, with every signal green.
    const { jobs, heard } = withAgendaAt(MORNING);
    const agenda = jobs.list({ kind: "morning_agenda", limit: 1 }).items[0];
    jobs.release(agenda?.id ?? "", "failure", null, instant(MORNING - 60 * 60_000));

    expect(whatOutranksTheHour({ voice: heard, jobs }, MORNING)).toBeNull();
  });

  it("should cost nothing and count as a success when it stands aside", async () => {
    // A yielded hour recorded as a failure would walk the job's circuit breaker
    // towards opening, so five polite hours in a row would take the hour away
    // altogether — a punishment for good manners.
    const { jobs, heard } = withAgendaAt(MORNING);
    const job = jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
    heard.occupied = true;
    const handler = createHeartbeatHandler({ voice: heard, jobs, tz: TZ, quiet: QUIET });

    const result = await handler(contextFor(jobs, job as Job, MORNING));

    expect(heard.prompts).toEqual([]);
    expect(result.outcome).toBe("success");
    expect(result.turns).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.spoke).toBe(false);
    expect(result.error).toBeNull();
    // No `nextRunAt`: the interval trigger computes the next hour, which is
    // strictly later. `null` would write NULL and take the job out of `due`
    // forever — the silent drop constraint 4 forbids, by the polite path.
    expect(result.nextRunAt).toBeUndefined();
  });

  it("should name only jobs that exist in the catalogue", () => {
    // A kind nobody recognises is a guard that never fires, silently.
    const kinds = new Set<string>([
      "reminder_delivery",
      "morning_agenda",
      "evening_review",
      "heartbeat",
      "nightly_consolidation",
      "research_brief",
      "content_ingestion",
      "maintenance",
    ]);
    for (const kind of OUTRANKS_THE_HOUR) expect(kinds.has(kind)).toBe(true);
    // And never itself, which would be an hour that always stands aside.
    expect(OUTRANKS_THE_HOUR).not.toContain("heartbeat");
  });

  it("should derive its window from the brief's own lead rather than a number", () => {
    // Move the announcement and both move together. A literal here is a number
    // that goes stale the day the 07:00 note moves, in a file that never
    // mentions it.
    expect(YIELD_WINDOW_MS).toBe(COMPOSE_LEAD_MS);
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
